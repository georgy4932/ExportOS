-- =============================================================================
-- ExportOS RC4 — Migration RC4_004: Backfill system_seed events
-- =============================================================================
-- Creates one system_seed event per existing evidence_items row so the
-- audit trail is complete from the point of RC4 migration forward.
-- See RC4_DATABASE_DESIGN.md — Backfill Strategy section.
--
-- NULL handling: previous_lifecycle_state and previous_validation_status are
-- both NOT NULL (confirmed RC4_002 schema). Compliant representation chosen:
--
--   previous_lifecycle_state  = 'missing'        (conceptual origin of all items)
--   previous_validation_status = 'not_validated'  (conceptual origin of all items)
--
-- For items already 'uploaded': records missing → uploaded, attributed to
-- system. Accurate — the upload occurred before event tracking existed.
-- For items still 'missing': records missing → missing, establishing the
-- baseline state at backfill time.
--
-- created_at is set to evidence_items.created_at to preserve audit accuracy;
-- the DEFAULT NOW() is overridden explicitly.
--
-- Idempotency: WHERE NOT EXISTS guard prevents duplicate system_seed events
-- for the same evidence_item_id if this migration is ever re-applied.
-- =============================================================================

BEGIN;

INSERT INTO evidence_events (
  evidence_item_id,
  shipment_id,
  exporter_id,
  nxp_reference,
  evidence_type,
  previous_lifecycle_state,
  new_lifecycle_state,
  previous_validation_status,
  new_validation_status,
  actor_user_id,
  actor_role,
  event_type,
  reason,
  metadata,
  created_at
)
SELECT
  ei.id,
  ei.shipment_id,
  ei.exporter_id,
  ei.nxp_reference,
  ei.evidence_type,
  'missing',                          -- previous: conceptual origin (see header note)
  ei.lifecycle_state,                 -- new: actual state at backfill time
  'not_validated',                    -- previous: conceptual origin (see header note)
  ei.validation_status,               -- new: actual status at backfill time
  NULL,                               -- actor_user_id: NULL for system-originated events
  'system',
  'system_seed',
  'RC4 evidence event backfill',
  jsonb_build_object(
    'source',     'rc4_backfill',
    'migration',  'RC4_004',
    'note',       'Backfilled at RC4 migration — no prior event history exists for this item'
  ),
  ei.created_at                       -- preserve item creation timestamp for audit accuracy
FROM evidence_items ei
WHERE NOT EXISTS (
  SELECT 1
  FROM evidence_events ee
  WHERE ee.evidence_item_id = ei.id
    AND ee.event_type = 'system_seed'
);

COMMIT;
