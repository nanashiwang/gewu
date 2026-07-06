import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "deployment_settings" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "server_url" varchar,
      "public_server_url" varchar,
      "trusted_proxy_count" numeric,
      "model_gateway_base_url" varchar,
      "model_gateway_key_encrypted" varchar,
      "model_gateway_default_model" varchar DEFAULT 'deepseek-chat',
      "approved_platform_models" varchar,
      "run_rate_limit_per_min" numeric,
      "benchmark_queue_max_jobs" numeric,
      "benchmark_max_attempts_per_skill" numeric,
      "benchmark_models" varchar,
      "newapi_admin_base_url" varchar,
      "newapi_admin_key_encrypted" varchar,
      "newapi_admin_user_id" varchar,
      "newapi_auth_bearer" boolean DEFAULT false,
      "newapi_sub_group" varchar,
      "allow_default_newapi_sub_group" boolean DEFAULT false,
      "newapi_credit_to_quota" numeric,
      "newapi_sub_token_ttl_days" numeric,
      "newapi_usage_source" varchar,
      "newapi_log_scope" varchar,
      "newapi_margin_rate" numeric,
      "newapi_model_margin_rates" varchar,
      "newapi_reconcile_tolerance_cents" numeric,
      "newapi_usd_exchange_rate_cny" numeric,
      "allow_local_margin_exchange" boolean DEFAULT false,
      "signing_key_encrypted" varchar,
      "backup_encryption_confirmed" boolean DEFAULT false,
      "backup_offsite_confirmed" boolean DEFAULT false,
      "backup_restore_drill_at" timestamp(3) with time zone,
      "backup_notes" varchar,
      "updated_at" timestamp(3) with time zone,
      "created_at" timestamp(3) with time zone
    );
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    DROP TABLE IF EXISTS "deployment_settings" CASCADE;
  `)
}
