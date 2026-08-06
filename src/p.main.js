// ==UserScript==
// @name         网页图片提取与下载器
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  支持全端拖拽、双击隐藏、DOM动态监听。单击弹出快捷菜单，长按触发多选与纯本地ZIP打包下载。
// @author       catmiao20260504
// @match        *://*/*
// @grant        GM_download
// @grant        GM_setClipboard
// ==/UserScript==

(function() {
    'use strict';

    let imageUrls = new Set();
    let observerTimer = null;
    let selectedUrls = new Set();
    let isMultiSelectMode = false;

    // 极简纯本地 Zip 打包算法 (无需加载任何外部 JSZip / FileSaver)
    class MiniZip {
        constructor() {
            this.files = [];
        }
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

                // Local file header
                let header = new Uint8Array(30 + nameBytes.length);
                let view = new DataView(header.buffer);
                view.setUint32(0, 0x04034b50, true); // Local header sig
                view.setUint16(4, 10, true);         // Version needed
                view.setUint16(6, 0, true);          // General purpose bit flag
                view.setUint16(8, 0, true);          // Compression method (0 = store)
                view.setUint32(14, crc, true);       // CRC32
                view.setUint32(18, size, true);      // Compressed size
                view.setUint32(22, size, true);      // Uncompressed size
                view.setUint16(26, nameBytes.length, true); // File name length
                view.setUint16(28, 0, true);         // Extra field length
                header.set(nameBytes, 30);

                parts.push(header);
                parts.push(file.data);

                // Central directory header
                let cdHeader = new Uint8Array(46 + nameBytes.length);
                let cdView = new DataView(cdHeader.buffer);
                cdView.setUint32(0, 0x02014b50, true); // Central directory sig
                cdView.setUint16(4, 10, true);
                cdView.setUint16(6, 10, true);
                cdView.setUint32(16, crc, true);
                cdView.setUint32(20, size, true);
                cdView.setUint32(24, size, true);
                cdView.setUint16(28, nameBytes.length, true);
                cdView.setUint32(42, offset, true); // Local header offset
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

            // End of central directory record
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

    // 1. 扫描页面图片
    function collectImages() {
        const oldSize = imageUrls.size;

        document.querySelectorAll('img').forEach(img => {
            const src = img.currentSrc || img.src || img.getAttribute('data-src') || img.getAttribute('data-original');
            if (src && !src.startsWith('data:')) {
                try { imageUrls.add(new URL(src, document.baseURI).href); } catch(e){}
            }
        });

        document.querySelectorAll('source').forEach(source => {
            const srcset = source.getAttribute('srcset');
            if (srcset) {
                srcset.split(',').forEach(item => {
                    const url = item.trim().split(' ')[0];
                    if (url && !url.startsWith('data:')) {
                        try { imageUrls.add(new URL(url, document.baseURI).href); } catch(e){}
                    }
                });
            }
        });

        document.querySelectorAll('*').forEach(el => {
            const bg = window.getComputedStyle(el).backgroundImage;
            if (bg && bg !== 'none' && bg.includes('url(')) {
                const match = bg.match(/url\((['"]?)(.*?)\1\)/);
                if (match && match[2] && !match[2].startsWith('data:')) {
                    try { imageUrls.add(new URL(match[2], document.baseURI).href); } catch(e){}
                }
            }
        });

        if (imageUrls.size !== oldSize) {
            updateBadge();
        }
    }

    function debounceCollect() {
        if (observerTimer) clearTimeout(observerTimer);
        observerTimer = setTimeout(collectImages, 500);
    }

    // 2. 注入样式
    const style = document.createElement('style');
    style.textContent = `
        #img-fetcher-btn {
            position: fixed; bottom: 20px; left: 20px; width: 42px; height: 42px;
            background: #2b2d42; color: #fff; font-weight: bold; font-size: 22px;
            display: flex; align-items: center; justify-content: center;
            border-radius: 8px; cursor: move; z-index: 999999;
            box-shadow: 0 4px 10px rgba(0,0,0,0.3); user-select: none;
            font-family: sans-serif; touch-action: none;
        }
        #img-fetcher-badge {
            position: absolute; top: -6px; right: -6px; background: #ef233c;
            color: #fff; font-size: 11px; padding: 2px 6px; border-radius: 10px;
            font-weight: normal; font-family: sans-serif; transition: transform 0.2s;
        }
        #img-fetcher-badge.pulse { transform: scale(1.3); }
        #img-fetcher-modal {
            position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
            background: rgba(0,0,0,0.6); z-index: 9999999; display: none;
            align-items: center; justify-content: center; backdrop-filter: blur(4px);
        }
        #img-fetcher-content {
            background: #fff; width: 85vw; height: 85vh; border-radius: 12px;
            display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 8px 32px rgba(0,0,0,0.3);
        }
        .img-fetcher-header {
            padding: 14px 16px; background: #f8f9fa; border-bottom: 1px solid #eee;
            display: flex; justify-content: space-between; align-items: center;
            font-weight: bold; font-family: sans-serif; color: #333; font-size: 14px;
        }
        .img-fetcher-toolbar {
            padding: 10px 16px; background: #fff; border-bottom: 1px solid #eee;
            display: none; gap: 10px; align-items: center; font-family: sans-serif; font-size: 13px;
        }
        .img-fetcher-btn-action {
            background: #2b2d42; color: #fff; border: none; padding: 6px 12px;
            border-radius: 4px; cursor: pointer; font-size: 12px;
        }
        .img-fetcher-btn-action:hover { background: #404363; }
        .img-fetcher-grid {
            padding: 16px; overflow-y: auto; display: grid;
            grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 12px; flex: 1;
        }
        .img-fetcher-card {
            width: 100%; height: 120px; border: 1px solid #ddd; border-radius: 6px;
            overflow: hidden; cursor: pointer; position: relative; background: #f0f0f0;
            user-select: none;
        }
        .img-fetcher-card img {
            width: 100%; height: 100%; object-fit: cover; transition: transform 0.2s;
        }
        .img-fetcher-card.selected { border: 3px solid #ef233c; }
        .img-fetcher-card .checkbox {
            position: absolute; top: 6px; left: 6px; width: 18px; height: 18px;
            border: 2px solid #fff; border-radius: 3px; background: rgba(0,0,0,0.3);
            display: none; align-items: center; justify-content: center; color: #fff; font-size: 12px;
        }
        .img-fetcher-card.show-checkbox .checkbox { display: flex; }
        .img-fetcher-card.selected .checkbox { background: #ef233c; }
        #img-fetcher-menu {
            position: fixed; background: #fff; border: 1px solid #ddd;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15); border-radius: 6px;
            display: none; z-index: 10000000; padding: 4px 0; font-family: sans-serif;
        }
        .img-fetcher-menu-item {
            padding: 8px 16px; font-size: 14px; cursor: pointer; color: #333;
        }
        .img-fetcher-menu-item:hover { background: #f0f0f0; }
    `;
    document.head.appendChild(style);

    // 创建悬浮 P 图标
    const btn = document.createElement('div');
    btn.id = 'img-fetcher-btn';
    btn.innerText = 'P';
    const badge = document.createElement('div');
    badge.id = 'img-fetcher-badge';
    badge.innerText = '0';
    btn.appendChild(badge);
    document.body.appendChild(btn);

    // 创建弹窗
    const modal = document.createElement('div');
    modal.id = 'img-fetcher-modal';
    modal.innerHTML = `
        <div id="img-fetcher-content">
            <div class="img-fetcher-header">
                <span>网页提取图片 (<span id="img-fetcher-modal-count">0</span>)</span>
                <button id="img-fetcher-close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
            </div>
            <div class="img-fetcher-toolbar" id="img-fetcher-toolbar">
                <button class="img-fetcher-btn-action" id="btn-select-all">全选</button>
                <button class="img-fetcher-btn-action" id="btn-invert-select">反选</button>
                <button class="img-fetcher-btn-action" id="btn-download-selected" style="background:#ef233c;">打包下载选中项</button>
                <button class="img-fetcher-btn-action" id="btn-cancel-multiselect" style="background:#666;">退出多选</button>
                <span id="selected-count-text" style="color:#666; margin-left:auto;">已选 0 项</span>
            </div>
            <div class="img-fetcher-grid" id="img-fetcher-grid"></div>
        </div>
    `;
    document.body.appendChild(modal);

    // 快捷菜单
    const menu = document.createElement('div');
    menu.id = 'img-fetcher-menu';
    menu.innerHTML = `
        <div class="img-fetcher-menu-item" id="menu-download">a. 下载图片</div>
        <div class="img-fetcher-menu-item" id="menu-copy">b. 复制链接</div>
    `;
    document.body.appendChild(menu);

    let activeUrl = '';

    function updateBadge() {
        badge.innerText = imageUrls.size;
        document.getElementById('img-fetcher-modal-count').innerText = imageUrls.size;
        badge.classList.add('pulse');
        setTimeout(() => badge.classList.remove('pulse'), 200);
    }

    function updateSelectedText() {
        document.getElementById('selected-count-text').innerText = `已选 ${selectedUrls.size} 项`;
    }

    // 3. 全端拖拽与双击隐藏
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
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
            isDragging = true;
        }
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
        collectImages();
        renderGrid();
        modal.style.display = 'flex';
    });

    // 4. 卡片长按触发多选，单击触发对话框逻辑
    function renderGrid() {
        const grid = document.getElementById('img-fetcher-grid');
        grid.innerHTML = '';
        selectedUrls.clear();
        isMultiSelectMode = false;
        document.getElementById('img-fetcher-toolbar').style.display = 'none';
        updateSelectedText();

        imageUrls.forEach(url => {
            const card = document.createElement('div');
            card.className = 'img-fetcher-card';
            
            const img = document.createElement('img');
            img.src = url;
            img.loading = 'lazy';
            card.appendChild(img);

            const checkbox = document.createElement('div');
            checkbox.className = 'checkbox';
            checkbox.innerHTML = '✓';
            card.appendChild(checkbox);

            let pressTimer = null;
            let longPressed = false;

            // 触摸/鼠标按下启动长按定时器
            const startPress = (e) => {
                longPressed = false;
                pressTimer = setTimeout(() => {
                    longPressed = true;
                    enterMultiSelectMode();
                    // 默认长按将当前卡片勾选
                    selectedUrls.add(url);
                    card.classList.add('selected');
                    updateSelectedText();
                }, 500); // 长按 500ms
            };

            const cancelPress = () => {
                if (pressTimer) clearTimeout(pressTimer);
            };

            card.addEventListener('mousedown', startPress);
            card.addEventListener('touchstart', startPress);
            card.addEventListener('mouseup', cancelPress);
            card.addEventListener('touchend', cancelPress);
            card.addEventListener('mouseleave', cancelPress);

            // 单击卡片处理
            card.addEventListener('click', (e) => {
                if (longPressed) return; // 长按不触发单击

                if (isMultiSelectMode) {
                    // 多选模式下：单击切换选中
                    if (selectedUrls.has(url)) {
                        selectedUrls.delete(url);
                        card.classList.remove('selected');
                    } else {
                        selectedUrls.add(url);
                        card.classList.add('selected');
                    }
                    updateSelectedText();
                } else {
                    // 非多选模式下：单击弹出 a.下载 / b.复制链接 菜单
                    e.preventDefault();
                    e.stopPropagation();
                    activeUrl = url;
                    menu.style.left = `${e.clientX || e.changedTouches[0]?.clientX}px`;
                    menu.style.top = `${e.clientY || e.changedTouches[0]?.clientY}px`;
                    menu.style.display = 'block';
                }
            });

            // 右键菜单默认弹出操作
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

    // 进入多选模式
    function enterMultiSelectMode() {
        isMultiSelectMode = true;
        document.getElementById('img-fetcher-toolbar').style.display = 'flex';
        document.querySelectorAll('.img-fetcher-card').forEach(card => {
            card.classList.add('show-checkbox');
        });
    }

    // 退出多选模式
    function exitMultiSelectMode() {
        isMultiSelectMode = false;
        selectedUrls.clear();
        document.getElementById('img-fetcher-toolbar').style.display = 'none';
        document.querySelectorAll('.img-fetcher-card').forEach(card => {
            card.classList.remove('show-checkbox', 'selected');
        });
        updateSelectedText();
    }

    document.getElementById('btn-cancel-multiselect').addEventListener('click', exitMultiSelectMode);

    // 全选 & 反选
    document.getElementById('btn-select-all').addEventListener('click', () => {
        selectedUrls.clear();
        document.querySelectorAll('.img-fetcher-card').forEach(card => {
            card.classList.add('selected');
        });
        imageUrls.forEach(url => selectedUrls.add(url));
        updateSelectedText();
    });

    document.getElementById('btn-invert-select').addEventListener('click', () => {
        const urlArray = Array.from(imageUrls);
        document.querySelectorAll('.img-fetcher-card').forEach((card, index) => {
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

    // 纯本地打包 ZIP 下载
    document.getElementById('btn-download-selected').addEventListener('click', async () => {
        if (selectedUrls.size === 0) {
            alert('请先勾选需要打包下载的图片！');
            return;
        }

        const btnDownload = document.getElementById('btn-download-selected');
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
                let filename = url.substring(url.lastIndexOf('/') + 1).split('?')[0] || `image_${index}.png`;
                if (!filename.includes('.')) filename += '.png';
                zip.addFile(filename, buffer);
                successCount++;
            } catch (err) {
                console.warn('打包跳过图片:', url);
            }
        });

        await Promise.all(promises);

        if (successCount > 0) {
            const blob = zip.generateBlob();
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `images_batch_${Date.now()}.zip`;
            a.click();
            URL.revokeObjectURL(a.href);
            btnDownload.innerText = originalText;
            btnDownload.disabled = false;
        } else {
            alert('选中图片全部下载失败（可能受跨域 CORS 保护限制）。');
            btnDownload.innerText = originalText;
            btnDownload.disabled = false;
        }
    });

    // 快捷菜单：下载 & 复制
    document.getElementById('menu-download').addEventListener('click', () => {
        if (!activeUrl) return;
        const filename = activeUrl.substring(activeUrl.lastIndexOf('/') + 1).split('?')[0] || 'image.png';
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

    document.getElementById('menu-copy').addEventListener('click', () => {
        if (!activeUrl) return;
        if (typeof GM_setClipboard !== 'undefined') {
            GM_setClipboard(activeUrl);
        } else {
            navigator.clipboard.writeText(activeUrl);
        }
        alert('链接已复制到剪贴板！');
        menu.style.display = 'none';
    });

    // 隐藏和关闭逻辑
    document.addEventListener('click', (e) => {
        if (!menu.contains(e.target)) menu.style.display = 'none';
    });
    document.getElementById('img-fetcher-close').addEventListener('click', () => {
        modal.style.display = 'none';
    });
    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.style.display = 'none';
    });

    // 5. 初始化与 MutationObserver 动态监听
    window.addEventListener('load', () => {
        collectImages();

        const observer = new MutationObserver((mutations) => {
            let hasNewNodes = false;
            for (let mutation of mutations) {
                if (mutation.addedNodes.length > 0) {
                    hasNewNodes = true;
                    break;
                }
            }
            if (hasNewNodes) debounceCollect();
        });

        observer.observe(document.body, { childList: true, subtree: true });
    });
})();
