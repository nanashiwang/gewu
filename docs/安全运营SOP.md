# 格物 安全运营 SOP

> 目标：封禁、密钥、充值/兑换、Runner、备份这些高风险动作必须可追溯、可复核、可回滚。

## 1. 封禁处置

1. 只通过 `/console/moderation` 的举报处置入口执行 `ban_target`，不要直接改库。
2. 执行后系统会自动：
   - 将用户 `accountStatus` 置为 `banned`；
   - 尽力把 New API 子令牌 quota 同步为 0；
   - 把该用户历史 online/Runner 兼容报告置 `suppressed=true`；
   - 写入 `audit-logs:user_banned`。
3. 处置后人工复核：控制台用户状态、Runner 是否还能鉴权、`compat-reports.suppressed` 是否生效。
4. 误封恢复只能由管理员执行：恢复账号后，Runner token 需要用户重新轮换；被 suppressed 的报告不要自动恢复，需逐条复核。

## 2. BYOK / Runner / 资金动作审计

以下动作必须在 `audit-logs` 有记录：

- `byok_set` / `byok_cleared`：用户设置或清除自带模型 Key；
- `runner_token_rotated`：Runner 自助轮换令牌；
- `runner_revoked`：用户或管理员撤销 Runner；
- `credit_recharged`：充值码兑换 credit；
- `points_exchanged`：术值兑换 credit；
- `report_handled` / `user_banned`：举报处置。

审计 metadata 只允许保存脱敏信息；禁止保存模型 Key、Runner token、充值码明文、Authorization 头。
`credit-logs`、`contribution-logs`、`audit-logs` 均为后台只读追加台账；`Users.creditBalance`、`Users.contributionScore` 这类余额快照在新建/编辑用户时也禁止后台手填。修正只能走受控脚本/补偿流水并保留审计；已有资金/术值流水的用户不得物理删除，只能封禁或后续做脱敏匿名化。

## 3. 备份与恢复

1. 每日备份：Postgres dump + media 目录同一时间窗打包。
2. 备份必须离机保存；生产备份文件必须用独立密钥加密，密钥不得放在同一服务器。
3. 每周至少做一次恢复演练到临时库，验证：用户、Skill、SkillRuns、credit-logs、audit-logs 数量一致。
4. 恢复后必须先跑 `npm run worker:preflight-production`，再开放公网流量。
5. 上线前在 `.env` 里确认 `BACKUP_ENCRYPTION_CONFIRMED=1`、`BACKUP_OFFSITE_CONFIRMED=1`、`BACKUP_RESTORE_DRILL_AT=YYYY-MM-DD`；缺任一项 preflight 会阻断。
6. 含 SkillRuns 的备份按敏感数据处理；外发排障前必须脱敏或只给聚合数据。

## 4. New API 对账漂移处理

1. 每次开放术值兑换前，先跑 `npm run worker:reconcile-newapi` dry-run；`--apply` 只在 dry-run 无阻断后执行。
2. 若出现逐用户漂移，系统会写入 `.reconcile-reports/newapi-drift-YYYY-MM.jsonl`（或 `NEWAPI_RECONCILE_DRIFT_REPORT_PATH` 指定的 `.jsonl` 普通文件路径），该文件含用户 ID 与金额，写出走临时文件原子替换、拒绝软链接、强制 `0600`，默认不提交版本库。
3. 先跑 `npm run worker:plan-newapi-drift -- .reconcile-reports/newapi-drift-YYYY-MM.jsonl` 生成只读人工动作清单；该命令只输出建议，不改数据库、不改网关。
4. 按 JSONL 的 `action` 处理：
   - `manual_backfill_local_or_refund_gateway`：New API 多扣、本地少扣；先确认是否需补本地 consume 流水，若是网关误扣则先在 New API 侧退款/归零。
   - `manual_refund_local_or_fix_gateway_undercharge`：本地多扣、New API 少扣；先确认是否需给用户退 credit，若是网关少扣/漏扣则先修子令牌或刻度。
5. 漂移处理完成后，重新跑 dry-run；仍有漂移时不得写回毛利，不得开启兑换池。
6. 对账报告只保留必要时间，外发前必须脱敏用户 ID；严禁写入模型 Key、管理 token、子令牌明文。

## 5. 上线前硬门禁

- `npm run worker:preflight-production` 必须通过；
- `npm run typecheck && npm test && npm run build` 必须通过；
- 真实 New API `/api/log`、quota 刻度、毛利率未校准前，不允许开启术值兑换；
- 生产环境不得开启 `ALLOW_LEGACY_RUNNER_TOKEN_AUTH=1`；
- 生产域名必须 HTTPS，Redis 必须可用。
