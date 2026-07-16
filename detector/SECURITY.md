# 安全策略

先测 AI 的产品本质是「用户把 API key 交给我们检测中转站真伪」。
**所以安全不是我们勾的某个选项,而是产品本身**。

## 我们怎么处理 API key

这是用户最关心的事,代码可逐行验证:

| 我们做了什么 | 你在哪里能验证 |
|---|---|
| 原始 API key 不进入 `Job`,只在正在执行的任务局部作用域中短暂使用 | [`web/jobs.py`](web/jobs.py) 的 `Job` 字段和 `_run()` 参数 |
| key **不写入**报告 JSON | [`web/jobs.py:_run`](web/jobs.py) 只持久化 `mask_api_key()` 结果,并在落盘前递归脱敏反射内容 |
| key **不写入**应用日志或持久错误 | [`web/jobs.py:_run`](web/jobs.py) 和 [`web/probe.py`](web/probe.py) 会对上游反射的 key 再脱敏 |
| 跨协议跳转不把 key 放进 URL 或 `sessionStorage` | [`web/static/app.js`](web/static/app.js) 只暂存 `base_url` 和来源协议 |
| 在线版拒绝访问本机、内网、链路本地、云元数据和保留地址 | [`web/security.py`](web/security.py);自托管内网检测需显式开启 `XIANCE_ALLOW_PRIVATE_TARGETS=1` |
| Web 出站请求不继承服务器的 `HTTP_PROXY` / `HTTPS_PROXY` | [`web/jobs.py`](web/jobs.py) 和 [`web/probe.py`](web/probe.py) 显式使用 `trust_env=False`;CLI 仍保留默认代理行为 |
| key **永不**写数据库 | 我们根本没有数据库 — 只有 JSON 文件,且都已脱敏 |
| 报告里的 key 显示为脱敏形式 `sk-y7xU••••••0h` | [`mask_api_key`](src/relay_detector/models.py) 函数 |
| `.env` 文件 gitignored | [`.gitignore`](.gitignore) |
| 生产部署在自有 VPS,不经任何第三方处理器 | 永不出售、共享、代理 key 给任何上游之外的厂商 |

不放心 SaaS,**clone 到自己机器跑**。这个 repo 的代码就是 your-domain.example 生产
环境的代码,完全一致。

## 报告漏洞

如果你发现下面任何一种情况:

- 能从运行中的服务里提取 API key 的途径(内存 / 进程 / 日志)
- 能让 key 写到磁盘的代码路径,即使是临时的
- 把用户 key 发到非上游目标的代码路径
- 让假冒中转站被错判为真品的检测旁路
- 其他安全相关的问题

**请不要开公开 GitHub issue**。请改用以下方式之一:

- 邮件 / 标记 `[SECURITY]` 但不带敏感细节的 issue,要求私聊渠道;或
- 用 GitHub 自带的[私下漏洞披露](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
  功能(repo 主页 Security 标签)

我们目标 **72 小时内回复**。确认有效后:

- 修复
- 通知 your-domain.example 在线服务运营
- 在合理披露窗口(通常 14 天,严重的会更长)后,通过
  源码仓库的 Security Advisories 公开
- 给报告者署名(如希望匿名我们尊重)

## 范围内(In Scope)

- 本仓库的代码、配置、默认部署设置
- your-domain.example 在线服务
- API key 处理(内存 + 网络 TLS 期望)
- 任何后续管理后台的 auth / authz

## 范围外(Out of Scope)

- **上游中转站漏洞**:`some-relay.com` 自己有 bug 是它们的责任,先测 AI
  只负责检测它们
- **DoS / 限流**:我们就一台 VPS,被 DDoS 是常态运维问题不算漏洞
- **钓鱼网站**:网上可能有人开 `xiance.io` / `xiance.cn` 仿站偷 key,
  我们知道。**只信 `your-domain.example` 这一个域名**
- **自托管错配**:你启 verbose 日志 / 暴露 `web_data/` 是你自己的事,不是
  我们的漏洞

## 防御深度

我们设计时假定服务器本身可能被打穿,所以:

- key 永远不接触磁盘 — 整盘 dump 也找不到 key
- 报告写盘前已脱敏 — 不存在"原始未脱敏"的中间形态
- 代码里没有 verbose 模式会打印 key(故意没有)

如果你在代码里发现以上任何承诺有反例,**请报告**。

## 漏洞赏金

我们没有付费 bounty 计划。但有:

- 公开 credit
- commit co-author 署名(如你愿意)

AGPL 意味着 先测 AI 是社区项目,不是 VC 公司,抱歉没现金。

谢谢你读完。先测 AI 只在它真的可信的时候才有价值,而它持续可信的唯一办法
是有像你这样的人来不断检验它。
