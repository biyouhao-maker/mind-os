# MIND OS 云端同步设计（设计稿 · 尚未实现）

> 本文档是 Supabase 云端同步的**架构设计稿**。截至当前版本（3.0-alpha.2），MIND OS 所有数据
> 仅保存在浏览器本地（localStorage + IndexedDB），未接入任何云端。本文描述的目标形态
> **尚未实现**，实现前请以本文为蓝图分阶段开发。

## 1. 目标

- 同一账号在多个浏览器 / 设备上使用 MIND OS，数据自动同步。
- 保持「原始数据归用户所有」：用户可随时导出全部数据并撤销云端授权。
- 健康数据在云端单独授权、单独控制（PRD 3.3）。

## 2. 技术选型

| 层 | 选型 | 理由 |
| --- | --- | --- |
| 认证 | Supabase Auth（Email + OAuth） | 官方授权接入，符合平台接入原则 |
| 结构化数据 | Supabase Postgres（localStorage 镜像） | 画像 / 索引 / 设置等小体量 JSON |
| 大体量原始消息 | Supabase Storage（JSON Lines 文件，按批次存储） | 3,106 条消息 ≈ 14MB，行存不合适 |
| 端到端加密（可选后期） | 用户密钥 + WebCrypto AES-GCM | 威胁模型：防服务商读取（会显著增加复杂度，后期评估） |

## 3. 数据表设计（草案）

```sql
-- 用户资料与设置镜像（localStorage mind-os-data-v2 的 JSON 快照）
create table app_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null,                -- profile/insights/goals/…（不含 IndexedDB 消息）
  updated_at timestamptz not null default now()
);

-- 导入批次索引（IndexedDB imports 的镜像）
create table import_batches (
  id text primary key,                -- chatgpt-<hash20> 等
  user_id uuid not null references auth.users(id) on delete cascade,
  file_hash text not null,
  file_name text not null,
  platform text not null,
  imported_at timestamptz not null,
  conversation_count int not null,
  message_count int not null,
  unique (user_id, file_hash)
);

-- 原始消息存 Storage：每批次一个 JSONL 文件
-- 路径：{user_id}/{import_id}.jsonl
alter policy … -- 见下 RLS

-- 行级安全：用户只能读写自己的数据
alter table app_state enable row level security;
alter table import_batches enable row level security;
create policy "own state" on app_state for all using (auth.uid() = user_id);
create policy "own batches" on import_batches for all using (auth.uid() = user_id);
```

## 4. 同步策略（草案）

1. **本地优先**：所有写入先落本地（现状不变），后台节流上传（防抖 10s）。
2. **冲突策略**：`updated_at` 最新者胜（last-write-wins）；IndexedDB 消息按批次幂等
   （`saveArchive` 的 put 天然幂等），重复上传无副作用。
3. **首次登录**：云端无数据 → 上传本地；云端有数据 → 询问用户「拉取云端」或「上传本地」，
   并提示先导出备份（沿用 2.1 恢复确认交互）。
4. **离线**：无网络时全部功能照常，恢复后自动补传。

## 5. 风险与边界

- API Key（BYOK）**永不上云**（本地 only）。
- 消息正文含高度敏感个人信息：上线云同步前须提供「仅本地模式」开关且默认关闭云端。
- 删除语义：本地删除批次 → 云端同批删除（含 Storage 文件），需用户确认一次。

## 6. 实施阶段拆分（建议）

1. Supabase Auth 接入 + 登录页启用（localStorage 数据保持本地）。
2. app_state 单表同步（画像 / 目标 / 设置）。
3. import_batches + Storage 消息文件同步。
4. 多设备冲突 UI + 删除同步。
