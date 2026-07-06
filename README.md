# 衡术 Hengshu

> Verified AI Skills, Powered by Contribution.

一个**经过评测的 AI Skill 平台**：用真实运行数据告诉你「这个 Skill 在哪个模型上真省真稳」，用户下载到本地用自己的模型 API 运行，贡献兼容数据与优质 Skill 换取**术值**。

> 完整产品方向、护城河与落地路线见 **[`docs/衡术-总纲.md`](docs/衡术-总纲.md)**（唯一开发依据）。

## 技术栈

| 组件 | 用途 |
|---|---|
| **Next.js 16**（standalone） | 前台页面 + `/v1` 对外 API |
| **Payload CMS 3**（原生嵌入 Next） | 数据建模 / 认证 / 权限 / 后台 / 钩子 |
| **PostgreSQL 16**（Drizzle） | 主业务数据（dev 自动 push，生产应切 migration） |
| **Redis 7** | 运行分布式限流 / 队列预留 |
| **本地 Runner** `runner/hengshu.mjs` | 登录 / 安装 / 离线运行 / 兼容回流 |
| **模型网关**（OpenAI 兼容） | 在线试用与多模型对比（留空则走 mock 回退） |

## 已实现能力

- **下载→运行主线**：Skill Spec v1 · 发布快照+checksum · Runner 设备码登录 · 本地安装/离线运行（CLI 六命令）· 兼容报告回流+LocalScore · 术值/贡献2.0 规则引擎 · 求术悬赏闭环
- **信任模型**：manifest ed25519 签名 + Runner 验签 + `/v1/keys` 公钥分发 + `/verify` 分数快照公开验签
- **护城河数据层**：逐模型兼容真值表（时间衰减加权 + 置信度）· 在线运行回流喂评测数据 · 失败知识库（`/failures`）· 来源分级权重
- **创作者供给**：前台发布 Skill（`/console/skills/new`）· AI 合规审核通过自动上架/未通过转人工 · 我的作品 · 未发布 Skill 作者可预览
- **经济闭环（骨架）**：credit 台账 + 术值兑换池（`/console/exchange`，默认关闭待接真值）
- **前台**：首页发现 · Skill 市场（筛选/排序/搜索）· 详情（兼容矩阵/评论/版本）· 排行榜 · 悬赏区 · 控制台 · 订阅更新通知 · 移动端导航 · SEO(sitemap/robots/metadata)

## 快速开始

```bash
# 0. Node 22 LTS
nvm use

# 1. 起 PostgreSQL + Redis（主机端口 5433 / 6380，避开常见占用）
docker compose up -d postgres redis

# 2. 环境变量
cp .env.example .env
#   - PAYLOAD_SECRET 必填（openssl rand -hex 32）
#   - 模型网关/New API/签名/备份可部署后在后台「部署设置」配置
#   - seed 不再创建默认管理员；先通过 /admin 创建首个账号

# 3. 安装并启动
npm install
npm run dev          # http://localhost:3000

# 4. 首次初始化
#   - 首访 http://localhost:3000/admin 创建的账号即超级管理员（Payload 首用户引导）
npm run seed         # 注入分类 + 21 个官方 Skill（含 Skill 合规审核员；幂等；生产不会创建固定测试邀请码）
```

启动后：前台 `http://localhost:3000` · 市场 `/skills` · 后台 `/admin`。


## NAS / Compose 部署

最小部署只需要数据库、Redis、`PAYLOAD_SECRET` 和站点地址；模型网关、New API、签名私钥、备份确认等运营配置，部署后到后台「系统设置 → 部署设置」再填。

```bash
cp .env.nas.example .env
# 修改 PAYLOAD_SECRET / POSTGRES_PASSWORD / SERVER_URL / NEXT_PUBLIC_SERVER_URL
docker compose up -d --build
curl http://127.0.0.1:8787/health
```

首次打开 `http://NAS_IP:8787/admin` 创建管理员，然后进入「部署设置」按需配置真实模型调用、New API 子令牌、manifest 签名和备份状态。内网 HTTP 可以试跑；公网生产预检仍要求 HTTPS 同源、真实网关、New API 权限和备份确认。

## 常用脚本

| 命令 | 说明 |
|---|---|
| `npm run dev` / `build` / `start` | 开发 / 构建 / 生产启动 |
| `npm run seed` | 分类 + 21 个官方 Skill（含 Skill 合规审核员；幂等；需先创建首个管理员） |
| `npm run seed:rules` | 术值规则（幂等） |
| `npm run generate:types` | 生成 `src/payload-types.ts` |
| `npm run lint` | 资金/中立性/密钥与高熵令牌静态门禁 |
| `npm run keygen` | 生成 ed25519 签名密钥 |
| `npm run worker:skillrank` | 批量重算 SkillRank |
| `npm run worker:benchmark-queue` | 处理发布即评测队列 |
| `npm run worker:preflight-production` | 生产上线前检查强配置 + New API 在线权限 + 重复数据 |
| `npm run worker:calibrate-newapi -- --apply` | 用 calib- 临时子令牌做 New API 小额真钱闭环校准 |
| `npm run worker:export-score-anchors` | 导出分数快照外锚 JSONL + manifest |
| `npm run worker:verify-score-anchors` | 校验分数外锚 JSONL + manifest |
| `node runner/hengshu.mjs <cmd>` | 本地 Runner（login/install/run/... ） |

## 目录结构

```
src/
├─ app/(payload)/      # Payload admin + REST/GraphQL（自动样板，勿手改 layout/importMap）
├─ app/(frontend)/     # 前台：首页 / skills / rank / bounties / console / login / register / docs
├─ app/v1/             # 对外 API：skills(发布/run/compare/favorite/manifest) / auth / runner / bounties / keys
├─ collections/        # 19 个 Collection（Users/Skills/SkillVersions/CreditLogs/...）
├─ lib/                # newapi / 运行编排 / 校验 / 路由 / 贡献值 / 兼容聚合 / 签名 / 反女巫
├─ components/         # 前台组件
├─ seed/              # 种子/迁移/回填脚本
└─ payload.config.ts
```

## 注意事项

- 环境变量统一用 `DATABASE_URL`（非 `DATABASE_URI`）。
- `src/app/(payload)/layout.tsx`、`admin/importMap.js` 由 Payload 自动生成，勿手改。
- 自定义 API 一律放 `src/app/v1/`（`src/app/api/` 被 Payload 占用）。
- 开发模式 schema `push`（自动同步）；**生产应改用 migration**（见总纲部署章节）。
- Payload 钩子内嵌套 Local API 写操作**必须透传 `req`**，否则外键锁互等死锁。
- 部分唯一约束若历史库有重复数据，首次迁移前需先跑 `npm run worker:preflight-production` 并按提示处理。

## 文档

| 文档 | 用途 |
|---|---|
| [`docs/衡术-功能说明书.md`](docs/衡术-功能说明书.md) | 面向外部用户的模块功能说明 |
| [`docs/衡术-总纲.md`](docs/衡术-总纲.md) | **唯一开发依据**：定位/护城河/经济/统一落地路线 |
| [`docs/PROGRESS.md`](docs/PROGRESS.md) | 功能进度基线 |
| [`docs/体验手册.md`](docs/体验手册.md) | 完整闭环体验操作 |
