# 衡术 Hengshu

> AI Skill 的可信与兼容控制平面：给 Skill 上身份、版本、签名、Passport、兼容证据、失败库和企业治理。

**衡术 Hengshu 让 AI Skill 像软件包一样拥有身份、版本、签名、兼容证据、失败记录和企业治理能力。**

衡术不是 Prompt 市场、通用模型网关或靠 New API margin 打价格战的平台；它真正解决的是：用户已经有自己的模型、网关、Runner 或企业环境，衡术负责证明某个 Skill 是否可信、能否稳定运行、失败后怎么修、换模型后能否继续复用。

> 完整产品方向、对象定义与落地路线见 **[`docs/衡术-总纲.md`](docs/衡术-总纲.md)**（唯一开发依据）。

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

- **下载→运行主线**：Skill Spec v1 · 发布快照+checksum · Runner 设备码登录 · 本地安装/离线运行（CLI 六命令）· 安装响应返回“验签→本地跑→脱敏回流→更新”playbook · 兼容报告回流形成兼容分 · 贡献值规则引擎 · 求术悬赏闭环
- **信任模型**：manifest ed25519 签名 + Runner 验签 + `/v1/keys` 公钥分发 + `/verify` 分数快照公开验签 + `/v1/evidence/verify` 证据快照验签 + `/v1/anchors/verify` 外锚 manifest 验签 + `/v1/skills/[slug]/certificate` 达标证书 + `/v1/certificates/verify` 证书验签（完整响应或裸证书均可）
- **护城河数据层**：逐模型/版本兼容真值表（时间衰减 + 来源权重 + 置信度，并展示有效样本）· ModelProfile 漂移曲线/输入规模档/任务画像/Skill任务画像表现 · 黄金样例逐条打分 · 在线运行回流喂评测数据 · 失败知识库（`/failures` + 归因看板，含人工归因/复验覆盖/证据验签/私人台账复验计划）· 从失败案例生成待评审 Adapter 草稿并直达前台评审看板 · 企业内 Passport/达标证书 · 企业策略包/身份策略骨架 · 企业失败知识库 · 来源分级权重
- **创作者供给**：前台发布 Skill（`/console/skills/new`，引导上传包→Contract→Passport→适配维护，并返回发布后维护 playbook）· AI 合规审核通过自动上架/未通过转人工 · GitHub README / Claude Skill / GPTs 配置导入为待审 Imported Skill · 批量来源导入 worker · 我的作品展示 Contract/Passport/证书预览/失败库入口 · 未发布 Skill 作者可预览
- **经济闭环（骨架）**：credit 台账 + 贡献值兑换池（`/console/exchange`，默认关闭待接真值）
- **前台**：首页发现（先跑必备 Skill）· Skill 市场（必备筛选/分类/排序/搜索）· 详情（Passport/Contract diff筛选/兼容矩阵/评论/版本）· 可信榜（公开排序口径，非下载量热榜）· 悬赏区 · 控制台 · Adapter 评审看板/批量评审 · 失败归因看板 · 订阅更新通知 · 移动端导航 · SEO(sitemap/robots/metadata)

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
npm run worker:preflight-private  # 可选：先检查 .env.nas 是否还有默认密钥/弱密码
docker compose up -d --build
curl http://127.0.0.1:8787/health
```

首次打开 `http://NAS_IP:8787/admin` 创建管理员，然后进入「部署设置」按需配置真实模型调用、New API 子令牌、manifest 签名和备份状态。内网 HTTP 可以试跑；公网生产预检仍要求 HTTPS 同源、真实网关、New API 权限和备份确认。

## 常用脚本

