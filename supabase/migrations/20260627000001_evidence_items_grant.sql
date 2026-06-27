-- =============================================================================
-- ExportOS — Migration 0009: Grant evidence_items privileges to exportos_app
-- =============================================================================
-- Problem: evidence_items was created in migration 0008 after the one-time
-- broad role grant (GRANT ALL ON ALL TABLES) was applied to exportos_app.
-- That statement only covers tables existing at the time it ran, so the new
-- table was not included.
--
-- Effect without this migration: PATCH mark_uploaded reaches the backend
-- (authentication passes), but the first DB query —
--   SELECT * FROM evidence_items ... FOR UPDATE
-- — fails with "permission denied for table evidence_items" because
-- SELECT FOR UPDATE requires UPDATE privilege, which was never granted.
--
-- Minimum required privileges:
--   SELECT — read endpoints (GET /export-cases/:nxp/evidence[/:type])
--   UPDATE — mark_uploaded write path (SELECT ... FOR UPDATE + UPDATE row)
--   INSERT — seed_evidence_items() trigger fires as exportos_app when a
--            compliance_record is created; future seeding paths may also INSERT
--   DELETE — intentionally not granted; evidence items are never hard-deleted
-- =============================================================================

BEGIN;

GRANT SELECT, INSERT, UPDATE ON evidence_items TO exportos_app;

COMMIT;
