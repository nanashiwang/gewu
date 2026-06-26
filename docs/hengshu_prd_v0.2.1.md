# 衡术 Hengshu PRD v0.2.1（收敛修订版）

> 本文不是重写 v0.2，而是基于多视角评审对 v0.2 的**修订与收敛**，作为实际执行依据。
> v0.2 中未被本文改动的细节（页面字段、求术字段、隐私字段清单等）继续有效。
> 文档版本：v0.2.1 · 更新：2026-06-27 · 配套：`hengshu_prd_v0.2.md`、`PROGRESS.md`

---

## 0. 这次改了什么（一页看懂）

| 维度 | v0.2 原稿 | v0.2.1 修订 | 原因 |
|---|---|---|---|
| 焦点 | 7 大模块齐头并进 | **只验证 1 个假设**，砍掉 4 类模块 | 窄受众撑不起需规模的社区模块，焦点被稀释 |
| 执行顺序 | §18：我的术台 #1、Spec v1 #3 | **Spec v1 #1**，我的术台后置为读视图 | 原序依赖倒置，照做 Sprint 1 会卡死 |
| 护城河 | 本地兼容**数据规模** | 兼容**评测协议 + 创作者维护网络** | 数据规模会被 Ollama/HF 默认采集碾压 |
| 术值 | 下载/消费货币（PT 式） | **声誉/优先权信用**，消费侧早期全免费 | Skill 明文可无限复制，做种比经济学不成立 |
| 兼容数据 | 自报即真 + 直接发术值 | raw/aggregated 分层 + 仅 verified 计分 | 不可信 Runner 自报 + 奖励 = 鼓励伪造 |
| 新数据模型 | 一次新增 8 张 | v0.2 先落 **4 张**，其余推迟 | 与 12 老表大面积重叠，需先对账 |
| 开工前置 | 无 | **3 张定义表必须先产出** | 否则 8 新表撞 12 老表、口径打架 |

---

## 1. 定位与护城河（重定义）

**定位不变**：面向本地/自有模型端点用户的 AI Skill 注册表 + 分发 + 兼容评测 + 贡献社区。

**护城河重定义**（关键修正）：
> 不押「用户上报的兼容样本量」（官方分发方默认开启就能碾压），而押
> **① 结构化兼容评测协议**（按任务维度切分、带验收标准、可复算的输出结构指纹）
> **② 创作者维护网络**（谁在持续修版本、响应 Issue、按失败反馈迭代）。

即护城河是「**语义结构 + 社区契约**」，不是原始数据规模。这两样官方分发方不会做、也复制不了。

**核心用户张力的解法**（v0.2 必须正面回答）：
- 明确目标人群是「**半在线社区党**」——愿意登录、看更新、查兼容榜的本地用户。
- 「完全离线」用户是受支持但**不计入二次访问 KPI**的人群，不为他们设计留存。
- 留存锚点从低频的「Skill 版本更新」改为更高频的「**模型雷达**：你装的 Skill 在 qwen3/llama4 上兼容性已变化」。

---

## 2. 术值重定位（声誉信用，非下载货币）

- 术值 = **声誉 + 优先权信用**，不是用来「买下载」的货币。
- **消费侧早期全免费**：下载、安装、看兼容榜不耗术值（明文 YAML 本就可白嫖，设墙只劝退早期用户）。
- 术值只用于：解锁**创作者特权**（免审、置顶、发布组、官方评测）与**求术悬赏冻结**。
- 计分来源从「下载」彻底剥离 —— `downloadCount` 降为**弱信号，不进任何计分**。

---

## 3. v0.2 范围收敛（聚焦唯一假设）

**v0.2 要验证的唯一核心假设：**
> 「**有本地模型、会用 CLI 的窄用户，愿意为兼容数据 + 安装管理回到衡术。**」

**保留（v0.2 做）：**
- Hengshu Skill Spec v1（契约）
- Runner v0.2：login / install / list / run / update / remove / doctor + `~/.hengshu`
- CompatReports 上报 + 详情页兼容表（初版 LocalScore）
- 我的术台（作为 Installs/Runs/Reports 的**读视图**）
- 贡献 2.0 的**规则引擎重构**（ContributionRules）

**砍掉 / 推迟到 v0.3+（v0.2 不做）：**
- ❌ 发布组、Skill 包、术榜多榜单、创作者中心重指标（Trust/Maintain/Community 多分）
- ❌ 求术广场闭环 → 复用现有 Bounties 做**最小版**即可，不新建表、不做争议仲裁
- ❌ checksum **签名**（v0.2 只做 checksum，签名留 v0.3，无验签消费方前不引入密钥管理）

---

## 4. 修正后的依赖序与 Sprint 重排（取代 §18）

