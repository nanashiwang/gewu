# 格物平台 产品文档 v0.1

> 内部产品规划文档  
> 项目代号：GEWU 格物平台 / 格物能力库
> 当前版本：v0.1  
> 文档目标：定义一个基于 New API 的 AI Skill 市场，并引入类 PT 站的贡献、等级、邀请、悬赏、资源健康度与社区治理机制。

---

## 1. 产品一句话定位

**格物平台 是一个经过评测的 AI Skill 市场，让用户发现、运行、安装、评测和复用高质量 AI 技能，并通过贡献值机制获得更高权限和资源。**

更准确的定位：

> New API 负责「模型怎么接、怎么扣费、怎么稳定调用」；格物平台 负责「任务怎么封装、怎么评测、怎么分发、怎么形成社区贡献」。

外部表达不建议使用「AI PT 站」「种子站」「做种」等词，内部可以借鉴其运营机制。对外更适合表达为：

- AI Skill 市场
- 格物能力库
- Verified Skill Marketplace
- AI 能力分发网络
- 经过评测的 Prompt / Workflow / Model Routing 市场

---

## 2. 背景与问题

当前 New API / 模型中转类平台容易陷入以下问题：

1. **同质化严重**：用户主要比较模型数量、渠道稳定性、价格和充值体验。
2. **用户资产沉淀弱**：用户调用完模型后，Prompt、工作流、模型选择经验通常沉淀在本地或其他平台。
3. **粘性不足**：中转站如果只提供 API 调用，用户切换成本低。
4. **缺少任务级经验**：用户真正关心的是“这个任务应该用哪个模型最省、最准、最稳”，而不只是“有哪些模型”。
5. **Prompt 市场价值偏轻**：单纯卖 Prompt 容易被复制，缺少评测、运行、版本、计费、路由和社区治理。

格物平台 的机会在于：

> 把 New API 的模型网关能力、调用数据、计费能力，与 AI Skill 的封装、评测、分发和社区贡献体系结合起来。

---

## 3. 核心破局点

格物平台 不应只是另一个 Dify / Open WebUI / Langflow，也不应只是 Prompt 模板站。

核心差异化应是：

### 3.1 Verified Skill：经过验证的技能

每个 Skill 不只是 Prompt，而是一个可运行、可评测、可计费、可安装、可版本化的能力包。

一个 Skill 至少包含：

- Prompt 模板
- 输入字段定义
- 输出格式定义
- 推荐模型
- 推荐参数
- 路由策略
- 示例输入/输出
- 调用成本预估
- 平均耗时
- 成功率
- 评测结果
- 版本记录
- 作者与维护状态

用户看到的不是“复制一段 Prompt”，而是：

> 这个 Skill 最近是否稳定？适合哪个模型？平均多少钱一次？输出格式是否可靠？有没有人维护？

### 3.2 Skill + Eval + Router 三合一

格物平台 的产品核心应由三部分组成：

| 模块 | 作用 |
|---|---|
| Skill 市场 | 发现、收藏、运行、安装、Fork AI Skill |
| Eval 评测中心 | 用测试集证明 Skill 在不同模型上的效果 |
| Router 路由配方 | 为不同任务推荐最省、最准、最快、最稳的模型组合 |

这三个组合起来，才是区别于普通 AI 工作流平台的关键。

### 3.3 Skill 即 API

每个 Skill 不只是页面上的模板，还应该自动生成可调用 endpoint：

```http
POST /v1/skills/{skill_slug}/run
```

用户可以在前台运行，也可以把 Skill 接入自己的业务系统。

### 3.4 云端运行 + 本地安装

最终形态应同时支持：

| 使用方式 | 说明 | 适合用户 |
|---|---|---|
| 云端运行 | 格物平台 调 New API 执行 Skill | 普通用户、开发者、企业在线场景 |
| API 调用 | 用户业务系统调用 格物平台 Skill endpoint | 开发者、SaaS、企业系统 |
| 本地安装 | 用户把 Skill 安装到本地 Runner，用 Ollama / LM Studio / vLLM / 私有模型运行 | 本地模型用户、隐私敏感团队、企业内网 |

第一阶段优先云端运行，第二阶段再做本地 Runner。

---

## 4. 产品目标

### 4.1 短期目标

在 New API 之外建立一个轻量独立项目，验证以下闭环：

1. 用户能浏览 Skill。
2. 用户能在线运行 Skill。
3. 格物平台 通过 New API 调用模型。
4. 平台能记录成本、耗时、成功率。
5. 平台能形成 SkillRank。
6. 用户能收藏、评论、贡献反馈。
7. 平台能通过邀请码、贡献值、悬赏形成初步社区秩序。

### 4.2 中期目标

形成一个具有社区粘性的 AI Skill 市场：

1. 开放创作者发布 Skill。
2. 引入审核、评分、举报、贡献值。
3. 增加悬赏区和创作者等级。
4. 支持多模型对比评测。
5. 支持一键生成 API。
6. 支持贡献值兑换 New API 额度或高级权限。

