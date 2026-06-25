-- =============================================================================
-- ExportOS v0.2 — Migration 0008: Evidence Items
-- =============================================================================
-- Implements the Evidence Domain per docs/rfc-evidence-domain.md.
--
-- Design decisions from the RFC:
--   • Database FK is shipment_id (the regulatory unit; no export_cases table
--     exists — shipments is the equivalent).
--   • nxp_reference is denormalised for API exposure; do not join on it.
--   • exporter_id included for RLS (same pattern as all other tenant tables).
--   • evidence_type is TEXT + CHECK to avoid clashing with the existing
--     evidence_type ENUM (payment message types in payment_evidence table).
--   • lifecycle_state and validation_status are TEXT + CHECK (not new ENUMs).
--   • System-derived types (shipment_record, compliance_summary) are seeded
--     directly to lifecycle_state='uploaded', validation_status='not_applicable'.
--   • Seeding fires AFTER INSERT on compliance_records, extending the existing
--     B/L → compliance_record chain: B/L INSERT → compliance_record → evidence_items.
-- =============================================================================

BEGIN;

-- =============================================================================
-- TABLE: evidence_items
-- One row per (shipment_id, evidence_type). Created at compliance record birth;
-- never hard-deleted for required_for_compliance rows.
-- =============================================================================

CREATE TABLE evidence_items (
  id                      UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id             UUID         NOT NULL REFERENCES shipments(id),
  exporter_id             UUID         NOT NULL REFERENCES exporters(id),
  nxp_reference           TEXT         NOT NULL,  -- denormalised; do not join on this field
  evidence_type           TEXT         NOT NULL
    CHECK (evidence_type IN (
      'nxp_approval',
      'bill_of_lading',
      'cci_document',
      'payment_evidence',
      'credit_advice',
      'shipment_record',
      'compliance_summary'
    )),
  evidence_code           TEXT         NOT NULL,
  lifecycle_state         TEXT         NOT NULL DEFAULT 'missing'
    CHECK (lifecycle_state IN (
      'missing',
      'uploaded',
      'under_review',
      'validated',
      'rejected'
    )),
  validation_status       TEXT         NOT NULL DEFAULT 'not_validated'
    CHECK (validation_status IN (
      'not_validated',
      'pending',
      'passed',
      'failed',
      'not_applicable'
    )),
  required_for_compliance BOOLEAN      NOT NULL DEFAULT TRUE,
  uploaded_at             TIMESTAMPTZ,
  last_checked_at         TIMESTAMPTZ,
  source_system           TEXT         NOT NULL DEFAULT 'user'
    CHECK (source_system IN ('user', 'system')),
  metadata_json           JSONB,
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  UNIQUE (shipment_id, evidence_type)
);

CREATE INDEX idx_evidence_items_shipment_id     ON evidence_items (shipment_id);
CREATE INDEX idx_evidence_items_exporter_id     ON evidence_items (exporter_id);
CREATE INDEX idx_evidence_items_lifecycle_state ON evidence_items (lifecycle_state);

-- =============================================================================
-- TRIGGER: updated_at
-- =============================================================================

CREATE TRIGGER trg_evidence_items_updated_at
  BEFORE UPDATE ON evidence_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- INVARIANT: evidence_type is immutable after creation
-- (RFC §6, invariant 2)
-- =============================================================================

CREATE OR REPLACE FUNCTION prevent_evidence_type_change()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.evidence_type IS DISTINCT FROM NEW.evidence_type THEN
    RAISE EXCEPTION
      'evidence_items.evidence_type is immutable after creation '
      '(current type=%, shipment_id=%)',
      OLD.evidence_type, OLD.shipment_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_evidence_type_immutable
  BEFORE UPDATE ON evidence_items
  FOR EACH ROW EXECUTE FUNCTION prevent_evidence_type_change();

-- =============================================================================
-- INVARIANT: validation_status cannot be 'passed' when lifecycle_state is 'missing'
-- (RFC §6, invariant 3)
-- =============================================================================

