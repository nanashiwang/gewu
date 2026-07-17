# 格物 · AI API 中转站真伪检测 / Claude · OpenAI · Gemini 中转站真假鉴定工具

[![License: AGPL v3](https://img.shields.io/badge/license-agpl_v3-blue.svg)](LICENSE)
[![Python 3.10+](https://img.shields.io/badge/python-3.10%2B-blue.svg)](https://www.python.org/)
> 品牌：**格物 / gewu**　·　口号：**让 AI 能力，有据可验。**

> **格物 是开源的 AI API 中转站真伪检测工具。**
> 输入 `base_url + api_key + model`,它会自动探测中转站是否真的转发到宣称的 Claude / OpenAI / Gemini 模型,
> 是否剥离了 PDF、Tool Use、Thinking、Function Calling、长上下文等关键能力,
> 以及响应字段、流式协议、usage 计费字段是否符合官方规范。
>
> 可直接自托管运行；完整检测逻辑、评分权重和字段证据都在本仓库公开。
>
> ⭐ 如果 格物 帮你识别过假中转、避过坑,欢迎给这个仓库点个 Star。
> Star 会让更多开发者和站长看到这个开源检测工具,也支持「评分独立、证据公开、付费不改分」的透明检测生态。

---

一个开源的 AI API 中转站(relay / proxy)真伪与质量检测工具。给定一个 `base_url + api_key + model`,自动跑一组探针请求,把结果跟「官方真品基线」做**字段级、协议级和签名回放级**对比,回答三个问题:

1. **真伪**:这家中转站给我的真的是它声称的模型吗?(Claude / GPT / Gemini)
2. **能力**:PDF / Tool Use / Thinking / Function Calling 等高级能力有没有被剥离?
3. **合规**:响应字段、ID 前缀、streaming 协议、usage 用量是否符合官方规范?

支持三大协议:**Anthropic Messages API**、**OpenAI Chat Completions**、**Gemini OpenAI 兼容 API**。

部署后通过 `GEWU_SITE_URL` 配置公开站点地址。

---

## 支持 格物

格物 的检测算法、评分逻辑和报告证据保持开源透明。你可以用两种方式支持项目继续维护:

1. **给 GitHub 仓库点 Star**:让更多中文开发者和站长找到这个项目。
2. **反馈与合作**:通过部署方公布的源码仓库或联系方式提交。

> 合作不会改变检测分数、verdict、critical 严重问题或排行榜算法。
> 格物 的价值来自公开证据,不是人工背书。

---

## 核心创新:服务端签名回放验证 ⭐

Claude 协议下,启用 thinking 时会返回不透明的 `signature` 字段。仅检查字段存在或长度并不能证明真实性,所以 格物 会执行两次对照:原始 thinking block 必须被接受,篡改单字节后的 block 必须被服务端以 thinking 校验错误拒绝。只有两项同时成立才给 100 分。它是高强度协议证据,但不是本地公钥验签,也不宣称能绝对排除专门针对探针的恶意中转层。

OpenAI / Gemini 没有同等级别的服务端签名机制,验证强度只到**协议级 / 行为级**,但仍可通过 `usage` 字段后端指纹(如 `claude_cache_creation_*` 残留)识别"换芯"中转站。

---

## 检测维度(按协议)

三个协议都按「真伪 / 能力 / 协议」分类组织检测器,各自的杀手锏不同。
权重分配、子检查细节见 [DESIGN.md](DESIGN.md)。

### 跨协议加测:长上下文真实性 ⭐

> **杀手锏**:三层 needle-in-haystack 探针实测中转站是否真实兑现宣传的
> context window — 能 catch「宣传 1M 实际只给 200k」「转发到小窗口模型」
> 「中段大海捞针失败」这类高端欺诈,基础协议检测完全测不到。

| 档位 | 探针深度 | 用途 |
|---|---|---|
| **标准** | 32k → 100k → 200k tokens | 验证常规上下文窗口未截断 |
| **极限** | 按模型上限等比(如 1M 模型测 32k → 500k → 950k) | 抓「宣传 1M 实际只给 200k」类高端欺诈 |

按需勾选启用。任一层未通过立即停止,避免无谓烧 token。
**支持**:Claude / OpenAI(Gemini 暂不支持)。
**成本**:由你的 API key 支付 — 标准档约 $0.05–$0.50,极限档约 $0.05–$8(随模型上限)。

### Claude(Anthropic)— 12 项

> **杀手锏**:`thinking_signature` 原始/篡改双向回放校验。
> 它比字段存在性检查更强,但结论仍应与行为、协议和一致性证据共同解读。

| 类别 | 检测器 | 核心检测点 |
|---|---|---|
| **真伪** | identity | 直接询问"你是谁",含 Claude / Anthropic 关键词 |
| | behavioral_signature | 3 道行为指纹题(markdown / 列表 / 拒绝风格) |
| | **thinking_signature** ⭐ | **签名回放**:原始块通过、篡改单字节块被明确拒绝 |
| | consistency | model 字段匹配 + 多次响应稳定性(CV) |
| | knowledge | 5 道 Anthropic 公司知识题 |
| **能力** | pdf | base64 PDF + magic string 提取 |
| | structured_output | tool_use schema 校验(5 项子检查) |
| **协议** | protocol | 字段、content block 类型、SSE 序列 |
| | integrity | stream / non-stream 一致性 |
| | message_id | id / toolu_ / srvtoolu_ 前缀校验 |
| | token_usage | usage 字段虚报识别 |
| **加测** | long_context | 三层 needle-in-haystack 探针(详见上方独立子节) |

### OpenAI(Chat Completions)— 8 项

> **杀手锏**:`usage` 字段后端指纹 — 若返回里残留 `claude_cache_creation_*`、
> `usage_source: anthropic`、Anthropic 命名(`input_tokens` / `output_tokens`)
> 等异源痕迹,直判 critical 级,verdict 上限锁在 marginal。

| 类别 | 检测器 | 核心检测点 |
|---|---|---|
| **真伪** | basic_request | 最小合规请求 — 中转站能不能按 OpenAI 协议正常回话 |
| | model_consistency | model 字段匹配 + 多次响应稳定性 |
| **能力** | function_calling | `tool_calls` 结构 + `call_` ID 校验 |
| | structured_output | `response_format` json_schema strict 模式 |
| **协议** | protocol | 字段形状 + SSE 序列 + `usage` 后端指纹 |
| | integrity | stream / non-stream 一致性 |
| | token_billing / token_parity | 用量异常 / 流式与非流式 token 比对 |
| **加测** | long_context | 三层 needle-in-haystack 探针(详见上方独立子节) |

### Gemini(OpenAI 兼容协议)— 7 项

> **杀手锏**:Gemini 3 thinking-by-default 适配 — 真品强制带 thinking 元数据,
> 假冒包装层经常漏字段或返回结构不符。

| 类别 | 检测器 | 核心检测点 |
|---|---|---|
| **真伪** | basic_request | 最小合规请求 — 中转站能不能按协议回话 |
| | model_info | model 字段匹配 + 多次响应稳定性 |
| **能力** | function_calling | `tool_calls` 结构 + thinking 模式适配 |
| | structured_output | `response_format` json_schema strict 模式 |
| **协议** | protocol | 字段形状 + SSE 序列校验 |
| | integrity | stream / non-stream 一致性 |
| | token_usage | usage 字段合理性 |

---

## 两种使用方式

### A. 使用已部署的网页

打开网页 → 选协议页(Claude / OpenAI / Gemini)→ 粘贴 `base_url + api_key + model` → 点检测,30–75 秒出报告。

报告自带永久分享链接 `/r/{id}` 和 JPG 卡片 `/r/{id}.jpg`,可直接发到微信群、知乎、V2EX、Reddit。

### B. 自托管(CLI + Web 服务)

#### 安装

```bash
git clone YOUR_REPOSITORY_URL 格物
cd 格物/detector
python3 -m venv venv
./venv/bin/pip install -e ".[dev,web]"
```

#### CLI 用法

```bash
# 配置中转站凭据
cp .env.example .env
nano .env  # 填 ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY / ANTHROPIC_MODEL

# 单次连通性测试(秒级,几乎零成本)
./venv/bin/gewu ping --model claude-haiku-4-5

# 跑完整检测(约 1 分钟,~$0.012)
./venv/bin/gewu detect \
  --model claude-haiku-4-5 \
  --mode full \
  -o out/test.json

# 跟官方基线对比(自动从 data/baselines/ 找)
./venv/bin/gewu compare out/test.json
```

`compare` 输出长这样:

```
╭─── 基线对比报告 ───╮
│ baseline: 100.0    │
│ relay:    63.1     │
│ ✗ 严重: 总分 -36.9 │
╰────────────────────╯
┏━━━━━━━━━━━━━━┳━━━━━━┳━━━━━┳━━━━━━━━━━━━━━━━━━━━━━━┓
┃ 项           ┃ relay ┃ Δ   ┃ 差异详情               ┃
┡━━━━━━━━━━━━━━╇━━━━━━━╇━━━━━╇━━━━━━━━━━━━━━━━━━━━━━━┩
│ 思维签名验证 │ 0     │-100 │ thinking 块完全没返回  │
│ PDF 文档识别 │ 50    │ -50 │ 'responded_but_missed' │
│ 消息标识规范 │ 50    │ -50 │ id 是 UUID + 'tool_1'  │
└──────────────┴───────┴─────┴────────────────────────┘
```

| 级别 | 含义 | 典型场景 |
|---|---|---|
| **✗ 严重 (critical)** | 几乎确定不是真品 | thinking 块缺失 / PDF 剥离 / tool_use 假 ID |
| **⚠ 重大 (major)** | 疑似伪装 / 能力降级 | response.model 不匹配 / 用 UUID 替代 msg_ |
| **▲ 轻微 (minor)** | 能用但有协议偏差 | 1-2 题失败 / CV 偏高 / 1-2 个 issues |
| **✓ 一致 (ok)** | 跟官方基线一致 | 关键字段全部匹配 |

#### 启动 Web 服务(本地)

```bash
./venv/bin/uvicorn web.server:app --host 0.0.0.0 --port 8000
# 浏览器访问 http://localhost:8000
```

线上版还提供:
- `/leaderboard` 中转站红黑榜,按域名聚合所有公开报告
- `/r/{id}` 可分享的公开检测报告(HTML + JPG)
- `POST /api/detect` 提交检测任务(异步)
- `/faq` 常见问题(35+ 问答,含 JSON-LD 结构化数据)

---

## 三档运行模式

| 模式 | 包含项 | 请求数 | 耗时 | 成本(Haiku) |
|---|---|---|---|---|
| `quick` | 5 项核心 | ~8 | ~15s | 依模型与实际输出而定 |
| `standard` | 8 项 | ~14 | ~40s | 依模型与实际输出而定 |
| `full` | 全部 11 项 | ~16–18 | ~70s | 依模型与实际输出而定 |

报告会记录实际请求数和 token 用量。签名回放验证比旧版多 2 次低输出上限的对照请求。

⚠️ `compare` 命令需要 `full` 模式 — quick / standard 跑出来的报告没有对应基线。

---

## CLI 详细参考

### `detect`

```bash
gewu detect [OPTIONS]
```

| Flag | 默认 | 说明 |
|---|---|---|
| `--base-url` | `$ANTHROPIC_BASE_URL` | 中转站根 URL |
| `--api-key` | `$ANTHROPIC_API_KEY` | API key |
| `--model` | `claude-haiku-4-5` | 测试目标模型 |
| `--mode` | `standard` | `quick` / `standard` / `full` |
| `--protocol` | 自动 | `anthropic` / `openai` / `gemini` |
| `--max-concurrent` | `3` | 并发请求数 |
| `--timeout` | `30` | 单请求超时秒数 |
| `--output` `-o` | stdout | JSON 报告输出路径 |

### `compare`

```bash
gewu compare <relay_report.json> [-b baseline.json] [-o diff.json]
```

自动从 `data/baselines/{model}_full.json` 找对应基线。

### `ping`

```bash
gewu ping --model claude-haiku-4-5
```

打印响应字段 + usage + latency,适合快速验证 base_url / api_key 能不能用。

---

## 收集官方基线(bench.sh)

工具自带 `bench.sh` 跑官方 Anthropic API 收集"真品参考"。**只在 baseline 缺失或需要刷新时才需要跑**。

```bash
# 用真官方 API key(不能是中转站 key)
OFFICIAL_KEY=sk-ant-XXXXX  ./bench.sh -o data/baselines

# 仅跑指定模型
OFFICIAL_KEY=sk-ant-XXXXX  ./bench.sh --models 'claude-opus-4-7 claude-haiku-4-5'
```

跑一次成本约 $0.15(4 个模型 × full 模式)。

---

## 项目结构

```
detector/
├── README.md                   # 本文档
├── DESIGN.md                   # 详细技术设计
├── pyproject.toml              # 依赖 + 包配置
├── bench.sh                    # 收集官方基线脚本
├── deploy.sh                   # 部署同步脚本
├── gewu.service             # systemd unit
├── gewu-monitor@.service    # 单目标定时检测 systemd 模板
├── gewu-monitor@.timer      # 默认每小时执行，带随机抖动
│
├── data/baselines/             # 已验证的官方基线
│   ├── claude-opus-4-7_full.json
│   ├── claude-sonnet-4-6_full.json
│   ├── claude-haiku-4-5_full.json
│   └── claude-opus-4-6_full.json
│
├── src/relay_detector/
│   ├── cli.py                  # typer CLI: detect / compare / ping
│   ├── core/                   # 协议无关的框架层
│   │   ├── detectors_base.py   # ActiveDetector / PassiveDetector 基类
│   │   ├── runner.py           # 并行调度
│   │   ├── scorer.py           # 加权评分 + verdict 阈值
│   │   ├── comparator_framework.py
│   │   └── models.py           # Protocol/Mode enum、DetectionReport
│   └── protocols/
│       ├── anthropic/          # Claude 11 detector
│       ├── openai/             # GPT 7 detector
│       └── gemini/             # Gemini 7 detector
│
├── web/                        # FastAPI 网页端
│   ├── server.py               # 路由:/、/claude、/openai、/gemini、/r/{id}、/leaderboard、/faq
│   ├── jobs.py                 # 任务队列(asyncio Semaphore 限并发 6)
│   ├── probe.py                # 提交前 GET /v1/models 探活
│   ├── leaderboard.py          # 中转站红黑榜聚合
│   ├── image_report.py         # 报告 → JPG 卡片
│   ├── ratelimit.py            # IP 限速
│   ├── faq_data.py             # FAQ 内容(含 JSON-LD)
│   ├── static/                 # CSS / JS / robots.txt / sitemap.xml / llms.txt
│   └── templates/              # hub / claude / openai / gemini / leaderboard / faq / result
│
├── scripts/
│   ├── build_test_pdf.py       # 生成 PDF 测试文档
│   └── bai_api_probe.py
│
└── tests/                      # pytest 单元测试
```

---

## 评分体系

```
total_score = Σ (detector.score × detector.weight) / Σ effective_weight
              for detector if status != "skip"

verdict:
  ≥ 85       passed (优秀)
  70 – 84    passed (通过)
  50 – 69    marginal (基本合格)
  <  50      failed (未达标)
```

skip 的检测项不参与分母。OpenAI / Gemini 协议下,任意一项 critical 级 issue(如 usage 字段含异源痕迹)会把 verdict 上限锁在 marginal,即使总分 ≥ 70 也不绿。

---

## 隐私与安全

- **API key 不落盘**:原始 key 不进入 `Job`、报告或日志,只在正在执行的任务局部作用域中短暂使用;任务结束后不再保留引用。
- **报告里 key 脱敏**:显示为 `sk-y7xU••••••0h` 形式。
- **目标地址默认隔离**:在线版拒绝本机、内网、链路本地、云元数据和保留地址,避免把检测服务变成 SSRF 跳板。自托管内网检测须显式设置 `GEWU_ALLOW_PRIVATE_TARGETS=1`。
- **公网强制 HTTPS**:公网 HTTP 页面会禁用 API key 输入，服务端也会在解析表单前返回 426。本地开发才使用 `GEWU_ALLOW_INSECURE_API=1`。
- **浏览器不暂存 key**:跨协议跳转只传递目标地址,用户需要在目标页重新粘贴 API key。
- **代码完全开源**:可审计服务端,或直接 clone 部署到自己机器上。
- **无追踪 / 无注册**:线上服务不要求注册账号、不写 cookie、不接埋点。

---

## 已知 Anthropic API 协议漂移

工具开发过程中发现 7 处官方文档与实测不符,每处都已在代码里防御处理:

| # | drift | 处理 |
|---|---|---|
| 1 | `anthropic-request-id` header 实测不返回 | 不再校验该 header |
| 2 | 模型自报 cutoff 不准 | 删除该题 |
| 3 | `tool_use.caller` 实际是 dict 不是 string | caller 非 string 时不扣分,记录 keys |
| 4 | Opus 4.7 `temperature` 参数 deprecated,传了 400 | 客户端层按 model 派发剥离 |
| 5 | Opus 4.7 `enabled+budget_tokens` thinking 模式被禁用 | 改用 adaptive thinking |
| 6 | Opus 4.7 `effort` 参数应放 `output_config.effort` | 移到正确位置 |
| 7 | Opus 4.7 streaming 模式 thinking 块不出现(non-stream 正常) | thinking detector 切非流式 |

详见 [DESIGN.md](DESIGN.md)。

---

## 部署 / 同步

推荐 Ubuntu 24.04 / Python 3.12。服务器先安装 `python3-venv`、`rsync` 和
`curl`。公网部署还必须先准备 `/etc/gewu.env`，不要把用户提交的中转 key
写入这个文件：

```bash
install -m 0600 /dev/stdin /etc/gewu.env <<'EOF'
GEWU_SITE_URL=https://<your-domain>
GEWU_SOURCE_URL=https://<public-source-repository>
GEWU_ALLOW_PRIVATE_TARGETS=0
GEWU_ALLOW_INSECURE_API=0
EOF
```

随后执行：

```bash
# 第一次部署：同步、建 venv、创建低权限用户和数据目录、安装 unit、启动并验证 /readyz
./deploy.sh --host root@<server> --install-systemd --test

# 增量更新
./deploy.sh
./deploy.sh --reinstall        # 改了 pyproject.toml 后重装依赖
./deploy.sh --test             # 同步后远程跑 pytest 验证
./deploy.sh --test --restart-service  # 测试通过后重启，并确认服务 active
./deploy.sh --dry-run          # 预览会改什么,不动文件
```

生产安装只包含 `[web]` 依赖；`--test` 才临时加入 `[dev]`，两者都受
`constraints.txt` 的已验证版本约束。`deploy.sh` 默认仍只同步，不会自动重启。
`--install-systemd` 只允许固定生产路径
`/opt/gewu-detector`，避免 unit 路径与实际目录悄悄分叉；自定义路径需人工维护对应
unit。排除项:`venv/`、`test-venv/`、`__pycache__/`、`.git/`、`.env`、`.env.bak`、`*.bak`、
`baselines/`、`out/`、`tmp/`、`web_data/`。

网页服务只监听 `127.0.0.1:8765`，不要直接暴露该端口。Nginx 示例位于
`deploy/nginx-gewu.conf.example`：替换域名、启用站点并用 Certbot 配置 HTTPS；
在 HTTPS 生效前不要让用户提交 API key。
公网切换后执行无密钥冒烟：

```bash
python3 scripts/smoke_web.py https://<your-domain>
```

当前任务队列在单个 Web 进程内；已完成报告会落盘，但重启会中断当时排队或运行中的
检测。Beta 更新应避开活跃检测窗口，正式扩容前再引入持久任务队列。

### 定时质量监控

`monitor-once` 每次只执行一轮检测，将报告原子写入
`GEWU_JOBS_DIR/<protocol>/`，现有历史页和 leaderboard 会直接读取。
目标配置不接收明文 key 参数；systemd 使用隔离 credential 文件。

```bash
# 安装模板
cp gewu-monitor@.service gewu-monitor@.timer /etc/systemd/system/
install -d -m 0700 /etc/gewu-monitor

# 不含密钥的目标配置
cat >/etc/gewu-monitor/claude-opus.env <<'EOF'
GEWU_MONITOR_BASE_URL=https://relay.example
GEWU_MONITOR_MODEL='claude-opus-4-8'
GEWU_MONITOR_PROTOCOL=anthropic
GEWU_MONITOR_MODE=quick
GEWU_MONITOR_MAX_CONCURRENT=2
EOF

# 密钥独立保存；LoadCredential 只在任务进程内暴露
install -m 0600 /dev/stdin /etc/gewu-monitor/claude-opus.key <<'EOF'
sk-replace-me
EOF

systemctl daemon-reload
systemctl enable --now gewu-monitor@claude-opus.timer
systemctl list-timers 'gewu-monitor@*'
```

默认每小时执行 quick，并加入 0–10 分钟随机抖动，减少固定时刻探针被针对。
建议另建 daily/weekly 实例执行 standard/full；长上下文默认关闭，只应在单独的
低频实例中显式设置 `GEWU_MONITOR_LONG_CONTEXT=1`。

实例级 timer drop-in 可以调整频率，而不复制 unit。下面把 standard 改为每天、
full 改为每 7 天；空赋值用于清除模板继承的每小时设置：

```bash
systemctl edit gewu-monitor@claude-standard.timer
# 写入：
[Timer]
OnUnitActiveSec=
OnUnitActiveSec=1d
RandomizedDelaySec=
RandomizedDelaySec=30min

systemctl edit gewu-monitor@claude-full.timer
# 写入：
[Timer]
OnUnitActiveSec=
OnUnitActiveSec=7d
RandomizedDelaySec=
RandomizedDelaySec=2h

systemctl daemon-reload
systemctl enable --now \
  gewu-monitor@claude-standard.timer \
  gewu-monitor@claude-full.timer
```

两个实例应分别使用自己的 `.env` 和 credential 文件，并将
`GEWU_MONITOR_MODE` 设置为 `standard` / `full`。不要让多个高成本任务在同一
时间窗口运行。

非 systemd 环境可引用已有环境变量，不把 key 写进命令历史：

```bash
export RELAY_MONITOR_KEY='sk-...'
gewu monitor-once \
  --target-id claude-opus \
  --base-url https://relay.example \
  --model claude-opus-4-8 \
  --protocol anthropic \
  --api-key-env RELAY_MONITOR_KEY \
  --output-root ./web_data/jobs
```

---

## 开发

```bash
# 装本地依赖
python3 -m venv venv
./venv/bin/pip install -e ".[dev,web]"

# 跑全部测试
./venv/bin/pytest tests/ -v

# 重新生成 PDF 测试文档
./venv/bin/python scripts/build_test_pdf.py
```

### 加新 detector

1. `src/relay_detector/protocols/<protocol>/detectors/` 新建文件
2. 继承 `ActiveDetector` 或 `PassiveDetector`
3. 实现 `run()`(active)或 `observe()` + `finalize()`(passive)
4. 注册到对应 `detectors/__init__.py` 的 `build_all()`
5. `protocols/<protocol>/config.py` 加权重和 mode 映射
6. 写测试

---

## 常见问题

**Q: `compare` 报错"找不到基线文件"**
A: `compare` 自动按 `target_model + mode` 在 `data/baselines/` 找。如果你测的 model 没有对应基线,跑 `bench.sh` 收集,或显式 `-b baseline.json` 指定一个相近的。

**Q: 中转站的 model 名带 `-thinking` 后缀**
A: 这是某些中转站的 routing 约定。它跟 `tool_choice: "any"` 不兼容,会导致 StructuredOutputDetector 报 400。改用不带后缀的模型名即可,detector 自己会按需开 thinking。

**Q: 我想测一个工具没覆盖的模型 / 协议**
A: 当前覆盖 Anthropic Messages API、OpenAI Chat Completions、Gemini OpenAI 兼容 API。其他协议(Anthropic Bedrock、Vertex AI 原生 API 等)欢迎 PR。

---

## License

**AGPL-3.0-or-later** — 见 [LICENSE](LICENSE)。

简单说:
- ✅ 自用、修改、内部部署:随便,免费
- ✅ 自托管研究、学术使用:随便,免费
- ⚠️ **作为公开 SaaS 运行**(给第三方提供服务):**必须把你的修改也开源**(AGPL §13 网络条款)

如需合作，请使用部署方公开的联系方式。

## 贡献

公开部署前请通过 `GEWU_SOURCE_URL` 配置当前版本的源码仓库地址。
欢迎 issues / PRs / fork — 完整贡献指南见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 为什么开源

格物 的核心交易是「你把 API key 给我,我帮你测中转站真假」。这件事的基础是**信任**:
- 你凭什么相信我们不偷 key?
- 你凭什么相信评分不是收钱定的?

答:**代码全部公开,你可以自己审计**。凡是涉及评分、检测逻辑、API key 处理的代码,都在这个 repo 里,可逐行复核。
