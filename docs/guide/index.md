# 简介

这是一个自用的阅读 3.0 Rust 服务端，前端使用 Vue 3。它把书源阅读、服务端书架、本地书籍和跨设备进度放在同一个应用里，并且会定时检查书架上的书有没有新章节。

## 当前重点

- **阅读体验**：阅读页、目录、设置、系统语音朗读、章节缓存和进度恢复。
- **服务端书架**：远程书源书籍和本地书籍使用统一书架。
- **新章节自动检查**：默认每 24 小时刷新一次书架上网络书的目录，标记有更新的书。
- **单端口部署**：默认 `18080`，Rust 服务端直接提供前端静态文件和 API。

## 架构概览

```text
Vue 3 前端
  -> /reader3 API
  -> axum handler
  -> service（含后台定时的新章节检查）
  -> crawler / parser / storage
  -> SQLite + 文件缓存
```

## 主要目录

- `src/api/`：HTTP handlers 和路由。
- `src/service/`：书源、书架、本地书籍、新章节检查等业务逻辑。
- `src/parser/`：规则解析引擎。
- `src/crawler/`：HTTP 抓取。
- `src/storage/`：SQLite 和文件缓存。
- `frontend/`：Vue 3 + Vite 前端。
- `docs/`：VitePress 文档站。

## 下一步

- [快速开始](./quickstart)
- [新章节自动检查](./chapter-update)
- [功能特性](./features)
- [API 文档](../api/)
