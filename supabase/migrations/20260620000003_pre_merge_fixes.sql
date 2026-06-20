-- =============================================================================
-- ExportOS v0.2 — Migration 0003: Pre-Merge Fixes
-- =============================================================================
-- Fix 1: Tests moved to supabase/tests/schema_foundation.sql.
--        No SAVEPOINT / ROLLBACK TO SAVEPOINT inside DO blocks in any migration.
-- Fix 2: payment_receipts.charges_deducted semantics corrected.
--        Add amount_variance for signed net direction.
-- Fix 3: Late repatriation history preserved on compliance_records.
--        was_repatriated_late and completed_after_deadline_at are write-once.
-- Fix 4: Counterparty registered_address required before contract can go ACTIVE.
-- Fix 5: BankEvidencePack sealing enforces ComplianceRecord checklist.
-- =============================================================================

BEGIN;

-- =============================================================================
-- FIX 2: payment_receipts amount semantics
--
-- Original: charges_deducted = instructed_amount − credited_amount
--   With the credited_amount <= instructed_amount constraint removed (0002),
--   this can now be negative for overpayments — misleading for a field named
--   "charges_deducted".
--
-- Replacement:
--   charges_deducted = GREATEST(instructed_amount − credited_amount, 0)
--     Always ≥ 0. Represents bank fees/charges deducted from the instructed
--     amount. Zero when credited ≥ instructed (no deduction occurred).
--
--   amount_variance  = credited_amount − instructed_amount
--     Signed. Positive = overpayment. Negative = under-credit or charge.
--     The sign immediately shows the net direction of the discrepancy.
-- =============================================================================

ALTER TABLE payment_receipts DROP COLUMN charges_deducted;

ALTER TABLE payment_receipts
  ADD COLUMN charges_deducted DECIMAL(18,2) GENERATED ALWAYS AS
    (GREATEST(instructed_amount - credited_amount, 0)) STORED,
  ADD COLUMN amount_variance  DECIMAL(18,2) GENERATED ALWAYS AS
    (credited_amount - instructed_amount) STORED;

-- =============================================================================
-- FIX 3: Late repatriation history on compliance_records
--
-- Problem: _sync_compliance_proceeds (migration 0002) overwrites
--   repatriation_status = 'COMPLETE' without recording whether completion
--   occurred after the deadline. Once COMPLETE, the late fact is lost.
--
-- Fix:
--   was_repatriated_late        BOOLEAN    — set TRUE when proceeds first
--     reach 100% after the deadline; write-once, never reset to FALSE.
--   completed_after_deadline_at TIMESTAMPTZ — timestamp of that first late
--     completion; write-once, never overwritten.
--
-- _sync_compliance_proceeds is replaced below to maintain these fields.
-- =============================================================================

ALTER TABLE compliance_records
  ADD COLUMN was_repatriated_late        BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN completed_after_deadline_at TIMESTAMPTZ;

-- Replace _sync_compliance_proceeds from migration 0002.
-- The signature and contract with the caller (sync_allocation_side_effects)
-- are unchanged; only the UPDATE logic is extended.
CREATE OR REPLACE FUNCTION _sync_compliance_proceeds(p_shipment_id UUID)
RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
  v_proceeds_received     DECIMAL(18,2);
  v_proceeds_required     DECIMAL(18,2);
  v_repatriation_deadline DATE;
  v_is_late               BOOLEAN;
  v_new_repatriation      repatriation_status;
  v_new_shipment_status   shipment_status;