```
S1 Spec v1 冻结 + 三处对齐 + 旧数据迁移        [契约根，必须先做]
   ↓
S2 SkillArtifacts + checksum（发布时规范化落库，不再即时生成）
   ↓
S3 Runner login + RunnerClients（OAuth Device Code，token 落 ~/.hengshu）
   ↓
S4 Runner install/list/run/update/remove/doctor（run 写回 SkillInstalls/SkillRuns）
   ↓
S5 Runner --report + CompatReports 落库（链路最长，先打通端到端真实事件）
   ↓
S6 我的术台（上述数据的读视图） + 贡献 2.0 规则引擎重构（可并行）
   ↓
S7 求术最小版（复用扩展 Bounties，并行/收尾）
```

每个 Sprint 的**最小可验收切片**（避免无数据假绿灯）：
- **S1**：12 个官方 Skill 全部能导出新 Spec 包；Runner 能解析；旧数据迁移脚本跑通且无丢失。
- **S2**：发布动作生成不可变冻结快照，同一版本两次下载**字节一致**、checksum 稳定。
- **S3**：`hengshu login` 走通设备码登录，写端点接受 Bearer；产生一条 RunnerClients。
- **S4**：不打开网页也能 `hengshu run` 已安装 Skill；doctor 能报 endpoint/模型不可用。
- **S5**：`hengshu run --report` 后中央查得到一条 CompatReport，且**字段不含输入输出**。
- **S6**：术台展示真实安装/运行/兼容数据；旧积分行为经规则引擎回归测试不变。

---

## 5. 开工前必做的 3 张定义表（最高优先，先于 S1 编码）

### 5.1 「现有表/字段 → 新模型」对账映射

| 现有 | 新模型 | 关系处理 |
|---|---|---|
| `downloadCount`（manifest GET 计数） | — | 保留为弱信号，**不进计分** |
| `SkillRuns` | `CompatReports` | **同源复用口径**，不另起炉灶；CompatReports = 可上报的 SkillRun 子集 |
| `Bounties` | 求术 | **扩展不新建表**（加 status `reviewing/disputed` + `frozenPoints`） |
| `Reports` | `SkillIssues` | **分流**：Reports=违规举报走下架；SkillIssues=建设性反馈走修复 |
| `CONTRIBUTION_ACTIONS`(14 值) | `ContributionRules.actionType` | 一一对齐，constants 降级为 seed |
| `skillrank.ts` 的 maintenance/userFeedback | Maintain/CommunityScore | **复用同一算法，不要换名再造一套** |

### 5.2 「四态指标」定义（钉死，三处共用）

| 指标 | 定义（来源表.字段 + 计算式） | 用途 |
|---|---|---|
| 下载 | `Skills.downloadCount`：manifest GET +1，匿名无去重 | 弱信号，**不计分** |
| 安装 | `SkillInstalls` 一条 `status=installed`，`unique[user,skill,runner]` | 计分起点 |
| 有效安装 | 该 install 关联 ≥1 条成功 `SkillRun/CompatReport`（跨表 EXISTS） | 创作者核心指标 |
| 活跃安装 | `SkillInstalls.lastUsedAt` 在 14 天滚动窗内 | 留存指标 |

### 5.3 Spec v1 字段冻结（见 §6）

---

## 6. Hengshu Skill Spec v1（冻结 + 破坏性变更迁移）

**采用 v0.2 §8 的字段结构**，并明确这是**破坏性变更**，S1 必须一次性对齐三处：

```yaml
schema_version: hengshu.skill/v1     # 字符串（非现状的数字 spec_version:1）
id / name / version / author / license / category
runtime: { type: prompt, min_runner_version: 0.2.0, permissions: {...} }
input_schema / output_schema
prompt: { system: ..., user_template: ... }   # 两段（现状只有单段 prompt_template）
models: { local_recommended: [...], endpoint_type: [...] }
examples: [...]
integrity: { checksum: sha256:... }   # 发布时算，signature 留 v0.3
```

**三处对齐（S1 同步交付）：**
1. `src/lib/manifest.ts`：`buildManifest` 重写字段，**去掉 `exported_at`**（时间戳使每次字节不同、checksum 无法稳定）。
2. `runner/hengshu-run.mjs`：解析改读 `prompt.system + user_template`、`models.local_recommended`。
3. `src/collections/SkillVersions.ts`：**新增 `systemPrompt`、`runtime`、`permissions`、`minRunnerVersion` 字段**；对全量旧 Skill 做 prompt 拆分迁移（把现有 `promptTemplate` 拆成 system/user）；`renderTemplate` 调用改为 `messages:[{role:system},{role:user}]`。

> 做**一次性 rename + 迁移**，不长期维护新旧双字段。

---

## 7. 兼容数据信任模型（解 PRD 最大缺陷）

「success/latency/format_valid 全由不可信本地 Runner 自报、中央无法独立验证」+「发术值」= 把伪造变成有回报。修正：

