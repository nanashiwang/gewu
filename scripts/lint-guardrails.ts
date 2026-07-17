import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const IGNORED_DIRS = new Set([
  '.git',
  '.next',
  '.pytest_cache',
  '.venv',
  '__pycache__',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'test-venv',
  'venv',
])
const SCANNED_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.yml',
  '.yaml',
])
const BRAND_SCANNED_EXTENSIONS = new Set([
  ...SCANNED_EXTENSIONS,
  '.css',
  '.example',
  '.html',
  '.py',
  '.service',
  '.sh',
  '.svg',
  '.timer',
  '.toml',
  '.txt',
])
const IGNORED_FILES = new Set(['src/app/(payload)/admin/importMap.js'])
const HIGH_ENTROPY_FIXTURE_PREFIXES = ['detector/data/baselines/']

type Failure = {
  code: string
  message: string
}

const failures: Failure[] = []

function fail(code: string, message: string) {
  failures.push({ code, message })
}

function rel(file: string): string {
  return path.relative(ROOT, file).split(path.sep).join('/')
}

function read(relativePath: string): string {
  return readFileSync(path.join(ROOT, relativePath), 'utf8')
}

function walk(dir: string, extensions = SCANNED_EXTENSIONS): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (IGNORED_DIRS.has(entry) || entry.endsWith('.egg-info')) continue
    const full = path.join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      out.push(...walk(full, extensions))
      continue
    }
    if (stat.isFile() && extensions.has(path.extname(entry))) out.push(full)
  }
  return out
}

function lineNumber(source: string, offset: number): number {
  return source.slice(0, offset).split(/\r?\n/).length
}

function maskSecret(value: string): string {
  if (value.length <= 12) return '<redacted>'
  return `${value.slice(0, 4)}...${value.slice(-4)}`
}

