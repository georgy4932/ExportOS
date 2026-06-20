-- =============================================================================
-- Migration 0004: local_users — minimal auth table for ExportOS v0.2
--
-- Provides a simple email/password store for local and development use.
-- JWTs are issued on successful login; the JWT sub maps to exporter_users.user_id.
--
-- NOT for production. When real auth is introduced (Supabase Auth, OAuth, etc.),
-- this table and the /auth/login endpoint should be removed or replaced.
-- =============================================================================

CREATE TABLE IF NOT EXISTS local_users (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT        UNIQUE NOT NULL,
  password_hash TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE local_users IS
  'v0.2 development-only auth store. Replace with Supabase Auth when deploying.';