BEGIN
  SELECT COALESCE(SUM(allocated_amount), 0)
    INTO v_proceeds_received
    FROM payment_allocations
   WHERE shipment_id = p_shipment_id;

  SELECT proceeds_required, repatriation_deadline
    INTO v_proceeds_required, v_repatriation_deadline
    FROM compliance_records
   WHERE shipment_id = p_shipment_id;

  -- No compliance record yet (B/L not yet inserted); nothing to update.
  IF NOT FOUND THEN
    RETURN;
  END IF;

  v_is_late := CURRENT_DATE > v_repatriation_deadline;

  IF v_proceeds_received >= v_proceeds_required THEN
    v_new_repatriation := 'COMPLETE';
  ELSIF v_is_late THEN
    v_new_repatriation := 'OVERDUE';
  ELSIF v_proceeds_received > 0 THEN
    v_new_repatriation := 'PARTIAL';
  ELSE
    v_new_repatriation := 'NOT_DUE';
  END IF;

  UPDATE compliance_records
     SET proceeds_received           = v_proceeds_received,
         repatriation_status         = v_new_repatriation,
         -- was_repatriated_late is write-once: OR with current value so TRUE
         -- is never reset, even if allocations are later deleted.
         was_repatriated_late        = was_repatriated_late
                                       OR (v_new_repatriation = 'COMPLETE' AND v_is_late),
         -- completed_after_deadline_at is write-once: stamp only the first
         -- time we reach COMPLETE after the deadline; never overwrite.
         completed_after_deadline_at = CASE
           WHEN completed_after_deadline_at IS NULL
                AND v_new_repatriation = 'COMPLETE'
                AND v_is_late
           THEN NOW()
           ELSE completed_after_deadline_at
         END,
         updated_at                  = NOW()
   WHERE shipment_id = p_shipment_id;

  -- Mirror completion state onto shipments.status.
  -- Only update departed shipments; do not touch PENDING or CANCELLED.
  IF v_proceeds_received >= v_proceeds_required THEN
    v_new_shipment_status := 'PROCEEDS_COMPLETE';
  ELSIF v_proceeds_received > 0 THEN
    v_new_shipment_status := 'PROCEEDS_PARTIAL';
  ELSE
    RETURN;
  END IF;

  UPDATE shipments
     SET status     = v_new_shipment_status,
         updated_at = NOW()
   WHERE id = p_shipment_id
     AND status IN ('DEPARTED', 'ARRIVED', 'PROCEEDS_PARTIAL', 'PROCEEDS_COMPLETE');
END;
$$;

-- =============================================================================
-- FIX 4: Counterparty completeness for ACTIVE contracts
--
-- A counterparty with no registered_address cannot be used in an NXP form
-- submission, bank evidence pack, or AML/KYC audit. Contracts must not be
-- set ACTIVE until the counterparty address is on record.
--
-- Trigger fires BEFORE INSERT OR UPDATE on export_contracts.
-- Only checked when NEW.status = 'ACTIVE'; DRAFT/CLOSED/etc. are unrestricted.
-- Counterparty record is checked at the time the contract is activated.
-- =============================================================================

CREATE OR REPLACE FUNCTION enforce_counterparty_completeness()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  v_registered_address TEXT;
BEGIN
  IF NEW.status = 'ACTIVE' THEN
    SELECT registered_address
      INTO v_registered_address
      FROM counterparties
     WHERE id = NEW.counterparty_id;

    IF v_registered_address IS NULL OR trim(v_registered_address) = '' THEN
      RAISE EXCEPTION
        'Cannot set export_contract status to ACTIVE: counterparty (id=%) '
        'has no registered_address. Update the counterparty record first.',
        NEW.counterparty_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_contract_counterparty_completeness
  BEFORE INSERT OR UPDATE ON export_contracts
  FOR EACH ROW EXECUTE FUNCTION enforce_counterparty_completeness();

-- =============================================================================
-- FIX 5: BankEvidencePack sealing preconditions
--
-- The existing trg_bank_evidence_pack_sealed (migration 0001) blocks mutation
-- of an already-sealed pack. This new trigger enforces the preconditions that
-- must be true BEFORE sealing is permitted.
--
-- Fires BEFORE UPDATE on bank_evidence_packs.
-- Only active when transitioning sealed FALSE → TRUE.
-- Trigger name begins with 'trg_pack_' which sorts after
-- 'trg_bank_evidence_pack_sealed' alphabetically, so the existing
-- already-sealed guard fires first — correct ordering.
--
-- Required preconditions (from spec §4 BankEvidencePack sealing):
--   compliance_records.nxp_approved             = TRUE
--   compliance_records.cci_obtained             = TRUE
--   compliance_records.bl_uploaded              = TRUE
--   compliance_records.payment_evidence_uploaded = TRUE
--   compliance_records.credit_advice_confirmed  = TRUE
-- =============================================================================

CREATE OR REPLACE FUNCTION enforce_pack_sealing_preconditions()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  v_cr      compliance_records%ROWTYPE;
  v_missing TEXT[] := ARRAY[]::TEXT[];
