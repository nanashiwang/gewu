import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    DO $$ BEGIN CREATE TYPE "public"."enum_relay_sites_protocol" AS ENUM('openai', 'anthropic', 'gemini'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE TYPE "public"."enum_relay_sites_mode" AS ENUM('quick', 'standard', 'full'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE TYPE "public"."enum_relay_sites_status" AS ENUM('draft', 'pending', 'approved', 'rejected', 'suspended'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE TYPE "public"."enum_relay_sites_claim_status" AS ENUM('unverified', 'pending', 'verified', 'failed', 'manual'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE TYPE "public"."enum_relay_sites_schedule_interval_hours" AS ENUM('6', '12', '24', '72', '168'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE TYPE "public"."enum_relay_checks_source" AS ENUM('manual', 'scheduled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE TYPE "public"."enum_relay_checks_protocol" AS ENUM('openai', 'anthropic', 'gemini'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE TYPE "public"."enum_relay_checks_mode" AS ENUM('quick', 'standard', 'full'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE TYPE "public"."enum_relay_checks_status" AS ENUM('queued', 'running', 'done', 'error'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

    CREATE TABLE IF NOT EXISTS "relay_sites" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "name" varchar NOT NULL,
      "slug" varchar NOT NULL,
      "owner_id" uuid NOT NULL,
      "website_url" varchar NOT NULL,
      "api_base_url" varchar NOT NULL,
      "description" varchar,
      "contacts" jsonb,
      "protocol" "enum_relay_sites_protocol" DEFAULT 'openai' NOT NULL,
      "model" varchar NOT NULL,
      "mode" "enum_relay_sites_mode" DEFAULT 'standard' NOT NULL,
      "api_key_encrypted" varchar,
      "has_api_key" boolean DEFAULT false,
      "status" "enum_relay_sites_status" DEFAULT 'draft' NOT NULL,
      "claim_status" "enum_relay_sites_claim_status" DEFAULT 'unverified' NOT NULL,
      "claim_domain" varchar NOT NULL,
      "claim_token" varchar NOT NULL,
      "claimed_at" timestamp(3) with time zone,
      "claim_checked_at" timestamp(3) with time zone,
      "schedule_enabled" boolean DEFAULT false,
      "schedule_interval_hours" "enum_relay_sites_schedule_interval_hours" DEFAULT '24' NOT NULL,
      "next_check_at" timestamp(3) with time zone,
      "last_check_at" timestamp(3) with time zone,
      "last_score" numeric,
      "last_grade" varchar,
      "last_verdict" varchar,
      "review_notes" varchar,
      "reviewed_by_id" uuid,
      "reviewed_at" timestamp(3) with time zone,
      "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
      "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "relay_checks" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "site_id" uuid NOT NULL,
      "triggered_by_id" uuid,
      "source" "enum_relay_checks_source" DEFAULT 'manual' NOT NULL,
      "protocol" "enum_relay_checks_protocol" NOT NULL,
      "model" varchar NOT NULL,
      "mode" "enum_relay_checks_mode" NOT NULL,
      "status" "enum_relay_checks_status" DEFAULT 'queued' NOT NULL,
      "detector_job_id" varchar,
      "result_url" varchar,
      "score" numeric,
      "grade" varchar,
      "verdict" varchar,
      "summary" varchar,
      "started_at" timestamp(3) with time zone,
      "finished_at" timestamp(3) with time zone,
      "duration_ms" numeric,
      "poll_failures" numeric DEFAULT 0,
      "report" jsonb,
      "error" varchar,
      "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
      "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
    );

    DO $$ BEGIN ALTER TABLE "relay_sites" ADD CONSTRAINT "relay_sites_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN ALTER TABLE "relay_sites" ADD CONSTRAINT "relay_sites_reviewed_by_id_users_id_fk" FOREIGN KEY ("reviewed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN ALTER TABLE "relay_checks" ADD CONSTRAINT "relay_checks_site_id_relay_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."relay_sites"("id") ON DELETE restrict ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN ALTER TABLE "relay_checks" ADD CONSTRAINT "relay_checks_triggered_by_id_users_id_fk" FOREIGN KEY ("triggered_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

    CREATE UNIQUE INDEX IF NOT EXISTS "relay_sites_slug_idx" ON "relay_sites" USING btree ("slug");
    CREATE INDEX IF NOT EXISTS "relay_sites_name_idx" ON "relay_sites" USING btree ("name");
    CREATE INDEX IF NOT EXISTS "relay_sites_owner_idx" ON "relay_sites" USING btree ("owner_id");
    CREATE INDEX IF NOT EXISTS "relay_sites_protocol_idx" ON "relay_sites" USING btree ("protocol");
    CREATE INDEX IF NOT EXISTS "relay_sites_status_idx" ON "relay_sites" USING btree ("status");
    CREATE INDEX IF NOT EXISTS "relay_sites_claim_status_idx" ON "relay_sites" USING btree ("claim_status");
    CREATE INDEX IF NOT EXISTS "relay_sites_claim_domain_idx" ON "relay_sites" USING btree ("claim_domain");
    CREATE INDEX IF NOT EXISTS "relay_sites_schedule_enabled_idx" ON "relay_sites" USING btree ("schedule_enabled");
    CREATE INDEX IF NOT EXISTS "relay_sites_next_check_at_idx" ON "relay_sites" USING btree ("next_check_at");
    CREATE INDEX IF NOT EXISTS "relay_sites_owner_status_idx" ON "relay_sites" USING btree ("owner_id", "status");
    CREATE INDEX IF NOT EXISTS "relay_sites_status_claim_status_idx" ON "relay_sites" USING btree ("status", "claim_status");
    CREATE INDEX IF NOT EXISTS "relay_sites_schedule_next_idx" ON "relay_sites" USING btree ("schedule_enabled", "next_check_at");

    CREATE UNIQUE INDEX IF NOT EXISTS "relay_checks_detector_job_id_idx" ON "relay_checks" USING btree ("detector_job_id");
    CREATE INDEX IF NOT EXISTS "relay_checks_site_idx" ON "relay_checks" USING btree ("site_id");
    CREATE INDEX IF NOT EXISTS "relay_checks_triggered_by_idx" ON "relay_checks" USING btree ("triggered_by_id");
    CREATE INDEX IF NOT EXISTS "relay_checks_source_idx" ON "relay_checks" USING btree ("source");
    CREATE INDEX IF NOT EXISTS "relay_checks_status_idx" ON "relay_checks" USING btree ("status");
    CREATE INDEX IF NOT EXISTS "relay_checks_score_idx" ON "relay_checks" USING btree ("score");
    CREATE INDEX IF NOT EXISTS "relay_checks_verdict_idx" ON "relay_checks" USING btree ("verdict");
    CREATE INDEX IF NOT EXISTS "relay_checks_site_created_at_idx" ON "relay_checks" USING btree ("site_id", "created_at");
    CREATE INDEX IF NOT EXISTS "relay_checks_site_status_idx" ON "relay_checks" USING btree ("site_id", "status");
    CREATE UNIQUE INDEX IF NOT EXISTS "relay_checks_one_active_per_site_idx" ON "relay_checks" USING btree ("site_id") WHERE "status" IN ('queued', 'running');

    ALTER TABLE "payload_locked_documents_rels" ADD COLUMN IF NOT EXISTS "relay_sites_id" uuid;
    ALTER TABLE "payload_locked_documents_rels" ADD COLUMN IF NOT EXISTS "relay_checks_id" uuid;
    DO $$ BEGIN ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_relay_sites_fk" FOREIGN KEY ("relay_sites_id") REFERENCES "public"."relay_sites"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_relay_checks_fk" FOREIGN KEY ("relay_checks_id") REFERENCES "public"."relay_checks"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    CREATE INDEX IF NOT EXISTS "payload_locked_documents_rels_relay_sites_id_idx" ON "payload_locked_documents_rels" USING btree ("relay_sites_id");
    CREATE INDEX IF NOT EXISTS "payload_locked_documents_rels_relay_checks_id_idx" ON "payload_locked_documents_rels" USING btree ("relay_checks_id");
  `)
}

export async function down(_args: MigrateDownArgs): Promise<void> {
  throw new Error('20260718_120000_relay_backend is a forward-only migration')
}