### 4.3 长期目标

打造 AI 能力分发网络：

1. 支持云端 Skill、私有 Skill、本地 Skill。
2. 支持企业私有能力库。
3. 支持本地 Runner 与本地模型兼容报告。
4. 支持 Skill 版本同步、授权、评分、跑分。
5. 支持创作者分成与企业采购。
6. 形成任务级模型路由数据库。

---

## 5. 目标用户

### 5.1 普通用户

典型需求：

- 找好用的 AI 模板。
- 不会写 Prompt，希望直接填表运行。
- 需要文案、总结、办公、教育、客服、内容创作类能力。

关键价值：

- 一键使用。
- 低门槛。
- 有真实效果数据。
- 不需要理解复杂模型参数。

### 5.2 开发者

典型需求：

- 想把某个 AI 能力快速接入系统。
- 不想自己维护 Prompt、模型选择和 fallback。
- 想通过 API 调用稳定能力。

关键价值：

- Skill 即 API。
- 统一输入输出。
- 模型路由和成本预估。
- New API 统一扣费和调用日志。

### 5.3 AI 创作者 / Prompt 工程师

典型需求：

- 发布自己的 Skill。
- 获得调用量、贡献值、收入或曝光。
- 参与悬赏任务。
- 建立个人主页和声誉。

关键价值：

- 创作者中心。
- 贡献值。
- SkillRank。
- 悬赏区。
- 后续付费分成。

### 5.4 企业用户

典型需求：

- 沉淀公司内部 Prompt、质检标准、回复规范、评审流程。
- 做模型效果评测和成本对比。
- 管理团队权限和调用审计。
- 私有部署或本地模型运行。

关键价值：

- 企业私有 Skill 库。
- 团队权限。
- 调用审计。
- 批量评测。
- New API 账单联动。

### 5.5 本地模型用户

典型需求：

- 想用 Ollama / LM Studio / vLLM 跑 Skill。
- 不希望数据上传云端。
- 想知道本地模型是否足够完成某类任务。

关键价值：

- 本地 Runner。
- Skill 安装包。
- 本地模型兼容报告。
- 云端模型对比。
- 云端 fallback。

---

## 6. 产品形态

### 6.1 云端 格物平台

域名建议：

```text
skill.gewu.ai
```

主要页面：

- 首页
- Skill 市场
- Skill 详情
- 在线运行
- 多模型对比
- 创作者中心
- 悬赏区
- 排行榜
- 用户中心
- 邀请码页面
- 后台管理

### 6.2 New API

域名建议：

```text
api.gewu.ai
```

职责：

- 模型渠道管理
- API Key
- 用户余额
- Token 计费
- 调用日志
- 渠道 fallback
- 模型价格和能力标签

### 6.3 本地 Runner

后期推出：

```text
GEWU Skill Runner
```

形态可包括：

- CLI 工具
- 桌面端
- Docker 服务
- 浏览器插件或本地 Web UI

能力：

- 安装 Skill
- 更新 Skill
- 连接本地模型
- 运行 Prompt Skill
- 本地评测
- 可选云端 fallback
- 可选匿名提交兼容报告

---

## 7. PT 站机制映射

内部借鉴 PT 站机制，但对外换成合规、正向的产品表达。

| PT 站概念 | 格物平台 对应设计 | 外部推荐叫法 |
|---|---|---|
| 种子 | Skill / 能力包 | Skill、能力、模板、工作流 |
| 下载 | 调用 Skill / 安装 Skill / Fork Skill | 调用、安装、复用 |
| 上传 | 发布 Skill / 贡献评测集 / 优化路由 | 贡献、发布、维护 |
| 做种 | 持续维护 Skill、保持成功率和版本更新 | 维护度、健康度 |
| Ratio | 贡献/消耗比 | 贡献比、活跃度 |
| 魔力值 | 贡献值 / 元力值 | 贡献值、能力值 |
| 求种 | 求模板 / 求工作流 | 悬赏需求 |
| Freeleech | 限时免费调用 / 不扣贡献值 | 限免 Skill、官方精选 |
| H&R | 长期只消耗不贡献 | 权限降级、贡献不足提示 |
| 发布组 | 高质量资源组 | 认证创作者组、官方发布组 |
| 种子健康度 | 资源是否仍可用 | Skill 健康度、SkillRank |

---

## 8. 用户等级与权限体系

### 8.1 角色类型

| 角色 | 权限 |
|---|---|
| 游客 | 浏览公开 Skill、查看部分详情 |
| 注册用户 | 运行公开 Skill、收藏、评论、参与基础悬赏 |
| 活跃用户 | Fork Skill、提交评测样本、提交失败案例 |
| 创作者 | 发布 Skill、参与悬赏交付 |
| 认证创作者 | 更高上架额度、优先审核、参与收益计划 |
| 审核员 | 审核 Skill、处理举报、标记质量问题 |
| 管理员 | 全站管理、配置规则、管理用户与权限 |
| 企业管理员 | 管理企业私有 Skill 库、团队成员、审计日志 |

