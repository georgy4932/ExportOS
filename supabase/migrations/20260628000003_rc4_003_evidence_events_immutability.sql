-- =============================================================================
-- ExportOS RC4 — Migration RC4_003: evidence_events immutability trigger
-- =============================================================================
-- Enforces append-only semantics at the trigger level as a second safety layer.
-- The first layer (RC4_002) is privilege-based: exportos_app has no UPDATE
-- or DELETE grant. This trigger catches any attempt by superuser or migration
-- scripts that do hold those privileges.
-- See RC4_DATABASE_DESIGN.md — Constraints section.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION prevent_evidence_events_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'evidence_events is append-only: % operations are not permitted (id=%)',
    TG_OP, OLD.id
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER trg_evidence_events_immutable
  BEFORE UPDATE OR DELETE ON evidence_events
  FOR EACH ROW EXECUTE FUNCTION prevent_evidence_events_mutation();

COMMIT;
