import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'

const env = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  ADMIN_API_TOKEN: z.preprocess(value => value === '' ? undefined : value, z.string().min(32).optional()),
  ALLOWED_ORIGINS: z.string().default('http://localhost:5173'),
  XTREAM_API_BASE_URL: z.preprocess(value => value === '' ? undefined : value, z.string().url().optional()),
  XTREAM_PROXY_TOKEN: z.preprocess(value => value === '' ? undefined : value, z.string().min(32).optional()),
  UPSTREAM_REDISTRIBUTION_AUTHORIZED: z.enum(['true', 'false']).default('false'),
  MEDIAFLOW_BASE_URL: z.preprocess(value => value === '' ? undefined : value, z.string().url().optional()),
  MEDIAFLOW_API_PASSWORD: z.preprocess(value => value === '' ? undefined : value, z.string().min(16).optional()),
  SUPABASE_URL: z.preprocess(value => value === '' ? undefined : value, z.string().url().optional()),
  SUPABASE_ANON_KEY: z.string().optional(),
  CATALOG_SYNC_SECRET: z.preprocess(value => value === '' ? undefined : value, z.string().min(32).optional()),
  TMDB_API_KEY: z.preprocess(value => value === '' ? undefined : value, z.string().optional())
}).parse(process.env)


async function xtreamFetch(url: string, timeoutMs: number) {
  if (!env.XTREAM_API_BASE_URL || !env.XTREAM_PROXY_TOKEN || !url.startsWith(env.XTREAM_API_BASE_URL.replace(/\/$/, ''))) {
    throw new Error('cloudflare_proxy_not_configured')
  }
  return fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'okhttp/5.0.0-alpha.2', Authorization: 'Bearer ' + env.XTREAM_PROXY_TOKEN },
    signal: AbortSignal.timeout(timeoutMs)
  })
}

function parsedStorageCode(detail: string) {
  const match = detail.match(/\b([A-Z0-9]{5})\b/)
  return match?.[1]?.toLowerCase() || ''
}

async function supabaseRpc(name: string, body: Record<string, unknown>) {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) throw new Error('catalog_storage_not_configured')
  const response = await fetch((env.SUPABASE_URL.endsWith('/') ? env.SUPABASE_URL.slice(0, -1) : env.SUPABASE_URL) + '/rest/v1/rpc/' + name, {
    method: 'POST',
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + env.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000)
  })
  const responseText = await response.text()
  if (!response.ok) {
    let detail = ''
    try {
      const parsed = JSON.parse(responseText) as { code?: string; message?: string; details?: string; hint?: string }
      detail = [parsed.code, parsed.message, parsed.details, parsed.hint].filter(Boolean).join(' | ')
    } catch {
      detail = responseText.slice(0, 500)
    }
    const safeDetail = detail.replace(/[\r\n\t]+/g, ' ').replace(/(authorization|apikey|token|password)\s*[:=]\s*[^ ,;]+/ig, '$1=[redacted]').slice(0, 700)
    console.error('[catalog-storage]', { rpc: name, status: response.status, detail: safeDetail })
    throw new Error('catalog_storage_http_' + response.status + (parsedStorageCode(safeDetail) ? '_' + parsedStorageCode(safeDetail) : ''))
  }
  return responseText ? JSON.parse(responseText) as any : null
}

