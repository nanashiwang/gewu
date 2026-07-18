import * as migration_20260702_173109_p0_hardening_and_recharge from './20260702_173109_p0_hardening_and_recharge';
import * as migration_20260702_180021_margin_reconcile_gate from './20260702_180021_margin_reconcile_gate';
import * as migration_20260702_181548_recharge_code_hash from './20260702_181548_recharge_code_hash';
import * as migration_20260702_184401_skill_run_charged_credits from './20260702_184401_skill_run_charged_credits';
import * as migration_20260703_052000_notification_and_compat_indexes from './20260703_052000_notification_and_compat_indexes';
import * as migration_20260703_060000_user_device_hash from './20260703_060000_user_device_hash';
import * as migration_20260703_063000_skill_submission_key from './20260703_063000_skill_submission_key';
import * as migration_20260703_064500_audit_logs from './20260703_064500_audit_logs';
import * as migration_20260706_003000_registration_email_required from './20260706_003000_registration_email_required';
import * as migration_20260706_020000_deployment_settings from './20260706_020000_deployment_settings';
import * as migration_20260716_120000_gewu_brand from './20260716_120000_gewu_brand';
import * as migration_20260718_120000_relay_backend from './20260718_120000_relay_backend';
import * as migration_20260718_130000_schema_alignment from './20260718_130000_schema_alignment';
import * as migration_20260718_140000_relay_check_hardening from './20260718_140000_relay_check_hardening';

export const migrations = [
  {
    up: migration_20260702_173109_p0_hardening_and_recharge.up,
    down: migration_20260702_173109_p0_hardening_and_recharge.down,
    name: '20260702_173109_p0_hardening_and_recharge',
  },
  {
    up: migration_20260702_180021_margin_reconcile_gate.up,
    down: migration_20260702_180021_margin_reconcile_gate.down,
    name: '20260702_180021_margin_reconcile_gate',
  },
  {
    up: migration_20260702_181548_recharge_code_hash.up,
    down: migration_20260702_181548_recharge_code_hash.down,
    name: '20260702_181548_recharge_code_hash',
  },
  {
    up: migration_20260702_184401_skill_run_charged_credits.up,
    down: migration_20260702_184401_skill_run_charged_credits.down,
    name: '20260702_184401_skill_run_charged_credits',
  },
  {
    up: migration_20260703_052000_notification_and_compat_indexes.up,
    down: migration_20260703_052000_notification_and_compat_indexes.down,
    name: '20260703_052000_notification_and_compat_indexes',
  },
  {
    up: migration_20260703_060000_user_device_hash.up,
    down: migration_20260703_060000_user_device_hash.down,
    name: '20260703_060000_user_device_hash',
  },
  {
    up: migration_20260703_063000_skill_submission_key.up,
    down: migration_20260703_063000_skill_submission_key.down,
    name: '20260703_063000_skill_submission_key',
  },
  {
    up: migration_20260703_064500_audit_logs.up,
    down: migration_20260703_064500_audit_logs.down,
    name: '20260703_064500_audit_logs',
  },
  {
    up: migration_20260706_003000_registration_email_required.up,
    down: migration_20260706_003000_registration_email_required.down,
    name: '20260706_003000_registration_email_required',
  },
  {
    up: migration_20260706_020000_deployment_settings.up,
    down: migration_20260706_020000_deployment_settings.down,
    name: '20260706_020000_deployment_settings',
  },
  {
    up: migration_20260716_120000_gewu_brand.up,
    down: migration_20260716_120000_gewu_brand.down,
    name: '20260716_120000_gewu_brand',
  },
  {
    up: migration_20260718_120000_relay_backend.up,
    down: migration_20260718_120000_relay_backend.down,
    name: '20260718_120000_relay_backend',
  },
  {
    up: migration_20260718_130000_schema_alignment.up,
    down: migration_20260718_130000_schema_alignment.down,
    name: '20260718_130000_schema_alignment',
  },
  {
    up: migration_20260718_140000_relay_check_hardening.up,
    down: migration_20260718_140000_relay_check_hardening.down,
    name: '20260718_140000_relay_check_hardening',
  },
];
