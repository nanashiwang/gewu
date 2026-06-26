# 衡术 Hengshu

> Verified AI Skills, Powered by Contribution.

> 经过评测的 AI Skill 市场 —— 基于 **模型网关（OpenAI 兼容网关）** 的 AI 技能分发平台，引入类 PT 站的贡献值 / 邀请码 / 悬赏 / 资源健康度机制。

当前版本 **v0.1（MVP 基础骨架）**。完整产品规划见 [`docs/yuanheng_skillhub_product_doc_v0.1.md`](docs/yuanheng_skillhub_product_doc_v0.1.md)。

## 技术栈

| 组件 | 用途 |
|---|---|
| **Next.js 16** | 前台页面 + 自定义 API 路由 |
| **Payload CMS 3** | 用户/权限/后台/内容集合/审核（原生嵌入 Next.js） |
| **PostgreSQL 16** | 主业务数据（Drizzle 适配器） |
| **Redis 7** | 队列/缓存（Worker 预留） |
| **模型网关** | 模型网关、token 计费、调用日志（OpenAI 兼容） |

## 快速开始

```bash
# 0. Node 22 LTS（推荐）
nvm use            # 读取 .nvmrc

# 1. 启动 PostgreSQL + Redis（主机端口 5433 / 6380，避开常见占用）
docker compose up -d

# 2. 配置环境变量
cp .env.example .env
#   - PAYLOAD_SECRET 必填（openssl rand -hex 32）
#   - MODEL_GATEWAY_BASE_URL / MODEL_GATEWAY_KEY 可暂留空（运行走 mock 回退）

# 3. 安装依赖并启动
npm install
npm run dev          # http://localhost:3000

# 4. 注入官方种子数据（管理员、分类、5 个官方 Skill、测试邀请码）
npm run seed
```

启动后：

- 前台首页：<http://localhost:3000>
- Skill 市场：<http://localhost:3000/skills>
- 管理后台：<http://localhost:3000/admin>
- 种子管理员：`admin@yuanheng.ai` / `admin12345`
- 测试邀请码：`WELCOME1`

## 常用脚本

| 命令 | 说明 |
|---|---|
| `npm run dev` | 启动开发服务器 |
| `npm run build` / `npm start` | 生产构建 / 启动 |
| `npm run seed` | 注入种子数据（幂等） |
| `npm run generate:types` | 生成 `src/payload-types.ts` |
| `npm run generate:importmap` | 生成 Admin importMap |
| `npm run worker:skillrank` | 批量重算 SkillRank / 健康度 |

## 目录结构

```
src/
├─ app/(payload)/      # Payload admin + REST/GraphQL（自动样板，勿手改 layout/importMap）
├─ app/(frontend)/     # 前台：首页 / skills / rank / bounties / me / login / register / docs
├─ app/v1/             # 对外 API：skills/[slug]/run、skills/[slug]/favorite、auth/register
├─ collections/        # 12 个 Collection（Users/Skills/SkillVersions/SkillRuns/...）
├─ access/             # 函数式访问控制
├─ lib/                # newapi / 运行编排 / 校验 / 路由 / 贡献值 / 成本 / SkillRank
├─ components/         # 前台组件
├─ seed/               # 种子脚本与官方 Skill 数据
├─ worker/             # 离线任务（SkillRank 重算）
└─ payload.config.ts
```

## 核心闭环（产品文档 §12.2）

```
填表 → 校验输入 → 渲染 Prompt → 选模型(路由) → 调 模型网关
→ 校验输出格式 → 写 SkillRun → 更新成本/成功率/SkillRank → 发贡献值
```

运行端点：`POST /v1/skills/{slug}/run`（详见 `/docs`）。

## 已实现 / 待办

- ✅ 12 Collection 数据模型、函数式权限、关键钩子（slug/指标/贡献值）
- ✅ Skill 市场（列表/筛选/详情）、在线运行、SkillRun 记录与指标聚合
- ✅ 邀请码注册、登录、收藏、评论评分、悬赏发布（基础）
- ✅ SkillRank 计算、贡献值发放、排行榜、个人中心
- ⏳ 第二阶段：模型网关 深度联动（模型同步/余额/metadata 透传）、多模型对比、一键 Skill API
- ⏳ 第三阶段：创作者中心/认证、限免、悬赏验收；第四阶段：本地 Runner；第五阶段：企业版

## 注意事项

- 环境变量统一用 `DATABASE_URL`（非 `DATABASE_URI`）。
- `src/app/(payload)/layout.tsx`、`admin/importMap.js` 由 Payload 自动生成，请勿手改。
- 开发模式启用 schema `push`（自动同步），生产应改用 migration。
- `src/app/api/` 目录被 Payload 占用，自定义 API 一律放 `src/app/v1/`。