const app = express()
app.disable('x-powered-by')
app.set('trust proxy', 1)
app.use(helmet())
app.use(cors({ origin: env.ALLOWED_ORIGINS.split(',').map(s => s.trim()), methods: ['GET', 'HEAD', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization', 'Range'], exposedHeaders: ['Accept-Ranges', 'Content-Length', 'Content-Range', 'Content-Type'] }))
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


let discoveryCache: { expiresAt: number; payload: unknown } | null = null
app.get('/api/discovery', async (_req, res) => {
  if (discoveryCache && discoveryCache.expiresAt > Date.now()) {
    res.setHeader('Cache-Control', 'public, max-age=120, stale-while-revalidate=300')
    return res.json(discoveryCache.payload)
  }
  const today = new Date()
  const dates = [0, 1, 2, 3, 4].map(offset => {
    const date = new Date(today)
    date.setUTCDate(date.getUTCDate() + offset)
    return date.toISOString().slice(0, 10)
  })
  const sports = ['football', 'basketball', 'tennis', 'cricket']
  const requests = sports.flatMap(sport => dates.map(async date => {
    try {
      const url = new URL('https://sportscore.com/api/v1/fixtures/')
      url.searchParams.set('sport', sport)
      url.searchParams.set('date', date)
      url.searchParams.set('status', 'upcoming')
      url.searchParams.set('limit', '100')
      const response = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'JokStream/1.0 (+https://jokstream-web.onrender.com)' }, signal: AbortSignal.timeout(12000) })
      if (!response.ok) return []
      const body = await response.json() as any
      const rawRows = Array.isArray(body) ? body : Array.isArray(body.fixtures) ? body.fixtures : Array.isArray(body.matches) ? body.matches : Array.isArray(body.data) ? body.data : Array.isArray(body.data?.fixtures) ? body.data.fixtures : Array.isArray(body.data?.matches) ? body.data.matches : []
      const teamName = (team: any) => typeof team === 'string' ? team : team?.name ?? team?.short_name ?? team?.display_name ?? ''
      return rawRows.map((row: any) => ({
        id: String(row.id ?? row.slug ?? [sport,teamName(row.home ?? row.home_team),teamName(row.away ?? row.away_team),row.time ?? row.startTime].join('-')),
        sport,
        title: [teamName(row.home ?? row.home_team ?? row.participants?.[0]), teamName(row.away ?? row.away_team ?? row.participants?.[1])].filter(Boolean).join(' vs '),
        startsAt: row.time ?? row.startTime ?? row.start_time ?? row.starting_at ?? row.date_time ?? row.kickoff?.utc ?? row.date ?? null,
        competition: typeof row.competition === 'string' ? row.competition : row.competition?.name ?? row.league?.name ?? row.tournament?.name ?? row.competition_name ?? '',
        status: typeof row.status === 'string' ? row.status : row.status?.type ?? 'upcoming',
        source: 'SportScore'
      })).filter((row: any) => row.title && row.startsAt)
    } catch { return [] }
  }))
  const tvDates = dates.map(async date => {
    try {
      const [local, web] = await Promise.all([
        fetch('https://api.tvmaze.com/schedule?country=ES&date=' + date, { signal: AbortSignal.timeout(12000) }),
        fetch('https://api.tvmaze.com/schedule/web?date=' + date, { signal: AbortSignal.timeout(12000) })
      ])
      const rows = [...(local.ok ? await local.json() as any[] : []), ...(web.ok ? await web.json() as any[] : [])]
      return rows.map((episode: any) => ({
        id: 'tvmaze-' + episode.id,
        title: episode.name || 'New episode',
        show: episode._embedded?.show?.name || episode.show?.name || '',
        season: episode.season,
        episode: episode.number,
        startsAt: episode.airstamp || (episode.airdate ? episode.airdate + 'T' + (episode.airtime || '00:00:00') + 'Z' : null),
        image: episode.image?.medium || episode._embedded?.show?.image?.medium || null,
        summary: String(episode.summary || '').replace(/<[^>]*>/g, '').slice(0, 240),
        source: 'TVmaze'
      })).filter((row: any) => row.show && row.startsAt)
    } catch { return [] }
  })
  const [sportsResults, tvResults] = await Promise.all([Promise.all(requests), Promise.all(tvDates)])
  const sportsEvents = sportsResults.flat().filter((row: any) => new Date(row.startsAt).getTime() >= Date.now() - 60_000)
  const episodes = tvResults.flat()
  const uniqueSports = Array.from(new Map(sportsEvents.map((row: any) => [row.id, row])).values()).sort((a: any,b: any) => Date.parse(a.startsAt)-Date.parse(b.startsAt))
  const uniqueEpisodes = Array.from(new Map(episodes.map((row: any) => [row.id, row])).values()).sort((a: any,b: any) => Date.parse(a.startsAt)-Date.parse(b.startsAt))
  const payload = { updatedAt: new Date().toISOString(), sports: uniqueSports, episodes: uniqueEpisodes, sources: ['SportScore', 'TVmaze'], broadcasterVerification: 'not_available_from_free_event_feed' }
  discoveryCache = { expiresAt: Date.now() + 10 * 60_000, payload }
  res.setHeader('Cache-Control', 'public, max-age=120, stale-while-revalidate=300')
  res.json(payload)
})

app.get('/api/img-proxy', async (req, res) => {
  const raw = String(req.query.url || '').trim()
  if (!raw || raw.length > 2048) return res.status(400).json({ error: 'invalid_image_url' })
  try {
    const target = new URL(raw)
    if (!['http:', 'https:'].includes(target.protocol)) return res.status(400).json({ error: 'image_host_not_allowed' })
    const imageUrl = target.hostname === 'image.tmdb.org'
      ? target.toString()
      : (() => {
          if (!env.XTREAM_API_BASE_URL || !env.XTREAM_PROXY_TOKEN) throw new Error('cloudflare_proxy_not_configured')
          const workerAsset = new URL('/asset', env.XTREAM_API_BASE_URL)
          workerAsset.searchParams.set('url', target.toString())
          workerAsset.searchParams.set('token', env.XTREAM_PROXY_TOKEN)
          return workerAsset.toString()
        })()
    const upstream = await fetch(imageUrl, {
      headers: { Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8', 'User-Agent': 'Mozilla/5.0 JokStream/1.0' },
      redirect: 'manual',
      signal: AbortSignal.timeout(12000)
    })
    if (upstream.status >= 300 && upstream.status < 400) {
      const location = upstream.headers.get('location')
      if (!location || new URL(location, target).hostname !== target.hostname) return res.status(502).end()
      const redirected = await fetch(new URL(location, target), { headers: { Accept: 'image/*', 'User-Agent': 'Mozilla/5.0 JokStream/1.0' }, signal: AbortSignal.timeout(12000) })
      if (!redirected.ok) return res.status(502).end()
      const contentType = redirected.headers.get('content-type') || ''
      if (!contentType.startsWith('image/')) return res.status(415).end()
      res.setHeader('Content-Type', contentType)
      res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800')
      return res.send(Buffer.from(await redirected.arrayBuffer()))
    }
    if (!upstream.ok) return res.status(502).end()
    const contentType = upstream.headers.get('content-type') || ''
    if (!contentType.startsWith('image/')) return res.status(415).end()
    res.setHeader('Content-Type', contentType)
    res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800')
    res.send(Buffer.from(await upstream.arrayBuffer()))
  } catch { res.status(502).json({ error: 'image_proxy_failed' }) }
})

app.get('/health', (_req, res) => res.json({ ok: true, service: 'jokstream-gateway' }))
app.get('/api/catalog/categories', async (req, res) => {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return res.status(503).json({ error: 'catalog_storage_not_configured' })
  const kindValue = String(req.query.kind || '')
  const kind = ['live','movie','series'].includes(kindValue) ? kindValue : null
  const q = String(req.query.q || '').trim().slice(0, 100)
  try {
    const result = await supabaseRpc('jok_catalog_categories', { p_kind: kind, p_query: q })
    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300')
    res.json(result)
  } catch { res.status(502).json({ error: 'catalog_categories_unavailable' }) }
})

app.get('/api/catalog', async (req, res) => {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return res.status(503).json({ error: 'catalog_storage_not_configured' })
  const kindValue = String(req.query.kind || '')
  const kind = ['live','movie','series'].includes(kindValue) ? kindValue : null
  const q = String(req.query.q || '').trim().slice(0, 100)
  const category = String(req.query.category || '').trim().slice(0, 160)
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 60))
  const offset = Math.max(0, Math.min(10000000, Number(req.query.offset) || 0))
  try {
    const result = await supabaseRpc('jok_catalog_page_filtered', { p_kind: kind, p_query: q, p_category: category, p_limit: limit, p_offset: offset })
    res.setHeader('Cache-Control', 'public, max-age=15, stale-while-revalidate=60')
    res.json(result)
  } catch { res.status(502).json({ error: 'catalog_storage_unavailable' }) }
})

