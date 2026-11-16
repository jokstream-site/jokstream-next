# JokStream Smart Engine
- Player adapts HLS rendition caps using browser network hints, buffer-ahead, dropped frames, and device capability hints. Downgrade quickly on stress; restore only after sustained stability.
- HLS ABR can only select renditions actually present in the manifest. MPEG-TS and single-rendition streams cannot gain true ABR without source-side transcoding.
- Browser cache: versioned same-origin assets cache-first; selected public JSON only with explicit public Cache-Control. Never cache playback URLs, manifests, media segments, authorization-bearing/private responses, or cross-origin resources.
- Saved Moments v1 stores playback-position bookmarks locally, never stream URLs, signed tokens, provider credentials, or media bytes. Live bookmarks require a seekable DVR window. This is not video clip recording; clip export requires authorized media and compatible segment/DVR support.
- Cloudflare Workers are for authorization-aware routing and telemetry; use approved Cache/CDN, R2, or Stream delivery for eligible content. Do not turn a generic Worker proxy into a video CDN.
- P2P remains disabled until rights, identical segment sequence/bytes, private signaling, upload caps, opt-in, and HTTP fallback are verified.
- No automatic paid resource scaling. All actions bounded, reversible, and observable.