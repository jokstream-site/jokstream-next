import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'

const env = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  ADMIN_API_TOKEN: z.preprocess(value => value === '' ? undefined : value, z.string().min(32).optional()),
  ALLOWED_ORIGINS: z.string().default('http://localhost:5173'),
  XTREAM_BASE_URL: z.preprocess(value => value === '' ? undefined : value, z.string().url().optional()),
  XTREAM_API_BASE_URL: z.preprocess(value => value === '' ? undefined : value, z.string().url().optional()),
  XTREAM_PROXY_TOKEN: z.preprocess(value => value === '' ? undefined : value, z.string().min(32).optional()),
  XTREAM_USERNAME: z.string().optional(),
  XTREAM_PASSWORD: z.string().optional(),
  UPSTREAM_REDISTRIBUTION_AUTHORIZED: z.enum(['true', 'false']).default('false'),
  MEDIAFLOW_BASE_URL: z.preprocess(value => value === '' ? undefined : value, z.string().url().optional()),
  MEDIAFLOW_API_PASSWORD: z.preprocess(value => value === '' ? undefined : value, z.string().min(16).optional()),
  SUPABASE_URL: z.preprocess(value => value === '' ? undefined : value, z.string().url().optional()),
  SUPABASE_ANON_KEY: z.string().optional(),
  CATALOG_SYNC_SECRET: z.preprocess(value => value === '' ? undefined : value, z.string().min(32).optional())
}).parse(process.env)


async function xtreamFetch(url: string, timeoutMs: number) {
  const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'okhttp/5.0.0-alpha.2' }
  if (env.XTREAM_API_BASE_URL && env.XTREAM_PROXY_TOKEN && url.startsWith(env.XTREAM_API_BASE_URL.replace(/\/$/, ''))) headers.Authorization = 'Bearer ' + env.XTREAM_PROXY_TOKEN
  return fetch(url, {
    headers,
    signal: AbortSignal.timeout(timeoutMs)
  })
}

async function supabaseRpc(name: string, body: Record<string, unknown>) {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) throw new Error('catalog_storage_not_configured')
  const response = await fetch((env.SUPABASE_URL.endsWith('/') ? env.SUPABASE_URL.slice(0, -1) : env.SUPABASE_URL) + '/rest/v1/rpc/' + name, {
    method: 'POST',
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + env.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000)
  })
  if (!response.ok) throw new Error('catalog_storage_http_' + response.status)
  return response.json() as Promise<any>
}

const app = express()
app.disable('x-powered-by')
app.set('trust proxy', 1)
app.use(helmet())
app.use(cors({ origin: env.ALLOWED_ORIGINS.split(',').map(s => s.trim()), methods: ['GET', 'POST'], allowedHeaders: ['Content-Type', 'Authorization'] }))
app.use(express.json({ limit: '32kb' }))
app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false }))

function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  const token = req.header('authorization')?.replace(/^Bearer\s+/i, '')
  const configured = Boolean(env.ADMIN_API_TOKEN)
  const matches = Boolean(token && env.ADMIN_API_TOKEN && token === env.ADMIN_API_TOKEN)
  if (!matches) {
    console.warn('[admin-auth]', {
      configured,
      received: Boolean(token),
      receivedLength: token?.length ?? 0,
      configuredLength: env.ADMIN_API_TOKEN?.length ?? 0,
      matches
    })
    res.status(401).json({ error: configured ? 'unauthorized' : 'admin_token_not_configured' }); return
  }
  next()
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'jokstream-gateway' }))
app.get('/api/catalog', async (req, res) => {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return res.status(503).json({ error: 'catalog_storage_not_configured' })
  const kindValue = String(req.query.kind || '')
  const kind = ['live','movie','series'].includes(kindValue) ? kindValue : null
  const q = String(req.query.q || '').trim().slice(0, 100)
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 60))
  const offset = Math.max(0, Math.min(10000000, Number(req.query.offset) || 0))
  try {
    const result = await supabaseRpc('jok_catalog_page', { p_kind: kind, p_query: q, p_limit: limit, p_offset: offset })
    res.setHeader('Cache-Control', 'public, max-age=15, stale-while-revalidate=60')
    res.json(result)
  } catch { res.status(502).json({ error: 'catalog_storage_unavailable' }) }
})
app.get('/api/status', (_req, res) => res.json({
  providerConfigured: Boolean(env.XTREAM_BASE_URL && env.XTREAM_USERNAME && env.XTREAM_PASSWORD),
  adminConfigured: Boolean(env.ADMIN_API_TOKEN),
  redistributionAuthorized: env.UPSTREAM_REDISTRIBUTION_AUTHORIZED === 'true',
  catalogStorageConfigured: Boolean(env.SUPABASE_URL && env.SUPABASE_ANON_KEY && env.CATALOG_SYNC_SECRET),
  mediaProxyConfigured: Boolean(process.env.MEDIAFLOW_BASE_URL && process.env.MEDIAFLOW_API_PASSWORD),
  updatedAt: lastSync
}))