### 8.2 等级维度

用户等级可由以下指标决定：

- 注册时长
- 贡献值
- 发布 Skill 数量
- Skill 调用量
- Skill 收藏量
- Skill 评分
- 提交评测样本数量
- 审核通过率
- 违规次数
- 邀请高质量用户数量

### 8.3 权限示例

| 功能 | 游客 | 注册用户 | 活跃用户 | 创作者 | 认证创作者 | 审核员 |
|---|---:|---:|---:|---:|---:|---:|
| 浏览公开 Skill | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 运行公开 Skill | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 收藏/评论 | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Fork Skill | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ |
| 发布 Skill | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ |
| 发布高级 Skill | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| 审核 Skill | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| 处理举报 | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |

---

## 9. 贡献值系统

### 9.1 贡献值获得方式

| 行为 | 贡献值建议 |
|---|---:|
| 发布 Skill 并通过审核 | +50 |
| Skill 被收藏 | +1 / 次，设置日上限 |
| Skill 被成功调用 | +0.1 / 次，设置日上限 |
| Skill 获得高评分 | +5 ~ +20 |
| 更新 Skill 版本 | +10 |
| 修复严重问题 | +20 ~ +100 |
| 提交评测样本并被采纳 | +5 / 条 |
| 提交失败案例并被确认 | +10 |
| 优化模型路由并被采用 | +30 |
| 参与审核并结果有效 | +5 ~ +20 |
| 发现安全风险 | +50 ~ +500 |
| 完成悬赏 | 按悬赏设定 |

### 9.2 贡献值消耗方式

| 行为 | 消耗方式 |
|---|---|
| 运行高级 Skill | 消耗贡献值或额度 |
| 下载/安装本地 Skill 包 | 消耗贡献值，或对认证用户免费 |
| 查看高级路由策略 | 消耗贡献值或会员权限 |
| 使用官方评测集 | 消耗贡献值 |
| 发布悬赏 | 锁定贡献值或现金赏金 |
| 申请创作者认证 | 消耗贡献值或满足门槛 |
| 兑换 New API 额度 | 按平台规则兑换 |

### 9.3 贡献/消耗比

可设计一个软性比例指标：

```text
贡献比 = 有效贡献值 / 高级资源消耗值
```

贡献比可影响：

- 高级 Skill 访问权限
- 每日运行次数
- 创建悬赏权限
- 邀请码数量
- 榜单曝光权重
- 内测功能资格

不建议第一版对普通用户做强限制。建议采用：

> 普通功能开放使用，高级社区功能引入贡献门槛。

---

## 10. Skill 定义

### 10.1 Skill 类型

第一阶段优先支持 Prompt Skill。

| 类型 | 说明 | 阶段 |
|---|---|---|
| Prompt Skill | 单 Prompt 模板 + 输入字段 + 输出格式 | MVP |
| Few-shot Skill | Prompt 内置示例 | MVP+ |
| Structured Output Skill | 强制 JSON / 表格 / 字段输出 | MVP |
| Workflow Skill | 多步骤任务编排 | 第二阶段 |
| Eval Skill | 针对评测任务设计的 Skill | 第二阶段 |
| RAG Skill | 结合知识库检索 | 第三阶段 |
| Tool Skill | 调用外部工具 / MCP / API | 第三阶段后，需谨慎 |
| Local Skill | 可安装到本地 Runner 的 Skill | 第三阶段 |

### 10.2 Skill Manifest 示例

```yaml
id: xhs-title-generator
slug: xhs-title-generator
name: 小红书标题生成器
version: 1.0.0
author: official
category: content_creation
visibility: public
status: published

input_schema:
  topic:
    type: string
    label: 主题
    required: true
  audience:
    type: string
    label: 目标人群
    required: false
  style:
    type: select
    label: 风格
    options:
      - 温暖
      - 犀利
      - 专业
      - 情绪共鸣

prompt_template: |
  你是一名小红书内容编辑。
  请根据以下信息生成 10 个小红书标题：
  主题：{{topic}}
  目标人群：{{audience}}
  风格：{{style}}

output_schema:
  titles:
    type: array
    item_type: string
  reason:
    type: string

recommended_models:
  cloud:
    - deepseek-chat
    - qwen-plus
    - gpt-4.1-mini
  local:
    - qwen2.5:14b
    - llama3.1:8b

route_policy:
  default: balanced
  strategies:
    cheap:
      - deepseek-chat
      - qwen-turbo
    quality:
      - gpt-4.1-mini
      - claude-sonnet
    fallback:
      - qwen-plus
      - deepseek-chat
      - gpt-4.1-mini

eval:
  dataset_id: xhs_title_eval_v1
  metrics:
    - relevance
    - clickability
    - compliance
```

---

## 11. SkillRank 与健康度

### 11.1 SkillRank 目的

SkillRank 用于让用户快速判断：

- 这个 Skill 是否好用？
- 是否还在维护？
- 成本是否合理？
- 输出是否稳定？
- 推荐用哪个模型？
- 有没有失败风险？

