import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'

const env = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  ADMIN_API_TOKEN: z.string().min(32).optional(),
  ALLOWED_ORIGINS: z.string().default('http://localhost:5173'),
  XTREAM_BASE_URL: z.string().url().optional(),
  XTREAM_USERNAME: z.string().optional(),
  XTREAM_PASSWORD: z.string().optional(),
  UPSTREAM_REDISTRIBUTION_AUTHORIZED: z.enum(['true', 'false']).default('false')
}).parse(process.env)

type CatalogItem = { id: string; name: string; category: string; kind: 'live' | 'movie' | 'series' }
let catalog: CatalogItem[] = []
let lastSync: string | null = null

const app = express()
app.disable('x-powered-by')
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
app.get('/api/catalog', (_req, res) => res.json({ items: catalog, updatedAt: lastSync }))
app.get('/api/status', (_req, res) => res.json({
  providerConfigured: Boolean(env.XTREAM_BASE_URL && env.XTREAM_USERNAME && env.XTREAM_PASSWORD),
  redistributionAuthorized: env.UPSTREAM_REDISTRIBUTION_AUTHORIZED === 'true',
  catalogItems: catalog.length,
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
      { action: 'get_live_streams', kind: 'live' as const, category: 'قنوات مباشرة' },
      { action: 'get_vod_streams', kind: 'movie' as const, category: 'أفلام' },
      { action: 'get_series', kind: 'series' as const, category: 'مسلسلات' }
    ]
    const next: CatalogItem[] = []
    for (const group of kinds) {
      const url = apiUrl + '&action=' + group.action
      const result = await fetch(url, { signal: AbortSignal.timeout(25_000) })
      if (!result.ok) throw new Error('provider_catalog_error')
      const rows = await result.json() as Array<{ stream_id?: string | number; series_id?: string | number; name?: string; title?: string }>
      if (Array.isArray(rows)) for (const row of rows) {
        const id = String(row.stream_id ?? row.series_id ?? '')
        const name = String(row.name ?? row.title ?? '').trim()
        if (id && name) next.push({ id, name, category: group.category, kind: group.kind })
      }
    }
    catalog = next
    lastSync = new Date().toISOString()
    res.json({ synced: catalog.length, updatedAt: lastSync })
  } catch {
    res.status(502).json({ error: 'provider_sync_failed' })
  }
})

// No upstream playback route is exposed until the authorized media-proxy implementation is deployed.
app.all('/stream/*', (_req, res) => res.status(503).json({ error: 'media_gateway_not_enabled' }))

app.listen(env.PORT, () => {
  console.log('JokStream gateway listening on port ' + env.PORT)
})
