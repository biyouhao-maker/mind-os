# MIND OS 3.0 — 跨 AI 平台个人智能分析与决策系统（本地优先 MVP）

技术栈：Next.js（App Router）+ React + TypeScript + 浏览器 localStorage / IndexedDB + fflate。

> **当前形态**：本地优先。所有数据默认保存在你自己的浏览器里，可导出 JSON 备份迁移；
> 可选接入你自己的 LLM 接口（BYOK）增强分析；可选接入你自己的 LeanCloud 应用做云端同步
>（显式上传 / 拉取，非自动后台同步，详见下方「云端同步」）。

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
- **设置与隐私**：LLM BYOK 配置（API Key 仅存本机、备份自动剔除）、LeanCloud 云端同步
  （上传自动剔除 API Key、拉取覆盖前二次确认）、JSON 备份 / 恢复
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

## 云端同步（LeanCloud，BYOK 模式）

已实现（第十一阶段）。同步走你自己的 LeanCloud 应用，本项目不提供任何服务端：

1. 到 [leancloud.cn](https://www.leancloud.cn) 注册并创建一个应用，拿到 AppID / AppKey。
2. 在本应用「设置 → 云端同步」面板里填入 AppID / AppKey，并选择服务器地址
  （区域预设：LeanCloud 华北 `https://lncldapi.com`、LeanCloud 国际版 `https://api.lcapp.app`）。
3. 注册 / 登录后即可**上传**（把本地数据推到云端，API Key 自动剔除）或**拉取**
  （云端数据更新于本地时提示覆盖，覆盖前二次确认）。

说明：
- 同步为**显式操作**（手动上传 / 拉取），没有自动后台同步；时间戳按 LWW（最后写入优先）比较。
- 数据存放在你自己的 LeanCloud 应用里（由 LeanCloud 平台托管），本项目本身没有服务器、不经手任何数据。
- 早期 Supabase 方案设计稿保留在 `docs/cloud-design.md`，仅作历史参考。
