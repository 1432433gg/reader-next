# Remote WebView 访问设置

## 使用条件

需要 Linux Docker Engine、支持 `!reset` 的 Docker Compose，以及可用的公网 IPv4 连接。

此配置用于限制书源网页访问服务器和内网服务。正常公网 IPv4 书源可用；新的 IPv6、环回、内网和链路本地连接默认不允许。仅有 IPv6 的书源需要另行配置。

## 填写地址

在 `docker/.env.docker` 中设置：

```dotenv
REMOTE_WEBVIEW_URL=http://remote-webview:8050
EGRESS_DENY_CIDRS=你的服务器公网IPv4/32
EGRESS_ALLOW_TCP=
```

`EGRESS_DENY_CIDRS` 必须包含服务器全部公网 IPv4 和外部 NAT 地址，每个地址后加 `/32`，多个地址用空格分隔。还可补充需要禁止访问的 IPv4 网段。不要直接复制示例文字。

`EGRESS_ALLOW_TCP` 默认留空。确需使用内网书源时，只允许指定的 `IPv4:端口`，多个地址用空格分隔；不要放开整个内网。

## 启动和升级

在仓库根目录执行：

```bash
docker compose --env-file docker/.env.docker -f docker/compose.yml -f docker/compose.egress.yml --profile webview config
docker compose --env-file docker/.env.docker -f docker/compose.yml -f docker/compose.egress.yml --profile webview pull
docker compose --env-file docker/.env.docker -f docker/compose.yml -f docker/compose.egress.yml --profile webview up -d --force-recreate renderer-net remote-webview
docker compose --env-file docker/.env.docker -f docker/compose.yml -f docker/compose.egress.yml --profile webview up -d reader
```

渲染服务不需要对外开放 `8050` 端口。服务器地址、访问规则或镜像版本改变后，重新执行上面的命令。已有 Reader 数据卷继续保留。

## 查看状态

```bash
docker compose --env-file docker/.env.docker -f docker/compose.yml -f docker/compose.egress.yml --profile webview ps
```

如需核对实际访问规则：

```bash
docker compose --env-file docker/.env.docker -f docker/compose.yml -f docker/compose.egress.yml exec renderer-net iptables-save
docker compose --env-file docker/.env.docker -f docker/compose.yml -f docker/compose.egress.yml exec renderer-net ip6tables-save
```

## 验证

检查已构建镜像：

```bash
bash docker/tests/run-bundled-smoke.sh reader-next:local
```

需要验证动态书源从搜索到首章的完整流程时，使用对应镜像和 Reader 程序执行：

```bash
EGRESS_VERIFY_IMAGE=reader-next:local \
READER_BINARY=/实际路径/reader-next \
EGRESS_VERIFY_OUTPUT=/实际路径/验证结果 \
node docker/egress/verify.mjs
```

需要 Node.js 24、Docker CLI/Compose，以及创建测试容器和网络的权限。省略 `EGRESS_VERIFY_IMAGE` 时，脚本会从当前仓库构建验证镜像。测试结果和原始日志保存在指定目录；脚本只清理本次创建的测试资源。
