# 衡术 Hengshu — 项目进度与规划

> Verified AI Skills, Powered by Contribution.
> 文档更新：2026-06-26 · 版本：v0.1（MVP 基础骨架）
> 仓库：https://github.com/nanashiwang/hengshu-ai

---

## 1. 一句话现状

衡术 Hengshu 的 **MVP 基础骨架已端到端跑通**：用户可浏览 Skill 市场 → 在线运行 Skill → 经 模型网关 调用真实模型 → 记录成本/耗时/成功率 → 形成 SkillRank → 收藏/评论/邀请/悬赏。前台支持浅色/深色主题，已容器化并接入真实 模型网关 网关。

对照产品文档里程碑（§24）：**阶段 0（技术验证）已完成，阶段 1（MVP）核心已完成**，阶段 2~5 待推进。

---

## 2. 技术栈与架构

| 层 | 选型 | 职责 |
|---|---|---|
| 前台 + API | **Next.js 16.2.6**（App Router, standalone） | 页面、RSC、自定义 `/v1` 端点 |
| 基座 | **Payload CMS 3.85.1** | 数据建模 / 认证 / 权限 / 后台 / 钩子 / Local API |
| 数据库 | **PostgreSQL 16**（Drizzle 适配器） | 主业务数据（dev 自动 push schema） |
| 缓存/队列 | **Redis 7** | 预留（Worker / 限流 / 缓存） |
| 模型网关 | **模型网关**（OpenAI 兼容，cn.meta-api.vip） | 模型调用、token 计费 |
| 样式 | **Tailwind v4** + 集中式 CSS 令牌 | 双主题设计系统 |
| 部署 | **Docker** 多阶段 + docker-compose | 本地/生产一致 |

**职责边界**：Payload 管「内容/用户/后台/权限」；衡术自研 `src/lib/` + `/v1` 管「Skill 运行/路由/评测/贡献」。

```
用户浏览器
   ↓
Next.js（前台页面 + /v1 端点 + Payload admin/api）
   ↓ Local API（零 HTTP）        ↓ fetch
PostgreSQL / Redis           模型网关 → 模型供应商
```

---

## 3. 已实现功能清单

### 3.1 数据层（12 Collection + 1 Global）✅
`Users`（auth）· `Categories` · `Skills` · `SkillVersions` · `SkillRuns` · `Reviews` · `Favorites` · `InviteCodes` · `ContributionLogs` · `Bounties` · `Reports` · `Media` · `SiteSettings`(global)

- 函数式 Access Control（集合级 + 字段级）：`isAdmin` / `ownerOrAdmin` / `publishedOrPrivileged` / 字段级敏感信息隔离
- 关键业务钩子：
  - slug 自动生成（Skills/Categories）
  - **首个用户自动成为超管**（Users beforeChange）
  - Skill 发布通过审核 → 作者 +50
  - Skill 被收藏 → 作者 +1
  - Skill 成功调用 → 作者 +0.1
  - 评论变更 → 重算 avgRating/reviewCount
  - 版本创建 → 自动设 currentVersion + 更新时间
  - ⚠️ 已修复 Payload 钩子事务死锁（嵌套写操作透传 `req`）

### 3.2 Skill 运行链路（核心）✅
`src/lib/` 运行编排，完整实现产品文档 §12.2 闭环：
```
校验输入 → 渲染 Prompt({{var}}) → 选模型(路由策略) → 调 模型网关(带 fallback)
→ 校验输出格式(JSON schema) → 写 SkillRun → 增量更新 Skill 指标 → 发贡献值
```
- 路由模式：`cheap / quality / fast / balanced` + fallback 链
- 成本估算（token × 价格表）、首 token/耗时/成功率记录
- **无 Key 自动 mock 回退**；**真实模型已验证**（claude-haiku-4-5 等）
- 对外端点 `POST /v1/skills/{slug}/run`

### 3.3 前台页面 ✅
首页（Hero+精选+分类）· `/skills` 市场（PT 风格表+分类/排序/搜索）· `/skills/[slug]` 详情（§19 完整结构）· `/skills/[slug]/run` 在线运行（动态表单）· `/rank` 排行榜 · `/bounties` 悬赏（列表+详情+发布）· `/me` 个人中心 · `/login` `/register` · `/docs`

### 3.4 社区与 PT 化基础 ✅
登录 · 邀请码注册 · 收藏（切换）· 评论评分 · 贡献值流水 · 邀请码管理 · 悬赏发布 · SkillRank/健康度 · 贡献榜

### 3.5 体验与工程 ✅
- **浅色/深色主题**切换（localStorage 持久化 + 无闪烁注水）
- 集中式设计系统（`.card/.btn/.chip/.input` + 阴影/圆角/双主题令牌）
- sticky footer（页脚统一贴底）
- Payload 自动后台 `/admin`
- Worker 脚本：`npm run worker:skillrank`（SkillRank 批量重算）
- 5 个官方 Skill 种子（小红书标题/会议纪要/邮件润色/周报/差评回复）
- Docker 容器化 + compose（postgres/redis/app 一体）