### 11.2 SkillRank 评分维度

| 维度 | 权重建议 | 数据来源 |
|---|---:|---|
| 评测通过率 | 35% | 格物平台 Eval |
| 稳定性 | 15% | New API 调用结果 + SkillRun |
| 成本优势 | 15% | New API token / 价格 |
| 延迟表现 | 10% | SkillRun latency |
| 输出格式成功率 | 10% | JSON/schema 校验 |
| 维护活跃度 | 10% | 版本更新、问题修复 |
| 用户反馈 | 5% | 评分、收藏、评论 |

示例公式：

```text
SkillRank =
评测通过率 * 0.35
+ 稳定性 * 0.15
+ 成本优势 * 0.15
+ 延迟表现 * 0.10
+ 输出格式成功率 * 0.10
+ 维护活跃度 * 0.10
+ 用户反馈 * 0.05
```

### 11.3 Skill 健康度展示

Skill 详情页应展示：

- 最近 7 天调用次数
- 最近 7 天成功率
- 平均成本
- 平均耗时
- 首 token 时间，可后期支持
- JSON 输出成功率
- 推荐模型
- 备用模型
- 最近更新时间
- 当前版本
- 兼容本地模型
- 已知问题
- 作者维护状态

---

## 12. New API 联动设计

### 12.1 职责边界

| 模块 | 职责 |
|---|---|
| New API | 模型网关、渠道、余额、Key、token 计费、调用日志、渠道级 fallback |
| 格物平台 | Skill 市场、Prompt 拼装、输入输出校验、任务级路由、SkillRank、贡献值、悬赏、社区 |

原则：

> New API 不理解 Skill 业务；格物平台 不直接绕过 New API 调模型。

### 12.2 云端运行流程

```text
用户填写 Skill 表单
        ↓
格物平台 校验输入字段
        ↓
格物平台 渲染 Prompt
        ↓
格物平台 选择模型 / 路由策略
        ↓
格物平台 调用 New API /v1/chat/completions
        ↓
New API 调模型供应商
        ↓
返回结果、token、耗时、错误信息
        ↓
格物平台 校验输出格式
        ↓
记录 SkillRun
        ↓
更新成本、成功率、SkillRank
```

### 12.3 MVP 阶段联动

MVP 可采用轻联动：

- 用户在 格物平台 绑定 New API Key。
- 格物平台 调用 New API OpenAI-compatible 接口。
- 格物平台 自己记录 SkillRun。
- 模型价格先由 格物平台 定期同步或手动配置。

优点：

- New API 几乎不用改。
- MVP 上线快。
- 风险低。

### 12.4 第二阶段联动

New API 增加内部接口：

```http
GET /internal/models
GET /internal/user/balance
POST /internal/keys
GET /internal/logs?external_run_id={run_id}
```

调用时透传 metadata：

```http
X-GEWU-Source: gewu
X-GEWU-Run-ID: run_xxx
X-GEWU-Skill-ID: skill_xxx
X-GEWU-Skill-Version: 1.0.0
```

New API 日志中记录：

- source
- external_run_id
- skill_id
- skill_version
- user_id
- model
- token
- cost
- error_code

### 12.5 路由层级

| 路由类型 | 归属 | 说明 |
|---|---|---|
| 任务级路由 | 格物平台 | 某个任务适合哪个模型 |
| 渠道级路由 | New API | 某个模型走哪个渠道最稳 |

示例：

```text
格物平台 判断：合同摘要 Skill 适合 Claude / GPT。
New API 判断：Claude 当前走哪个渠道更稳定。
```

---

## 13. 页面结构

### 13.1 前台页面

```text
/
首页：定位、精选 Skill、榜单、悬赏入口

/skills
Skill 市场列表页，类似 PT 资源列表

/skills/[slug]
Skill 详情页，类似资源详情页

/skills/[slug]/run
在线运行页

/skills/[slug]/versions
版本历史

/skills/[slug]/reviews
评论和反馈

/bounties
悬赏区，类似求种区

/bounties/[id]
悬赏详情

/rank
排行榜：SkillRank、贡献榜、创作者榜

/creators/[id]
创作者主页

/users/[id]
用户资料页

/me
个人中心

/me/invites
邀请码管理

/me/contributions
贡献值流水

/me/favorites
收藏 Skill

/me/runs
运行记录

/docs
开发者文档

/api-keys
New API 绑定与 Skill API Key 管理
```

### 13.2 管理后台

使用 Payload CMS 自动后台：

```text
/admin
- 用户管理
- Skill 管理
- Skill 审核
- 评论审核
- 举报处理
- 邀请码管理
- 贡献值记录
- 悬赏管理
- 创作者认证
- 官方推荐配置
- 分类标签管理
```

### 13.3 PT 风格列表页字段

`/skills` 列表页可采用类似 PT 资源列表的信息密度：

