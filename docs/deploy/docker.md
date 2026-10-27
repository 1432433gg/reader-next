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

Deploying behind a reverse proxy on a VPS (Caddy, Reality, etc.) is handled by [mihomo-next](https://github.com/1432433gg/mihomo-next), not by files in this repository.

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
cp docker/env.docker.example .env.docker
docker compose -f docker/compose.yml up -d
```

Upgrade:

```bash
docker compose -f docker/compose.yml pull
docker compose -f docker/compose.yml up -d
```

Runtime contract:

- Container port: `18080`.
- Persistent data: `/app/storage`.
- Static frontend: `/app/web/dist`.
- Default database URL: `sqlite:/app/storage/reader.db?mode=rwc`.
- Secrets stay in `.env.docker`; never bake `SECURE_KEY` or `INVITE_CODE` into the image.

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