app.get('/api/admin/provider/diagnostics', requireAdmin, async (_req, res) => {
  if (!env.XTREAM_API_BASE_URL || !env.XTREAM_PROXY_TOKEN) {
    res.status(503).json({ error: 'cloudflare_proxy_not_configured' }); return
  }
  if (!env.XTREAM_USERNAME || !env.XTREAM_PASSWORD) {
    res.status(503).json({ error: 'provider_credentials_not_configured' }); return
  }
  const base = env.XTREAM_API_BASE_URL.replace(/\/$/, '')
  const params = new URLSearchParams({ username: env.XTREAM_USERNAME, password: env.XTREAM_PASSWORD })
  const checks: Record<string, unknown> = {}
  try {
    const accountResponse = await xtreamFetch(base + '?' + params, 15000)
    checks.account = { status: accountResponse.status, ok: accountResponse.ok }
    if (accountResponse.ok) {
      const account = await accountResponse.json() as { user_info?: { auth?: number; status?: string; exp_date?: string } }
      checks.account = { status: accountResponse.status, ok: true, authenticated: account.user_info?.auth === 1, accountStatus: account.user_info?.status ?? null, expiresAt: account.user_info?.exp_date ?? null }
    }
    const actions = [
      { key: 'liveChannels', action: 'get_live_streams' },
      { key: 'liveCategories', action: 'get_live_categories' },
      { key: 'movies', action: 'get_vod_streams' },
      { key: 'series', action: 'get_series' }
    ]
    for (const item of actions) {
      try {
        const response = await xtreamFetch(base + '?' + params + '&action=' + item.action, 25000)
        if (!response.ok) {
          checks[item.key] = { status: response.status, ok: false }
          continue
        }
        const rows = await response.json() as Array<{ name?: string; title?: string; category_name?: string }>
        checks[item.key] = {
          status: response.status,
          ok: true,
          count: Array.isArray(rows) ? rows.length : null,
          sample: Array.isArray(rows) ? rows.slice(0, 8).map(row => row.name ?? row.title ?? row.category_name ?? 'بدون اسم') : null
        }
      } catch (error) {
        checks[item.key] = { ok: false, error: error instanceof Error ? error.name : 'unknown' }
      }
    }
    res.json({ route: 'gateway -> cloudflare worker -> provider', checkedAt: new Date().toISOString(), checks })
  } catch (error) {
    res.status(502).json({ route: 'gateway -> cloudflare worker -> provider', error: error instanceof Error ? error.name : 'connection_failed', checks })
  }
})


type SyncState = {
  status: 'idle' | 'running' | 'completed' | 'failed'
  stage: string
  synced: number
  startedAt: string | null
  updatedAt: string | null
  error: string | null
}
let syncState: SyncState = { status: 'idle', stage: 'idle', synced: 0, startedAt: null, updatedAt: null, error: null }

const trimTrailingSlash = (value: string) => value.endsWith('/') ? value.slice(0, -1) : value

