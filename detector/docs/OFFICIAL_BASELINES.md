# 官方采样与审核

官方直连检测保留。外部状态页只用来排查厂商事故，不参与评分，也不能替代官方协议采样。当前没有可用的已审核新样本时，网页必须显示暂缺基线；不回填历史样本的来源或版本。

## 1. 先离线预览

在 detector 目录运行（`gewu` 为已安装的 CLI）：

```sh
gewu baseline-collect --protocol openai --model gpt-4.1 --wire-api responses --mode quick --max-requests 2 --max-output-tokens 8192 --max-payload-bytes 65536
```

模型 ID 仅作命令示例，执行前核对账号当前可用型号；程序不自动选模。默认只输出计划，不联网、不写文件、不发送或显示凭据。CLI 沿用项目原有的当前目录 `.env` 加载行为；预览不要求 Key。Claude 使用 `anthropic/messages`；OpenAI 使用 `openai/chat_completions` 或 `openai/responses`；Gemini 使用 `gemini/chat_completions`、`gemini/interactions` 或 `gemini/generate_content`。

## 2. 明确预算后执行

只从专用环境变量读取官方 Key：`GEWU_OFFICIAL_ANTHROPIC_KEY`、`GEWU_OFFICIAL_OPENAI_KEY`、`GEWU_OFFICIAL_GEMINI_KEY`。由服务器凭据管理注入，不写入仓库、命令参数或日志，不使用中转 Key。确认官方账号支出上限后，在同一条命令追加 `--execute`。

- 固定官方端点、指定模型和接口，不跟随重定向；禁用环境代理和传输重试。原有探针的重发仍计入同一预算，不改变探针参数凑预算。
- 每次发送前预留该请求声明的最大输出 tokens；累计限制请求次数、输出上限和 JSON 请求体字节。取消、网络中断、鉴权、限流、服务器错误或超限后不再发送请求；等待响应、读取响应及关闭错误响应时被取消也会锁定停止状态，保留取消异常供调用方清理。
- 输入字节不是输入 tokens，预留输出不是实际账单，以上不是美元硬预算；也请设置厂商账号支出上限。不开启长上下文和额外参考采样，无定时器、自动升级预算或自动重跑。
- 候选默认存入 `private_baseline_candidates/`，文件权限 0600，含探针结果和预算记录；输出文件名、SHA256 和审核资格。不输出 Key 或本机路径。错误和不完整候选保留供排查，但不能审核发布。
- 当前 CLI 采样的 Responses 核心方案/Gemini 原生探针最多 2/3/5 次请求，每次输出上限 4096；网页 Responses 增强方案不在当前 CLI 基线采集范围内，不能借用核心方案基线。Claude/兼容协议所需预算取决于模型和探针。预算不足必须重新决定，不能把中途停止当成通过。

## 3. 人工核实后审核

核对候选全文、执行日志、官方账号请求记录，确认凭据与端点属于官方直连，且采样完整。采样记录是本地记录，不是厂商签名证明；不能从任意用户提交的报告直接生成可信官方证据。

```sh
gewu baseline-approve private_baseline_candidates/候选文件.json --sha256 审阅过的完整哈希 --confirm-official-source
gewu baseline-audit
```

审核会再次校验文件哈希、固定来源、计划/报告一致性、预算、评分/探针版本、时效和探针覆盖。按 `协议/接口/模型_深度_UTC时间_哈希.json` 发布，不覆盖旧样本；使用文件锁与原子替换更新独立 `approvals.json`。自定义目录使用 `--baseline-dir`；确保检测服务运行用户具有读取权限，审核目录只允许运营者写入。

审核不会将报告放入公共榜单，不改变 Responses/Gemini 原生接口的榜单限制。变更后的样本与审核清单需要按既有发布流程同步到检测服务。

## 4. 对照与失效

报告页和 CLI `compare` 只选择同模型、协议、接口、深度、评分/探针版本、实际计分项与权重且 30 天内的已审核样本。逐项显示官方、本次及差值；观察项、延迟和实际账单不做差异推断，不修改已保存的报告或榜单分数。

源文件被改动、版本改变、过期、证据不足或范围不匹配时停止对照。分数、权重和加权运算必须处于有效有限数值范围；异常数值作为无效证据处理，不影响其他样本的库存查看。删除对应审核清单项可撤销批准，保留原文件便于复核。不要删除仍在使用的审核清单、把旧样本改成新日期或导入合成测试样本。

接口参数核对来源（2026-10-15）：Anthropic Messages API 文档、OpenAI Responses 创建文档、Google Gemini generateContent / Interactions 文档。实现沿用已有探针，不更换模型或扩大检测结论。
