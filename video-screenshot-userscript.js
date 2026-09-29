// ==UserScript==
// @name         视频截图（通用版 · 悬浮按钮 + 跨域 iframe 中继）
// @namespace    https://github.com/Kflho
// @version      1.2.1
// @description  任意视频网页按 Ctrl+Shift+S 截图到剪贴板；视频画面角落自动出现「截屏」按钮，不用为每个站点写规则；视频藏在跨域 iframe 里也能截
// @author       Kflho
// @match        http*://*/*
// @icon         data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ctext y='14' font-size='14'%3E%F0%9F%93%B7%3C/text%3E%3C/svg%3E
// @run-at       document-idle
// @grant        none
// @license      MIT
// @downloadURL  https://raw.githubusercontent.com/Kflho/video-screenshot-userscript/refs/heads/main/video-screenshot-userscript.js
// @updateURL    https://raw.githubusercontent.com/Kflho/video-screenshot-userscript/refs/heads/main/video-screenshot-userscript.js
// ==/UserScript==

// ============================================================================
// 设计说明（跨域 iframe 中继）
// ----------------------------------------------------------------------------
// 很多站点（MacCMS 系、各类解析站）不把 <video> 放在主文档里，而是塞进一个
// 跨域 iframe：主文档按快捷键只能扫到 0 个 <video>，于是「未找到有效视频」。
// 更麻烦的是那个 iframe 通常没有 allow="clipboard-write"，Permissions Policy
// 默认只给同源框架，子框架里 navigator.clipboard.write() 必然被拒。
//
// 所以：谁有视频谁抓帧（canvas 在它自己的文档里是干净的），
//      谁有剪贴板权限谁写入（一般是顶层文档），两者用 postMessage 传 PNG Blob：
//
//   顶层按快捷键 ──capture-request──▶ 各层子框架（逐层转发，穿透嵌套 iframe）
//                ◀──capture-result───  有视频的那层回一个 Blob
//                └─ 顶层自己写剪贴板 + 提示
//
//   子框架按快捷键（焦点在播放器里/全屏时）─ 自己抓帧 ─▶ 写剪贴板被策略拒绝
//                └──write-request(Blob)──▶ 顶层写入 ──write-result──▶ 子框架提示
//
// 关于「按钮」：
//   站点千千万，为每个站点写「按钮插到哪个选择器后面」是写不完的，而且播放器一改版就失效。
//   所以默认走通用方案——在视频画面角落浮一个按钮：
//     · 谁持有 <video> 就在谁的文档里画（所以视频在跨域 iframe 里也照样显示在画面上）
//     · position:fixed + getBoundingClientRect 跟随视频，改版/换播放器都不受影响
//     · 全屏时挂进全屏元素，照样看得见
//   想在某站用「正统」位置（像 B 站那样插在标题旁边），再往 SITE_RULES 里加一行即可，
//   命中站点规则的站点会自动改用内联按钮、不再显示悬浮按钮。
// ============================================================================

