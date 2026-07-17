import { mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveReconcileDriftReportPath, writeUserDriftReportFile } from '@/lib/newapiDriftReport'
import {
  buildDriftRemediationPlan,
  formatDriftRemediationPlanJsonl,
  parseUserUsageDriftJsonl,
} from '@/lib/newapiDriftRemediation'
import {
  buildUserUsageDriftReport,
  calculateModelMarginCents,
  calculateTokenPricedCostCents,
  compareUsageDrift,
  formatUserUsageDriftJsonl,
  mergeModelUsageRows,
  resolveReconcileModelMarginRates,
  resolveReconcileMarginRate,
  resolveReconcileToleranceCents,
  resolveUsageSource,
  usageDriftToleranceCents,
} from '@/lib/newapiReconcile'

describe('newapiReconcile — New API 真值与本地 credit 消费漂移检测', () => {
  it('默认容忍 5% 或至少 2 分的舍入误差', () => {
    expect(usageDriftToleranceCents(1000, 980)).toBe(50)
    expect(usageDriftToleranceCents(10, 9)).toBe(2)
  })

  it('显式容忍值可覆盖默认', () => {
    expect(usageDriftToleranceCents(1000, 900, 20)).toBe(20)
  })

  it('漂移超过容忍值时阻断写回毛利', () => {
    const r = compareUsageDrift(1200, 1000)
    expect(r.ok).toBe(false)
    expect(r.driftCents).toBe(200)
    expect(r.toleranceCents).toBe(60)
  })

  it('小额舍入误差通过', () => {
    expect(compareUsageDrift(101, 100).ok).toBe(true)
  })

  it('NEWAPI_USAGE_SOURCE 只能是 newapi/local，禁止非法值静默回退', () => {
    expect(resolveUsageSource({})).toBe('newapi')
    expect(resolveUsageSource({ NEWAPI_USAGE_SOURCE: 'local' })).toBe('local')
    expect(() => resolveUsageSource({ NEWAPI_USAGE_SOURCE: 'manual' })).toThrow('NEWAPI_USAGE_SOURCE')
  })

  it('毛利写回时必须显式配置正毛利率，避免写入伪真值', () => {
    expect(resolveReconcileMarginRate({})).toBe(0)
    expect(resolveReconcileMarginRate({ NEWAPI_MARGIN_RATE: '0.3' }, { requirePositive: true })).toBe(0.3)
    expect(() => resolveReconcileMarginRate({ NEWAPI_MARGIN_RATE: '0' }, { requirePositive: true })).toThrow('NEWAPI_MARGIN_RATE')
    expect(() => resolveReconcileMarginRate({ NEWAPI_MARGIN_RATE: '1.2' })).toThrow('NEWAPI_MARGIN_RATE')
  })

  it('New API 真值毛利必须支持按模型配置不同毛利率', () => {
    const rates = resolveReconcileModelMarginRates({
      NEWAPI_MODEL_MARGIN_RATES: 'deepseek-chat=0.25,qwen-plus=0.18',
    })
    expect(rates.get('deepseek-chat')).toBe(0.25)
    expect(rates.get('qwen-plus')).toBe(0.18)

    const margin = calculateModelMarginCents(
      [
        { modelName: 'deepseek-chat', costCents: 100, usedQuota: 70000, calls: 2 },
        { modelName: 'qwen-plus', costCents: 50, usedQuota: 35000, calls: 1 },
      ],
      rates,
      { requireAllModels: true },
    )
    expect(margin.marginCents).toBe(34) // 100*25% + 50*18%
    expect(margin.byModel.map((r) => [r.modelName, r.marginCents])).toEqual([
      ['deepseek-chat', 25],
      ['qwen-plus', 9],
    ])
  })

  it('按模型毛利写回时，日志缺模型字段或缺模型配置必须 fail-closed', () => {
    const rates = resolveReconcileModelMarginRates({ NEWAPI_MODEL_MARGIN_RATES: 'deepseek-chat=0.25' })
    expect(() =>
      calculateModelMarginCents([{ modelName: 'deepseek-chat', costCents: 100 }], rates, {
        requireAllModels: true,
        missingModelCalls: 1,
      }),
    ).toThrow('缺少模型字段')
    expect(() =>
      calculateModelMarginCents(
        [
          { modelName: 'deepseek-chat', costCents: 100 },
          { modelName: 'qwen-plus', costCents: 50 },
        ],
        rates,
        { requireAllModels: true },
      ),
    ).toThrow('qwen-plus')
  })

  it('模型毛利配置拒绝非法格式、重复模型和越界倍率', () => {
    expect(() => resolveReconcileModelMarginRates({}, { requireConfigured: true })).toThrow('NEWAPI_MODEL_MARGIN_RATES')
    expect(() => resolveReconcileModelMarginRates({ NEWAPI_MODEL_MARGIN_RATES: 'deepseek-chat:0.2' })).toThrow('格式')
    expect(() => resolveReconcileModelMarginRates({ NEWAPI_MODEL_MARGIN_RATES: 'deepseek-chat=1.2' })).toThrow('0-1')
    expect(() =>
      resolveReconcileModelMarginRates({ NEWAPI_MODEL_MARGIN_RATES: 'deepseek-chat=0.2,deepseek-chat=0.3' }),
    ).toThrow('重复')
  })

  it('同一模型跨用户用量会先合并并可按总 quota 重算分值，避免逐用户舍入放大', () => {
    expect(
      mergeModelUsageRows([
        { modelName: 'deepseek-chat', costCents: 1, usedQuota: 350, calls: 1 },
        { modelName: 'deepseek-chat', costCents: 1, usedQuota: 350, calls: 2 },
      ], { quotaPerCredit: 700 }),
    ).toEqual([
      {
        modelName: 'deepseek-chat',
        costCents: 1,
        usedQuota: 700,
        tokenPricedQuota: 0,
        calls: 3,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    ])
  })

  it('token×/api/pricing 可按输入、输出、cache 命中、cache 创建精算成本', () => {
    const cost = calculateTokenPricedCostCents(
      [
        {
          modelName: 'deepseek-chat',
          costCents: 0,
          calls: 1,
          inputTokens: 1_000_000,
          outputTokens: 500_000,
          cacheReadTokens: 100_000,
          cacheCreationTokens: 100_000,
        },
      ],
      [
        {
          modelName: 'deepseek-chat',
          quotaType: 0,
          modelRatio: 0.25,
          modelPrice: 0,
          completionRatio: 2,
          supportsCacheRead: true,
          cacheRatio: 0.1,
          supportsCacheCreation: true,
          cacheCreationRatio: 1.25,
          groupRatio: 1,
        },
      ],
      { quotaPerUnit: 500000, usdToCny: 7, requireAllModels: true },
    )
    // input $0.5 + output $0.5 + cache read $0.005 + cache creation $0.0625 = $1.0675 = 747 分
    expect(cost.costCents).toBe(747)
    expect(cost.byModel[0]).toMatchObject({ source: 'per_token', tokenCostCents: 747 })
  })

  it('日志自带实际结算倍率时优先按 tokenPricedQuota 折算，避免 /api/pricing 普通分组倍率误差', () => {
    const cost = calculateTokenPricedCostCents(
      [{ modelName: 'gpt-5.4-mini', costCents: 0, usedQuota: 982, tokenPricedQuota: 982 }],
      [],
      { quotaPerUnit: 500000, usdToCny: 1, requireAllModels: true },
    )
    expect(cost.missingModels).toEqual([])
    expect(cost.costCents).toBe(0)
    expect(cost.byModel[0]).toMatchObject({ source: 'log_pricing', tokenCostCents: 0, tokenPricedQuota: 982 })
  })

  it('token×pricing 缺模型价格或 cache 能力不匹配时 fail-closed', () => {
    expect(() =>
      calculateTokenPricedCostCents([{ modelName: 'qwen-plus', costCents: 0 }], [], { requireAllModels: true }),
    ).toThrow('缺少模型价格')

    expect(() =>
      calculateTokenPricedCostCents(
        [{ modelName: 'deepseek-chat', costCents: 0, cacheReadTokens: 1 }],
        [
          {
            modelName: 'deepseek-chat',
            quotaType: 0,
            modelRatio: 0.25,
            modelPrice: 0,
            completionRatio: 2,
            supportsCacheRead: false,
            cacheRatio: 0,
            supportsCacheCreation: false,
            cacheCreationRatio: 0,
            groupRatio: 1,
          },
        ],
        { requireAllModels: true },
      ),
    ).toThrow('supports_cache_read')
  })

  it('quotaType=1 按调用次数和 model_price 精算', () => {
    const cost = calculateTokenPricedCostCents(
      [{ modelName: 'image-model', costCents: 0, calls: 3 }],
      [
        {
          modelName: 'image-model',
          quotaType: 1,
          modelRatio: 0,
          modelPrice: 0.02,
          completionRatio: 0,
          supportsCacheRead: false,
          cacheRatio: 0,
          supportsCacheCreation: false,
          cacheCreationRatio: 0,
          groupRatio: 0.5,
        },
      ],
      { usdToCny: 7, requireAllModels: true },
    )
    expect(cost.costCents).toBe(21) // 3 * $0.02 * 0.5 * 7 CNY
    expect(cost.byModel[0]).toMatchObject({ source: 'per_call', tokenCostCents: 21 })
  })

  it('漂移容忍值必须是非负数字，禁止非法 env 静默回退默认', () => {
    expect(resolveReconcileToleranceCents({})).toBeUndefined()
    expect(resolveReconcileToleranceCents({ NEWAPI_RECONCILE_TOLERANCE_CENTS: '2.9' })).toBe(2)
    expect(() => resolveReconcileToleranceCents({ NEWAPI_RECONCILE_TOLERANCE_CENTS: 'NaN' })).toThrow('NEWAPI_RECONCILE_TOLERANCE_CENTS')
    expect(() => resolveReconcileToleranceCents({ NEWAPI_RECONCILE_TOLERANCE_CENTS: '-1' })).toThrow('NEWAPI_RECONCILE_TOLERANCE_CENTS')
  })

  it('逐用户漂移报告给出人工处理动作，并按绝对漂移排序', () => {
    const report = buildUserUsageDriftReport([
      { userId: 'u-ok', newapiUsageCents: 100, localConsumeCents: 100 },
      { userId: 'u-gateway-more', newapiUsageCents: 130, localConsumeCents: 100 },
      { userId: 'u-local-more', newapiUsageCents: 100, localConsumeCents: 160 },
    ])
    expect(report.map((r) => r.userId)).toEqual(['u-local-more', 'u-gateway-more', 'u-ok'])
    expect(report[0]).toMatchObject({
      direction: 'local_gt_newapi',
      action: 'manual_refund_local_or_fix_gateway_undercharge',
      ok: false,
    })
    expect(report[1]).toMatchObject({
      direction: 'newapi_gt_local',
      action: 'manual_backfill_local_or_refund_gateway',
      ok: false,
    })
    expect(report[2]).toMatchObject({ direction: 'matched', action: 'none', ok: true })
  })

  it('逐用户漂移报告可导出 JSONL，供运营按 action 人工处理', () => {
    const rows = buildUserUsageDriftReport([
      { userId: 'u1', newapiUsageCents: 130, localConsumeCents: 100 },
    ])
    const text = formatUserUsageDriftJsonl(rows, {
      monthStartISO: '2026-07-01T00:00:00.000Z',
      generatedAt: '2026-07-03T00:00:00.000Z',
      usageSource: 'newapi',
    })
    const parsed = JSON.parse(text)
    expect(parsed).toMatchObject({
      schema: 'gewu.newapi.user_drift.v1',
      userId: 'u1',
      direction: 'newapi_gt_local',
      action: 'manual_backfill_local_or_refund_gateway',
    })
  })

  it('逐用户漂移报告默认写入 gitignored JSONL，显式路径禁止误覆盖非 JSONL 文件', () => {
    const monthStart = new Date('2026-07-01T00:00:00.000Z')
    expect(resolveReconcileDriftReportPath({ cwd: '/tmp/gewu', monthStart })).toBe(
      resolve('/tmp/gewu', '.reconcile-reports', 'newapi-drift-2026-07.jsonl'),
    )
    expect(() =>
      resolveReconcileDriftReportPath({
        explicitPath: '/tmp/gewu/.env',
        monthStart,
      }),
    ).toThrow('NEWAPI_RECONCILE_DRIFT_REPORT_PATH')
  })

  it('逐用户漂移报告写出后强制 0600，避免用户 ID 与金额被同机用户读取', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gewu-drift-'))
    const file = join(dir, 'drift.jsonl')
    await writeFile(file, 'old\n', { mode: 0o644 })
    const rows = buildUserUsageDriftReport([
      { userId: 'u1', newapiUsageCents: 130, localConsumeCents: 100 },
    ]).filter((row) => !row.ok)

    const path = await writeUserDriftReportFile(rows, {
      explicitPath: file,
      monthStart: new Date('2026-07-01T00:00:00.000Z'),
      generatedAt: new Date('2026-07-03T00:00:00.000Z'),
      usageSource: 'newapi',
    })

    expect(path).toBe(file)
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)
    const parsed = JSON.parse((await readFile(file, 'utf8')).trim())
    expect(parsed).toMatchObject({
      schema: 'gewu.newapi.user_drift.v1',
      userId: 'u1',
      generatedAt: '2026-07-03T00:00:00.000Z',
    })
  })

  it.skipIf(process.platform === 'win32')('逐用户漂移报告拒绝软链接路径，避免跟随软链覆盖敏感文件', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gewu-drift-symlink-'))
    const target = join(dir, 'target.env')
    const link = join(dir, 'drift.jsonl')
    await writeFile(target, 'SECRET=keep\n', 'utf8')
    await symlink(target, link)
    const rows = buildUserUsageDriftReport([
      { userId: 'u1', newapiUsageCents: 130, localConsumeCents: 100 },
    ]).filter((row) => !row.ok)

    await expect(
      writeUserDriftReportFile(rows, {
        explicitPath: link,
        monthStart: new Date('2026-07-01T00:00:00.000Z'),
        usageSource: 'newapi',
      }),
    ).rejects.toThrow('软链接')
    await expect(readFile(target, 'utf8')).resolves.toBe('SECRET=keep\n')
  })

  it('无逐用户漂移时不写空报告', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gewu-drift-empty-'))
    await expect(
      writeUserDriftReportFile([], {
        explicitPath: join(dir, 'empty.jsonl'),
        monthStart: new Date('2026-07-01T00:00:00.000Z'),
        usageSource: 'newapi',
      }),
    ).resolves.toBeNull()
  })

  it('漂移 JSONL 可解析为只读人工处理计划，不自动改账', () => {
    const rows = buildUserUsageDriftReport([
      { userId: 'u-gateway-more', newapiUsageCents: 130, localConsumeCents: 100 },
      { userId: 'u-local-more', newapiUsageCents: 100, localConsumeCents: 160 },
      { userId: 'u-ok', newapiUsageCents: 100, localConsumeCents: 100 },
    ])
    const parsed = parseUserUsageDriftJsonl(
      formatUserUsageDriftJsonl(rows, {
        monthStartISO: '2026-07-01T00:00:00.000Z',
        generatedAt: '2026-07-03T00:00:00.000Z',
        usageSource: 'newapi',
      }),
    )
    const plan = buildDriftRemediationPlan(parsed)

    expect(plan).toHaveLength(2)
    expect(plan.find((p) => p.userId === 'u-gateway-more')).toMatchObject({
      suggestedLocalCreditDelta: -30,
      idempotencyKey: 'newapi-drift:2026-07:u-gateway-more:newapi_gt_local:30',
    })
    expect(plan.find((p) => p.userId === 'u-local-more')).toMatchObject({
      suggestedLocalCreditDelta: 60,
      idempotencyKey: 'newapi-drift:2026-07:u-local-more:local_gt_newapi:60',
    })
    expect(plan.some((p) => p.userId === 'u-ok')).toBe(false)
  })

  it('漂移人工处理计划输出 JSONL，供运营留痕复核', () => {
    const parsed = parseUserUsageDriftJsonl(
      JSON.stringify({
        schema: 'gewu.newapi.user_drift.v1',
        monthStartISO: '2026-07-01T00:00:00.000Z',
        generatedAt: '2026-07-03T00:00:00.000Z',
        usageSource: 'newapi',
        userId: 'u1',
        newapiUsageCents: 130,
        localConsumeCents: 100,
        driftCents: 30,
        absDriftCents: 30,
        toleranceCents: 2,
        direction: 'newapi_gt_local',
        action: 'manual_backfill_local_or_refund_gateway',
      }),
    )
    const out = formatDriftRemediationPlanJsonl(buildDriftRemediationPlan(parsed))
    const step = JSON.parse(out)
    expect(step).toMatchObject({
      schema: 'gewu.newapi.user_drift_remediation.v1',
      userId: 'u1',
      suggestedLocalCreditDelta: -30,
    })
    expect(step.checklist.join('\n')).toContain('未修改')
  })

  it('漂移 JSONL 解析会拒绝 schema 或金额不一致的坏报告', () => {
    expect(() => parseUserUsageDriftJsonl('{"schema":"bad"}')).toThrow('schema')
    expect(() =>
      parseUserUsageDriftJsonl(
        JSON.stringify({
          schema: 'gewu.newapi.user_drift.v1',
          monthStartISO: '2026-07-01T00:00:00.000Z',
          generatedAt: '2026-07-03T00:00:00.000Z',
          usageSource: 'newapi',
          userId: 'u1',
          newapiUsageCents: 130,
          localConsumeCents: 100,
          driftCents: 30,
          absDriftCents: 29,
          toleranceCents: 2,
          direction: 'newapi_gt_local',
          action: 'manual_backfill_local_or_refund_gateway',
        }),
      ),
    ).toThrow('absDriftCents')
  })

  it('漂移 JSONL 解析会拒绝方向或动作被手改反的报告', () => {
    const base = {
      schema: 'gewu.newapi.user_drift.v1',
      monthStartISO: '2026-07-01T00:00:00.000Z',
      generatedAt: '2026-07-03T00:00:00.000Z',
      usageSource: 'newapi',
      userId: 'u1',
      newapiUsageCents: 130,
      localConsumeCents: 100,
      driftCents: 30,
      absDriftCents: 30,
      toleranceCents: 2,
      direction: 'newapi_gt_local',
      action: 'manual_backfill_local_or_refund_gateway',
      ok: false,
    }
    expect(() => parseUserUsageDriftJsonl(JSON.stringify({ ...base, direction: 'local_gt_newapi' }))).toThrow('direction')
    expect(() => parseUserUsageDriftJsonl(JSON.stringify({ ...base, action: 'manual_refund_local_or_fix_gateway_undercharge' }))).toThrow('action')
    expect(() => parseUserUsageDriftJsonl(JSON.stringify({ ...base, ok: true }))).toThrow('action')
  })

  it('漂移 JSONL 解析会拒绝同月同用户重复行，避免双补扣或双退款', () => {
    const line = JSON.stringify({
      schema: 'gewu.newapi.user_drift.v1',
      monthStartISO: '2026-07-01T00:00:00.000Z',
      generatedAt: '2026-07-03T00:00:00.000Z',
      usageSource: 'newapi',
      userId: 'u1',
      newapiUsageCents: 130,
      localConsumeCents: 100,
      driftCents: 30,
      absDriftCents: 30,
      toleranceCents: 2,
      direction: 'newapi_gt_local',
      action: 'manual_backfill_local_or_refund_gateway',
      ok: false,
    })
    expect(() => parseUserUsageDriftJsonl(`${line}\n${line}`)).toThrow('重复用户行')
  })
})
