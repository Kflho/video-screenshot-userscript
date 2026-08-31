// ==UserScript==
// @name         Bilibili 视频截图按钮（带快捷键 + 居中提示 + 8px圆角）
// @namespace    https://github.com/Kflho
// @version      1.0.5
// @description  截图按钮 + Ctrl+Shift+S，弹窗水平居中垂直对齐按钮，圆角8px
// @author       Kflho
// @match        http*://www.bilibili.com/*
// @match        http*://live.bilibili.com/*
// @icon         https://www.bilibili.com/favicon.ico
// @grant        none
// @license      MIT
// @downloadURL  https://raw.githubusercontent.com/Kflho/bilibili-screenshot-userscript/refs/heads/main/bilibili-screenshot-userscript.js
// @updateURL    https://raw.githubusercontent.com/Kflho/bilibili-screenshot-userscript/refs/heads/main/bilibili-screenshot-userscript.js
// ==/UserScript==

(function () {
    "use strict";

    const CONFIG = {
        logPrefix: "[视频截图按钮]",
        buttonText: "截屏",
        buttonClass: "screenshotBtn08",
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
        pubDateSelector: '.pubdate-ip',
        liveRoomTitleSelector: '.follow-ctnr',
        checkInterval: 3000,
        buttonAdded: false,
        shortcut: {
            key: 's',
            ctrl: true,
            shift: true,
            alt: false
        },
        toastDuration: 2000
    };

    function log(message) {
        console.log(`${CONFIG.logPrefix} ${message}`);
    }

    // ---------- Toast 提示（水平居中，垂直与按钮对齐，8px圆角） ----------
    function showToast(message, isSuccess, anchorElement) {
        const oldToast = document.getElementById('biliScreenshotToast');
        if (oldToast) oldToast.remove();

        if (!anchorElement) {
            anchorElement = document.querySelector('.' + CONFIG.buttonClass);
        }

        const toast = document.createElement('div');
        toast.id = 'biliScreenshotToast';
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

        // ----- 定位：水平居中，垂直与按钮中心对齐 -----
        if (anchorElement) {
            const rect = anchorElement.getBoundingClientRect();
            const centerY = rect.top + rect.height / 2;
            toast.style.left = '50%';
            toast.style.top = centerY + 'px';
            toast.style.transform = 'translateX(-50%) translateY(-50%)';
            toast.style.bottom = 'auto';
            toast.style.right = 'auto';
        } else {
            // 无锚点（回退）
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

    function init() {
        log("脚本初始化");
        FindvideoEle();
        document.addEventListener('keydown', handleKeyDown);
        log(`快捷键已启用：${CONFIG.shortcut.ctrl ? 'Ctrl+' : ''}${CONFIG.shortcut.shift ? 'Shift+' : ''}${CONFIG.shortcut.alt ? 'Alt+' : ''}${CONFIG.shortcut.key.toUpperCase()}`);
    }

    function FindvideoEle() {
        function f() {
            let videos = document.getElementsByTagName('video');
            if (videos.length > 0 && !CONFIG.buttonAdded) {
                addScreenShotEle(videos[0]);
                CONFIG.buttonAdded = true;
                clearInterval(interval);
            }
        }
        const interval = setInterval(f, CONFIG.checkInterval);
    }

    function isLivePage() {
        return window.location.hostname.includes('live.bilibili.com');
    }

    function addScreenShotEle(videoElement) {
        let SsIDname = videoElement.id + "_Sshot";
        if (document.getElementById(SsIDname) === null) {
            let SsHtml = document.createElement("button");
            SsHtml.textContent = CONFIG.buttonText;
            SsHtml.className = CONFIG.buttonClass;
            Object.assign(SsHtml.style, CONFIG.buttonStyle);
            SsHtml.addEventListener("mouseover", function () {
                SsHtml.style.backgroundColor = CONFIG.hoverStyle.backgroundColor;
            });
            SsHtml.addEventListener("mouseout", function () {
                SsHtml.style.backgroundColor = CONFIG.buttonStyle.backgroundColor;
            });

            let targetElement;
            if (isLivePage()) {
                targetElement = document.querySelector(CONFIG.liveRoomTitleSelector);
            } else {
                targetElement = document.querySelector(CONFIG.pubDateSelector);
            }

            if (targetElement) {
                SsHtml.setAttribute("id", SsIDname);
                targetElement.insertAdjacentElement('afterend', SsHtml);
                log("截图按钮已添加");
            } else {
                SsHtml.setAttribute("id", SsIDname);
                videoElement.parentNode.insertBefore(SsHtml, videoElement.nextSibling);
                log("截图按钮已添加（备用位置）");
            }

            SsHtml._currentVideo = videoElement;

            SsHtml.addEventListener("click", function (event) {
                event.stopPropagation();
                let currentVideo = SsHtml._currentVideo;
                if (currentVideo && currentVideo.videoWidth > 0 && currentVideo.videoHeight > 0 && currentVideo.readyState >= 2) {
                    takeScreenshot(currentVideo, SsHtml);
                } else {
                    log('视频元素已更新，重新查找...');
                    let videos = document.getElementsByTagName('video');
                    for (let i = 0; i < videos.length; i++) {
                        let v = videos[i];
                        if (v.videoWidth > 0 && v.videoHeight > 0 && v.readyState >= 2) {
                            SsHtml._currentVideo = v;
                            takeScreenshot(v, SsHtml);
                            return;
                        }
                    }
                    log('未找到有效的视频元素，请确保视频已加载');
                    showToast('❌ 未找到有效视频', false, SsHtml);
                }
            });
        } else {
            log("截图按钮已存在，跳过添加");
        }
    }

    function takeScreenshot(videoElement, anchorElement) {
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

        var myCanvas = document.createElement('canvas');
        myCanvas.width = videoElement.videoWidth;
        myCanvas.height = videoElement.videoHeight;
        var ctx = myCanvas.getContext('2d');
        if (!ctx) {
            log('错误: 无法获取Canvas 2D上下文');
            showToast('❌ Canvas初始化失败', false, anchorElement);
            return;
        }
        ctx.drawImage(videoElement, 0, 0, videoElement.videoWidth, videoElement.videoHeight);
        log('Canvas绘制完成: ' + myCanvas.width + 'x' + myCanvas.height);

        myCanvas.toBlob(function (blob) {
            if (!blob) {
                log('错误: toBlob返回null，Canvas内容可能为空');
                showToast('❌ 截图生成失败', false, anchorElement);
                return;
            }
            log('Blob生成成功: size=' + blob.size + ' bytes, type=' + blob.type);

            if (!document.hasFocus()) {
                window.focus();
                log('页面失去焦点，尝试恢复焦点，结果: hasFocus=' + document.hasFocus());
            }

            if (!navigator.clipboard) {
                log('错误: navigator.clipboard不可用');
                showToast('❌ 剪贴板API不可用', false, anchorElement);
                return;
            }

            navigator.clipboard.write([
                new ClipboardItem({ 'image/png': blob })
            ]).then(function () {
                log('截图已复制到剪贴板');
                showToast('✅ 已复制', true, anchorElement);
            }).catch(function (err) {
                log('截图复制失败:');
                log('  错误类型: ' + err.name);
                log('  错误信息: ' + err.message);
                log('  错误堆栈: ' + (err.stack || '无'));
                log('  Blob状态: size=' + blob.size + ', type=' + blob.type);
                log('  文档状态: hasFocus=' + document.hasFocus() + ', visibility=' + document.visibilityState);
                let errorMsg = '❌ 复制失败';
                if (err.name === 'DataError' || err.message.includes('ClipboardItemData')) {
                    errorMsg += '，请刷新页面';
                }
                showToast(errorMsg, false, anchorElement);
            });
        }, 'image/png');
    }

    // ----- 快捷键处理 -----
    function handleKeyDown(event) {
        const tag = event.target.tagName.toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || event.target.isContentEditable) {
            return;
        }

        const sc = CONFIG.shortcut;
        const matchCtrl = sc.ctrl ? event.ctrlKey : !event.ctrlKey;
        const matchShift = sc.shift ? event.shiftKey : !event.shiftKey;
        const matchAlt = sc.alt ? event.altKey : !event.altKey;
        const matchKey = event.key.toLowerCase() === sc.key.toLowerCase();

        if (matchCtrl && matchShift && matchAlt && matchKey) {
            event.preventDefault();
            log('快捷键触发截图');
            let video = getValidVideo();
            if (video) {
                takeScreenshot(video, null);
            } else {
                log('未找到有效的视频，无法截图');
                showToast('❌ 未找到有效视频', false);
            }
        }
    }

    function getValidVideo() {
        let videos = document.getElementsByTagName('video');
        for (let i = 0; i < videos.length; i++) {
            let v = videos[i];
            if (v.videoWidth > 0 && v.videoHeight > 0 && v.readyState >= 2) {
                return v;
            }
        }
        return null;
    }

    init();
})();