BEGIN
  -- Only enforce on the FALSE → TRUE transition
  IF NOT (OLD.sealed = FALSE AND NEW.sealed = TRUE) THEN
    RETURN NEW;
  END IF;

  SELECT *
    INTO v_cr
    FROM compliance_records
   WHERE shipment_id = NEW.shipment_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Cannot seal BankEvidencePack: no ComplianceRecord exists for shipment_id %.',
      NEW.shipment_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_cr.nxp_approved              IS NOT TRUE THEN v_missing := v_missing || 'nxp_approved';              END IF;
  IF v_cr.cci_obtained              IS NOT TRUE THEN v_missing := v_missing || 'cci_obtained';              END IF;
  IF v_cr.bl_uploaded               IS NOT TRUE THEN v_missing := v_missing || 'bl_uploaded';               END IF;
  IF v_cr.payment_evidence_uploaded IS NOT TRUE THEN v_missing := v_missing || 'payment_evidence_uploaded'; END IF;
  IF v_cr.credit_advice_confirmed   IS NOT TRUE THEN v_missing := v_missing || 'credit_advice_confirmed';   END IF;

  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION
      'Cannot seal BankEvidencePack: compliance checklist incomplete — missing: [%]. '
      'Update the ComplianceRecord and retry.',
      array_to_string(v_missing, ', ')
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_pack_sealing_preconditions
  BEFORE UPDATE ON bank_evidence_packs
  FOR EACH ROW EXECUTE FUNCTION enforce_pack_sealing_preconditions();

-- =============================================================================
-- STRUCTURAL VERIFICATION
-- Catalog-only DO blocks. No data manipulation. No SAVEPOINTs.
-- Any ASSERT failure aborts the migration transaction.
-- Behavioral tests live in supabase/tests/schema_foundation.sql.
-- =============================================================================

DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'payment_receipts'
       AND column_name = 'charges_deducted'
  ), 'FAIL: charges_deducted column missing on payment_receipts';

  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'payment_receipts'
       AND column_name = 'amount_variance'
  ), 'FAIL: amount_variance column missing on payment_receipts';

  RAISE NOTICE 'PASS [3.2]: payment_receipts has charges_deducted (clamped ≥0) and amount_variance (signed)';
END;
$$;

DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'compliance_records'
       AND column_name = 'was_repatriated_late'
  ), 'FAIL: was_repatriated_late missing on compliance_records';

  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'compliance_records'
       AND column_name = 'completed_after_deadline_at'
  ), 'FAIL: completed_after_deadline_at missing on compliance_records';

  RAISE NOTICE 'PASS [3.3]: late repatriation history columns exist on compliance_records';
END;
$$;

DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relname = 'export_contracts'
       AND t.tgname  = 'trg_contract_counterparty_completeness'
  ), 'FAIL: trg_contract_counterparty_completeness not found on export_contracts';

  ASSERT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'enforce_counterparty_completeness'
  ), 'FAIL: enforce_counterparty_completeness function not found';

  RAISE NOTICE 'PASS [3.4]: counterparty completeness trigger wired to export_contracts';
END;
$$;

DO $$
DECLARE
  v_src TEXT;
BEGIN
  ASSERT EXISTS (
    SELECT 1
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relname = 'bank_evidence_packs'
       AND t.tgname  = 'trg_pack_sealing_preconditions'
  ), 'FAIL: trg_pack_sealing_preconditions not found on bank_evidence_packs';

  SELECT prosrc INTO v_src
    FROM pg_proc WHERE proname = 'enforce_pack_sealing_preconditions';

  ASSERT v_src IS NOT NULL, 'FAIL: enforce_pack_sealing_preconditions function not found';

  -- Verify all five required checklist fields are named in the function body
  ASSERT position('nxp_approved'              IN v_src) > 0, 'FAIL: nxp_approved not checked in sealing function';
  ASSERT position('cci_obtained'              IN v_src) > 0, 'FAIL: cci_obtained not checked in sealing function';
  ASSERT position('bl_uploaded'               IN v_src) > 0, 'FAIL: bl_uploaded not checked in sealing function';
  ASSERT position('payment_evidence_uploaded' IN v_src) > 0, 'FAIL: payment_evidence_uploaded not checked in sealing function';
  ASSERT position('credit_advice_confirmed'   IN v_src) > 0, 'FAIL: credit_advice_confirmed not checked in sealing function';

  RAISE NOTICE 'PASS [3.5]: pack sealing preconditions trigger and function cover all 5 checklist fields';
END;
$$;

COMMIT;