async function runCatalogSync() {
  const update = (patch: Partial<SyncState>) => { syncState = { ...syncState, ...patch, updatedAt: new Date().toISOString() } }
  try {
    if (env.UPSTREAM_REDISTRIBUTION_AUTHORIZED !== 'true') throw new Error('provider_redistribution_authorization_required')
    if (!env.XTREAM_BASE_URL || !env.XTREAM_USERNAME || !env.XTREAM_PASSWORD) throw new Error('provider_not_configured')
    if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || !env.CATALOG_SYNC_SECRET) throw new Error('catalog_storage_not_configured')
    update({ stage: 'account_request' })
    const base = env.XTREAM_API_BASE_URL ? trimTrailingSlash(env.XTREAM_API_BASE_URL) : trimTrailingSlash(env.XTREAM_BASE_URL) + '/player_api.php'
    const params = new URLSearchParams({ username: env.XTREAM_USERNAME, password: env.XTREAM_PASSWORD })
    const apiUrl = base + '?' + params.toString()
    const response = await xtreamFetch(apiUrl, 15_000)
    if (!response.ok) throw new Error('provider_http_' + response.status + '_account')
    const account = await response.json() as { user_info?: { auth?: number } }
    if (account.user_info?.auth !== 1) throw new Error('provider_auth_failed')
    const version = await supabaseRpc('jok_catalog_sync_begin', { p_token: env.CATALOG_SYNC_SECRET }) as string
    let total = 0
    const groups = [
      { action: 'get_live_streams', categoryAction: 'get_live_categories', kind: 'live' as const, fallback: 'قنوات مباشرة' },
      { action: 'get_vod_streams', categoryAction: 'get_vod_categories', kind: 'movie' as const, fallback: 'أفلام' },
      { action: 'get_series', categoryAction: 'get_series_categories', kind: 'series' as const, fallback: 'مسلسلات' }
    ]
    for (const group of groups) {
      update({ stage: group.kind + '_download', synced: total })
      const [listResponse, categoryResponse] = await Promise.all([
        xtreamFetch(apiUrl + '&action=' + group.action, 90_000),
        xtreamFetch(apiUrl + '&action=' + group.categoryAction, 30_000)
      ])
      if (!listResponse.ok) throw new Error('provider_http_' + listResponse.status + '_' + group.kind)
      const rows = await listResponse.json() as Array<{ stream_id?: string|number; series_id?: string|number; name?: string; title?: string; category_id?: string|number; container_extension?: string }>
      const categoryRows = categoryResponse.ok ? await categoryResponse.json() as Array<{ category_id?: string|number; category_name?: string }> : []
      const categories = new Map(categoryRows.map(row => [String(row.category_id ?? ''), String(row.category_name ?? group.fallback)]))
      if (!Array.isArray(rows)) throw new Error('provider_invalid_catalog_' + group.kind)
      update({ stage: group.kind + '_saving', synced: total })
      let batch: Array<{kind:string;item_id:string;name:string;category:string;extension:string}> = []
      for (const row of rows) {
        const id = String(row.stream_id ?? row.series_id ?? '')
        const name = String(row.name ?? row.title ?? '').trim()
        if (!id || !name) continue
        batch.push({ kind: group.kind, item_id: id, name, category: categories.get(String(row.category_id ?? '')) || group.fallback, extension: row.container_extension || (group.kind === 'live' ? 'ts' : 'mp4') })
        if (batch.length >= 400) {
          await supabaseRpc('jok_catalog_sync_batch', { p_token: env.CATALOG_SYNC_SECRET, p_version: version, p_items: batch })
          total += batch.length; batch = []
          update({ synced: total, stage: group.kind + '_saving' })
        }
      }
      if (batch.length) {
        await supabaseRpc('jok_catalog_sync_batch', { p_token: env.CATALOG_SYNC_SECRET, p_version: version, p_items: batch })
        total += batch.length
      }
      update({ stage: group.kind + '_completed', synced: total })
    }
    const finished = await supabaseRpc('jok_catalog_sync_finish', { p_token: env.CATALOG_SYNC_SECRET, p_version: version }) as { total?: number; updatedAt?: string }
    update({ status: 'completed', stage: 'completed', synced: Number(finished.total ?? total), error: null })
  } catch (error) {
    const err = error as { name?: string; cause?: { code?: string }; message?: string }
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError'
    const code = err.message?.startsWith('provider_') || err.message?.startsWith('catalog_') ? err.message : timedOut ? 'provider_timeout_' + syncState.stage : 'sync_failed_' + syncState.stage
    console.error('[catalog-sync]', { stage: syncState.stage, errorName: err.name || 'unknown', causeCode: err.cause?.code || 'unknown' })
    update({ status: 'failed', stage: 'failed', error: code })
  }
}
app.post('/api/admin/catalog/sync', requireAdmin, (_req, res) => {
  if (syncState.status === 'running') {
    res.status(202).json({ status: 'running', stage: syncState.stage, synced: syncState.synced })
    return
  }
  syncState = { status: 'running', stage: 'starting', synced: 0, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), error: null }
  void runCatalogSync()
  res.status(202).json({ status: 'running', stage: syncState.stage, synced: 0 })
})

app.get('/api/admin/catalog/sync/status', requireAdmin, (_req, res) => {
  res.json(syncState)
})

