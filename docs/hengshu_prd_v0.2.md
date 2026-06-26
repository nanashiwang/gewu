# 衡术 Hengshu PRD v0.2

> AI Skill 注册表、本地运行分发平台、贡献驱动社区与兼容性评测网络  
> 文档版本：v0.2  
> 规划阶段：产品规划 / MVP 后续迭代  
> 当前原则：暂不规划 New API 联动，优先完善独立 Skill 平台闭环  
> 产品口号：让 AI Skill 被发现、安装、更新、评测、复用和共建

---

## 1. 文档目的

本文档用于明确「衡术 Hengshu」下一阶段的产品方向、功能范围、用户路径、数据结构、隐私边界、贡献机制和迭代计划。

当前衡术已经完成 MVP 的端到端验证：用户可以浏览 Skill 市场、在线试用、下载 Skill Manifest，并通过本地 Runner 或自有模型端点运行。下一阶段的重点不是继续堆叠页面，而是把衡术从「Skill 下载站」升级为：

> 可安装、可更新、可反馈、可排名、可共建的 AI Skill 分发社区。

---

## 2. 产品定位

### 2.1 一句话定位

**衡术 Hengshu 是一个面向本地模型和自有模型端点用户的 AI Skill 注册表、Runner 分发平台、兼容性评测网络与贡献驱动社区。**

### 2.2 产品不是什么

衡术不是：

- 单纯的 Prompt 模板站；
- 单纯的 AI 工作流 SaaS；
- 单纯的云端模型调用平台；
- 单纯的下载资源站；
- 一个要求用户持续在线使用的 Web 工具。

### 2.3 产品是什么

衡术是：

- AI Skill 的注册表；
- 可下载 Skill Manifest 的分发平台；
- 本地 Runner 的管理入口；
- 本地模型兼容性数据网络；
- 贡献驱动的 Skill 社区；
- 创作者发布、维护、认领需求的工作台；
- 团队后续沉淀私有 AI 能力资产的基础。

### 2.4 核心差异

普通 Skill / Prompt 市场解决的是：

> 有没有这个 Prompt？

衡术要解决的是：

> 这个 Skill 能不能安装？能不能更新？在哪些模型上能跑？输出稳不稳？谁在维护？社区反馈如何？我能不能求一个更适合自己的版本？

---

## 3. 背景与问题

### 3.1 当前已具备基础

衡术 MVP 已具备以下基础能力：

- Skill 市场；
- Skill 详情页；
- Skill Manifest YAML / JSON 下载；
- 本地 Runner 最小实现；
- 在线运行和多模型对比；
- 收藏、评论、邀请、悬赏等基础社区功能；
- Payload Admin 后台；
- SkillRank 和基础统计能力；
- Docker 容器化部署。

### 3.2 当前主要问题

如果衡术只停留在「找 Skill、下载 Skill」的形态，会遇到几个问题：

1. **用户低频**：用户只有需要 Skill 时才访问，用不到就不上线。
2. **下载即离站**：Manifest 下载后，用户可直接本地使用，平台可能退化成下载页。
3. **缺少持续触点**：没有更新、任务台、兼容榜、创作者数据时，用户没有反复回来的理由。
4. **贡献价值难判断**：下载量不等于真实价值，容易被刷。
5. **市场天花板不清晰**：单纯 Skill 市场未必足够大，需要扩展为 AI 能力资产管理和评测网络。

### 3.3 核心改造方向

将产品从：

> Skill 下载市场

升级为：

> Skill 注册表 + 我的术台 + 本地 Runner + 兼容性评测网络 + 求术社区 + 创作者发布组

---

## 4. 产品目标

### 4.1 v0.2 目标

v0.2 的目标是让衡术完成从「可下载」到「可安装、可更新、可反馈」的升级。

核心交付：

1. Hengshu Skill Spec v1；
2. Hengshu Runner v0.2；
3. 我的术台；
4. Skill 更新机制；
5. 本地模型兼容报告；
6. 术值贡献体系 2.0；
7. 求术广场闭环。

### 4.2 业务目标

