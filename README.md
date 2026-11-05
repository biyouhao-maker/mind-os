# MIND OS 2.0

本地运行的个人智能操作系统 MVP。技术栈：Next.js + React + TypeScript + 浏览器 localStorage。

## 环境要求
Node.js 20.9 或更高版本，npm。

## 安装和启动
```bash
npm install
npm run dev
```
浏览器打开 http://localhost:3000

## 生产构建
```bash
npm run build
npm start
```

## 功能
- Dashboard：画像、目标、成长记录与 AI 数据概览。
- 数字画像：基础资料、兴趣、优势、技能、思维偏好；画像线索可区分事实、观察、推测，并保留证据。
- 个人成长：创建目标、调整进度、记录成长日志。
- AI 数据中心：平台接入状态、JSON/JSONL 文件本地索引预览。
- 健康管理：饮食、饮水、睡眠、运动、体重记录。
- 决策助手：记录问题、备选方案、收益、风险、最终选择和复盘。
- 设置与隐私：导出 JSON 备份、恢复备份、清空本地数据。

## 数据说明
所有数据保存在当前浏览器 localStorage，不会自动上传。清理浏览器网站数据或更换设备可能导致数据不可用，请定期导出备份。当前版本不包含登录、多设备同步、云端数据库、AI 模型推理或官方 OAuth。AI 平台状态仅为手动记录；文件导入是通用预览解析，不保证识别所有平台格式。请勿导入不希望保存在当前浏览器中的敏感数据。


## MIND OS 3.0 Alpha 1 — ChatGPT archive import

This alpha adds browser-local import of a ChatGPT official export ZIP containing
`conversations.json`. It stores conversation indexes in the existing local app
data and complete message records in IndexedDB (`mind-os-chat-archive`).

Each stored message includes role, author name, timestamp, source message ID,
parent node ID, extracted text, and the original message JSON. ZIP files are
hashed with SHA-256 to prevent importing the exact same archive twice.

### Install and run

```bash
npm install
npm run dev
```

Open `http://localhost:3000`, then go to **AI 数据中心** and choose the official
ChatGPT export ZIP.

### Important limits

- This is a local-browser alpha, not cloud sync and not an official ChatGPT API connection.
- Only ChatGPT ZIP archives containing `conversations.json` are implemented in this phase.
- ZIP files over 250 MB are rejected to reduce browser memory risk.
- IndexedDB data can be removed if browser site data is cleared. Keep the original export ZIP and regular backups.
- The parser retains raw message JSON, but non-text attachments are not yet downloaded or rendered as media.
- Existing 2.0 user data remains in the same localStorage key; no automatic migration or deletion is performed.
