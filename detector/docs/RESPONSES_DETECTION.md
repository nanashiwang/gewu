# Responses 能力检测

公共 `/openai` 表单提供 Responses 与 Chat Completions 选择。GPT 默认推荐 Responses 的快速档；切换接口不会执行模型请求。已有 API 调用方不传 `wire_api` 时仍使用 Chat Completions，账号站点的定时检测也保持原接口。

模型目录只是候选。读取中转站 `/models` 后，Responses 可显示该入口声明的文本 Pro/Codex 型号，Chat Completions 继续排除这些受限型号；不自动替换模型或承诺权限。

## 检测与费用边界

| 深度 | 覆盖 | 请求上限 |
|---|---|---|
| quick | 随机文本挑战、流式完整性 | 2 |
| standard | 上述项目及严格 JSON 结构 | 3 |
| full | 上述项目及工具调用往返 | 5 |

每次请求设置 `max_output_tokens=4096`，包含推理 Token。全部请求设 `store=false`；无自动重试、付费预检、补充 TTFT 请求或接口降级。失败可以提前结束，因此实际请求数可能小于上限。长上下文选项与 Responses 不兼容，服务端与 CLI 会拒绝同时启用。

这些是请求与输出预算，不是固定价格或账单承诺。输入（含工具定义和续接内容）也可能计费；失败请求可能产生费用。报告中的 Token 数仅为上游返回的 Usage 汇总。部分请求没有完整用量时，`performance.usage_complete=false`，不得将已知数值当成全部消耗。

## 证据规则

- HTTP 200 不代表完成。顶层错误、`failed`、`incomplete`、无效输出或缺少用量时不判通过。
- 流式检查要求合法 created、文本增量、文本结束和 completed 事件，核对事件顺序、响应与消息 ID、增量及最终文本。中断、错误事件、重复完成或不一致内容都无法取得可计分证据。
- 结构化输出使用 `text.format` 与 strict schema，核对 JSON 结构及随机挑战值。
- 工具仅允许 `gewu_echo` 与严格的随机 nonce 参数。模拟函数在格物内生成新的随机 receipt，通过匹配 `call_id` 回传，并验证模型继续回复该 receipt。不会执行模型生成的代码、网络请求或外部工具。
- 续接会保留原 reasoning / function call Items，请求加密 reasoning 以支持 `store=false`。这些 Items 只在本次内存中使用，不写入证据报告。
- 基础请求无效时停止后续请求；鉴权失败时取消剩余探针。已发出的请求可能仍然计费。
- 报告、任务元数据、状态 API 和 JPG 记录或显示 Responses 接口。未选深度中的项目显示未测试，404/405 说明接口或模型未开放，不能确认具体是哪种限制。
- Responses 报告不能进入现有公共榜单，即使被手动加上审核元数据也不能与 Chat Completions 分数混算；`baseline_version=not_available`，不借用旧接口基线。
- 通过只证明本次已测能力符合预期。随机挑战可以避免固定回答误过测试，不能认证模型身份或抵御所有针对检测器的定制伪装。

## 使用

网页：打开 `/openai`，选择模型与 Responses，确认检测深度、请求上限后提交。

CLI（从环境读取凭据，不把密钥写进命令历史）：

```bash
gewu detect --protocol openai --wire-api responses \
  --base-url https://relay.example/v1 --model YOUR_MODEL --mode quick \
  --output responses-report.json
```

Web API：向 `/api/detect/openai` 提交原有表单字段，并增加 `wire_api=responses`。旧请求不增加字段时行为不变。

## 验证

`tests/test_responses_detection.py` 使用 HTTP 模拟上游，覆盖三档预算、三种证据输出、工具完整往返、鉴权/限流/重定向、HTTP 200 错误、流截断与篡改、响应体上限、取消清理、状态持久化、权限入口、CLI 默认兼容和榜单隔离。测试不调用真实模型。

协议依据（2026-10-12 核对）：
- https://developers.openai.com/api/docs/guides/migrate-to-responses
- https://developers.openai.com/api/docs/guides/function-calling

真实服务商兼容性需使用获准的测试凭据另行验证；模拟测试通过不表示某个真实中转已通过。
