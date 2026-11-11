# syntax=docker/dockerfile:1.7

# 三段构建：前端、后端，以及包含 Reader / WebView / 出站隔离工具的合并运行镜像。
# 镜像标签由 .github/workflows/docker-publish.yml 在发版时贴：版本号和 latest。

FROM node:22-bookworm-slim AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM rust:1-bookworm AS backend-builder
WORKDIR /app
RUN apt-get -o Acquire::Retries=3 update \
    && apt-get install -y -o Acquire::Retries=3 --no-install-recommends pkg-config libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/app/target \
    cargo build --release --locked \
    && cp /app/target/release/reader-next /app/reader-next

# One published image provides reader, webview and egress entry modes.
FROM node:22-bookworm-slim AS runtime
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
RUN apt-get -o Acquire::Retries=3 update \
    && apt-get install -y -o Acquire::Retries=3 --no-install-recommends \
       ca-certificates curl libsqlite3-0 tzdata iptables iproute2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY docker/remote-webview/package*.json /app/remote-webview/
# The exact Playwright version also pins its matching playwright-core/browser.
RUN cd /app/remote-webview \
    && npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && ./node_modules/.bin/playwright install --with-deps webkit \
    && chmod -R a+rX /opt/playwright \
    && rm -rf /var/lib/apt/lists/* /root/.npm

RUN useradd --system --uid 10001 --create-home --home-dir /home/reader reader
COPY --from=backend-builder /app/reader-next /app/reader-next
COPY --from=frontend-builder /app/frontend/dist /app/web/dist
COPY docker/remote-webview/index.js /app/remote-webview/index.js
COPY docker/egress/start.sh /app/egress/start.sh
COPY --chmod=0755 docker/runtime-entrypoint.sh /usr/local/bin/reader-entrypoint
RUN mkdir -p /app/storage/assets \
    && chown -R reader:reader /app/storage

LABEL io.reader-next.bundled-webview="1" \
      io.reader-next.playwright-version="1.65.0"
ENV SERVER_HOST=0.0.0.0 \
    SERVER_PORT=18080 \
    DATABASE_URL=sqlite:/app/storage/reader.db?mode=rwc \
    STORAGE_DIR=/app/storage \
    ASSETS_DIR=/app/storage/assets \
    WEB_ROOT=/app/web/dist \
    LOG_LEVEL=info \
    REQUEST_TIMEOUT_SECS=15

EXPOSE 18080
VOLUME ["/app/storage"]
USER reader
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
    CMD curl -fsS "http://127.0.0.1:${SERVER_PORT:-18080}/" >/dev/null || exit 1
ENTRYPOINT ["/usr/local/bin/reader-entrypoint"]
CMD ["reader"]
