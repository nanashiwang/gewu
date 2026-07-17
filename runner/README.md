# 格物 · 本地 Skill Runner

> 下载 Skill 能力包后，用**你自己的模型与算力**运行 —— 运行不经过中央服务器。

格物 的每个 Skill 都是可移植的能力包（Spec v1：system/user 模板 + 输入/输出 schema + 推荐模型 + checksum）。在详情页**下载**后用本地 Runner 运行；也可先登录把设备绑定到你的账号。

## 命令

```bash
# 登录（设备码流程：终端显示码 → 浏览器 /device 输入码授权）
node runner/gewu.mjs login --hub http://localhost:3000

# 查看登录归属
node runner/gewu.mjs whoami

# 轮换本机 Runner 令牌（旧令牌立即失效）
node runner/gewu.mjs rotate-token

# 安装 Skill：下载冻结 manifest，校验 checksum + ed25519 签名，并打印后续回流指引
node runner/gewu.mjs install xhs-title-generator --hub http://localhost:3000

# 检查本地安装是否过期；过期时先 update，再 run --report
node runner/gewu.mjs outdated

# 运行（默认连本地 Ollama）
node runner/gewu.mjs run xhs-title-generator \
  --hub http://localhost:3000 \
  --endpoint http://localhost:11434/v1 --model qwen2.5 \
  --in topic=秋季护肤 --in style=专业

# 运行本地下载的 manifest 文件 / 用自有网关
node runner/gewu.mjs run ./xhs-title-generator-1.0.0.yaml \
  --endpoint https://your-gateway/v1 --model your-model --key sk-xxx
```

登录令牌保存在 `~/.gewu/config.json`（chmod 600）。如怀疑泄漏，可执行 `rotate-token` 轮换，或在控制台撤销该 Runner 后重新登录。

## 选项（run）

| 选项 | 说明 |
|---|---|
| `--endpoint <url>` | OpenAI 兼容 endpoint（默认 `http://localhost:11434/v1`，即 Ollama） |
| `--model <name>` | 模型名（默认取 manifest 的 `models.local_recommended[0]`） |
| `--key <key>` | endpoint 的 Key（本地模型一般留空） |
| `--hub <url>` | 传入 slug 时从该 Hub 拉取 manifest（默认读取当前 格物 配置目录中的 hub，未配置时使用 `http://localhost:3000`） |
| `--in <key=value>` | 预填输入字段（可重复） |
| `--raw` | 只输出模型原文 |
| `--report` | 回传兼容报告（不含输入/输出原文） |
| `--anon` | 与 `--report` 搭配，匿名回传 |

## 支持的模型后端

任意 **OpenAI 兼容** `/chat/completions` endpoint：Ollama、LM Studio、vLLM、llama.cpp server、LocalAI，或你自己的网关。

> Runner 默认拒绝未签名/签名无效的远端 manifest；自建调试可显式加 `--allow-unsigned`。

## 安装后的可信闭环

`install` 响应会给 Runner 一份 playbook，并在终端提示：

1. 校验 manifest：使用 `/v1/keys` 公钥验证 checksum 与 ed25519 签名。
2. 本地运行：绑定 Ollama、LM Studio、vLLM 或自有 OpenAI 兼容网关。
3. 脱敏回流：`run --report` 只上传成功率、格式、延迟、错误类型等指标，不上传输入/输出原文。
4. 保持新鲜：`outdated` / `update` 先更新 checksum；过期安装提交报告会被 Hub 拒绝。

`outdated` 也会读取 Hub 返回的更新复验 playbook：如果 checksum 过期，先 `update` 重新验签，再用同一输入复验并回传。