function stripCommentsAndStrings(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\r\n]*/g, ' ')
    .replace(/(['"`])(?:\\[\s\S]|(?!\1)[^\\])*\1/g, ' ')
}

function assertIncludes(relativePath: string, needle: string, code: string, message: string) {
  const file = path.join(ROOT, relativePath)
  if (!existsSync(file)) {
    fail(code, `${relativePath} missing; ${message}`)
    return
  }
  if (!read(relativePath).includes(needle)) fail(code, `${relativePath}: ${message}`)
}

function assertNotIncludes(relativePath: string, needle: string, code: string, message: string) {
  const file = path.join(ROOT, relativePath)
  if (!existsSync(file)) {
    fail(code, `${relativePath} missing; ${message}`)
    return
  }
  if (read(relativePath).includes(needle)) fail(code, `${relativePath}: ${message}`)
}

function checkNoCommittedModelKeys() {
  const modelKeyPattern = /sk-[A-Za-z0-9/_+\-=]{24,}/g
  const highEntropyTokenPattern =
    /(?<![A-Za-z0-9/+_=:-])(?=[A-Za-z0-9/+_=:-]{28,})(?=[A-Za-z0-9/+_=:-]*[a-z])(?=[A-Za-z0-9/+_=:-]*[A-Z])(?=[A-Za-z0-9/+_=:-]*\d)(?=[A-Za-z0-9/+_=:-]*[\/+_=:-])[A-Za-z0-9/+_=:-]{28,}(?![A-Za-z0-9/+_=:-])/g
  for (const file of walk(ROOT)) {
    const relative = rel(file)
    if (relative === 'package-lock.json' || IGNORED_FILES.has(relative)) continue
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(modelKeyPattern)) {
      fail(
        'NO_COMMITTED_MODEL_KEYS',
        `${relative}:${lineNumber(source, match.index || 0)} possible committed model key ${maskSecret(match[0])}`,
      )
    }
    if (HIGH_ENTROPY_FIXTURE_PREFIXES.some((prefix) => relative.startsWith(prefix))) continue
    for (const match of source.matchAll(highEntropyTokenPattern)) {
      fail(
        'NO_COMMITTED_HIGH_ENTROPY_TOKENS',
        `${relative}:${lineNumber(source, match.index || 0)} possible committed high-entropy token ${maskSecret(match[0])}`,
      )
    }
  }
}

function checkRetiredBrandIdentifiers() {
  const retiredAscii = [
    ['su', 'yuan'].join(''),
    ['yuan', 'heng'].join(''),
    ['skill', 'hub'].join(''),
    ['x', '-', 'yh', '-'].join(''),
  ]
  const retiredHan = [
    String.fromCodePoint(0x6eaf, 0x6e90),
    String.fromCodePoint(0x5143, 0x8861),
  ]

  for (const file of walk(ROOT, BRAND_SCANNED_EXTENSIONS)) {
    const relative = rel(file)
    const source = readFileSync(file, 'utf8')
    const normalizedSource = source.toLowerCase()
    const offsets = [
      ...retiredAscii.map((identifier) => normalizedSource.indexOf(identifier)),
      ...retiredHan.map((identifier) => source.indexOf(identifier)),
    ].filter((offset) => offset >= 0)
    const offset = offsets.length > 0 ? Math.min(...offsets) : -1
    if (offset >= 0) {
      fail(
        'RETIRED_BRAND_IDENTIFIER',
        `${relative}:${lineNumber(source, offset)} retired brand identifier must not return`,
      )
    }

    const normalizedPath = relative.toLowerCase()
    if (
      retiredAscii.some((identifier) => normalizedPath.includes(identifier)) ||
      retiredHan.some((identifier) => relative.includes(identifier))
    ) {
      fail('RETIRED_BRAND_PATH', `${relative}: retired brand identifier must not appear in paths`)
    }
  }

  const retiredSubtokenPrefix = ['h', 's_'].join('')
  for (const relative of [
    'src/lib/newapiAdmin.ts',
    'src/lib/newapiProbe.ts',
    'src/worker/calibrate-newapi.ts',
    'src/worker/reconcile-newapi.ts',
  ]) {
    assertNotIncludes(
      relative,
      retiredSubtokenPrefix,
      'RETIRED_SUBTOKEN_PREFIX',
      'retired subtoken prefix must not return to New API contracts',
    )
  }

  const retiredCachePrefix = ['h', 's:'].join('')
  for (const relative of [
    'src/lib/benchmarkQueue.ts',
    'src/lib/rateLimit.ts',
    'src/lib/reverifyQueue.ts',
  ]) {
    assertNotIncludes(
      relative,
      retiredCachePrefix,
      'RETIRED_CACHE_PREFIX',
      'retired cache prefix must not return to queue or rate-limit keys',
    )
  }
}

function checkNeutralModelRank() {
  const relative = 'src/lib/modelrank.ts'
  const code = stripCommentsAndStrings(read(relative))
  const forbidden = /\b(margin|profit|revenue|isOurs|isOwned|platformCost|gatewayCost|costPrice)\b/i
  const match = code.match(forbidden)
  if (match) {
    fail('MODEL_RANK_REVENUE_COUPLING', `${relative}: neutral ranking code references forbidden field "${match[0]}"`)
  }
}

function checkMoneyGuardrails() {
  assertIncludes(
    'src/app/v1/economy/exchange/route.ts',
    'normalizeExternalIdempotencyKey',
    'EXCHANGE_IDEMPOTENCY_REQUIRED',
    'exchange writes must require an external idempotency key',
  )
  assertIncludes(
    'src/app/v1/economy/exchange/route.ts',
    "scopedIdempotencyKey('exchange', uid,",
    'EXCHANGE_IDEMPOTENCY_SCOPED',
    'exchange idempotency keys must be scoped per user',
  )
  assertIncludes(
    'src/lib/economy.ts',
    'ALLOW_LOCAL_MARGIN_EXCHANGE',
    'LOCAL_MARGIN_CONFIRMATION_REQUIRED',
    'local margin estimates must require explicit confirmation before enabling exchange',
  )
  assertIncludes(
    'src/lib/credit.ts',
    'validateCreditTxAmount',
    'CREDIT_LEDGER_SIGN_GUARD',
    'credit ledger writes must validate transaction sign so consume cannot be recorded as income',
  )
  assertIncludes(
    'src/lib/credit.ts',
    'normalizeCreditAmount',
    'CREDIT_LEDGER_PRECISION_GUARD',
    'credit ledger writes must enforce 2-decimal precision so balance snapshots equal the sum of logs',
  )
  assertIncludes(
    'src/collections/CreditLogs.ts',
    'validateCreditTxAmount',
    'CREDIT_LOG_COLLECTION_SIGN_GUARD',
    'direct credit-log writes must keep the same transaction sign invariant as applyCredit',
  )
  assertIncludes(
    'src/collections/CreditLogs.ts',
    'create: () => false',
    'CREDIT_LOGS_APPEND_ONLY',
    'credit logs must be append-only via service overrideAccess, not manually created/edited/deleted from admin',
  )
  assertIncludes(
    'src/collections/ContributionLogs.ts',
    'create: () => false',
    'CONTRIBUTION_LOGS_APPEND_ONLY',
    'contribution logs must be append-only via service overrideAccess, not manually created/edited/deleted from admin',
  )
  assertIncludes(
    'src/collections/AuditLogs.ts',
    'delete: () => false',
    'AUDIT_LOGS_NOT_DELETABLE',
    'audit logs must not be deletable from admin because they are the security trail',
  )
  assertIncludes(
    'src/collections/RechargeCodes.ts',
    'delete: () => false',
    'RECHARGE_CODES_NOT_DELETABLE',
    'recharge code credentials must not be deletable from admin because they prove the money entry path',
  )
  assertIncludes(
    'src/collections/RechargeCodes.ts',
    'allowRechargeCodeServiceUpdate',
    'RECHARGE_CODES_SERVICE_ONLY_REDEEM',
    'only the recharge endpoint service context may mark a recharge code as used',
  )
  assertIncludes(
    'src/collections/RechargeCodes.ts',
    '充值码创建时不能预置使用记录',
    'RECHARGE_CODES_CREATE_CLEAN_UNUSED',
    'recharge codes must be created as clean unused credentials and cannot be pre-marked as used',
  )
  assertNotIncludes(
    'src/app/v1/economy/recharge/route.ts',
    'Math.floor(Number(code.creditAmount',
    'RECHARGE_CODE_AMOUNT_NO_FLOOR',
    'recharge code redemption must not silently floor credit amounts and under-credit users',
  )
  assertIncludes(
    'src/app/v1/economy/recharge/route.ts',
    'resolveRechargeCreditAmount',
    'RECHARGE_CODE_AMOUNT_PRECISION_GUARD',
    'recharge code redemption must use the same 2-decimal credit amount guard as the credit ledger',
  )
  assertIncludes(
    'src/collections/Users.ts',
    "name: 'creditBalance'",
    'USER_CREDIT_BALANCE_FIELD_EXISTS',
    'user credit balance field must exist and remain guarded by ledger invariants',
  )
  assertIncludes(
    'src/collections/Users.ts',
    '恒等于 credit-logs 之和',
    'USER_CREDIT_BALANCE_READ_ONLY',
    'user credit balance must be documented as ledger-derived and not manually editable',
  )
  assertIncludes(
    'src/collections/Users.ts',
    'access: { create: () => false, update: () => false }',
    'USER_LEDGER_SNAPSHOT_CREATE_UPDATE_BLOCKED',
    'user ledger snapshot fields must reject both create-time and update-time manual writes',
  )
  assertIncludes(
    'src/collections/Users.ts',
    '恒等于 contribution-logs 之和',
    'USER_CONTRIBUTION_SCORE_READ_ONLY',
    'user contribution score must be documented as ledger-derived and not manually editable',
  )
  assertIncludes(
    'src/collections/Users.ts',
    '存在 credit 流水',
    'USER_DELETE_BLOCKS_CREDIT_LOGS',
    'user deletion must block when append-only credit logs exist instead of deleting money history',
  )
  assertIncludes(
    'src/collections/Users.ts',
    '存在贡献值流水',
    'USER_DELETE_BLOCKS_CONTRIBUTION_LOGS',
    'user deletion must block when append-only contribution logs exist instead of deleting reputation history',
  )
  assertIncludes(
    'src/lib/economy.ts',
    "NEWAPI_USAGE_SOURCE === 'local'",
    'LOCAL_MARGIN_SOURCE_MUST_BE_SELECTED',
    'local margin estimates must only be trusted when NEWAPI_USAGE_SOURCE=local',
  )
  assertIncludes(
    'src/worker/reconcile-newapi.ts',
    'ALLOW_LOCAL_MARGIN_EXCHANGE',
    'LOCAL_MARGIN_WORKER_CONFIRMATION_REQUIRED',
    'local margin reconcile --apply must require explicit confirmation',
  )
  assertIncludes(
    'src/worker/reconcile-newapi.ts',
    'resolveReconcileMarginRate',
    'RECONCILE_MARGIN_RATE_VALIDATED',
    'New API reconcile must validate margin rate before writing trusted exchange pool inputs',
  )
  assertIncludes(
    'src/lib/newapiReconcile.ts',
    'calculateTokenPricedCostCents',
    'RECONCILE_TOKEN_PRICED_COST_CONFIGURED',
    'New API reconcile must calculate model cost from /api/log token usage and /api/pricing ratios instead of hand-entered model margin rates',
  )
  assertIncludes(
    'src/worker/reconcile-newapi.ts',
    'admin.fetchPricing',
    'RECONCILE_PRICING_SNAPSHOT_FETCHED',
    'New API reconcile --apply must fetch /api/pricing and /api/status before trusting token-priced cost',
  )
  assertIncludes(
    'src/lib/newapiAdmin.ts',
    'logModelName',
    'NEWAPI_USAGE_LOG_MODEL_EXTRACTED',
    'New API usage logs must extract model names so per-model multipliers can be reconciled',
  )
  assertIncludes(
    'src/lib/newapiAdmin.ts',
    'logTokenUsage',
    'NEWAPI_USAGE_LOG_TOKEN_EXTRACTED',
    'New API usage logs must extract input/output/cache token counts for token-priced reconciliation',
  )
  assertIncludes(
    'src/lib/newapiAdmin.ts',
    'fetchPricing',
    'NEWAPI_PRICING_API_FETCHED',
    'New API admin client must fetch /api/pricing and /api/status for official price snapshots',
  )
  assertNotIncludes(
    'src/worker/reconcile-newapi.ts',
    'revenueCents * marginRate',
    'RECONCILE_NO_SINGLE_FLAT_MARGIN_WRITEBACK',
    'New API reconcile must not use one flat marginRate for trusted writeback across different model multipliers',
  )
  assertIncludes(
    'src/worker/reconcile-newapi.ts',
    'resolveReconcileToleranceCents',
    'RECONCILE_TOLERANCE_VALIDATED',
    'New API reconcile must validate drift tolerance instead of silently falling back',
  )
  assertIncludes(
    'src/worker/reconcile-newapi.ts',
    'buildUserUsageDriftReport',
    'RECONCILE_PER_USER_DRIFT_REPORT',
    'New API reconcile must produce per-user drift actions so aggregate totals cannot hide user-level money drift',
  )
  assertIncludes(
    'src/worker/reconcile-newapi.ts',
    'NEWAPI_RECONCILE_DRIFT_REPORT_PATH',
    'RECONCILE_DRIFT_JSONL_EXPORT',
    'New API reconcile must export a local JSONL handling list for per-user drift remediation',
  )
  assertIncludes(
    'package.json',
    'worker:plan-newapi-drift',
    'RECONCILE_DRIFT_PLAN_SCRIPT',
    'New API per-user drift JSONL must have a dry-run remediation planner for safe manual handling',
  )
  assertIncludes(
    'src/lib/newapiDriftRemediation.ts',
    'suggestedLocalCreditDelta',
    'RECONCILE_DRIFT_MANUAL_ACTION_PLAN',
    'New API drift remediation planner must calculate suggested local credit deltas without executing them',
  )
  assertIncludes(
    'src/lib/newapiDriftRemediation.ts',
    'action 与 drift/ok 不一致',
    'RECONCILE_DRIFT_PLAN_CONSISTENCY_GUARD',
    'New API drift remediation planner must reject tampered rows where action/direction do not match the drift sign',
  )
  assertIncludes(
    'src/lib/newapiDriftRemediation.ts',
    '重复用户行',
    'RECONCILE_DRIFT_PLAN_DUPLICATE_USER_GUARD',
    'New API drift remediation planner must reject duplicate user rows to avoid double backfill or refund',
  )
  assertNotIncludes(
    'src/worker/plan-newapi-drift-actions.ts',
    'applyCredit',
    'RECONCILE_DRIFT_PLAN_NO_AUTO_LEDGER_WRITE',
    'New API drift planner must stay dry-run and must not write credit ledgers',
  )
  assertIncludes(
    'src/lib/newapiDriftReport.ts',
    "endsWith('.jsonl')",
    'RECONCILE_DRIFT_REPORT_JSONL_ONLY',
    'New API drift report path must be restricted to JSONL files to avoid overwriting env/config files',
  )
  assertIncludes(
    'src/lib/newapiDriftReport.ts',
    'chmod(path, 0o600)',
    'RECONCILE_DRIFT_REPORT_PRIVATE_PERMS',
    'New API drift report contains user IDs and money amounts and must be written with private permissions',
  )
  assertIncludes(
    'src/lib/newapiDriftReport.ts',
    'isSymbolicLink()',
    'RECONCILE_DRIFT_REPORT_NO_SYMLINK',
    'New API drift report writer must reject symlink paths so reports cannot overwrite sensitive files through symlinks',
  )
  assertIncludes(
    'src/lib/newapiDriftReport.ts',
    'rename(tempPath, path)',
    'RECONCILE_DRIFT_REPORT_ATOMIC_RENAME',
    'New API drift report writer must write through a private temp file and atomic rename',
  )
  assertIncludes(
    'src/worker/calibrate-newapi.ts',
    'setQuotaToCredits(userId, 0)',
    'CALIBRATION_TEMP_QUOTA_ZEROED',
    'New API calibration must zero the temporary subtoken quota after real calls',
  )
  assertIncludes(
    'src/worker/calibrate-newapi.ts',
    'tokenWasProvisioned',
    'CALIBRATION_TEMP_QUOTA_ZERO_AFTER_PROVISION',
    'New API calibration must attempt temp quota cleanup once the temporary subtoken exists, even if later steps fail',
  )
  assertIncludes(
    'src/lib/newapiAdmin.ts',
    'requireExplicit: true',
    'NEWAPI_CREDIT_TO_QUOTA_RUNTIME_GUARD',
    'New API admin runtime must require explicit quota scale before syncing paid quota',
  )
  assertIncludes(
    'src/lib/newapiAdmin.ts',
    'quotaLimitedTokenPayload',
    'NEWAPI_SUBTOKEN_UNLIMITED_QUOTA_DISABLED',
    'New API subtoken quota sync must force unlimited_quota=false',
  )
  assertIncludes(
    'src/lib/newapiAdmin.ts',
    'ALLOW_DEFAULT_NEWAPI_SUB_GROUP',
    'NEWAPI_SUBTOKEN_GROUP_PATCHED',
    'New API subtokens must require a configured low-cost group or explicit default-group confirmation',
  )
  assertIncludes(
    'src/lib/newapiAdmin.ts',
    'NEWAPI_SUB_TOKEN_TTL_DAYS',
    'NEWAPI_SUBTOKEN_TTL_GUARD',
    'New API subtokens must use a bounded TTL instead of never-expiring tokens',
  )
  assertIncludes(
    'src/lib/newapiAdmin.ts',
    'requireUniqueTokenByName',
    'NEWAPI_SUBTOKEN_DUPLICATE_FAIL_CLOSED',
    'New API duplicate subtokens with the same user name must fail closed instead of choosing an arbitrary key',
  )
  assertIncludes(
    'src/lib/newapiAdmin.ts',
    '同名 New API 子令牌',
    'NEWAPI_SUBTOKEN_DUPLICATES_ZEROED',
    'New API duplicate subtokens must be zeroed before failing closed',
  )
  assertIncludes(
    'src/lib/newapiAdmin.ts',
    'TOKEN_LIST_MAX_PAGES',
    'NEWAPI_TOKEN_LIST_PAGINATION_CAP',
    'New API token list scanning must fail closed at the pagination cap',
  )
  assertIncludes(
    'src/lib/newapiAdmin.ts',
    '/api/log 超过分页扫描上限',
    'NEWAPI_USAGE_LOG_PAGINATION_CAP',
    'New API usage logs must fail closed when pagination could truncate money usage',
  )
  assertIncludes(
    'src/lib/newapiAdmin.ts',
    'requireLogQuota',
    'NEWAPI_USAGE_LOG_QUOTA_REQUIRED',
    'New API usage logs must fail closed when any consumption record lacks a valid quota field',
  )
  assertIncludes(
    'src/lib/newapiAdmin.ts',
    'requireLogType',
    'NEWAPI_USAGE_LOG_TYPE_REQUIRED',
    'New API usage logs must fail closed when records cannot be proven to be type=2 consumption logs',
  )
  assertIncludes(
    'src/lib/newapiAdmin.ts',
    'requireNoAmbiguousRefundLog',
    'NEWAPI_USAGE_LOG_REFUND_FAIL_CLOSED',
    'New API usage logs must fail closed when refund or ambiguous stream settlement records are present',
  )
  assertIncludes(
    'src/lib/newapiAdmin.ts',
    'requireLogTokenName',
    'NEWAPI_USAGE_LOG_TOKEN_NAME_REQUIRED',
    'New API usage logs must fail closed when records cannot be proven to belong to the target subtoken',
  )
  assertIncludes(
    'src/lib/newapiAdmin.ts',
    'requireLogTimestamp',
    'NEWAPI_USAGE_LOG_TIMESTAMP_REQUIRED',
    'New API usage logs must fail closed when records cannot be proven to respect start_timestamp',
  )
  assertIncludes(
    'src/lib/newapiAdmin.ts',
    'MAX_LOG_FUTURE_SKEW_MS',
    'NEWAPI_USAGE_LOG_FUTURE_TIME_GUARD',
    'New API usage logs must fail closed when records are implausibly in the future',
  )
  assertIncludes(
    'src/lib/newapiProbe.ts',
    'gw_preflight_impossible',
    'NEWAPI_USAGE_LOG_FILTER_PROBE',
    'New API production preflight must probe token_name filtering instead of only checking /api/log reachability',
  )
  assertIncludes(
    'src/lib/newapiProbe.ts',
    'start_timestamp',
    'NEWAPI_USAGE_LOG_TIME_FILTER_PROBE',
    'New API production preflight must probe start_timestamp filtering instead of only checking /api/log reachability',
  )
  assertIncludes(
    'src/lib/newapiProbe.ts',
    'ambiguousSettlementCount',
    'NEWAPI_USAGE_LOG_SETTLEMENT_SAMPLE_PROBE',
    'New API production preflight must inspect log samples for refund or ambiguous stream settlement records',
  )
  assertIncludes(
    'src/lib/newapiProbe.ts',
    'NEWAPI_PROBE_TIMEOUT_MS',
    'NEWAPI_PROBE_TIMEOUT_GUARD',
    'New API production preflight must bound live permission probes instead of hanging before deployment',
  )
  assertIncludes(
    'src/worker/probe-newapi.ts',
    'logFilterOK',
    'NEWAPI_PROBE_CLI_FILTER_FAILS_CLOSED',
    'New API probe CLI must fail when token_name filtering cannot be proven',
  )
  assertIncludes(
    'src/worker/probe-newapi.ts',
    'logTimeFilterOK',
    'NEWAPI_PROBE_CLI_TIME_FILTER_FAILS_CLOSED',
    'New API probe CLI must fail when start_timestamp filtering cannot be proven',
  )
  assertIncludes(
    'src/worker/probe-newapi.ts',
    'logSettlementOK',
    'NEWAPI_PROBE_CLI_SETTLEMENT_FAILS_CLOSED',
    'New API probe CLI must fail when log settlement samples are ambiguous',
  )
  assertIncludes(
    'src/worker/preflight-production.ts',
    'logSettlementOK',
    'NEWAPI_PREFLIGHT_SETTLEMENT_FAILS_CLOSED',
    'New API production preflight must block when log settlement samples are ambiguous',
  )
  assertIncludes(
    'src/lib/newapiAdmin.ts',
    'model_limits_enabled: true',
    'NEWAPI_SUBTOKEN_MODEL_LIMITS_ENABLED',
    'New API subtokens must be limited to the approved platform model allowlist',
  )
  assertIncludes(
    'src/lib/newapiAdmin.ts',
    'requireApprovedPlatformModelList',
    'NEWAPI_SUBTOKEN_MODEL_LIMITS_ALLOWLIST',
    'New API subtoken model limits must be derived from the approved platform allowlist',
  )
  assertIncludes(
    'src/lib/constants.ts',
    '平台代付白名单不能为空',
    'NEWAPI_SUBTOKEN_EMPTY_MODEL_LIMITS_FAIL_CLOSED',
    'New API subtoken model_limits must fail closed when the approved model allowlist parses empty',
  )
  assertIncludes(
    'src/lib/skillRunner.ts',
    'prepareNewApiSubTokenForRun',
    'PLATFORM_RUN_SYNC_QUOTA_BEFORE_CALL',
    'platform-paid real calls must sync subtoken quota to the current local balance before calling the gateway',
  )
  assertIncludes(
    'src/lib/newapiCalibration.ts',
    'getCreditToQuota',
    'CALIBRATION_QUOTA_SCALE_VALIDATED',
    'New API calibration must validate quota scale before real calls',
  )
  assertIncludes(
    'src/worker/calibrate-newapi.ts',
    'assertCalibrationUsageDelta',
    'CALIBRATION_USAGE_DELTA_BOUNDED',
    'New API calibration must fail if real usage exceeds the temporary subtoken quota',
  )
  assertIncludes(
    'src/lib/newapiCalibration.ts',
    '未新增消费记录',
    'CALIBRATION_USAGE_CALL_DELTA_REQUIRED',
    'New API calibration must prove that a real call added a fresh consumption log record',
  )
  assertIncludes(
    'src/worker/calibrate-newapi.ts',
    'resolveCalibrationCredits',
    'CALIBRATION_CREDITS_BOUNDED',
    'New API calibration must parse and bound temporary credit amount instead of silently clamping invalid values',
  )
  assertIncludes(
    'src/lib/productionPreflight.ts',
    "startsWith('sk-')",
    'NEWAPI_ADMIN_KEY_MUST_NOT_BE_MODEL_KEY',
    'production preflight must reject model keys used as New API admin keys',
  )
  assertIncludes(
    'src/lib/productionPreflight.ts',
    'APPROVED_PLATFORM_MODELS_EMPTY',
    'PRODUCTION_EMPTY_PLATFORM_MODELS_BLOCKED',
    'production preflight must block an explicitly empty platform-paid model allowlist',
  )
  assertIncludes(
    'src/lib/productionPreflight.ts',
    'ALLOW_DEFAULT_NEWAPI_SUB_GROUP',
    'PRODUCTION_SUBTOKEN_GROUP_FAIL_CLOSED',
    'production preflight must block missing New API low-cost subtoken group unless explicitly confirmed',
  )
  assertIncludes(
    'src/lib/productionPreflight.ts',
    'NEWAPI_SUB_TOKEN_TTL_INVALID',
    'PRODUCTION_SUBTOKEN_TTL_BOUNDED',
    'production preflight must block invalid New API subtoken TTL settings',
  )
  assertIncludes(
    'src/lib/productionPreflight.ts',
    'NEWAPI_MODEL_MARGIN_RATES_DRY_RUN_UNSET',
    'PRODUCTION_MODEL_MARGIN_RATES_DRY_RUN_ONLY',
    'production preflight must not require hand-entered model margin rates when New API token pricing is the trusted path',
  )
}

function checkRuntimeGuardrails() {
  assertIncludes(
    'src/collections/Users.ts',
    'isActiveAccount(user)',
    'PAYLOAD_ADMIN_ACCESS_BANNED_FAIL_CLOSED',
    'Payload admin panel access must reject banned active sessions, not only API endpoints',
  )
  assertIncludes(
    'src/lib/newapi.ts',
    "process.env.NODE_ENV === 'production'",
    'PRODUCTION_MOCK_FAIL_CLOSED',
    'production gateway calls must fail closed instead of using mock output',
  )
  assertIncludes(
    'src/lib/newapi.ts',
    'redactGatewayErrorText',
    'GATEWAY_ERROR_REDACTION',
    'gateway error bodies must be redacted before reaching logs or returned errors',
  )
  assertIncludes(
    'src/lib/skillRunner.ts',
    'redactGatewayErrorText(lastError)',
    'RUN_FAILURE_LOG_REDACTION',
    'run failure logs must redact upstream gateway errors',
  )
  assertIncludes(
    'src/lib/skillRunner.ts',
    '模型调用失败（${errorType}）',
    'SKILLRUN_FAILURE_OUTPUT_SAFE',
    'failed SkillRun outputText must store a controlled public error instead of raw upstream errors',
  )
  assertIncludes(
    'src/lib/skillRunner.ts',
    'approvedPlatformFallback',
    'PLATFORM_MODELS_ALLOWLISTED',
    'platform-paid runs must pass through the approved model fallback',
  )
  assertIncludes(
    'src/proxy.ts',
    "fetchSite === 'cross-site'",
    'V1_CSRF_SAME_ORIGIN',
    'write APIs must keep the same-origin CSRF boundary',
  )
  assertIncludes(
    'src/proxy.ts',
    '!allowedOrigins.has(origin)',
    'V1_CSRF_ORIGIN_CHECK',
    'write APIs must reject mismatched Origin headers',
  )
  assertIncludes(
    'src/lib/productionPreflight.ts',
    'NEXT_PUBLIC_SERVER_URL_MISSING',
    'PRODUCTION_PUBLIC_URL_REQUIRED',
    'production preflight must require an explicit public site URL for CORS/CSRF',
  )
  assertIncludes(
    'src/lib/productionPreflight.ts',
    'SITE_URL_ORIGIN_MISMATCH',
    'PRODUCTION_SITE_URLS_SAME_ORIGIN',
    'production preflight must keep server and public site URLs same-origin',
  )
  assertIncludes(
    'src/collections/Users.ts',
    'BYOK_DIRECT_FIELD_ACCESS_BLOCKED',
    'BYOK_DIRECT_FIELD_ACCESS_BLOCKED',
    'BYOK encrypted field must not be directly readable or writable through Payload admin/REST',
  )
  assertIncludes(
    'src/collections/Users.ts',
    'normalizeNewApiKeyForStorage',
    'BYOK_DIRECT_WRITE_ENCRYPTED',
    'service writes to BYOK encrypted field must still be normalized to encrypted storage',
  )
}

function checkV1RequestBoundaryGuardrails() {
  const v1Dir = path.join(ROOT, 'src/app/v1')
  if (!existsSync(v1Dir)) {
    fail('V1_DIR_MISSING', 'src/app/v1 missing; public API request boundary cannot be checked')
    return
  }

  for (const file of walk(v1Dir)) {
    const relative = rel(file)
    const source = readFileSync(file, 'utf8')
    const stripped = stripCommentsAndStrings(source)

    for (const match of stripped.matchAll(/\brequest\.json\s*\(/g)) {
      fail(
        'V1_RAW_REQUEST_JSON_FORBIDDEN',
        `${relative}:${lineNumber(source, match.index || 0)} v1 routes must use a bounded request reader instead of request.json()`,
      )
    }

    for (const match of stripped.matchAll(/\bNumber\s*\(\s*(?:url\.)?searchParams\.get\s*\(/g)) {
      fail(
        'V1_UNBOUNDED_NUMERIC_QUERY_FORBIDDEN',
        `${relative}:${lineNumber(source, match.index || 0)} numeric query params must go through boundedIntParam()`,
      )
    }

    if (/\brequest\.formData\s*\(/.test(stripped) && !source.includes('preflightSkillPackageFormRequest')) {
      fail(
        'V1_RAW_FORMDATA_PREFLIGHT_REQUIRED',
        `${relative}: v1 multipart/form routes must preflight content-length before request.formData()`,
      )
    }

    const rawResponsePattern =
      /\b(member|registry|adapter|organization)\s*:\s*result\.(member|registry|adapter|organization)\b/g
    for (const match of stripped.matchAll(rawResponsePattern)) {
      fail(
        'V1_RAW_DOMAIN_OBJECT_RESPONSE_FORBIDDEN',
        `${relative}:${lineNumber(source, match.index || 0)} v1 routes must return an explicit public summary instead of raw result.${match[2]}`,
      )
    }

    const rawErrorMessageResponsePattern =
      /(?:error|errors)\s*:\s*(?:\[\s*)?(?:\(?\s*(?:e|err|error)\s+as\s+Error\s*\)?|(?:e|err|error))\.message\b/g
    for (const match of stripped.matchAll(rawErrorMessageResponsePattern)) {
      fail(
        'V1_RAW_ERROR_MESSAGE_RESPONSE_FORBIDDEN',
        `${relative}:${lineNumber(source, match.index || 0)} v1 routes must not return raw exception messages to clients`,
      )
    }
  }
}

function checkCiWiresLint() {
  const pkg = JSON.parse(read('package.json')) as { scripts?: Record<string, string> }
  if (!pkg.scripts?.lint) fail('LINT_SCRIPT_MISSING', 'package.json must expose npm run lint')
  assertIncludes('.github/workflows/ci.yml', 'npm run lint', 'CI_LINT_MISSING', 'CI must run npm run lint')
}

checkNoCommittedModelKeys()
checkRetiredBrandIdentifiers()
checkNeutralModelRank()
checkMoneyGuardrails()
checkRuntimeGuardrails()
checkV1RequestBoundaryGuardrails()
checkCiWiresLint()

if (failures.length > 0) {
  console.error('Guardrail lint failed:')
  for (const item of failures) console.error(`- [${item.code}] ${item.message}`)
  process.exit(1)
}

console.log('Guardrail lint passed.')
