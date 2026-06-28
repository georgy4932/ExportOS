-- =============================================================================
-- ExportOS RC4 — Migration RC4_001: Normalize evidence lifecycle states
-- =============================================================================
-- Decisions encoded (see RC4_DATABASE_DESIGN.md Open Question 1 — RESOLVED):
--   • Rename under_review → pending_review (zero rows currently use under_review)
--   • Add superseded to the allowed value set
--   • Final allowed set: missing, uploaded, pending_review, validated,
--                        rejected, superseded
--
-- Does NOT create evidence_events (RC4_002).
-- Does NOT change reviewer role storage (RC4_005).
-- =============================================================================

BEGIN;

-- Step 1: Convert any existing under_review rows to pending_review.
-- Verified zero rows on 2026-06-28; this guard ensures idempotency if the
-- migration is ever replayed or if rows were written between deploy steps.
UPDATE evidence_items
   SET lifecycle_state = 'pending_review'
 WHERE lifecycle_state = 'under_review';

-- Step 2: Drop the old inline CHECK constraint (auto-named by migration 0008).
ALTER TABLE evidence_items
  DROP CONSTRAINT evidence_items_lifecycle_state_check;

-- Step 3: Add the replacement constraint with all RC4 lifecycle states.
ALTER TABLE evidence_items
  ADD CONSTRAINT evidence_items_lifecycle_state_check
  CHECK (lifecycle_state IN (
    'missing',
    'uploaded',
    'pending_review',
    'validated',
    'rejected',
    'superseded'
  ));

COMMIT;
