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
  XTREAM_USERNAME: z.string().optional(),
  XTREAM_PASSWORD: z.string().optional(),
  UPSTREAM_REDISTRIBUTION_AUTHORIZED: z.enum(['true', 'false']).default('false'),
  MEDIAFLOW_BASE_URL: z.preprocess(value => value === '' ? undefined : value, z.string().url().optional()),
  MEDIAFLOW_API_PASSWORD: z.preprocess(value => value === '' ? undefined : value, z.string().min(16).optional())
}).parse(process.env)

type CatalogItem = { id: string; name: string; category: string; kind: 'live' | 'movie' | 'series'; extension?: string }
let catalog: CatalogItem[] = []
let lastSync: string | null = null

const app = express()
app.disable('x-powered-by')
app.set('trust proxy', 1)
app.use(helmet())
app.use(cors({ origin: env.ALLOWED_ORIGINS.split(',').map(s => s.trim()), methods: ['GET', 'POST'], allowedHeaders: ['Content-Type', 'Authorization'] }))
app.use(express.json({ limit: '32kb' }))
app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false }))

function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  const token = req.header('authorization')?.replace(/^Bearer\s+/i, '')
  if (!env.ADMIN_API_TOKEN || !token || token !== env.ADMIN_API_TOKEN) {
    res.status(401).json({ error: 'unauthorized' }); return
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

app.post('/api/admin/catalog/sync', requireAdmin, async (_req, res) => {
  if (env.UPSTREAM_REDISTRIBUTION_AUTHORIZED !== 'true') {
    res.status(403).json({ error: 'provider_redistribution_authorization_required' }); return
  }
  if (!env.XTREAM_BASE_URL || !env.XTREAM_USERNAME || !env.XTREAM_PASSWORD) {
    res.status(503).json({ error: 'provider_not_configured' }); return
  }
  try {
    const base = env.XTREAM_BASE_URL.replace(/\/$/, '')
    const params = new URLSearchParams({ username: env.XTREAM_USERNAME, password: env.XTREAM_PASSWORD })
    const apiUrl = base + '/player_api.php?' + params.toString()
    const response = await fetch(apiUrl, { signal: AbortSignal.timeout(15_000) })
    if (!response.ok) throw new Error('provider_http_error')
    const account = await response.json() as { user_info?: { auth?: number } }
    if (account.user_info?.auth !== 1) throw new Error('provider_auth_failed')

    const kinds = [
      { action: 'get_live_streams', categoryAction: 'get_live_categories', kind: 'live' as const, fallback: 'قنوات مباشرة' },
      { action: 'get_vod_streams', categoryAction: 'get_vod_categories', kind: 'movie' as const, fallback: 'أفلام' },
      { action: 'get_series', categoryAction: 'get_series_categories', kind: 'series' as const, fallback: 'مسلسلات' }
    ]
    const next: CatalogItem[] = []
    for (const group of kinds) {
      const [listResponse, categoryResponse] = await Promise.all([
        fetch(apiUrl + '&action=' + group.action, { signal: AbortSignal.timeout(25_000) }),
        fetch(apiUrl + '&action=' + group.categoryAction, { signal: AbortSignal.timeout(15_000) })
      ])
      if (!listResponse.ok) throw new Error('provider_catalog_error')
      const rows = await listResponse.json() as Array<{ stream_id?: string | number; series_id?: string | number; name?: string; title?: string; category_id?: string | number; container_extension?: string }>
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
  } catch {
    res.status(502).json({ error: 'provider_sync_failed' })
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
      const infoResponse = await fetch(env.XTREAM_BASE_URL.replace(/\/$/, '') + '/player_api.php?' + params, { signal: AbortSignal.timeout(20_000) })
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
    const response = await fetch(env.XTREAM_BASE_URL.replace(/\/$/, '') + '/player_api.php?' + params, { signal: AbortSignal.timeout(20_000) })
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
