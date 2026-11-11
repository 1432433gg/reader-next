# Docker Deployment and Release

This document is the single Docker runbook for Reader Next.

## File layout

```text
Dockerfile                         # canonical image build entrypoint
docker/
  compose.yml                      # simple user deployment
  compose.local.yml                # local always-on container bound to repo storage/
  env.docker.example               # docker/compose.yml environment template
.github/workflows/docker-publish.yml # multi-arch GHCR publishing
```

## Published image

Default image repo: `ghcr.io/1432433gg/reader-next`.

Tags:

- `latest`: newest release.
- `x.y.z`: exact release (the git tag without the leading `v`).

Architectures:

- `linux/amd64`
- `linux/arm64`

## User deployment

Run from the repository root:

```bash
cp docker/env.docker.example docker/.env.docker
docker compose --env-file docker/.env.docker -f docker/compose.yml up -d
```

Upgrade:

```bash
docker compose --env-file docker/.env.docker -f docker/compose.yml pull
docker compose --env-file docker/.env.docker -f docker/compose.yml up -d
```

Runtime contract:

- Container port: `18080`.
- Persistent data: `/app/storage`.
- Static frontend: `/app/web/dist`.
- Default database URL: `sqlite:/app/storage/reader.db?mode=rwc`.
- Secrets stay in `docker/.env.docker`; never bake `SECURE_KEY` or `INVITE_CODE` into the image.

## Prerelease

See [v1.1.7-beta.2](../releases/v1.1.7-beta.2.md) for the testing image and Chinese Remote WebView setup instructions.

## Optional Remote WebView

Most sources use the regular HTTP client. Sources whose parsed request rule sets `webView` use the renderer configured by `REMOTE_WEBVIEW_URL`; if no renderer is configured, those requests return a clear error and do not fall back to HTTP.

To run the optional renderer in the same Compose network, set this in `docker/.env.docker`:

```dotenv
REMOTE_WEBVIEW_URL=http://remote-webview:8050
```

Use a published Reader image that supports Remote WebView. The renderer is included in that image, so deployment only needs a pull and start.

The isolated profile requires Linux Docker Engine and Compose supporting the `!reset` tag. Set every public/NAT IPv4 address of your server in `docker/.env.docker`, with `/32` after each address and spaces between them:

```dotenv
EGRESS_DENY_CIDRS=your_server_public_IPv4/32
EGRESS_ALLOW_TCP=
```

Replace the example with actual addresses. Leave `EGRESS_ALLOW_TCP` empty unless an internal source specifically requires an `IPv4:port` exception. This preset requires public IPv4 connectivity.

Start or upgrade from the repository root:

```bash
docker compose --env-file docker/.env.docker -f docker/compose.yml -f docker/compose.egress.yml --profile webview config
docker compose --env-file docker/.env.docker -f docker/compose.yml -f docker/compose.egress.yml --profile webview pull
docker compose --env-file docker/.env.docker -f docker/compose.yml -f docker/compose.egress.yml --profile webview up -d --force-recreate renderer-net remote-webview
docker compose --env-file docker/.env.docker -f docker/compose.yml -f docker/compose.egress.yml --profile webview up -d reader
```

Then import your source and search/read normally. Check service status with:

```bash
docker compose --env-file docker/.env.docker -f docker/compose.yml -f docker/compose.egress.yml --profile webview ps
```

After a server address change, update `EGRESS_DENY_CIDRS` and run the start commands again. Keep the existing storage volume when upgrading.

## Local dual-db workflow

If you want an always-on local container for day-to-day reading while keeping development writes isolated, run:

```bash
docker compose -f docker/compose.local.yml up -d
```

Contract:

- Host port defaults to `28080`.
- Repo `storage/` is bind-mounted into `/app/storage`.
- The container uses the repo's current `storage/reader.db`.
- Local development should use a separate db such as `dev-storage/reader.db`.

Recommended dev startup:

```bash
cp .env.dev.example .env.dev
./scripts/run-dev.sh
```

## Release flow

1. Verify changes locally.
2. Bump versions and create a tag through the release helper:

```bash
./scripts/release.sh vx.y.z
```

3. Pushing the `vx.y.z` tag triggers `.github/workflows/docker-publish.yml`.
4. The workflow builds `amd64` and `arm64` natively, then creates a multi-arch manifest.

Verify a published image:

```bash
docker buildx imagetools inspect ghcr.io/1432433gg/reader-next:x.y.z
```

## Manual image test

```bash
docker build -t reader-next:local .
docker run --rm -p 18080:18080 -v reader-storage-test:/app/storage reader-next:local
```

Open `http://localhost:18080`.
