import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   DO $$ BEGIN CREATE TYPE "public"."enum_skill_versions_contract_status" AS ENUM('initial', 'compatible_change', 'breaking_change'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE TYPE "public"."enum_skill_passports_status" AS ENUM('draft', 'current', 'stale', 'revoked'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE TYPE "public"."enum_skill_passports_skill_class" AS ENUM('verified', 'imported', 'high_risk', 'rejected'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE TYPE "public"."enum_compat_test_cases_case_type" AS ENUM('normal', 'edge', 'long_context', 'structured_output', 'safety'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE TYPE "public"."enum_adapter_profiles_status" AS ENUM('draft', 'active', 'observed', 'disabled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE TYPE "public"."enum_adapter_profiles_review_status" AS ENUM('pending', 'needs_changes', 'approved', 'rejected'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE TYPE "public"."enum_relay_sites_protocol" AS ENUM('openai', 'anthropic', 'gemini'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE TYPE "public"."enum_relay_sites_mode" AS ENUM('quick', 'standard', 'full'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE TYPE "public"."enum_relay_sites_status" AS ENUM('draft', 'pending', 'approved', 'rejected', 'suspended'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE TYPE "public"."enum_relay_sites_claim_status" AS ENUM('unverified', 'pending', 'verified', 'failed', 'manual'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE TYPE "public"."enum_relay_sites_schedule_interval_hours" AS ENUM('6', '12', '24', '72', '168'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE TYPE "public"."enum_relay_checks_source" AS ENUM('manual', 'scheduled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE TYPE "public"."enum_relay_checks_protocol" AS ENUM('openai', 'anthropic', 'gemini'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE TYPE "public"."enum_relay_checks_mode" AS ENUM('quick', 'standard', 'full'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE TYPE "public"."enum_relay_checks_status" AS ENUM('queued', 'running', 'done', 'error'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE TYPE "public"."enum_failure_cases_triage_status" AS ENUM('pending', 'attributed', 'needs_more_evidence', 'verified'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE TYPE "public"."enum_failure_cases_root_cause_category" AS ENUM('model_drift', 'prompt_boundary', 'schema_mismatch', 'adapter_gap', 'data_quality', 'unknown'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE TYPE "public"."enum_failure_cases_status" AS ENUM('observed', 'confirmed', 'fixed', 'ignored'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE TYPE "public"."enum_evidence_snapshots_target_type" AS ENUM('skill_passport', 'failure_case', 'adapter_profile'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE TYPE "public"."enum_organizations_plan" AS ENUM('team', 'enterprise'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE TYPE "public"."enum_organizations_status" AS ENUM('active', 'suspended'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE TYPE "public"."enum_organization_members_role" AS ENUM('member', 'approver', 'auditor', 'admin'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE TYPE "public"."enum_organization_members_status" AS ENUM('active', 'suspended'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE TYPE "public"."enum_enterprise_registries_approval_status" AS ENUM('pending', 'approved', 'restricted', 'disabled', 'deprecated'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE TYPE "public"."enum_enterprise_audit_logs_outcome" AS ENUM('success', 'failed', 'denied'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE TYPE "public"."enum_model_profiles_profile_status" AS ENUM('observed', 'verified', 'stale', 'deprecated'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE TYPE "public"."enum_deployment_settings_newapi_usage_source" AS ENUM('newapi', 'local'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE TYPE "public"."enum_deployment_settings_newapi_log_scope" AS ENUM('auto', 'admin', 'self'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  ALTER TYPE "public"."enum_notifications_type" ADD VALUE IF NOT EXISTS 'skill_updated' BEFORE 'review';
  CREATE TABLE IF NOT EXISTS "skill_passports" (
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"title" varchar NOT NULL,
  	"skill_id" uuid NOT NULL,
  	"skill_version_id" uuid,
  	"status" "enum_skill_passports_status" DEFAULT 'draft',
  	"skill_class" "enum_skill_passports_skill_class" DEFAULT 'imported',
  	"trust_score" numeric DEFAULT 0,
  	"signature_status" varchar,
  	"manifest_checksum" varchar,
  	"capability_summary" jsonb,
  	"compatibility_summary" jsonb,
  	"reliability_summary" jsonb,
  	"safety_summary" jsonb,
  	"failure_summary" jsonb,
  	"evidence_summary" jsonb,
  	"evidence_hash" varchar,
  	"enterprise_summary" jsonb,
  	"last_verified_at" timestamp(3) with time zone,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE IF NOT EXISTS "compat_test_cases" (
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"title" varchar NOT NULL,
  	"skill_id" uuid NOT NULL,
  	"skill_version_id" uuid,
  	"case_type" "enum_compat_test_cases_case_type" DEFAULT 'normal',
  	"input_json" jsonb NOT NULL,
  	"expected_output_shape" jsonb,
  	"required_output_paths" jsonb,
  	"expected_text_includes" jsonb,
  	"min_score" numeric DEFAULT 0.8,
  	"rubric" varchar,
  	"enabled" boolean DEFAULT true,
  	"last_run_at" timestamp(3) with time zone,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE IF NOT EXISTS "adapter_profiles" (
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"title" varchar NOT NULL,
  	"skill_id" uuid NOT NULL,
  	"skill_version_id" uuid,
  	"source_failure_case_id" uuid,
  	"model_profile_id" uuid,
  	"model_name" varchar NOT NULL,
  	"model_version" varchar,
  	"status" "enum_adapter_profiles_status" DEFAULT 'draft',
  	"review_status" "enum_adapter_profiles_review_status" DEFAULT 'pending',
  	"reviewed_by_id" uuid,
  	"reviewed_at" timestamp(3) with time zone,
  	"reviewer_notes" varchar,
  	"system_prompt_append" varchar,
  	"user_prompt_append" varchar,
  	"output_schema_patch" jsonb,
  	"decoding_patch" jsonb,
  	"retry_policy" jsonb,
  	"failure_types" jsonb,
  	"lift_score" numeric DEFAULT 0,
  	"before_metrics" jsonb,
  	"after_metrics" jsonb,
  	"evidence_hash" varchar,
  	"last_verified_at" timestamp(3) with time zone,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
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
  
  CREATE TABLE IF NOT EXISTS "failure_cases" (
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"title" varchar NOT NULL,
  	"profile_key" varchar,
  	"error_type" varchar NOT NULL,
  	"model_name" varchar NOT NULL,
  	"primary_model_version" varchar,
  	"skill_id" uuid,
  	"skill_version_id" uuid,
  	"symptom" varchar,
  	"likely_cause" varchar,
  	"triage_status" "enum_failure_cases_triage_status" DEFAULT 'pending',
  	"root_cause_category" "enum_failure_cases_root_cause_category",
  	"triaged_by_id" uuid,
  	"triaged_at" timestamp(3) with time zone,
  	"triage_notes" varchar,
  	"verification_coverage" jsonb,
  	"repair_template" varchar,
  	"verify_template" varchar,
  	"primary_input_bucket" varchar,
  	"input_buckets" jsonb,
  	"output_buckets" jsonb,
  	"model_breakdown" jsonb,
  	"model_versions" jsonb,
  	"model_version_breakdown" jsonb,
  	"source_breakdown" jsonb,
  	"evidence_hash" varchar,
  	"occurrence_count" numeric DEFAULT 0,
  	"affected_skill_count" numeric DEFAULT 0,
  	"status" "enum_failure_cases_status" DEFAULT 'observed',
  	"last_observed_at" timestamp(3) with time zone,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE IF NOT EXISTS "evidence_snapshots" (
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"target_type" "enum_evidence_snapshots_target_type" NOT NULL,
  	"target_id" varchar NOT NULL,
  	"evidence_hash" varchar NOT NULL,
  	"target_summary" jsonb,
  	"payload_hash" varchar,
  	"key_id" varchar,
  	"signature" varchar,
  	"signed_at" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE IF NOT EXISTS "audit_logs" (
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"event" varchar NOT NULL,
  	"actor_id" uuid,
  	"target_user_id" uuid,
  	"target_type" varchar,
  	"target_id" varchar,
  	"ip_hash" varchar,
  	"summary" varchar,
  	"metadata" jsonb,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE IF NOT EXISTS "organizations" (
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"name" varchar NOT NULL,
  	"slug" varchar NOT NULL,
  	"owner_id" uuid NOT NULL,
  	"plan" "enum_organizations_plan" DEFAULT 'team',
  	"status" "enum_organizations_status" DEFAULT 'active',
  	"model_allowlist" jsonb,
  	"policy" jsonb,
  	"identity_policy" jsonb,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE IF NOT EXISTS "organization_members" (
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"organization_id" uuid NOT NULL,
  	"user_id" uuid NOT NULL,
  	"role" "enum_organization_members_role" DEFAULT 'member',
  	"status" "enum_organization_members_status" DEFAULT 'active',
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE IF NOT EXISTS "enterprise_registries" (
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"name" varchar NOT NULL,
  	"organization_id" uuid NOT NULL,
  	"skill_id" uuid NOT NULL,
  	"skill_version_id" uuid,
  	"passport_id" uuid,
  	"approval_status" "enum_enterprise_registries_approval_status" DEFAULT 'pending',
  	"approved_by_id" uuid,
  	"approved_at" timestamp(3) with time zone,
  	"model_allowlist" jsonb,
  	"usage_scope" varchar,
  	"risk_notes" varchar,
  	"audit_policy" jsonb,
  	"adoption_baseline" jsonb,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE IF NOT EXISTS "enterprise_audit_logs" (
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"organization_id" uuid NOT NULL,
  	"registry_id" uuid,
  	"actor_id" uuid,
  	"skill_id" uuid NOT NULL,
  	"skill_version_id" uuid,
  	"skill_run_id" uuid,
  	"run_id" varchar NOT NULL,
  	"model_name" varchar,
  	"model_version" varchar,
  	"model_profile_id" uuid,
  	"outcome" "enum_enterprise_audit_logs_outcome" NOT NULL,
  	"error_code" varchar,
  	"policy_reason" varchar,
  	"input_size_bucket" varchar,
  	"output_size_bucket" varchar,
  	"latency_ms" numeric,
  	"estimated_cost" numeric,
  	"charged_credits" numeric,
  	"metadata" jsonb,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE IF NOT EXISTS "model_profiles" (
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"provider" varchar,
  	"model_name" varchar NOT NULL,
  	"model_version" varchar,
  	"profile_status" "enum_model_profiles_profile_status" DEFAULT 'observed',
  	"context_length" numeric,
  	"supports_structured_output" boolean DEFAULT false,
  	"supports_tool_use" boolean DEFAULT false,
  	"chinese_style_score" numeric,
  	"json_stability_score" numeric,
  	"long_output_stability_score" numeric,
  	"input_price" numeric,
  	"output_price" numeric,
  	"region" varchar,
  	"platform_pay_allowed" boolean DEFAULT false,
  	"known_issues" jsonb,
  	"regression_alerts" jsonb,
  	"drift_summary" jsonb,
  	"drift_history" jsonb,
  	"capabilities" jsonb,
  	"freshness" jsonb,
  	"last_observed_at" timestamp(3) with time zone,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE IF NOT EXISTS "site_settings_essential_starter_pack" (
  	"_order" integer NOT NULL,
  	"_parent_id" uuid NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"skill_id" uuid NOT NULL,
  	"order" numeric DEFAULT 0,
  	"reason" varchar,
  	"starter_example" jsonb
  );
  
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
  	"newapi_auth_bearer" boolean,
  	"newapi_sub_group" varchar,
  	"allow_default_newapi_sub_group" boolean,
  	"newapi_credit_to_quota" numeric,
  	"newapi_sub_token_ttl_days" numeric,
  	"newapi_usage_source" "enum_deployment_settings_newapi_usage_source",
  	"newapi_log_scope" "enum_deployment_settings_newapi_log_scope",
  	"newapi_margin_rate" numeric,
  	"newapi_model_margin_rates" varchar,
  	"newapi_reconcile_tolerance_cents" numeric,
  	"newapi_usd_exchange_rate_cny" numeric,
  	"allow_local_margin_exchange" boolean,
  	"signing_key_encrypted" varchar,
  	"backup_encryption_confirmed" boolean,
  	"backup_offsite_confirmed" boolean,
  	"backup_restore_drill_at" timestamp(3) with time zone,
  	"backup_notes" varchar,
  	"anchor_trusted_publishers" varchar,
  	"updated_at" timestamp(3) with time zone,
  	"created_at" timestamp(3) with time zone
  );
  
  ALTER TABLE "deployment_settings" ADD COLUMN IF NOT EXISTS "anchor_trusted_publishers" varchar;
  
  ALTER TABLE "site_settings" ALTER COLUMN "slogan" SET DEFAULT 'AI Skill 的可信与兼容控制平面。';
  ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "client_submission_key" varchar;
  ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "import_source_format" varchar;
  ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "import_source_locator" varchar;
  ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "import_source_hash" varchar;
  ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "import_source_last_synced_at" timestamp(3) with time zone;
  ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "import_source_last_diff" jsonb;
  ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "is_essential" boolean DEFAULT false;
  ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "essential_reason" varchar;
  ALTER TABLE "skill_versions" ADD COLUMN IF NOT EXISTS "contract_hash" varchar;
  ALTER TABLE "skill_versions" ADD COLUMN IF NOT EXISTS "contract_status" "enum_skill_versions_contract_status" DEFAULT 'initial';
  ALTER TABLE "skill_runs" ADD COLUMN IF NOT EXISTS "rerun_of_id" uuid;
  ALTER TABLE "skill_runs" ADD COLUMN IF NOT EXISTS "rerun_from_model" varchar;
  ALTER TABLE "skill_runs" ADD COLUMN IF NOT EXISTS "adapter_profile_id" uuid;
  ALTER TABLE "skill_runs" ADD COLUMN IF NOT EXISTS "model_profile_id" uuid;
  ALTER TABLE "skill_runs" ADD COLUMN IF NOT EXISTS "model_version" varchar;
  ALTER TABLE "compat_reports" ADD COLUMN IF NOT EXISTS "model_profile_id" uuid;
  ALTER TABLE "compat_reports" ADD COLUMN IF NOT EXISTS "adapter_profile_id" uuid;
  ALTER TABLE "compat_reports" ADD COLUMN IF NOT EXISTS "benchmark_case_id" uuid;
  ALTER TABLE "compat_reports" ADD COLUMN IF NOT EXISTS "benchmark_score" numeric;
  ALTER TABLE "compat_reports" ADD COLUMN IF NOT EXISTS "benchmark_passed" boolean;
  ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "device_hash" varchar;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN IF NOT EXISTS "skill_passports_id" uuid;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN IF NOT EXISTS "compat_test_cases_id" uuid;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN IF NOT EXISTS "adapter_profiles_id" uuid;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN IF NOT EXISTS "relay_sites_id" uuid;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN IF NOT EXISTS "relay_checks_id" uuid;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN IF NOT EXISTS "failure_cases_id" uuid;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN IF NOT EXISTS "evidence_snapshots_id" uuid;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN IF NOT EXISTS "audit_logs_id" uuid;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN IF NOT EXISTS "organizations_id" uuid;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN IF NOT EXISTS "organization_members_id" uuid;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN IF NOT EXISTS "enterprise_registries_id" uuid;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN IF NOT EXISTS "enterprise_audit_logs_id" uuid;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN IF NOT EXISTS "model_profiles_id" uuid;
  ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "registration_email_required" boolean DEFAULT false;
  DO $$ BEGIN ALTER TABLE "skill_passports" ADD CONSTRAINT "skill_passports_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE "skill_passports" ADD CONSTRAINT "skill_passports_skill_version_id_skill_versions_id_fk" FOREIGN KEY ("skill_version_id") REFERENCES "public"."skill_versions"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE "compat_test_cases" ADD CONSTRAINT "compat_test_cases_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE "compat_test_cases" ADD CONSTRAINT "compat_test_cases_skill_version_id_skill_versions_id_fk" FOREIGN KEY ("skill_version_id") REFERENCES "public"."skill_versions"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE "adapter_profiles" ADD CONSTRAINT "adapter_profiles_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE "adapter_profiles" ADD CONSTRAINT "adapter_profiles_skill_version_id_skill_versions_id_fk" FOREIGN KEY ("skill_version_id") REFERENCES "public"."skill_versions"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE "adapter_profiles" ADD CONSTRAINT "adapter_profiles_source_failure_case_id_failure_cases_id_fk" FOREIGN KEY ("source_failure_case_id") REFERENCES "public"."failure_cases"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE "adapter_profiles" ADD CONSTRAINT "adapter_profiles_model_profile_id_model_profiles_id_fk" FOREIGN KEY ("model_profile_id") REFERENCES "public"."model_profiles"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE "adapter_profiles" ADD CONSTRAINT "adapter_profiles_reviewed_by_id_users_id_fk" FOREIGN KEY ("reviewed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE "relay_sites" ADD CONSTRAINT "relay_sites_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE "relay_sites" ADD CONSTRAINT "relay_sites_reviewed_by_id_users_id_fk" FOREIGN KEY ("reviewed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE "relay_checks" ADD CONSTRAINT "relay_checks_site_id_relay_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."relay_sites"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE "relay_checks" ADD CONSTRAINT "relay_checks_triggered_by_id_users_id_fk" FOREIGN KEY ("triggered_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE "failure_cases" ADD CONSTRAINT "failure_cases_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE "failure_cases" ADD CONSTRAINT "failure_cases_skill_version_id_skill_versions_id_fk" FOREIGN KEY ("skill_version_id") REFERENCES "public"."skill_versions"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE "failure_cases" ADD CONSTRAINT "failure_cases_triaged_by_id_users_id_fk" FOREIGN KEY ("triaged_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE "organizations" ADD CONSTRAINT "organizations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE "enterprise_registries" ADD CONSTRAINT "enterprise_registries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE "enterprise_registries" ADD CONSTRAINT "enterprise_registries_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE "enterprise_registries" ADD CONSTRAINT "enterprise_registries_skill_version_id_skill_versions_id_fk" FOREIGN KEY ("skill_version_id") REFERENCES "public"."skill_versions"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE "enterprise_registries" ADD CONSTRAINT "enterprise_registries_passport_id_skill_passports_id_fk" FOREIGN KEY ("passport_id") REFERENCES "public"."skill_passports"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE "enterprise_registries" ADD CONSTRAINT "enterprise_registries_approved_by_id_users_id_fk" FOREIGN KEY ("approved_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE "enterprise_audit_logs" ADD CONSTRAINT "enterprise_audit_logs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE "enterprise_audit_logs" ADD CONSTRAINT "enterprise_audit_logs_registry_id_enterprise_registries_id_fk" FOREIGN KEY ("registry_id") REFERENCES "public"."enterprise_registries"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE "enterprise_audit_logs" ADD CONSTRAINT "enterprise_audit_logs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE "enterprise_audit_logs" ADD CONSTRAINT "enterprise_audit_logs_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE "enterprise_audit_logs" ADD CONSTRAINT "enterprise_audit_logs_skill_version_id_skill_versions_id_fk" FOREIGN KEY ("skill_version_id") REFERENCES "public"."skill_versions"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE "enterprise_audit_logs" ADD CONSTRAINT "enterprise_audit_logs_skill_run_id_skill_runs_id_fk" FOREIGN KEY ("skill_run_id") REFERENCES "public"."skill_runs"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE "enterprise_audit_logs" ADD CONSTRAINT "enterprise_audit_logs_model_profile_id_model_profiles_id_fk" FOREIGN KEY ("model_profile_id") REFERENCES "public"."model_profiles"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE "site_settings_essential_starter_pack" ADD CONSTRAINT "site_settings_essential_starter_pack_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE "site_settings_essential_starter_pack" ADD CONSTRAINT "site_settings_essential_starter_pack_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."site_settings"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  CREATE UNIQUE INDEX IF NOT EXISTS "skill_passports_skill_idx" ON "skill_passports" USING btree ("skill_id");
  CREATE INDEX IF NOT EXISTS "skill_passports_skill_version_idx" ON "skill_passports" USING btree ("skill_version_id");
  CREATE INDEX IF NOT EXISTS "skill_passports_status_idx" ON "skill_passports" USING btree ("status");
  CREATE INDEX IF NOT EXISTS "skill_passports_evidence_hash_idx" ON "skill_passports" USING btree ("evidence_hash");
  CREATE INDEX IF NOT EXISTS "skill_passports_updated_at_idx" ON "skill_passports" USING btree ("updated_at");
  CREATE INDEX IF NOT EXISTS "skill_passports_created_at_idx" ON "skill_passports" USING btree ("created_at");
  CREATE INDEX IF NOT EXISTS "skill_status_idx" ON "skill_passports" USING btree ("skill_id","status");
  CREATE INDEX IF NOT EXISTS "compat_test_cases_skill_idx" ON "compat_test_cases" USING btree ("skill_id");
  CREATE INDEX IF NOT EXISTS "compat_test_cases_skill_version_idx" ON "compat_test_cases" USING btree ("skill_version_id");
  CREATE INDEX IF NOT EXISTS "compat_test_cases_enabled_idx" ON "compat_test_cases" USING btree ("enabled");
  CREATE INDEX IF NOT EXISTS "compat_test_cases_updated_at_idx" ON "compat_test_cases" USING btree ("updated_at");
  CREATE INDEX IF NOT EXISTS "compat_test_cases_created_at_idx" ON "compat_test_cases" USING btree ("created_at");
  CREATE INDEX IF NOT EXISTS "skill_enabled_idx" ON "compat_test_cases" USING btree ("skill_id","enabled");
  CREATE INDEX IF NOT EXISTS "adapter_profiles_skill_idx" ON "adapter_profiles" USING btree ("skill_id");
  CREATE INDEX IF NOT EXISTS "adapter_profiles_skill_version_idx" ON "adapter_profiles" USING btree ("skill_version_id");
  CREATE INDEX IF NOT EXISTS "adapter_profiles_source_failure_case_idx" ON "adapter_profiles" USING btree ("source_failure_case_id");
  CREATE INDEX IF NOT EXISTS "adapter_profiles_model_profile_idx" ON "adapter_profiles" USING btree ("model_profile_id");
  CREATE INDEX IF NOT EXISTS "adapter_profiles_model_name_idx" ON "adapter_profiles" USING btree ("model_name");
  CREATE INDEX IF NOT EXISTS "adapter_profiles_model_version_idx" ON "adapter_profiles" USING btree ("model_version");
  CREATE INDEX IF NOT EXISTS "adapter_profiles_status_idx" ON "adapter_profiles" USING btree ("status");
  CREATE INDEX IF NOT EXISTS "adapter_profiles_review_status_idx" ON "adapter_profiles" USING btree ("review_status");
  CREATE INDEX IF NOT EXISTS "adapter_profiles_reviewed_by_idx" ON "adapter_profiles" USING btree ("reviewed_by_id");
  CREATE INDEX IF NOT EXISTS "adapter_profiles_evidence_hash_idx" ON "adapter_profiles" USING btree ("evidence_hash");
  CREATE INDEX IF NOT EXISTS "adapter_profiles_updated_at_idx" ON "adapter_profiles" USING btree ("updated_at");
  CREATE INDEX IF NOT EXISTS "adapter_profiles_created_at_idx" ON "adapter_profiles" USING btree ("created_at");
  CREATE INDEX IF NOT EXISTS "skill_modelName_status_idx" ON "adapter_profiles" USING btree ("skill_id","model_name","status");
  CREATE INDEX IF NOT EXISTS "skill_modelProfile_status_idx" ON "adapter_profiles" USING btree ("skill_id","model_profile_id","status");
  CREATE INDEX IF NOT EXISTS "relay_sites_name_idx" ON "relay_sites" USING btree ("name");
  CREATE UNIQUE INDEX IF NOT EXISTS "relay_sites_slug_idx" ON "relay_sites" USING btree ("slug");
  CREATE INDEX IF NOT EXISTS "relay_sites_owner_idx" ON "relay_sites" USING btree ("owner_id");
  CREATE INDEX IF NOT EXISTS "relay_sites_protocol_idx" ON "relay_sites" USING btree ("protocol");
  CREATE INDEX IF NOT EXISTS "relay_sites_status_idx" ON "relay_sites" USING btree ("status");
  CREATE INDEX IF NOT EXISTS "relay_sites_claim_status_idx" ON "relay_sites" USING btree ("claim_status");
  CREATE INDEX IF NOT EXISTS "relay_sites_claim_domain_idx" ON "relay_sites" USING btree ("claim_domain");
  CREATE INDEX IF NOT EXISTS "relay_sites_schedule_enabled_idx" ON "relay_sites" USING btree ("schedule_enabled");
  CREATE INDEX IF NOT EXISTS "relay_sites_next_check_at_idx" ON "relay_sites" USING btree ("next_check_at");
  CREATE INDEX IF NOT EXISTS "relay_sites_reviewed_by_idx" ON "relay_sites" USING btree ("reviewed_by_id");
  CREATE INDEX IF NOT EXISTS "relay_sites_updated_at_idx" ON "relay_sites" USING btree ("updated_at");
  CREATE INDEX IF NOT EXISTS "relay_sites_created_at_idx" ON "relay_sites" USING btree ("created_at");
  CREATE INDEX IF NOT EXISTS "owner_status_idx" ON "relay_sites" USING btree ("owner_id","status");
  CREATE INDEX IF NOT EXISTS "status_claimStatus_idx" ON "relay_sites" USING btree ("status","claim_status");
  CREATE INDEX IF NOT EXISTS "scheduleEnabled_nextCheckAt_idx" ON "relay_sites" USING btree ("schedule_enabled","next_check_at");
  CREATE INDEX IF NOT EXISTS "relay_checks_site_idx" ON "relay_checks" USING btree ("site_id");
  CREATE INDEX IF NOT EXISTS "relay_checks_triggered_by_idx" ON "relay_checks" USING btree ("triggered_by_id");
  CREATE INDEX IF NOT EXISTS "relay_checks_source_idx" ON "relay_checks" USING btree ("source");
  CREATE INDEX IF NOT EXISTS "relay_checks_status_idx" ON "relay_checks" USING btree ("status");
  CREATE UNIQUE INDEX IF NOT EXISTS "relay_checks_detector_job_id_idx" ON "relay_checks" USING btree ("detector_job_id");
  CREATE INDEX IF NOT EXISTS "relay_checks_score_idx" ON "relay_checks" USING btree ("score");
  CREATE INDEX IF NOT EXISTS "relay_checks_verdict_idx" ON "relay_checks" USING btree ("verdict");
  CREATE INDEX IF NOT EXISTS "relay_checks_updated_at_idx" ON "relay_checks" USING btree ("updated_at");
  CREATE INDEX IF NOT EXISTS "relay_checks_created_at_idx" ON "relay_checks" USING btree ("created_at");
  CREATE INDEX IF NOT EXISTS "site_createdAt_idx" ON "relay_checks" USING btree ("site_id","created_at");
  CREATE INDEX IF NOT EXISTS "site_status_idx" ON "relay_checks" USING btree ("site_id","status");
  CREATE INDEX IF NOT EXISTS "detectorJobId_idx" ON "relay_checks" USING btree ("detector_job_id");
  CREATE INDEX IF NOT EXISTS "failure_cases_profile_key_idx" ON "failure_cases" USING btree ("profile_key");
  CREATE INDEX IF NOT EXISTS "failure_cases_error_type_idx" ON "failure_cases" USING btree ("error_type");
  CREATE INDEX IF NOT EXISTS "failure_cases_model_name_idx" ON "failure_cases" USING btree ("model_name");
  CREATE INDEX IF NOT EXISTS "failure_cases_skill_idx" ON "failure_cases" USING btree ("skill_id");
  CREATE INDEX IF NOT EXISTS "failure_cases_skill_version_idx" ON "failure_cases" USING btree ("skill_version_id");
  CREATE INDEX IF NOT EXISTS "failure_cases_triage_status_idx" ON "failure_cases" USING btree ("triage_status");
  CREATE INDEX IF NOT EXISTS "failure_cases_triaged_by_idx" ON "failure_cases" USING btree ("triaged_by_id");
  CREATE INDEX IF NOT EXISTS "failure_cases_evidence_hash_idx" ON "failure_cases" USING btree ("evidence_hash");
  CREATE INDEX IF NOT EXISTS "failure_cases_updated_at_idx" ON "failure_cases" USING btree ("updated_at");
  CREATE INDEX IF NOT EXISTS "failure_cases_created_at_idx" ON "failure_cases" USING btree ("created_at");
  CREATE INDEX IF NOT EXISTS "profileKey_idx" ON "failure_cases" USING btree ("profile_key");
  CREATE INDEX IF NOT EXISTS "errorType_modelName_idx" ON "failure_cases" USING btree ("error_type","model_name");
  CREATE INDEX IF NOT EXISTS "evidence_snapshots_target_type_idx" ON "evidence_snapshots" USING btree ("target_type");
  CREATE INDEX IF NOT EXISTS "evidence_snapshots_target_id_idx" ON "evidence_snapshots" USING btree ("target_id");
  CREATE INDEX IF NOT EXISTS "evidence_snapshots_evidence_hash_idx" ON "evidence_snapshots" USING btree ("evidence_hash");
  CREATE INDEX IF NOT EXISTS "evidence_snapshots_updated_at_idx" ON "evidence_snapshots" USING btree ("updated_at");
  CREATE INDEX IF NOT EXISTS "evidence_snapshots_created_at_idx" ON "evidence_snapshots" USING btree ("created_at");
  CREATE INDEX IF NOT EXISTS "targetType_targetId_idx" ON "evidence_snapshots" USING btree ("target_type","target_id");
  CREATE INDEX IF NOT EXISTS "audit_logs_event_idx" ON "audit_logs" USING btree ("event");
  CREATE INDEX IF NOT EXISTS "audit_logs_actor_idx" ON "audit_logs" USING btree ("actor_id");
  CREATE INDEX IF NOT EXISTS "audit_logs_target_user_idx" ON "audit_logs" USING btree ("target_user_id");
  CREATE INDEX IF NOT EXISTS "audit_logs_target_type_idx" ON "audit_logs" USING btree ("target_type");
  CREATE INDEX IF NOT EXISTS "audit_logs_target_id_idx" ON "audit_logs" USING btree ("target_id");
  CREATE INDEX IF NOT EXISTS "audit_logs_ip_hash_idx" ON "audit_logs" USING btree ("ip_hash");
  CREATE INDEX IF NOT EXISTS "audit_logs_updated_at_idx" ON "audit_logs" USING btree ("updated_at");
  CREATE INDEX IF NOT EXISTS "audit_logs_created_at_idx" ON "audit_logs" USING btree ("created_at");
  CREATE UNIQUE INDEX IF NOT EXISTS "organizations_slug_idx" ON "organizations" USING btree ("slug");
  CREATE INDEX IF NOT EXISTS "organizations_owner_idx" ON "organizations" USING btree ("owner_id");
  CREATE INDEX IF NOT EXISTS "organizations_updated_at_idx" ON "organizations" USING btree ("updated_at");
  CREATE INDEX IF NOT EXISTS "organizations_created_at_idx" ON "organizations" USING btree ("created_at");
  CREATE INDEX IF NOT EXISTS "slug_idx" ON "organizations" USING btree ("slug");
  CREATE INDEX IF NOT EXISTS "organization_members_organization_idx" ON "organization_members" USING btree ("organization_id");
  CREATE INDEX IF NOT EXISTS "organization_members_user_idx" ON "organization_members" USING btree ("user_id");
  CREATE INDEX IF NOT EXISTS "organization_members_updated_at_idx" ON "organization_members" USING btree ("updated_at");
  CREATE INDEX IF NOT EXISTS "organization_members_created_at_idx" ON "organization_members" USING btree ("created_at");
  CREATE INDEX IF NOT EXISTS "organization_user_idx" ON "organization_members" USING btree ("organization_id","user_id");
  CREATE INDEX IF NOT EXISTS "enterprise_registries_organization_idx" ON "enterprise_registries" USING btree ("organization_id");
  CREATE INDEX IF NOT EXISTS "enterprise_registries_skill_idx" ON "enterprise_registries" USING btree ("skill_id");
  CREATE INDEX IF NOT EXISTS "enterprise_registries_skill_version_idx" ON "enterprise_registries" USING btree ("skill_version_id");
  CREATE INDEX IF NOT EXISTS "enterprise_registries_passport_idx" ON "enterprise_registries" USING btree ("passport_id");
  CREATE INDEX IF NOT EXISTS "enterprise_registries_approved_by_idx" ON "enterprise_registries" USING btree ("approved_by_id");
  CREATE INDEX IF NOT EXISTS "enterprise_registries_updated_at_idx" ON "enterprise_registries" USING btree ("updated_at");
  CREATE INDEX IF NOT EXISTS "enterprise_registries_created_at_idx" ON "enterprise_registries" USING btree ("created_at");
  CREATE INDEX IF NOT EXISTS "organization_skill_idx" ON "enterprise_registries" USING btree ("organization_id","skill_id");
  CREATE INDEX IF NOT EXISTS "enterprise_audit_logs_organization_idx" ON "enterprise_audit_logs" USING btree ("organization_id");
  CREATE INDEX IF NOT EXISTS "enterprise_audit_logs_registry_idx" ON "enterprise_audit_logs" USING btree ("registry_id");
  CREATE INDEX IF NOT EXISTS "enterprise_audit_logs_actor_idx" ON "enterprise_audit_logs" USING btree ("actor_id");
  CREATE INDEX IF NOT EXISTS "enterprise_audit_logs_skill_idx" ON "enterprise_audit_logs" USING btree ("skill_id");
  CREATE INDEX IF NOT EXISTS "enterprise_audit_logs_skill_version_idx" ON "enterprise_audit_logs" USING btree ("skill_version_id");
  CREATE INDEX IF NOT EXISTS "enterprise_audit_logs_skill_run_idx" ON "enterprise_audit_logs" USING btree ("skill_run_id");
  CREATE INDEX IF NOT EXISTS "enterprise_audit_logs_run_id_idx" ON "enterprise_audit_logs" USING btree ("run_id");
  CREATE INDEX IF NOT EXISTS "enterprise_audit_logs_model_name_idx" ON "enterprise_audit_logs" USING btree ("model_name");
  CREATE INDEX IF NOT EXISTS "enterprise_audit_logs_model_version_idx" ON "enterprise_audit_logs" USING btree ("model_version");
  CREATE INDEX IF NOT EXISTS "enterprise_audit_logs_model_profile_idx" ON "enterprise_audit_logs" USING btree ("model_profile_id");
  CREATE INDEX IF NOT EXISTS "enterprise_audit_logs_outcome_idx" ON "enterprise_audit_logs" USING btree ("outcome");
  CREATE INDEX IF NOT EXISTS "enterprise_audit_logs_error_code_idx" ON "enterprise_audit_logs" USING btree ("error_code");
  CREATE INDEX IF NOT EXISTS "enterprise_audit_logs_updated_at_idx" ON "enterprise_audit_logs" USING btree ("updated_at");
  CREATE INDEX IF NOT EXISTS "enterprise_audit_logs_created_at_idx" ON "enterprise_audit_logs" USING btree ("created_at");
  CREATE INDEX IF NOT EXISTS "organization_createdAt_idx" ON "enterprise_audit_logs" USING btree ("organization_id","created_at");
  CREATE INDEX IF NOT EXISTS "registry_createdAt_idx" ON "enterprise_audit_logs" USING btree ("registry_id","created_at");
  CREATE INDEX IF NOT EXISTS "runId_idx" ON "enterprise_audit_logs" USING btree ("run_id");
  CREATE INDEX IF NOT EXISTS "model_profiles_provider_idx" ON "model_profiles" USING btree ("provider");
  CREATE INDEX IF NOT EXISTS "model_profiles_model_name_idx" ON "model_profiles" USING btree ("model_name");
  CREATE INDEX IF NOT EXISTS "model_profiles_updated_at_idx" ON "model_profiles" USING btree ("updated_at");
  CREATE INDEX IF NOT EXISTS "model_profiles_created_at_idx" ON "model_profiles" USING btree ("created_at");
  CREATE INDEX IF NOT EXISTS "provider_modelName_idx" ON "model_profiles" USING btree ("provider","model_name");
  CREATE INDEX IF NOT EXISTS "modelName_modelVersion_idx" ON "model_profiles" USING btree ("model_name","model_version");
  CREATE INDEX IF NOT EXISTS "site_settings_essential_starter_pack_order_idx" ON "site_settings_essential_starter_pack" USING btree ("_order");
  CREATE INDEX IF NOT EXISTS "site_settings_essential_starter_pack_parent_id_idx" ON "site_settings_essential_starter_pack" USING btree ("_parent_id");
  CREATE INDEX IF NOT EXISTS "site_settings_essential_starter_pack_skill_idx" ON "site_settings_essential_starter_pack" USING btree ("skill_id");
  DO $$ BEGIN ALTER TABLE "skill_runs" ADD CONSTRAINT "skill_runs_rerun_of_id_skill_runs_id_fk" FOREIGN KEY ("rerun_of_id") REFERENCES "public"."skill_runs"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE "skill_runs" ADD CONSTRAINT "skill_runs_adapter_profile_id_adapter_profiles_id_fk" FOREIGN KEY ("adapter_profile_id") REFERENCES "public"."adapter_profiles"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE "skill_runs" ADD CONSTRAINT "skill_runs_model_profile_id_model_profiles_id_fk" FOREIGN KEY ("model_profile_id") REFERENCES "public"."model_profiles"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE "compat_reports" ADD CONSTRAINT "compat_reports_model_profile_id_model_profiles_id_fk" FOREIGN KEY ("model_profile_id") REFERENCES "public"."model_profiles"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE "compat_reports" ADD CONSTRAINT "compat_reports_adapter_profile_id_adapter_profiles_id_fk" FOREIGN KEY ("adapter_profile_id") REFERENCES "public"."adapter_profiles"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE "compat_reports" ADD CONSTRAINT "compat_reports_benchmark_case_id_compat_test_cases_id_fk" FOREIGN KEY ("benchmark_case_id") REFERENCES "public"."compat_test_cases"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_skill_passports_fk" FOREIGN KEY ("skill_passports_id") REFERENCES "public"."skill_passports"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_compat_test_cases_fk" FOREIGN KEY ("compat_test_cases_id") REFERENCES "public"."compat_test_cases"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_adapter_profiles_fk" FOREIGN KEY ("adapter_profiles_id") REFERENCES "public"."adapter_profiles"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_relay_sites_fk" FOREIGN KEY ("relay_sites_id") REFERENCES "public"."relay_sites"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_relay_checks_fk" FOREIGN KEY ("relay_checks_id") REFERENCES "public"."relay_checks"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_failure_cases_fk" FOREIGN KEY ("failure_cases_id") REFERENCES "public"."failure_cases"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_evidence_snapshots_fk" FOREIGN KEY ("evidence_snapshots_id") REFERENCES "public"."evidence_snapshots"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_audit_logs_fk" FOREIGN KEY ("audit_logs_id") REFERENCES "public"."audit_logs"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_organizations_fk" FOREIGN KEY ("organizations_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_organization_members_fk" FOREIGN KEY ("organization_members_id") REFERENCES "public"."organization_members"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_enterprise_registries_fk" FOREIGN KEY ("enterprise_registries_id") REFERENCES "public"."enterprise_registries"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_enterprise_audit_logs_fk" FOREIGN KEY ("enterprise_audit_logs_id") REFERENCES "public"."enterprise_audit_logs"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_model_profiles_fk" FOREIGN KEY ("model_profiles_id") REFERENCES "public"."model_profiles"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  CREATE UNIQUE INDEX IF NOT EXISTS "skills_client_submission_key_idx" ON "skills" USING btree ("client_submission_key");
  CREATE INDEX IF NOT EXISTS "skills_import_source_hash_idx" ON "skills" USING btree ("import_source_hash");
  CREATE INDEX IF NOT EXISTS "status_visibility_isEssential_idx" ON "skills" USING btree ("status","visibility","is_essential");
  CREATE INDEX IF NOT EXISTS "skill_versions_contract_hash_idx" ON "skill_versions" USING btree ("contract_hash");
  CREATE INDEX IF NOT EXISTS "skill_runs_rerun_of_idx" ON "skill_runs" USING btree ("rerun_of_id");
  CREATE INDEX IF NOT EXISTS "skill_runs_adapter_profile_idx" ON "skill_runs" USING btree ("adapter_profile_id");
  CREATE INDEX IF NOT EXISTS "skill_runs_model_profile_idx" ON "skill_runs" USING btree ("model_profile_id");
  CREATE INDEX IF NOT EXISTS "compat_reports_model_profile_idx" ON "compat_reports" USING btree ("model_profile_id");
  CREATE INDEX IF NOT EXISTS "compat_reports_adapter_profile_idx" ON "compat_reports" USING btree ("adapter_profile_id");
  CREATE INDEX IF NOT EXISTS "compat_reports_benchmark_case_idx" ON "compat_reports" USING btree ("benchmark_case_id");
  CREATE INDEX IF NOT EXISTS "skill_createdAt_idx" ON "compat_reports" USING btree ("skill_id","created_at");
  CREATE INDEX IF NOT EXISTS "modelName_createdAt_idx" ON "compat_reports" USING btree ("model_name","created_at");
  CREATE INDEX IF NOT EXISTS "modelProfile_createdAt_idx" ON "compat_reports" USING btree ("model_profile_id","created_at");
  CREATE INDEX IF NOT EXISTS "users_device_hash_idx" ON "users" USING btree ("device_hash");
  CREATE INDEX IF NOT EXISTS "payload_locked_documents_rels_skill_passports_id_idx" ON "payload_locked_documents_rels" USING btree ("skill_passports_id");
  CREATE INDEX IF NOT EXISTS "payload_locked_documents_rels_compat_test_cases_id_idx" ON "payload_locked_documents_rels" USING btree ("compat_test_cases_id");
  CREATE INDEX IF NOT EXISTS "payload_locked_documents_rels_adapter_profiles_id_idx" ON "payload_locked_documents_rels" USING btree ("adapter_profiles_id");
  CREATE INDEX IF NOT EXISTS "payload_locked_documents_rels_relay_sites_id_idx" ON "payload_locked_documents_rels" USING btree ("relay_sites_id");
  CREATE INDEX IF NOT EXISTS "payload_locked_documents_rels_relay_checks_id_idx" ON "payload_locked_documents_rels" USING btree ("relay_checks_id");
  CREATE INDEX IF NOT EXISTS "payload_locked_documents_rels_failure_cases_id_idx" ON "payload_locked_documents_rels" USING btree ("failure_cases_id");
  CREATE INDEX IF NOT EXISTS "payload_locked_documents_rels_evidence_snapshots_id_idx" ON "payload_locked_documents_rels" USING btree ("evidence_snapshots_id");
  CREATE INDEX IF NOT EXISTS "payload_locked_documents_rels_audit_logs_id_idx" ON "payload_locked_documents_rels" USING btree ("audit_logs_id");
  CREATE INDEX IF NOT EXISTS "payload_locked_documents_rels_organizations_id_idx" ON "payload_locked_documents_rels" USING btree ("organizations_id");
  CREATE INDEX IF NOT EXISTS "payload_locked_documents_rels_organization_members_id_idx" ON "payload_locked_documents_rels" USING btree ("organization_members_id");
  CREATE INDEX IF NOT EXISTS "payload_locked_documents_rels_enterprise_registries_id_idx" ON "payload_locked_documents_rels" USING btree ("enterprise_registries_id");
  CREATE INDEX IF NOT EXISTS "payload_locked_documents_rels_enterprise_audit_logs_id_idx" ON "payload_locked_documents_rels" USING btree ("enterprise_audit_logs_id");
  CREATE INDEX IF NOT EXISTS "payload_locked_documents_rels_model_profiles_id_idx" ON "payload_locked_documents_rels" USING btree ("model_profiles_id");`)
}

export async function down(_args: MigrateDownArgs): Promise<void> {
  throw new Error('20260718_130000_schema_alignment is a forward-only reconciliation migration')
}