const artworkCache = new Map<string, { expiresAt: number; value: any }>()
async function lookupCinemetaArtwork(kind: 'movie' | 'series', title: string) {
  try {
    const searchUrl = 'https://v3-cinemeta.strem.io/catalog/' + kind + '/top/search=' + encodeURIComponent(title) + '.json'
    const response = await fetch(searchUrl, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) })
    if (!response.ok) return null
    const body = await response.json() as { metas?: Array<{ id?: string; name?: string; poster?: string; background?: string }> }
    const normalize = (value: string) => value.toLocaleLowerCase('en').replace(/\(\d{4}\)/g, ' ').replace(/\b(19|20)\d{2}\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ')
    const match = (body.metas || []).find(item => item.id && normalize(item.name || '') === normalize(title))
    if (!match?.id) return { matched: false }
    let detail: any = null
    try {
      const detailResponse = await fetch('https://v3-cinemeta.strem.io/meta/' + kind + '/' + encodeURIComponent(match.id) + '.json', {
        headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000)
      })
      if (detailResponse.ok) detail = (await detailResponse.json() as { meta?: any }).meta
    } catch { /* retain catalog artwork */ }
    return {
      matched: true,
      title: detail?.name || match.name || title,
      poster: detail?.poster || match.poster || null,
      backdrop: detail?.background || match.background || null,
      overview: detail?.description || '',
      releaseYear: String(detail?.releaseInfo || '').slice(0, 4),
      rating: detail?.imdbRating || null
    }
  } catch { return null }
}

async function lookupArtwork(kind: 'movie' | 'series', title: string) {
  const key = kind + ':' + title.toLocaleLowerCase('en')
  const cached = artworkCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.value

  let value: any = null
  if (env.TMDB_API_KEY) {
    try {
      const endpoint = kind === 'movie' ? 'movie' : 'tv'
      const url = new URL('https://api.themoviedb.org/3/search/' + endpoint)
      url.searchParams.set('query', title)
      url.searchParams.set('include_adult', 'false')
      url.searchParams.set('language', 'en-US')
      url.searchParams.set('page', '1')
      url.searchParams.set('api_key', env.TMDB_API_KEY)
      const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) })
      if (response.ok) {
        const body = await response.json() as { results?: Array<any> }
        const normalize = (v: string) => v.toLocaleLowerCase('en').replace(/\(\d{4}\)/g, ' ').replace(/\b(19|20)\d{2}\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ')
        const match = (body.results || []).find(item => normalize(String(item.title || item.name || item.original_title || item.original_name || '')) === normalize(title))
        if (match) value = {
          matched: true,
          id: match.id,
          title: match.title || match.name,
          poster: match.poster_path ? 'https://image.tmdb.org/t/p/w500' + match.poster_path : null,
          backdrop: match.backdrop_path ? 'https://image.tmdb.org/t/p/w1280' + match.backdrop_path : null,
          overview: match.overview || '',
          releaseYear: String(match.release_date || match.first_air_date || '').slice(0, 4),
          rating: typeof match.vote_average === 'number' ? match.vote_average : null,
          genres: []
        }
      }
    } catch { /* fall back to Cinemeta below */ }
  }

  if (!value?.poster) {
    const fallback = await lookupCinemetaArtwork(kind, title)
    if (fallback?.matched && fallback.poster) value = { ...(value || {}), ...fallback, poster: fallback.poster, source: 'cinemeta' }
  }
  if (!value) value = { matched: false }
  artworkCache.set(key, { expiresAt: Date.now() + (value.matched ? 24 : 6) * 60 * 60_000, value })
  return value
}
app.get('/api/artwork/:kind', async (req, res) => {
  const kind = String(req.params.kind)
  const title = String(req.query.title || '').trim().slice(0, 180)
  if (!['movie', 'series'].includes(kind) || !title) return res.status(400).json({ error: 'invalid_artwork_request' })
  if (!env.TMDB_API_KEY) return res.status(503).json({ error: 'tmdb_api_key_not_configured' })
  const value = await lookupArtwork(kind as 'movie' | 'series', title)
  if (!value) return res.status(502).json({ error: 'tmdb_unavailable' })
  res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400')
  res.json(value)
})

