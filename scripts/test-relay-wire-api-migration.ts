/** Runs only against the CI disposable database; all test DDL/data rolls back. */
import pg from 'pg'
import { PgDialect } from 'drizzle-orm/pg-core'
import { up, down } from '../src/migrations/20261012_120000_relay_wire_api'
import assert from 'node:assert/strict'

if (process.env.CI !== 'true') throw new Error('This migration acceptance script requires the disposable CI database')
const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
await client.connect()
try {
  await client.query('BEGIN')
  await client.query('CREATE TEMP TABLE relay_sites (id integer, model text); CREATE TEMP TABLE relay_checks (id integer, model text)')
  await client.query("INSERT INTO relay_sites VALUES (1, 'legacy'); INSERT INTO relay_checks VALUES (1, 'legacy')")
  const dialect = new PgDialect()
  const args = { db: { execute: async (statement: any) => { const query = dialect.sqlToQuery(statement); return client.query(query.sql, query.params) } } } as any
  await up(args)
  for (const table of ['relay_sites', 'relay_checks']) {
    assert.deepEqual((await client.query(`SELECT * FROM ${table}`)).rows, [{ id: 1, model: 'legacy', wire_api: null }])
    await client.query(`UPDATE ${table} SET wire_api = 'interactions' WHERE id = 1`)
  }
  await down(args)
  for (const table of ['relay_sites', 'relay_checks']) {
    assert.deepEqual((await client.query(`SELECT * FROM ${table}`)).rows, [{ id: 1, model: 'legacy' }])
  }
  console.log('PASS: additive interface migration and rollback preserve existing rows')
} finally {
  await client.query('ROLLBACK')
  await client.end()
}
