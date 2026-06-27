-- =============================================================================
-- ExportOS — Migration 0010: Backfill evidence_items for existing compliance_records
-- =============================================================================
-- Problem: Migration 0008 (20260625000001_evidence_items.sql) added the
-- evidence_items table and the seed_evidence_items() trigger, which fires
-- AFTER INSERT ON compliance_records. The production DB already had
-- compliance_records from the initial seed; AFTER INSERT triggers do not fire
-- retroactively, so evidence_items is empty for all seeded shipments.
--
-- Effect without this migration: markEvidenceUploaded finds the shipment
-- (nxp_reference → shipments lookup passes) but finds no evidence_items row,
-- returning NOT_FOUND → "Export case or evidence item not found" toast.
--
-- This migration replicates the seed_evidence_items() INSERT logic for every
-- compliance_record that has no corresponding evidence_items rows.
-- ON CONFLICT DO NOTHING makes it safe to run more than once.
-- =============================================================================

BEGIN;

INSERT INTO evidence_items
  (shipment_id, exporter_id, nxp_reference,
   evidence_type, evidence_code,
   required_for_compliance, source_system,
   lifecycle_state, validation_status)
SELECT
  cr.shipment_id,
  s.exporter_id,
  s.nxp_reference,
  v.evidence_type,
  v.evidence_code,
  v.required_for_compliance::boolean,
  v.source_system,
  v.lifecycle_state,
  v.validation_status
FROM compliance_records cr
JOIN shipments s ON s.id = cr.shipment_id
CROSS JOIN (VALUES
  ('nxp_approval',      'NXP', 'true',  'user',   'missing',  'not_validated'),
  ('bill_of_lading',    'BL',  'true',  'user',   'missing',  'not_validated'),
  ('cci_document',      'CCI', 'true',  'user',   'missing',  'not_validated'),
  ('payment_evidence',  'EVD', 'true',  'user',   'missing',  'not_validated'),
  ('credit_advice',     'ADV', 'true',  'user',   'missing',  'not_validated'),
  ('shipment_record',   'SHP', 'false', 'system', 'uploaded', 'not_applicable'),
  ('compliance_summary','CMP', 'false', 'system', 'uploaded', 'not_applicable')
) AS v(evidence_type, evidence_code, required_for_compliance, source_system, lifecycle_state, validation_status)
ON CONFLICT (shipment_id, evidence_type) DO NOTHING;

-- Set uploaded_at for system-derived types (mirrors what seed_evidence_items()
-- does immediately after the INSERT in the trigger body).
UPDATE evidence_items
   SET uploaded_at = NOW()
 WHERE source_system = 'system'
   AND uploaded_at IS NULL;

COMMIT;