function cleanCatalogRow(row: any) {
  const name = String(row?.name || '').trim()
  const id = String(row?.item_id || row?.id || '').trim()
  const fakeHeader = /^(?:[-=_.\s]{3,}|.*(?:^|\s)[-=]{3,}.*|.*[-=]{3,}$)$/.test(name)
  const validId = /^\d{1,20}$/.test(id)
  return Boolean(name && !fakeHeader && validId)
}
async function getPagedCatalog(kind: 'live' | 'movie' | 'series', req: express.Request) {
  const page = Math.max(1, Math.min(100000, Number(req.query.page) || 1))
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 40))
  const category = String(req.query.category || '').trim().slice(0, 160)
  const search = String(req.query.search || '').trim().slice(0, 100)
  const targetStart = (page - 1) * limit
  const chunkSize = 500
  let sourceOffset = 0
  let acceptedBefore = 0
  let items: any[] = []
  let sourceTotal = 0
  let exhausted = false
  while (!exhausted && items.length < limit && sourceOffset < 10000000) {
    const result = await supabaseRpc('jok_catalog_page_filtered', {
      p_kind: kind, p_query: search, p_category: category, p_limit: chunkSize, p_offset: sourceOffset
    })
    const rows = Array.isArray(result) ? result : Array.isArray(result?.items) ? result.items : []
    sourceTotal = Number(result?.total ?? result?.count ?? sourceTotal)
    if (!rows.length) { exhausted = true; break }
    for (const row of rows) {
      if (!cleanCatalogRow(row)) continue
      if (acceptedBefore++ < targetStart) continue
      items.push({ ...row, kind, streamAvailable: true })
      if (items.length >= limit) break
    }
    sourceOffset += rows.length
    if (rows.length < chunkSize || (sourceTotal > 0 && sourceOffset >= sourceTotal)) exhausted = true
  }
  if (kind === 'movie' || kind === 'series') {
    let cursor = 0
    const workers = Array.from({ length: Math.min(6, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++
        const item = items[index]
        if (item.image_url || item.poster) {
          item.poster = item.image_url || item.poster
          continue
        }
        const artwork = await lookupArtwork(kind, String(item.name || ''))
        item.poster = artwork?.matched ? artwork.poster : null
      }
    })
    await Promise.all(workers)
  } else if (kind === 'live' && env.XTREAM_API_BASE_URL && env.XTREAM_PROXY_TOKEN) {
    try {
      const cacheKey = 'live-provider-icons'
      const cached = artworkCache.get(cacheKey)
      let iconMap: Map<string, string>
      if (cached && cached.expiresAt > Date.now()) {
        iconMap = cached.value as Map<string, string>
      } else {
        const apiBase = env.XTREAM_API_BASE_URL!.replace(/\/$/, '')
        const params = new URLSearchParams({ action: 'get_live_streams' })
        const response = await xtreamFetch(apiBase + '?' + params, 25000)
        if (!response.ok) throw new Error('live_icons_unavailable')
        const rows = await response.json() as Array<{ stream_id?: string | number; stream_icon?: string }>
        iconMap = new Map((Array.isArray(rows) ? rows : []).map(row => [String(row.stream_id ?? ''), String(row.stream_icon ?? '')] as [string, string]).filter((entry): entry is [string, string] => /^\d+$/.test(entry[0]) && /^https?:\/\//i.test(entry[1])))
        artworkCache.set(cacheKey, { expiresAt: Date.now() + 30 * 60_000, value: iconMap })
      }
      for (const item of items) item.image_url = item.image_url || iconMap.get(String(item.item_id || item.id)) || null
    } catch { /* keep the subscribed catalog available when provider artwork is unavailable */ }
  }
  return { items, page, limit, total: sourceTotal, hasMore: !exhausted || items.length === limit }
}
for (const [path, kind] of [['/api/live', 'live'], ['/api/movies', 'movie'], ['/api/series', 'series']] as const) {
  app.get(path, async (req, res) => {
    if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return res.status(503).json({ error: 'catalog_storage_not_configured' })
    try {
      const result = await getPagedCatalog(kind, req)
      res.setHeader('Cache-Control', 'public, max-age=15, stale-while-revalidate=60')
      res.json(result)
    } catch { res.status(502).json({ error: 'catalog_storage_unavailable' }) }
  })
}

app.get('/api/home-discovery', async (_req, res) => {
  const cacheKey = 'home-discovery'
  const cached = artworkCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=900')
    return res.json(cached.value)
  }
  if (!env.TMDB_API_KEY) return res.status(503).json({ error: 'tmdb_api_key_not_configured' })
  try {
    const today = new Date().toISOString().slice(0, 10)
    const yearAgo = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10)
    const discover = async (kind: 'movie' | 'tv', sort: string, extra: Record<string, string> = {}) => {
      const url = new URL('https://api.themoviedb.org/3/discover/' + kind)
      url.searchParams.set('api_key', env.TMDB_API_KEY!)
      url.searchParams.set('language', 'en-US')
      url.searchParams.set('include_adult', 'false')
      url.searchParams.set('include_video', 'false')
      url.searchParams.set('sort_by', sort)
      url.searchParams.set('page', '1')
      for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value)
      const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12000) })
      if (!response.ok) throw new Error('tmdb_discovery_unavailable')
      const body = await response.json() as { results?: any[] }
      return (body.results || []).filter(row => row.poster_path).map(row => ({
        id: Number(row.id),
        title: String(row.title || row.name || row.original_title || row.original_name || 'Untitled'),
        overview: String(row.overview || ''),
        releaseDate: String(row.release_date || row.first_air_date || ''),
        year: String(row.release_date || row.first_air_date || '').slice(0, 4),
        rating: typeof row.vote_average === 'number' ? row.vote_average : null,
        poster: row.poster_path ? 'https://image.tmdb.org/t/p/w500' + row.poster_path : null,
        backdrop: row.backdrop_path ? 'https://image.tmdb.org/t/p/w1280' + row.backdrop_path : null
      }))
    }
    const [latestMovies, latestSeries, topMovies, topSeries] = await Promise.all([
      discover('movie', 'release_date.desc', { 'release_date.lte': today, 'release_date.gte': yearAgo, 'vote_count.gte': '10' }),
      discover('tv', 'first_air_date.desc', { 'first_air_date.lte': today, 'first_air_date.gte': yearAgo, 'vote_count.gte': '5' }),
      discover('movie', 'vote_average.desc', { 'vote_count.gte': '200' }),
      discover('tv', 'vote_average.desc', { 'vote_count.gte': '100' })
    ])
    const payload = { updatedAt: new Date().toISOString(), latestMovies: latestMovies.slice(0, 14), latestSeries: latestSeries.slice(0, 14), topMovies: topMovies.slice(0, 14), topSeries: topSeries.slice(0, 14), attribution: 'TMDB' }
    artworkCache.set(cacheKey, { expiresAt: Date.now() + 30 * 60_000, value: payload })
    res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=900')
    res.json(payload)
  } catch {
    res.status(502).json({ error: 'home_discovery_unavailable' })
  }
})