- 提升用户二次访问率；
- 让用户在本地运行后仍然需要回到衡术查看更新、兼容性和社区反馈；
- 让创作者有持续维护 Skill 的动机；
- 让平台沉淀本地模型兼容数据，而不是只沉淀下载次数；
- 让需求通过「求术」机制转化为新的 Skill 供给。

### 4.3 非目标

v0.2 暂不重点做：

- 复杂云端托管运行；
- 大规模工作流画布；
- 任意代码执行型 Skill；
- 企业私有部署商业化；
- 创作者现金分账；
- 完整模型网关联动；
- 大规模自动化评测平台。

---

## 5. 目标用户

### 5.1 使用者

特征：

- 有本地模型或自有模型端点；
- 会使用 CLI 或愿意复制命令；
- 需要现成 Skill 完成具体任务；
- 关心安装、运行、输出质量和模型兼容性。

典型需求：

- 找到一个能在本地模型上跑的 Skill；
- 快速安装并运行；
- 查看哪个模型更适合这个 Skill；
- 获得更新提醒；
- 管理自己常用的 Skill。

### 5.2 创作者

特征：

- 会编写 Prompt / Manifest；
- 愿意维护 Skill；
- 需要曝光、反馈、排名和术值激励；
- 可能以发布组形式持续产出。

典型需求：

- 发布 Skill；
- 查看下载、安装、反馈和兼容报告；
- 根据失败反馈修复版本；
- 认领求术任务；
- 提升发布组排名。

### 5.3 团队用户

特征：

- 有内部 AI 使用场景；
- 需要沉淀私有 Skill；
- 关心版本、权限和隐私；
- 未来可能需要私有术库或企业内网 Runner。

v0.2 仅为该类用户预留结构，不作为主交付。

---

## 6. 核心产品闭环

### 6.1 使用闭环

```text
发现 Skill
↓
查看详情、示例、兼容报告
↓
安装 Skill
↓
本地 Runner 运行
↓
检查更新 / 查看失败原因
↓
可选提交兼容报告 / 评价
↓
SkillRank 更新
↓
用户获得术值，作者获得反馈
```

### 6.2 创作闭环

```text
发现需求 / 认领求术
↓
创建 Skill Manifest
↓
提交审核
↓
发布到术库
↓
获得安装、反馈、兼容报告
↓
迭代版本
↓
提升排名和术值
```

### 6.3 社区闭环

```text
用户发布求术
↓
创作者认领
↓
提交 Skill
↓
需求方验收
↓
Skill 入库
↓
术值发放
↓
优质创作者获得更多曝光
```

---

## 7. 产品模块规划

## 7.1 术库

术库是公开 Skill 注册表。

### 功能范围

- Skill 列表；
- 分类筛选；
- 排序：最新、热门、SkillRank、LocalScore、安装量、更新时间；
- 搜索；
- 标签；
- 官方精选；
- 发布组筛选；
- Skill 包 / 专题。

### 列表字段

每个 Skill 卡片展示：

- 名称；
- 简介；
- 分类 / 标签；
- 作者 / 发布组；
- 当前版本；
- SkillRank；
- LocalScore；
- 安装量；
- 更新时间；
- 是否 Verified；
- 是否支持本地运行；
- 是否有兼容报告。

---

## 7.2 Skill 详情页

详情页是判断 Skill 是否值得安装的核心页面。

### 页面结构

1. 基础信息区；
2. 安装命令区；
3. 输入字段说明；
4. 输出格式说明；
5. 示例输入 / 输出；
6. 推荐运行环境；
7. 本地模型兼容报告；
8. 版本历史；
9. 评论 / Issue / 反馈；
10. 相似 Skill；
11. 关联求术。

### 核心操作

- `hengshu install <slug>`；
- 下载 YAML；
- 下载 JSON；
- 收藏；
- 反馈问题；
- 提交兼容报告；
- 查看更新日志。

---

## 7.3 我的术台

我的术台是提升粘性的关键模块。

### 定位

用户不是每次都来市场搜索，而是进入自己的 AI Skill 工作台。

### 功能范围

- 已安装 Skill；
- 已收藏 Skill；
- 最近运行；
- 待更新 Skill；
- 常用模型配置；
- 失败记录；
- 推荐替代 Skill；
- 我的术值；
- 我的兼容报告；
- 我的求术；
- 我的评论和反馈。

