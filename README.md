# bilibili-screenshot-userscript

B 站视频截图按钮 + 通用视频截图用户脚本。

## 快速开始

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 或兼容的用户脚本管理器；
2. 打开脚本地址，选择“安装”：
   - `bilibili-screenshot-userscript.js`
   - `video-screenshot-userscript.js`
3. 打开视频页，点页面上的“截屏”，或按 `Ctrl+Shift+S`。

## 两个脚本

| 文件 | 作用 |
|---|---|
| `bilibili-screenshot-userscript.js` | B 站视频/直播页：注入截图按钮，截图带到剪贴板 |
| `video-screenshot-userscript.js` | 任意视频页：快捷键截图；命中站点规则时额外注入按钮 |

## 更新地址

脚本的 `@downloadURL` / `@updateURL` 指向仓库根目录的 `.js` 文件。**这两个文件必须
留在仓库根**，否则已安装版本检查更新会 404；这是分发契约，不是普通源码目录。

## 限制

- 依赖浏览器剪贴板权限；不同浏览器的截图 API 支持不同；
- B 站 DOM 改版可能导致按钮定位失效，需要更新选择器；
- 不做视频下载，只做当前帧截图。

## License

MIT
