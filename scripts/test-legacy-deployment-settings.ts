/** Disposable CI only: real Payload reads/writes against both historical layouts. */
import assert from 'node:assert/strict'
import pg from 'pg'
import type { DeploymentSetting } from '../src/payload-types'

assert.equal(process.env.CI, 'true')
assert.equal(process.env.GITHUB_ACTIONS, 'true')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
assert.equal(process.env.NODE_ENV, 'production')
const url = new URL(process.env.DATABASE_URL || '')
assert(['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/gewu' && url.username === 'payload')
const client = new pg.Client({ connectionString: url.toString() })
let payload: import('payload').Payload | undefined
let adapterPool: pg.Pool | undefined
const leasedConnections = new Set<pg.PoolClient>()
class FixturePool extends pg.Pool {
  constructor(options?: pg.PoolConfig) {
    super(options)
    adapterPool = this
    this.on('acquire', (connection) => leasedConnections.add(connection))
    this.on('release', (_error, connection) => leasedConnections.delete(connection))
    this.on('remove', (connection) => leasedConnections.delete(connection))
  }
}
const typesSql = `SELECT column_name, udt_name FROM information_schema.columns
  WHERE table_schema='public' AND table_name='deployment_settings'
  AND column_name IN ('newapi_usage_source','newapi_log_scope') ORDER BY column_name`
try {
  await client.connect()
  assert.equal((await client.query('SELECT count(*)::int AS n FROM deployment_settings')).rows[0].n, 0,
    'CI fixture must contain no deployment settings')
  const canonicalTypes = (await client.query(typesSql)).rows
  assert.deepEqual(canonicalTypes.map(r => r.udt_name), [
    'enum_deployment_settings_newapi_log_scope', 'enum_deployment_settings_newapi_usage_source',
  ])
  const { getPayload } = await import('payload')
  const { default: config } = await import('../src/payload.config')
  const { deploymentSettingsToEnv } = await import('../src/lib/deploymentSettings')
  const resolvedConfig = await config
  const createAdapter = resolvedConfig.db.init
  resolvedConfig.db.init = (args) => {
    const adapter = createAdapter(args) as ReturnType<typeof createAdapter> & { pg: typeof pg }
    // Keep the production adapter and queries; track only this fixture's
    // checked-out connections through the public pg.Pool lifecycle events.
    adapter.pg = { ...adapter.pg, Pool: FixturePool }
    return adapter
  }
  payload = await getPayload({ config: resolvedConfig })
  for (const layout of ['enum', 'varchar']) {
    if (layout === 'varchar') {
      await client.query(`ALTER TABLE deployment_settings
        ALTER COLUMN newapi_usage_source TYPE varchar USING newapi_usage_source::text,
        ALTER COLUMN newapi_log_scope TYPE varchar USING newapi_log_scope::text`)
    }
    const beforeTypes = (await client.query(typesSql)).rows
    for (const usage of ['newapi', 'local', null] as const) {
      for (const scope of ['auto', 'admin', 'self', null] as const) {
        await payload.updateGlobal({ slug: 'deployment-settings', overrideAccess: true,
          data: { newapiUsageSource: usage, newapiLogScope: scope, backupNotes: 'synthetic settings canary' } })
        const read: DeploymentSetting = await payload.findGlobal({ slug: 'deployment-settings', depth: 0, overrideAccess: true })
        assert.equal(read.newapiUsageSource, usage)
        assert.equal(read.newapiLogScope, scope)
        assert.equal(read.backupNotes, 'synthetic settings canary')
        const env = deploymentSettingsToEnv(read, {})
        assert.equal(env.NEWAPI_USAGE_SOURCE, usage ?? undefined)
        assert.equal(env.NEWAPI_LOG_SCOPE, scope ?? undefined)
      }
    }
    const beforeRows = (await client.query('SELECT * FROM deployment_settings ORDER BY id')).rows
    for (const field of ['newapiUsageSource', 'newapiLogScope']) {
      await assert.rejects(() => payload!.updateGlobal({ slug: 'deployment-settings', overrideAccess: true,
        data: { [field]: 'invalid-ci-value' } as never }),
      (error: any) => error?.status === 400 && error?.data?.errors?.some((item: any) => item.path === field))
    }
    assert.deepEqual((await client.query('SELECT * FROM deployment_settings ORDER BY id')).rows, beforeRows)
    assert.deepEqual((await client.query(typesSql)).rows, beforeTypes, 'Payload must not rewrite the schema')
    console.log(`PASS: real Payload ${layout} settings read/write, nulls, all choices and invalid-value rejection`)
  }
  // Restore this disposable CI database only; the canonical release dump was
  // exported before this test. No migration command exists in the deployer.
  await client.query(`DELETE FROM deployment_settings;
    ALTER TABLE deployment_settings
      ALTER COLUMN newapi_usage_source TYPE enum_deployment_settings_newapi_usage_source
        USING newapi_usage_source::enum_deployment_settings_newapi_usage_source,
      ALTER COLUMN newapi_log_scope TYPE enum_deployment_settings_newapi_log_scope
        USING newapi_log_scope::enum_deployment_settings_newapi_log_scope`)
  assert.deepEqual((await client.query(typesSql)).rows, canonicalTypes)
  assert.equal(Object.keys((payload.db as unknown as { sessions: object }).sessions).length, 0)
  assert(leasedConnections.size <= 1, 'No query/transaction leases may remain beyond the adapter bootstrap connection')
} finally {
  try {
    if (payload) await payload.destroy()
  } finally {
    try {
      // db-postgres keeps one startup error-listener connection checked out;
      // its destroy does not release that lease or close the pool. All fixture
      // operations are awaited; release only connections owned by this test.
      for (const connection of leasedConnections) connection.release(true)
      if (adapterPool) {
        await adapterPool.end()
        assert.equal(adapterPool.totalCount, 0)
        assert.equal(adapterPool.waitingCount, 0)
      }
      assert.equal(leasedConnections.size, 0)
    } finally {
      await client.end()
    }
  }
}
console.log('LEGACY_SETTINGS_TEST_CONNECTIONS=0')
// The guarded CI-only command is complete, including both pool shutdowns.
// Do not leave config-tooling watchers alive after all awaited assertions.
process.exit(0)
