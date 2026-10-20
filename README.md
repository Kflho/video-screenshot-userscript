# video-screenshot-userscript

视频截图到剪贴板：按 `Ctrl+Shift+S`，或点画面角落的「截屏」按钮，把当前视频画面复制到剪贴板，
直接粘进聊天框或文档。

## 快速开始

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 或兼容的用户脚本管理器；
2. 打开 `video-screenshot-userscript.js` 的 raw 地址，选择「安装」；
3. 打开视频页，按 `Ctrl+Shift+S`，或点画面角落的「截屏」按钮。

## 能力

- 通用：任意带 `<video>` 的页面都能截当前帧，不依赖逐站适配；
- 跨域 iframe：播放器嵌在 iframe 里也能截——有画面的层抓帧，有剪贴板权限的层负责写入；
- 站点规则：命中 `SITE_RULES` 的站点（B 站视频/直播页等）把按钮插到页面固定位置；
- 全屏：按钮跟随视频，全屏下也可见。

## 更新地址

脚本的 `@downloadURL` / `@updateURL` 指向仓库根目录的 `video-screenshot-userscript.js`。
**这个文件必须留在仓库根**，否则已安装版本检查更新会 404；这是分发契约，不是普通源码目录。

## 限制

- 依赖浏览器剪贴板权限；部分浏览器在 iframe 内不授予，脚本改由顶层文档写入；
- 不做视频下载，只截当前帧；
- B 站等站点 DOM 改版可能导致按钮定位失效，需要更新 `SITE_RULES` 里的选择器。

## License

MIT
