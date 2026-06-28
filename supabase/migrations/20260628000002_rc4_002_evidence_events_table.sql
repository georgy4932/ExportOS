-- =============================================================================
-- ExportOS RC4 — Migration RC4_002: evidence_events audit table
-- =============================================================================
-- Append-only audit log for every evidence lifecycle transition.
-- See RC4_DATABASE_DESIGN.md.
--
-- Immutability is enforced at the privilege level in this migration:
-- exportos_app receives SELECT + INSERT only; UPDATE and DELETE are withheld.
-- An immutability trigger (BEFORE UPDATE OR DELETE → RAISE EXCEPTION) is
-- deferred to RC4_003 per migration sequencing in RC4_DATABASE_DESIGN.md.
-- =============================================================================

BEGIN;

-- =============================================================================
-- TABLE: evidence_events
-- One row per lifecycle transition. Never updated or deleted.
-- =============================================================================

CREATE TABLE evidence_events (
  id                         UUID         NOT NULL DEFAULT gen_random_uuid(),
  evidence_item_id           UUID         NOT NULL,
  shipment_id                UUID         NOT NULL,
  exporter_id                UUID         NOT NULL,
  nxp_reference              TEXT         NOT NULL,
  evidence_type              TEXT         NOT NULL,
  previous_lifecycle_state   TEXT         NOT NULL,
  new_lifecycle_state        TEXT         NOT NULL,
  previous_validation_status TEXT         NOT NULL,
  new_validation_status      TEXT         NOT NULL,
  actor_user_id              UUID,                   -- NULL for system-originated events
  actor_role                 TEXT         NOT NULL,
  event_type                 TEXT         NOT NULL,
  reason                     TEXT,                   -- required for reviewer/admin; optional otherwise
  metadata                   JSONB,                  -- extensible payload; schema defined per use
  created_at                 TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  PRIMARY KEY (id),

  -- FK to evidence_items: no CASCADE DELETE so events survive item archival
  CONSTRAINT fk_evidence_events_item
    FOREIGN KEY (evidence_item_id) REFERENCES evidence_items(id),

  CONSTRAINT evidence_events_actor_role_check
    CHECK (actor_role IN ('exporter', 'reviewer', 'admin', 'system')),

  CONSTRAINT evidence_events_previous_lifecycle_state_check
    CHECK (previous_lifecycle_state IN (
      'missing', 'uploaded', 'pending_review', 'validated', 'rejected', 'superseded'
    )),

  CONSTRAINT evidence_events_new_lifecycle_state_check
    CHECK (new_lifecycle_state IN (
      'missing', 'uploaded', 'pending_review', 'validated', 'rejected', 'superseded'
    )),

  CONSTRAINT evidence_events_previous_validation_status_check
    CHECK (previous_validation_status IN (
      'not_validated', 'pending', 'passed', 'failed', 'not_applicable'
    )),

  CONSTRAINT evidence_events_new_validation_status_check
    CHECK (new_validation_status IN (
      'not_validated', 'pending', 'passed', 'failed', 'not_applicable'
    )),

  CONSTRAINT evidence_events_event_type_check
    CHECK (event_type IN (
      'mark_uploaded', 'resubmit', 'enter_review', 'validate',
      'reject', 'supersede', 'system_seed'
    ))
);

-- =============================================================================
-- INDEXES
-- =============================================================================

-- Primary audit access pattern: all events for a specific evidence item
CREATE INDEX idx_evidence_events_item_id
  ON evidence_events (evidence_item_id, created_at);

-- Shipment-scoped queries (all events for a shipment)
CREATE INDEX idx_evidence_events_shipment_id
  ON evidence_events (shipment_id, created_at);

-- Tenant-scoped queries (all events for an exporter)
CREATE INDEX idx_evidence_events_exporter_id
  ON evidence_events (exporter_id, created_at);

-- nxp_reference lookup
CREATE INDEX idx_evidence_events_nxp_reference
  ON evidence_events (nxp_reference);

-- Actor audit: all actions by a specific user (partial — excludes system events)
CREATE INDEX idx_evidence_events_actor_user_id
  ON evidence_events (actor_user_id, created_at)
  WHERE actor_user_id IS NOT NULL;

-- =============================================================================
-- ROW LEVEL SECURITY
-- =============================================================================

ALTER TABLE evidence_events ENABLE ROW LEVEL SECURITY;

-- Exporters: read their own records only
CREATE POLICY rls_evidence_events_exporter_read ON evidence_events
  FOR SELECT
  USING (exporter_id IN (SELECT current_user_exporter_ids()));

-- =============================================================================
-- PRIVILEGES
-- SELECT + INSERT only. UPDATE and DELETE withheld to enforce append-only.
-- =============================================================================

GRANT SELECT, INSERT ON evidence_events TO exportos_app;

COMMIT;
