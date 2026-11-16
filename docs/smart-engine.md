# JokStream Smart Engine

## Purpose

The Smart Engine is an automatic policy layer. It observes aggregate delivery health and per-player playback signals, chooses only supported optimizations, and continuously verifies whether each action helped. It must fail open: if telemetry, cache, or a Cloudflare feature is unavailable, normal playback continues.

## Autonomy model

1. Observe: collect startup time, rebuffer ratio, stall count, selected rendition/bitrate, request latency, cache hit/miss, origin errors, and coarse network hints.
2. Classify: estimate playback risk and content eligibility. Do not infer a user's identity, exact location, or provider credentials.
3. Decide: select a policy using explicit thresholds, confidence, minimum sample sizes, and cooldowns.
4. Act: change only reversible settings (rendition preference, prefetch amount, cache TTL within origin directives, route preference among authorized origins, or opt-in peer contribution).
5. Verify: compare outcomes against a control cohort and roll back an action when it increases errors, stalls, latency, or cost.
6. Learn: update thresholds from aggregated, bounded metrics. Never let an unconstrained model modify security, authorization, redistribution, or cache-key rules.

## Automatic policies

| Signal | Automatic response | Guardrail |
|---|---|---|
| Slow startup or repeated stalls | Prefer a lower available rendition; increase buffer conservatively; retry with bounded backoff | Cannot create a rendition that the source does not provide |
| Stable throughput and low rebuffering | Gradually probe a higher rendition | Upgrade only with sustained headroom; downgrade quickly |
| Repeated public catalog reads | Serve fresh browser/edge cache; revalidate in background | Only explicitly public responses and exact safe routes |
| Popular, immutable assets | Long-lived browser and edge caching | Versioned URLs; never cache HTML shell as immutable |
| Origin latency/error spike | Prefer a healthy, authorized alternate route | No bypass of provider policy, auth, or SSRF protections |
| High peer density and eligible identical HLS segments | Enable capped P2P contribution | Rights/authorization, same segment bytes and sequence, opt-in and fallback required |
| Low device/network capability | Disable upload contribution and reduce prefetch | Save battery, data, and CPU |

## Browser cache v1

The service worker caches:
- Vite fingerprinted same-origin /assets/* files using cache-first.
- Selected public JSON catalog/metadata/artwork GET routes only when the response explicitly permits public caching with Cache-Control.

It does not cache:
- Playback URLs, manifests, segments, TS/MP4 media, authorization-bearing requests, admin endpoints, private/no-store responses, or cross-origin resources.
- API responses without explicit public cache directives.

The worker uses a bounded entry count for JSON cache. Browser storage remains best-effort and can be evicted by the browser.

## Cloudflare architecture (later phases)

- Workers: request policy, authorization-aware routing, safe cache key normalization, and lightweight telemetry ingestion.
- Cache/CDN or Cloudflare Stream: use only for content and delivery models permitted by the applicable Cloudflare product terms. Do not turn a generic Worker proxy into a video CDN.
- R2: store owned/licensed static assets or media where the rights and product terms permit.
- Durable Objects: coordinate per-stream peer/session state only if measurements justify it.
- Analytics Engine: aggregate high-cardinality performance signals without recording provider URLs, tokens, or personal data.

## Safety and cost controls

- Keep UPSTREAM_REDISTRIBUTION_AUTHORIZED enforcement intact.
- Never cache personalized or credential-bearing responses in a shared cache.
- Never share signed URLs, cookies, tokens, or private manifests between users.
- Never enable peer redistribution unless content rights and identical segment compatibility are verified.
- Add per-user upload caps, global circuit breakers, rate limits, and a kill switch for P2P.
- Use sampling, aggregation, retention limits, and no raw provider URLs in telemetry.
- All autonomous actions must be bounded, reversible, observable, and have a cooldown.
- Do not scale paid Cloudflare products automatically without a budget limit and explicit approval.

## Rollout gates

1. Browser cache: verify only safe public responses are cached; test logout/session boundaries and cache eviction.
2. Player telemetry: measure real startup, stalls, bitrate, and recovery on multiple networks.
3. Adaptive policy: run in shadow mode first, then a small percentage cohort, then expand only when metrics improve.
4. Edge routing/cache: test cache-key isolation, authorization, regional latency, and origin fallback.
5. P2P: verify rights, exact segment identity, peer density, upload limits, and HTTP fallback before any experiment.

No PR from this project is merged and no production deployment is triggered without explicit approval after review.