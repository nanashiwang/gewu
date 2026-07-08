# 衡术 v2 架构映射

> 目的：把当前代码基座映射到「AI Skill 的可信与兼容控制平面」对象，避免继续按旧的“省钱路由 + 中转履约”叙事开发。
> 更新时间：2026-07-08

## 已落地

| v2 对象/能力 | 当前实现 | 说明 |
|---|---|---|
| Skill | `src/collections/Skills.ts` | Skill 市场、状态、可见性、作者、指标；`isEssential` + `essentialReason` 支撑必备 Skill onboarding。 |
| SkillVersion / Skill Contract | `src/collections/SkillVersions.ts`、`src/lib/skillContract.ts`、`src/lib/skillContractPublic.ts` | 已有 prompt、input/output schema、permissions、examples、recommended models、routePolicy；自动生成 `contractHash`，并标记初始/兼容/破坏性变更；公开 Contract 只输出 hash/schema/权限摘要、可选基线 diff 和客户复核 playbook，Skill 详情页可视化并筛选破坏性/兼容字段变化，prompt/examples/changelog 原文按字段权限隐藏。 |
| Manifest 快照 | `src/collections/SkillArtifacts.ts` | 发布时冻结 manifest/checksum/signature；原始集合仅后台可读，公开下载走 `/v1/skills/[slug]/manifest`；无 manifest 走人工审核。 |
| Runner | `runner/hengshu.mjs`、`src/lib/runnerInstallPlaybook.ts`、`src/lib/runnerUpdatePlaybook.ts`、`src/app/v1/runner/install/route.ts` | 支持安装、本地运行、验签和兼容报告回流；安装/检查更新响应返回“验签 → 本地运行 → 脱敏回流 → 更新/复验”的客户指引，避免把 Runner 只做成下载器。 |
| SkillRuns 私人台账 | `src/collections/SkillRuns.ts`、`src/app/v1/runs/route.ts`、`src/app/v1/runs/[id]/rerun/route.ts` | 输入/输出加密；记录模型、成本、延迟、错误；支持多维筛选导出、换模型一键重跑、重跑血缘，并为失败运行输出模型画像/失败库排障入口。 |
| CompatReports 活体数据 | `src/collections/CompatReports.ts`、`src/lib/compat.ts` | 脱敏兼容报告；时间衰减 + 来源权重聚合；优先按 `modelProfile`/版本分组；前台展示有效样本与来源权重摘要。 |
| SkillPassport | `src/collections/SkillPassports.ts`、`src/lib/passport.ts`、`src/lib/passportRefresh.ts`、`src/lib/passportPublic.ts` | 随 Runner/online/benchmark 回流自动刷新；写入 evidenceHash 和证据快照；原始集合仅后台可读，公开读取走脱敏 Passport API，并返回“看当前性/可信分 → 验签证据/证书 → 查 Contract → 用自己模型试跑”的客户复核 playbook。 |
| ModelProfile | `src/collections/ModelProfiles.ts`、`src/lib/modelProfile.ts`、`src/lib/modelProfilePublic.ts` | 支持 modelName + modelVersion；刷新 worker；记录 `driftHistory` 漂移曲线、inputBucket 表现和 taskProfile 表现；回归/漂移告警；保留有效样本与来源权重；原始集合仅后台可读，公开读取走脱敏模型画像 API，并返回采用复验 checklist 与私人台账复验入口。 |
| CompatTestCase | `src/collections/CompatTestCases.ts`、`src/lib/benchmark.ts`、`src/lib/benchmarkScoring.ts` | benchmark 优先读取测试用例，再回退 examples/schema；支持按黄金样例 requiredOutputPaths / expectedTextIncludes 逐条打分，并把 case 分数写回兼容报告；测试输入原文仅作者/审核/管理可读。 |
| FailureCase | `src/collections/FailureCases.ts`、`src/lib/failureKnowledge.ts`、`src/lib/failureRefresh.ts`、`src/lib/failureCasePublic.ts`、`src/lib/reverifyPlan.ts`、`src/lib/reverifyQueue.ts`、`src/lib/reverifyWorker.ts`、`src/worker/reverify-queue.ts` | 按 Skill × 输入档 × errorType 聚合任务失败画像；随失败回流自动刷新并写证据快照；原始集合仅后台可读，公开读取走脱敏失败库 API，并返回人工归因摘要、复验覆盖、triage checklist、私人台账复现、自动复验计划、批量复验入队、worker 结果回写、模型画像、Adapter 和证据验签入口；`/console/failures/triage` 提供审核员归因看板。 |
| AdapterProfile | `src/collections/AdapterProfiles.ts`、`src/lib/adapterProfile.ts`、`src/lib/adapterProfilePublic.ts`、`src/app/v1/failures/[id]/adapter/route.ts` | Skill × Model/Profile 的 prompt/schema/decoding/retry 补丁；运行时应用；自动 evidenceHash/快照；刷新 before/after lift；支持从 FailureCase 生成待审核草稿；未批准草稿不得启用 active；`/console/adapters/review` 提供前台评审看板，公开 API 只读已批准 active Adapter，返回复用/复验 checklist、私人台账复验入口和证据验签入口；原始补丁正文仅作者/审核/管理可读。 |
| EvidenceSnapshots | `src/collections/EvidenceSnapshots.ts`、`src/lib/evidenceSnapshot.ts`、`src/lib/evidenceSnapshotVerify.ts`、`src/lib/evidenceAnchor.ts` | Passport / FailureCase / Adapter 的 append-only 证据快照；原始集合仅后台可读；公开验签必须带已知 targetType/targetId，不允许匿名枚举；支持 JSONL 外锚导出、manifest 自签/校验，以及第三方发布/时间戳声明。 |
| 公开验签 | `src/app/(frontend)/verify/page.tsx`、`src/components/verify/CertificateVerifyForm.tsx`、`src/components/verify/EvidenceVerifyForm.tsx`、`src/components/verify/AnchorVerifyForm.tsx`、`src/app/v1/evidence/verify/route.ts`、`src/app/v1/anchors/verify/route.ts`、`src/app/v1/certificates/verify/route.ts`、`src/app/v1/skills/[slug]/passport/route.ts`、`src/lib/scoreAnchor.ts`、`src/lib/skillCertificateVerify.ts` | 分数快照、证据快照、Skill Passport 和达标证书均可公开复核；达标证书可通过 `/verify?certificateUrl=...` 直达自动加载并验签；证据快照表单可输入或通过 `/verify?targetType=...&targetId=...` 直达展示脱敏 targetSummary、payloadHash 和签名状态；Passport API 也返回带 evidenceHash 的黄金样例基准摘要；分数/证据外锚 manifest 支持 ed25519 自签/校验、可信发布目标/外部时间戳可信等级、第三方时间戳 imprint 请求包、页面粘贴校验和公开 API 校验，并返回采购/审计复核 playbook。 |
| Enterprise Registry | `src/collections/Organizations.ts`、`OrganizationMembers.ts`、`EnterpriseRegistries.ts`、`src/app/v1/enterprise/registry/route.ts`、`members/route.ts`、`identity/route.ts`、`identity/authorize/route.ts`、`identity/callback/route.ts`、`/console/enterprise` | 组织、成员、批准 Skill、模型白名单与治理边界；支持审批准入、成员增删改、组织内 Passport 读取、准入治理 checklist、审计/失败库入口、基础策略包执行、策略模板编辑和身份策略配置；添加成员时执行邮箱域/SSO 策略；OIDC SSO 已能生成 authorize 发起包、签名 state，并在 callback 校验后还原组织上下文、输出 tokenExchange 请求包、校验 ID Token claims 并预检 active 成员绑定。 |
| 企业运行授权 | `src/lib/enterprise.ts`、`src/app/v1/skills/[slug]/run/route.ts`、`compare/route.ts` | 企业 Skill 或传 organizationId 时必须组织成员 + approved registry。 |
| 企业运行审计 / 失败知识 | `src/collections/EnterpriseAuditLogs.ts`、`src/app/v1/enterprise/audit/export/route.ts`、`src/app/v1/enterprise/failures/route.ts` | 成功/失败/策略拒绝均可审计；CSV 导出；可按组织聚合脱敏失败知识和模型版本分布；不含输入输出原文。 |
| 上传审核 | `src/lib/skillComplianceReview.ts`、`src/app/v1/skills/route.ts` | 规则 + AI 审核 + 人工兜底；低风险 Prompt Skill 才能自动上架。 |
| Import Adapters | `src/lib/skillPackage.ts`、`src/lib/skillSourceImport.ts`、`src/worker/import-skill-sources.ts` | 无 Hengshu manifest 的 GitHub README / Claude Skill `SKILL.md` / GPTs 配置可转成 Imported Skill 的初始 Prompt Contract，默认仍走人工审核；支持来源清单批量导入、内容 hash、手动同步和变更差分。 |

