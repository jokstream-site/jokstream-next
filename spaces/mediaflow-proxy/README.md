---
title: JokStream MediaFlow Proxy
emoji: 📺
colorFrom: yellow
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
---

# JokStream — MediaFlow Proxy

This Space runs the upstream open-source MediaFlow Proxy in Docker.

## Space secret

In **Settings → Variables and secrets → New secret**, add:

- `API_PASSWORD`: create a long, random password. Never commit it to GitHub.

The container listens on port 7860 (the Space's exposed port). The upstream MediaFlow service listens internally on the same port.

## Important

This Space is only the media-proxy component. It is not the JokStream website or the JokStream catalog/admin gateway. Do not paste provider credentials into a public frontend or a public GitHub file. Provider credentials must be held by the private server-side gateway before enabling public playback.

Free Spaces can sleep after inactivity and have resource/network limits. Treat this as a development and compatibility test, not a guarantee of uninterrupted commercial streaming.

Upstream project and documentation:
- https://github.com/mhdzumair/mediaflow-proxy
- https://mhdzumair.github.io/mediaflow-proxy/
