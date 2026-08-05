# Web Media & Text Extractor Suite (网页多媒体与文本提取套件)

一个轻量、高效的 Tampermonkey/Violentmonkey 油猴脚本套件，集成了文本、图片与视频的全局提取功能，并支持通过自动化工具链一键打包为单文件加载器。

> **共创声明**
> 本项目由 **catmiao** 与 **Gemini** 共同设计、架构与开发完成。

---

## 📦 模块组成

| 脚本模块 | 文件路径 | 功能说明 | 核心权限 |
| :--- | :--- | :--- | :--- |
| **T 脚本** | `src/t.main.js` | 提取网页中的任何文字段落与文本内容 | `GM_setClipboard` |
| **P 脚本** | `src/p.main.js` | 提取并下载网页中的图片文件 | `GM_download`, `GM_setClipboard` |
| **M 脚本** | `src/m.main.js` | 提取并下载网页中的媒体/视频文件 | `GM_download`, `GM_setClipboard`, `GM_xmlhttpRequest` |

---

## 🛠️ 构建与工具链使用

本项目包含一套纯命令行（Node.js + Python）自动化检测与合并构建工具。

### 1. 语法与权限检测
在更新 `src/` 下的源码后，运行语法及 API 匹配校验：
```bash
node scripts/check.js