## 当前关键数据闭环

```text
真实运行 / Runner 回流 / benchmark
→ CompatReports
→ 兼容分（localScore）+ dataDriven routePolicy
→ SkillPassport + EvidenceSnapshot
→ ModelProfile freshness / regressionAlerts
→ FailureCase 任务失败画像 + EvidenceSnapshot
→ 前台详情页 / 模型榜 / 失败库 / 公开验签 API
```

## 已接入的前台触点

| 页面/API | 当前能力 |
|---|---|
| 首页 + `/skills` | 首页“先跑必备 Skill”新手入口；必备卡片展示“为什么先跑”；首页 SkillCard 展示 Passport 可信分；首页引导从已有运行证据的 Skill fork 成新版本；`/skills?essential=1` 必备筛选；市场顶部 Starter Pack；必备页展示“看 Passport → 默认输入试跑 → 回控制台看台账/重跑”的新手路径；列表展示 Passport 可信分和证据入口，并可直达试跑页和该 Skill 私人台账；分类、搜索、排序。 |
| `/v1/skills` | 公开 Skill 摘要列表 API，支持 `essential=1` 输出必备 Skill starter pack，并返回必备推荐理由、新手 starterPlaybook、可信榜排序依据、Passport 可信摘要、证据入口、证书入口、试跑入口和台账入口。 |
| `/v1/skills/[slug]/contract` | 公开读取能力契约摘要；返回 contractHash、promptHash、schema/权限摘要、availableBaselines 和可选 compareVersion/compareVersionId 基线 diff，并给出“核对 Hash → 检查破坏性变更 → 验签证书 → 试跑/重跑”的复核 playbook，不暴露 prompt 正文。 |
| `/skills/[slug]` | Passport 区块、Contract diff 可视化与破坏性/兼容筛选、证据快照摘要、黄金样例基准分、公开 Contract/Passport API、达标证书可视化验签入口、证据验签入口、兼容矩阵；兼容矩阵可跳转模型画像、该 Skill×模型失败库与 Adapter API。 |
| `/skills/[slug]/run` | 在线试跑页；运行前展示 Passport 可信分，并提供 Passport、Contract、达标证书和证据验签入口；运行请求可携带 modelProvider/modelVersion，结果进入私人台账并按模型版本回流兼容证据。 |
| `/v1/runner/install` | Runner 登录后安装公开 Skill；返回冻结 manifest、checksum、版本和安装 playbook，提示先验签、再绑定本地/自有网关运行、只回传脱敏兼容报告，并在 checksum 变化时先更新。 |
| `/v1/runner/check` | Runner 检查本地安装 checksum 是否过期；返回更新复验 playbook，提示过期 Skill 先 update、重新验签，再用同一输入复验并回流。 |
| `/v1/runner/report` | Runner 本地兼容回流；要求当前 Runner 存在 active install 且 checksum 匹配，只存成功率、格式、延迟、错误类型、输入/输出大小档等指标，不存输入/输出原文。 |
| `/models` | 中立模型榜；显示 ModelProfile 稳定/回归告警、输入规模档/任务画像/Skill任务画像表现、来源权重、有效样本、客户决策步骤和画像筛选表单；每行可跳转模型画像 API、该模型失败库与 Adapter API，不污染排序。 |
| `/v1/model-profiles` | 公开读取模型画像、版本漂移、输入规模档/任务画像/Skill任务画像表现、回归告警、有效样本、来源权重和 use/trial/review/avoid 决策 playbook；支持 modelName/modelVersion/provider/status 过滤；返回采用复验 checklist、私人台账复验、失败库和 Adapter 排障入口，不暴露平台收益字段。 |
| `/failures` | 优先读取 FailureCases；展示“发现失败模式 → 生成 Adapter 草稿 → 复验 lift”的闭环和“客户怎么用”排障步骤；展示 profileKey、主输入档、模型分布、Adapter 建议、Adapter 复用/复验说明、模型画像入口、Adapter API、失败/Adapter 证据验签入口和多维筛选表单；只有 Skill 作者、审核员或管理员可从失败案例生成待人工评审 Adapter 草稿并直达后台草稿审核。 |
| `/v1/failures` | 公开读取脱敏 FailureCase 列表、人工归因摘要、复验覆盖、客户排障 playbook、triage checklist、私人台账复现入口、修复/复验建议、模型/来源分布、模型画像/Adapter/复验计划入口和 API/页面证据验签入口；支持 errorType/modelName/modelVersion/status/skillId/profileKey/inputBucket/source 过滤。 |
| `/rank` | 可信发现榜；公开说明排序口径，把可信分（skillRank）、成功率、可信兼容运行数和 Passport 可信分放在一起，并提供公开 Passport 证据入口，避免把下载量/普通调用量当成可信度。 |
| `/bounties` | 求术悬赏；引导用户把需求写成可验收标准，创作者交付可版本化、可签名、可进入 Passport 闭环的 Skill，而不是一次性答案。 |
| `/console` | 个人控制台概览；展示已安装 Skill、Runner、私人台账、兼容贡献，并突出私人运行台账的总运行、成功、格式有效、可信兼容和换模型重跑。 |
| `/console/skills/new` | 创作者发布页；按“上传包 → 生成 Contract → 刷新 Passport → 适配维护”解释发布闭环，并提示 manifest、schema、示例、权限和推荐模型会影响 Passport/证书质量；提交成功后展示 Contract/Passport/证书/失败库维护 playbook；待审阶段证据入口按作者预览口径展示。 |
| `/console/skills` | 我的作品；每个 Skill 展示发布状态、可信兼容运行数、Contract 状态、Passport 可信分，并直达 Contract、Passport、证书/预览、失败库/Adapter。 |
| `/console/runs` | 私人运行台账；页面按 Skill/模型/路由/成功/格式/可信兼容/重跑来源筛选；查看输入/输出；导出账本指标或本人输入/输出并沿用筛选；推荐模型或自定义 OpenAI 兼容模型名重跑；重跑血缘；展示重跑前后成本/延迟/成功结果对比；失败运行可直达模型画像和失败库；顶部解释“历史输入 → 换模型重跑 → 省钱回执 → 失败修复”的切换成本闭环。 |
| `/v1/runs` | 当前用户私人运行台账导出 API；支持 skillId/model/modelVersion/routeMode/success/formatValid/trustedCompatible/rerunOf 过滤；默认只导出账本指标，同时返回 `modelProfileUrl`、`trustedCompatible`、失败运行的 `failureKnowledgeUrl` 与换模型重跑 playbook；`includeIO=1` 时仅本人导出输入/输出；导出动作写入审计日志。 |
| `/docs` | 面向用户的模块化功能说明；首页按“找 Skill / 本地 Runner / 发布 / 私人台账 / 公开验签 / 企业 Registry”六条路径直达关键入口。 |
| `/verify` | 解释分数快照、达标证书、证据快照、外锚包四类证据链和客户复核路径；分数快照验签列表 + 达标证书在线验签表单（支持 certificateUrl 自动加载、展示绑定 Contract 与准入复核指引）+ 证据快照在线验签表单（支持 query 参数直达并展示 targetSummary）+ 外锚包在线校验表单；可粘贴证书、score/evidence JSONL、manifest、可信发布目标和时间戳 receipt，并展示外锚可信等级、复核清单和下一步处理建议。 |
| `/v1/evidence/verify` | 公开验证已知 Passport/FailureCase/Adapter 证据快照；必须带 `targetType` 和 `targetId`，返回公开脱敏 `targetSummary`、payloadHash 和签名状态，不允许匿名枚举全部证据快照。 |
| `/v1/anchors/verify` | 公开校验 score/evidence 外锚 JSONL + manifest，返回链头、行数、文件哈希、签名校验结果、可信发布目标命中状态、外部时间戳 receiptHash 校验结果和 `assurance.level`（chain_only/self_signed/trusted_published/external_timestamped）；可信发布目标可在部署设置配置；响应附带 accept/review/archive_only/reject 决策 playbook，方便采购、审计或 CI 复核。 |
| `/v1/certificates/verify` | 公开校验绑定 Contract 摘要的 Skill 达标证书 certificateHash 与 ed25519 签名；支持完整证书响应或裸 certificate 对象，返回 valid/unsigned/hash_mismatch/key_unavailable/signature_invalid，并带证书绑定的 Contract/Passport/基准摘要、`statusReasons` 和 accept/review/reject 客户复核 playbook 供页面、采购或企业 Registry 准入使用。 |
| `worker:preflight-private` | NAS/私有部署 readiness：允许内网 HTTP，但阻断默认密钥/弱数据库密码/URL 不同源/非法端口，并提示备份与媒体持久化。 |
| `worker:preflight-production` | 生产上线前检查可信发布目标格式；缺失只警告，非法 URL / 空目标阻断。 |
| `/v1/skills/[slug]/contract` | 公开读取 Skill 能力契约摘要、contractHash、prompt hash、availableBaselines、可选 compareVersion/compareVersionId 基线 diff 和客户复核 playbook；详情页同步展示 diff；diff 对 prompt 只给 hash，对 routePolicy 去除 dataDriven，不暴露 prompt 正文。 |
| `/v1/skills/[slug]/passport` | 公开读取清洗后的 Skill Passport + 黄金样例摘要 + 可信兼容运行计数 + API/页面证据验签入口 + 最新证据验签摘要 + 客户复核 playbook。 |
| `/v1/skills/[slug]/certificate` | 公开读取 Skill 达标证书：合并 Contract 摘要、Passport、可信兼容运行计数、黄金样例逐条摘要、证据快照验签状态，输出 certificateHash、ed25519 签名、Passport 证据验签页面入口和未达正式达标原因。 |
| `/v1/enterprise/audit/export` | 企业审计 CSV 导出，含模型版本治理元数据，不含输入输出原文。 |
| `/v1/enterprise/failures` | 组织内失败知识库，只从企业审计元数据聚合，含模型版本分布，不暴露输入输出。 |
| `/v1/enterprise/registry` + `/console/enterprise` | GET 返回内置策略模板；POST 更新准入/白名单/策略包并返回治理 checklist/playbook；控制台展示“批准 Skill → 绑定策略 → 留审计 → 查失败库”治理闭环，可编辑 Registry 策略模板并直达组织内 Passport/证书状态、审计导出（含模型版本）和企业失败知识库。 |
| `/v1/enterprise/identity` + `/console/enterprise` | 更新组织身份策略：邮箱域白名单、requireSso、OIDC provider/issuer/clientId/discoveryUrl、SCIM baseUrl/tokenDigest；保存时阻断非 HTTPS URL、缺失 OIDC 必填项和非法 tokenDigest；返回身份接入 playbook，串起域名白名单、SSO 测试、SCIM 同步和成员边界复核。 |
| `/v1/enterprise/identity/authorize` + `/v1/enterprise/identity/callback` | 企业 OIDC SSO 连接器骨架；authorize 返回 IdP 跳转 URL、callbackUrl、HMAC state/nonce 和接入 playbook；callback 校验 state 后还原 organizationId/redirectPath，并返回不含明文授权码的 tokenExchange 请求包；可选 `id_token` 会校验 issuer/audience/exp/nonce/email/email_verified、邮箱域白名单和组织 active 成员绑定，JWKS 签名校验后续接真实 IdP。 |
| `/v1/enterprise/scim/users` | SCIM provision 入口：用 Bearer token digest 校验后，兼容 `userName`/`emails`/`roles` payload、`userName/email/emails.value eq` filter 和 PATCH Operations；支持按 email 查询、无 email 返回 ListResponse、创建/绑定或停用组织成员。 |
| `/v1/enterprise/members` | 添加/更新/移除组织成员；添加 active 成员时执行组织身份策略，移除时保留 suspended 记录。 |
| `/v1/enterprise/registry/[id]/passport` | 组织内读取已批准/可审 Registry 的 Skill Passport、治理状态、准入治理 checklist、证据验签摘要、证书状态摘要、审计/失败库入口和绑定 Contract 的达标证书，便于企业采购/审计复核。 |
| `worker:export-evidence-anchors` / `worker:verify-evidence-anchors` | 导出证据快照 JSONL 哈希链，并用 manifest 校验行数、链头、文件哈希、manifest ed25519 自签名和第三方发布/时间戳声明格式；`/v1/anchors/timestamp-request` 可为 manifest 生成第三方时间戳 imprint 请求包。 |
| `/v1/adapters` | 公开读取已批准 active Adapter 的 lift 效果摘要、复用/复验 checklist、私人台账复验入口、模型画像入口和 API/页面证据验签入口；支持 skillId/modelName/modelVersion/failureType/failureId/modelProfile 过滤，不暴露 prompt/schema/decoding 补丁正文、未批准草稿或停用补丁。 |
| `/v1/failures/[id]/triage` | 审核员为失败案例写入人工归因、根因分类和复验覆盖；公开失败库只展示脱敏摘要。 |
| `/v1/failures/[id]/reverify-plan` | 登录用户基于自己的私人台账生成候选失败运行、rerunUrl、覆盖缺口和已批准 Adapter 复验动作；不返回原始输入输出或补丁正文。 |
| `/v1/failures/[id]/reverify-queue` + `worker:reverify-queue` | 登录用户把 reverify-plan 放入 Redis 批量复验队列；按 failureCaseId+userId 去重，返回 plan、queued 状态和 jobPreview；worker 消费候选历史运行、沿用私人台账输入重跑、回写 verificationCoverage；未配置 Redis 时显式 503 降级。 |
| `/console/failures/triage` | 审核员前台失败归因看板；集中查看待归因 FailureCase、模型/版本/输入档、影响范围和复验覆盖，可写入根因分类与脱敏归因备注。 |
| `/v1/failures/[id]/adapter` | 从失败案例生成 Adapter 待评审草稿；只有审核员通过 `/console/adapters/review` 或后台批准后才能启用 active。 |
| `/console/adapters/review` | 审核员前台 Adapter 评审看板；集中查看待评审草稿、来源 FailureCase、模型/版本、lift 摘要和私人台账复验入口，可批准启用、要求修改或拒绝。 |
| `/v1/skills` 包上传 | 支持 Hengshu Skill 包；也可导入 GitHub README、Claude Skill `SKILL.md`、GPTs 配置为待审 Imported Skill。 |
| `worker:import-skill-sources` / `worker:sync-skill-sources` | 从 JSON 来源清单批量导入 GitHub README / Claude Skill / GPTs / Skill 包；用稳定来源键幂等创建，另存内容 hash；`--sync`/同步 worker 命中内容变化时生成新版本并记录差分，可直接挂 cron。 |