| 字段 | 说明 |
|---|---|
| 分类 | 文案、办公、代码、客服、评测、教育等 |
| Skill 名称 | 主标题 + 简介 |
| 作者 | 创作者 / 发布组 |
| 版本 | 当前版本 |
| 更新时间 | 维护状态 |
| 调用量 | 类似下载量，但叫调用量 |
| 收藏 | 用户收藏数 |
| 成功率 | 最近 7 天成功率 |
| 平均成本 | 单次调用成本 |
| 平均耗时 | 运行速度 |
| SkillRank | 综合评分 |
| 状态 | 精选、限免、认证、私有、本地可用 |

---

## 14. 数据模型草案

### 14.1 users

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid | 用户 ID |
| email | string | 邮箱 |
| username | string | 用户名 |
| role | enum | user / creator / reviewer / admin |
| level | integer | 用户等级 |
| contribution_score | number | 贡献值 |
| consumption_score | number | 消耗值 |
| ratio_score | number | 贡献比 |
| newapi_user_id | string | 绑定 New API 用户 ID |
| newapi_key_encrypted | string | 加密后的 API Key，MVP 可选 |
| invite_count | integer | 可用邀请码数量 |
| warning_count | integer | 违规次数 |
| created_at | datetime | 注册时间 |

### 14.2 skills

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid | Skill ID |
| slug | string | URL slug |
| title | string | 名称 |
| description | text | 简介 |
| category_id | relation | 分类 |
| author_id | relation | 作者 |
| creator_group_id | relation | 创作者组，可选 |
| visibility | enum | public / private / unlisted / enterprise |
| status | enum | draft / pending / published / rejected / archived |
| current_version_id | relation | 当前版本 |
| skill_rank | number | 综合评分 |
| health_score | number | 健康度 |
| run_count | integer | 调用次数 |
| favorite_count | integer | 收藏数 |
| review_count | integer | 评论数 |
| avg_rating | number | 平均评分 |
| avg_cost | number | 平均成本 |
| avg_latency_ms | number | 平均耗时 |
| success_rate | number | 成功率 |
| format_success_rate | number | 格式成功率 |
| last_run_at | datetime | 最近调用时间 |
| last_updated_at | datetime | 最近更新时间 |
| created_at | datetime | 创建时间 |

### 14.3 skill_versions

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid | 版本 ID |
| skill_id | relation | 所属 Skill |
| version | string | 版本号 |
| prompt_template | text | Prompt 模板 |
| input_schema | json | 输入字段 |
| output_schema | json | 输出字段 |
| recommended_models | json | 推荐模型 |
| route_policy | json | 路由策略 |
| changelog | text | 更新说明 |
| status | enum | draft / active / deprecated |
| created_by | relation | 创建人 |
| created_at | datetime | 创建时间 |

### 14.4 skill_runs

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid | 运行 ID |
| run_id | string | 外部运行 ID |
| user_id | relation | 用户 |
| skill_id | relation | Skill |
| skill_version_id | relation | 版本 |
| model | string | 使用模型 |
| route_mode | string | cheap / quality / fast / balanced |
| input_json | json | 输入 |
| output_text | text | 输出原文 |
| output_json | json | 结构化输出 |
| prompt_tokens | integer | 输入 token |
| completion_tokens | integer | 输出 token |
| total_tokens | integer | 总 token |
| estimated_cost | number | 估算成本 |
| charged_amount | number | 实际收费 |
| latency_ms | integer | 耗时 |
| success | boolean | 是否成功 |
| error_code | string | 错误码 |
| format_valid | boolean | 输出格式是否有效 |
| newapi_log_id | string | New API 日志 ID |
| created_at | datetime | 创建时间 |

### 14.5 contribution_logs

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid | 记录 ID |
| user_id | relation | 用户 |
| action_type | enum | 行为类型 |
| points | number | 贡献值变化 |
| related_skill_id | relation | 关联 Skill |
| related_bounty_id | relation | 关联悬赏 |
| description | text | 描述 |
| created_at | datetime | 时间 |

### 14.6 invite_codes

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid | 邀请码 ID |
| code | string | 邀请码 |
| inviter_id | relation | 邀请人 |
| used_by_id | relation | 使用人 |
| status | enum | unused / used / expired / revoked |
| min_level_required | integer | 使用门槛，可选 |
| expires_at | datetime | 过期时间 |
| created_at | datetime | 创建时间 |

### 14.7 bounties

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid | 悬赏 ID |
| title | string | 标题 |
| description | text | 需求说明 |
| creator_id | relation | 发布人 |
| reward_points | number | 贡献值赏金 |
| reward_amount | number | 现金赏金，后期可选 |
| status | enum | open / accepted / submitted / completed / cancelled |
| accepted_by_id | relation | 接单人 |
| submitted_skill_id | relation | 提交的 Skill |
| due_at | datetime | 截止时间 |
| created_at | datetime | 创建时间 |

---

## 15. 技术架构建议

### 15.1 推荐主架构

```text
Next.js + Payload CMS + PostgreSQL + Redis + Worker + New API
```

### 15.2 各组件职责