app.post('/api/playback', async (req, res) => {
  const input = z.object({
    kind: z.enum(['live', 'movie', 'series']),
    id: z.string().min(1).max(64),
    seriesId: z.string().min(1).max(64).optional()
  }).safeParse(req.body)
  if (!input.success) return res.status(400).json({ error: 'invalid_playback_request' })
  if (env.UPSTREAM_REDISTRIBUTION_AUTHORIZED !== 'true') return res.status(403).json({ error: 'redistribution_not_authorized' })
  if (!env.XTREAM_BASE_URL || !env.XTREAM_USERNAME || !env.XTREAM_PASSWORD) return res.status(503).json({ error: 'provider_not_configured' })
  if (!env.MEDIAFLOW_BASE_URL || !env.MEDIAFLOW_API_PASSWORD) return res.status(503).json({ error: 'media_proxy_not_configured' })

  try {
    let extension = input.data.kind === 'live' ? 'ts' : 'mp4'
    if (input.data.kind === 'series') {
      if (!input.data.seriesId) return res.status(400).json({ error: 'series_id_required' })
      const params = new URLSearchParams({ username: env.XTREAM_USERNAME, password: env.XTREAM_PASSWORD, action: 'get_series_info', series_id: input.data.seriesId })
      const apiBase = env.XTREAM_API_BASE_URL ? env.XTREAM_API_BASE_URL.replace(/\/$/, '') : env.XTREAM_BASE_URL.replace(/\/$/, '') + '/player_api.php'
      const infoResponse = await xtreamFetch(apiBase + '?' + params, 20_000)
      if (!infoResponse.ok) throw new Error('series_info_failed')
      const info = await infoResponse.json() as { episodes?: Record<string, Array<{ id?: string | number; episode_num?: number; container_extension?: string }>> }
      const episodes = Object.values(info.episodes || {}).flat()
      const episode = episodes.find(row => String(row.id ?? '') === input.data.id)
      if (!episode) return res.status(404).json({ error: 'episode_not_found' })
      extension = episode.container_extension || 'mp4'
    } else {
      extension = input.data.kind === 'live' ? 'ts' : 'mp4'
    }

    const path = input.data.kind === 'live' ? 'live' : input.data.kind === 'movie' ? 'movie' : 'series'
    const upstream = new URL('/' + path + '/' + encodeURIComponent(env.XTREAM_USERNAME) + '/' + encodeURIComponent(env.XTREAM_PASSWORD) + '/' + encodeURIComponent(input.data.id) + '.' + encodeURIComponent(extension), env.XTREAM_BASE_URL).toString()
    const isHls = extension.toLowerCase() === 'm3u8'
    const proxyBase = env.MEDIAFLOW_BASE_URL.replace(/\/$/, '')
    const generated = await fetch(proxyBase + '/generate_url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mediaflow_proxy_url: proxyBase,
        endpoint: isHls ? '/proxy/hls/manifest.m3u8' : '/proxy/stream',
        destination_url: upstream,
        query_params: (!isHls && ['ts', 'mkv', 'avi'].includes(extension.toLowerCase())) ? { transcode: 'true' } : {},
        api_password: env.MEDIAFLOW_API_PASSWORD,
        expiration: 1800
      }),
      signal: AbortSignal.timeout(20_000)
    })
    if (!generated.ok) throw new Error('mediaflow_url_generation_failed')
    const result = await generated.json() as { url?: string }
    if (!result.url) throw new Error('mediaflow_url_missing')
    res.json({ url: result.url, expiresIn: 1800, kind: input.data.kind })
  } catch {
    res.status(502).json({ error: 'playback_url_generation_failed' })
  }
})

app.get('/api/series/:id', async (req, res) => {
  if (!env.XTREAM_BASE_URL || !env.XTREAM_USERNAME || !env.XTREAM_PASSWORD) return res.status(503).json({ error: 'provider_not_configured' })
  try {
    const params = new URLSearchParams({ username: env.XTREAM_USERNAME, password: env.XTREAM_PASSWORD, action: 'get_series_info', series_id: req.params.id })
    const apiBase = env.XTREAM_API_BASE_URL ? env.XTREAM_API_BASE_URL.replace(/\/$/, '') : env.XTREAM_BASE_URL.replace(/\/$/, '') + '/player_api.php'
    const response = await xtreamFetch(apiBase + '?' + params, 20_000)
    if (!response.ok) throw new Error('provider_error')
    res.json(await response.json())
  } catch { res.status(502).json({ error: 'series_details_unavailable' }) }
})

// Playback remains disabled until signed MediaFlow URLs can be generated server-side.
app.all('/api/playback/*', (_req, res) => res.status(503).json({ error: 'media_proxy_not_configured' }))
app.all('/stream/*', (_req, res) => res.status(503).json({ error: 'media_gateway_not_enabled' }))

app.listen(env.PORT, () => {
  console.log('JokStream gateway listening on port ' + env.PORT)
})
