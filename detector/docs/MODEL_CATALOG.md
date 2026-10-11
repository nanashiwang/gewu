# 模型目录维护

统一来源：`src/relay_detector/model_catalog.py`。2026-10-11 核对了九家厂商的官方公开资料；每家目录保留官方来源，不从第三方价格榜推断正式型号。

公开页面使用 `/leaderboard/models`，归属现有检测站代理前缀。同域名的 `/models` 属于 Next 项目，不能占用。上线必须从公网点击目录链接验证，不能只检查回环端口。

## 核对与更新

1. 每日 GitHub 工作流读取官方公开页面，比较可见模型 ID 快照。网络/解析失败单独报错，不冒充“无变化”；超过 30 天未人工复核也会失败。此流程不使用 Key、不调用推理、不自动改目录。
2. 维护者读取变更的模型、下线与迁移文档，检查可用产品、请求参数、端点、强制工具调用和思考限制。先更新目录与检测能力，再运行回归测试。
3. 人工确认后更新 `VERIFIED_ON`，运行 `PYTHONPATH=src python scripts/check_model_catalog.py --record` 生成来源 ID 快照，审核差异后一起提交。
4. 执行不带 `--record` 的巡检。差异必须处理，不能只刷新日期或快照来消除提示。巡检是变更线索，不保证捕获所有能力/价格变化。

## 本次能力边界

- Anthropic：Fable 5.1、Opus/Sonnet/Haiku 5.5；保留旧版能力表与历史报告。Opus 5.5/Fable 5.1 常开思考，强制 `tool_choice` 探针跳过。参考官方 `/docs/en/models/opus-5-5/overview`、`/docs/en/models/haiku-5-5/overview`。
- OpenAI：GPT-6 Astra/6.1 Sol 的 Chat Completions 工具调用跳过；6 Sol/Luna 使用 `reasoning_effort=none`。不自动切换 Responses 或模型。参考官方 `https://developers.openai.com/api/docs/guides/latest-model/gpt-6-astra.md`。
- Gemini：更新当前文本模型；2.5 系列标注既有用户限制。不把 Live/TTS/Image/Embedding 当作普通文本候选。
- DeepSeek、Qwen、Kimi、GLM、MiniMax、Grok：先提供基础请求与流式一致性检测。其他项目显示跳过，不套用 OpenAI 的 tokenizer、模型身份证据与计费规则。GLM/Kimi 新模型使用低思考强度；预留输出预算，不对默认思考模型发送极小输出上限。
- MiniMax-M3.1-Flash-Preview 标注仅 M Plan/Code。参考 `https://platform.minimax.io/docs/api-reference/text-openai-api`；GLM 参考 `https://docs.z.ai/guides/llm/glm-5.3` 与 `/guides/vlm/glm-5.3-flash`。
- 未知厂商：用户主动选择“其他”后，从当前接口读取型号，仍需明确选中。仅按基础兼容范围检测。任何名称或接口声明都不证明模型身份。

真实上游调用需要用户的额度；本次验证使用模拟接口。新增候选没有伪造身份基线或官方价格。基础兼容报告在准入检查中明确排除，即使人工标记审核通过也不能进入公共榜单。