| 组件 | 职责 |
|---|---|
| Next.js | 前台页面、用户交互、Skill 运行页、开发者文档 |
| Payload CMS | 用户、权限、后台、内容集合、审核管理 |
| PostgreSQL | 主业务数据 |
| Redis | 队列、缓存、限流、运行状态 |
| Worker | 批量评测、SkillRank 计算、贡献值结算、日志同步 |
| New API | 模型网关、Key、余额、token 计费、渠道管理 |
| Object Storage | Skill 附件、评测集、导出文件、图片 |

### 15.3 架构图

```text
用户浏览器
   ↓
Next.js 格物平台 前台
   ↓
Payload / Custom API
   ↓                     ↓
PostgreSQL / Redis       New API
   ↓                     ↓
Worker                  模型供应商
```

### 15.4 为什么选择 Payload

Payload 适合作为基座，因为它能节省：

- 用户管理
- 角色权限
- 后台管理
- 数据 CRUD
- 文件上传
- 审核流程
- 内容模型管理

但以下能力仍需自研：

- Skill 运行引擎
- New API 调用逻辑
- Prompt 渲染
- SkillRank
- 贡献值规则
- 批量评测
- 创作者分成
- 本地 Runner

---

## 16. 开源参考项目

此处仅作为产品和信息架构参考，正式立项前需复核最新许可证、商业使用条款和技术栈适配性。

### 16.1 Payload CMS

推荐作为 格物平台 的用户、权限、后台和内容数据基座。

适合借鉴/使用：

- 用户认证
- 后台管理
- Access Control
- Collections
- Hooks
- REST / GraphQL API
- Next.js 集成

### 16.2 sqtracker

适合参考现代 PT 站前台结构：

- 资源列表
- 邀请制
- Bonus points
- Ratio
- Freeleech
- Requests
- 评论
- 收藏

不建议直接照搬业务代码，主要参考页面结构和机制。

### 16.3 UNIT3D

适合参考完整 PT 站机制：

- 用户等级
- 邀请码
- 魔力值
- 请求区
- 用户组
- 资源健康度
- 后台审核
- 社区治理

不建议作为 格物平台 主基座，主要参考运营逻辑。

### 16.4 NexusPHP

适合参考中文 PT 用户习惯：

- 高密度资源列表
- 中文站点信息架构
- 邀请注册
- 等级体系
- 魔力值系统

不建议直接二开做现代 格物平台。

---

## 17. MVP 范围

### 17.1 MVP 目标

用最少功能验证：

1. 用户是否会浏览和运行 Skill。
2. 用户是否认可 SkillRank / 健康度。
3. New API 联动是否能形成调用消耗。
4. PT 化机制是否能提高社区参与。

### 17.2 MVP 必做功能

#### 用户与权限

- 注册 / 登录
- 用户角色
- 用户等级字段
- 邀请码注册，或者创作者邀请码
- 基础用户中心

#### Skill 市场

- Skill 列表
- Skill 详情
- 分类标签
- 搜索筛选
- 官方精选
- Skill 状态：草稿、待审核、已发布、驳回、归档

#### Skill 运行

- 输入表单
- Prompt 渲染
- 调用 New API
- 显示输出
- 记录 SkillRun
- 显示本次成本、耗时、模型

#### 社区互动

- 收藏
- 评论
- 评分
- 举报

#### PT 化基础

- 贡献值字段
- 贡献值流水
- 邀请码
- 悬赏区基础版
- Skill 健康度基础版

#### 管理后台

- 用户管理
- Skill 审核
- 评论审核
- 举报处理
- 邀请码管理
- 贡献值调整

### 17.3 MVP 暂不做

- 完整工作流画布
- RAG 知识库
- MCP 工具市场
- 自动微调
- 复杂创作者分账
- 企业私有库
- 本地 Runner
- 完整论坛
- 支付系统
- 复杂 H&R 惩罚机制

---

## 18. 第一批官方 Skill 建议

优先选择高频、低风险、易评测的中文业务场景。

### 18.1 内容创作类

- 小红书标题生成器
- 小红书笔记生成器
- 公众号文章大纲生成器
- 短视频脚本生成器
- 私域朋友圈文案生成器

### 18.2 办公效率类

- 会议纪要整理
- 周报生成
- 邮件润色
- 文档摘要
- SOP 生成

### 18.3 客服与运营类

- 客服回复建议
- 差评回复
- 用户投诉总结
- 工单分类
- 常见问题回答模板

### 18.4 AI 评测类

- Prompt 对比评测
- 多模型输出对比
- Excel 批量评审
- JSON 结构化输出测试
- AI 评审一致性分析

### 18.5 教育与心理类

- 心理课教案生成
- 学习单生成
- 家长反馈生成
- 个案记录整理
- 学生活动方案生成

---

## 19. Skill 详情页设计

Skill 详情页是核心页面，应兼顾 PT 站资源页和 AI 技能页。

建议结构：

1. 标题区
   - Skill 名称
   - 分类
   - 作者
   - 当前版本
   - 状态标签：官方、认证、限免、本地可用、高级