### 核心提醒

- 有新版本；
- 当前版本已废弃；
- 有兼容性改善；
- 收藏 Skill 有新评论；
- 求术有人认领；
- 发布的反馈已被修复。

---

## 7.4 Hengshu Runner

Runner 是衡术的本地触点。

### v0.2 命令

```bash
hengshu login
hengshu install <slug>
hengshu list
hengshu run <slug> --in key=value
hengshu update <slug>
hengshu outdated
hengshu remove <slug>
hengshu doctor
hengshu config
```

### 本地目录

```text
~/.hengshu/
├── config.json
├── skills/
│   └── <skill-slug>/
│       ├── skill.yaml
│       ├── README.md
│       ├── examples.json
│       └── changelog.md
├── runs/
│   └── runs.jsonl
├── cache/
└── logs/
```

### Runner v0.2 必须支持

- 安装 Skill 到本地；
- 本地缓存；
- 查看已安装 Skill；
- 更新 Skill；
- 回滚版本；
- 检查 endpoint 是否可用；
- 检查模型是否可用；
- 本地运行记录；
- 可选匿名兼容报告；
- 完全离线模式。

---

## 7.5 本地模型兼容榜

### 定位

兼容榜是衡术区别于普通 Prompt 市场的核心资产。

### 展示维度

- Skill × Model 矩阵；
- 成功率；
- JSON 成功率；
- 平均耗时；
- 报告数量；
- 最近更新时间；
- 推荐模型；
- 不推荐模型；
- 常见失败原因。

### 示例表格

| Skill | qwen2.5:14b | llama3.1:8b | deepseek-r1:14b | gemma3:12b |
|---|---:|---:|---:|---:|
| 小红书标题生成器 | 92 | 75 | 88 | 81 |
| 合同摘要助手 | 84 | 61 | 80 | 70 |
| AI 评审一致性检测 | 78 | 52 | 86 | 64 |

---

## 7.6 求术广场

求术广场用于把用户需求转化为 Skill 供给。

### 流程

```text
发布需求
↓
设置术值悬赏
↓
创作者认领
↓
提交 Skill
↓
需求方验收
↓
Skill 入库
↓
术值发放
```

### 求术字段

- 标题；
- 场景说明；
- 输入示例；
- 期望输出；
- 是否要求本地运行；
- 推荐模型类型；
- 隐私要求；
- 悬赏术值；
- 截止时间；
- 验收标准。

### 状态

- 待认领；
- 进行中；
- 待验收；
- 已完成；
- 已关闭；
- 争议中。

---

## 7.7 创作者中心

### 功能范围

- 我的 Skill；
- 安装 / 下载 / 收藏数据；
- 兼容报告；
- 失败原因；
- 用户反馈；
- 待修复问题；
- 求术推荐；
- 术值收益；
- 发布组排名；
- 版本更新入口。

### 关键指标

- 有效安装数；
- 活跃安装数；
- 成功运行报告数；
- 平均评分；
- Issue 响应时间；
- 版本维护频率；
- LocalScore；
- TrustScore。

---

## 7.8 发布组

发布组用于形成类似 PT 站发布组的荣誉和供给秩序。

### 发布组类型

- 官方发布组；
- 写作创作组；
- 办公效率组；
- 教育心理组；
- 本地模型组；
- 评测质检组；
- 开发工具组。

### 发布组页面

- 组介绍；
- 成员；
- 已发布 Skill；
- 总安装量；
- 平均 SkillRank；
- 最近维护；
- 求术完成数；
- 徽章与等级。

---

## 7.9 术榜

术榜不只展示热门，还展示质量和维护。

### 榜单类型

- 综合 SkillRank；
- 本地兼容榜；
- 最新高分 Skill；
- 本周维护榜；
- 发布组榜；
- 求术完成榜；
- 小模型友好榜；
- JSON 稳定输出榜。

---

## 8. Hengshu Skill Spec v1

### 8.1 目标

将 Skill 从页面内容升级为可分发、可安装、可校验、可更新的标准包。

