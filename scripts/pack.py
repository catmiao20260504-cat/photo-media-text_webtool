import os
import re
import json
import base64

# 自动定位项目根目录、src 目录和 dist 目录
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(BASE_DIR, 'src')
DIST_DIR = os.path.join(BASE_DIR, 'dist')
OUTPUT_FILE = os.path.join(DIST_DIR, 'bundle.user.js')

FILES = ['t.main.js', 'p.main.js', 'm.main.js']

if not os.path.exists(DIST_DIR):
    os.makedirs(DIST_DIR)

all_matches = set()
all_grants = set()
script_payloads = []

print("正在解析 src/ 目录下的脚本...")

for file_name in FILES:
    file_path = os.path.join(SRC_DIR, file_name)
    if not os.path.exists(file_path):
        print(f"⚠️ 警告: 文件 {file_path} 不存在，跳过")
        continue

    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()

    # 提取 @match
    matches = re.findall(r'//\s*@(match|include)\s+(.+)', content)
    for _, m in matches:
        all_matches.add(m.strip())

    # 提取 @grant
    grants = re.findall(r'//\s*@grant\s+(.+)', content)
    for g in grants:
        g_clean = g.strip()
        if g_clean and g_clean != 'none':
            all_grants.add(g_clean)

    # 剔除元数据头
    clean_code = re.sub(r'//\s*==UserScript==[\s\S]*?//\s*==/UserScript==', '', content)
    b64_code = base64.b64encode(clean_code.encode('utf-8')).decode('utf-8')

    script_payloads.append({
        'name': file_name,
        'b64': b64_code
    })

all_grants.add('unsafeWindow')

header_lines = [
    "// ==UserScript==",
    "// @name         Web Media & Text Extractor Suite",
    "// @namespace    http://tampermonkey.net/",
    "// @version      1.0.0",
    "// @description  全能网页元素提取套件 (T:文本 / P:图片 / M:视频)",
    "// @author       catmiao & Gemini",
    "// @run-at       document-end"
]

for m in sorted(all_matches):
    header_lines.append(f"// @match        {m}")
if not all_matches:
    header_lines.append("// @match        *://*/*")

for g in sorted(all_grants):
    header_lines.append(f"// @grant        {g}")

header_lines.append("// ==/UserScript==\n")

user_script_header = "\n".join(header_lines)
payload_json = json.dumps(script_payloads, ensure_ascii=False)

loader_body = f"""
(function() {{
    'use strict';

    function b64ToUtf8(str) {{
        const binary = atob(str);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {{
            bytes[i] = binary.charCodeAt(i);
        }}
        return new TextDecoder('utf-8').decode(bytes);
    }}

    const scripts = {payload_json};

    scripts.forEach(item => {{
        try {{
            const rawCode = b64ToUtf8(item.b64);
            const runner = new Function(
                'GM', 'GM_info', 'unsafeWindow', 'GM_download', 'GM_setClipboard', 'GM_xmlhttpRequest',
                `try {{ ${{rawCode}} }} catch(err) {{ console.error('[Bundle Error] ' + item.name + ':', err); }}`
            );
            runner(
                typeof GM !== 'undefined' ? GM : {{}},
                typeof GM_info !== 'undefined' ? GM_info : {{}},
                typeof unsafeWindow !== 'undefined' ? unsafeWindow : window,
                typeof GM_download !== 'undefined' ? GM_download : undefined,
                typeof GM_setClipboard !== 'undefined' ? GM_setClipboard : undefined,
                typeof GM_xmlhttpRequest !== 'undefined' ? GM_xmlhttpRequest : undefined
            );
            console.log('[Bundle Loader] 已载入并释放脚本: ' + item.name);
        }} catch(e) {{
            console.error('[Bundle Loader] 解析脚本 [' + item.name + '] 失败:', e);
        }}
    }});
}})();
"""

with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
    f.write(user_script_header + loader_body)

print(f"🎉 打包成功！产物放置于: {OUTPUT_FILE}")
