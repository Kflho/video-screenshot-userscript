// ==UserScript==
// @name         视频截图（通用版 · 快捷键 + B站按钮）
// @namespace    https://github.com/Kflho
// @version      1.0.1
// @description  任意视频网页按 Ctrl+Shift+S 截图到剪贴板；命中站点规则时额外注入按钮
// @author       Kflho
// @match        http*://*/*
// @icon         data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ctext y='14' font-size='14'%3E%F0%9F%93%B7%3C/text%3E%3C/svg%3E
// @run-at       document-idle
// @grant        none
// @license      MIT
// @downloadURL  https://raw.githubusercontent.com/Kflho/bilibili-screenshot-userscript/refs/heads/main/video-screenshot-userscript.js
// @updateURL    https://raw.githubusercontent.com/Kflho/bilibili-screenshot-userscript/refs/heads/main/video-screenshot-userscript.js
// ==/UserScript==

(function () {
    "use strict";

    const CONFIG = {
        logPrefix: "[视频截图]",
        buttonText: "截屏",
        buttonClass: "screenshotBtn08",
        buttonId: "videoScreenshotBtn",
        toastId: "videoScreenshotToast",
        buttonStyle: {
            backgroundColor: 'rgba(0,174,236, 0.5)',
            transition: 'background-color 0.3s',
            color: '#ffffff',
            fontSize: '15px',
            cursor: 'pointer',
            borderRadius: '8px',          // B站风格微小圆角
            border: '0px solid #ffffff',
            paddingLeft: '10px',
            paddingRight: '10px',
            marginBottom: '2px'
        },
        hoverStyle: {
            backgroundColor: 'rgba(0,174,236, 1)'
        },
        checkInterval: 1000,              // 命中站点规则后，等待锚点出现的轮询间隔
        maxCheckTimes: 30,                // 最多等 30 次，之后退回插到视频后面
        shortcut: {
            key: 's',
            code: 'KeyS',
            ctrl: true,
            shift: true,
            alt: false
        },
        toastDuration: 2000
    };

    // ---------- 站点规则表 ----------
    // 命中才注入按钮；未命中的站点不注入任何 UI，仅保留快捷键。
    // 想支持新站点，在这里加一行 host + 按钮要插到哪个选择器后面即可。
    const SITE_RULES = [
        { host: 'live.bilibili.com', anchor: '.follow-ctnr' },
        { host: 'www.bilibili.com', anchor: '.pubdate-ip' }
    ];

    function log(message) {
        console.log(`${CONFIG.logPrefix} ${message}`);
    }

    function getSiteRule() {
        const host = window.location.hostname;
        for (let i = 0; i < SITE_RULES.length; i++) {
            if (host === SITE_RULES[i].host) return SITE_RULES[i];
        }
        return null;
    }

    // ---------- Toast 提示（水平居中，垂直与按钮对齐，8px圆角） ----------
    function showToast(message, isSuccess, anchorElement) {
        const oldToast = document.getElementById(CONFIG.toastId);
        if (oldToast) oldToast.remove();

        if (!anchorElement) {
            anchorElement = document.getElementById(CONFIG.buttonId);
        }

        const toast = document.createElement('div');
        toast.id = CONFIG.toastId;
        toast.textContent = message;

        const bgColor = isSuccess
            ? 'rgba(0, 174, 236, 0.95)'
            : 'rgba(244, 67, 54, 0.92)';

        const baseStyle = {
            padding: '2px 10px',
            borderRadius: '8px',           // B站风格微小圆角
            fontSize: '15px',
            fontWeight: 'bold',
            color: '#ffffff',
            backgroundColor: bgColor,
            boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
            zIndex: '999999',
            opacity: '0',
            transition: 'opacity 0.25s ease-in-out',
            pointerEvents: 'none',
            fontFamily: 'sans-serif',
            whiteSpace: 'nowrap',
            position: 'fixed',
            textAlign: 'center',
            lineHeight: '1.2'
        };
        Object.assign(toast.style, baseStyle);

        // ----- 定位：有按钮就与按钮中心对齐，否则回退到屏幕底部居中 -----
        if (anchorElement) {
            const rect = anchorElement.getBoundingClientRect();
            const centerY = rect.top + rect.height / 2;
            toast.style.left = '50%';
            toast.style.top = centerY + 'px';
            toast.style.transform = 'translateX(-50%) translateY(-50%)';
            toast.style.bottom = 'auto';
            toast.style.right = 'auto';
        } else {
            toast.style.left = '50%';
            toast.style.bottom = '80px';
            toast.style.transform = 'translateX(-50%)';
            toast.style.top = 'auto';
        }
        // ----------------------------------

        document.body.appendChild(toast);

        requestAnimationFrame(() => {
            toast.style.opacity = '1';
        });

        setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => {
                if (toast.parentNode) toast.remove();
            }, 300);
        }, CONFIG.toastDuration);
    }
    // ----------------------------------

    // ---------- 视频查找 ----------
    // 递归收集 <video>，穿透 open shadow root（部分播放器用 Web Component 封装）
    function collectVideos(root, out) {
        const videos = root.querySelectorAll('video');
        for (let i = 0; i < videos.length; i++) out.push(videos[i]);

        const elements = root.querySelectorAll('*');
        for (let i = 0; i < elements.length; i++) {
            if (elements[i].shadowRoot) collectVideos(elements[i].shadowRoot, out);
        }
        return out;
    }

    function isVisible(el) {
        const rect = el.getBoundingClientRect();
        if (rect.width < 4 || rect.height < 4) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        return true;
    }

    // 页面上常有多个 <video>（广告位、悬停预览、贴片），
    // 取「可见面积最大」的那个，同面积优先正在播放的。
    function getBestVideo() {
        const videos = collectVideos(document, []);
        let best = null;
        let bestScore = -1;

        for (let i = 0; i < videos.length; i++) {
            const v = videos[i];
            if (v.videoWidth <= 0 || v.videoHeight <= 0 || v.readyState < 2) continue;
            if (!isVisible(v)) continue;

            const rect = v.getBoundingClientRect();
            let score = rect.width * rect.height;
            if (!v.paused) score *= 2;      // 正在播放的优先

            if (score > bestScore) {
                bestScore = score;
                best = v;
            }
        }

        if (!best) {
            log('未找到可截图的视频（本页共扫描到 ' + videos.length + ' 个 <video>）');
        }
        return best;
    }
    // ----------------------------------

    // ---------- 按钮注入（仅命中站点规则的站点） ----------
    function addScreenShotEle(insertAfter) {
        if (document.getElementById(CONFIG.buttonId)) return;

        const btn = document.createElement('button');
        btn.textContent = CONFIG.buttonText;
        btn.className = CONFIG.buttonClass;
        btn.id = CONFIG.buttonId;
        Object.assign(btn.style, CONFIG.buttonStyle);

        btn.addEventListener("mouseover", function () {
            btn.style.backgroundColor = CONFIG.hoverStyle.backgroundColor;
        });
        btn.addEventListener("mouseout", function () {
            btn.style.backgroundColor = CONFIG.buttonStyle.backgroundColor;
        });

        btn.addEventListener("click", function (event) {
            event.stopPropagation();
            // 每次点击都重新找一遍：SPA 换集/换 P 会换掉 video 元素
            const video = getBestVideo();
            if (video) {
                takeScreenshot(video, btn).catch(function (err) {
                    log('截图流程异常: ' + err);
                });
            } else {
                showToast('❌ 未找到有效视频', false, btn);
            }
        });

        insertAfter.insertAdjacentElement('afterend', btn);
        log("截图按钮已添加");
    }

    function startButtonWatcher() {
        const rule = getSiteRule();
        if (!rule) return;                 // 未命中规则：不注入按钮，只用快捷键

        log('命中站点规则，按钮锚点: ' + rule.anchor);

        let tries = 0;
        const interval = setInterval(tick, CONFIG.checkInterval);
        tick();                            // 多数情况下首帧就能添上，不用等 1 秒

        function tick() {
            if (document.getElementById(CONFIG.buttonId)) {
                clearInterval(interval);
                startDomWatcher(rule);
                return;
            }

            const anchor = document.querySelector(rule.anchor);
            if (anchor) {
                addScreenShotEle(anchor);
                clearInterval(interval);
                startDomWatcher(rule);
                return;
            }

            if (++tries >= CONFIG.maxCheckTimes) {
                clearInterval(interval);
                // 锚点一直没出现（站点改版？），退回插到视频元素后面
                const video = getBestVideo();
                if (video) {
                    addScreenShotEle(video);
                    log('锚点 ' + rule.anchor + ' 未出现，按钮已退回插到视频后面');
                    startDomWatcher(rule);
                } else {
                    log('锚点 ' + rule.anchor + ' 与视频均未出现，按钮未添加（快捷键仍可用）');
                }
            }
        }
    }

    // SPA 换集/换 P 会重渲染 DOM 把按钮一起冲掉，这里补回来
    function startDomWatcher(rule) {
        if (!document.body) return;

        let timer = null;
        const observer = new MutationObserver(function () {
            if (document.getElementById(CONFIG.buttonId)) return;   // 按钮还在，忽略绝大多数变更
            if (timer) return;
            timer = setTimeout(function () {
                timer = null;
                const anchor = document.querySelector(rule.anchor);
                if (anchor) {
                    addScreenShotEle(anchor);
                    log('按钮已被页面重渲染移除，已重新添加');
                }
            }, 300);
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }
    // ----------------------------------

    // ---------- 截图 ----------
    function describeClipboardError(err) {
        const name = (err && err.name) || '';
        const message = (err && err.message) || String(err);

        if (name === 'SecurityError') return '该站点视频受跨域限制';
        if (name === 'NotAllowedError') return '剪贴板被禁用或页面未聚焦';
        if (name === 'DataError' || message.indexOf('ClipboardItemData') !== -1) return '复制失败，请刷新页面';
        if (message.indexOf('toBlob 返回 null') !== -1) return '截图生成失败';
        return '复制失败';
    }

    async function takeScreenshot(videoElement, anchorElement) {
        log('--- 开始截图 ---');
        log('视频尺寸: ' + videoElement.videoWidth + 'x' + videoElement.videoHeight);
        log('视频状态: readyState=' + videoElement.readyState + ', paused=' + videoElement.paused);
        log('文档焦点: hasFocus=' + document.hasFocus() + ', visibilityState=' + document.visibilityState);
        log('剪贴板权限: ' + (navigator.clipboard ? 'available' : 'unavailable'));

        if (videoElement.videoWidth === 0 || videoElement.videoHeight === 0) {
            log('错误: 视频尺寸为0，可能视频未加载完成');
            showToast('❌ 视频未加载完成', false, anchorElement);
            return;
        }

        // EME/DRM 加密流的画面受保护，截出来是黑帧，提前说明原因
        if (videoElement.mediaKeys) {
            log('错误: 该视频使用 EME/DRM 加密，画面受保护');
            showToast('❌ 该视频已加密，无法截图', false, anchorElement);
            return;
        }

        var myCanvas = document.createElement('canvas');
        myCanvas.width = videoElement.videoWidth;
        myCanvas.height = videoElement.videoHeight;
        var ctx = myCanvas.getContext('2d');
        if (!ctx) {
            log('错误: 无法获取Canvas 2D上下文');
            showToast('❌ Canvas初始化失败', false, anchorElement);
            return;
        }

        try {
            ctx.drawImage(videoElement, 0, 0, videoElement.videoWidth, videoElement.videoHeight);
        } catch (err) {
            log('错误: drawImage 失败 - ' + err.name + ': ' + err.message);
            showToast('❌ 该视频无法截图', false, anchorElement);
            return;
        }
        log('Canvas绘制完成: ' + myCanvas.width + 'x' + myCanvas.height);

        // 同步检查画布是否被跨域污染：<video> 的帧源跨域且没带 CORS 头时，
        // getImageData 会立刻抛 SecurityError。在这里先拦一道，
        // 既能给出准确原因，也不用白白消耗用户手势。
        try {
            ctx.getImageData(0, 0, 1, 1);
        } catch (err) {
            log('错误: Canvas 被跨域污染，无法导出图片 - ' + err.name + ': ' + err.message);
            log('  说明: 该 <video> 的帧源跨域且未提供 CORS 头，浏览器不允许读取像素');
            showToast('❌ 该站点视频受跨域限制', false, anchorElement);
            return;
        }

        if (!document.hasFocus()) {
            window.focus();
            log('页面失去焦点，尝试恢复焦点，结果: hasFocus=' + document.hasFocus());
        }

        if (!navigator.clipboard || typeof ClipboardItem === 'undefined') {
            log('错误: 剪贴板 API 不可用（需要 https 页面且浏览器支持）');
            showToast('❌ 剪贴板API不可用', false, anchorElement);
            return;
        }

        // 把 toBlob 的 Promise 直接交给 ClipboardItem：这样 clipboard.write()
        // 仍在按键/点击的用户手势内同步发起，toBlob 完成后再自动兑现，
        // 避免「异步转换完成时手势已过期」导致的复制失败。
        const blobPromise = new Promise(function (resolve, reject) {
            try {
                myCanvas.toBlob(function (blob) {
                    if (blob) resolve(blob);
                    else reject(new Error('toBlob 返回 null，Canvas 内容可能为空'));
                }, 'image/png');
            } catch (err) {
                reject(err);
            }
        });

        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                await navigator.clipboard.write([
                    new ClipboardItem({ 'image/png': blobPromise })
                ]);
                log('截图已复制到剪贴板');
                showToast('✅ 已复制', true, anchorElement);
                return;
            } catch (err) {
                const name = (err && err.name) || '';
                const message = (err && err.message) || '';
                log('截图复制失败（第 ' + attempt + ' 次尝试）:');
                log('  错误类型: ' + name);
                log('  错误信息: ' + message);
                log('  错误堆栈: ' + ((err && err.stack) || '无'));
                log('  文档状态: hasFocus=' + document.hasFocus() + ', visibility=' + document.visibilityState);

                // 只有「页面未聚焦」是可恢复的，抢回焦点再试一次；其余原因重试也没用
                if (attempt === 1 && name === 'NotAllowedError' && message.indexOf('not focused') !== -1) {
                    log('  页面未聚焦，恢复焦点后重试');
                    window.focus();
                    continue;
                }

                showToast('❌ ' + describeClipboardError(err), false, anchorElement);
                return;
            }
        }
    }
    // ----------------------------------

    // ----- 快捷键处理 -----
    function handleKeyDown(event) {
        const target = event.target;
        const tag = target && target.tagName ? target.tagName.toLowerCase() : '';
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || (target && target.isContentEditable)) {
            return;
        }

        const sc = CONFIG.shortcut;
        const matchCtrl = sc.ctrl ? event.ctrlKey : !event.ctrlKey;
        const matchShift = sc.shift ? event.shiftKey : !event.shiftKey;
        const matchAlt = sc.alt ? event.altKey : !event.altKey;
        // 用 code 判断，非 QWERTY 布局下也能触发；key 作为兜底
        const matchKey = event.code === sc.code ||
            (event.key && event.key.toLowerCase() === sc.key.toLowerCase());

        if (matchCtrl && matchShift && matchAlt && matchKey) {
            event.preventDefault();
            log('快捷键触发截图');
            const video = getBestVideo();
            if (video) {
                takeScreenshot(video, null).catch(function (err) {
                    log('截图流程异常: ' + err);
                });
            } else {
                log('未找到有效的视频，无法截图');
                showToast('❌ 未找到有效视频', false);
            }
        }
    }

    function shortcutText() {
        const sc = CONFIG.shortcut;
        return `${sc.ctrl ? 'Ctrl+' : ''}${sc.shift ? 'Shift+' : ''}${sc.alt ? 'Alt+' : ''}${sc.key.toUpperCase()}`;
    }

    function init() {
        log('脚本初始化：' + window.location.hostname);
        document.addEventListener('keydown', handleKeyDown);
        log(`快捷键已启用：${shortcutText()}（输入框内不触发）`);

        startButtonWatcher();
        if (!getSiteRule()) {
            log('未命中站点规则，本站点仅支持快捷键截图');
        }
    }

    init();
})();