---

## 4. 端到端验证记录（实测）

| 验证项 | 结果 |
|---|---|
| 生产构建 `npm run build` | ✅ 通过，19 条路由 |
| DB schema 推送 | ✅ 12 集合 + 全局表 |
| 真实模型运行（容器内） | ✅ `mocked:false`，claude-haiku-4-5，合法 JSON，成本/token/格式校验齐全 |
| SkillRun 落库 + 指标更新 | ✅ run_count/success_rate/skill_rank 正确 |
| 贡献值发放 | ✅ 发布 +50、调用 +0.1 |
| 收藏/评论钩子 | ✅ favorite_count/avg_rating 重算无死锁 |
| 双主题渲染 | ✅ 深/浅色截图验证 |
| 容器化 | ✅ 8787 端口端到端可用 |

---

## 5. 本地运行速查

```bash
docker compose up -d            # 起 postgres(5433)/redis(6380)
cp .env.example .env            # 填 PAYLOAD_SECRET / MODEL_GATEWAY_*
npm install && npm run dev      # http://localhost:3000
npm run seed                    # 注入官方数据
docker compose up -d app        # 容器版 http://localhost:8787
```
- 种子管理员：`admin@yuanheng.ai / admin12345` ｜ 邀请码：`WELCOME1`
- 真实网关：`https://cn.meta-api.vip`（仅 Claude 4.x / GPT-5.x / grok-4.3）

---

## 6. 已知限制 / 暂未实现

### 基础版/占位
- `/rank`、`/me`、`/bounties`：功能可用但较基础（无分页、悬赏无接单/验收流程）
- 评测中心：占位（指标来自真实运行聚合，无独立测试集评测）
- Worker：仅重算脚本，无队列/定时调度
- Fork：仅「敬请期待」反馈

### 工程待加固
- 生产仍需切 **migration**（当前 dev 用 push 自动同步）
- 模型网关 Key **明文存储**，需加密（KMS/对称加密）
- **邮件适配器**未配（注册验证/找回密码走 console）
- 缺**速率限制**、错误监控、自动化测试

### 产品文档后续阶段（§24 阶段 2~5）
模型网关 深度联动 · 多模型对比 · 一键 Skill API · 创作者中心/认证 · 限免/H&R/贡献比强约束 · 工作流/RAG/工具 Skill · 本地 Runner · 企业版 · 支付分成

---

## 7. 下一步建议（按优先级）

### 优先级 A — 形成数据差异化（产品文档阶段 2 核心）
1. **模型网关 深度联动**：本地同步模型列表与价格、调用透传 metadata（`X-YH-Run-ID`/`Skill-ID`）、关联 模型网关 调用日志、余额查询
2. **多模型对比评测**：同一 Skill 一次跑多模型，并排展示准确率/成本/延迟/JSON 成功率 —— 这是区别于普通 Prompt 站的关键卖点
3. **一键 Skill API**：用户生成 API Key，外部系统调用 Skill endpoint（开发者场景闭环）

### 优先级 B — 评测与社区
4. **评测中心 MVP**：上传测试集 + 批量评测 → 让 SkillRank 的「评测通过率」有真实来源
5. **悬赏验收流程**：接单 → 提交 → 验收 → 释放赏金（贡献值结算）
6. **创作者中心 + 认证**：发布管理、收益/曝光、认证创作者组

### 优先级 C — 工程化与上线就绪
7. 生产 migration 流程（`payload migrate:create` / `migrate`）
8. 模型网关 Key 加密存储 + 邮件适配器（注册验证）
9. Redis 速率限制 / 运行任务队列（异步评测）
10. 单元测试（lib 运行编排）+ E2E（关键路径）

### 建议的最小下一步（可立即开工）
> **「多模型对比 + 模型网关 metadata 透传」** 一起做：在运行页加「对比模式」选 2~3 个模型并行跑，落库多条 SkillRun，详情页展示对比表。它直接复用现有运行编排，改动小、产品价值最高，且能验证 模型网关 联动方向。

---

## 8. 关键文件索引

| 路径 | 说明 |
|---|---|
| `src/payload.config.ts` | Payload 主配置（集合/db/admin） |
| `src/collections/*` | 12 个数据集合 + 钩子 |
| `src/access/index.ts` | 权限规则 |
| `src/lib/skillRunner.ts` | 运行编排（核心） |
| `src/lib/newapi.ts` | 模型网关 客户端（含 mock 回退） |
| `src/lib/skillrank.ts` | SkillRank 加权计算 |
| `src/app/v1/**` | 对外 API（run/favorite/register） |
| `src/app/(frontend)/**` | 前台页面 |
| `src/app/(frontend)/globals.css` | 设计系统 + 双主题令牌 |
| `src/seed/*` | 种子脚本 + 官方 Skill 数据 |
| `docs/yuanheng_skillhub_product_doc_v0.1.md` | 原始产品规划文档 |
