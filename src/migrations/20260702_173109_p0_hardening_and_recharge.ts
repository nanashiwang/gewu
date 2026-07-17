import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_skills_visibility" AS ENUM('public', 'private', 'unlisted', 'enterprise');
  CREATE TYPE "public"."enum_skills_status" AS ENUM('draft', 'pending', 'published', 'rejected', 'archived');
  CREATE TYPE "public"."enum_skill_versions_status" AS ENUM('draft', 'active', 'deprecated');
  CREATE TYPE "public"."enum_skill_artifacts_format" AS ENUM('yaml', 'json');
  CREATE TYPE "public"."enum_skill_runs_route_mode" AS ENUM('cheap', 'quality', 'fast', 'balanced');
  CREATE TYPE "public"."enum_bounties_reward_type" AS ENUM('points', 'cash', 'credit');
  CREATE TYPE "public"."enum_bounties_status" AS ENUM('open', 'accepted', 'submitted', 'completed', 'disputed', 'cancelled');
  CREATE TYPE "public"."enum_compat_reports_source" AS ENUM('community', 'verified', 'online', 'benchmark');
  CREATE TYPE "public"."enum_users_role" AS ENUM('user', 'creator', 'certified_creator', 'reviewer', 'admin', 'enterprise_admin');
  CREATE TYPE "public"."enum_users_account_status" AS ENUM('active', 'banned');
  CREATE TYPE "public"."enum_invite_codes_status" AS ENUM('unused', 'used', 'expired', 'revoked');
  CREATE TYPE "public"."enum_contribution_logs_action_type" AS ENUM('skill_published', 'skill_favorited', 'skill_run', 'skill_high_rating', 'skill_version_update', 'fix_issue', 'eval_sample', 'failure_case', 'route_optimization', 'compat_report', 'review', 'security', 'bounty', 'invite', 'consume', 'other');
  CREATE TYPE "public"."enum_contribution_rules_action_type" AS ENUM('skill_published', 'skill_favorited', 'skill_run', 'skill_high_rating', 'skill_version_update', 'fix_issue', 'eval_sample', 'failure_case', 'route_optimization', 'compat_report', 'review', 'security', 'bounty', 'invite', 'consume', 'other');
  CREATE TYPE "public"."enum_credit_logs_type" AS ENUM('recharge', 'exchange', 'consume', 'refund', 'adjust');
  CREATE TYPE "public"."enum_recharge_codes_status" AS ENUM('unused', 'used', 'disabled');
  CREATE TYPE "public"."enum_runner_clients_trusted_level" AS ENUM('community', 'verified');
  CREATE TYPE "public"."enum_device_codes_status" AS ENUM('pending', 'authorized', 'denied', 'consumed');
  CREATE TYPE "public"."enum_skill_installs_status" AS ENUM('installed', 'removed');
  CREATE TYPE "public"."enum_notifications_type" AS ENUM('skill_favorited', 'review', 'bounty_accepted', 'bounty_submitted', 'bounty_completed', 'system');
  CREATE TYPE "public"."enum_reviews_type" AS ENUM('review', 'failure_case', 'compat_report');
  CREATE TYPE "public"."enum_reviews_status" AS ENUM('visible', 'hidden', 'pending');
  CREATE TYPE "public"."enum_reports_target_type" AS ENUM('skill', 'review', 'user', 'bounty');
  CREATE TYPE "public"."enum_reports_reason" AS ENUM('spam', 'low_quality', 'copyright', 'abuse', 'security', 'other');
  CREATE TYPE "public"."enum_reports_status" AS ENUM('open', 'reviewing', 'resolved', 'dismissed');
  CREATE TABLE "skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" varchar NOT NULL,
	"slug" varchar,
	"description" varchar,
	"category_id" uuid,
	"author_id" uuid,
	"forked_from_id" uuid,
	"visibility" "enum_skills_visibility" DEFAULT 'public',
	"status" "enum_skills_status" DEFAULT 'draft',
	"current_version_id" uuid,
	"is_official" boolean DEFAULT false,
	"is_featured" boolean DEFAULT false,
	"is_freeleech" boolean DEFAULT false,
	"skill_rank" numeric DEFAULT 0,
	"local_score" numeric DEFAULT 0,
	"health_score" numeric DEFAULT 0,
	"run_count" numeric DEFAULT 0,
	"download_count" numeric DEFAULT 0,
	"favorite_count" numeric DEFAULT 0,
	"review_count" numeric DEFAULT 0,
	"avg_rating" numeric DEFAULT 0,
	"avg_cost" numeric DEFAULT 0,
	"avg_latency_ms" numeric DEFAULT 0,
	"success_rate" numeric DEFAULT 0,
	"format_success_rate" numeric DEFAULT 0,
	"last_run_at" timestamp(3) with time zone,
	"last_updated_at" timestamp(3) with time zone,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

  CREATE TABLE "skill_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"skill_id" uuid NOT NULL,
	"version" varchar DEFAULT '1.0.0' NOT NULL,
	"system_prompt" varchar,
	"prompt_template" varchar NOT NULL,
	"input_schema" jsonb,
	"output_schema" jsonb,
	"recommended_models" jsonb,
	"route_policy" jsonb,
	"changelog" varchar,
	"license" varchar DEFAULT 'CC-BY-NC-4.0',
	"min_runner_version" varchar DEFAULT '0.2.0',
	"permissions_network" boolean DEFAULT false,
	"permissions_file_read" boolean DEFAULT false,
	"permissions_file_write" boolean DEFAULT false,
	"permissions_shell" boolean DEFAULT false,
	"examples" jsonb,
	"status" "enum_skill_versions_status" DEFAULT 'active',
	"created_by_id" uuid,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

  CREATE TABLE "skill_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"skill_id" uuid NOT NULL,
	"skill_version_id" uuid NOT NULL,
	"version" varchar,
	"format" "enum_skill_artifacts_format" NOT NULL,
	"manifest" varchar,
	"checksum" varchar,
	"file_size" numeric,
	"download_count" numeric DEFAULT 0,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

  CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar NOT NULL,
	"slug" varchar,
	"description" varchar,
	"icon" varchar,
	"order" numeric DEFAULT 0,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

  CREATE TABLE "skill_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" varchar,
	"user_id" uuid,
	"skill_id" uuid NOT NULL,
	"skill_version_id" uuid,
	"model" varchar,
	"route_mode" "enum_skill_runs_route_mode",
	"input_json" jsonb,
	"output_text" varchar,
	"output_json" jsonb,
	"prompt_tokens" numeric,
	"completion_tokens" numeric,
	"total_tokens" numeric,
	"estimated_cost" numeric,
	"charged_amount" numeric,
	"saved_amount" numeric DEFAULT 0,
	"latency_ms" numeric,
	"success" boolean DEFAULT false,
	"error_code" varchar,
	"format_valid" boolean DEFAULT false,
	"counted_in_metrics" boolean DEFAULT true,
	"newapi_log_id" varchar,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

  CREATE TABLE "bounties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" varchar NOT NULL,
	"description" varchar,
	"creator_id" uuid,
	"reward_type" "enum_bounties_reward_type" DEFAULT 'points',
	"reward_points" numeric DEFAULT 0,
	"reward_amount" numeric DEFAULT 0,
	"status" "enum_bounties_status" DEFAULT 'open',
	"frozen_points" numeric DEFAULT 0,
	"idempotency_key" varchar,
	"accepted_by_id" uuid,
	"submitted_skill_id" uuid,
	"requirements" jsonb,
	"due_at" timestamp(3) with time zone,
	"is_public" boolean DEFAULT true,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

  CREATE TABLE "compat_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"skill_id" uuid NOT NULL,
	"skill_version_id" uuid,
	"runner_id" uuid,
	"anonymous_user_hash" varchar,
	"model_provider" varchar,
	"model_name" varchar,
	"model_version" varchar,
	"success" boolean DEFAULT false,
	"latency_ms" numeric,
	"format_valid" boolean DEFAULT false,
	"error_type" varchar,
	"input_size_bucket" varchar,
	"output_size_bucket" varchar,
	"runner_version" varchar,
	"suppressed" boolean DEFAULT false,
	"source" "enum_compat_reports_source" DEFAULT 'community',
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

  CREATE TABLE "users_sessions" (
	"_order" integer NOT NULL,
	"_parent_id" uuid NOT NULL,
	"id" varchar PRIMARY KEY NOT NULL,
	"created_at" timestamp(3) with time zone,
	"expires_at" timestamp(3) with time zone NOT NULL
  );

  CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" varchar NOT NULL,
	"role" "enum_users_role" DEFAULT 'user' NOT NULL,
	"level" numeric DEFAULT 1,
	"account_status" "enum_users_account_status" DEFAULT 'active',
	"contribution_score" numeric DEFAULT 0,
	"consumption_score" numeric DEFAULT 0,
	"credit_balance" numeric DEFAULT 0,
	"invite_count" numeric DEFAULT 3,
	"warning_count" numeric DEFAULT 0,
	"bio" varchar,
	"invited_by_id" uuid,
	"ip_hash" varchar,
	"newapi_user_id" varchar,
	"newapi_key_encrypted" varchar,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"email" varchar NOT NULL,
	"reset_password_token" varchar,
	"reset_password_expiration" timestamp(3) with time zone,
	"salt" varchar,
	"hash" varchar,
	"login_attempts" numeric DEFAULT 0,
	"lock_until" timestamp(3) with time zone
  );

  CREATE TABLE "invite_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar,
	"inviter_id" uuid,
	"used_by_id" uuid,
	"status" "enum_invite_codes_status" DEFAULT 'unused',
	"min_level_required" numeric DEFAULT 1,
	"expires_at" timestamp(3) with time zone,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

  CREATE TABLE "contribution_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"action_type" "enum_contribution_logs_action_type" NOT NULL,
	"points" numeric NOT NULL,
	"actor_id" uuid,
	"idempotency_key" varchar,
	"related_skill_id" uuid,
	"related_bounty_id" uuid,
	"description" varchar,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

  CREATE TABLE "contribution_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action_type" "enum_contribution_rules_action_type" NOT NULL,
	"base_points" numeric DEFAULT 0 NOT NULL,
	"daily_limit" numeric DEFAULT 0,
	"self_action_excluded" boolean DEFAULT false,
	"enabled" boolean DEFAULT true,
	"description" varchar,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

  CREATE TABLE "credit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "enum_credit_logs_type" NOT NULL,
	"amount" numeric NOT NULL,
	"balance_after" numeric,
	"idempotency_key" varchar,
	"description" varchar,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

  CREATE TABLE "recharge_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar NOT NULL,
	"credit_amount" numeric NOT NULL,
	"status" "enum_recharge_codes_status" DEFAULT 'unused' NOT NULL,
	"used_by_id" uuid,
	"used_at" timestamp(3) with time zone,
	"expires_at" timestamp(3) with time zone,
	"note" varchar,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

  CREATE TABLE "favorites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"skill_id" uuid NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

  CREATE TABLE "runner_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"runner_id" varchar NOT NULL,
	"token_hash" varchar,
	"token" varchar,
	"token_expires_at" timestamp(3) with time zone,
	"runner_version" varchar,
	"os" varchar,
	"arch" varchar,
	"label" varchar,
	"anonymous_mode" boolean DEFAULT false,
	"trusted_level" "enum_runner_clients_trusted_level" DEFAULT 'community',
	"last_seen_at" timestamp(3) with time zone,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

  CREATE TABLE "device_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_code" varchar NOT NULL,
	"user_code" varchar NOT NULL,
	"status" "enum_device_codes_status" DEFAULT 'pending',
	"user_id" uuid,
	"runner_client_id" uuid,
	"meta" jsonb,
	"ip_hash" varchar,
	"expires_at" timestamp(3) with time zone,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

  CREATE TABLE "skill_installs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"skill_version_id" uuid,
	"runner_id" uuid,
	"installed_version" varchar,
	"installed_checksum" varchar,
	"status" "enum_skill_installs_status" DEFAULT 'installed',
	"installed_at" timestamp(3) with time zone,
	"last_used_at" timestamp(3) with time zone,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

  CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "enum_notifications_type" DEFAULT 'system',
	"title" varchar NOT NULL,
	"body" varchar,
	"link" varchar,
	"read" boolean DEFAULT false,
	"related_skill_id" uuid,
	"related_bounty_id" uuid,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

  CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"skill_id" uuid NOT NULL,
	"user_id" uuid,
	"rating" numeric,
	"content" varchar,
	"type" "enum_reviews_type" DEFAULT 'review',
	"status" "enum_reviews_status" DEFAULT 'visible',
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

  CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reporter_id" uuid,
	"target_type" "enum_reports_target_type" NOT NULL,
	"target_id" varchar NOT NULL,
	"reason" "enum_reports_reason" NOT NULL,
	"detail" varchar,
	"status" "enum_reports_status" DEFAULT 'open',
	"handled_by_id" uuid,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

  CREATE TABLE "media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"alt" varchar,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"url" varchar,
	"thumbnail_u_r_l" varchar,
	"filename" varchar,
	"mime_type" varchar,
	"filesize" numeric,
	"width" numeric,
	"height" numeric,
	"focal_x" numeric,
	"focal_y" numeric
  );

  CREATE TABLE "model_price_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model" varchar NOT NULL,
	"input_price" numeric NOT NULL,
	"output_price" numeric NOT NULL,
	"currency" varchar DEFAULT 'CNY',
	"source_url" varchar,
	"captured_at" timestamp(3) with time zone,
	"note" varchar,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

  CREATE TABLE "score_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"skill_id" uuid NOT NULL,
	"local_score" numeric NOT NULL,
	"report_count" numeric,
	"payload_hash" varchar,
	"key_id" varchar,
	"signature" varchar,
	"signed_at" varchar,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

  CREATE TABLE "payload_kv" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar NOT NULL,
	"data" jsonb NOT NULL
  );

  CREATE TABLE "payload_locked_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"global_slug" varchar,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

  CREATE TABLE "payload_locked_documents_rels" (
	"id" serial PRIMARY KEY NOT NULL,
	"order" integer,
	"parent_id" uuid NOT NULL,
	"path" varchar NOT NULL,
	"skills_id" uuid,
	"skill_versions_id" uuid,
	"skill_artifacts_id" uuid,
	"categories_id" uuid,
	"skill_runs_id" uuid,
	"bounties_id" uuid,
	"compat_reports_id" uuid,
	"users_id" uuid,
	"invite_codes_id" uuid,
	"contribution_logs_id" uuid,
	"contribution_rules_id" uuid,
	"credit_logs_id" uuid,
	"recharge_codes_id" uuid,
	"favorites_id" uuid,
	"runner_clients_id" uuid,
	"device_codes_id" uuid,
	"skill_installs_id" uuid,
	"notifications_id" uuid,
	"reviews_id" uuid,
	"reports_id" uuid,
	"media_id" uuid,
	"model_price_snapshots_id" uuid,
	"score_snapshots_id" uuid
  );

  CREATE TABLE "payload_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar,
	"value" jsonb,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

  CREATE TABLE "payload_preferences_rels" (
	"id" serial PRIMARY KEY NOT NULL,
	"order" integer,
	"parent_id" uuid NOT NULL,
	"path" varchar NOT NULL,
	"users_id" uuid
  );

  CREATE TABLE "payload_migrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar,
	"batch" numeric,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

  CREATE TABLE "site_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_name" varchar DEFAULT '格物',
	"slogan" varchar DEFAULT 'Verified AI Skills, Powered by Contribution.',
	"announcement" varchar,
	"updated_at" timestamp(3) with time zone,
	"created_at" timestamp(3) with time zone
  );

  CREATE TABLE "site_settings_rels" (
	"id" serial PRIMARY KEY NOT NULL,
	"order" integer,
	"parent_id" uuid NOT NULL,
	"path" varchar NOT NULL,
	"skills_id" uuid
  );

  CREATE TABLE "economy_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"exchange_enabled" boolean DEFAULT false,
	"free_credit_on_register" numeric DEFAULT 0,
	"alpha" numeric DEFAULT 0.3,
	"monthly_realized_margin_cents" numeric DEFAULT 0,
	"points_per_credit" numeric DEFAULT 10,
	"min_credit_per_tx" numeric DEFAULT 10,
	"per_tx_max_credit" numeric DEFAULT 500,
	"per_user_daily_max_credit" numeric DEFAULT 1000,
	"per_user_monthly_max_credit" numeric DEFAULT 5000,
	"updated_at" timestamp(3) with time zone,
	"created_at" timestamp(3) with time zone
  );

  ALTER TABLE "skills" ADD CONSTRAINT "skills_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "skills" ADD CONSTRAINT "skills_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "skills" ADD CONSTRAINT "skills_forked_from_id_skills_id_fk" FOREIGN KEY ("forked_from_id") REFERENCES "public"."skills"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "skills" ADD CONSTRAINT "skills_current_version_id_skill_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."skill_versions"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "skill_artifacts" ADD CONSTRAINT "skill_artifacts_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "skill_artifacts" ADD CONSTRAINT "skill_artifacts_skill_version_id_skill_versions_id_fk" FOREIGN KEY ("skill_version_id") REFERENCES "public"."skill_versions"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "skill_runs" ADD CONSTRAINT "skill_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "skill_runs" ADD CONSTRAINT "skill_runs_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "skill_runs" ADD CONSTRAINT "skill_runs_skill_version_id_skill_versions_id_fk" FOREIGN KEY ("skill_version_id") REFERENCES "public"."skill_versions"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "bounties" ADD CONSTRAINT "bounties_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "bounties" ADD CONSTRAINT "bounties_accepted_by_id_users_id_fk" FOREIGN KEY ("accepted_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "bounties" ADD CONSTRAINT "bounties_submitted_skill_id_skills_id_fk" FOREIGN KEY ("submitted_skill_id") REFERENCES "public"."skills"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "compat_reports" ADD CONSTRAINT "compat_reports_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "compat_reports" ADD CONSTRAINT "compat_reports_skill_version_id_skill_versions_id_fk" FOREIGN KEY ("skill_version_id") REFERENCES "public"."skill_versions"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "compat_reports" ADD CONSTRAINT "compat_reports_runner_id_runner_clients_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runner_clients"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "users_sessions" ADD CONSTRAINT "users_sessions_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "users" ADD CONSTRAINT "users_invited_by_id_users_id_fk" FOREIGN KEY ("invited_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "invite_codes" ADD CONSTRAINT "invite_codes_inviter_id_users_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "invite_codes" ADD CONSTRAINT "invite_codes_used_by_id_users_id_fk" FOREIGN KEY ("used_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "contribution_logs" ADD CONSTRAINT "contribution_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "contribution_logs" ADD CONSTRAINT "contribution_logs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "contribution_logs" ADD CONSTRAINT "contribution_logs_related_skill_id_skills_id_fk" FOREIGN KEY ("related_skill_id") REFERENCES "public"."skills"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "contribution_logs" ADD CONSTRAINT "contribution_logs_related_bounty_id_bounties_id_fk" FOREIGN KEY ("related_bounty_id") REFERENCES "public"."bounties"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "credit_logs" ADD CONSTRAINT "credit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "recharge_codes" ADD CONSTRAINT "recharge_codes_used_by_id_users_id_fk" FOREIGN KEY ("used_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "favorites" ADD CONSTRAINT "favorites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "favorites" ADD CONSTRAINT "favorites_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "runner_clients" ADD CONSTRAINT "runner_clients_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "device_codes" ADD CONSTRAINT "device_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "device_codes" ADD CONSTRAINT "device_codes_runner_client_id_runner_clients_id_fk" FOREIGN KEY ("runner_client_id") REFERENCES "public"."runner_clients"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "skill_installs" ADD CONSTRAINT "skill_installs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "skill_installs" ADD CONSTRAINT "skill_installs_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "skill_installs" ADD CONSTRAINT "skill_installs_skill_version_id_skill_versions_id_fk" FOREIGN KEY ("skill_version_id") REFERENCES "public"."skill_versions"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "skill_installs" ADD CONSTRAINT "skill_installs_runner_id_runner_clients_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runner_clients"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "notifications" ADD CONSTRAINT "notifications_related_skill_id_skills_id_fk" FOREIGN KEY ("related_skill_id") REFERENCES "public"."skills"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "notifications" ADD CONSTRAINT "notifications_related_bounty_id_bounties_id_fk" FOREIGN KEY ("related_bounty_id") REFERENCES "public"."bounties"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "reviews" ADD CONSTRAINT "reviews_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "reviews" ADD CONSTRAINT "reviews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "reports" ADD CONSTRAINT "reports_handled_by_id_users_id_fk" FOREIGN KEY ("handled_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "score_snapshots" ADD CONSTRAINT "score_snapshots_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."payload_locked_documents"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_skills_fk" FOREIGN KEY ("skills_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_skill_versions_fk" FOREIGN KEY ("skill_versions_id") REFERENCES "public"."skill_versions"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_skill_artifacts_fk" FOREIGN KEY ("skill_artifacts_id") REFERENCES "public"."skill_artifacts"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_categories_fk" FOREIGN KEY ("categories_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_skill_runs_fk" FOREIGN KEY ("skill_runs_id") REFERENCES "public"."skill_runs"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_bounties_fk" FOREIGN KEY ("bounties_id") REFERENCES "public"."bounties"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_compat_reports_fk" FOREIGN KEY ("compat_reports_id") REFERENCES "public"."compat_reports"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_users_fk" FOREIGN KEY ("users_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_invite_codes_fk" FOREIGN KEY ("invite_codes_id") REFERENCES "public"."invite_codes"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_contribution_logs_fk" FOREIGN KEY ("contribution_logs_id") REFERENCES "public"."contribution_logs"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_contribution_rules_fk" FOREIGN KEY ("contribution_rules_id") REFERENCES "public"."contribution_rules"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_credit_logs_fk" FOREIGN KEY ("credit_logs_id") REFERENCES "public"."credit_logs"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_recharge_codes_fk" FOREIGN KEY ("recharge_codes_id") REFERENCES "public"."recharge_codes"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_favorites_fk" FOREIGN KEY ("favorites_id") REFERENCES "public"."favorites"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_runner_clients_fk" FOREIGN KEY ("runner_clients_id") REFERENCES "public"."runner_clients"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_device_codes_fk" FOREIGN KEY ("device_codes_id") REFERENCES "public"."device_codes"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_skill_installs_fk" FOREIGN KEY ("skill_installs_id") REFERENCES "public"."skill_installs"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_notifications_fk" FOREIGN KEY ("notifications_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_reviews_fk" FOREIGN KEY ("reviews_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_reports_fk" FOREIGN KEY ("reports_id") REFERENCES "public"."reports"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_media_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_model_price_snapshots_fk" FOREIGN KEY ("model_price_snapshots_id") REFERENCES "public"."model_price_snapshots"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_score_snapshots_fk" FOREIGN KEY ("score_snapshots_id") REFERENCES "public"."score_snapshots"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_preferences_rels" ADD CONSTRAINT "payload_preferences_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."payload_preferences"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_preferences_rels" ADD CONSTRAINT "payload_preferences_rels_users_fk" FOREIGN KEY ("users_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "site_settings_rels" ADD CONSTRAINT "site_settings_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."site_settings"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "site_settings_rels" ADD CONSTRAINT "site_settings_rels_skills_fk" FOREIGN KEY ("skills_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;
  CREATE UNIQUE INDEX "skills_slug_idx" ON "skills" USING btree ("slug");
  CREATE INDEX "skills_category_idx" ON "skills" USING btree ("category_id");
  CREATE INDEX "skills_author_idx" ON "skills" USING btree ("author_id");
  CREATE INDEX "skills_forked_from_idx" ON "skills" USING btree ("forked_from_id");
  CREATE INDEX "skills_current_version_idx" ON "skills" USING btree ("current_version_id");
  CREATE INDEX "skills_skill_rank_idx" ON "skills" USING btree ("skill_rank");
  CREATE INDEX "skills_run_count_idx" ON "skills" USING btree ("run_count");
  CREATE INDEX "skills_success_rate_idx" ON "skills" USING btree ("success_rate");
  CREATE INDEX "skills_updated_at_idx" ON "skills" USING btree ("updated_at");
  CREATE INDEX "skills_created_at_idx" ON "skills" USING btree ("created_at");
  CREATE INDEX "status_visibility_idx" ON "skills" USING btree ("status","visibility");
  CREATE INDEX "skill_versions_skill_idx" ON "skill_versions" USING btree ("skill_id");
  CREATE INDEX "skill_versions_created_by_idx" ON "skill_versions" USING btree ("created_by_id");
  CREATE INDEX "skill_versions_updated_at_idx" ON "skill_versions" USING btree ("updated_at");
  CREATE INDEX "skill_versions_created_at_idx" ON "skill_versions" USING btree ("created_at");
  CREATE INDEX "skill_artifacts_skill_idx" ON "skill_artifacts" USING btree ("skill_id");
  CREATE INDEX "skill_artifacts_skill_version_idx" ON "skill_artifacts" USING btree ("skill_version_id");
  CREATE INDEX "skill_artifacts_format_idx" ON "skill_artifacts" USING btree ("format");
  CREATE INDEX "skill_artifacts_checksum_idx" ON "skill_artifacts" USING btree ("checksum");
  CREATE INDEX "skill_artifacts_updated_at_idx" ON "skill_artifacts" USING btree ("updated_at");
  CREATE INDEX "skill_artifacts_created_at_idx" ON "skill_artifacts" USING btree ("created_at");
  CREATE UNIQUE INDEX "categories_slug_idx" ON "categories" USING btree ("slug");
  CREATE INDEX "categories_updated_at_idx" ON "categories" USING btree ("updated_at");
  CREATE INDEX "categories_created_at_idx" ON "categories" USING btree ("created_at");
  CREATE INDEX "skill_runs_run_id_idx" ON "skill_runs" USING btree ("run_id");
  CREATE INDEX "skill_runs_user_idx" ON "skill_runs" USING btree ("user_id");
  CREATE INDEX "skill_runs_skill_idx" ON "skill_runs" USING btree ("skill_id");
  CREATE INDEX "skill_runs_skill_version_idx" ON "skill_runs" USING btree ("skill_version_id");
  CREATE INDEX "skill_runs_updated_at_idx" ON "skill_runs" USING btree ("updated_at");
  CREATE INDEX "skill_runs_created_at_idx" ON "skill_runs" USING btree ("created_at");
  CREATE INDEX "bounties_creator_idx" ON "bounties" USING btree ("creator_id");
  CREATE UNIQUE INDEX "bounties_idempotency_key_idx" ON "bounties" USING btree ("idempotency_key");
  CREATE INDEX "bounties_accepted_by_idx" ON "bounties" USING btree ("accepted_by_id");
  CREATE INDEX "bounties_submitted_skill_idx" ON "bounties" USING btree ("submitted_skill_id");
  CREATE INDEX "bounties_updated_at_idx" ON "bounties" USING btree ("updated_at");
  CREATE INDEX "bounties_created_at_idx" ON "bounties" USING btree ("created_at");
  CREATE INDEX "compat_reports_skill_idx" ON "compat_reports" USING btree ("skill_id");
  CREATE INDEX "compat_reports_skill_version_idx" ON "compat_reports" USING btree ("skill_version_id");
  CREATE INDEX "compat_reports_runner_idx" ON "compat_reports" USING btree ("runner_id");
  CREATE INDEX "compat_reports_anonymous_user_hash_idx" ON "compat_reports" USING btree ("anonymous_user_hash");
  CREATE INDEX "compat_reports_model_name_idx" ON "compat_reports" USING btree ("model_name");
  CREATE INDEX "compat_reports_error_type_idx" ON "compat_reports" USING btree ("error_type");
  CREATE INDEX "compat_reports_suppressed_idx" ON "compat_reports" USING btree ("suppressed");
  CREATE INDEX "compat_reports_updated_at_idx" ON "compat_reports" USING btree ("updated_at");
  CREATE INDEX "compat_reports_created_at_idx" ON "compat_reports" USING btree ("created_at");
  CREATE INDEX "users_sessions_order_idx" ON "users_sessions" USING btree ("_order");
  CREATE INDEX "users_sessions_parent_id_idx" ON "users_sessions" USING btree ("_parent_id");
  CREATE UNIQUE INDEX "users_username_idx" ON "users" USING btree ("username");
  CREATE INDEX "users_account_status_idx" ON "users" USING btree ("account_status");
  CREATE INDEX "users_contribution_score_idx" ON "users" USING btree ("contribution_score");
  CREATE INDEX "users_invited_by_idx" ON "users" USING btree ("invited_by_id");
  CREATE INDEX "users_ip_hash_idx" ON "users" USING btree ("ip_hash");
  CREATE INDEX "users_updated_at_idx" ON "users" USING btree ("updated_at");
  CREATE INDEX "users_created_at_idx" ON "users" USING btree ("created_at");
  CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree ("email");
  CREATE UNIQUE INDEX "invite_codes_code_idx" ON "invite_codes" USING btree ("code");
  CREATE INDEX "invite_codes_inviter_idx" ON "invite_codes" USING btree ("inviter_id");
  CREATE INDEX "invite_codes_used_by_idx" ON "invite_codes" USING btree ("used_by_id");
  CREATE INDEX "invite_codes_updated_at_idx" ON "invite_codes" USING btree ("updated_at");
  CREATE INDEX "invite_codes_created_at_idx" ON "invite_codes" USING btree ("created_at");
  CREATE INDEX "contribution_logs_user_idx" ON "contribution_logs" USING btree ("user_id");
  CREATE INDEX "contribution_logs_actor_idx" ON "contribution_logs" USING btree ("actor_id");
  CREATE UNIQUE INDEX "contribution_logs_idempotency_key_idx" ON "contribution_logs" USING btree ("idempotency_key");
  CREATE INDEX "contribution_logs_related_skill_idx" ON "contribution_logs" USING btree ("related_skill_id");
  CREATE INDEX "contribution_logs_related_bounty_idx" ON "contribution_logs" USING btree ("related_bounty_id");
  CREATE INDEX "contribution_logs_updated_at_idx" ON "contribution_logs" USING btree ("updated_at");
  CREATE INDEX "contribution_logs_created_at_idx" ON "contribution_logs" USING btree ("created_at");
  CREATE UNIQUE INDEX "contribution_rules_action_type_idx" ON "contribution_rules" USING btree ("action_type");
  CREATE INDEX "contribution_rules_updated_at_idx" ON "contribution_rules" USING btree ("updated_at");
  CREATE INDEX "contribution_rules_created_at_idx" ON "contribution_rules" USING btree ("created_at");
  CREATE INDEX "credit_logs_user_idx" ON "credit_logs" USING btree ("user_id");
  CREATE UNIQUE INDEX "credit_logs_idempotency_key_idx" ON "credit_logs" USING btree ("idempotency_key");
  CREATE INDEX "credit_logs_updated_at_idx" ON "credit_logs" USING btree ("updated_at");
  CREATE INDEX "credit_logs_created_at_idx" ON "credit_logs" USING btree ("created_at");
  CREATE UNIQUE INDEX "recharge_codes_code_idx" ON "recharge_codes" USING btree ("code");
  CREATE INDEX "recharge_codes_status_idx" ON "recharge_codes" USING btree ("status");
  CREATE INDEX "recharge_codes_used_by_idx" ON "recharge_codes" USING btree ("used_by_id");
  CREATE INDEX "recharge_codes_updated_at_idx" ON "recharge_codes" USING btree ("updated_at");
  CREATE INDEX "recharge_codes_created_at_idx" ON "recharge_codes" USING btree ("created_at");
  CREATE INDEX "favorites_user_idx" ON "favorites" USING btree ("user_id");
  CREATE INDEX "favorites_skill_idx" ON "favorites" USING btree ("skill_id");
  CREATE INDEX "favorites_updated_at_idx" ON "favorites" USING btree ("updated_at");
  CREATE INDEX "favorites_created_at_idx" ON "favorites" USING btree ("created_at");
  CREATE UNIQUE INDEX "user_skill_idx" ON "favorites" USING btree ("user_id","skill_id");
  CREATE INDEX "runner_clients_user_idx" ON "runner_clients" USING btree ("user_id");
  CREATE UNIQUE INDEX "runner_clients_runner_id_idx" ON "runner_clients" USING btree ("runner_id");
  CREATE INDEX "runner_clients_token_hash_idx" ON "runner_clients" USING btree ("token_hash");
  CREATE INDEX "runner_clients_token_idx" ON "runner_clients" USING btree ("token");
  CREATE INDEX "runner_clients_updated_at_idx" ON "runner_clients" USING btree ("updated_at");
  CREATE INDEX "runner_clients_created_at_idx" ON "runner_clients" USING btree ("created_at");
  CREATE INDEX "device_codes_device_code_idx" ON "device_codes" USING btree ("device_code");
  CREATE INDEX "device_codes_user_code_idx" ON "device_codes" USING btree ("user_code");
  CREATE INDEX "device_codes_user_idx" ON "device_codes" USING btree ("user_id");
  CREATE INDEX "device_codes_runner_client_idx" ON "device_codes" USING btree ("runner_client_id");
  CREATE INDEX "device_codes_ip_hash_idx" ON "device_codes" USING btree ("ip_hash");
  CREATE INDEX "device_codes_updated_at_idx" ON "device_codes" USING btree ("updated_at");
  CREATE INDEX "device_codes_created_at_idx" ON "device_codes" USING btree ("created_at");
  CREATE INDEX "skill_installs_user_idx" ON "skill_installs" USING btree ("user_id");
  CREATE INDEX "skill_installs_skill_idx" ON "skill_installs" USING btree ("skill_id");
  CREATE INDEX "skill_installs_skill_version_idx" ON "skill_installs" USING btree ("skill_version_id");
  CREATE INDEX "skill_installs_runner_idx" ON "skill_installs" USING btree ("runner_id");
  CREATE INDEX "skill_installs_updated_at_idx" ON "skill_installs" USING btree ("updated_at");
  CREATE INDEX "skill_installs_created_at_idx" ON "skill_installs" USING btree ("created_at");
  CREATE UNIQUE INDEX "user_skill_runner_idx" ON "skill_installs" USING btree ("user_id","skill_id","runner_id");
  CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id");
  CREATE INDEX "notifications_read_idx" ON "notifications" USING btree ("read");
  CREATE INDEX "notifications_related_skill_idx" ON "notifications" USING btree ("related_skill_id");
  CREATE INDEX "notifications_related_bounty_idx" ON "notifications" USING btree ("related_bounty_id");
  CREATE INDEX "notifications_updated_at_idx" ON "notifications" USING btree ("updated_at");
  CREATE INDEX "notifications_created_at_idx" ON "notifications" USING btree ("created_at");
  CREATE INDEX "reviews_skill_idx" ON "reviews" USING btree ("skill_id");
  CREATE INDEX "reviews_user_idx" ON "reviews" USING btree ("user_id");
  CREATE INDEX "reviews_updated_at_idx" ON "reviews" USING btree ("updated_at");
  CREATE INDEX "reviews_created_at_idx" ON "reviews" USING btree ("created_at");
  CREATE UNIQUE INDEX "user_skill_type_idx" ON "reviews" USING btree ("user_id","skill_id","type");
  CREATE INDEX "reports_reporter_idx" ON "reports" USING btree ("reporter_id");
  CREATE INDEX "reports_handled_by_idx" ON "reports" USING btree ("handled_by_id");
  CREATE INDEX "reports_updated_at_idx" ON "reports" USING btree ("updated_at");
  CREATE INDEX "reports_created_at_idx" ON "reports" USING btree ("created_at");
  CREATE INDEX "media_updated_at_idx" ON "media" USING btree ("updated_at");
  CREATE INDEX "media_created_at_idx" ON "media" USING btree ("created_at");
  CREATE UNIQUE INDEX "media_filename_idx" ON "media" USING btree ("filename");
  CREATE INDEX "model_price_snapshots_model_idx" ON "model_price_snapshots" USING btree ("model");
  CREATE INDEX "model_price_snapshots_updated_at_idx" ON "model_price_snapshots" USING btree ("updated_at");
  CREATE INDEX "model_price_snapshots_created_at_idx" ON "model_price_snapshots" USING btree ("created_at");
  CREATE INDEX "score_snapshots_skill_idx" ON "score_snapshots" USING btree ("skill_id");
  CREATE INDEX "score_snapshots_updated_at_idx" ON "score_snapshots" USING btree ("updated_at");
  CREATE INDEX "score_snapshots_created_at_idx" ON "score_snapshots" USING btree ("created_at");
  CREATE UNIQUE INDEX "payload_kv_key_idx" ON "payload_kv" USING btree ("key");
  CREATE INDEX "payload_locked_documents_global_slug_idx" ON "payload_locked_documents" USING btree ("global_slug");
  CREATE INDEX "payload_locked_documents_updated_at_idx" ON "payload_locked_documents" USING btree ("updated_at");
  CREATE INDEX "payload_locked_documents_created_at_idx" ON "payload_locked_documents" USING btree ("created_at");
  CREATE INDEX "payload_locked_documents_rels_order_idx" ON "payload_locked_documents_rels" USING btree ("order");
  CREATE INDEX "payload_locked_documents_rels_parent_idx" ON "payload_locked_documents_rels" USING btree ("parent_id");
  CREATE INDEX "payload_locked_documents_rels_path_idx" ON "payload_locked_documents_rels" USING btree ("path");
  CREATE INDEX "payload_locked_documents_rels_skills_id_idx" ON "payload_locked_documents_rels" USING btree ("skills_id");
  CREATE INDEX "payload_locked_documents_rels_skill_versions_id_idx" ON "payload_locked_documents_rels" USING btree ("skill_versions_id");
  CREATE INDEX "payload_locked_documents_rels_skill_artifacts_id_idx" ON "payload_locked_documents_rels" USING btree ("skill_artifacts_id");
  CREATE INDEX "payload_locked_documents_rels_categories_id_idx" ON "payload_locked_documents_rels" USING btree ("categories_id");
  CREATE INDEX "payload_locked_documents_rels_skill_runs_id_idx" ON "payload_locked_documents_rels" USING btree ("skill_runs_id");
  CREATE INDEX "payload_locked_documents_rels_bounties_id_idx" ON "payload_locked_documents_rels" USING btree ("bounties_id");
  CREATE INDEX "payload_locked_documents_rels_compat_reports_id_idx" ON "payload_locked_documents_rels" USING btree ("compat_reports_id");
  CREATE INDEX "payload_locked_documents_rels_users_id_idx" ON "payload_locked_documents_rels" USING btree ("users_id");
  CREATE INDEX "payload_locked_documents_rels_invite_codes_id_idx" ON "payload_locked_documents_rels" USING btree ("invite_codes_id");
  CREATE INDEX "payload_locked_documents_rels_contribution_logs_id_idx" ON "payload_locked_documents_rels" USING btree ("contribution_logs_id");
  CREATE INDEX "payload_locked_documents_rels_contribution_rules_id_idx" ON "payload_locked_documents_rels" USING btree ("contribution_rules_id");
  CREATE INDEX "payload_locked_documents_rels_credit_logs_id_idx" ON "payload_locked_documents_rels" USING btree ("credit_logs_id");
  CREATE INDEX "payload_locked_documents_rels_recharge_codes_id_idx" ON "payload_locked_documents_rels" USING btree ("recharge_codes_id");
  CREATE INDEX "payload_locked_documents_rels_favorites_id_idx" ON "payload_locked_documents_rels" USING btree ("favorites_id");
  CREATE INDEX "payload_locked_documents_rels_runner_clients_id_idx" ON "payload_locked_documents_rels" USING btree ("runner_clients_id");
  CREATE INDEX "payload_locked_documents_rels_device_codes_id_idx" ON "payload_locked_documents_rels" USING btree ("device_codes_id");
  CREATE INDEX "payload_locked_documents_rels_skill_installs_id_idx" ON "payload_locked_documents_rels" USING btree ("skill_installs_id");
  CREATE INDEX "payload_locked_documents_rels_notifications_id_idx" ON "payload_locked_documents_rels" USING btree ("notifications_id");
  CREATE INDEX "payload_locked_documents_rels_reviews_id_idx" ON "payload_locked_documents_rels" USING btree ("reviews_id");
  CREATE INDEX "payload_locked_documents_rels_reports_id_idx" ON "payload_locked_documents_rels" USING btree ("reports_id");
  CREATE INDEX "payload_locked_documents_rels_media_id_idx" ON "payload_locked_documents_rels" USING btree ("media_id");
  CREATE INDEX "payload_locked_documents_rels_model_price_snapshots_id_idx" ON "payload_locked_documents_rels" USING btree ("model_price_snapshots_id");
  CREATE INDEX "payload_locked_documents_rels_score_snapshots_id_idx" ON "payload_locked_documents_rels" USING btree ("score_snapshots_id");
  CREATE INDEX "payload_preferences_key_idx" ON "payload_preferences" USING btree ("key");
  CREATE INDEX "payload_preferences_updated_at_idx" ON "payload_preferences" USING btree ("updated_at");
  CREATE INDEX "payload_preferences_created_at_idx" ON "payload_preferences" USING btree ("created_at");
  CREATE INDEX "payload_preferences_rels_order_idx" ON "payload_preferences_rels" USING btree ("order");
  CREATE INDEX "payload_preferences_rels_parent_idx" ON "payload_preferences_rels" USING btree ("parent_id");
  CREATE INDEX "payload_preferences_rels_path_idx" ON "payload_preferences_rels" USING btree ("path");
  CREATE INDEX "payload_preferences_rels_users_id_idx" ON "payload_preferences_rels" USING btree ("users_id");
  CREATE INDEX "payload_migrations_updated_at_idx" ON "payload_migrations" USING btree ("updated_at");
  CREATE INDEX "payload_migrations_created_at_idx" ON "payload_migrations" USING btree ("created_at");
  CREATE INDEX "site_settings_rels_order_idx" ON "site_settings_rels" USING btree ("order");
  CREATE INDEX "site_settings_rels_parent_idx" ON "site_settings_rels" USING btree ("parent_id");
  CREATE INDEX "site_settings_rels_path_idx" ON "site_settings_rels" USING btree ("path");
  CREATE INDEX "site_settings_rels_skills_id_idx" ON "site_settings_rels" USING btree ("skills_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP TABLE "skills" CASCADE;
  DROP TABLE "skill_versions" CASCADE;
  DROP TABLE "skill_artifacts" CASCADE;
  DROP TABLE "categories" CASCADE;
  DROP TABLE "skill_runs" CASCADE;
  DROP TABLE "bounties" CASCADE;
  DROP TABLE "compat_reports" CASCADE;
  DROP TABLE "users_sessions" CASCADE;
  DROP TABLE "users" CASCADE;
  DROP TABLE "invite_codes" CASCADE;
  DROP TABLE "contribution_logs" CASCADE;
  DROP TABLE "contribution_rules" CASCADE;
  DROP TABLE "credit_logs" CASCADE;
  DROP TABLE "recharge_codes" CASCADE;
  DROP TABLE "favorites" CASCADE;
  DROP TABLE "runner_clients" CASCADE;
  DROP TABLE "device_codes" CASCADE;
  DROP TABLE "skill_installs" CASCADE;
  DROP TABLE "notifications" CASCADE;
  DROP TABLE "reviews" CASCADE;
  DROP TABLE "reports" CASCADE;
  DROP TABLE "media" CASCADE;
  DROP TABLE "model_price_snapshots" CASCADE;
  DROP TABLE "score_snapshots" CASCADE;
  DROP TABLE "payload_kv" CASCADE;
  DROP TABLE "payload_locked_documents" CASCADE;
  DROP TABLE "payload_locked_documents_rels" CASCADE;
  DROP TABLE "payload_preferences" CASCADE;
  DROP TABLE "payload_preferences_rels" CASCADE;
  DROP TABLE "payload_migrations" CASCADE;
  DROP TABLE "site_settings" CASCADE;
  DROP TABLE "site_settings_rels" CASCADE;
  DROP TABLE "economy_settings" CASCADE;
  DROP TYPE "public"."enum_skills_visibility";
  DROP TYPE "public"."enum_skills_status";
  DROP TYPE "public"."enum_skill_versions_status";
  DROP TYPE "public"."enum_skill_artifacts_format";
  DROP TYPE "public"."enum_skill_runs_route_mode";
  DROP TYPE "public"."enum_bounties_reward_type";
  DROP TYPE "public"."enum_bounties_status";
  DROP TYPE "public"."enum_compat_reports_source";
  DROP TYPE "public"."enum_users_role";
  DROP TYPE "public"."enum_users_account_status";
  DROP TYPE "public"."enum_invite_codes_status";
  DROP TYPE "public"."enum_contribution_logs_action_type";
  DROP TYPE "public"."enum_contribution_rules_action_type";
  DROP TYPE "public"."enum_credit_logs_type";
  DROP TYPE "public"."enum_recharge_codes_status";
  DROP TYPE "public"."enum_runner_clients_trusted_level";
  DROP TYPE "public"."enum_device_codes_status";
  DROP TYPE "public"."enum_skill_installs_status";
  DROP TYPE "public"."enum_notifications_type";
  DROP TYPE "public"."enum_reviews_type";
  DROP TYPE "public"."enum_reviews_status";
  DROP TYPE "public"."enum_reports_target_type";
  DROP TYPE "public"."enum_reports_reason";
  DROP TYPE "public"."enum_reports_status";`)
}