app.get('/api/hero-events', async (_req, res) => {
  const key = 'hero-events'
  const cached = artworkCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return res.json(cached.value)
  try {
    const dates = [0, 1].map(offset => {
      const d = new Date()
      d.setUTCDate(d.getUTCDate() + offset)
      return d.toISOString().slice(0, 10)
    })
    const feeds = await Promise.all(dates.map(async date => {
      const url = new URL('https://www.thesportsdb.com/api/v1/json/3/eventsday.php')
      url.searchParams.set('d', date)
      url.searchParams.set('s', 'Soccer')
      const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) })
      if (!response.ok) return []
      const body = await response.json() as { events?: any[] | null }
      return body.events || []
    }))
    const events = feeds.flat().map((event: any) => ({
      id: String(event.idEvent || ''),
      title: [event.strEvent, event.strLeague].filter(Boolean).join(' · '),
      homeTeam: event.strHomeTeam || '',
      awayTeam: event.strAwayTeam || '',
      competition: event.strLeague || '',
      start_time: event.strTimestamp || (event.dateEvent && event.strTime ? event.dateEvent + 'T' + event.strTime + 'Z' : null),
      image: event.strThumb || event.strPoster || null,
      source: 'TheSportsDB',
      linked_channel_id: null,
      channelMatchStatus: 'unmatched'
    })).filter((event: any) => event.id && event.title && event.start_time && Date.parse(event.start_time) >= Date.now() - 60000)
    let trendingMovies: any[] = []
    if (env.TMDB_API_KEY) {
      try {
        const trendingUrl = new URL('https://api.themoviedb.org/3/trending/movie/day')
        trendingUrl.searchParams.set('api_key', env.TMDB_API_KEY)
        trendingUrl.searchParams.set('language', 'en-US')
        const trendingResponse = await fetch(trendingUrl, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) })
        if (trendingResponse.ok) {
          const trendingBody = await trendingResponse.json() as { results?: any[] }
          trendingMovies = (trendingBody.results || []).slice(0, 12).map(movie => ({
            id: String(movie.id),
            title: movie.title || movie.original_title || 'Untitled movie',
            overview: movie.overview || '',
            releaseYear: String(movie.release_date || '').slice(0, 4),
            rating: typeof movie.vote_average === 'number' ? movie.vote_average : null,
            poster: movie.poster_path ? 'https://image.tmdb.org/t/p/w500' + movie.poster_path : null,
            backdrop: movie.backdrop_path ? 'https://image.tmdb.org/t/p/w1280' + movie.backdrop_path : null,
            source: 'TMDB'
          }))
        }
      } catch { /* sports fixtures remain available if TMDB is offline */ }
    }
    const payload = { updatedAt: new Date().toISOString(), events, trendingMovies, note: 'Broadcast channels are not inferred; no channel is linked unless a verified provider mapping exists.' }
    artworkCache.set(key, { expiresAt: Date.now() + 15 * 60_000, value: payload })
    res.setHeader('Cache-Control', 'public, max-age=120, stale-while-revalidate=600')
    res.json(payload)
  } catch { res.status(502).json({ error: 'sports_feed_unavailable' }) }
})

app.get('/api/status', (_req, res) => res.json({
  providerConfigured: Boolean(env.XTREAM_API_BASE_URL && env.XTREAM_PROXY_TOKEN),
  adminConfigured: Boolean(env.ADMIN_API_TOKEN),
  redistributionAuthorized: env.UPSTREAM_REDISTRIBUTION_AUTHORIZED === 'true',
  catalogStorageConfigured: Boolean(env.SUPABASE_URL && env.SUPABASE_ANON_KEY && env.CATALOG_SYNC_SECRET),
  mediaProxyConfigured: Boolean(process.env.MEDIAFLOW_BASE_URL && process.env.MEDIAFLOW_API_PASSWORD),
  updatedAt: syncState.updatedAt
}))

