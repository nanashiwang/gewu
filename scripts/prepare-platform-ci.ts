/** Disposable CI schema only; never runs migrations against a production URL. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import pg from 'pg'
import { getPayload } from 'payload'
import config from '../src/payload.config'

assert.equal(process.env.CI, 'true')
assert.equal(process.env.GITHUB_ACTIONS, 'true')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
assert.equal(process.env.NODE_ENV, 'development')
const url = new URL(process.env.DATABASE_URL || '')
assert(['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/gewu' && url.username === 'payload')
const payload = await getPayload({ config })
const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
try {
  await client.connect()
  const columns = await client.query("SELECT table_name,column_name,udt_name FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position")
  const enums = await client.query("SELECT t.typname AS name,e.enumlabel AS value FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid JOIN pg_namespace n ON t.typnamespace=n.oid WHERE n.nspname='public' ORDER BY t.typname,e.enumsortorder")
  assert(columns.rows.some(r => r.table_name === 'users') && columns.rows.some(r => r.table_name === 'relay_checks' && r.column_name === 'wire_api'))
  await fs.writeFile('platform-schema.json', JSON.stringify({ version: 1, columns: columns.rows, enums: enums.rows }, null, 2) + '\n')
  await client.query("CREATE TABLE gewu_release_probe_canary (id integer PRIMARY KEY, note text NOT NULL); INSERT INTO gewu_release_probe_canary VALUES (1, 'synthetic CI canary, never production data')")
  console.log('PASS: disposable CI schema prepared; no users, external messages or model calls created')
} finally {
  await client.end()
  await payload.destroy()
}
