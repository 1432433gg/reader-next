# Changelog

## v1.1.3 - 2026-10-29

第一个正式版本。

- 自定义书源：搜索、详情、目录、正文解析（CSS Selector、JSONPath、XPath、Regex、JavaScript）。
- 服务端书架：分组、最近阅读、阅读进度、章节缓存，跨设备同步。
- 本地书籍：上传 TXT、EPUB、MOBI、PDF。
- 新章节自动检查：每 24 小时检查书架上的书（`CHAPTER_UPDATE_INTERVAL_HOURS`），有更新的在书名右边显示「新 N 章」，也可以手动检查。
- WebDAV 备份/恢复、RSS、系统语音朗读、缓存管理、用户和权限管理。
- iOS 主屏幕应用适配：状态栏跟阅读背景同色，阅读页避开系统顶部模糊。
- 图标地址带版本号，更新图标后手机上不会一直显示旧图标。
- Docker 镜像 `ghcr.io/1432433gg/reader-next`，amd64 和 arm64，标签只有版本号和 `latest`。
