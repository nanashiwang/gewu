import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    WITH ranked_active_checks AS (
      SELECT
        "id",
        row_number() OVER (
          PARTITION BY "site_id"
          ORDER BY "created_at" ASC, "id" ASC
        ) AS active_order
      FROM "relay_checks"
      WHERE "status" IN ('queued', 'running')
    )
    UPDATE "relay_checks"
    SET
      "status" = 'error',
      "error" = '迁移清理：同一中转站存在重复活动检测任务',
      "finished_at" = COALESCE("finished_at", now()),
      "updated_at" = now()
    WHERE "id" IN (
      SELECT "id"
      FROM ranked_active_checks
      WHERE active_order > 1
    );

    CREATE UNIQUE INDEX IF NOT EXISTS "relay_checks_one_active_per_site_idx"
      ON "relay_checks" USING btree ("site_id")
      WHERE "status" IN ('queued', 'running');
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    DROP INDEX IF EXISTS "relay_checks_one_active_per_site_idx";
  `)
}