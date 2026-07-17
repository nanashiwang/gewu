# Changelog

All notable changes to **格物** are documented here.
This project adheres to [Semantic Versioning](https://semver.org/) and the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

公开站点地址由部署方通过 `GEWU_SITE_URL` 配置。

## [Unreleased]

### Added
- Caddy structured access logs(JSON 格式,含 Cf-Connecting-Ip / Referer / User-Agent)
- 用户画像分析工具 `scripts/analyze_access_log.py` — 把访问者按行为分群
  (比价决策买家 / 疑似中转站运营者 / 自测开发者 / 看了测试页未提交 / 浅浏览 / 一次性跳出 / 爬虫)
- 报告点击排行榜 + 报告评分分布直方图 + 检测可靠性 Dashboard
- Claude thinking block 原始回放 + 单字符篡改负向对照
- 在线目标 SSRF 防护、请求体上限、分域限流、有界任务队列和安全响应头
- Web 出站 HTTP 禁用环境代理继承,避免绕过目标边界或把 key 交给意外代理
- 96-bit 随机报告 ID、报告/错误递归 key 脱敏和有界内存缓存

### Changed
- README:H1 + 首段加中文 SEO 关键词与锚文本回链,提升搜索引擎可见度
- GitHub repo description:关键词前置(去 emoji 占位)
- Claude 报告 tier 从 `cryptographic` 改为 `signature_roundtrip`;旧值仍可读取
- 跨协议跳转不再在浏览器会话中暂存 API key,目标页要求重新粘贴
- 检测结论统一改为“协议证据/风险评估”,不再承诺绝对模型真伪

## [0.1.0] - 2026-05-10

### Added
- 三协议检测:Anthropic Messages API、OpenAI Chat Completions、Gemini OpenAI 兼容协议
- Claude thinking signature 字段检测(现已由 Unreleased 的原始/篡改回放取代)
- OpenAI usage 字段后端指纹识别(检测 `claude_cache_creation_*` 异源痕迹的「换芯」中转站)
- Gemini 3 thinking-by-default 适配
- 三层 needle-in-haystack 长上下文探针(32k → 1M tokens),抓「宣传 1M 实际只给 200k」式欺诈
- 加权评分 + critical issue 一票否决(单项 critical 把 verdict 上限锁在 marginal)
- 三档运行模式:quick / standard / full(费用取决于模型、实际输出和中转站定价)
- Web 服务:FastAPI + 异步任务队列、IP 限速、报告 JPG 卡片生成
- 中转站红黑榜:按域名聚合公开报告,贝叶斯排序防 1-sample 刷分
- 可分享链接 `/r/{id}` 与社交分享图片 `/r/{id}.jpg`
- CLI 工具 `gewu`:`detect` / `compare` / `ping` 三个子命令
- 官方基线收集脚本 `bench.sh`(Opus 4.7 / Sonnet 4.6 / Haiku 4.5 / Opus 4.6)

### Privacy
- 原始 API key 仅用于调用用户配置的目标中转站,不写报告、不持久化到磁盘
- 报告中 key 脱敏为 `sk-y7xU••••••0h` 格式
- 无注册;统计脚本仅在部署方显式配置 analytics ID 时加载
