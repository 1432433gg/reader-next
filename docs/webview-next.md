# 可选 WebView 渲染服务

部分动态书源通过 URL 选项 `webView: true` 请求 Chromium 渲染。配置 `REMOTE_WEBVIEW_URL` 后，Reader 将这些请求交给独立 WebView Next 服务，普通书源请求沿用内置 HTTP 客户端。使用 URL 选项 `webJs` 可在浏览器执行页内脚本，`webViewDelayTime` 使用毫秒。已有 `ruleContent.webJs` 保留 Reader 的正文规则语义。

## Docker Compose

先把 [WebView Next](https://github.com/1432433gg/webview-next) 候选或已审查的版本构建为本地镜像，或设置 `WEBVIEW_IMAGE` 指向已发布的固定版本及摘要。

```sh
docker build -t webview-next:local /path/to/webview-next
docker compose -f docker/compose.yml -f docker/compose.webview.yml config
docker compose -f docker/compose.yml -f docker/compose.webview.yml up -d
```

叠加配置通过 Compose 网络访问 `http://webview:8050`。渲染服务不映射宿主机端口。已有 Reader 数据卷与 `docker/.env.docker` 继续使用。停用时用同一项目名仅启用基础文件，`docker compose -f docker/compose.yml up -d --remove-orphans`。此前自行配置的 `REMOTE_WEBVIEW_URL` 也需要清空。

在已有可信网络内部运行服务。Renderer 处理书源指定的目标 URL、请求头和页内脚本。Compose 的 Chromium 沙盒配置沿用 Playwright v1.65.1 的 [seccomp 配置](https://github.com/microsoft/playwright/blob/v1.65.1/utils/docker/seccomp_profile.json)，见 [第三方许可](webview-playwright-license.txt)。

## 地址与缓存

Reader 保持书架 URL、进度和缓存键的现有形式，按账号和书源保存动态书源链接的渲染参数。启用服务后可刷新已有书源的搜索结果与目录，以重新取得旧缓存当时未保存的渲染选项。搜索结果的 `bookRequestId` 和详情返回的 `tocRequestId` 可随对应请求传递，同一公开 URL 的不同请求可各自使用原来的书源规则并读取各自目录缓存。目录条目的 `chapterRequestId` 随正文和批量缓存请求使用，渲染正文与同 URL 的普通正文分别缓存。普通请求继续读取原缓存键。

配置了服务但渲染失败时，Reader 返回上游错误。可修复服务或书源后重试。新版渲染器传回最终 URL 和站点状态，支持相对链接及重定向。无这些响应头的旧服务使用请求 URL 作为相对链接的基准，无法提供实际重定向目标和站点状态。
