# 格物中转站后台

## 能力边界

- Payload 用户账号负责注册、登录和会话。
- `relay-sites` 保存站点资料、公开选择、认领/审核状态、定时策略和加密 API Key。
- 创建或更新站点必须保留至少一种有效运营联系方式，便于格物联系站长；联系方式默认私密，仅站长、审核员和管理员可见，只有站长主动勾选后才公开展示。API Base URL 必须使用 HTTPS，避免检测凭证明文传输。
- `relay-checks` 保存手动/定时检测历史；原始报告和错误只对站长及审核员开放。
- FastAPI 检测器仍是唯一检测执行引擎，Next/Payload 只负责任务桥接、账户和历史趋势。
- 当前版本不包含付费收录套餐、订单、支付回调或退款。审核通过仅代表已收录，不能据此标记“已付款”或“推广”。

## 上线必需配置

```dotenv
DETECTOR_BASE_URL=https://gewu.uk
DETECTOR_PUBLIC_URL=https://gewu.uk
RELAY_CRON_SECRET=<至少 24 位强随机值>
RELAY_CRON_INTERVAL_MS=60000
```

`PAYLOAD_SECRET` 是 API Key 密文的根密钥。生产环境不得更换或丢失，否则历史 API Key 无法解密；备份必须包含密钥的异地加密备份。

## 数据库迁移

部署新应用前执行：

```bash
npx payload migrate
```

迁移 `20260718_120000_relay_backend` 会幂等创建中转站和检测历史；`20260718_140000_relay_check_hardening` 会先把历史重复活动任务安全转为 `error`，再创建局部唯一索引，确保同一站点最多存在一个 `queued/running` 任务。

这三项迁移按顺序执行：`20260718_130000_schema_alignment` 会补齐旧数据库缺失的集合、字段、关联和索引，并写入当前完整 schema 快照，避免全新部署在管理员审核时因关联表不完整而返回 500。迁移不会删除现有业务数据，也不会覆盖已存在的表、列或索引；正式执行前必须先完成数据库备份，不能依赖自动 down 回滚。

## 定时任务

`docker compose up -d app relay-cron` 会启动独立调度容器，每分钟调用内部 Bearer 鉴权入口：

```text
POST /v1/internal/relay-checks/run
```

一次周期先同步正在运行的 FastAPI 任务，再提交到期站点。连续三次同步失败会把任务转为 `error`；提交后 5 分钟仍没有检测任务 ID，或总执行时间超过 6 小时，也会自动终止，避免永久占用“正在检测”状态。

## 认领与审核

1. 用户创建草稿。
2. 用户在 API 域名添加 `_gewu-verify.<domain>` TXT 记录。
3. 验证成功后提交审核。
4. 审核员通过后公开展示；拒绝/暂停必须填写原因。
5. 修改 API 域名会强制重置认领和审核；修改公开资料会重新进入审核。

DNS TXT 认领只证明域名控制权，不等价于公司资质或资金担保。公开页面必须继续展示这一边界。
