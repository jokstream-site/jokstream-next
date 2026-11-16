const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Range, If-Range",
  "Access-Control-Expose-Headers": "Accept-Ranges, Content-Length, Content-Range, Content-Type"
};
function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}
function getConfig(env) {
  if (!env.XIRO_M3U_URL || !env.JOKSTREAM_PROXY_TOKEN) throw new Error("Worker secrets are not configured");
  const playlist = new URL(env.XIRO_M3U_URL);
  if (!["http:", "https:"].includes(playlist.protocol)) throw new Error("Unsupported provider protocol");
  const username = playlist.searchParams.get("username");
  const password = playlist.searchParams.get("password");
  if (!username || !password) throw new Error("Provider URL must contain username and password parameters");
  return { origin: playlist.origin, username, password, playlistUrl: env.XIRO_M3U_URL };
}
function authorized(request, env, url, allowQuery = false) {
  const header = request.headers.get("Authorization") || "";
  return header === "Bearer " + env.JOKSTREAM_PROXY_TOKEN ||
    (allowQuery && url.searchParams.get("token") === env.JOKSTREAM_PROXY_TOKEN);
}
function providerStreamUrl(cfg, pathname, search = "") {
  const raw = pathname.slice("/stream/".length);
  if (!raw || raw.length > 4096 || raw.includes("\\\\") || /[\\u0000-\\u001f]/.test(raw)) {
    throw new Error("Invalid stream path");
  }
  const parts = raw.split("/").filter(Boolean);
  if (parts.some(part => part === "." || part === "..")) throw new Error("Invalid stream path");
  const category = ["live", "movie", "series"].includes(parts[0]) ? parts.shift() : null;
  const upstreamPath = category
    ? "/" + category + "/" + encodeURIComponent(cfg.username) + "/" +
      encodeURIComponent(cfg.password) + "/" + parts.map(part => encodeURIComponent(decodeURIComponent(part))).join("/")
    : "/" + raw.split("/").map(part => encodeURIComponent(decodeURIComponent(part))).join("/");
  const target = new URL(upstreamPath, cfg.origin);
  const incoming = new URLSearchParams(search);
  for (const [key, value] of incoming) {
    if (key.toLowerCase() === "username" || key.toLowerCase() === "password") continue;
    target.searchParams.append(key, value);
  }
  return target;
}
// Playback destinations come from the authenticated provider's redirects and HLS manifests.
// CDN hostnames and HTTP/HTTPS may vary between channels; do not maintain a per-CDN allowlist.
function isPublicProviderHost(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host === "localhost" || /\.(?:localhost|local|internal|lan|home\.arpa)$/.test(host)) return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    const octets = host.split(".").map(Number);
    if (octets.some(value => value > 255)) return false;
    const [a, b, c] = octets;
    if (a === 0 || a === 10 || a === 127 || a >= 224 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) ||
        (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
        (a === 203 && b === 0 && c === 113)) return false;
    return true;
  }
  if (host.startsWith("[") && host.endsWith("]")) {
    const address = host.slice(1, -1);
    return /^2[0-9a-f]{3}:/i.test(address) && !/^2001:db8:/i.test(address);
  }
  return host.includes(".") && !host.includes("..");
}
function isAllowedProviderTarget(target, cfg) {
  if (target.username || target.password || !["http:", "https:"].includes(target.protocol)) return false;
  if (target.origin === cfg.origin) return true;
  return isPublicProviderHost(target.hostname);
}
// The generic asset endpoint remains on its previous narrow policy; playback uses provider-origin trust.
const ASSET_CDN_HOSTS = new Set(["burn.arshas.com", "bpair.arshas.com"]);
function isAllowedAssetTarget(target, cfg) {
  if (target.username || target.password || target.protocol !== "https:") return false;
  if (target.origin === cfg.origin) return true;
  return ASSET_CDN_HOSTS.has(target.hostname) && (target.port === "" || target.port === "443");
}
function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function base64UrlToBytes(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}
async function hlsCryptoKey(secret) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
async function sealHlsTarget(target, secret) {
  const key = await hlsCryptoKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(target));
  const payload = new Uint8Array(iv.length + encrypted.byteLength);
  payload.set(iv);
  payload.set(new Uint8Array(encrypted), iv.length);
  return bytesToBase64Url(payload);
}
async function openHlsTarget(token, secret) {
  const payload = base64UrlToBytes(token);
  if (payload.length < 29) throw new Error("Invalid HLS resource token");
  const key = await hlsCryptoKey(secret);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: payload.slice(0, 12) }, key, payload.slice(12));
  const target = new URL(new TextDecoder().decode(plain));
  if (!["http:", "https:"].includes(target.protocol)) throw new Error("Unsupported HLS resource protocol");
  return target;
}
async function hlsResourceUrl(target, requestUrl, secret) {
  const token = await sealHlsTarget(target.toString(), secret);
  return new URL("/hls/" + token, requestUrl).toString();
}
async function rewriteHlsManifest(body, target, requestUrl, cfg, secret, targetPolicy = isAllowedProviderTarget) {
  const lines = body.replace(/^\uFEFF/, "").split(/\r?\n/);
  const output = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { output.push(line); continue; }
    if (trimmed.startsWith("#")) {
      const pattern = /(\bURI\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^,\s]+))/gi;
      const matches = [...line.matchAll(pattern)];
      let rewritten = line;
      for (const match of matches) {
        const raw = match[2] ?? match[3] ?? match[4];
        const resolved = new URL(raw, target);
        if (!targetPolicy(resolved, cfg)) throw new Error("HLS manifest contains a disallowed resource URI");
        const proxyUrl = await hlsResourceUrl(resolved, requestUrl, secret);
        const quote = match[2] !== undefined ? '"' : match[3] !== undefined ? "'" : "";
        rewritten = rewritten.replace(match[0], match[1] + quote + proxyUrl + quote);
      }
      output.push(rewritten);
    } else {
      const resolved = new URL(trimmed, target);
      if (!targetPolicy(resolved, cfg)) throw new Error("HLS manifest contains a disallowed resource URI");
      const proxyUrl = await hlsResourceUrl(resolved, requestUrl, secret);
      const leading = line.match(/^\s*/)?.[0] || "";
      const trailing = line.match(/\s*$/)?.[0] || "";
      output.push(leading + proxyUrl + trailing);
    }
  }
  return output.join("\n");
}
async function resolvePlaylistStreamTarget(cfg, id) {
  const playlist = await fetch(cfg.playlistUrl, {
    headers: { "User-Agent": "okhttp/5.0.0-alpha.2", Accept: "*/*" },
    redirect: "follow", signal: AbortSignal.timeout(30000)
  });
  if (!playlist.ok) throw new Error("provider_playlist_http_" + playlist.status);
  const body = await playlist.text();
  for (const line of body.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const value = line.trim();
    if (!value || value.startsWith("#")) continue;
    try {
      const candidate = new URL(value, cfg.origin);
      const segments = candidate.pathname.split("/").filter(Boolean).map(part => {
        try { return decodeURIComponent(part); } catch { return part; }
      });
      const segmentMatch = segments.some(part => new RegExp("^" + id + "(?:\\.(?:ts|m3u8|mp4|mkv|avi))?$", "i").test(part));
      const queryMatch = [...candidate.searchParams.entries()].some(([key, val]) =>
        /^(?:stream_?id|id)$/i.test(key) && val === id);
      if (segmentMatch || queryMatch) {
        if (!isAllowedProviderTarget(candidate, cfg)) throw new Error("provider_playlist_target_rejected");
        return candidate;
      }
    } catch (error) {
      if (error instanceof Error && error.message === "provider_playlist_target_rejected") throw error;
    }
  }
  throw new Error("provider_stream_not_found_in_playlist");
}
async function proxyProvider(request, cfg, target, env, redirectDepth = 0, targetPolicy = isAllowedProviderTarget) {
  if (!targetPolicy(target, cfg)) return json({ error: "Provider target rejected" }, 403);
  const headers = new Headers({
    "User-Agent": "okhttp/5.0.0-alpha.2",
    "Accept": request.headers.get("Accept") || "*/*",
    "Accept-Encoding": "identity",
    "Referer": cfg.origin + "/",
    "Origin": cfg.origin
  });
  for (const name of ["Range", "If-Range"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const upstream = await fetch(target, {
    method: request.method === "HEAD" ? "HEAD" : "GET",
    headers, redirect: "manual", signal: AbortSignal.timeout(90000)
  });
  if (upstream.status >= 300 && upstream.status < 400) {
    const location = upstream.headers.get("Location");
    if (!location) return json({ error: "Provider redirect missing location" }, 502);
    if (redirectDepth >= 4) return json({ error: "Provider redirect limit exceeded" }, 502);
    const redirected = new URL(location, target);
    if (!targetPolicy(redirected, cfg)) return json({ error: "Provider redirect target rejected" }, 502);
    return proxyProvider(request, cfg, redirected, env, redirectDepth + 1, targetPolicy);
  }
  const responseHeaders = new Headers(cors);
  for (const name of ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "Last-Modified", "ETag", "Content-Disposition"]) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  responseHeaders.set("Cache-Control", "no-store");
  const contentType = upstream.headers.get("Content-Type") || "";
  const isManifest = /mpegurl|vnd\.apple\.mpegurl/i.test(contentType) || /\.m3u8(?:$|[?#])/i.test(target.pathname);
  if (upstream.ok && isManifest && request.method !== "HEAD") {
    const body = await upstream.text();
    const rewritten = await rewriteHlsManifest(body, target, request.url, cfg, env.JOKSTREAM_PROXY_TOKEN, targetPolicy);
    responseHeaders.delete("Content-Length");
    responseHeaders.set("Content-Type", "application/vnd.apple.mpegurl");
    return new Response(rewritten, { status: upstream.status, headers: responseHeaders });
  }
  return new Response(request.method === "HEAD" ? null : upstream.body, { status: upstream.status, headers: responseHeaders });
}
async function apiFetch(cfg, params = {}) {
  const u = new URL("/player_api.php", cfg.origin);
  u.searchParams.set("username", cfg.username);
  u.searchParams.set("password", cfg.password);
  for (const [key, value] of Object.entries(params)) u.searchParams.set(key, String(value));
  return fetch(u, {
    headers: { Accept: "application/json", "User-Agent": "okhttp/5.0.0-alpha.2" },
    redirect: "follow", signal: AbortSignal.timeout(25000)
  });
}

async function probeStream(cfg, id, ext) {
  let target = new URL("/live/" + encodeURIComponent(cfg.username) + "/" +
    encodeURIComponent(cfg.password) + "/" + id + "." + ext, cfg.origin);
  const headers = {
    "User-Agent": "okhttp/5.0.0-alpha.2",
    "Accept": "*/*",
    "Accept-Encoding": "identity",
    "Referer": cfg.origin + "/",
    "Origin": cfg.origin
  };
  const redirectChain = [];
  let response;
  try {
    for (let depth = 0; depth <= 4; depth++) {
      if (!isAllowedProviderTarget(target, cfg)) {
        return { format: ext, ok: false, error: "redirect_target_rejected", redirectChain, rejectedHost: target.hostname };
      }
      response = await fetch(target, { headers, redirect: "manual", signal: AbortSignal.timeout(25000) });
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get("Location");
      redirectChain.push({ status: response.status, host: target.hostname });
      if (!location) return { format: ext, ok: false, status: response.status, error: "redirect_missing_location", redirectChain };
      if (depth === 4) return { format: ext, ok: false, status: response.status, error: "redirect_limit_exceeded", redirectChain };
      target = new URL(location, target);
    }
  } catch (error) {
    return { format: ext, ok: false, error: error instanceof Error ? error.name : "fetch_failed", redirectChain };
  }
  const result = {
    format: ext,
    status: response.status,
    ok: response.ok,
    finalHost: target.hostname,
    contentType: response.headers.get("Content-Type"),
    contentLength: response.headers.get("Content-Length"),
    acceptRanges: response.headers.get("Accept-Ranges"),
    redirectChain
  };
  if (response.ok && ext === "m3u8") {
    const body = await response.text();
    const hosts = new Set();
    for (const line of body.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const uris = trimmed.startsWith("#")
        ? [...trimmed.matchAll(/\bURI\s*=\s*(?:"([^"]*)"|'([^']*)'|([^,\s]+))/gi)].map(match => match[1] ?? match[2] ?? match[3])
        : [trimmed];
      for (const uri of uris) {
        try { hosts.add(new URL(uri, target).hostname); } catch {}
      }
    }
    result.manifestBytes = new TextEncoder().encode(body).length;
    result.resourceHosts = [...hosts].slice(0, 12);
    result.hasCrossOriginResources = [...hosts].some(host => host !== new URL(cfg.origin).hostname);
  } else if (response.body) {
    await response.body.cancel();
  }
  return result;
}

async function probePlaylistStream(cfg, id) {
  const playlist = await fetch(cfg.playlistUrl, {
    headers: { "User-Agent": "okhttp/5.0.0-alpha.2", Accept: "*/*" },
    redirect: "follow", signal: AbortSignal.timeout(30000)
  });
  if (!playlist.ok) return { ok: false, stage: "playlist", status: playlist.status };
  const body = await playlist.text();
  let streamTarget = null;
  let matchedBy = null;
  const hosts = new Set();
  let entries = 0;
  let idMentions = 0;
  const pathShapes = [];
  for (const line of body.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const value = line.trim();
    if (!value || value.startsWith("#")) continue;
    entries++;
    try {
      const candidate = new URL(value, cfg.origin);
      hosts.add(candidate.hostname);
      const segments = candidate.pathname.split("/").filter(Boolean).map(part => {
        try { return decodeURIComponent(part); } catch { return part; }
      });
      const segmentMatch = segments.find(part => new RegExp("^" + id + "(?:\\.(?:ts|m3u8|mp4))?$", "i").test(part));
      const queryMatch = [...candidate.searchParams.entries()].some(([key, val]) =>
        /^(?:stream_?id|id)$/i.test(key) && val === id);
      if (segmentMatch || queryMatch) {
        idMentions++;
        if (!streamTarget) {
          streamTarget = candidate;
          matchedBy = segmentMatch ? "path_segment" : "query_parameter";
        }
      } else if (pathShapes.length < 5 && candidate.pathname.includes("/")) {
        pathShapes.push({
          host: candidate.hostname,
          pathSegments: segments.length,
          finalSegmentPattern: segments.length ? (segments[segments.length - 1].replace(/\\d/g, "N").slice(-18)) : ""
        });
      }
    } catch {}
  }
  if (!streamTarget) return {
    ok: false, stage: "playlist_lookup", matched: false, entries,
    idMentions, hosts: [...hosts].slice(0, 8), pathShapes
  };
  const headers = {
    "User-Agent": "okhttp/5.0.0-alpha.2", Accept: "*/*", "Accept-Encoding": "identity",
    Referer: cfg.origin + "/", Origin: cfg.origin
  };
  const redirectChain = [];
  let response;
  let target = streamTarget;
  try {
    for (let depth = 0; depth <= 4; depth++) {
      if (!isAllowedProviderTarget(target, cfg)) {
        return { ok: false, stage: "playlist_target", error: "unsafe_target", streamHost: streamTarget.hostname, matchedBy, redirectChain };
      }
      response = await fetch(target, { headers, redirect: "manual", signal: AbortSignal.timeout(25000) });
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get("Location");
      redirectChain.push({ status: response.status, host: target.hostname });
      if (!location || depth === 4) return { ok: false, stage: "playlist_redirect", status: response.status, streamHost: streamTarget.hostname, matchedBy, redirectChain };
      target = new URL(location, target);
    }
  } catch (error) {
    return { ok: false, stage: "playlist_fetch", error: error instanceof Error ? error.name : "fetch_failed", streamHost: streamTarget.hostname, matchedBy, redirectChain };
  }
  const result = {
    ok: response.ok, stage: "playlist_stream", status: response.status,
    matchedBy, streamHost: streamTarget.hostname, finalHost: target.hostname,
    contentType: response.headers.get("Content-Type"),
    contentLength: response.headers.get("Content-Length"), redirectChain
  };
  if (response.body) await response.body.cancel();
  return result;
}
function firstHlsResource(manifest) {
  for (const line of manifest.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) {
      const match = trimmed.match(/\bURI\s*=\s*(?:\"([^\"]*)\"|'([^']*)'|([^,\s]+))/i);
      if (match) return match[1] ?? match[2] ?? match[3];
    } else return trimmed;
  }
  return null;
}
async function cancelResponseBody(response) {
  try { if (response.body) { const reader = response.body.getReader(); await reader.read(); await reader.cancel(); } } catch {}
}
async function probeHlsPipeline(request, cfg, id, env) {
  const stages = [];
  const streamUrl = new URL('/stream/live/' + id + '.m3u8', request.url);
  try {
    const streamRequest = new Request(streamUrl, { method: 'GET', headers: { Authorization: 'Bearer ' + env.JOKSTREAM_PROXY_TOKEN, Accept: 'application/vnd.apple.mpegurl,*/*' } });
    const response = await proxyProvider(streamRequest, cfg, providerStreamUrl(cfg, streamUrl.pathname), env);
    const contentType = response.headers.get('Content-Type') || '';
    stages.push({ stage: 'hls_stream', status: response.status, ok: response.ok, contentType });
    if (!response.ok) { await cancelResponseBody(response); return { id, ok: false, stages }; }
    const manifest = await response.text();
    stages.push({ stage: 'manifest_rewrite', ok: manifest.includes('/hls/'), bytes: new TextEncoder().encode(manifest).length });
    if (!manifest.includes('/hls/')) return { id, ok: false, stages, error: 'manifest_resources_not_rewritten' };
    let resourcePath = firstHlsResource(manifest);
    let depth = 0;
    while (resourcePath && depth < 2) {
      const resourceUrl = new URL(resourcePath, request.url);
      if (resourceUrl.origin !== new URL(request.url).origin || !resourceUrl.pathname.startsWith('/hls/')) return { id, ok: false, stages: stages.concat([{ stage: 'hls_resource', ok: false, error: 'resource_not_worker_local' }]) };
      const token = resourceUrl.pathname.slice('/hls/'.length);
      const target = await openHlsTarget(token, env.JOKSTREAM_PROXY_TOKEN);
      if (!isAllowedProviderTarget(target, cfg)) return { id, ok: false, stages: stages.concat([{ stage: 'hls_resource', ok: false, error: 'resource_host_rejected' }]) };
      const childRequest = new Request(resourceUrl, { method: 'GET', headers: { Accept: 'application/vnd.apple.mpegurl,*/*', Range: 'bytes=0-0' } });
      const childResponse = await proxyProvider(childRequest, cfg, target, env);
      const childType = childResponse.headers.get('Content-Type') || '';
      const isManifest = /mpegurl|vnd\.apple\.mpegurl/i.test(childType) || /\.m3u8(?:$|[?#])/i.test(target.pathname);
      stages.push({ stage: depth === 0 ? 'first_hls_resource' : 'first_media_resource', status: childResponse.status, ok: childResponse.ok, host: target.hostname, contentType: childType, isManifest });
      if (!childResponse.ok) { await cancelResponseBody(childResponse); return { id, ok: false, stages }; }
      if (isManifest) {
        const childManifest = await childResponse.text();
        resourcePath = firstHlsResource(childManifest);
        if (!resourcePath) return { id, ok: false, stages: stages.concat([{ stage: 'nested_manifest', ok: false, error: 'manifest_has_no_resources' }]) };
      } else { await cancelResponseBody(childResponse); resourcePath = null; }
      depth++;
    }
    return { id, ok: stages.every(stage => stage.ok !== false), stages };
  } catch (error) {
    stages.push({ stage: 'pipeline_exception', ok: false, error: error instanceof Error ? error.name : 'fetch_failed' });
    return { id, ok: false, stages };
  }
}
async function inspect(cfg, action, label) {
  const r = await apiFetch(cfg, { action });
  if (!r.ok) return { test: label, ok: false, status: r.status };
  const data = await r.json();
  return { test: label, ok: true, status: r.status,
    count: Array.isArray(data) ? data.length : null,
    sample: Array.isArray(data) ? data.slice(0, 8).map(x => x.name || x.title || x.category_name || "بدون اسم") : null };
}
async function inspectLiveChannels(cfg, url) {
  const response = await apiFetch(cfg, { action: "get_live_streams" });
  if (!response.ok) return { test: "live_channels", ok: false, status: response.status };
  const data = await response.json();
  if (!Array.isArray(data)) return { test: "live_channels", ok: false, error: "unexpected_provider_response" };
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 100));
  const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
  const query = (url.searchParams.get("q") || "").trim().toLowerCase();
  const categoryId = (url.searchParams.get("category_id") || "").trim();
  const filtered = data.filter(item => {
    if (categoryId && String(item.category_id ?? "") !== categoryId) return false;
    if (!query) return true;
    return [item.name, item.stream_id, item.epg_channel_id, item.category_name]
      .some(value => value != null && String(value).toLowerCase().includes(query));
  });
  const channels = filtered.slice(offset, offset + limit).map(item => ({
    id: item.stream_id ?? null,
    name: item.name ?? null,
    categoryId: item.category_id ?? null,
    categoryName: item.category_name ?? null,
    streamType: item.stream_type ?? "live",
    containerExtension: item.container_extension ?? null,
    epgChannelId: item.epg_channel_id ?? null,
    hasDirectSource: Boolean(item.direct_source)
  }));
  return { test: "live_channels", ok: true, total: data.length, matched: filtered.length,
    offset, limit, returned: channels.length, hasMore: offset + channels.length < filtered.length,
    query: query || null, categoryId: categoryId || null, channels };
}
async function inspectLiveCategories(cfg) {
  const response = await apiFetch(cfg, { action: "get_live_categories" });
  if (!response.ok) return { test: "live_categories", ok: false, status: response.status };
  const data = await response.json();
  if (!Array.isArray(data)) return { test: "live_categories", ok: false, error: "unexpected_provider_response" };
  return { test: "live_categories", ok: true, count: data.length,
    categories: data.map(item => ({ id: item.category_id ?? null, name: item.category_name ?? null })) };
}
export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (!["GET", "HEAD"].includes(request.method)) return json({ error: "Method not allowed" }, 405);
    const url = new URL(request.url);
    try {
      const cfg = getConfig(env);
      if (url.pathname === "/api") {
        if (!authorized(request, env, url)) return json({ error: "Unauthorized" }, 401);
        const upstreamUrl = new URL("/player_api.php", cfg.origin);
        upstreamUrl.searchParams.set("username", cfg.username);
        upstreamUrl.searchParams.set("password", cfg.password);
        const allowed = new Set(["action", "stream_id", "series_id", "category_id", "vod_id"]);
        for (const [key, value] of url.searchParams) {
          if (key === "username" || key === "password") continue;
          if (!allowed.has(key)) return json({ error: "Unsupported parameter" }, 400);
          upstreamUrl.searchParams.set(key, value);
        }
        const upstream = await fetch(upstreamUrl, {
          headers: { Accept: "application/json", "User-Agent": "okhttp/5.0.0-alpha.2" },
          redirect: "follow", signal: AbortSignal.timeout(90000)
        });
        return new Response(await upstream.arrayBuffer(), {
          status: upstream.status,
          headers: { ...cors, "Content-Type": upstream.headers.get("Content-Type") || "application/json", "Cache-Control": "no-store" }
        });
      }
      if (url.pathname.startsWith("/stream/")) {
        if (!authorized(request, env, url, true)) return json({ error: "Unauthorized" }, 401);
        const requested = providerStreamUrl(cfg, url.pathname, url.search);
        const match = url.pathname.match(/^\/stream\/(?:live|movie|series)\/(\d+)\.(?:ts|m3u8|mp4|mkv|avi)$/i);
        const target = match ? await resolvePlaylistStreamTarget(cfg, match[1]) : requested;
        return proxyProvider(request, cfg, target, env);
      }
      if (url.pathname.startsWith("/hls/")) {
        const token = url.pathname.slice("/hls/".length);
        if (!token || token.includes("/") || token.length > 8192) return json({ error: "Invalid HLS token" }, 400);
        const target = await openHlsTarget(token, env.JOKSTREAM_PROXY_TOKEN);
        if (!isAllowedProviderTarget(target, cfg)) return json({ error: "HLS resource target rejected" }, 403);
        return proxyProvider(request, cfg, target, env);
      }
      if (url.pathname === "/asset") {
        if (!authorized(request, env, url, true)) return json({ error: "Unauthorized" }, 401);
        const raw = url.searchParams.get("url");
        if (!raw || raw.length > 4096) return json({ error: "Invalid asset URL" }, 400);
        const target = new URL(raw);
        return proxyProvider(request, cfg, target, env, 0, isAllowedAssetTarget);
      }
      if (url.pathname === "/test") {
        const response = await apiFetch(cfg);
        if (!response.ok) return json({ worker: "online", providerReachable: true, account: { ok: false, status: response.status } });
        const data = await response.json();
        return json({ worker: "online", providerReachable: true, account: {
          ok: true, status: response.status, authenticated: data?.user_info?.auth === 1,
          statusText: data?.user_info?.status || null, expiresAt: data?.user_info?.exp_date || null
        }});
      }

      if (url.pathname === '/test-stream-pipeline') {
        const id = url.searchParams.get('id') || '1981089';
        if (!/^\d{1,20}$/.test(id)) return json({ error: 'Invalid stream id' }, 400);
        return json({ test: 'hls_pipeline', ...(await probeHlsPipeline(request, cfg, id, env)) });
      }
      if (url.pathname === "/test-playlist-stream") {
        const id = url.searchParams.get("id") || "1981089";
        if (!/^\d{1,20}$/.test(id)) return json({ error: "Invalid stream id" }, 400);
        return json({ test: "playlist_stream", id, result: await probePlaylistStream(cfg, id) });
      }
      if (url.pathname === "/test-stream") {
        const id = url.searchParams.get("id") || "1981089";
        if (!/^\d{1,20}$/.test(id)) return json({ error: "Invalid stream id" }, 400);
        const [ts, hls] = await Promise.all([
          probeStream(cfg, id, "ts"),
          probeStream(cfg, id, "m3u8")
        ]);
        return json({ test: "stream", id, results: [ts, hls] });
      }
      if (url.pathname === "/test-playlist") {
        const response = await fetch(cfg.playlistUrl, { headers: { "User-Agent": "okhttp/5.0.0-alpha.2" }, redirect: "follow", signal: AbortSignal.timeout(25000) });
        if (!response.ok) return json({ test: "playlist", ok: false, status: response.status });
        const body = await response.text();
        const names = [...body.matchAll(/#EXTINF:[^,]*,([^\r\n]+)/g)].map(match => match[1].trim());
        return json({ test: "playlist", ok: true, status: response.status, bytes: new TextEncoder().encode(body).length, entries: names.length, sample: names.slice(0, 8) });
      }
      if (url.pathname === "/test-live-channels") return json(await inspectLiveChannels(cfg, url));
      if (url.pathname === "/test-live-categories") return json(await inspectLiveCategories(cfg));
      const map = {
        "/test-live": ["get_live_streams", "live"],
        "/test-movies": ["get_vod_streams", "movies"],
        "/test-movie-categories": ["get_vod_categories", "movieCategories"],
        "/test-series": ["get_series", "series"],
        "/test-series-categories": ["get_series_categories", "seriesCategories"]
      };
      if (map[url.pathname]) return json(await inspect(cfg, ...map[url.pathname]));
      return json({ error: "Not found", tests: ["/test", "/test-playlist", ...Object.keys(map)] }, 404);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Proxy request failed" }, 502);
    }
  }
};
