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
  MEDIAFLOW_API_PASSWORD: z.preprocess(value => value === '' ? undefined : value, z.string().min(16).optional())
}).parse(process.env)

type CatalogItem = { id: string; name: string; category: string; kind: 'live' | 'movie' | 'series'; extension?: string }
let catalog: CatalogItem[] = []
let lastSync: string | null = null

async function xtreamFetch(url: string, timeoutMs: number) {
  const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'okhttp/5.0.0-alpha.2' }
  if (env.XTREAM_API_BASE_URL && env.XTREAM_PROXY_TOKEN && url.startsWith(env.XTREAM_API_BASE_URL.replace(/\/$/, ''))) headers.Authorization = 'Bearer ' + env.XTREAM_PROXY_TOKEN
  return fetch(url, {
    headers,
    signal: AbortSignal.timeout(timeoutMs)
  })
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
app.get('/api/catalog', (req, res) => {
  const kind = String(req.query.kind || '')
  const q = String(req.query.q || '').trim().toLocaleLowerCase()
  const items = catalog.filter(item => (!kind || item.kind === kind) && (!q || (item.name + ' ' + item.category).toLocaleLowerCase().includes(q)))
  res.json({ items, updatedAt: lastSync, total: items.length })
})
app.get('/api/status', (_req, res) => res.json({
  providerConfigured: Boolean(env.XTREAM_BASE_URL && env.XTREAM_USERNAME && env.XTREAM_PASSWORD),
  adminConfigured: Boolean(env.ADMIN_API_TOKEN),
  redistributionAuthorized: env.UPSTREAM_REDISTRIBUTION_AUTHORIZED === 'true',
  catalogItems: catalog.length,
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

app.post('/api/admin/catalog/sync', requireAdmin, async (_req, res) => {
  if (env.UPSTREAM_REDISTRIBUTION_AUTHORIZED !== 'true') {
    res.status(403).json({ error: 'provider_redistribution_authorization_required' }); return
  }
  if (!env.XTREAM_BASE_URL || !env.XTREAM_USERNAME || !env.XTREAM_PASSWORD) {
    res.status(503).json({ error: 'provider_not_configured' }); return
  }

  let stage = 'account_request'
  try {
    const base = env.XTREAM_API_BASE_URL ? env.XTREAM_API_BASE_URL.replace(/\/$/, '') : env.XTREAM_BASE_URL.replace(/\/$/, '') + '/player_api.php'
    const params = new URLSearchParams({ username: env.XTREAM_USERNAME, password: env.XTREAM_PASSWORD })
    const apiUrl = base + '?' + params.toString()
    const response = await xtreamFetch(apiUrl, 15_000)
    if (!response.ok) {
      res.status(502).json({ error: 'provider_http_' + response.status + '_account' }); return
    }
    stage = 'account_json'
    const account = await response.json() as { user_info?: { auth?: number } }
    if (account.user_info?.auth !== 1) {
      res.status(502).json({ error: 'provider_auth_failed' }); return
    }

    const kinds = [
      { action: 'get_live_streams', categoryAction: 'get_live_categories', kind: 'live' as const, fallback: 'قنوات مباشرة' },
      { action: 'get_vod_streams', categoryAction: 'get_vod_categories', kind: 'movie' as const, fallback: 'أفلام' },
      { action: 'get_series', categoryAction: 'get_series_categories', kind: 'series' as const, fallback: 'مسلسلات' }
    ]
    const next: CatalogItem[] = []
    for (const group of kinds) {
      stage = group.kind + '_streams_request'
      const [listResponse, categoryResponse] = await Promise.all([
        xtreamFetch(apiUrl + '&action=' + group.action, 25_000),
        xtreamFetch(apiUrl + '&action=' + group.categoryAction, 15_000)
      ])
      if (!listResponse.ok) {
        res.status(502).json({ error: 'provider_http_' + listResponse.status + '_' + group.kind }); return
      }
      stage = group.kind + '_streams_json'
      const rows = await listResponse.json() as Array<{ stream_id?: string | number; series_id?: string | number; name?: string; title?: string; category_id?: string | number; container_extension?: string }>
      stage = group.kind + '_categories_json'
      const categoryRows = categoryResponse.ok ? await categoryResponse.json() as Array<{ category_id?: string | number; category_name?: string }> : []
      const categories = new Map(categoryRows.map(row => [String(row.category_id ?? ''), String(row.category_name ?? group.fallback)]))
      if (Array.isArray(rows)) for (const row of rows) {
        const id = String(row.stream_id ?? row.series_id ?? '')
        const name = String(row.name ?? row.title ?? '').trim()
        const category = categories.get(String(row.category_id ?? '')) || group.fallback
        if (id && name) next.push({ id, name, category, kind: group.kind, extension: row.container_extension || (group.kind === 'live' ? 'ts' : 'mp4') })
      }
    }
    catalog = next
    lastSync = new Date().toISOString()
    res.json({ synced: catalog.length, updatedAt: lastSync })
  } catch (error) {
    const err = error as { name?: string; cause?: { code?: string } }
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError'
    const invalidJson = err.name === 'SyntaxError'
    const errorCode = timedOut
      ? 'provider_timeout_' + stage
      : invalidJson
        ? 'provider_invalid_json_' + stage
        : 'provider_connection_failed_' + stage
    console.error('[catalog-sync]', { stage, errorName: err.name || 'unknown', causeCode: err.cause?.code || 'unknown' })
    res.status(502).json({ error: errorCode })
  }
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
      if (!input.data.seriesId || !catalog.some(item => item.kind === 'series' && item.id === input.data.seriesId)) return res.status(404).json({ error: 'series_not_found' })
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
      const item = catalog.find(row => row.kind === input.data.kind && row.id === input.data.id)
      if (!item) return res.status(404).json({ error: 'catalog_item_not_found' })
      extension = item.extension || extension
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
  if (!catalog.some(item => item.kind === 'series' && item.id === req.params.id)) return res.status(404).json({ error: 'series_not_found' })
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
