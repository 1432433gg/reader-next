# 应用图标

| 文件 | 用途 |
| --- | --- |
| `app-icon.svg` / `app-icon.png` | 当前图标（1024×1024，正方形铺满，系统自己裁圆角） |
| `app-icon-maskable.svg` | 安卓自适应图标：文字缩在中间安全区，书照样从底边露出 |

`frontend/public` 里的 favicon、apple-touch-icon、`icons/` 下的各尺寸 PNG 都是从这里的 SVG 导出的。
换图标后要同时改 `frontend/public/sw.js` 里的缓存版本号，不然已经打开过的设备会继续用旧图标；
iPhone 上已经添加到主屏幕的图标不会自动更新，要删掉重新添加。

文字「阅读」用的是[霞鹜文楷](https://github.com/lxgw/LxgwWenKai)（SIL Open Font License 1.1），
已经转成路径，不依赖字体文件。
