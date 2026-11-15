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
function providerStreamUrl(cfg, pathname) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length !== 3 || parts[0] !== "stream" || !["live", "movie", "series"].includes(parts[1])) throw new Error("Invalid stream path");
  if (!/^\d{1,20}\.[a-z0-9]{2,6}$/i.test(parts[2])) throw new Error("Invalid stream identifier");
  return new URL("/" + parts[1] + "/" + encodeURIComponent(cfg.username) + "/" +
    encodeURIComponent(cfg.password) + "/" + parts[2], cfg.origin);
}
async function proxyProvider(request, cfg, target, env) {
  if (target.origin !== cfg.origin || !["http:", "https:"].includes(target.protocol)) return json({ error: "Provider target rejected" }, 403);
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
    const redirected = new URL(location, target);
    if (redirected.origin !== cfg.origin) return json({ error: "Cross-origin provider redirect rejected" }, 502);
    return proxyProvider(request, cfg, redirected, env);
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
    const workerOrigin = new URL(request.url).origin;
    const assetUrl = raw => {
      const resolved = new URL(raw, target);
      if (resolved.origin !== cfg.origin) throw new Error("Cross-origin HLS resource rejected");
      const out = new URL("/asset", workerOrigin);
      out.searchParams.set("url", resolved.toString());
      out.searchParams.set("token", env.JOKSTREAM_PROXY_TOKEN);
      return out.toString();
    };
    const rewritten = body.split(/\r?\n/).map(line => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith("#")) {
        return line.replace(/URI="([^"]+)"/g, (_m, uri) => 'URI="' + assetUrl(uri) + '"');
      }
      return assetUrl(trimmed);
    }).join("\n");
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
  const target = new URL("/live/" + encodeURIComponent(cfg.username) + "/" +
    encodeURIComponent(cfg.password) + "/" + id + "." + ext, cfg.origin);
  const headers = {
    "User-Agent": "okhttp/5.0.0-alpha.2",
    "Accept": "*/*",
    "Accept-Encoding": "identity",
    "Referer": cfg.origin + "/",
    "Origin": cfg.origin
  };
  let response;
  try {
    response = await fetch(target, { headers, redirect: "manual", signal: AbortSignal.timeout(25000) });
  } catch (error) {
    return { format: ext, ok: false, error: error instanceof Error ? error.message : "Fetch failed" };
  }
  const result = {
    format: ext,
    status: response.status,
    ok: response.ok,
    contentType: response.headers.get("Content-Type"),
    contentLength: response.headers.get("Content-Length"),
    acceptRanges: response.headers.get("Accept-Ranges")
  };
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("Location");
    if (location) {
      const next = new URL(location, target);
      result.redirectHost = next.hostname;
      result.redirectPath = next.pathname;
      result.redirectCrossOrigin = next.origin !== cfg.origin;
    }
    return result;
  }
  if (response.ok && ext === "m3u8") {
    const body = await response.text();
    const hosts = new Set();
    for (const line of body.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const uris = trimmed.startsWith("#")
        ? [...trimmed.matchAll(/URI="([^"]+)"/g)].map(match => match[1])
        : [trimmed];
      for (const uri of uris) {
        try { hosts.add(new URL(uri, target).hostname); } catch {}
      }
    }
    result.manifestBytes = new TextEncoder().encode(body).length;
    result.resourceHosts = [...hosts].slice(0, 12);
    result.hasCrossOriginResources = [...hosts].some(host => host !== new URL(cfg.origin).hostname);
  }
  return result;
}

async function inspect(cfg, action, label) {
  const r = await apiFetch(cfg, { action });
  if (!r.ok) return { test: label, ok: false, status: r.status };
  const data = await r.json();
  return { test: label, ok: true, status: r.status,
    count: Array.isArray(data) ? data.length : null,
    sample: Array.isArray(data) ? data.slice(0, 8).map(x => x.name || x.title || x.category_name || "بدون اسم") : null };
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
        return proxyProvider(request, cfg, providerStreamUrl(cfg, url.pathname), env);
      }
      if (url.pathname === "/asset") {
        if (!authorized(request, env, url, true)) return json({ error: "Unauthorized" }, 401);
        const raw = url.searchParams.get("url");
        if (!raw || raw.length > 4096) return json({ error: "Invalid asset URL" }, 400);
        const target = new URL(raw);
        return proxyProvider(request, cfg, target, env);
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

      if (url.pathname === "/test-stream") {
        const id = url.searchParams.get("id") || "1981089";
        if (!/^\\d{1,20}$/.test(id)) return json({ error: "Invalid stream id" }, 400);
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
      const map = {
        "/test-live": ["get_live_streams", "live"],
        "/test-live-categories": ["get_live_categories", "liveCategories"],
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