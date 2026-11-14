# JokStream

A clean, premium streaming-platform foundation.

## Workspace
- `apps/web`: public React + Vite interface.
- `services/gateway`: planned server-side catalog and stream gateway.
- Existing Supabase project `jokstream-chat` remains the chat backend; its existing `public.chat_messages` table is reused unchanged.

## Local development
1. Copy `.env.example` to `.env.local` and fill in the Supabase public URL and anon key.
2. `npm install`
3. `npm run dev`

## Important deployment requirements
- Never put Xtream credentials or service-role keys in browser code or Git.
- Do not enable upstream playback until the content provider has explicitly authorized public redistribution/re-streaming.
- The gateway must proxy media server-side; the browser must never receive provider credentials or upstream URLs.
- A production stream gateway needs a persistent server/container and bandwidth capacity. Static hosting/edge functions are not a substitute for sustained video delivery.

## Current status
Initial frontend foundation only. No IPTV provider is configured, no stream is enabled, and no deployment has been performed.
