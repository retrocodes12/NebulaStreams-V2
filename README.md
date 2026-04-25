<div align="center">

<img src="./assets/nebulastreams-logo.jpeg" alt="NebulaStreams V2 logo" width="220" />

# NebulaStreams V2

Self-host optimized multi-provider HTTP stream addon for Stremio.

</div>

## What Is Different In V2

- self-host defaults instead of public-host protection defaults
- request rate limiters disabled by default
- bot protection disabled by default
- memory guard disabled by default
- provider cooldowns disabled by default
- higher HTTP socket, provider concurrency, and result-cache ceilings
- provider execution tuned for broader coverage instead of aggressive early exit
- background refresh and popular prewarm disabled by default so live requests get the budget

This repo is intended for operators who want to run the addon on their own machine or VPS and tune the box for throughput.

## Default Runtime Model

V2 still keeps bounded concurrency for provider execution and host fan-out. That is intentional. Removing every internal bound would make the process easier to crash under real traffic. The public-facing throttles are disabled by default, but the internal scheduler still uses wider caps so the process can stay responsive under load.

## Local Start

```bash
npm ci
npm start
```

Default local endpoints:

- `http://127.0.0.1:3000/manifest.json`
- `http://127.0.0.1:3000/configure`
- `http://127.0.0.1:3000/health`

## Important Environment Overrides

These are the main knobs for a self-hosted deployment:

```env
PUBLIC_BASE_URL=https://your-domain.example
TMDB_API_KEY=...
REDIS_URL=redis://127.0.0.1:6379
PROVIDER_GLOBAL_MAX_INFLIGHT=48
PROVIDER_HOST_MAX_INFLIGHT=6
PROVIDER_MAX_CONCURRENCY=12
STREMIO_FAST_PROVIDER_CONCURRENCY=10
STREMIO_FAST_PROVIDER_LIMIT=12
STREMIO_FAST_STREAM_LIMIT=120
MAX_ACTIVE_STREAMS=0
STREMIO_MAX_INFLIGHT_SEARCHES=0
PUBLIC_RATE_LIMIT_MAX_REQUESTS=0
STREAM_RATE_LIMIT_MAX_REQUESTS=0
PROVIDER_RATE_LIMIT_MAX_REQUESTS=0
BOT_PROTECTION_ENABLED=false
MEMORY_GUARD_ENABLED=false
```

`0` means disabled for:

- `MAX_ACTIVE_STREAMS`
- `STREMIO_MAX_INFLIGHT_SEARCHES`
- `PUBLIC_RATE_LIMIT_MAX_REQUESTS`
- `STREAM_RATE_LIMIT_MAX_REQUESTS`
- `PROVIDER_RATE_LIMIT_MAX_REQUESTS`
- provider cooldown thresholds / cooldown durations

## Deployment Notes

- Use a VPS or dedicated machine if you want the wider V2 defaults to matter.
- Put a reverse proxy in front of it for TLS and connection reuse.
- Redis is optional but recommended if you want stronger cache persistence across restarts.
- If you run this behind a CDN or WAF, keep those protections outside the addon. V2 does not enable its own request throttles by default.

## Render

`render.yaml` is included, but V2 is not designed around free/shared Render limits. It exists only as a convenience template. For full performance, self-host it.
