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

## 时效与模型观测

- 所有来源统一采用 30 天有效窗口。当前实测分数仅聚合窗口内的报告，旧低分或高分不会混入当前分数。
- 超过窗口的实测和第三方快照保留在折叠的历史参考中，保留原分数、来源与日期，不代表当前质量。
- 静态榜单禁止使用 `gewu_test` 自报实测资格，只有通过准入的磁盘报告能生成实测条目。
- 无时区、明显未来时间、含凭据或查询参数的接口地址不进入公共证据。
- `/leaderboard/monitor` 是只读入口，不会发起检测或消耗上游额度。按模型、协议、观测入口、模式、检测器版本和基线分组。
- 观测入口只显示地址摘要，不显示路径或任何 Key。内部路由、账号分组无法识别时标注未知，不宣称是独立供应商线路。
- 七天状态条使用 UTC 日期，同一天优先显示异常，其次未完成项，再次通过；色块链接指向产生该状态的报告。
- 只有有效且经审核的样本进入状态条，不能用它计算可用率；没有合格证据显示无有效样本，不能当成故障或通过。
- 移除跨模型、跨模式混合趋势图；最近报告在对应模型观测中分别展示。

部署沿用 `/leaderboard/` 路由前缀，无需变更其他项目或新增 Nginx 转发规则。
仅同步检测器，不更新 Next 平台、发卡系统或酒馆。不调整现有监测频率，不为填充页面运行收费检测。

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