## 半落地 / 下一步

| 能力 | 现状 | 下一步 |
|---|---|---|
| SSO / SCIM | 配置校验 + 最小 SCIM provision + OIDC claims/成员绑定预检 + 接入 playbook | `Organizations.identityPolicy` + `/v1/enterprise/identity` + `/v1/enterprise/scim/users` + 控制台身份策略面板已承接 domainAllowlist、requireSso、OIDC、SCIM 配置；保存时校验 HTTPS URL、OIDC 必填项与 tokenDigest；SCIM 已支持查询、ListResponse 列表、`userName/email/emails.value eq` filter、PATCH Operations、创建/绑定、停用成员；callback 已校验 ID Token claims、邮箱域和 active 成员绑定；后续补 JWKS 签名校验、正式会话签发、SAML 登录和更复杂的 SCIM filter 兼容。 |

## 当前开发原则

- 前台主叙事：可信、兼容、可治理。
- 可信榜/模型榜只展示中立事实，不把平台收益纳入排序。
- 成本优化路由、New API、credit：保留为后台履约/优化能力，不作为主叙事。
- 无 manifest 的 Skill：可收录、可预览、可人工审核，但不得自动 Verified 上架。
- 公开聚合不得暴露 prompt 正文、examples 原文、原始输入输出、平台收益或内部日志；企业审计只记录治理元数据、模型版本和规模档。
- Payload 原始集合默认不作为公开接口；Passport / FailureCase / ModelProfile / Adapter / EvidenceSnapshot / SkillArtifact 等公开能力必须走 `/v1` 脱敏 API 或专门下载/验签端点。
- 评论与悬赏原始集合也按状态过滤：匿名只读 visible 评论和 public 悬赏；待审/隐藏评论、私有悬赏只给本人、接单人或审核/管理查看。
- 失败库公开 API 只暴露 observed / confirmed / fixed；ignored 仅留作后台内部降噪状态，不能被 query 参数枚举出来。
- 公开已发布 Skill 的 Passport / 证书端点只读取 current Passport；draft/stale 仅用于作者、审核员或管理员预览，避免把待审证据当成正式可信结论。
- Skill 详情页和 SEO metadata 也复用同一公开判断：匿名只看 published + public；private / unlisted / enterprise 即使已发布也只给作者、审核员、管理员或企业管理员预览。
- 企业运行/对比端点不再用 Payload 公开读权限做预检；服务端读取后由 `runSkill` 按最终模型、输入规模、routeMode、BYOK 和 Registry 策略统一校验并写审计，避免模型白名单在路由前因缺少最终模型而误拦截。
- 企业控制台 Registry 卡片提供“组织上下文试跑”，跳转时携带 `organizationId`，保证网页试跑也进入企业策略、审计和失败知识库闭环。
- 悬赏认领即使服务端用 id 读取，也必须校验 `isPublic` 和 `open` 状态；私有悬赏不能被知道 id 的陌生用户抢单。
- 悬赏交付物必须是接单人本人公开已发布的 Skill，避免用不可见草稿、私有 Skill 或他人热门 Skill 冒充可复用交付。
- 私有悬赏详情页服务端读取后再执行统一可见性判断：只给发布人、接单人、审核员或管理员查看，匿名和无关用户不可通过 id 访问。