CREATE OR REPLACE FUNCTION check_evidence_state_consistency()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.validation_status = 'passed' AND NEW.lifecycle_state = 'missing' THEN
    RAISE EXCEPTION
      'validation_status cannot be ''passed'' when lifecycle_state is ''missing'' '
      '(evidence_type=%, shipment_id=%)',
      NEW.evidence_type, NEW.shipment_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_evidence_state_consistency
  BEFORE INSERT OR UPDATE ON evidence_items
  FOR EACH ROW EXECUTE FUNCTION check_evidence_state_consistency();

-- =============================================================================
-- SEEDING: seed all 7 evidence items when a compliance_record is created.
-- Fires AFTER INSERT on compliance_records, which itself fires after B/L INSERT.
-- Full chain: bills_of_lading INSERT
--   → trg_bl_auto_compliance_record (AFTER) creates compliance_record
--   → trg_compliance_record_seeds_evidence (AFTER) seeds evidence_items.
--
-- System-derived types (shipment_record, compliance_summary) are immediately
-- advanced to 'uploaded' + 'not_applicable' because their source is confirmed
-- at the moment the compliance record exists.
--
-- ON CONFLICT DO NOTHING makes the function idempotent if called more than once.
-- =============================================================================

CREATE OR REPLACE FUNCTION seed_evidence_items()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  v_nxp_reference TEXT;
  v_exporter_id   UUID;
BEGIN
  SELECT s.nxp_reference, s.exporter_id
    INTO v_nxp_reference, v_exporter_id
    FROM shipments s
   WHERE s.id = NEW.shipment_id;

  INSERT INTO evidence_items
    (shipment_id, exporter_id, nxp_reference,
     evidence_type, evidence_code,
     required_for_compliance, source_system,
     lifecycle_state, validation_status)
  VALUES
    (NEW.shipment_id, v_exporter_id, v_nxp_reference, 'nxp_approval',       'NXP', TRUE,  'user',   'missing',  'not_validated'),
    (NEW.shipment_id, v_exporter_id, v_nxp_reference, 'bill_of_lading',     'BL',  TRUE,  'user',   'missing',  'not_validated'),
    (NEW.shipment_id, v_exporter_id, v_nxp_reference, 'cci_document',       'CCI', TRUE,  'user',   'missing',  'not_validated'),
    (NEW.shipment_id, v_exporter_id, v_nxp_reference, 'payment_evidence',   'EVD', TRUE,  'user',   'missing',  'not_validated'),
    (NEW.shipment_id, v_exporter_id, v_nxp_reference, 'credit_advice',      'ADV', TRUE,  'user',   'missing',  'not_validated'),
    (NEW.shipment_id, v_exporter_id, v_nxp_reference, 'shipment_record',    'SHP', FALSE, 'system', 'uploaded', 'not_applicable'),
    (NEW.shipment_id, v_exporter_id, v_nxp_reference, 'compliance_summary', 'CMP', FALSE, 'system', 'uploaded', 'not_applicable')
  ON CONFLICT (shipment_id, evidence_type) DO NOTHING;

  UPDATE evidence_items
     SET uploaded_at = NOW()
   WHERE shipment_id = NEW.shipment_id
     AND source_system = 'system'
     AND uploaded_at IS NULL;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_compliance_record_seeds_evidence
  AFTER INSERT ON compliance_records
  FOR EACH ROW EXECUTE FUNCTION seed_evidence_items();

-- =============================================================================
-- ROW LEVEL SECURITY
-- Same pattern as all other tenant-scoped tables.
-- =============================================================================

ALTER TABLE evidence_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY rls_evidence_items ON evidence_items
  FOR ALL
  USING     (exporter_id IN (SELECT current_user_exporter_ids()))
  WITH CHECK (exporter_id IN (SELECT current_user_exporter_ids()));

COMMIT;
