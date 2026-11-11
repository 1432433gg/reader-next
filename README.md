# Reader

自用的阅读 3.0 服务端：Rust 后端负责书源解析、账号、缓存和定时检查新章节，Vue 前端负责书架、阅读器和本地书籍。

## 使用

### VPS 一键安装

用 [mihomo-next](https://github.com/1432433gg/mihomo-next) 的脚本，选「1. 安装（Mihomo + Reality + Caddy + Reader）」，HTTPS 证书和反向代理一起装好，之后在脚本菜单里更新 Reader。

### Docker

镜像 `ghcr.io/1432433gg/reader-next`，标签 `latest` 和版本号 `x.y.z`，amd64 和 arm64 都有。

```bash
docker run -d \
  --name reader-next \
  --restart unless-stopped \
  -p 18080:18080 \
  -v reader-storage:/app/storage \
  ghcr.io/1432433gg/reader-next:latest
```

或者在仓库目录里用 Compose：

```bash
cp docker/env.docker.example .env.docker   # 改端口、登录、用户数、邀请码等
docker compose -f docker/compose.yml up -d
```

升级：`docker compose -f docker/compose.yml pull && docker compose -f docker/compose.yml up -d`。

打开 `http://服务器地址:18080`。默认不用登录；要开登录就设 `SECURE=true`，第一个注册的账号是管理员。

数据库、上传的书和缓存都在容器的 `/app/storage`，一定要挂载 volume 或宿主机目录，不然删容器就丢数据。

## 要求

- Docker 部署：只要 Docker（Compose 可选）。
- 本地运行和开发：Rust（stable）、Node.js 20+。

## 功能

- 自定义书源：搜索、详情、目录、正文解析（CSS Selector、JSONPath、XPath、Regex、JavaScript）。
- 服务端书架：书架、分组、最近阅读、阅读进度、章节缓存，跨设备同步。
- 本地书籍：上传 TXT、EPUB、MOBI、PDF，解析章节后加入服务端书架。
- 新章节自动检查：每 24 小时检查书架上的书，有更新的在书名右边显示「新 N 章」，也可以手动检查。
- WebDAV 备份/恢复书架、书源、阅读进度；RSS；系统语音朗读；缓存管理；用户和权限管理。

## 配置

从 `.env` 或环境变量读取，完整示例见 `.env.example`；Docker 部署写在 `.env.docker` 里。

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `SERVER_HOST` | `0.0.0.0` | 监听地址 |
| `SERVER_PORT` | `18080` | 端口 |
| `DATABASE_URL` | `sqlite:storage/reader.db?mode=rwc` | SQLite 数据库 |
| `WEB_ROOT` | `frontend/dist` | 前端页面目录 |
| `SECURE` | `false` | 是否需要登录 |
| `SECURE_KEY` | 空 | 管理密钥，不要写进镜像 |
| `INVITE_CODE` | 空 | 注册邀请码 |
| `USER_LIMIT` | `50` | 最多能注册几个账号 |
| `USER_BOOK_LIMIT` | `2000` | 每个账号最多几本书 |
| `LOG_LEVEL` | `info` | 日志级别，`off` 不输出 |
| `REQUEST_TIMEOUT_SECS` | `15` | 请求书源的超时（秒） |
| `CHAPTER_UPDATE_INTERVAL_HOURS` | `24` | 新章节自动检查间隔（小时），`0` 关闭 |
| `CHAPTER_UPDATE_CONCURRENCY` | `3` | 新章节检查同时请求的书源数 |

## 目录

```
src/                  Rust 后端
  api/                HTTP 接口，/reader3/* 路由
  app/                启动、配置加载
  crawler/            HTTP 客户端
  error/              错误类型
  model/              数据模型
  parser/             书源规则解析：CSS / JSONPath / XPath / JavaScript / Regex
  service/            书源、书架、本地书籍、新章节检查等业务逻辑
  storage/            SQLite、文件缓存、上传文件
  util/               工具函数
tests/                后端集成测试，fixtures/ 是测试用的书
frontend/             Vue 3 + Vite + Pinia 前端，构建到 frontend/dist/
docs/                 VitePress 文档站：指南、API、书源开发（含解析器实现规格 spec.md）
docker/               compose.yml（部署）、compose.local.yml（本地常驻容器）、env.docker.example
design/icon/          应用图标源文件
scripts/              release.sh（发版）、run-dev.sh（本地开发）
.github/workflows/    docker-publish.yml（打标签后构建镜像）、docs.yml（手动发布文档站）
Dockerfile            镜像构建
.env.example          配置示例；.env.dev.example 给 run-dev.sh 用
CHANGELOG.md          更新记录
```

## 文件位置

容器里：

| 路径 | 内容 |
| --- | --- |
| `/app/reader-next` | 服务端程序 |
| `/app/web/dist` | 前端页面 |
| `/app/storage` | 数据，要挂载：`reader.db`（SQLite）、`assets/`（上传的书、封面）、章节缓存 |

本地运行时对应 `frontend/dist/` 和 `storage/`（不提交 Git）。用 mihomo-next 装的，数据在 Docker 卷 `reader-next_reader-data`，设置在 `/etc/mihomo-next/reader.env`。

## 开发

先构建前端，再起后端，后端同时提供页面和 `/reader3/*` 接口：

```bash
cd frontend && npm install && npm run build
cd .. && SERVER_PORT=18080 cargo run --release
```

打开 <http://localhost:18080>。只调前端可以 `cd frontend && npm run dev`（`5173`，会把 `/reader3` 代理到后端）。`scripts/run-dev.sh` 按 `.env.dev` 起一个用独立数据目录的开发实例。

```bash
cargo test                      # 后端测试
cargo build --release           # 后端发布构建
cd frontend && npm test         # 前端测试
cd frontend && npm run build    # 前端构建
```

发版：`./scripts/release.sh vx.y.z` 改版本号、打标签、推送，GitHub Actions 构建镜像并发布到 `ghcr.io`；更新内容写在 `CHANGELOG.md`。文档站在 `docs/`，发布到 GitHub Pages 要在 Actions 里手动运行「Deploy Docs to GitHub Pages」。

## 致谢

- [Maple0517/reader-next](https://github.com/Maple0517/reader-next)
- [givenge/reader-rust](https://github.com/givenge/reader-rust)
- [hectorqin/reader](https://github.com/hectorqin/reader)