### 8.2 Manifest 示例

```yaml
schema_version: hengshu.skill/v1
id: xhs-title-generator
name: 小红书标题生成器
version: 1.0.0
author: content-lab
license: CC-BY-NC-4.0
category: writing

runtime:
  type: prompt
  min_runner_version: 0.2.0
  permissions:
    network: false
    file_read: false
    file_write: false
    shell: false

input_schema:
  topic:
    type: string
    label: 主题
    required: true
  audience:
    type: string
    label: 目标人群
    required: false

output_schema:
  type: json
  fields:
    titles:
      type: array
    reason:
      type: string

prompt:
  system: |
    你是一名小红书内容策划专家。
  user_template: |
    请根据以下主题生成10个小红书标题：
    主题：{{topic}}
    目标人群：{{audience}}

models:
  local_recommended:
    - qwen2.5:14b
    - llama3.1:8b
  endpoint_type:
    - ollama
    - lmstudio
    - openai_compatible

examples:
  - input:
      topic: 秋季护肤
      audience: 30岁女性
    output:
      titles:
        - 秋天护肤别乱来，这3步比贵妇霜更重要
      reason: 突出季节痛点和实用价值

integrity:
  checksum: sha256:...
```

### 8.3 v1 支持类型

允许：

- Prompt Skill；
- 结构化输出 Skill；
- 只读 Workflow Skill。

暂不允许：

- 任意代码执行；
- Shell 执行；
- 自动浏览器控制；
- 自动读写本地文件；
- 自动登录第三方账号；
- 自动发送消息。

---

## 9. 术值贡献体系 2.0

### 9.1 原则

下载不能直接等于贡献。贡献应来自真实采用、有效反馈、持续维护和社区验证。

### 9.2 获取术值

| 行为 | 术值建议 |
|---|---:|
| 发布 Skill 草稿 | +5 |
| Skill 通过审核 | +30 |
| 提交新版本 | +5 |
| 被有效安装 | +1 |
| 被确认成功运行 | +2 |
| 提交兼容报告 | +3 |
| 兼容报告被采纳 | +5 |
| 解决求术悬赏 | +50～500 |
| 通过官方认证 | +100 |
| 被加入精选术库 | +100 |
| 高信誉用户五星评价 | +5 |

### 9.3 消耗术值

- 下载高级 Skill；
- 查看高级兼容报告；
- 发布求术悬赏；
- 申请创作者认证；
- 申请发布组；
- 申请官方评测；
- 置顶 Skill；
- 创建私有 Skill。

### 9.4 反作弊规则

- 同一用户同一 Skill 重复下载不计分；
- 作者自己下载不计分；
- 新用户评分权重较低；
- 匿名报告权重较低；
- 异常下载触发审核；
- 被举报 Skill 暂停贡献结算；
- 同 IP / 设备指纹异常行为降权。

---

## 10. 用户等级体系

| 等级 | 权限 |
|---|---|
| 游客 | 浏览公开 Skill |
| 普通成员 | 下载公开 Skill、收藏、评论 |
| 活跃成员 | 提交兼容报告、参与求术讨论 |
| 创作者 | 发布 Skill |
| 认证创作者 | 更高发布权重，部分免审 |
| 发布组成员 | 维护系列 Skill，创建 Skill 包 |
| 审核员 | 参与审核、处理举报、标注兼容报告 |
| 管理员 | 全站管理 |

升级依据：

- 术值；
- 信誉分；
- 注册时间；
- 贡献质量；
- 违规记录；
- 发布 Skill 的维护表现。

---

## 11. 隐私与兼容报告

### 11.1 原则

本地运行数据默认不回传。兼容报告必须由用户主动开启。

### 11.2 允许回传字段

```text
skill_id
skill_version
runner_version
model_provider
model_name
model_version
success
latency_ms
format_valid
error_type
input_size_bucket
output_size_bucket
```

### 11.3 禁止回传字段

```text
原始输入
原始输出
完整 prompt
文件内容
本地文件路径
API Key
用户业务名称
客户名称
```

### 11.4 隐私模式