app.get('/api/admin/provider/diagnostics', requireAdmin, async (_req, res) => {
  if (!env.XTREAM_API_BASE_URL || !env.XTREAM_PROXY_TOKEN) {
    res.status(503).json({ error: 'cloudflare_proxy_not_configured' }); return
  }
  const base = env.XTREAM_API_BASE_URL.replace(/\/$/, '')
  const params = new URLSearchParams()
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
    if (!env.XTREAM_API_BASE_URL || !env.XTREAM_PROXY_TOKEN) throw new Error('provider_not_configured')
    if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || !env.CATALOG_SYNC_SECRET) throw new Error('catalog_storage_not_configured')
    update({ stage: 'account_request' })
    const base = trimTrailingSlash(env.XTREAM_API_BASE_URL!)
    const params = new URLSearchParams()
    const apiUrl = base + '?' + params.toString()
    const response = await xtreamFetch(apiUrl, 15_000)
    if (!response.ok) throw new Error('provider_http_' + response.status + '_account')
    const account = await response.json() as { user_info?: { auth?: number } }
    if (account.user_info?.auth !== 1) throw new Error('provider_auth_failed')
    const version = await supabaseRpc('jok_catalog_sync_begin', { p_token: env.CATALOG_SYNC_SECRET }) as string
    let total = 0
    const groups = [
      { action: 'get_live_streams', categoryAction: 'get_live_categories', kind: 'live' as const, fallback: 'Live TV' },
      { action: 'get_vod_streams', categoryAction: 'get_vod_categories', kind: 'movie' as const, fallback: 'Movies' },
      { action: 'get_series', categoryAction: 'get_series_categories', kind: 'series' as const, fallback: 'Series' }
    ]
    for (const group of groups) {
      update({ stage: group.kind + '_download', synced: total })
      const [listResponse, categoryResponse] = await Promise.all([
        xtreamFetch(apiUrl + '&action=' + group.action, 90_000),
        xtreamFetch(apiUrl + '&action=' + group.categoryAction, 30_000)
      ])
      if (!listResponse.ok) throw new Error('provider_http_' + listResponse.status + '_' + group.kind)
      const rows = await listResponse.json() as Array<{ stream_id?: string|number; series_id?: string|number; name?: string; title?: string; category_id?: string|number; container_extension?: string; stream_icon?: string; cover?: string; movie_image?: string }>
      const categoryRows = categoryResponse.ok ? await categoryResponse.json() as Array<{ category_id?: string|number; category_name?: string }> : []
      const categories = new Map(categoryRows.map(row => [String(row.category_id ?? ''), String(row.category_name ?? group.fallback)]))
      if (!Array.isArray(rows)) throw new Error('provider_invalid_catalog_' + group.kind)
      update({ stage: group.kind + '_saving', synced: total })
      let batch: Array<{kind:string;item_id:string;name:string;category:string;extension:string;image_url:string|null}> = []
      for (const row of rows) {
        const id = String(row.stream_id ?? row.series_id ?? '').trim()
        const name = String(row.name ?? row.title ?? '').trim()
        const separatorHeader = /^(?:[-=_.\s]{3,}|.*(?:^|\s)[-=]{3,}.*|.*[-=]{3,}$)$/.test(name)
        if (!/^\d{1,20}$/.test(id) || !name || separatorHeader) continue
        const rawImage = String(row.stream_icon || row.cover || row.movie_image || '')
        const imageUrl = /^https?:\/\//i.test(rawImage) ? rawImage.slice(0, 2048) : null
        batch.push({ kind: group.kind, item_id: id, name, category: categories.get(String(row.category_id ?? '')) || group.fallback, extension: row.container_extension || (group.kind === 'live' ? 'ts' : 'mp4'), image_url: imageUrl })
        if (batch.length >= 100) {
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

type PlaybackTokenEntry = { url: string; expiresAt: number }
const playbackTokens = new Map<string, PlaybackTokenEntry>()
const PLAYBACK_TOKEN_TTL_MS = 30 * 60_000

function createPlaybackToken(url: string) {
  const token = randomUUID()
  const now = Date.now()
  for (const [key, entry] of playbackTokens) if (entry.expiresAt <= now) playbackTokens.delete(key)
  playbackTokens.set(token, { url, expiresAt: now + PLAYBACK_TOKEN_TTL_MS })
  return token
}

function safeUrlForLog(value: string) {
  try {
    const url = new URL(value)
    return url.origin + url.pathname + (url.search ? '?[query-redacted]' : '')
  } catch { return '[invalid-url]' }
}

function safeXtreamUrlForLog(value: string) {
  try {
    const url = new URL(value)
    const parts = url.pathname.split('/')
    const streamIndex = parts.findIndex(part => ['live', 'movie', 'series'].includes(part))
    if (streamIndex >= 0 && parts.length > streamIndex + 2) {
      parts[streamIndex + 1] = '[username-redacted]'
      parts[streamIndex + 2] = '[password-redacted]'
    }
    return url.origin + parts.join('/')
  } catch { return '[invalid-url]' }
}

function setStreamCors(res: express.Response) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Authorization')
  res.setHeader('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Length, Content-Range, Content-Type')
  res.setHeader('Vary', 'Origin')
}

app.options('/api/stream/:token', (_req, res) => {
  setStreamCors(res)
  res.status(204).end()
})

app.all('/api/stream/:token', async (req, res) => {
  setStreamCors(res)
  if (!['GET', 'HEAD'].includes(req.method)) return res.status(405).end()
  const entry = playbackTokens.get(String(req.params.token))
  if (!entry || entry.expiresAt <= Date.now()) {
    playbackTokens.delete(String(req.params.token))
    return res.status(404).json({ error: 'playback_link_expired' })
  }
  const mediaflowBase = env.MEDIAFLOW_BASE_URL
  const workerBase = env.XTREAM_API_BASE_URL ? new URL(env.XTREAM_API_BASE_URL).origin : ''
  if (!mediaflowBase && !workerBase) return res.status(503).json({ error: 'cloudflare_proxy_not_configured' })

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 90_000)
  const abortOnDisconnect = () => {
    if (!res.writableEnded) controller.abort()
  }
  res.once('close', abortOnDisconnect)

  try {
    const target = new URL(entry.url)
    const allowedOrigins = new Set([workerBase, mediaflowBase ? new URL(mediaflowBase).origin : ''].filter(Boolean))
    if (!allowedOrigins.has(target.origin)) return res.status(403).json({ error: 'invalid_playback_target' })

    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 JokStream/1.0',
      Accept: req.header('accept') || '*/*',
      'Accept-Encoding': 'identity'
    }
    const range = req.header('range')
    const ifRange = req.header('if-range')
    if (range) headers.Range = range
    if (ifRange) headers['If-Range'] = ifRange

    const upstream = await fetch(target, {
      method: req.method,
      headers,
      redirect: 'follow',
      signal: controller.signal
    })
    res.status(upstream.status)
    if (!upstream.ok) console.warn('[stream-upstream-status]', {
      status: upstream.status,
      url: safeUrlForLog(upstream.url || target.toString()),
      hasRange: Boolean(range)
    })

    for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag', 'content-disposition']) {
      const value = upstream.headers.get(header)
      if (value) res.setHeader(header, value)
    }
    res.setHeader('Cache-Control', 'no-store')

    if (req.method === 'HEAD' || !upstream.body) return res.end()

    const finalUrl = upstream.url || target.toString()
    const contentType = upstream.headers.get('content-type') || ''
    const isManifest =
      /mpegurl|vnd\.apple\.mpegurl/i.test(contentType) ||
      /\.m3u8(?:$|[?#])/i.test(target.pathname) ||
      /\.m3u8(?:$|[?#])/i.test(new URL(finalUrl).pathname)

    if (isManifest && upstream.ok) {
      const manifest = await upstream.text()
      const allowedOrigins = new Set([workerBase, mediaflowBase ? new URL(mediaflowBase).origin : ''].filter(Boolean))
      const toGatewayUrl = (raw: string) => {
        const resolved = new URL(raw, finalUrl)
        if (!allowedOrigins.has(resolved.origin)) return raw
        return '/api/stream/' + createPlaybackToken(resolved.toString())
      }
      const rewritten = manifest.split(/\r?\n/).map(line => {
        const trimmed = line.trim()
        if (!trimmed) return line
        if (trimmed.startsWith('#')) {
          return line.replace(/URI="([^"]+)"/g, (_match, uri: string) => 'URI="' + toGatewayUrl(uri) + '"')
        }
        return toGatewayUrl(trimmed)
      }).join('\n')

      res.removeHeader('Content-Length')
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
      return res.send(rewritten)
    }

    return Readable.fromWeb(upstream.body as any).on('error', () => {
      if (!res.headersSent) res.status(502)
      res.end()
    }).pipe(res)
  } catch (error) {
    console.error('[stream-proxy]', { errorName: error instanceof Error ? error.name : 'unknown' })
    if (!res.headersSent && !res.destroyed) return res.status(502).json({ error: 'upstream_stream_failed' })
    if (!res.destroyed) res.end()
  } finally {
    clearTimeout(timeout)
    res.off('close', abortOnDisconnect)
  }
})

async function generateMediaFlowUrl(
  proxyBase: string,
  endpoint: string,
  destinationUrl: string,
  providerOrigin: string
) {
  const response = await fetch(proxyBase + '/generate_url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mediaflow_proxy_url: proxyBase,
      endpoint,
      destination_url: destinationUrl,
      query_params: {},
      request_headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36',
        Accept: '*/*',
        Referer: providerOrigin + '/',
        Origin: providerOrigin
      },
      api_password: env.MEDIAFLOW_API_PASSWORD,
      expiration: 1800
    }),
    signal: AbortSignal.timeout(20_000)
  })
  if (!response.ok) throw new Error('mediaflow_url_generation_failed')
  const result = await response.json() as { url?: string }
  if (!result.url) throw new Error('mediaflow_url_missing')
  const generated = new URL(result.url)
  if (generated.origin !== new URL(proxyBase).origin) throw new Error('mediaflow_generated_external_url')
  return generated.toString()
}

