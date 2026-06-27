# 衡术 Hengshu — 项目进度与规划

> Verified AI Skills, Powered by Contribution.
> 更新：2026-06-27 · 阶段：v0.2.1 路线图 S1–S7 全部完成 · 仓库：https://github.com/nanashiwang/hengshu-ai
> 规划依据见 `hengshu_prd_v0.2.1.md`（收敛修订版）；体验见 `体验手册.md`。

---

## 1. 现状

「下载站 → 可安装/可更新/离线运行/兼容回流/术值留存/求术供给」**全链路已贯通且端到端验证**。核心定位（修订版 §2）：中央只做发现/评测/分发/社区，**运行算力下沉用户侧、中央零负担**。

v0.2.1 修订路线图 **S1–S7 全部完成**：

| Sprint | 交付 | 关键产物 |
|---|---|---|
| **S1** | Skill Spec v1 冻结 | schema_version/runtime/prompt.{system,user_template}/integrity；三处对齐 + 旧数据迁移 |
| **S2** | 发布时冻结快照 | `SkillArtifacts` + 稳定 checksum；下载发存量字节 |
| **S3** | Runner 登录 | OAuth Device Code；`RunnerClients`/`DeviceCodes`；Bearer 鉴权 |
| **S4** | 安装与本地运行 | `SkillInstalls`；CLI install/list/run/update/remove/doctor；离线运行 |
| **S5** | 兼容报告回流 | `CompatReports`（无输入输出）；LocalScore；详情页兼容表 |
| **S6** | 术台 + 贡献2.0 | `ContributionRules` 规则引擎（日上限/自操作排除）；我的术台读视图 |
| **S7** | 求术闭环 | 扩展 `Bounties`（frozenPoints/术值托管）；认领→提交→验收/取消 |
| **★ 收口** | 信任模型 | manifest **ed25519 签名** + Runner 验签；**verified Runner** 兼容报告**计术值**（社区仅展示） |

---

## 2. 技术栈

| 层 | 选型 | 职责 |
|---|---|---|
| 前台 + API | **Next.js 16.2.6**（standalone） | 页面、RSC、`/v1` 端点 |
| 基座 | **Payload CMS 3.85.1** | 数据建模 / 认证 / 权限 / 后台 / 钩子 / Local API |
| 数据库 | **PostgreSQL 16**（Drizzle） | dev 自动 push（生产应切 migration） |
| 缓存/队列 | **Redis 7** | 预留（限流/队列） |
| 本地 Runner | `runner/hengshu.mjs`（Node CLI） | 登录/安装/离线运行/兼容回流 |
| 模型网关 | OpenAI 兼容（`MODEL_GATEWAY_*`） | 在线试用与多模型对比 |
| 部署 | Docker 多阶段 + compose | dev `:3000` / 容器 `:8787` |

---

## 3. 数据模型（18 Collection + 1 Global）

- **Skill 内容**：`Skills` · `SkillVersions` · `SkillArtifacts` · `Categories` · `SkillRuns` · `Bounties` · `CompatReports`
- **成员管理**：`Users`(auth) · `InviteCodes` · `ContributionLogs` · `ContributionRules` · `Favorites` · `RunnerClients` · `SkillInstalls`（另 `DeviceCodes` 为 OAuth 设备码，后台隐藏、不分组）
- **审核治理**：`Reviews` · `Reports`
- **系统设置**：`Media` · `SiteSettings`(global)

四态指标口径（修订版 §5.2）：下载=manifest GET 计数(弱信号不计分)；安装=`SkillInstalls`；有效安装=关联成功 run/report；活跃安装=`lastUsedAt` 滚动窗。

---

## 4. 对外 API（`/v1`）

| 分组 | 端点 |
|---|---|
| Skill | `skills/[slug]/run` · `/compare` · `/favorite` · `/manifest?format=yaml\|json`（发布时冻结、**含 ed25519 签名**） |
| 认证 | `auth/register`（邀请码） · `auth/device/{code,authorize,token}`（设备码） |
| Runner（Bearer） | `runner/me` · `/install` · `/uninstall` · `/check` · `/touch` · `/report`（verified 计术值） |
| 悬赏（cookie） | `bounties/[id]/{accept,submit,complete,cancel}` |
| 公钥 | `keys`（ed25519 公钥，供 Runner 验签） |

