# 公共榜单证据治理

公共报告与公共排名是两条独立边界：`/r/{job_id}` 报告仍可分享，但只有可信证据可以影响 leaderboard。

## 准入规则

榜单聚合采用 fail-closed 策略。报告必须同时满足：

- `ranking_evidence.eligible=true`；
- `review_status=approved`；
- 来源为 `operator_monitor`、`manual_review` 或 `site_owner_verified`；
- 记录检测器版本、基线版本、审核人和审核时间；
- 没有 `run_error` 或鉴权失败；
- 协议核心探针已经产生 `pass` 或 `fail` 结论；
- 分数、协议、目标模型和地址结构有效。

没有 `ranking_evidence` 的旧报告，以及网页/普通 CLI 产生的用户自测报告，默认不进入榜单。

## 定时监测

`gewu monitor-once` 由服务器受控配置运行，会写入 `operator_monitor` 审核元数据。即使元数据存在，运行错误、鉴权失败或核心探针未完成时仍会被榜单拒绝。

## 人工审核与所有者验证

```bash
gewu approve-ranking-report /opt/gewu-detector/web_data/jobs/openai/<job_id>.json \
  --source manual_review \
  --reviewer <operator-id> \
  --verification-reference <ticket-or-proof>
```

站点所有者完成 DNS TXT 或 `/.well-known/` 文件验证后，将来源改为 `site_owner_verified`。命令会在写盘前重新执行资格校验，不能强行批准无效检测。

## 撤下

```bash
gewu revoke-ranking-report /opt/gewu-detector/web_data/jobs/openai/<job_id>.json \
  --reviewer <operator-id> \
  --reason <reason>
```

撤下只取消排名资格，不删除原始报告和审计记录。运营方应在收到可信的错误报告、所有者申诉或检测器缺陷通知后先撤下，再安排复测。