app.post('/api/playback', async (req, res) => {
  const input = z.object({
    kind: z.enum(['live', 'movie', 'series']),
    id: z.string().min(1).max(64),
    seriesId: z.string().min(1).max(64).optional()
  }).safeParse(req.body)
  if (!input.success) return res.status(400).json({ error: 'invalid_playback_request' })
  if (env.UPSTREAM_REDISTRIBUTION_AUTHORIZED !== 'true') return res.status(403).json({ error: 'redistribution_not_authorized' })
  if (!env.XTREAM_API_BASE_URL || !env.XTREAM_PROXY_TOKEN) return res.status(503).json({ error: 'cloudflare_proxy_not_configured' })

  let stage = 'initialize'
  try {
    const { kind, id, seriesId } = input.data
    let extension = kind === 'live' ? 'm3u8' : 'mp4'
    const apiBase = env.XTREAM_API_BASE_URL.replace(/\/$/, '')

    if (kind === 'series') {
      stage = 'series_info'
      if (!seriesId) return res.status(400).json({ error: 'series_id_required' })
      const params = new URLSearchParams({ action: 'get_series_info', series_id: seriesId })
      const infoResponse = await xtreamFetch(apiBase + '?' + params, 20_000)
      if (!infoResponse.ok) throw new Error('series_info_http_' + infoResponse.status)
      const info = await infoResponse.json() as { episodes?: Record<string, Array<{ id?: string | number; container_extension?: string }>> }
      const episode = Object.values(info.episodes || {}).flat().find(row => String(row.id ?? '') === id)
      if (!episode) return res.status(404).json({ error: 'episode_not_found' })
      extension = String(episode.container_extension || 'mp4').replace(/^\./, '').toLowerCase()
    } else if (kind === 'movie') {
      // VOD details are optional: some providers reject get_vod_info even when
      // the catalog and stream endpoints are available. Keep playback URL
      // creation working with the standard mp4 extension in that case.
      stage = 'movie_info'
      try {
        const params = new URLSearchParams({ action: 'get_vod_info', vod_id: id })
        const infoResponse = await xtreamFetch(apiBase + '?' + params, 20_000)
        if (infoResponse.ok) {
          const info = await infoResponse.json() as { movie_data?: { container_extension?: string }; info?: { container_extension?: string }; container_extension?: string }
          extension = String(info.movie_data?.container_extension || info.info?.container_extension || info.container_extension || 'mp4').replace(/^\./, '').toLowerCase()
        } else {
          console.warn('[vod-info-fallback]', { status: infoResponse.status })
        }
      } catch (error) {
        console.warn('[vod-info-fallback]', { errorName: error instanceof Error ? error.name : 'unknown' })
      }
    }

    stage = 'build_playback_url'
    if (!/^[a-z0-9]{2,6}$/.test(extension)) extension = kind === 'live' ? 'm3u8' : 'mp4'
    if (kind === 'live') extension = 'm3u8'

    const path = kind === 'live' ? 'live' : kind === 'movie' ? 'movie' : 'series'
    const workerOrigin = new URL(env.XTREAM_API_BASE_URL).origin
    const upstream = new URL('/stream/' + path + '/' + encodeURIComponent(id) + '.' + extension, workerOrigin)
    upstream.searchParams.set('token', env.XTREAM_PROXY_TOKEN)
    const upstreamUrl = upstream.toString()
    const isLive = kind === 'live'
    const isVodHls = !isLive && extension === 'm3u8'
    const transcodeHls = !isLive && ['mkv', 'avi', 'ts'].includes(extension)
    let primaryTarget = upstreamUrl
    if (transcodeHls) {
      stage = 'mediaflow_url'
      if (!env.MEDIAFLOW_BASE_URL || !env.MEDIAFLOW_API_PASSWORD) return res.status(503).json({ error: 'media_proxy_not_configured_for_transcode' })
      const proxyBase = env.MEDIAFLOW_BASE_URL.replace(/\/$/, '')
      primaryTarget = await generateMediaFlowUrl(proxyBase, '/proxy/transcode/playlist.m3u8', upstreamUrl, workerOrigin)
    }
    const primaryToken = createPlaybackToken(primaryTarget)
    const publicUrl = new URL('/api/stream/' + primaryToken, req.protocol + '://' + req.get('host'))
    publicUrl.searchParams.set('format', isLive || isVodHls || transcodeHls ? 'hls' : 'file')

    let fallbackUrl: string | undefined
    if (isLive) {
      const tsUrl = new URL('/stream/live/' + encodeURIComponent(id) + '.ts', workerOrigin)
      tsUrl.searchParams.set('token', env.XTREAM_PROXY_TOKEN)
      const fallbackTarget = tsUrl.toString()
      const fallbackToken = createPlaybackToken(fallbackTarget)
      const fallback = new URL('/api/stream/' + fallbackToken, req.protocol + '://' + req.get('host'))
      fallback.searchParams.set('format', 'mpegts')
      fallbackUrl = fallback.toString()
    }

    res.setHeader('Cache-Control', 'no-store')
    res.json({
      url: publicUrl.toString(),
      fallbackUrl,
      expiresIn: 1800,
      kind,
      extension,
      playbackType: isLive || isVodHls || transcodeHls ? 'hls' : 'file',
      fallbackPlaybackType: isLive ? 'mpegts' : undefined
    })
  } catch (error) {
    console.error('[playback-url-error]', {
      kind: input.data.kind,
      stage,
      errorName: error instanceof Error ? error.name : 'unknown',
      errorCode: error instanceof Error && /^[a-z0-9_]{1,80}$/i.test(error.message) ? error.message : undefined
    })
    res.status(502).json({ error: 'playback_url_generation_failed' })
  }
})