| 命令 | 说明 |
|---|---|
| `npm run dev` / `build` / `start` | 开发 / 构建 / 生产启动 |
| `npm run seed` | 分类 + 21 个官方 Skill（含 Skill 合规审核员；幂等；需先创建首个管理员） |
| `npm run seed:rules` | 贡献值规则（幂等） |
| `npm run generate:types` | 生成 `src/payload-types.ts` |
| `npm run lint` | 资金/中立性/密钥与高熵令牌静态门禁 |
| `npm run keygen` | 生成 ed25519 签名密钥 |
| `npm run worker:skillrank` | 批量重算 Skill 可信分（含 Passport 中的可信兼容运行计数） |
| `npm run worker:backfill-passports` | 从现有 Skill/版本/制品/兼容报告回填 Skill Passport |
| `npm run worker:refresh-model-profiles` | 从兼容报告和官方报价快照刷新 Model Profile |
| `npm run worker:backfill-compat-model-profiles` | 给历史兼容报告补关联 Model Profile |
| `npm run worker:cluster-failures` | 从兼容报告聚类生成脱敏 FailureCase |
| `npm run worker:import-skill-sources -- --file=imports.json [--sync]` | 批量导入/同步 GitHub README / Claude Skill / GPTs / Skill 包；`--sync` 会按来源内容 hash 生成新版本和变更差分 |
| `npm run worker:sync-skill-sources -- --file=imports.json` | 定时任务/cron 友好的来源同步入口，等价于 import worker 开启 `--sync` |
| `npm run worker:benchmark-queue` | 处理发布即评测队列 |
| `npm run worker:preflight-private` | NAS/私有部署 readiness：检查默认密钥、数据库密码、URL 同源、端口和持久化提示 |
| `npm run worker:preflight-production` | 生产上线前检查强配置 + New API 在线权限 + 外锚可信发布目标 + 重复数据 |
| `npm run worker:calibrate-newapi -- --apply` | 用 calib- 临时子令牌做 New API 小额真钱闭环校准 |
| `npm run worker:export-score-anchors` | 导出分数快照外锚 JSONL + 自签 manifest |
| `npm run worker:verify-score-anchors` | 校验分数外锚 JSONL + manifest 签名 |
| `npm run worker:export-evidence-anchors` | 导出证据快照外锚 JSONL + 自签 manifest（可带第三方发布/时间戳声明 env） |
| `npm run worker:verify-evidence-anchors` | 校验证据快照外锚 JSONL + manifest 签名 + 第三方声明格式；可信发布目标可在部署设置配置，公开 API 可校验命中状态和时间戳 receiptHash |
| `npm run worker:reverify-queue` | 消费失败库私人台账复验队列，按候选历史运行自动重跑并回写 verificationCoverage |
| `node runner/hengshu.mjs <cmd>` | 本地 Runner（login/install/run/... ） |

## 关键 API

