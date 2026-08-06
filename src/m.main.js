// ==UserScript==
// @name         网页音视频提取与下载器（Magic Bytes 智能识别）
// @namespace    http://tampermonkey.net/
// @version      2.1
// @description  通过 Range 请求读取文件头智能识别 MP4/MKV/WebM/FLV/MP3/Ogg/WAV 等格式，无视后缀名限制，支持批量打包下载与在线预览。
// @author       You
// @match        *://*/*
// @grant        GM_download
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @connect      *
// ==/UserScript==

(function() {
    'use strict';

    const CONCURRENCY = 4;            // 同时进行的探测请求数
    const REQUEST_TIMEOUT = 6000;     // 单次探测超时（毫秒）
    const SCAN_DEBOUNCE = 600;        // DOM 变化后的重新扫描防抖间隔
    const NAV_EXT_BLACKLIST = ['html', 'htm', 'php', 'jsp', 'jspx', 'asp', 'aspx', 'action', 'shtml'];

    let mediaMap = new Map();      // url -> { type, format }：已确认是媒体
    let nonMediaUrls = new Set();  // 已探测、确认不是媒体，不再重复请求
    let inFlight = new Set();      // 正在探测中，避免同一 URL 并发重复请求
    let selectedUrls = new Set();
    let isMultiSelectMode = false;
    let hlsInstance = null;
    let hlsLoadPromise = null;

    // ---------- 并发控制队列，避免链接较多的页面瞬间打出成百上千个请求 ----------
    class RequestQueue {
        constructor(max) { this.max = max; this.running = 0; this.queue = []; }
        push(task) { this.queue.push(task); this._drain(); }
        _drain() {
            while (this.running < this.max && this.queue.length) {
                const task = this.queue.shift();
                this.running++;
                Promise.resolve().then(task).catch(() => {}).finally(() => {
                    this.running--;
                    this._drain();
                });
            }
        }
    }
    const probeQueue = new RequestQueue(CONCURRENCY);

    // 常用媒体文件头 Magic Bytes 匹配表
    function detectFormatByHeader(u) {
        if (u.length < 4) return null;
        if (u.length >= 8 && u[4] === 0x66 && u[5] === 0x74 && u[6] === 0x79 && u[7] === 0x70) {
            return { type: 'video', format: 'MP4' };
        }
        if (u[0] === 0x1A && u[1] === 0x45 && u[2] === 0xDF && u[3] === 0xA3) {
            return { type: 'video', format: 'WebM/MKV' };
        }
        if (u[0] === 0x46 && u[1] === 0x4C && u[2] === 0x56) {
            return { type: 'video', format: 'FLV' };
        }
        if (u[0] === 0x4F && u[1] === 0x67 && u[2] === 0x67 && u[3] === 0x53) {
            return { type: 'audio', format: 'Ogg' };
        }
        if ((u[0] === 0x49 && u[1] === 0x44 && u[2] === 0x33) || (u[0] === 0xFF && (u[1] & 0xE0) === 0xE0)) {
            return { type: 'audio', format: 'MP3' };
        }
        if (u[0] === 0x52 && u[1] === 0x49 && u[2] === 0x46 && u[3] === 0x46) {
            return { type: 'audio', format: 'WAV' };
        }
        return null;
    }

    // 单次 GM_xmlhttpRequest 封装为 Promise，带超时
    function gmProbe(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                headers: { 'Range': 'bytes=0-15' },
                responseType: 'arraybuffer',
                timeout: REQUEST_TIMEOUT,
                onload: res => resolve(res),
                onerror: () => reject(new Error('network')),
                ontimeout: () => reject(new Error('timeout')),
                onabort: () => reject(new Error('abort'))
            });
        });
    }

    // fetch 兜底方案，用 AbortController 强制超时中断——
    // 防止目标服务器不支持 Range 时把整个大文件下载下来
    function fetchProbe(url) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
        return fetch(url, { headers: { 'Range': 'bytes=0-15' }, signal: controller.signal })
            .then(res => res.arrayBuffer())
            .finally(() => clearTimeout(timer));
    }

    // 零流量嗅探：只请求前 16 字节。探测结果分三种状态归档：
    // 1) mediaMap：确认是媒体 2) nonMediaUrls：确认不是媒体，永久跳过
    // 3) 网络错误/超时：不写入任何缓存，允许下次扫描重试
    async function probeUrlHeader(url) {
        if (mediaMap.has(url) || nonMediaUrls.has(url) || inFlight.has(url)) return;
        if (url.startsWith('javascript:') || url.startsWith('data:')) return;

        if (url.includes('.m3u8')) {
            mediaMap.set(url, { type: 'video', format: 'M3U8' });
            updateBadge();
            return;
        }

        inFlight.add(url);
        probeQueue.push(async () => {
            try {
                let buffer;
                if (typeof GM_xmlhttpRequest !== 'undefined') {
                    const res = await gmProbe(url);
                    if (res.status < 200 || res.status >= 300) throw new Error('status');
                    buffer = new Uint8Array(res.response);
                } else {
                    buffer = new Uint8Array(await fetchProbe(url));
                }
                const info = detectFormatByHeader(buffer);
                if (info) {
                    mediaMap.set(url, info);
                    updateBadge();
                } else {
                    nonMediaUrls.add(url);
                }
            } catch (e) {
                // 失败不记录，留给下一轮扫描重试
            } finally {
                inFlight.delete(url);
            }
        });
    }

    // 粗筛掉明显是站内导航的链接（纯锚点、常见页面后缀、同域无后缀路径），
    // 减少对普通 <a> 标签的无谓探测；video/audio/source 元素不受此限制
    function isLikelyNavLink(urlStr) {
        try {
            const u = new URL(urlStr);
            if (u.hash && u.pathname + u.search === location.pathname + location.search) return true;
            const ext = u.pathname.includes('.') ? u.pathname.split('.').pop().toLowerCase() : '';
            const hasExt = ext.length > 0 && ext.length <= 5;
            if (u.hostname === location.hostname && (!hasExt || NAV_EXT_BLACKLIST.includes(ext))) return true;
            return false;
        } catch (e) {
            return true;
        }
    }

    // 遍历页面所有潜在链接并校验 Header
    function scanAndProbeLinks() {
        const candidates = new Set();

        document.querySelectorAll('video[src], audio[src], video source, audio source').forEach(el => {
            const src = el.src;
            if (!src) return;
            try { candidates.add(new URL(src, document.baseURI).href); } catch (e) {}
        });

        document.querySelectorAll('a[href], source[src]').forEach(el => {
            const src = el.href || el.src;
            if (!src) return;
            try {
                const full = new URL(src, document.baseURI).href;
                if (!isLikelyNavLink(full)) candidates.add(full);
            } catch (e) {}
        });

        candidates.forEach(url => probeUrlHeader(url));
    }

    // 动态加载 hls.js：用 Promise 缓存加载状态，避免短时间内重复播放 m3u8 时重复插入 <script>
    function loadHlsLibrary() {
        if (typeof Hls !== 'undefined') return Promise.resolve();
        if (hlsLoadPromise) return hlsLoadPromise;
        hlsLoadPromise = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/hls.js@latest';
            script.onload = resolve;
            script.onerror = () => { hlsLoadPromise = null; reject(new Error('hls.js 加载失败')); };
            document.head.appendChild(script);
        });
        return hlsLoadPromise;
    }

    // 纯本地 Zip 打包
    class MiniZip {
        constructor() { this.files = []; }
        addFile(filename, arrayBuffer) {
            this.files.push({ name: filename, data: new Uint8Array(arrayBuffer) });
        }
        generateBlob() {
            let parts = [];
            let centralDirectory = [];
            let offset = 0;
            const encoder = new TextEncoder();

            for (let file of this.files) {
                let nameBytes = encoder.encode(file.name);
                let crc = this.crc32(file.data);
                let size = file.data.length;

                let header = new Uint8Array(30 + nameBytes.length);
                let view = new DataView(header.buffer);
                view.setUint32(0, 0x04034b50, true);
                view.setUint16(4, 10, true);
                view.setUint16(6, 0, true);
                view.setUint16(8, 0, true);
                view.setUint32(14, crc, true);
                view.setUint32(18, size, true);
                view.setUint32(22, size, true);
                view.setUint16(26, nameBytes.length, true);
                view.setUint16(28, 0, true);
                header.set(nameBytes, 30);

                parts.push(header);
                parts.push(file.data);

                let cdHeader = new Uint8Array(46 + nameBytes.length);
                let cdView = new DataView(cdHeader.buffer);
                cdView.setUint32(0, 0x02014b50, true);
                cdView.setUint16(4, 10, true);
                cdView.setUint16(6, 10, true);
                cdView.setUint32(16, crc, true);
                cdView.setUint32(20, size, true);
                cdView.setUint32(24, size, true);
                cdView.setUint16(28, nameBytes.length, true);
                cdView.setUint32(42, offset, true);
                cdHeader.set(nameBytes, 46);

                centralDirectory.push(cdHeader);
                offset += header.length + size;
            }

            let cdOffset = offset;
            let cdSize = 0;
            for (let cd of centralDirectory) {
                parts.push(cd);
                cdSize += cd.length;
            }

            let eocd = new Uint8Array(22);
            let eocdView = new DataView(eocd.buffer);
            eocdView.setUint32(0, 0x06054b50, true);
            eocdView.setUint16(8, this.files.length, true);
            eocdView.setUint16(10, this.files.length, true);
            eocdView.setUint32(12, cdSize, true);
            eocdView.setUint32(16, cdOffset, true);
            parts.push(eocd);

            return new Blob(parts, { type: 'application/zip' });
        }

        crc32(data) {
            let table = MiniZip.crcTable || (MiniZip.crcTable = (() => {
                let t = new Uint32Array(256);
                for (let i = 0; i < 256; i++) {
                    let c = i;
                    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
                    t[i] = c;
                }
                return t;
            })());
            let crc = -1;
            for (let i = 0; i < data.length; i++) {
                crc = (crc >>> 8) ^ table[(crc ^ data[i]) & 0xFF];
            }
            return (crc ^ (-1)) >>> 0;
        }
    }

    // 样式设置
    const style = document.createElement('style');
    style.textContent = `
        #media-fetcher-btn {
            position: fixed; bottom: 80px; left: 20px; width: 42px; height: 42px;
            background: #1d3557; color: #fff; font-weight: bold; font-size: 22px;
            display: flex; align-items: center; justify-content: center;
            border-radius: 8px; cursor: move; z-index: 999999;
            box-shadow: 0 4px 10px rgba(0,0,0,0.3); user-select: none;
            font-family: sans-serif; touch-action: none;
        }
        #media-fetcher-badge {
            position: absolute; top: -6px; right: -6px; background: #e63946;
            color: #fff; font-size: 11px; padding: 2px 6px; border-radius: 10px;
            font-weight: normal; font-family: sans-serif; transition: transform 0.2s;
        }
        #media-fetcher-badge.pulse { transform: scale(1.3); }
        #media-fetcher-modal, #media-player-modal {
            position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
            background: rgba(0,0,0,0.6); z-index: 9999999; display: none;
            align-items: center; justify-content: center; backdrop-filter: blur(4px);
        }
        #media-fetcher-content {
            background: #fff; width: 85vw; height: 85vh; border-radius: 12px;
            display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 8px 32px rgba(0,0,0,0.3);
        }
        .media-fetcher-header {
            padding: 14px 16px; background: #f8f9fa; border-bottom: 1px solid #eee;
            display: flex; justify-content: space-between; align-items: center;
            font-weight: bold; font-family: sans-serif; color: #333; font-size: 14px;
        }
        .media-fetcher-toolbar {
            padding: 10px 16px; background: #fff; border-bottom: 1px solid #eee;
            display: none; gap: 10px; align-items: center; font-family: sans-serif; font-size: 13px;
        }
        .media-fetcher-btn-action {
            background: #1d3557; color: #fff; border: none; padding: 6px 12px;
            border-radius: 4px; cursor: pointer; font-size: 12px;
        }
        .media-fetcher-btn-action:hover { background: #457b9d; }
        .media-fetcher-grid {
            padding: 16px; overflow-y: auto; display: grid;
            grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; flex: 1;
        }
        .media-fetcher-card {
            width: 100%; height: 120px; border: 1px solid #ddd; border-radius: 6px;
            overflow: hidden; cursor: pointer; position: relative; background: #f1faee;
            user-select: none; display: flex; flex-direction: column; align-items: center;
            justify-content: center; padding: 8px; box-sizing: border-box; text-align: center;
        }
        .media-fetcher-card.selected { border: 3px solid #e63946; }
        .media-fetcher-card .checkbox {
            position: absolute; top: 6px; left: 6px; width: 18px; height: 18px;
            border: 2px solid #fff; border-radius: 3px; background: rgba(0,0,0,0.3);
            display: none; align-items: center; justify-content: center; color: #fff; font-size: 12px;
            z-index: 2;
        }
        .media-fetcher-card.show-checkbox .checkbox { display: flex; }
        .media-fetcher-card.selected .checkbox { background: #e63946; }
        .media-icon { font-size: 28px; margin-bottom: 4px; color: #1d3557; }
        .media-fmt { font-size: 10px; background: #1d3557; color: #fff; padding: 1px 5px; border-radius: 3px; margin-bottom: 4px; }
        .media-name { font-size: 11px; color: #333; word-break: break-all; max-height: 28px; overflow: hidden; }

        #media-fetcher-menu {
            position: fixed; background: #fff; border: 1px solid #ddd;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15); border-radius: 6px;
            display: none; z-index: 10000000; padding: 4px 0; font-family: sans-serif;
        }
        .media-fetcher-menu-item {
            padding: 8px 16px; font-size: 14px; cursor: pointer; color: #333;
        }
        .media-fetcher-menu-item:hover { background: #f0f0f0; }

        #player-container {
            width: 70vw; max-width: 800px; background: #000; border-radius: 8px;
            overflow: hidden; display: flex; flex-direction: column; position: relative;
        }
        #player-container video { width: 100%; max-height: 70vh; outline: none; }
        #player-close {
            position: absolute; top: 10px; right: 10px; color: #fff; font-size: 24px;
            cursor: pointer; z-index: 10; background: rgba(0,0,0,0.5); width: 32px; height: 32px;
            border-radius: 50%; display: flex; align-items: center; justify-content: center;
        }
    `;
    document.head.appendChild(style);

    // M 悬浮按钮
    const btn = document.createElement('div');
    btn.id = 'media-fetcher-btn';
    btn.innerText = 'M';
    const badge = document.createElement('div');
    badge.id = 'media-fetcher-badge';
    badge.innerText = '0';
    btn.appendChild(badge);
    document.body.appendChild(btn);

    // 弹窗
    const modal = document.createElement('div');
    modal.id = 'media-fetcher-modal';
    modal.innerHTML = `
        <div id="media-fetcher-content">
            <div class="media-fetcher-header">
                <span>媒体提取器（共 <span id="media-fetcher-modal-count">0</span> 项）</span>
                <button id="media-fetcher-close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
            </div>
            <div class="media-fetcher-toolbar" id="media-fetcher-toolbar">
                <button class="media-fetcher-btn-action" id="btn-media-select-all">全选</button>
                <button class="media-fetcher-btn-action" id="btn-media-invert-select">反选</button>
                <button class="media-fetcher-btn-action" id="btn-media-download-selected" style="background:#e63946;">打包下载</button>
                <button class="media-fetcher-btn-action" id="btn-media-cancel-multiselect" style="background:#666;">退出多选</button>
                <span id="media-selected-count-text" style="color:#666; margin-left:auto;">已选 0 项</span>
            </div>
            <div class="media-fetcher-grid" id="media-fetcher-grid"></div>
        </div>
    `;
    document.body.appendChild(modal);

    // 快捷菜单
    const menu = document.createElement('div');
    menu.id = 'media-fetcher-menu';
    menu.innerHTML = `
        <div class="media-fetcher-menu-item" id="menu-media-download">下载文件</div>
        <div class="media-fetcher-menu-item" id="menu-media-copy">复制链接</div>
        <div class="media-fetcher-menu-item" id="menu-media-play" style="color:#1d3557;font-weight:bold;">预览播放</div>
    `;
    document.body.appendChild(menu);

    // 播放器弹窗
    const playerModal = document.createElement('div');
    playerModal.id = 'media-player-modal';
    playerModal.innerHTML = `
        <div id="player-container">
            <div id="player-close">&times;</div>
            <video id="media-player-video" controls autoplay></video>
        </div>
    `;
    document.body.appendChild(playerModal);

    let activeUrl = '';

    function updateBadge() {
        badge.innerText = mediaMap.size;
        document.getElementById('media-fetcher-modal-count').innerText = mediaMap.size;
        badge.classList.add('pulse');
        setTimeout(() => badge.classList.remove('pulse'), 200);
    }

    function updateSelectedText() {
        document.getElementById('media-selected-count-text').innerText = `已选 ${selectedUrls.size} 项`;
    }

    // 拖拽与点击
    let isDragging = false;
    let startX, startY, initialLeft, initialTop;

    function startDrag(clientX, clientY) {
        isDragging = false;
        startX = clientX;
        startY = clientY;
        const rect = btn.getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;
    }

    function onDragMove(clientX, clientY) {
        const dx = clientX - startX;
        const dy = clientY - startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) isDragging = true;
        btn.style.left = `${initialLeft + dx}px`;
        btn.style.top = `${initialTop + dy}px`;
        btn.style.bottom = 'auto';
        btn.style.right = 'auto';
    }

    btn.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        startDrag(e.clientX, e.clientY);
        const mouseMove = (me) => onDragMove(me.clientX, me.clientY);
        const mouseUp = () => {
            document.removeEventListener('mousemove', mouseMove);
            document.removeEventListener('mouseup', mouseUp);
        };
        document.addEventListener('mousemove', mouseMove);
        document.addEventListener('mouseup', mouseUp);
    });

    btn.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) return;
        const touch = e.touches[0];
        startDrag(touch.clientX, touch.clientY);
        const touchMove = (te) => {
            if (te.touches.length !== 1) return;
            onDragMove(te.touches[0].clientX, te.touches[0].clientY);
        };
        const touchEnd = () => {
            document.removeEventListener('touchmove', touchMove);
            document.removeEventListener('touchend', touchEnd);
        };
        document.addEventListener('touchmove', touchMove, { passive: false });
        document.addEventListener('touchend', touchEnd);
    });

    let lastTapTime = 0;
    btn.addEventListener('click', () => {
        const currentTime = new Date().getTime();
        if (currentTime - lastTapTime < 300) {
            btn.style.display = 'none';
            return;
        }
        lastTapTime = currentTime;

        if (isDragging) return;
        scanAndProbeLinks();
        renderGrid();
        modal.style.display = 'flex';
    });

    // 渲染卡片
    function renderGrid() {
        const grid = document.getElementById('media-fetcher-grid');
        grid.innerHTML = '';
        selectedUrls.clear();
        isMultiSelectMode = false;
        document.getElementById('media-fetcher-toolbar').style.display = 'none';
        updateSelectedText();

        mediaMap.forEach((info, url) => {
            const card = document.createElement('div');
            card.className = 'media-fetcher-card';

            const fileName = url.substring(url.lastIndexOf('/') + 1).split('?')[0] || 'media_stream';

            card.innerHTML = `
                <div class="checkbox">✓</div>
                <div class="media-icon">${info.type === 'audio' ? '🎵' : '🎬'}</div>
                <div class="media-fmt">${info.format}</div>
                <div class="media-name">${fileName}</div>
            `;

            let pressTimer = null;
            let longPressed = false;

            const startPress = () => {
                longPressed = false;
                pressTimer = setTimeout(() => {
                    longPressed = true;
                    enterMultiSelectMode();
                    selectedUrls.add(url);
                    card.classList.add('selected');
                    updateSelectedText();
                }, 500);
            };

            const cancelPress = () => { if (pressTimer) clearTimeout(pressTimer); };

            card.addEventListener('mousedown', startPress);
            card.addEventListener('touchstart', startPress);
            card.addEventListener('mouseup', cancelPress);
            card.addEventListener('touchend', cancelPress);
            card.addEventListener('mouseleave', cancelPress);

            card.addEventListener('click', (e) => {
                if (longPressed) return;

                if (isMultiSelectMode) {
                    if (selectedUrls.has(url)) {
                        selectedUrls.delete(url);
                        card.classList.remove('selected');
                    } else {
                        selectedUrls.add(url);
                        card.classList.add('selected');
                    }
                    updateSelectedText();
                } else {
                    e.preventDefault();
                    e.stopPropagation();
                    activeUrl = url;
                    menu.style.left = `${e.clientX || e.changedTouches[0]?.clientX}px`;
                    menu.style.top = `${e.clientY || e.changedTouches[0]?.clientY}px`;
                    menu.style.display = 'block';
                }
            });

            card.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                activeUrl = url;
                menu.style.left = `${e.clientX}px`;
                menu.style.top = `${e.clientY}px`;
                menu.style.display = 'block';
            });

            grid.appendChild(card);
        });
    }

    function enterMultiSelectMode() {
        isMultiSelectMode = true;
        document.getElementById('media-fetcher-toolbar').style.display = 'flex';
        document.querySelectorAll('.media-fetcher-card').forEach(card => card.classList.add('show-checkbox'));
    }

    function exitMultiSelectMode() {
        isMultiSelectMode = false;
        selectedUrls.clear();
        document.getElementById('media-fetcher-toolbar').style.display = 'none';
        document.querySelectorAll('.media-fetcher-card').forEach(card => card.classList.remove('show-checkbox', 'selected'));
        updateSelectedText();
    }

    document.getElementById('btn-media-cancel-multiselect').addEventListener('click', exitMultiSelectMode);

    document.getElementById('btn-media-select-all').addEventListener('click', () => {
        selectedUrls.clear();
        document.querySelectorAll('.media-fetcher-card').forEach(card => card.classList.add('selected'));
        mediaMap.forEach((_, url) => selectedUrls.add(url));
        updateSelectedText();
    });

    document.getElementById('btn-media-invert-select').addEventListener('click', () => {
        const urlArray = Array.from(mediaMap.keys());
        document.querySelectorAll('.media-fetcher-card').forEach((card, index) => {
            const url = urlArray[index];
            if (selectedUrls.has(url)) {
                selectedUrls.delete(url);
                card.classList.remove('selected');
            } else {
                selectedUrls.add(url);
                card.classList.add('selected');
            }
        });
        updateSelectedText();
    });

    // 纯本地 ZIP 打包
    document.getElementById('btn-media-download-selected').addEventListener('click', async () => {
        if (selectedUrls.size === 0) {
            alert('请先选择要打包的文件');
            return;
        }

        const btnDownload = document.getElementById('btn-media-download-selected');
        const originalText = btnDownload.innerText;
        btnDownload.innerText = '打包中...';
        btnDownload.disabled = true;

        const zip = new MiniZip();
        let successCount = 0;

        const promises = Array.from(selectedUrls).map(async (url, index) => {
            try {
                const response = await fetch(url);
                if (!response.ok) throw new Error();
                const buffer = await response.arrayBuffer();
                let filename = url.substring(url.lastIndexOf('/') + 1).split('?')[0] || `media_${index}`;
                zip.addFile(filename, buffer);
                successCount++;
            } catch (err) {
                console.warn('打包跳过:', url);
            }
        });

        await Promise.all(promises);

        if (successCount > 0) {
            const blob = zip.generateBlob();
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `media_batch_${Date.now()}.zip`;
            a.click();
            URL.revokeObjectURL(a.href);
        } else {
            alert('下载失败，可能是跨域限制或流媒体加密');
        }
        btnDownload.innerText = originalText;
        btnDownload.disabled = false;
    });

    // 快捷菜单交互
    document.getElementById('menu-media-download').addEventListener('click', () => {
        if (!activeUrl) return;
        const filename = activeUrl.substring(activeUrl.lastIndexOf('/') + 1).split('?')[0] || 'media_file';
        if (typeof GM_download !== 'undefined') {
            GM_download({ url: activeUrl, name: filename });
        } else {
            const a = document.createElement('a');
            a.href = activeUrl;
            a.download = filename;
            a.target = '_blank';
            a.click();
        }
        menu.style.display = 'none';
    });

    document.getElementById('menu-media-copy').addEventListener('click', () => {
        if (!activeUrl) return;
        if (typeof GM_setClipboard !== 'undefined') {
            GM_setClipboard(activeUrl);
        } else {
            navigator.clipboard.writeText(activeUrl);
        }
        alert('已复制链接');
        menu.style.display = 'none';
    });

    document.getElementById('menu-media-play').addEventListener('click', () => {
        if (!activeUrl) return;
        menu.style.display = 'none';

        const video = document.getElementById('media-player-video');
        playerModal.style.display = 'flex';

        if (hlsInstance) {
            hlsInstance.destroy();
            hlsInstance = null;
        }

        const info = mediaMap.get(activeUrl);

        if (info && info.format === 'M3U8') {
            loadHlsLibrary().then(() => {
                if (Hls.isSupported()) {
                    hlsInstance = new Hls();
                    hlsInstance.loadSource(activeUrl);
                    hlsInstance.attachMedia(video);
                    hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => video.play());
                } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                    video.src = activeUrl;
                    video.play();
                } else {
                    alert('当前浏览器不支持播放此格式');
                }
            }).catch(() => alert('播放组件加载失败，请检查网络'));
        } else {
            video.src = activeUrl;
            video.play();
        }
    });

    const closePlayer = () => {
        const video = document.getElementById('media-player-video');
        video.pause();
        video.src = '';
        if (hlsInstance) {
            hlsInstance.destroy();
            hlsInstance = null;
        }
        playerModal.style.display = 'none';
    };

    document.getElementById('player-close').addEventListener('click', closePlayer);
    playerModal.addEventListener('click', (e) => { if (e.target === playerModal) closePlayer(); });

    document.addEventListener('click', (e) => { if (!menu.contains(e.target)) menu.style.display = 'none'; });
    document.getElementById('media-fetcher-close').addEventListener('click', () => { modal.style.display = 'none'; });
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });

    // 初始化：hls.js 改为播放时按需加载，不再随页面无条件注入
    window.addEventListener('load', () => {
        scanAndProbeLinks();

        let scanTimer = null;
        const observer = new MutationObserver(() => {
            clearTimeout(scanTimer);
            scanTimer = setTimeout(scanAndProbeLinks, SCAN_DEBOUNCE);
        });
        observer.observe(document.body, { childList: true, subtree: true });
    });
})();