| 模式 | 说明 |
|---|---|
| 完全离线 | 不登录、不检查更新、不回传任何数据，只运行本地 manifest |
| 基础连接 | 登录、下载、检查更新，不上传运行指标 |
| 匿名兼容贡献 | 上传匿名兼容指标，获得术值 |
| 完整评测贡献 | 用户主动上传测试集或评测结果，参与榜单 |

---

## 12. 数据模型规划

### 12.1 已有核心模型

- Users；
- Categories；
- Skills；
- SkillVersions；
- SkillRuns；
- Reviews；
- Favorites；
- InviteCodes；
- ContributionLogs；
- Bounties；
- Reports；
- Media；
- SiteSettings。

### 12.2 建议新增模型

#### SkillArtifacts

用于存放 manifest 包、checksum、签名、下载地址。

字段：

```text
skill_id
version_id
format
manifest_json
manifest_yaml
checksum
signature
file_size
download_url
created_at
```

#### SkillInstalls

记录安装事件，不等于下载事件。

```text
user_id
skill_id
version_id
runner_id
installed_at
last_used_at
status
```

#### RunnerClients

记录 Runner 实例。

```text
user_id
runner_id
runner_version
os
arch
anonymous_mode
last_seen_at
trusted_level
```

#### CompatReports

本地模型兼容报告。

```text
skill_id
version_id
runner_version
model_provider
model_name
model_version
success
latency_ms
format_valid
error_type
input_size_bucket
output_size_bucket
anonymous_user_hash
created_at
```

#### PublisherGroups

发布组。

```text
name
slug
description
members
verified
skill_count
rank_score
created_at
```

#### SkillIssues

问题反馈和改进建议。

```text
skill_id
version_id
user_id
type
content
status
assigned_to
created_at
updated_at
```

#### ContributionRules

术值规则配置。

```text
action_type
base_points
daily_limit
requires_verification
weight_by_user_level
enabled
```

#### SkillPackages

系列 Skill 包。

```text
name
slug
description
skills
publisher_group
price_type
visibility
created_at
```

---

## 13. 指标体系

### 13.1 用户指标

- 注册用户数；
- 活跃用户数；
- Runner 安装用户数；
- 二次访问率；
- 我的术台访问频次；
- 兼容报告提交率；
- 求术发布数。

### 13.2 Skill 指标

- 下载量；
- 安装量；
- 有效安装量；
- 更新率；
- 收藏数；
- 评论数；
- Issue 数；
- 兼容报告数；
- LocalScore；
- TrustScore；
- MaintainScore；
- CommunityScore。

### 13.3 创作者指标

- 发布 Skill 数；
- 被安装数；
- 被采纳求术数；
- 平均评分；
- 平均维护周期；
- Issue 响应时间；
- 术值收入。

### 13.4 社区指标

- 求术发布数；
- 求术完成率；
- 平均验收时间；
- 发布组活跃度；
- 兼容榜覆盖模型数；
- 本周新增高质量 Skill 数。

---

## 14. v0.2 迭代计划

### Sprint 1：Skill 标准化

目标：让 Skill 从页面内容变成可分发包。

任务：

- 定义 Hengshu Skill Spec v1；
- 新增 SkillArtifacts；
- manifest checksum；
- 版本 changelog；
- 官方 12 个 Skill 补 README、示例和输出 schema。

验收：

- 每个官方 Skill 都能下载完整包；
- 每个包都有版本、示例、输入输出说明；
- Manifest 能被 Runner 正确解析。

---

### Sprint 2：Runner 产品化

目标：用户可以真正把 Skill 装到本地。

任务：

- `hengshu install`；
- `hengshu list`；
- `hengshu run`；
- `hengshu update`；
- `hengshu doctor`；
- `~/.hengshu` 本地目录；
- Runner 安装页；
- Ollama / LM Studio 教程。

验收：

- 用户不打开网页也能运行已安装 Skill；
- Runner 能检查 endpoint 是否可用；
- Runner 能提示模型不存在、输出格式错误等常见问题。

---

### Sprint 3：兼容报告

目标：平台开始沉淀差异化数据。

任务：

- 新增 CompatReports；
- Runner `--report`；
- 匿名上报开关；
- 详情页兼容报告表；
- LocalScore 初版；
- 兼容报告术值奖励。