1. **分层**：`CompatReports` 拆 `raw_reports`（原始上报，**永不直接上榜**）与 `aggregated_score`（聚合后才展示/计分）。
2. **可复算指纹**：`format_valid` 由 Runner 上报**输出结构指纹**，中央按 `output_schema` 重算校验，而非信 Runner 的布尔。
3. **分级计分**：仅**官方 verified Runner**（签名构建版）的报告计分发术值；社区自建 Runner 的报告**仅展示、不计分**。
4. **离群检测**：latency/format 偏离基线的报告降权（跨报告统计，不是单条信任）。
5. **反作弊真正落地**：`daily_limit / 自操作排除 / 限频 / 幂等键` 接入 `awardContribution` 的**前置校验**（现状无条件发分）；`downloadCount` 加去重。
6. **匿名 ≠ 发术值**：匿名通道只展示不发术值（要发术值就必须定位用户）；具名通道明示关联账号。

---

## 8. 数据模型收敛（v0.2 只落 4 张 + 约束 + 命名）

**v0.2 落地**：`SkillArtifacts`、`SkillInstalls`、`RunnerClients`、`CompatReports`。
**推迟**：`PublisherGroups`、`SkillPackages`、`SkillIssues`、`ContributionRules`（ContributionRules 在 S6 落，其余 v0.3+）。

**命名统一**：新模型一律按现有实现风格 **camelCase + relationship 字段去 `_id` 后缀**（`skill_id→skill`），避免 `payload-types.ts` 出两套风格。

**必须声明的 unique / 外键反向关系**：
- `SkillInstalls` unique `[user, skill, runner]`；`SkillArtifacts` unique `[version, format]`；`RunnerClients` unique `[runnerId]`
- 外键链：`SkillInstalls.runner→RunnerClients`、`CompatReports.install→SkillInstalls`、`SkillRuns→SkillInstalls`
- 否则安装量被重复行灌水、有效/活跃安装跨表计算无路径。

**4 个新分的来源**（别同概念两套算法）：`LocalScore←CompatReports 聚合→写 Skills.localScore`；`MaintainScore` 复用 `skillrank` 的 `recencyScore`；`CommunityScore` 复用 `avgRating`；`TrustScore` 落 `Users/PublisherGroups`（v0.3）而非 Skill。

**匿名标识**：`anonymousUserHash = HMAC(runnerId + 服务端 salt)`，不可逆到 user；`runnerId` 为随机 UUID **非硬件指纹**；同步把它补进 §11.2 白名单并注明不可逆。

---

## 9. Runner 登录与信任根（PRD 只各一行，这里补实现）

- **登录**：OAuth **Device Code** 流程（CLI 无浏览器），token 落 `~/.hengshu/config.json`（chmod 600）；写端点（install/report）同时接受 **Bearer**（现状仅 cookie session，CLI 拿不到）。列为 Runner **第 0 步**。
- **checksum**：发布时把 manifest **规范化**（去 `exported_at` + JCS key 排序）冻结进 `SkillArtifacts` 并算一次 checksum 持久化，下载发**存量字节**。v0.2 只做 checksum，signature 标注 v0.3。

---

## 10. 冷启动（PRD 完全空白，必须补）

社区产品成败几乎全在冷启动：
- **种子数据矩阵**：平台用 **12 个官方 Skill × N 个主流本地模型**（qwen2.5/llama3.1/deepseek-r1/gemma3…）自跑，先把兼容榜填满——**先有数据，再谈网络效应**，不靠用户上报冷启。
- **前 100 个用户路径**：写清从哪来（本地模型社区 / Ollama 用户 / 极客渠道），用什么钩子（「一条命令装好能在你 qwen 上跑的中文 Skill」）。

---

## 11. v0.2 成功度量（可量化，取代「Skill 数量」）

- 安装→成功运行转化率 ≥ X%（Runner 真能跑通）
- 装过 Skill 的用户 7 日二次访问率 ≥ X%
- 兼容榜覆盖：官方 Skill × 本地模型矩阵填充率 = 100%（种子）
- 具名兼容报告数 / 周（社区开始贡献结构化数据的信号）
- 创作者版本维护频率（维护网络是否成立）

> v0.2 成败 = 上述「采用 + 回访 + 维护」信号，**不是 Skill 数量**。

---

## 附：与现有代码的衔接点（落地索引）

| 改动 | 文件 |
|---|---|
| Spec 字段 / 去 exported_at | `src/lib/manifest.ts` |
| Runner 解析对齐 + login/install 等命令 | `runner/`（升级为可发布包，`bin: hengshu`） |
| SkillVersions 加 systemPrompt/runtime 等 + 迁移 | `src/collections/SkillVersions.ts` |
| 新 4 表 | `src/collections/{SkillArtifacts,SkillInstalls,RunnerClients,CompatReports}.ts` |
| 反作弊前置校验 | `src/lib/contribution.ts`（`awardContribution`） |
| 规则引擎 | `src/collections/ContributionRules.ts`（S6）+ `src/lib/constants.ts` 降级为 seed |
