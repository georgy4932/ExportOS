-- =============================================================================
-- ExportOS RC4 — Migration RC4_006: QA test users for role-based E2E testing
-- =============================================================================
-- Adds two synthetic test identities under the existing AKOBO AGRI-EXPORT
-- exporter (no new exporter/company created):
--   qa-member@akoboexports.ng    → exporter_users.role = 'MEMBER'   → actorRole 'exporter'
--   qa-reviewer@akoboexports.ng  → exporter_users.role = 'REVIEWER' → actorRole 'reviewer'
--
-- Password for both: dev-seed-password (same dev-only convention as the
-- existing operator@akoboexports.ng seed user — see 20260620000004_local_auth.sql).
--
-- exporter_users.user_id has a real FK to auth.users(id) (see
-- 20260620000001_initial_schema.sql), while local_users has no FK relationship
-- to auth.users — the two tables are linked only by convention (same literal
-- UUID), matching the existing operator seed pattern. Each test identity
-- therefore needs a row in all three tables: auth.users (FK target only, not
-- read by the login flow), local_users (actually authenticated against by
-- POST /auth/login), and exporter_users (resolves exporterId + role).
--
-- The qa- prefix is deliberate: these are test fixtures, not real staff
-- accounts, and should be unambiguous as such in any future audit of
-- local_users/exporter_users.
--
-- No schema changes. No new exporter. No changes to auth logic or app code.
-- All inserts are idempotent (ON CONFLICT DO NOTHING), safe to re-run.
-- =============================================================================

BEGIN;

-- =============================================================================
-- QA MEMBER — qa-member@akoboexports.ng / dev-seed-password
-- UUID: a0b00000-0000-0000-0000-000000000002
-- =============================================================================

INSERT INTO auth.users (
  id, instance_id, aud, role, email,
  encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at,
  confirmation_token, recovery_token,
  email_change_token_new, email_change
) VALUES (
  'a0b00000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000000',
  'authenticated',
  'authenticated',
  'qa-member@akoboexports.ng',
  crypt('dev-seed-password', gen_salt('bf')),
  NOW(),
  '{"provider":"email","providers":["email"]}',
  '{}',
  NOW(), NOW(),
  '', '', '', ''
) ON CONFLICT (id) DO NOTHING;

INSERT INTO local_users (id, email, password_hash) VALUES (
  'a0b00000-0000-0000-0000-000000000002',
  'qa-member@akoboexports.ng',
  '$2a$10$UmcD5HqyRunUbh9rPCKMu.MlrbTWQ0l9H1rDmlbNODKikuFP1dVXK'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO exporter_users (
  exporter_id, user_id, role
) VALUES (
  'b0b00001-0000-0000-0000-000000000001',
  'a0b00000-0000-0000-0000-000000000002',
  'MEMBER'
) ON CONFLICT (exporter_id, user_id) DO NOTHING;

-- =============================================================================
-- QA REVIEWER — qa-reviewer@akoboexports.ng / dev-seed-password
-- UUID: a0b00000-0000-0000-0000-000000000003
-- =============================================================================

INSERT INTO auth.users (
  id, instance_id, aud, role, email,
  encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at,
  confirmation_token, recovery_token,
  email_change_token_new, email_change
) VALUES (
  'a0b00000-0000-0000-0000-000000000003',
  '00000000-0000-0000-0000-000000000000',
  'authenticated',
  'authenticated',
  'qa-reviewer@akoboexports.ng',
  crypt('dev-seed-password', gen_salt('bf')),
  NOW(),
  '{"provider":"email","providers":["email"]}',
  '{}',
  NOW(), NOW(),
  '', '', '', ''
) ON CONFLICT (id) DO NOTHING;

INSERT INTO local_users (id, email, password_hash) VALUES (
  'a0b00000-0000-0000-0000-000000000003',
  'qa-reviewer@akoboexports.ng',
  '$2a$10$cL6bkpunPE7TJhiAhgoqregqOgBG0y3oJDaWB/Qzxbhsh5xTeOwxS'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO exporter_users (
  exporter_id, user_id, role
) VALUES (
  'b0b00001-0000-0000-0000-000000000001',
  'a0b00000-0000-0000-0000-000000000003',
  'REVIEWER'
) ON CONFLICT (exporter_id, user_id) DO NOTHING;

COMMIT;