(function () {
    "use strict";

    const CONFIG = {
        logPrefix: "[视频截图]",
        debug: true,
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
        // 通用悬浮按钮：不依赖任何站点选择器
        autoButton: {
            enabled: true,
            corner: 'top-right',          // top-right | top-left | bottom-right | bottom-left
            inset: 12,                    // 距画面边缘的像素
            minWidth: 280,                // 视频小于这个尺寸就不打扰（过滤广告位/缩略图预览）
            minHeight: 160,
            minVisibleRatio: 0.3,         // 至少这么多比例露在视口里才显示
            idleOpacity: 0.55,            // 平时半透明，鼠标移上去变清晰
            pollInterval: 800             // 跟随视频位置的刷新间隔（滚动/缩放/全屏另有事件）
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
        toastDuration: 2000,
        relay: {                          // 跨框架中继参数
            key: '__videoScreenshotMsg',  // 消息标识，避免和站点自己的 postMessage 撞车
            collectWindow: 250,           // 收到第一个子框架结果后，再等这么久收其它结果（选面积最大的）
            captureTimeout: 1500,         // 等子框架抓帧的总超时（没人有视频时就该这么快报错）
            ackTimeout: 10000,            // 子框架已确认「我有视频」后的等待上限（可能要走 CORS 兜底，慢）
            writeTimeout: 3000,           // 等顶层写剪贴板的超时
            maxHops: 6                    // capture-request 最多向下转发几层
        },
        corsRetry: true,                  // 画布被污染时，尝试用 crossOrigin 重新拉一次媒体源
        downloadFallback: true            // 剪贴板彻底不可用时，退化为下载 PNG
    };

    // ---------- 站点规则表（可选覆盖，不是必需品） ----------
    // 默认所有站点都用通用悬浮按钮，不需要在这里登记。
    // 只有当某站希望按钮出现在「正经位置」（例如 B 站标题栏旁边）时，才加一行
    // host + 锚点选择器；命中规则的站点会改用内联按钮，并且不再显示悬浮按钮。
    const SITE_RULES = [
        { host: 'live.bilibili.com', anchor: '.follow-ctnr' },
        { host: 'www.bilibili.com', anchor: '.pubdate-ip' }
    ];

    const IS_TOP = (function () {
        try { return window.top === window; } catch (e) { return false; }
    })();

    function log() {
        if (!CONFIG.debug) return;
        const args = Array.prototype.slice.call(arguments);
        args.unshift(CONFIG.logPrefix);
        console.log.apply(console, args);
    }

    function getSiteRule() {
        const host = window.location.hostname;
        for (let i = 0; i < SITE_RULES.length; i++) {
            if (host === SITE_RULES[i].host) return SITE_RULES[i];
        }
        return null;
    }

    // ---------- 错误码 → 人话 ----------
    function fail(code, detail) {
        const err = new Error(detail || code);
        err.code = code;
        return err;
    }

    const ERROR_TEXT = {
        NO_VIDEO: '未找到有效视频',
        EMPTY_FRAME: '视频未加载完成',
        DRM: '该视频已加密，无法截图',
        NO_CANVAS: 'Canvas 初始化失败',
        TAINTED: '该站点视频受跨域限制',
        BLOB_NULL: '截图生成失败',
        RELAY_TIMEOUT: '子框架截图超时'
    };

    function describeError(err) {
        if (!err) return '复制失败';
        if (err.code && ERROR_TEXT[err.code]) return ERROR_TEXT[err.code];

        const name = err.name || '';
        const message = err.message || String(err);
        if (name === 'SecurityError') return ERROR_TEXT.TAINTED;
        if (name === 'NotAllowedError') {
            return message.indexOf('permissions policy') !== -1 || message.indexOf('disabled') !== -1
                ? '浏览器策略禁止本框架写剪贴板'
                : '剪贴板被禁用或页面未聚焦';
        }
        if (name === 'DataError' || message.indexOf('ClipboardItemData') !== -1) return '复制失败，请刷新页面';
        if (message.indexOf('toBlob 返回 null') !== -1) return ERROR_TEXT.BLOB_NULL;
        return '复制失败：' + message;
    }

    // ---------- Toast 提示（水平居中，垂直与按钮对齐，8px圆角） ----------
    function getToastHost() {
        // 全屏时只有全屏元素（及其后代）会被渲染，提示要挂到它里面才看得见
        return document.fullscreenElement || document.webkitFullscreenElement || document.body || document.documentElement;
    }

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
            zIndex: '2147483647',
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
        if (anchorElement && anchorElement.getBoundingClientRect) {
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

        getToastHost().appendChild(toast);

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

        if (!best && videos.length) {
            log('本框架扫到 ' + videos.length + ' 个 <video>，但没有一个处于可截图的就绪状态');
        }
        return best;
    }
    // ----------------------------------

    // ---------- 本框架内抓帧（只产出 Blob，不碰剪贴板） ----------
    function drawToCanvas(video) {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw fail('NO_CANVAS');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        return canvas;
    }

    function canvasToBlob(canvas) {
        return new Promise(function (resolve, reject) {
            try {
                canvas.toBlob(function (blob) {
                    blob ? resolve(blob) : reject(fail('BLOB_NULL', 'toBlob 返回 null'));
                }, 'image/png');
            } catch (err) {
                reject(err);
            }
        });
    }

    function isCanvasTainted(canvas) {
        try {
            canvas.getContext('2d').getImageData(0, 0, 1, 1);
            return false;
        } catch (err) {
            return !!err && err.name === 'SecurityError';
        }
    }

    // 兜底：<video> 的源跨域且没带 CORS 头 → 画布被污染，像素读不出来。
    // 用带 crossOrigin="anonymous" 的新 <video> 重新拉一次同一地址并 seek 到同一时间点，
    // 只要媒体服务器给了 Access-Control-Allow-Origin，就能拿到干净的一帧。
    // MSE（blob: 地址）不适用，因为原始分片由页面自己的 JS 喂进去，无法重放。
    function captureViaCorsVideo(video) {
        return new Promise(function (resolve, reject) {
            const src = video.currentSrc || video.src || '';
            if (!/^https?:/i.test(src)) return reject(fail('TAINTED', '媒体源不是 http(s) 地址，无法用 CORS 重试'));

            const time = video.currentTime || 0;
            const helper = document.createElement('video');
            helper.crossOrigin = 'anonymous';
            helper.muted = true;
            helper.preload = 'auto';
            helper.playsInline = true;

            let finished = false;
            const cleanup = function () {
                try { helper.removeAttribute('src'); helper.load(); } catch (e) {}
            };
            const bail = function (err) {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                helper.remove();
                cleanup();
                reject(err);
            };
            const timer = setTimeout(function () { bail(fail('TAINTED', 'CORS 重试超时')); }, 8000);

            helper.addEventListener('error', function () { bail(fail('TAINTED', '媒体服务器未提供 CORS 头')); });

            const grab = function () {
                if (finished) return;
                if (helper.videoWidth <= 0) return bail(fail('TAINTED', 'CORS 重试后视频尺寸为 0'));
                finished = true;
                clearTimeout(timer);
                let canvas;
                try {
                    canvas = drawToCanvas(helper);
                } catch (err) {
                    return bail(err);
                }
                if (isCanvasTainted(canvas)) return bail(fail('TAINTED', '媒体服务器未提供 CORS 头'));
                canvasToBlob(canvas).then(function (blob) {
                    helper.remove();
                    cleanup();
                    resolve(blob);
                }).catch(bail);
            };

            helper.addEventListener('loadeddata', function () {
                if (finished) return;
                // 尽量 seek 到用户当前看到的那一帧
                const duration = isFinite(helper.duration) ? helper.duration : time;
                const target = Math.max(0, Math.min(time, Math.max(0, duration - 0.05)));
                if (target > 0 && Math.abs(helper.currentTime - target) > 0.05) {
                    helper.addEventListener('seeked', grab, { once: true });
                    setTimeout(function () { if (!finished) grab(); }, 1500);
                    try { helper.currentTime = target; } catch (e) { grab(); }
                } else {
                    grab();
                }
            });

            helper.src = src;
        });
    }

    function captureFrame(video) {
        if (!video) return Promise.reject(fail('NO_VIDEO'));
        if (!video.videoWidth || !video.videoHeight) return Promise.reject(fail('EMPTY_FRAME'));
        if (video.mediaKeys) return Promise.reject(fail('DRM'));   // EME/DRM 加密流截出来是黑帧

        let canvas;
        try {
            canvas = drawToCanvas(video);
        } catch (err) {
            return Promise.reject(err);
        }

        if (isCanvasTainted(canvas)) {
            log('画布被跨域污染，尝试用 crossOrigin 重新拉一次媒体源');
            const retry = CONFIG.corsRetry
                ? captureViaCorsVideo(video).catch(function (err) {
                    log('CORS 重试失败：' + err.message);
                    return null;
                })
                : Promise.resolve(null);

            return retry.then(function (blob) {
                if (!blob) throw fail('TAINTED');
                log('CORS 重试成功，拿到干净的一帧');
                return { blob: blob, width: video.videoWidth, height: video.videoHeight };
            });
        }

        return canvasToBlob(canvas).then(function (blob) {
            return { blob: blob, width: canvas.width, height: canvas.height };
        });
    }
    // ----------------------------------

    // ---------- 跨框架中继 ----------
    const relay = (function () {
        const KEY = CONFIG.relay.key;
        const pending = new Map();          // id -> { onResult(shot|response), collect }
        let seq = 0;

        function newId() {
            seq++;
            return Date.now().toString(36) + '-' + seq.toString(36) + '-' + Math.random().toString(36).slice(2, 8);
        }

        function post(target, msg) {
            try { target.postMessage(msg, '*'); return true; } catch (e) { return false; }
        }

        function postToChildren(msg) {
            let sent = false;
            for (let i = 0; i < window.frames.length; i++) {
                let child = null;
                try { child = window.frames[i]; } catch (e) { continue; }
                if (child && post(child, msg)) sent = true;
            }
            return sent;
        }

        function isMyChild(source) {
            if (!source) return false;
            for (let i = 0; i < window.frames.length; i++) {
                let child = null;
                try { child = window.frames[i]; } catch (e) { continue; }
                if (child === source) return true;
            }
            return false;
        }

        function isMyParent(source) {
            try { return !!source && source === window.parent; } catch (e) { return false; }
        }

        // 让某一层子框架抓帧，返回 { shot, error }
        function captureFromDescendants() {
            return new Promise(function (resolve) {
                if (!window.frames.length) return resolve({ shot: null, error: '' });

                const id = newId();
                let settled = false;
                let collectTimer = null;
                let hardTimer = null;
                const shots = [];
                const errors = [];

                const finish = function () {
                    if (settled) return;
                    settled = true;
                    clearTimeout(collectTimer);
                    clearTimeout(hardTimer);
                    pending.delete(id);
                    shots.sort(function (a, b) { return (b.width * b.height) - (a.width * a.height); });
                    resolve({ shot: shots[0] || null, error: errors[0] || '' });
                };

                hardTimer = setTimeout(function () {
                    if (!settled && !shots.length && !errors.length) log('等待子框架抓帧超时');
                    finish();
                }, CONFIG.relay.captureTimeout);

                pending.set(id, {
                    collect: true,
                    // 子框架先回一声「我有视频，正在抓」：可能要走 CORS 兜底等好几秒，
                    // 这时把等待上限放宽，别让用户看到一个假的「未找到有效视频」。
                    onAck: function () {
                        if (settled) return;
                        log('子框架确认有视频，正在抓帧（延长等待）');
                        clearTimeout(hardTimer);
                        hardTimer = setTimeout(function () {
                            if (!settled && !shots.length) log('子框架抓帧超时（已确认有视频）');
                            finish();
                        }, CONFIG.relay.ackTimeout);
                    },
                    onResult: function (shot, error) {
                        if (settled) return;
                        if (shot) shots.push(shot);
                        else if (error) errors.push(error);
                        // 收到回音后只再等一小会儿，收齐其它子框架的结果（避免挑到小的那个），
                        // 也让「抓帧失败」这类结果能快速反馈给用户，不用干等满超时。
                        if (!collectTimer) collectTimer = setTimeout(finish, CONFIG.relay.collectWindow);
                    }
                });

                log('本框架没有可用视频，向 ' + window.frames.length + ' 个子框架请求抓帧');
                postToChildren({ [KEY]: 1, kind: 'capture-request', id: id, hops: 0 });
            });
        }

        // 请顶层代为写入剪贴板（子框架没有 clipboard-write 权限时用）
        function requestTopWrite(blob) {
            return new Promise(function (resolve) {
                if (IS_TOP) return resolve({ ok: false, reason: '已经在顶层' });

                const id = newId();
                let settled = false;
                const finish = function (res) {
                    if (settled) return;
                    settled = true;
                    pending.delete(id);
                    resolve(res);
                };

                pending.set(id, {
                    onResult: function (res) { finish(res || { ok: false, reason: '顶层无响应' }); }
                });

                if (!post(window.top, { [KEY]: 1, kind: 'write-request', id: id, blob: blob })) {
                    return finish({ ok: false, reason: '无法与顶层通信' });
                }
                setTimeout(function () {
                    if (!settled) log('等待顶层写剪贴板超时');
                    finish({ ok: false, reason: '顶层写入超时' });
                }, CONFIG.relay.writeTimeout);
            });
        }

        // 顶层代子框架写入，静默（提示由发起方自己弹）
        function handleWriteRequest(data, event) {
            if (!isMyChild(event.source)) return;
            writeBlobToClipboard(data.blob).then(function () {
                post(event.source, { [KEY]: 1, kind: 'write-result', id: data.id, ok: true });
            }).catch(function (err) {
                log('代子框架写剪贴板失败：' + describeError(err));
                post(event.source, { [KEY]: 1, kind: 'write-result', id: data.id, ok: false, reason: describeError(err) });
            });
        }

        function handleCaptureRequest(data, event) {
            if (!isMyParent(event.source)) return;    // 只服务祖先框架的请求

            const video = getBestVideo();
            if (video) {
                log('收到抓帧请求，本框架有视频，开始抓帧');
                post(event.source, { [KEY]: 1, kind: 'capture-ack', id: data.id });   // 先应答，别让上层等急了
                captureFrame(video).then(function (shot) {
                    log('抓帧完成 ' + shot.width + 'x' + shot.height + '，回传给请求方');
                    post(event.source, {
                        [KEY]: 1, kind: 'capture-result', id: data.id,
                        shot: { blob: shot.blob, width: shot.width, height: shot.height }
                    });
                }).catch(function (err) {
                    log('抓帧失败：' + describeError(err));
                    post(event.source, { [KEY]: 1, kind: 'capture-result', id: data.id, error: describeError(err) });
                });
                return;
            }

            // 自己没有视频 → 继续往下问（穿透嵌套 iframe）
            const hops = (data.hops || 0) + 1;
            if (hops <= CONFIG.relay.maxHops && window.frames.length) {
                postToChildren({ [KEY]: 1, kind: 'capture-request', id: data.id, hops: hops });
            }
        }

        // 子框架的「我有视频」应答：不是自己发起的就继续往上传
        function handleCaptureAck(data, event) {
            const entry = pending.get(data.id);
            if (entry && entry.collect && entry.onAck) { entry.onAck(); return; }
            if (isMyChild(event.source) && !IS_TOP) post(window.parent, data);
        }

        function handleCaptureResult(data, event) {
            const entry = pending.get(data.id);
            if (entry && entry.collect) {
                if (data.shot && data.shot.blob) entry.onResult(data.shot, '');
                else {
                    log('子框架回传失败：' + (data.error || '未知原因'));
                    entry.onResult(null, data.error || '');
                }
                return;
            }

            // 不是我发起的（下层转发上来的结果）→ 继续往上传
            if (isMyChild(event.source) && !IS_TOP) {
                post(window.parent, data);
            }
        }

        function handleWriteResult(data) {
            const entry = pending.get(data.id);
            if (entry) entry.onResult({ ok: !!data.ok, reason: data.reason || '' });
        }

        // 顶层已经插好内联按钮 → 让子框架收起悬浮按钮，免得同一页出现两个「截屏」
        function handleInlineButton(data, event) {
            if (!isMyParent(event.source)) return;
            floater.suppress();
            if (window.frames.length) postToChildren(data);   // 继续往下传，穿透嵌套 iframe
        }

        function notifyInlineButton() {
            postToChildren({ [KEY]: 1, kind: 'inline-button' });
        }

        function install() {
            window.addEventListener('message', function (event) {
                const data = event.data;
                if (!data || typeof data !== 'object' || data[KEY] !== 1) return;

                switch (data.kind) {
                    case 'capture-request': handleCaptureRequest(data, event); break;
                    case 'capture-ack': handleCaptureAck(data, event); break;
                    case 'capture-result': handleCaptureResult(data, event); break;
                    case 'write-request': handleWriteRequest(data, event); break;
                    case 'write-result': handleWriteResult(data); break;
                    case 'inline-button': handleInlineButton(data, event); break;
                }
            });
            log('跨框架中继已就绪（' + (IS_TOP ? '顶层' : '子框架') + '）');
        }

        return {
            install: install,
            captureFromDescendants: captureFromDescendants,
            requestTopWrite: requestTopWrite,
            notifyInlineButton: notifyInlineButton
        };
    })();
    // ----------------------------------

    // ---------- 剪贴板 ----------
    // 跨域 iframe 默认拿不到 clipboard-write（Permissions Policy 默认 allowlist 是 self），
    // 先查策略，能写就自己写，不能写就交给顶层。
    function clipboardAllowedHere() {
        if (!navigator.clipboard || typeof ClipboardItem === 'undefined') return false;
        try {
            if (document.featurePolicy && document.featurePolicy.allowsFeature &&
                !document.featurePolicy.allowsFeature('clipboard-write')) return false;
        } catch (e) { /* 老浏览器没有 featurePolicy，交给实际写入时报错 */ }
        return true;
    }

    function writeBlobToClipboard(blob) {
        if (!blob) return Promise.reject(fail('BLOB_NULL'));
        if (!navigator.clipboard || typeof ClipboardItem === 'undefined') {
            return Promise.reject(fail('NO_CLIPBOARD', '剪贴板 API 不可用（需要 https 页面且浏览器支持）'));
        }

        const item = new ClipboardItem({ 'image/png': blob });

        return navigator.clipboard.write([item]).catch(function (err) {
            // 只有「页面未聚焦」是可恢复的，抢回焦点再试一次；其余原因重试也没用
            const name = (err && err.name) || '';
            const message = (err && err.message) || '';
            if (name === 'NotAllowedError' && message.indexOf('not focused') !== -1) {
                log('页面未聚焦，恢复焦点后重试');
                try { window.focus(); } catch (e) {}
                return navigator.clipboard.write([item]);
            }
            throw err;
        });
    }

    function downloadBlob(blob, name) {
        try {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = name || ('video-frame-' + Date.now() + '.png');
            a.style.display = 'none';
            (document.body || document.documentElement).appendChild(a);
            a.click();
            setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 10000);
            return true;
        } catch (err) {
            log('下载兜底失败：' + err.message);
            return false;
        }
    }
    // ----------------------------------

    // ---------- 主流程 ----------
    // 抓帧 → 写入剪贴板；写不了就交给顶层写；都写不了再退化成下载。
    async function saveShot(shot, anchorElement, silent) {
        const toast = function (msg, ok) { if (!silent) showToast(msg, ok, anchorElement); };

        if (clipboardAllowedHere()) {
            try {
                await writeBlobToClipboard(shot.blob);
                log('截图已复制到剪贴板（' + shot.width + 'x' + shot.height + '）');
                toast('✅ 已复制', true);
                return true;
            } catch (err) {
                log('本框架写剪贴板失败：' + describeError(err));
                if (IS_TOP) {
                    if (CONFIG.downloadFallback && downloadBlob(shot.blob)) {
                        toast('⚠️ 剪贴板不可用，已改为下载图片', false);
                        return false;
                    }
                    toast('❌ ' + describeError(err), false);
                    return false;
                }
            }
        } else {
            log('本框架没有 clipboard-write 权限（多为跨域 iframe），转交顶层写入');
        }

        if (!IS_TOP) {
            const res = await relay.requestTopWrite(shot.blob);
            if (res.ok) {
                log('已由顶层写入剪贴板');
                toast('✅ 已复制', true);
                return true;
            }
            log('顶层写入失败：' + res.reason);
            toast('❌ ' + (res.reason || '复制失败'), false);
            return false;
        }

        return false;
    }

    async function doCapture(anchorElement) {
        log('--- 开始截图 ---');
        log('文档焦点: hasFocus=' + document.hasFocus() + ', visibility=' + document.visibilityState +
            ', clipboard-write=' + clipboardAllowedHere() + ', frames=' + window.frames.length);

        // 1) 本框架有视频：直接抓
        const video = getBestVideo();
        if (video) {
            log('使用本框架视频: ' + video.videoWidth + 'x' + video.videoHeight +
                ', readyState=' + video.readyState + ', paused=' + video.paused +
                ', src=' + String(video.currentSrc || video.src || '').slice(0, 60));
            try {
                const shot = await captureFrame(video);
                return await saveShot(shot, anchorElement, false);
            } catch (err) {
                log('截图失败：' + describeError(err) + ' / ' + (err && err.message));
                showToast('❌ ' + describeError(err), false, anchorElement);
                return false;
            }
        }

        // 2) 本框架没有视频：问子框架（视频在跨域 iframe 里的站点走这条路）
        if (window.frames.length) {
            const res = await relay.captureFromDescendants();
            if (res.shot) {
                log('子框架回传截图 ' + res.shot.width + 'x' + res.shot.height + '，准备写入剪贴板');
                return await saveShot(res.shot, anchorElement, false);
            }
            if (res.error) {
                // 子框架给出了明确原因（跨域限制/加密流等），直接透传给用户
                showToast('❌ ' + res.error, false, anchorElement);
                return false;
            }
            log('子框架里也没有可截图的视频');
        }

        showToast('❌ ' + ERROR_TEXT.NO_VIDEO, false, anchorElement);
        return false;
    }
    // ----------------------------------

    // ---------- 按钮 ----------
    function makeButton() {
        const btn = document.createElement('button');
        btn.textContent = CONFIG.buttonText;
        btn.className = CONFIG.buttonClass;
        btn.id = CONFIG.buttonId;
        Object.assign(btn.style, CONFIG.buttonStyle);

        btn.addEventListener("mouseover", function () {
            btn.style.backgroundColor = CONFIG.hoverStyle.backgroundColor;
            btn.style.opacity = '1';
        });
        btn.addEventListener("mouseout", function () {
            btn.style.backgroundColor = CONFIG.buttonStyle.backgroundColor;
            if (btn.dataset.floating) btn.style.opacity = String(CONFIG.autoButton.idleOpacity);
        });

        btn.addEventListener("click", function (event) {
            event.stopPropagation();
            doCapture(btn).catch(function (err) {
                log('截图流程异常: ' + err);
            });
        });
        return btn;
    }

    // 视频露在视口内的面积占比（滚出屏幕 / 被裁掉时用来隐藏按钮）
    function visibleRatio(el) {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return 0;
        const w = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
        const h = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
        return (w * h) / (rect.width * rect.height);
    }

    function overlayHost() {
        // 全屏时只有全屏元素（及其后代）会被渲染，按钮要挂到它里面才看得见
        return document.fullscreenElement || document.webkitFullscreenElement || document.body || document.documentElement;
    }

    // ---------- 通用悬浮按钮（不依赖站点选择器） ----------
    // 谁持有 <video> 就在谁的文档里画按钮，直接贴在画面角落上：
    //   · 视频在跨域 iframe 里 → 按钮就画在那个 iframe 的画面上，位置天然正确
    //   · 播放器改版 / 换播放器 / SPA 换集 → 按钮跟着视频元素走，不受影响
    const floater = (function () {
        let btn = null;
        let shownFor = null;
        let suppressed = false;      // 页面里已经有内联按钮时不再显示

        function pickVideo() {
            const video = getBestVideo();
            if (!video) return null;

            const rect = video.getBoundingClientRect();
            if (rect.width < CONFIG.autoButton.minWidth || rect.height < CONFIG.autoButton.minHeight) return null;
            if (visibleRatio(video) < CONFIG.autoButton.minVisibleRatio) return null;
            return video;
        }

        function hide() {
            if (btn && btn.style.display !== 'none') btn.style.display = 'none';
            shownFor = null;
        }

        function place(video) {
            // 全屏元素本身就是 <video> 时，里面塞不进任何东西（video 的子元素不参与渲染）
            const fs = document.fullscreenElement || document.webkitFullscreenElement;
            if (fs === video) return false;

            const parent = overlayHost();
            if (btn.parentNode !== parent) parent.appendChild(btn);

            const rect = video.getBoundingClientRect();
            const inset = CONFIG.autoButton.inset;
            const w = btn.offsetWidth || 64;
            const h = btn.offsetHeight || 28;
            const corner = CONFIG.autoButton.corner;

            let left = corner.indexOf('left') !== -1 ? rect.left + inset : rect.right - w - inset;
            let top = corner.indexOf('top') !== -1 ? rect.top + inset : rect.bottom - h - inset;
            left = Math.max(4, Math.min(left, window.innerWidth - w - 4));
            top = Math.max(4, Math.min(top, window.innerHeight - h - 4));

            btn.style.left = left + 'px';
            btn.style.top = top + 'px';
            btn.style.display = '';
            return true;
        }

        function update() {
            if (!CONFIG.autoButton.enabled || suppressed || getSiteRule()) return hide();

            const video = pickVideo();
            if (!video) return hide();

            if (!btn) {
                btn = makeButton();
                btn.dataset.floating = '1';
                Object.assign(btn.style, {
                    position: 'fixed',
                    zIndex: '2147483646',
                    opacity: String(CONFIG.autoButton.idleOpacity),
                    userSelect: 'none',
                    marginBottom: '0',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.3)'
                });
            }

            if (!place(video)) return hide();
            if (shownFor !== video) log('已在视频画面角落显示悬浮截图按钮');
            shownFor = video;
        }

        // 页面别处已经有内联按钮（本站命中站点规则，或顶层已经插好）→ 收起悬浮按钮
        function suppress() {
            if (suppressed) return;
            suppressed = true;
            hide();
            log('页面已有内联截图按钮，收起悬浮按钮');
        }

        return { update: update, hide: hide, suppress: suppress };
    })();

    function startFloatingWatcher() {
        if (!CONFIG.autoButton.enabled || getSiteRule()) return;

        let queued = false;
        const tick = function () {
            if (queued) return;
            queued = true;
            requestAnimationFrame(function () {
                queued = false;
                try { floater.update(); } catch (err) { log('悬浮按钮刷新异常: ' + err); }
            });
        };

        setInterval(tick, CONFIG.autoButton.pollInterval);
        window.addEventListener('scroll', tick, true);      // 捕获阶段，内层滚动容器也算
        window.addEventListener('resize', tick);
        document.addEventListener('fullscreenchange', tick);
        document.addEventListener('webkitfullscreenchange', tick);
        tick();
    }
    // ----------------------------------

    // ---------- 内联按钮注入（仅命中站点规则的站点） ----------
    function addScreenShotEle(insertAfter) {
        if (document.getElementById(CONFIG.buttonId)) return;
        const btn = makeButton();
        insertAfter.insertAdjacentElement('afterend', btn);
        log("截图按钮已添加");
        floater.suppress();            // 本框架用内联按钮
        relay.notifyInlineButton();    // 告诉子框架也别再显示悬浮按钮
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

    // ----- 快捷键处理 -----
    function handleKeyDown(event) {
        if (event.repeat) return;

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
            event.stopPropagation();       // 别让播放器/站点自己的快捷键也吃到这一次
            log('快捷键触发截图');
            doCapture(null).catch(function (err) {
                log('截图流程异常: ' + err);
            });
        }
    }

    function shortcutText() {
        const sc = CONFIG.shortcut;
        return `${sc.ctrl ? 'Ctrl+' : ''}${sc.shift ? 'Shift+' : ''}${sc.alt ? 'Alt+' : ''}${sc.key.toUpperCase()}`;
    }

    function init() {
        log('脚本初始化：' + window.location.hostname + '（' + (IS_TOP ? '顶层文档' : '子框架') + '）');

        relay.install();                                   // 每个框架都要装，中继才能穿透嵌套 iframe

        // 用捕获阶段监听：抢在站点自己的按键处理之前拿到事件
        window.addEventListener('keydown', handleKeyDown, true);
        log(`快捷键已启用：${shortcutText()}（输入框内不触发）`);

        startButtonWatcher();      // 命中了站点规则 → 内联按钮
        startFloatingWatcher();    // 没命中 → 通用悬浮按钮，视频画面上见
        log(getSiteRule()
            ? '本站命中站点规则，使用内联按钮'
            : '未命中站点规则，使用通用悬浮按钮 + 快捷键');
    }

    init();
})();
