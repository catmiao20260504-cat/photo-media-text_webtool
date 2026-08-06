// ==UserScript==
// @name         网页 HTML 块级文本提取与下载器
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  按照 HTML 标签与块级节点自动辨识并提取网页中的文本块，提供文本搜索过滤、前20字预览、复制与txt单段/批量下载。
// @author       catmiao20260504
// @match        *://*/*
// @grant        GM_setClipboard
// ==/UserScript==

(function() {
    'use strict';

    let textList = []; // Array of { id, tagName, fullText, preview }
    let selectedIds = new Set();
    let isMultiSelectMode = false;
    let currentKeyword = '';

    // 扫描页面中包含有效文本的 HTML 节点元素
    function scanHtmlTextNodes() {
        const targetTags = ['P', 'ARTICLE', 'SECTION', 'DIV', 'LI', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TD', 'TH'];
        const elements = document.querySelectorAll(targetTags.join(','));
        const set = new Set();
        const results = [];

        elements.forEach(el => {
            if (el.closest('script, style, noscript, svg, nav, footer, header, #text-fetcher-modal, #media-fetcher-modal')) return;

            const hasChildTarget = Array.from(el.children).some(child => targetTags.includes(child.tagName));
            if (hasChildTarget) return;

            const txt = el.innerText ? el.innerText.trim() : '';
            if (txt.length >= 5 && !set.has(txt)) {
                set.add(txt);
                results.push({
                    id: results.length,
                    tagName: el.tagName.toLowerCase(),
                    fullText: txt,
                    preview: txt.slice(0, 20) + (txt.length > 20 ? '...' : '')
                });
            }
        });

        textList = results;
        updateBadge();
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

    // 样式注入：#text-fetcher-btn 样式完全照抄源脚本（位置与颜色 1:1 对齐）
    const style = document.createElement('style');
    style.textContent = `
        #text-fetcher-btn {
            position: fixed; bottom: 140px; left: 20px; width: 42px; height: 42px;
            background: #1d3557; color: #fff; font-weight: bold; font-size: 22px;
            display: flex; align-items: center; justify-content: center;
            border-radius: 8px; cursor: move; z-index: 999999;
            box-shadow: 0 4px 10px rgba(0,0,0,0.3); user-select: none;
            font-family: sans-serif; touch-action: none;
        }
        #text-fetcher-badge {
            position: absolute; top: -6px; right: -6px; background: #e63946;
            color: #fff; font-size: 11px; padding: 2px 6px; border-radius: 10px;
            font-weight: normal; font-family: sans-serif; transition: transform 0.2s;
        }
        #text-fetcher-badge.pulse { transform: scale(1.3); }
        #text-fetcher-modal {
            position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
            background: rgba(0,0,0,0.6); z-index: 9999999; display: none;
            align-items: center; justify-content: center; backdrop-filter: blur(4px);
        }
        #text-fetcher-content {
            background: #fff; width: 85vw; height: 85vh; border-radius: 12px;
            display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 8px 32px rgba(0,0,0,0.3);
        }
        .text-fetcher-header {
            padding: 14px 16px; background: #f8f9fa; border-bottom: 1px solid #eee;
            display: flex; justify-content: space-between; align-items: center;
            font-weight: bold; font-family: sans-serif; color: #333; font-size: 14px;
        }
        .text-search-bar {
            padding: 8px 16px; background: #f8f9fa; border-bottom: 1px solid #eee;
            display: flex; gap: 8px; align-items: center;
        }
        .text-search-input {
            width: 100%; padding: 6px 10px; border: 1px solid #ccc; border-radius: 4px;
            font-size: 13px; outline: none; box-sizing: border-box;
        }
        .text-search-input:focus { border-color: #1d3557; }
        .text-fetcher-toolbar {
            padding: 10px 16px; background: #fff; border-bottom: 1px solid #eee;
            display: none; gap: 10px; align-items: center; font-family: sans-serif; font-size: 13px;
        }
        .text-fetcher-btn-action {
            background: #1d3557; color: #fff; border: none; padding: 6px 12px;
            border-radius: 4px; cursor: pointer; font-size: 12px;
        }
        .text-fetcher-btn-action:hover { background: #457b9d; }
        .text-fetcher-grid {
            padding: 16px; overflow-y: auto; display: grid;
            grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; flex: 1;
        }
        .text-fetcher-card {
            width: 100%; height: 120px; border: 1px solid #ddd; border-radius: 6px;
            overflow: hidden; cursor: pointer; position: relative; background: #f8f9fa;
            user-select: none; display: flex; flex-direction: column;
            padding: 10px; box-sizing: border-box; justify-content: space-between;
        }
        .text-fetcher-card.selected { border: 2px solid #e63946; background: #fff5f2; }
        .text-fetcher-card .checkbox {
            position: absolute; top: 6px; left: 6px; width: 18px; height: 18px;
            border: 2px solid #ccc; border-radius: 3px; background: #fff;
            display: none; align-items: center; justify-content: center; color: #fff; font-size: 12px;
            z-index: 2;
        }
        .text-fetcher-card.show-checkbox .checkbox { display: flex; }
        .text-fetcher-card.selected .checkbox { background: #e63946; border-color: #e63946; }
        
        .text-card-actions {
            position: absolute; top: 6px; right: 6px; display: flex; gap: 4px; z-index: 3;
        }
        .text-card-btn {
            background: rgba(255,255,255,0.9); border: 1px solid #ccc; border-radius: 4px;
            width: 24px; height: 24px; display: flex; align-items: center; justify-content: center;
            font-size: 12px; cursor: pointer; transition: all 0.2s;
        }
        .text-card-btn:hover { background: #1d3557; color: #fff; border-color: #1d3557; }

        .text-preview-body {
            font-size: 13px; color: #333; line-height: 1.4;
            word-break: break-all; margin-top: 18px; overflow: hidden;
            text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
        }
        .text-card-footer {
            font-size: 10px; color: #888; display: flex; justify-content: space-between; align-items: center;
        }
        .tag-badge {
            background: #e0e1dd; color: #415a77; padding: 1px 4px; border-radius: 3px; font-weight: bold; text-transform: uppercase;
        }
    `;
    document.head.appendChild(style);

    // 悬浮按钮 (T)
    const btn = document.createElement('div');
    btn.id = 'text-fetcher-btn';
    btn.innerText = 'T';
    const badge = document.createElement('div');
    badge.id = 'text-fetcher-badge';
    badge.innerText = '0';
    btn.appendChild(badge);
    document.body.appendChild(btn);

    // 弹窗结构（增加搜索栏）
    const modal = document.createElement('div');
    modal.id = 'text-fetcher-modal';
    modal.innerHTML = `
        <div id="text-fetcher-content">
            <div class="text-fetcher-header">
                <span>网页 HTML 文本提取器 (提取项: <span id="text-fetcher-modal-count">0</span>)</span>
                <button id="text-fetcher-close" style="border:none;background:none;font-size:20px;cursor:pointer;">&times;</button>
            </div>
            <div class="text-search-bar">
                <input type="text" id="text-search-input" class="text-search-input" placeholder="🔍 搜索提取的文本内容..." />
            </div>
            <div class="text-fetcher-toolbar" id="text-fetcher-toolbar">
                <button class="text-fetcher-btn-action" id="btn-text-select-all">全选</button>
                <button class="text-fetcher-btn-action" id="btn-text-invert-select">反选</button>
                <button class="text-fetcher-btn-action" id="btn-text-download-selected" style="background:#e63946;">打包导出选中文本</button>
                <button class="text-fetcher-btn-action" id="btn-text-cancel-multiselect" style="background:#666;">退出多选</button>
                <span id="text-selected-count-text" style="color:#666; margin-left:auto;">已选 0 项</span>
            </div>
            <div class="text-fetcher-grid" id="text-fetcher-grid"></div>
        </div>
    `;
    document.body.appendChild(modal);

    function updateBadge() {
        badge.innerText = textList.length;
        document.getElementById('text-fetcher-modal-count').innerText = textList.length;
        badge.classList.add('pulse');
        setTimeout(() => badge.classList.remove('pulse'), 200);
    }

    function updateSelectedText() {
        document.getElementById('text-selected-count-text').innerText = `已选 ${selectedIds.size} 项`;
    }

    // 拖拽控制
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
        scanHtmlTextNodes();
        currentKeyword = '';
        document.getElementById('text-search-input').value = '';
        renderGrid();
        modal.style.display = 'flex';
    });

    // 下载单段文本 txt
    function downloadTextFile(filename, text) {
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        URL.revokeObjectURL(a.href);
    }

    // 复制单段文本
    function copyToClipboard(text) {
        if (typeof GM_setClipboard !== 'undefined') {
            GM_setClipboard(text);
        } else {
            navigator.clipboard.writeText(text);
        }
        alert('文本内容已复制到剪贴板！');
    }

    // 搜索实时过滤绑定
    document.getElementById('text-search-input').addEventListener('input', (e) => {
        currentKeyword = e.target.value.toLowerCase().trim();
        renderGrid(currentKeyword);
    });

    // 渲染卡片 (支持搜索关键词过滤)
    function renderGrid(keyword = '') {
        const grid = document.getElementById('text-fetcher-grid');
        grid.innerHTML = '';
        selectedIds.clear();
        isMultiSelectMode = false;
        document.getElementById('text-fetcher-toolbar').style.display = 'none';
        updateSelectedText();

        const filteredList = keyword 
            ? textList.filter(item => item.fullText.toLowerCase().includes(keyword))
            : textList;

        filteredList.forEach(item => {
            const card = document.createElement('div');
            card.className = 'text-fetcher-card';

            card.innerHTML = `
                <div class="checkbox">✓</div>
                <div class="text-card-actions">
                    <button class="text-card-btn btn-copy" title="复制文本">📋</button>
                    <button class="text-card-btn btn-dl" title="下载文本">💾</button>
                </div>
                <div class="text-preview-body">${item.preview}</div>
                <div class="text-card-footer">
                    <span class="tag-badge">&lt;${item.tagName}&gt;</span>
                    <span>字数: ${item.fullText.length}</span>
                </div>
            `;

            // 复制与下载按钮
            const copyBtn = card.querySelector('.btn-copy');
            copyBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                copyToClipboard(item.fullText);
            });

            const dlBtn = card.querySelector('.btn-dl');
            dlBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                downloadTextFile(`text_block_${item.id + 1}.txt`, item.fullText);
            });

            // 长按多选逻辑
            let pressTimer = null;
            let longPressed = false;

            const startPress = () => {
                longPressed = false;
                pressTimer = setTimeout(() => {
                    longPressed = true;
                    enterMultiSelectMode();
                    selectedIds.add(item.id);
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

            card.addEventListener('click', () => {
                if (longPressed) return;

                if (isMultiSelectMode) {
                    if (selectedIds.has(item.id)) {
                        selectedIds.delete(item.id);
                        card.classList.remove('selected');
                    } else {
                        selectedIds.add(item.id);
                        card.classList.add('selected');
                    }
                    updateSelectedText();
                }
            });

            grid.appendChild(card);
        });
    }

    function enterMultiSelectMode() {
        isMultiSelectMode = true;
        document.getElementById('text-fetcher-toolbar').style.display = 'flex';
        document.querySelectorAll('.text-fetcher-card').forEach(card => card.classList.add('show-checkbox'));
    }

    function exitMultiSelectMode() {
        isMultiSelectMode = false;
        selectedIds.clear();
        document.getElementById('text-fetcher-toolbar').style.display = 'none';
        document.querySelectorAll('.text-fetcher-card').forEach(card => card.classList.remove('show-checkbox', 'selected'));
        updateSelectedText();
    }

    document.getElementById('btn-text-cancel-multiselect').addEventListener('click', exitMultiSelectMode);

    document.getElementById('btn-text-select-all').addEventListener('click', () => {
        selectedIds.clear();
        document.querySelectorAll('.text-fetcher-card').forEach(card => card.classList.add('selected'));
        
        const activeList = currentKeyword 
            ? textList.filter(item => item.fullText.toLowerCase().includes(currentKeyword))
            : textList;

        activeList.forEach(item => selectedIds.add(item.id));
        updateSelectedText();
    });

    document.getElementById('btn-text-invert-select').addEventListener('click', () => {
        const activeList = currentKeyword 
            ? textList.filter(item => item.fullText.toLowerCase().includes(currentKeyword))
            : textList;

        document.querySelectorAll('.text-fetcher-card').forEach((card, index) => {
            const item = activeList[index];
            if (selectedIds.has(item.id)) {
                selectedIds.delete(item.id);
                card.classList.remove('selected');
            } else {
                selectedIds.add(item.id);
                card.classList.add('selected');
            }
        });
        updateSelectedText();
    });

    // 多选批量 Zip 下载
    document.getElementById('btn-text-download-selected').addEventListener('click', () => {
        if (selectedIds.size === 0) {
            alert('请先勾选需要导出的文本！');
            return;
        }

        const zip = new MiniZip();
        const encoder = new TextEncoder();

        let mergedText = '';
        selectedIds.forEach(id => {
            const item = textList.find(t => t.id === id);
            if (item) {
                zip.addFile(`text_block_${item.id + 1}_${item.tagName}.txt`, encoder.encode(item.fullText));
                mergedText += `--- [<${item.tagName}> Node ${item.id + 1}] ---\n${item.fullText}\n\n`;
            }
        });

        zip.addFile(`_all_selected_text_blocks.txt`, encoder.encode(mergedText));

        const blob = zip.generateBlob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `extracted_text_blocks_${Date.now()}.zip`;
        a.click();
        URL.revokeObjectURL(a.href);
    });

    document.getElementById('text-fetcher-close').addEventListener('click', () => { modal.style.display = 'none'; });
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });

    // 初始化监听
    window.addEventListener('load', () => {
        scanHtmlTextNodes();
        const observer = new MutationObserver(() => scanHtmlTextNodes());
        observer.observe(document.body, { childList: true, subtree: true });
    });
})();