const metadataCache = new Map<string, { expiresAt: number; value: unknown }>()
function normalizeMediaTitle(value: string) {
  return value.toLocaleLowerCase('en').replace(/\(\d{4}\)/g, ' ').replace(/\b(19|20)\d{2}\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ')
}
app.get('/api/metadata/:kind', async (req, res) => {
  const kind = String(req.params.kind)
  const title = String(req.query.title || '').trim().slice(0, 180)
  if (!['movie','series'].includes(kind) || !title) return res.status(400).json({ error: 'invalid_metadata_request' })
  const cacheKey = kind + ':' + title.toLocaleLowerCase('en')
  const cached = metadataCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    res.setHeader('Cache-Control', 'public, max-age=3600')
    return res.json(cached.value)
  }
  try {
    const searchUrl = 'https://v3-cinemeta.strem.io/catalog/' + kind + '/top/search=' + encodeURIComponent(title) + '.json'
    const searchResponse = await fetch(searchUrl, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) })
    if (!searchResponse.ok) throw new Error('metadata_search_failed')
    const searchData = await searchResponse.json() as { metas?: Array<{ id?: string; type?: string; name?: string; poster?: string; background?: string; description?: string; releaseInfo?: string; imdbRating?: string; genres?: string[]; runtime?: string; cast?: string[]; director?: string[] }> }
    const expected = normalizeMediaTitle(title)
    const candidates = searchData.metas || []
    const match = candidates.find(item => item.id && normalizeMediaTitle(item.name || '') === expected)
    if (!match?.id) {
      const empty = { matched: false }
      metadataCache.set(cacheKey, { expiresAt: Date.now() + 6 * 60 * 60_000, value: empty })
      return res.json(empty)
    }
    let meta: any = match
    try {
      const detailResponse = await fetch('https://v3-cinemeta.strem.io/meta/' + kind + '/' + encodeURIComponent(match.id) + '.json', { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) })
      if (detailResponse.ok) {
        const detailData = await detailResponse.json() as { meta?: unknown }
        if (detailData.meta) meta = detailData.meta
      }
    } catch { /* retain the matched catalog metadata */ }
    const value = { matched: true, meta }
    metadataCache.set(cacheKey, { expiresAt: Date.now() + 24 * 60 * 60_000, value })
    res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400')
    res.json(value)
  } catch {
    res.status(502).json({ error: 'metadata_provider_unavailable' })
  }
})

app.get('/api/movie/:id', async (req, res) => {
  if (!env.XTREAM_API_BASE_URL || !env.XTREAM_PROXY_TOKEN) return res.status(503).json({ error: 'provider_not_configured' })
  try {
    const params = new URLSearchParams({ action: 'get_vod_info', vod_id: req.params.id })
    const apiBase = env.XTREAM_API_BASE_URL!.replace(/\/$/, '')
    const response = await xtreamFetch(apiBase + '?' + params, 20_000)
    if (!response.ok) throw new Error('provider_error')
    res.setHeader('Cache-Control', 'private, max-age=300')
    res.json(await response.json())
  } catch { res.status(502).json({ error: 'movie_details_unavailable' }) }
})

app.get('/api/series/:id', async (req, res) => {
  if (!env.XTREAM_API_BASE_URL || !env.XTREAM_PROXY_TOKEN) return res.status(503).json({ error: 'provider_not_configured' })
  try {
    const params = new URLSearchParams({ action: 'get_series_info', series_id: req.params.id })
    const apiBase = env.XTREAM_API_BASE_URL!.replace(/\/$/, '')
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
