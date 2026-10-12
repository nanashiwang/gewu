import { sql, type MigrateUpArgs, type MigrateDownArgs } from '@payloadcms/db-postgres'

// Nullable, no backfill/default: all existing schedules retain their legacy API.
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    CREATE TYPE "public"."enum_relay_sites_wire_api" AS ENUM ('chat_completions', 'responses', 'messages', 'interactions', 'generate_content');
    CREATE TYPE "public"."enum_relay_checks_wire_api" AS ENUM ('chat_completions', 'responses', 'messages', 'interactions', 'generate_content');
    ALTER TABLE "relay_sites" ADD COLUMN "wire_api" "public"."enum_relay_sites_wire_api";
    ALTER TABLE "relay_checks" ADD COLUMN "wire_api" "public"."enum_relay_checks_wire_api";
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "relay_checks" DROP COLUMN "wire_api";
    ALTER TABLE "relay_sites" DROP COLUMN "wire_api";
    DROP TYPE "public"."enum_relay_checks_wire_api";
    DROP TYPE "public"."enum_relay_sites_wire_api";
  `)
}