---

## 5. Runner CLI（`node runner/hengshu.mjs <cmd>`）

`login`（设备码） · `whoami` · `install <slug>` · `list` · `run <slug\|file> [--report] [--anon]` · `outdated` · `update [<slug>]` · `remove <slug>` · `doctor`

令牌存 `~/.hengshu/config.json`（chmod 600）；已装 Skill 在 `~/.hengshu/skills/<slug>/`。
**安装时**重算 checksum + 验 ed25519 签名（公钥取自 `/v1/keys`），无效则拒装。

---

## 6. 端到端验证（生产容器 8787 冒烟，全过）

| 验证项 | 结果 |
|---|---|
| Runner whoami（Bearer 归属） | ✅ |
| install → 本地落盘 + `SkillInstalls` + checksum | ✅ |
| 离线 run + `--report` → `CompatReports`（无输入输出）+ LocalScore | ✅ |
| 多模型对比（haiku vs sonnet 并行） | ✅ |
| 下载发存量字节（两次字节一致 + checksum 三处一致） | ✅ |
| 贡献2.0：自操作排除 / 非自操作发分 / 日上限 | ✅ |
| 求术闭环：发布冻结 → 认领 → 提交 → 验收释放 / 取消退还（结算正确） | ✅ |
| manifest ed25519 签名 + Runner 安装验签（YAML 规范化重建后验证） | ✅ |
| verified Runner 报告计术值（+3）/ 社区报告不计 | ✅ |
| 全部前台页面 + `/admin` 分组 | ✅ |

---

## 7. 常用脚本

```bash
docker compose up -d                 # postgres(5433)/redis(6380)
npm install && npm run dev           # http://localhost:3000
npm run seed                         # 管理员+分类+5官方Skill+邀请码
npm run migrate:spec-v1              # 旧版本迁移到 Spec v1（幂等）
npm run artifacts:backfill           # 冻结现有版本制品（幂等）
npm run seed:rules                   # 术值规则（幂等，含 compat_report）
npm run keygen                       # 生成 ed25519 签名密钥（输出 HENGSHU_SIGNING_KEY=... 写入 .env）
npm run artifacts:backfill           # 冻结现有版本制品（幂等）；配了签名密钥则带签名
docker compose up -d app             # 容器版 http://localhost:8787
node runner/hengshu.mjs <cmd>        # 本地 Runner
```

---

## 8. 已知限制 / 后续（v0.3+，修订版 §8 阶段3-4）

- **信任模型**：✅ manifest **ed25519 签名 + Runner 验签** 已落地（`HENGSHU_SIGNING_KEY` / `/v1/keys`）；✅ **verified Runner 兼容报告计术值**（社区仅展示）。剩余：raw/aggregated 拆层、跨报告离群检测、verified Runner 的真实远程证明（当前为**管理员核验** trustedLevel）
- 反作弊深化：raw/aggregated 拆层、离群检测、跨报告去伪
- 工程：生产 migration（替代 dev push）、Runner Key 加密、邮件适配器、Redis 限流、自动化测试
- **推迟到 v0.3+**：发布组、Skill 包、术榜多榜单、创作者中心重指标、争议仲裁、私有术库/企业版

> v0.2 成功度量（修订版 §11）：安装→成功运行转化率、7 日二次访问率、兼容榜矩阵填充率、具名兼容报告数/周、创作者维护频率 —— **不是 Skill 数量**。

---

## 9. 关键文件索引

| 路径 | 说明 |
|---|---|
| `src/payload.config.ts` | 集合/分组/db/admin |
| `src/collections/*` | 18 个集合 + 钩子 |
| `src/lib/{skillRunner,newapi,manifest,artifacts,installs,compat,contribution,runnerAuth,skillrank}.ts` | 核心库 |
| `src/app/v1/**` | 对外 API |
| `runner/hengshu.mjs` | 本地 Runner CLI |
| `src/seed/*` | 种子/迁移/回填脚本 |
| `docs/hengshu_prd_v0.2.1.md` | 收敛修订版 PRD（规划依据） |
| `docs/体验手册.md` | 完整闭环体验操作手册 |