| API | 用途 |
|---|---|
| `GET /v1/skills` | 公开读取 Skill 摘要列表，支持 `essential=1` 作为必备 Skill onboarding 接口，并返回必备推荐理由、新手 starterPlaybook、可信榜排序依据、顶层 trustedCompatibleRunCount、Passport 可信摘要、API/页面证据验签入口、试跑入口和台账入口 |
| `GET /v1/skills/[slug]/contract` | 公开读取当前未废弃版本的 Skill 能力契约摘要、contractHash、prompt hash、availableBaselines、可选 compareVersion/compareVersionId 基线 diff 和客户复核 playbook；详情页已可视化 diff，不暴露 prompt 正文 |
| `GET /v1/skills/[slug]/passport` | 公开读取清洗后的 Skill Passport、黄金样例摘要、可信兼容运行计数、证据验签入口、最新证据验签摘要和客户复核 playbook |
| `GET /v1/skills/[slug]/certificate` | 公开读取 Skill 达标证书，绑定当前未废弃 Contract 摘要、Passport、可信兼容运行计数、黄金样例逐条摘要和证据验签状态，含 `certificateHash`、签名、公开公钥、`statusReasons` 和 Passport 证据验签页面入口 |
| `POST /v1/skills/[slug]/run` | 在线试跑 Skill；请求可携带 `modelProvider` / `modelVersion`，运行回流会绑定对应 ModelProfile、FailureCase 和 Adapter 版本链路 |
| `POST /v1/runner/install` | Runner 安装公开 Skill，返回冻结 manifest、checksum 和“验签→本地运行→脱敏回流→更新”playbook |
| `POST /v1/runner/check` | Runner 检查本地安装 checksum 是否过期，返回“先更新→重新验签→复验回流”playbook |
| `POST /v1/runner/report` | Runner 回流本地兼容报告；只接收指标，不接收输入/输出原文，且要求当前安装版本与 checksum 匹配 |
| `POST /v1/certificates/verify` | 校验完整证书响应或裸 certificate 的 hash 与 ed25519 签名，并返回绑定的 Contract/Passport/基准摘要、客户复核指引和未达正式达标原因；前台 `/verify?certificateUrl=...` 可自动加载证书并验签 |
| `GET /v1/model-profiles` | 公开读取模型画像、版本漂移、输入规模档、任务画像与 Skill 任务画像表现、回归告警、有效样本、来源权重、采用复验 checklist 和客户决策 playbook；支持 modelName/modelVersion/provider/status 过滤，并返回私人台账复验、失败库/Adapter 排障入口 |
| `GET /v1/failures` | 公开读取脱敏失败知识库、人工归因摘要、复验覆盖、客户排障 playbook、triage checklist、私人台账复现、修复/复验建议、模型画像/Adapter 排障入口和 API/页面证据验签入口；支持 skillId/profileKey/inputBucket/modelVersion/source 过滤 |
| `GET /v1/failures/[id]/reverify-plan` | 登录后基于当前用户私人台账生成失败复现与 Adapter 复验计划：候选失败运行、rerunUrl、覆盖缺口、已批准 Adapter 和 triage 回写动作；不暴露原始输入输出或补丁正文 |
| `POST /v1/failures/[id]/reverify-queue` | 登录后把该失败案例的私人台账复验计划放入 Redis 批量队列；按 failureCaseId+userId 去重，返回 plan 和 jobPreview，未配置 Redis 时显式 503 降级；`worker:reverify-queue` 消费后回写复验覆盖 |
| `POST /v1/adapters/review` | 审核员批量批准/拒绝/要求修改 Adapter 草稿；批准时可批量启用 active，最多 100 条，不暴露补丁正文或用户输入输出 |
| `GET /v1/adapters` | 公开读取已批准 active Adapter 效果摘要、lift 指标、复用/复验 checklist、私人台账复验入口和 API/页面证据验签入口；支持 skillId/modelName/modelVersion/failureType/failureId/modelProfile 过滤，不暴露补丁正文或未批准草稿 |
| `GET /v1/evidence/verify?targetType=...&targetId=...` | 校验已知 Passport / FailureCase / Adapter 的证据快照，返回公开脱敏 `targetSummary`、payloadHash 和签名状态；不提供匿名全量枚举 |
| `POST /v1/anchors/verify` | 校验 score/evidence 外锚 JSONL + manifest + 可信发布/时间戳声明，返回可信等级和采购/审计复核 playbook；`/v1/anchors/timestamp-request` 可生成第三方时间戳 imprint 请求包 |
| `GET /v1/runs` | 当前用户私人运行台账导出；支持 skillId/model/modelVersion/routeMode/success/formatValid/trustedCompatible/rerunOf 过滤；默认不含输入/输出，返回模型画像、可信兼容标记、失败库排障入口和换模型重跑 playbook，`includeIO=1` 仅本人导出原文并写审计 |
| `POST /v1/runs/[id]/rerun` | 用私人台账中的历史输入换模型重跑，可携带 modelProvider/modelVersion，写入重跑血缘 |
| `GET /v1/enterprise/registry/[id]/passport` | 企业内读取已批准/可审 Skill 的 Passport、治理状态、批准时采用基线、基线漂移告警、证书状态摘要、准入治理 checklist、审计/失败库入口和绑定 Contract 的达标证书 |
| `GET /v1/enterprise/identity/authorize` | 生成企业 OIDC SSO 登录发起包：authorizeUrl、callbackUrl、HMAC state/nonce、IdP 跳转和回调接入指引；callback 先校验 state、还原组织上下文并返回服务端 tokenExchange 请求包，可选校验 ID Token claims、邮箱域和 active 成员绑定；JWKS 签名校验仍待真实 IdP 接入 |
| `GET /v1/enterprise/audit/export` | 企业审计 CSV 导出，含模型版本治理元数据，不含输入输出原文 |
| `GET /v1/enterprise/failures` | 从企业审计元数据聚合组织内失败知识库和模型版本分布 |
| `POST /v1/enterprise/identity` | 企业身份策略保存：域名白名单、requireSso、OIDC/SCIM 格式校验，并返回 SSO/SCIM 接入 playbook |
| `POST/GET/PATCH/DELETE /v1/enterprise/scim/users` | 企业 SCIM 成员 provision：Bearer digest 校验、ListResponse 列表、基础 filter、PATCH active、创建/绑定/停用成员 |

## 目录结构

```
src/
├─ app/(payload)/      # Payload admin + REST/GraphQL（自动样板，勿手改 layout/importMap）
├─ app/(frontend)/     # 前台：首页 / skills / rank / bounties / console / login / register / docs
├─ app/v1/             # 对外 API：skills/passport/certificate/verify / runner / evidence / anchors / enterprise
├─ collections/        # 业务 Collection（Users/Skills/SkillVersions/SkillPassports/ModelProfiles/AdapterProfiles/Organizations/EnterpriseRegistries/...）
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
| [`docs/ARCHITECTURE_V2.md`](docs/ARCHITECTURE_V2.md) | v2 对象与当前代码映射 |
| [`docs/PROGRESS.md`](docs/PROGRESS.md) | 历史进度存档（已冻结；当前状态看总纲和架构映射） |
| [`docs/体验手册.md`](docs/体验手册.md) | 完整闭环体验操作 |
