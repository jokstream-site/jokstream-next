const STATIC_CACHE = 'jokstream-static-v1'
const DATA_CACHE = 'jokstream-public-data-v1'
const MAX_DATA_ENTRIES = 100
const DATA_PATHS = [
  /^\/api\/catalog(?:\/categories)?$/,
  /^\/api\/(?:live|movies|series)$/,
  /^\/api\/metadata\/(?:movie|series)\/[^/]+$/,
  /^\/api\/artwork\/(?:movie|series)\/[^/]+$/
]

self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.filter(key => key.startsWith('jokstream-') && ![STATIC_CACHE, DATA_CACHE].includes(key)).map(key => caches.delete(key)))
    await self.clients.claim()
  })())
})

function isPublicDataRequest(request, url) {
  return request.method === 'GET' &&
    url.origin === self.location.origin &&
    DATA_PATHS.some(pattern => pattern.test(url.pathname)) &&
    !request.headers.has('authorization') &&
    request.cache !== 'no-store'
}

function cacheLifetime(response) {
  const value = response.headers.get('Cache-Control') || ''
  if (/private|no-store|no-cache/i.test(value) || !/public/i.test(value)) return 0
  const match = value.match(/(?:s-maxage|max-age)=(\d+)/i)
  return match ? Math.min(30 * 60, Math.max(30, Number(match[1]))) : 0
}

async function trimDataCache(cache) {
  const keys = await cache.keys()
  if (keys.length <= MAX_DATA_ENTRIES) return
  await Promise.all(keys.slice(0, keys.length - MAX_DATA_ENTRIES).map(key => cache.delete(key)))
}

async function refreshPublicData(request, cache, cached) {
  try {
    const response = await fetch(request)
    const ttl = response.ok ? cacheLifetime(response) : 0
    const contentType = response.headers.get('Content-Type') || ''
    if (ttl > 0 && contentType.includes('application/json') && !response.headers.has('Set-Cookie')) {
      const headers = new Headers(response.headers)
      headers.set('X-JokStream-Cached-At', String(Date.now()))
      await cache.put(request, new Response(await response.clone().arrayBuffer(), {
        status: response.status,
        statusText: response.statusText,
        headers
      }))
      await trimDataCache(cache)
    }
    return response
  } catch (error) {
    if (cached) return cached
    throw error
  }
}

self.addEventListener('fetch', event => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith((async () => {
      const cache = await caches.open(STATIC_CACHE)
      const cached = await cache.match(request)
      if (cached) return cached
      const response = await fetch(request)
      if (response.ok && response.type === 'basic') await cache.put(request, response.clone())
      return response
    })())
    return
  }

  if (!isPublicDataRequest(request, url)) return
  event.respondWith((async () => {
    const cache = await caches.open(DATA_CACHE)
    const cached = await cache.match(request)
    if (cached) {
      const storedAt = Number(cached.headers.get('X-JokStream-Cached-At') || 0)
      const ttl = cacheLifetime(cached) * 1000
      if (storedAt && Date.now() - storedAt < ttl) return cached
      event.waitUntil(refreshPublicData(request, cache, cached).catch(() => {}))
      return cached
    }
    return refreshPublicData(request, cache, null)
  })())
})