验收：

- Skill 详情页可以展示不同本地模型的成功率；
- 兼容报告不包含输入输出；
- 用户可以关闭回传。

---

### Sprint 4：贡献体系 2.0

目标：PT 式贡献秩序成立。

任务：

- 新增 ContributionRules；
- 有效安装计分；
- 兼容报告计分；
- 求术采纳计分；
- 作者术值结算；
- 用户等级；
- 反作弊限制。

验收：

- 下载不再直接等于贡献；
- 贡献值来源可解释；
- 用户能看到自己的术值流水；
- 作者能看到 Skill 带来的术值。

---

### Sprint 5：求术广场闭环

目标：让需求驱动内容增长。

任务：

- 求术认领；
- 提交 Skill 应答；
- 验收流程；
- 争议处理；
- 悬赏术值冻结；
- 完成后自动关联 Skill。

验收：

- 一个需求可以完整走完：发布 → 认领 → 提交 → 验收 → 发放术值。

---

## 15. v0.3 及后续路线

### v0.3：评测网络

- 本地模型兼容榜；
- Skill × Model 矩阵；
- LocalScore 优化；
- 每周榜单；
- 模型适配专题。

### v0.4：社区与发布组

- 发布组制度；
- 创作者工作台；
- 挑战赛；
- Skill Issue 讨论；
- 求术推荐。

### v0.5：团队与私有术库

- 团队空间；
- 私有 Skill；
- 成员权限；
- 私有 Runner；
- 内部版本审核；
- 私有兼容报告。

---

## 16. 风险与应对

### 风险 1：用户低频

应对：

- 我的术台；
- 更新提醒；
- 兼容榜；
- 每周榜单；
- 求术广场。

### 风险 2：下载后离站

应对：

- Runner update；
- 版本废弃提醒；
- 兼容报告；
- 评论和 Issue；
- Skill 包订阅。

### 风险 3：用户担心数据回传

应对：

- 默认不回传运行数据；
- 匿名兼容报告显式开启；
- 不上传输入输出；
- 企业模式彻底关闭遥测。

### 风险 4：贡献值被刷

应对：

- 下载低权重；
- 有效安装、成功运行、兼容报告高权重；
- 新用户降权；
- 异常行为审核；
- 被举报 Skill 暂停结算。

### 风险 5：Skill 质量参差不齐

应对：

- 审核机制；
- Verified 标识；
- Skill Spec 强约束；
- 输出 schema；
- Issue 和举报；
- 发布组制度。

---

## 17. 首页信息架构建议

首页首屏：

- 标题：衡术：AI Skill 注册表与本地运行分发社区；
- 副标题：发现、安装、更新和共建可本地运行的 AI Skill；
- CTA：进入术库、安装 Runner、查看兼容榜、发布求术。

首页模块顺序：

1. 精选术库；
2. 我的术台入口；
3. Runner 安装指引；
4. 本地模型兼容榜；
5. 求术广场；
6. 术榜；
7. 发布组；
8. 贡献值机制说明。

---

## 18. 当前最小下一步

优先级：

```text
1. 我的术台
2. Runner install/list/update
3. Hengshu Skill Spec v1
4. CompatReports
5. 贡献值规则 2.0
6. 求术广场闭环
```

不建议优先：

```text
复杂工作流画布
企业版
完整商业化
任意代码执行 Skill
大型评测中心
```

---

## 19. 最终产品判断

衡术不应只做成用户偶尔访问的 Skill 市场，而应做成：

> 用户管理 AI Skill、更新 Skill、评估模型兼容性、发布需求、参与贡献、沉淀团队能力的长期工作台。

核心判断：

```text
Skill 是低频入口；
我的术台和更新机制是留存；
兼容榜是差异化数据资产；
求术和发布组是社区粘性；
私有术库是长期商业化方向。
```

v0.2 的成败标准不是 Skill 数量，而是：

- 用户是否能顺畅安装并运行 Skill；
- 用户是否愿意回来更新；
- 用户是否愿意查看兼容榜；
- 创作者是否愿意维护版本；
- 求术是否能产生新的优质 Skill。