2. 核心指标
   - SkillRank
   - 成功率
   - 平均成本
   - 平均耗时
   - 调用量
   - 收藏量
   - 最近更新时间

3. 快速操作
   - 在线运行
   - 收藏
   - Fork
   - 查看 API
   - 下载/安装到本地，后期

4. 使用说明
   - 适用场景
   - 输入字段
   - 输出格式
   - 示例输入
   - 示例输出

5. 模型推荐
   - 省钱模式
   - 高质量模式
   - 快速模式
   - 稳定模式
   - 本地模型建议，后期

6. 评测结果
   - 数据集说明
   - 各模型准确率
   - 成本对比
   - 延迟对比

7. 版本历史
   - changelog
   - 更新时间
   - 作者说明

8. 评论反馈
   - 用户评价
   - 失败案例
   - 模型兼容报告
   - 改进建议

---

## 20. 悬赏区设计

悬赏区对应 PT 站的「求种」，但应包装为正向需求市场。

### 20.1 悬赏类型

- 求 Prompt Skill
- 求结构化输出 Skill
- 求评测集
- 求模型路由优化
- 求行业模板包
- 求本地模型适配

### 20.2 悬赏流程

```text
用户发布需求
    ↓
锁定贡献值 / 赏金
    ↓
创作者接单
    ↓
提交 Skill
    ↓
平台或用户验收
    ↓
发布 Skill / 私有交付
    ↓
释放贡献值 / 赏金
```

### 20.3 悬赏字段

- 标题
- 描述
- 适用场景
- 输入输出要求
- 推荐模型要求
- 是否公开
- 赏金类型：贡献值 / 现金 / New API 额度
- 截止时间
- 验收标准

---

## 21. 本地 Runner 规划

本地 Runner 不作为 MVP，但应提前在 Skill Manifest 上预留兼容字段。

### 21.1 本地 Runner 目标

- 让用户把 Skill 安装到本地。
- 使用本地模型运行 Skill。
- 私有数据不出本地。
- 可选使用 New API 作为 fallback。
- 可选提交匿名兼容数据。

### 21.2 支持模型后端

- Ollama
- LM Studio
- vLLM
- llama.cpp server
- LocalAI
- 任意 OpenAI-compatible endpoint

### 21.3 本地运行流程

```text
用户从 格物平台 安装 Skill
        ↓
Runner 读取 manifest
        ↓
用户选择本地模型
        ↓
Runner 渲染 Prompt
        ↓
调用本地模型 endpoint
        ↓
本地保存输出和运行记录
        ↓
可选云端 fallback / 可选匿名提交统计
```

### 21.4 本地与云端对比

后期可提供：

| 模型 | 准确率 | 平均耗时 | 成本 | JSON 成功率 |
|---|---:|---:|---:|---:|
| 本地 Qwen 14B | 78% | 6.2s | 0 | 85% |
| New API DeepSeek | 84% | 2.3s | 低 | 92% |
| New API GPT / Claude | 92% | 3.1s | 高 | 98% |

---

## 22. 商业化方向

### 22.1 基础收入

- New API 调用消耗
- 高级模型调用
- 格物平台 会员
- 高级 Skill 使用权限

### 22.2 创作者经济

- 付费 Skill
- 悬赏抽佣
- 创作者分成
- 认证创作者服务
- 模板包售卖

### 22.3 企业服务

- 企业私有 Skill 库
- 团队权限
- 调用审计
- 私有评测集
- 私有部署
- 专属模型路由
- 账单与成本分析

### 22.4 本地与混合部署

- 本地 Runner 企业版
- 内网私有 格物平台
- 本地模型评测服务
- 云端 fallback 套餐

---

## 23. 风险与边界

### 23.1 内容质量风险

风险：低质量 Prompt 泛滥。

应对：

- 上架审核
- SkillRank
- 官方认证
- 评论举报
- 低分降权
- 重复 Skill 合并

### 23.2 安全风险

风险：恶意 Prompt、提示词注入、外部工具滥用、数据泄露。

应对：

- MVP 只做纯 Prompt Skill
- 禁止自动执行高风险操作
- 后期工具类 Skill 需权限沙箱
- 记录调用日志
- 举报和审查机制

### 23.3 版权与合规风险

风险：用户上传未授权数据集、泄露企业内部内容、复制他人 Prompt。

应对：

- 用户协议
- 举报机制
- 审核机制
- 版权声明
- 敏感内容处理流程

### 23.4 商业开源协议风险

风险：借鉴 PT 开源项目时触发 GPL / AGPL 等协议义务。

应对：

- 正式开发前复核许可证
- 尽量只参考信息架构和产品机制
- 主工程使用可控基座
- 避免直接复制受限代码

### 23.5 New API 稳定性风险

风险：格物平台 运行依赖 New API，New API 不稳定会影响 格物平台 体验。

应对：

- 调用失败重试
- 模型 fallback
- 错误提示
- 运行状态监控
- 异步评测任务队列

---

## 24. 里程碑规划

### 阶段 0：技术验证

目标：验证 Payload + Next.js + New API 调用链。

交付：

