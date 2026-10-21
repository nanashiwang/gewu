# Responses 能力检测

首页一次填写地址、Key 和模型，默认完整检测；点击后直接进入进度与报告。GPT 自动使用 Responses，首页不再显示接口下拉框；确需指定 Chat Completions 时，可主动进入独立的高级配置页。`/openai` 的 GPT 表单同样默认 Responses 完整档。切换接口、深度或读取检测范围不会发送模型请求。

模型目录只是候选。读取中转站 `/models` 后，Responses 可显示该入口声明的文本 Pro/Codex 型号，Chat Completions 继续排除这些受限型号；不自动替换模型或承诺权限。

## 两套预算，不能静默增加旧任务费用

网页明确使用 `responses_suite=extended`，提交前展示覆盖与请求上限：

| 深度 | 覆盖 | 检查数 | 模型请求上限 |
|---|---|---:|---:|
| quick | 随机文本挑战、流式完整性 | 2 | 2 |
| standard | 上述项目 + 严格 JSON、工具往返、指令优先级、多轮上下文 | 6 | 8 |
| full | 上述项目 + 嵌套 JSON、指定工具、禁用工具、多工具调用 | 10 | 12 |

工具往返和上下文检查各需两次请求，其余各一次；不是把同一次回答拆成十条“通过”。全程串行，标准和完整档整批超时分别为 240、360 秒。超时会取消剩余检查，不启动后台补测。

不传 `responses_suite` 的旧 API、CLI、官方基线采样及定时任务继续使用 `core`：

| 深度 | 覆盖 | 检查数 | 模型请求上限 |
|---|---|---:|---:|
| quick | 随机文本挑战、流式完整性 | 2 | 2 |
| standard | 上述项目 + 严格 JSON | 3 | 3 |
| full | 上述项目 + 工具调用往返 | 4 | 5 |

旧调用不传 `wire_api` 时也仍使用 Chat Completions。增强方案只适用于 OpenAI Responses；与其他接口组合会在排队前被拒绝。旧任务状态中缺少方案字段时按 `core` 读取，不自动升级或重跑。

每次请求设置 `max_output_tokens=4096`，包含推理 Token。全部请求设 `store=false`；无自动重试、付费预检、补充 TTFT 请求或接口降级。失败可以提前结束，因此实际请求数可能小于上限。长上下文选项与 Responses 不兼容，服务端与 CLI 会拒绝同时启用。

这些是请求与输出预算，不是固定价格或账单承诺。输入（含工具定义和续接内容）也可能计费；失败请求可能产生费用。报告中的 Token 数仅为上游返回的 Usage 汇总。部分请求没有完整用量时，`performance.usage_complete=false`，私有报告与分享图均保留此限制，不得将已知数值当成全部消耗。整批输出速率不是单次模型生成速度。

## 十项检查分别验证什么

| 检查 | 验证方式 | 不作出的结论 |
|---|---|---|
| 基础回复 | 返回本次生成的随机文本 | HTTP 200 或模型自报名称不证明模型身份 |
| 流式完整性 | 核对事件顺序、ID、增量、结束文本与完成信号 | 不额外发送测速请求 |
| 结构化输出 | 严格 JSON Schema、字段类型和随机值 | 只说明本次约束满足情况 |
| 工具往返 | 校验本地模拟函数参数，再回传新的随机回执 | 不执行模型生成的代码、网络请求或外部工具 |
| 指令优先级 | 互相冲突的开发者规则与用户请求 | 不是通用安全性或抗攻击认证 |
| 多轮上下文 | 回放完整前一轮，取回其中的随机标记 | 不是长上下文容量测试，也不是服务商会话存储测试 |
| 嵌套 JSON | 对象、数组、枚举、整数、顺序及禁止额外/重复字段 | 不把能输出普通 JSON 等同于所有 schema 均受支持 |
| 指定工具 | 多个候选中强制选择指定函数，核对随机参数 | 不执行函数 |
| 禁用工具 | `tool_choice=none`，要求普通文本且无函数调用 | 只记录本次是否遵守禁用约束 |
| 多工具调用 | 请求两个独立调用，校验唯一调用 ID、名称和各自参数 | 允许多调用不保证每次都返回两个；单次未通过不证明换模 |

## 证据与版本规则

- HTTP 200 不代表完成。顶层错误、`failed`、`incomplete`、无效输出或缺少用量时不判通过。
- 流式检查要求合法 created、文本增量、文本结束和 completed 事件，核对事件顺序、响应与消息 ID、增量及最终文本。中断、错误事件、重复完成或不一致内容都无法取得可计分证据。
- 续接会保留原 reasoning / function call Items，请求加密 reasoning 以支持 `store=false`。这些 Items 只在本次内存中使用，不写入证据报告。
- 基础请求无效时停止后续请求；鉴权失败时取消剩余探针。已发出的请求可能仍然计费。
- 报告、任务元数据、状态 API 和 JPG 记录或显示 Responses 接口。未选深度中的项目显示未测试，404/405 说明接口或模型未开放，不能确认具体是哪种限制。
- 增强方案使用独立 `probe_version=2026-10-21-responses-extended-1`，私有报告、分享页与 JPG 保留对应的十项展示。历史核心方案仍按原四项展示，不伪造新增证据。
- 增强方案暂无匹配的已审核官方基线，不借用核心方案样本；也不全局修改其他协议的探针版本。CLI 基线采集当前仍为核心方案，不宣称可采集增强方案。
- Responses 报告不能进入现有公共榜单，即使被手动加上审核元数据也不能与 Chat Completions 分数混算；`baseline_version=not_available`，不借用旧接口基线。
- 通过只证明本次已测能力符合预期。随机挑战可以避免固定回答误过测试，不能认证模型身份或抵御所有针对检测器的定制伪装。

## 使用

网页：在首页选择 GPT 模型，系统自动匹配 Responses；确认检测范围、请求上限后开始。深度可在折叠选项中改为标准或快速，不增加额外确认页。

CLI（目前仅核心方案；从环境读取凭据，不把密钥写进命令历史）：

```bash
gewu detect --protocol openai --wire-api responses \
  --base-url https://relay.example/v1 --model YOUR_MODEL --mode quick \
  --output responses-report.json
```

Web API：向 `/api/detect/openai` 提交原有表单字段，并增加 `wire_api=responses`。若明确需要增强方案，再添加 `responses_suite=extended`；缺省为 `core`，不自动增加请求预算。

检测范围预览：`GET /api/status/detection-scope?protocol=openai&model=YOUR_MODEL&mode=full&wire_api=responses&responses_suite=extended`，只读取计划，不执行检测或接收 Key。

## 验证

`tests/test_responses_detection.py` 覆盖核心方案预算、协议证据、鉴权、取消、CLI 和榜单隔离；`tests/test_responses_extended.py` 覆盖增强三档真实请求数量、随机挑战、结构与工具反例、超时清理、显式选择、历史任务兼容、私有/分享/JPG 展示和版本隔离。所有上游均为 HTTP 模拟，测试不调用真实模型。

协议依据（增强项于 2026-10-21 核对）：
- https://developers.openai.com/api/docs/guides/function-calling
- https://developers.openai.com/api/docs/guides/conversation-state

真实服务商兼容性需使用获准的测试凭据另行验证；模拟测试通过不表示某个真实中转已通过。
