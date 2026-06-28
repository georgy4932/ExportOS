-- =============================================================================
-- ExportOS RC4 — Migration RC4_005: Extend exporter_users role values
-- =============================================================================
-- Decision (RC4_DATABASE_DESIGN.md Open Question 2 — RESOLVED):
--   Extend exporter_users.role to include REVIEWER rather than creating
--   a separate reviewer_users table.
--
-- Current state (confirmed 2026-06-28):
--   • role column is VARCHAR(50) NOT NULL DEFAULT 'MEMBER'
--   • No CHECK constraint exists on role
--   • One existing row: role = 'ADMIN'
--
-- This migration adds a CHECK constraint permitting: MEMBER, ADMIN, REVIEWER.
-- The existing ADMIN row is valid under the new constraint — no data migration
-- needed. No new users are seeded; role assignment to specific users is an
-- operational step outside this migration.
--
-- Role semantics for RC4 middleware:
--   MEMBER   → actorRole = 'exporter'   (standard exporter/operator)
--   REVIEWER → actorRole = 'reviewer'   (can validate/reject evidence)
--   ADMIN    → actorRole = 'admin'      (all transitions + supersede)
-- =============================================================================

BEGIN;

ALTER TABLE exporter_users
  ADD CONSTRAINT exporter_users_role_check
  CHECK (role IN ('MEMBER', 'ADMIN', 'REVIEWER'));

COMMIT;