- Payload 项目初始化
- User / Skill / SkillVersion / SkillRun Collection
- Skill 列表和详情原型
- 在线运行一个官方 Skill
- 调用 New API 返回结果

### 阶段 1：MVP

目标：完成可公开内测的 格物平台。

交付：

- 用户注册登录
- 邀请码
- Skill 市场
- Skill 详情
- 在线运行
- 收藏评论评分
- Skill 审核后台
- 贡献值流水
- 悬赏区基础版
- Skill 健康度基础版

### 阶段 2：New API 深度联动

目标：形成数据差异化。

交付：

- 模型列表同步
- 余额查询
- 虚拟 Key
- 调用 metadata 透传
- SkillRank
- 多模型对比
- 一键 Skill API

### 阶段 3：社区化和创作者体系

目标：形成 PT 化运营机制。

交付：

- 创作者中心
- 认证创作者
- 发布组
- 高级 Skill
- 限免机制
- 贡献/消耗比
- 悬赏验收
- 榜单体系

### 阶段 4：本地 Runner

目标：支持本地模型使用 Skill。

交付：

- CLI Runner
- Skill 安装包
- Ollama / LM Studio / vLLM 支持
- 本地运行记录
- 云端 fallback
- 本地模型兼容报告

### 阶段 5：企业版

目标：商业化升级。

交付：

- 企业空间
- 私有 Skill 库
- 团队权限
- 调用审计
- 私有评测集
- 企业账单
- 私有部署方案

---

## 25. 第一版开发任务拆分

### 后端 / Payload

- 初始化 Payload + PostgreSQL
- Users Collection
- Skills Collection
- SkillVersions Collection
- SkillRuns Collection
- Reviews Collection
- Favorites Collection
- InviteCodes Collection
- ContributionLogs Collection
- Bounties Collection
- Reports Collection
- Access Control 规则
- Hooks：发布审核、贡献值变更、Skill 指标更新

### 前端 / Next.js

- 首页
- Skill 列表页
- Skill 详情页
- 在线运行页
- 登录注册页
- 用户中心
- 收藏页
- 贡献值页
- 悬赏列表页
- 悬赏详情页
- 排行榜页

### New API 联动

- 配置用户 New API Key
- 调用 `/v1/chat/completions`
- 记录 token / cost / latency
- 错误处理
- 基础 fallback，可选

### Worker

- SkillRun 聚合统计
- SkillRank 定时计算
- 贡献值结算
- 榜单刷新

---

## 26. 成功指标

### MVP 指标

- 注册用户数
- 激活用户数
- Skill 浏览次数
- Skill 运行次数
- New API 调用消耗
- 收藏率
- 评论率
- 用户留存
- 平均单次运行成本
- 成功率
- 平均耗时

### 社区指标

- 创作者数量
- 发布 Skill 数
- 审核通过率
- 悬赏发布数
- 悬赏完成数
- 贡献值发放量
- 高质量用户邀请数
- 举报处理时长

### 商业指标

- 格物平台 带来的 New API 消耗
- 付费用户比例
- 高级 Skill 使用次数
- 企业空间试用数
- 创作者分成 GMV，后期

---

## 27. 当前推荐决策

### 27.1 主基座

推荐：

```text
Payload CMS + Next.js
```

原因：

- 有用户系统
- 有后台管理
- 有权限控制
- 适合内容市场
- 适合 Skill 审核和 PT 化管理
- 不会被 Dify / Open WebUI / Langflow 的产品结构绑住

### 27.2 PT 前台参考

推荐参考顺序：

1. sqtracker：现代 PT 站前台结构
2. UNIT3D：完整 PT 机制
3. NexusPHP：中文 PT 用户习惯
4. Gazelle：经典 PT 信息架构

建议只参考，不直接作为主工程。

### 27.3 MVP 策略

优先做：

```text
官方 Skill + 在线运行 + New API 调用 + SkillRun 记录 + SkillRank 雏形 + 邀请码 + 贡献值 + 悬赏区
```

暂缓：

```text
工作流画布、本地 Runner、企业空间、复杂分成、完整论坛
```

---

## 28. 下一步建议

1. 确认项目命名：格物平台 / 格物能力库 / 格物平台。
2. 确认技术栈：Payload + Next.js + PostgreSQL + Redis。
3. 建立 Git 仓库。
4. 初始化 Payload 项目。
5. 先建 Users、Skills、SkillVersions、SkillRuns 四个核心 Collection。
6. 做第一个官方 Skill：小红书标题生成器。
7. 接 New API 完成一次真实调用。
8. 再补收藏、评论、贡献值、邀请码和悬赏。

---

## 29. 附录：产品口号备选

- 经过评测的 AI 技能市场
- 让优质 AI Skill 可以被发现、评测、复用和分发
- 一个 Skill，两种运行方式：云端调用，本地运行
- 不只是 Prompt，而是可运行、可评测、可计费的 AI 能力
- 帮你找到这个任务最省、最准、最稳的 AI 调用方案
- AI 能力的注册中心、评测中心和分发网络

