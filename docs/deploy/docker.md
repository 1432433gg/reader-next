# Docker 部署与发版

## 文件

| 文件 | 用途 |
| --- | --- |
| `docker/compose.yml` | Docker 部署 |
| `docker/compose.egress.yml` | Remote WebView 访问限制 |
| `docker/compose.local.yml` | 使用本地数据目录运行 |
| `docker/env.docker.example` | 环境配置示例 |

## 镜像

镜像地址为 `ghcr.io/1432433gg/reader-next`，支持 `linux/amd64` 和 `linux/arm64`。

- `latest`：正式最新版。
- `x.y.z`：指定正式版本，不带开头的 `v`。
- 测试版本使用对应的完整版本号，例如 `1.1.7-beta.2`，不会替换 `latest`。

## 安装

使用对应版本的仓库配置文件，在仓库根目录执行：

```bash
cp docker/env.docker.example docker/.env.docker
```

编辑 `docker/.env.docker`，填写端口、账号和邀请码等设置。需要固定版本时，修改 `READER_IMAGE`。启动：

```bash
docker compose --env-file docker/.env.docker -f docker/compose.yml pull
docker compose --env-file docker/.env.docker -f docker/compose.yml up -d
```

打开 `http://服务器地址:18080`；修改过 `READER_PORT` 时使用对应端口。默认不要求登录，需要登录时设置 `SECURE=true`。

数据保存在 `/app/storage`，包括数据库、上传文件和缓存。升级或重建容器时保留现有数据卷。

## 升级

确认 `docker/.env.docker` 中的镜像版本后执行：

```bash
docker compose --env-file docker/.env.docker -f docker/compose.yml pull
docker compose --env-file docker/.env.docker -f docker/compose.yml up -d
```

不要使用 `down -v` 删除数据卷。密钥和邀请码保存在环境配置文件中，不提交到仓库。

## Remote WebView

需要网页渲染的文字书源可启用 Remote WebView。使用包含该功能的已发布 Reader 镜像，在 `docker/.env.docker` 中填写：

```dotenv
REMOTE_WEBVIEW_URL=http://remote-webview:8050
EGRESS_DENY_CIDRS=你的服务器公网IPv4/32
EGRESS_ALLOW_TCP=
```

将示例中的文字替换为真实地址。服务器有多个公网或 NAT 地址时，应全部填写，每个地址后加 `/32`，用空格分隔。`EGRESS_ALLOW_TCP` 默认留空；确需访问内网书源时，只填写对应的 `IPv4:端口`。

此配置需要 Linux Docker Engine、支持 `!reset` 的 Compose 和可用的公网 IPv4 连接。拉取并启动：

```bash
docker compose --env-file docker/.env.docker -f docker/compose.yml -f docker/compose.egress.yml --profile webview config
docker compose --env-file docker/.env.docker -f docker/compose.yml -f docker/compose.egress.yml --profile webview pull
docker compose --env-file docker/.env.docker -f docker/compose.yml -f docker/compose.egress.yml --profile webview up -d --force-recreate renderer-net remote-webview
docker compose --env-file docker/.env.docker -f docker/compose.yml -f docker/compose.egress.yml --profile webview up -d reader
```

启用后照常导入书源、搜索和阅读，无需在服务器上手动构建镜像。查看运行状态：

```bash
docker compose --env-file docker/.env.docker -f docker/compose.yml -f docker/compose.egress.yml --profile webview ps
```

服务器公网地址变更时，更新 `EGRESS_DENY_CIDRS`，再运行上面的启动命令。更多访问设置见 [Remote WebView 访问设置](../../docker/egress/README.md)。

## 使用本地数据目录

需要直接使用仓库内的 `storage/` 时运行：

```bash
docker compose -f docker/compose.local.yml up -d
```

默认端口为 `28080`，数据位于仓库的 `storage/`。日常使用和开发应分别使用独立的数据目录，避免开发操作改动正在使用的数据。

## 发版

完成验证后，正式版本使用原来的发版命令：

```bash
./scripts/release.sh vx.y.z
```

镜像构建成功后，可按版本号更新。GitHub 发布标题只写版本号，正文写新功能、修复和使用说明，不重复版本标题。

## 手工构建检查

```bash
docker build -t reader-next:local .
bash docker/tests/run-bundled-smoke.sh reader-next:local
```

镜像检查需要 Docker 和创建测试容器、网络及数据卷的权限。测试使用独立资源，检查结果保存在 `bundle-check-logs/`。
