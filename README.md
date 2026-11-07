# MIND OS 3.0 — 跨 AI 平台个人智能分析与决策系统（本地优先 MVP）

技术栈：Next.js（App Router）+ React + TypeScript + 浏览器 localStorage / IndexedDB + fflate。

> **当前形态**：本地优先 MVP。所有数据保存在你自己的浏览器里，可导出 JSON 备份迁移；
> 可选接入你自己的 LLM 接口（BYOK）增强分析。云端同步见 `docs/cloud-design.md`（设计稿，未实现）。

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

## 测试
```bash
npm run test        # 全部六套（parser / analyzer / growth / decision / llm / export）
npm run test:parser # 单独运行
```

## 功能
- **AI 数据中心**：ChatGPT 官方 ZIP / Claude 官方导出（JSON·ZIP）/ Gemini Takeout（实验）导入；
  SHA-256 去重；批次隔离与删除；原始消息与 rawJson 全量保存在 IndexedDB；
  大文件解析在 Web Worker 后台执行（不支持时自动回退主线程）。
- **数字画像**：基础资料、兴趣、优势、技能、思维偏好；画像线索区分事实、行为观察、推测并保留证据；
  本地规则 / LLM（BYOK）双模式分析，候选需用户确认采纳。
- **个人成长**：目标创建与进度调整、成长日志；画像快照与跨时间对比；月 / 季 / 年成长报告。
- **健康管理**：饮食、饮水、睡眠、运动、体重记录（不参与画像推断，不做医疗诊断）。
- **决策助手**：决策日志 + 智能决策参考（历史检索 + 七段结构 + 证据跳转 + 反馈持久化）。
- **设置与隐私**：LLM BYOK 配置（API Key 仅存本机、备份自动剔除）、JSON 备份 / 恢复
  （结构校验 + 计数对比 + 二次确认）、清空本地数据。

## 部署（Vercel / 静态托管）

本项目为纯客户端应用（无服务端 API 路由），可部署到 Vercel 或任何静态托管：

1. 把仓库推到 GitHub（`git push`）。
2. Vercel 控制台 → Add New Project → 选择该仓库 → Framework 自动识别为 Next.js → Deploy。
3. 或使用命令行：`npx vercel`（首次会引导登录）。

注意事项：
- 部署后站点运行在**新的域名**下，浏览器数据（localStorage / IndexedDB）是全新隔离的，
  需要重新导入数据或先在本地导出 JSON 备份再导入。
- LLM BYOK 的 API Key 保存在浏览器 localStorage，同样不会随代码或备份上传。
- 无需配置任何环境变量即可运行（当前版本没有服务端密钥）。

## 云端同步
设计稿见 `docs/cloud-design.md`（Supabase 表结构、RLS、同步策略）——**尚未实现**，
实现前所有数据仅保存在浏览器本地。
