# JokStream Gateway

Server-side gateway foundation. Xtream credentials are read only from server environment variables and never returned to clients.

## Configure
Copy `.env.example` to your deployment's secret environment. Use a long random `ADMIN_API_TOKEN`. Never commit real values.

## Endpoints
- `GET /health`
- `GET /api/status`
- `GET /api/catalog`
- `POST /api/admin/catalog/sync` (Bearer admin token)

Catalog synchronization is blocked unless `UPSTREAM_REDISTRIBUTION_AUTHORIZED=true`. Set that only after confirming written rights to publicly redistribute/re-stream the provider's content.

The stream route intentionally returns 503 until a hardened media proxy is selected, reviewed, deployed, and tested for HLS segment forwarding, client disconnects, range requests, token expiry, IP restrictions, and bandwidth limits. Do not point browsers at Xtream URLs.
