-- =============================================================================
-- Migration 0005: audit_events — append-only audit trail for write operations
--
-- Records who did what to which entity, with a full JSONB snapshot of the
-- row state at the time of the action. Rows are immutable: UPDATE and DELETE
-- are blocked by triggers.
--
-- exporter_id and actor_user_id are always server-derived (from the JWT and
-- exporter_users mapping). They are never accepted from client input.
-- =============================================================================

CREATE TABLE audit_events (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  exporter_id    UUID        NOT NULL REFERENCES exporters(id),
  actor_user_id  UUID        NOT NULL REFERENCES auth.users(id),
  entity_type    TEXT        NOT NULL,  -- e.g. 'export_contract'
  entity_id      UUID        NOT NULL,  -- FK-by-convention to the named entity
  action         TEXT        NOT NULL,  -- 'CREATE' | 'UPDATE' | 'DELETE'
  event_data     JSONB       NOT NULL,  -- full row snapshot at time of action
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_events_exporter_id ON audit_events (exporter_id);
CREATE INDEX idx_audit_events_entity      ON audit_events (entity_type, entity_id);
CREATE INDEX idx_audit_events_actor       ON audit_events (actor_user_id);
CREATE INDEX idx_audit_events_created_at  ON audit_events (created_at DESC);

-- Enforce append-only: raise an exception on any UPDATE or DELETE attempt.
CREATE OR REPLACE FUNCTION trg_audit_events_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events rows are immutable — UPDATE and DELETE are not permitted';
END;
$$;

CREATE TRIGGER trg_audit_events_no_update
  BEFORE UPDATE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION trg_audit_events_immutable();

CREATE TRIGGER trg_audit_events_no_delete
  BEFORE DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION trg_audit_events_immutable();

COMMENT ON TABLE audit_events IS
  'Append-only audit trail for all write operations. Rows cannot be updated or deleted.';
