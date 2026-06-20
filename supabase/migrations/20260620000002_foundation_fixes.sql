-- =============================================================================
-- ExportOS v0.2 — Migration 0002: Foundation Fixes
-- Applies 6 corrections to migration 0001 before production deployment.
-- =============================================================================
-- Fix 1: Add missing BANK_CREDIT_ADVICE fields to payment_evidence
-- Fix 2: Remove strict credited <= instructed constraint; add mismatch trigger
-- Fix 3: Add WITH CHECK to all FOR ALL RLS policies
-- Fix 4: Auto-create ComplianceRecord on BillOfLading INSERT
-- Fix 5: Allocation side-effect trigger (receipt status, compliance proceeds)
-- Fix 6: SQL verification blocks
-- =============================================================================

BEGIN;

-- =============================================================================
-- FIX 1: Add BANK_CREDIT_ADVICE fields to payment_evidence
-- BANK_CREDIT_ADVICE evidence must carry the actual domiciliary account credit
-- details; without these, the type is indistinguishable from MT103 as evidence.
-- All six new fields are immutable after creation (trigger updated below).
-- =============================================================================

ALTER TABLE payment_evidence
  ADD COLUMN credited_amount   DECIMAL(18,2) CHECK (credited_amount > 0),
  ADD COLUMN credited_currency CHAR(3),
  ADD COLUMN credit_date       DATE,
  ADD COLUMN bank_ref          VARCHAR(200),
  ADD COLUMN payer_account     VARCHAR(200),
  ADD COLUMN payer_name        VARCHAR(300);

-- Rebuild the immutability guard to cover the six new fields.
-- Only receipt_id (initial assignment) and superseded_by (correction chain)
-- remain mutable after creation.
CREATE OR REPLACE FUNCTION prevent_payment_evidence_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.exporter_id          IS DISTINCT FROM NEW.exporter_id          OR
     OLD.evidence_type        IS DISTINCT FROM NEW.evidence_type        OR
     OLD.source_document_ref  IS DISTINCT FROM NEW.source_document_ref  OR
     OLD.sender_bic           IS DISTINCT FROM NEW.sender_bic           OR
     OLD.receiver_bic         IS DISTINCT FROM NEW.receiver_bic         OR
     OLD.instructed_amount    IS DISTINCT FROM NEW.instructed_amount    OR
     OLD.instructed_currency  IS DISTINCT FROM NEW.instructed_currency  OR
     OLD.value_date           IS DISTINCT FROM NEW.value_date           OR
     OLD.charges_code         IS DISTINCT FROM NEW.charges_code         OR
     OLD.ordering_customer    IS DISTINCT FROM NEW.ordering_customer    OR
     OLD.beneficiary_customer IS DISTINCT FROM NEW.beneficiary_customer OR
     OLD.remittance_info      IS DISTINCT FROM NEW.remittance_info      OR
     OLD.document_url         IS DISTINCT FROM NEW.document_url         OR
     OLD.uploaded_by          IS DISTINCT FROM NEW.uploaded_by          OR
     OLD.created_at           IS DISTINCT FROM NEW.created_at           OR
     OLD.credited_amount      IS DISTINCT FROM NEW.credited_amount      OR
     OLD.credited_currency    IS DISTINCT FROM NEW.credited_currency    OR
     OLD.credit_date          IS DISTINCT FROM NEW.credit_date          OR
     OLD.bank_ref             IS DISTINCT FROM NEW.bank_ref             OR
     OLD.payer_account        IS DISTINCT FROM NEW.payer_account        OR
     OLD.payer_name           IS DISTINCT FROM NEW.payer_name
  THEN
    RAISE EXCEPTION
      'payment_evidence core fields are immutable after creation. '
      'Create a new row and set superseded_by on this row to issue a correction.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

-- =============================================================================
-- FIX 2: Remove strict credited_amount <= instructed_amount constraint.
-- Replace with trigger-based mismatch detection.
-- Overpayments and corrections are permitted but auto-flagged.
--
-- Discrepancy logic (fires BEFORE INSERT OR UPDATE on payment_receipts):
--   - diff = 0                  → CLEAN
--   - diff <= tolerance band    → CLEAN  (expected under SHA/BEN charges)
--   - diff  > tolerance band    → AMOUNT_MISMATCH
--   - MANUALLY_RESOLVED         → never overridden
--   - other statuses on UPDATE  → only recomputed when amounts change
--
-- Tolerance band: min(instructed * pct, max_abs), from exporter_settings.
-- Defaults: 2% or USD 500 max per spec.
-- =============================================================================

ALTER TABLE payment_receipts
  DROP CONSTRAINT IF EXISTS payment_receipts_credited_lte_instructed;

CREATE OR REPLACE FUNCTION detect_payment_receipt_discrepancy()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  v_tolerance_pct    DECIMAL(5,4);
  v_tolerance_max    DECIMAL(18,2);
  v_diff             DECIMAL(18,2);
  v_tolerance_amount DECIMAL(18,2);
BEGIN
  -- On UPDATE, only recompute if amounts actually changed
  IF TG_OP = 'UPDATE' AND
     OLD.instructed_amount IS NOT DISTINCT FROM NEW.instructed_amount AND
     OLD.credited_amount   IS NOT DISTINCT FROM NEW.credited_amount
  THEN
    RETURN NEW;
  END IF;

  -- Never override a status set by a human reviewer
  IF NEW.discrepancy_status = 'MANUALLY_RESOLVED' THEN
    RETURN NEW;
  END IF;

  v_diff := ABS(NEW.instructed_amount - NEW.credited_amount);

  SELECT charges_tolerance_pct, charges_tolerance_max_abs
    INTO v_tolerance_pct, v_tolerance_max
    FROM exporter_settings
   WHERE exporter_id = NEW.exporter_id;

  -- Fall back to spec defaults if no settings row exists yet
  v_tolerance_pct := COALESCE(v_tolerance_pct, 0.0200);
  v_tolerance_max := COALESCE(v_tolerance_max, 500.00);

  v_tolerance_amount := LEAST(
    NEW.instructed_amount * v_tolerance_pct,
    v_tolerance_max
  );

  IF v_diff = 0 THEN
    NEW.discrepancy_status := 'CLEAN';
  ELSIF v_diff <= v_tolerance_amount THEN
    -- Within tolerance (expected SHA/BEN charges): treat as CLEAN
    NEW.discrepancy_status := 'CLEAN';
  ELSE
    -- Exceeds tolerance — includes overpayments (credited > instructed)
    NEW.discrepancy_status := 'AMOUNT_MISMATCH';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_payment_receipt_discrepancy
  BEFORE INSERT OR UPDATE ON payment_receipts
  FOR EACH ROW EXECUTE FUNCTION detect_payment_receipt_discrepancy();

-- =============================================================================
-- FIX 3: Add explicit WITH CHECK to all FOR ALL RLS policies.
-- Without it, PostgreSQL silently reuses USING for writes, but the intent is
-- ambiguous and can regress if policies are later split by operation.
-- FOR SELECT policies (exporters, exporter_users) have no WITH CHECK — correct.
-- =============================================================================

DROP POLICY rls_exporter_settings          ON exporter_settings;
DROP POLICY rls_counterparties             ON counterparties;
DROP POLICY rls_counterparty_bank_accounts ON counterparty_bank_accounts;
DROP POLICY rls_export_contracts           ON export_contracts;
DROP POLICY rls_shipments                  ON shipments;
DROP POLICY rls_invoices                   ON invoices;
DROP POLICY rls_bills_of_lading            ON bills_of_lading;
DROP POLICY rls_compliance_records         ON compliance_records;
DROP POLICY rls_payment_receipts           ON payment_receipts;
DROP POLICY rls_payment_evidence           ON payment_evidence;
DROP POLICY rls_payment_allocations        ON payment_allocations;
DROP POLICY rls_bank_evidence_packs        ON bank_evidence_packs;

CREATE POLICY rls_exporter_settings ON exporter_settings
  FOR ALL
  USING     (exporter_id IN (SELECT current_user_exporter_ids()))
  WITH CHECK (exporter_id IN (SELECT current_user_exporter_ids()));

CREATE POLICY rls_counterparties ON counterparties
  FOR ALL
  USING     (exporter_id IN (SELECT current_user_exporter_ids()))
  WITH CHECK (exporter_id IN (SELECT current_user_exporter_ids()));

CREATE POLICY rls_counterparty_bank_accounts ON counterparty_bank_accounts
  FOR ALL
  USING     (exporter_id IN (SELECT current_user_exporter_ids()))
  WITH CHECK (exporter_id IN (SELECT current_user_exporter_ids()));

CREATE POLICY rls_export_contracts ON export_contracts
  FOR ALL
  USING     (exporter_id IN (SELECT current_user_exporter_ids()))
  WITH CHECK (exporter_id IN (SELECT current_user_exporter_ids()));

CREATE POLICY rls_shipments ON shipments
  FOR ALL
  USING     (exporter_id IN (SELECT current_user_exporter_ids()))
  WITH CHECK (exporter_id IN (SELECT current_user_exporter_ids()));

CREATE POLICY rls_invoices ON invoices
  FOR ALL
  USING     (exporter_id IN (SELECT current_user_exporter_ids()))
  WITH CHECK (exporter_id IN (SELECT current_user_exporter_ids()));

CREATE POLICY rls_bills_of_lading ON bills_of_lading
  FOR ALL
  USING     (exporter_id IN (SELECT current_user_exporter_ids()))
  WITH CHECK (exporter_id IN (SELECT current_user_exporter_ids()));

CREATE POLICY rls_compliance_records ON compliance_records
  FOR ALL
  USING     (exporter_id IN (SELECT current_user_exporter_ids()))
  WITH CHECK (exporter_id IN (SELECT current_user_exporter_ids()));

CREATE POLICY rls_payment_receipts ON payment_receipts
  FOR ALL
  USING     (exporter_id IN (SELECT current_user_exporter_ids()))
  WITH CHECK (exporter_id IN (SELECT current_user_exporter_ids()));

CREATE POLICY rls_payment_evidence ON payment_evidence
  FOR ALL
  USING     (exporter_id IN (SELECT current_user_exporter_ids()))
  WITH CHECK (exporter_id IN (SELECT current_user_exporter_ids()));

CREATE POLICY rls_payment_allocations ON payment_allocations
  FOR ALL
  USING     (exporter_id IN (SELECT current_user_exporter_ids()))
  WITH CHECK (exporter_id IN (SELECT current_user_exporter_ids()));

CREATE POLICY rls_bank_evidence_packs ON bank_evidence_packs
  FOR ALL
  USING     (exporter_id IN (SELECT current_user_exporter_ids()))
  WITH CHECK (exporter_id IN (SELECT current_user_exporter_ids()));

-- =============================================================================
-- FIX 4: Auto-create ComplianceRecord on BillOfLading INSERT
-- Fires AFTER INSERT so the B/L row (with its trigger-computed
-- repatriation_deadline) is already written to the table.
-- NEW.repatriation_deadline in an AFTER INSERT trigger reflects the final
-- value set by the BEFORE INSERT trigger trg_bl_compute_deadline.
-- Uses ON CONFLICT DO NOTHING to be idempotent if called more than once.
-- =============================================================================

CREATE OR REPLACE FUNCTION auto_create_compliance_record()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  v_shipment_value DECIMAL(18,2);
BEGIN
  SELECT shipment_value
    INTO v_shipment_value
    FROM shipments
   WHERE id = NEW.shipment_id;

  INSERT INTO compliance_records (
    shipment_id,
    exporter_id,
    repatriation_deadline,
    days_remaining,
    repatriation_status,
    proceeds_required
  ) VALUES (
    NEW.shipment_id,
    NEW.exporter_id,
    NEW.repatriation_deadline,
    (NEW.repatriation_deadline - CURRENT_DATE),
    'NOT_DUE',
    v_shipment_value
  )
  ON CONFLICT (shipment_id) DO NOTHING;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_bl_auto_compliance_record
  AFTER INSERT ON bills_of_lading
  FOR EACH ROW EXECUTE FUNCTION auto_create_compliance_record();

-- =============================================================================
-- FIX 5: Allocation side-effect trigger
-- Fires AFTER INSERT, UPDATE, or DELETE on payment_allocations.
-- Recomputes three derived states from the canonical allocation rows:
--
--   payment_receipts.allocation_status
--     UNALLOCATED        if SUM(allocated_amount) = 0
--     PARTIALLY_ALLOCATED if SUM < credited_amount
--     FULLY_ALLOCATED     if SUM >= credited_amount
--
--   compliance_records.proceeds_received
--     SUM(allocated_amount) WHERE shipment_id = this shipment
--
--   compliance_records.repatriation_status
--     COMPLETE  if proceeds_received >= proceeds_required
--     OVERDUE   if CURRENT_DATE > deadline AND proceeds < required
--     PARTIAL   if proceeds_received > 0 AND < proceeds_required
--     NOT_DUE   otherwise
--
--   shipments.status  (only when shipment has departed)
--     PROCEEDS_COMPLETE if proceeds_received >= proceeds_required
--     PROCEEDS_PARTIAL  if proceeds_received > 0 AND < proceeds_required
-- =============================================================================

CREATE OR REPLACE FUNCTION _sync_receipt_allocation_status(p_receipt_id UUID)
RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
  v_total_allocated DECIMAL(18,2);
  v_credited_amount DECIMAL(18,2);
  v_new_status      allocation_status;
BEGIN
  SELECT COALESCE(SUM(allocated_amount), 0)
    INTO v_total_allocated
    FROM payment_allocations
   WHERE receipt_id = p_receipt_id;

  SELECT credited_amount
    INTO v_credited_amount
    FROM payment_receipts
   WHERE id = p_receipt_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF v_total_allocated = 0 THEN
    v_new_status := 'UNALLOCATED';
  ELSIF v_total_allocated >= v_credited_amount THEN
    v_new_status := 'FULLY_ALLOCATED';
  ELSE
    v_new_status := 'PARTIALLY_ALLOCATED';
  END IF;

  UPDATE payment_receipts
     SET allocation_status = v_new_status,
         updated_at        = NOW()
   WHERE id = p_receipt_id;
END;
$$;

CREATE OR REPLACE FUNCTION _sync_compliance_proceeds(p_shipment_id UUID)
RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
  v_proceeds_received     DECIMAL(18,2);
  v_proceeds_required     DECIMAL(18,2);
  v_repatriation_deadline DATE;
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

  IF v_proceeds_received >= v_proceeds_required THEN
    v_new_repatriation := 'COMPLETE';
  ELSIF CURRENT_DATE > v_repatriation_deadline THEN
    v_new_repatriation := 'OVERDUE';
  ELSIF v_proceeds_received > 0 THEN
    v_new_repatriation := 'PARTIAL';
  ELSE
    v_new_repatriation := 'NOT_DUE';
  END IF;

  UPDATE compliance_records
     SET proceeds_received   = v_proceeds_received,
         repatriation_status = v_new_repatriation,
         updated_at          = NOW()
   WHERE shipment_id = p_shipment_id;

  -- Mirror proceeds completion onto shipments.status.
  -- Only update if the shipment has already departed (not PENDING/CANCELLED).
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

CREATE OR REPLACE FUNCTION sync_allocation_side_effects()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM _sync_receipt_allocation_status(OLD.receipt_id);
    PERFORM _sync_compliance_proceeds(OLD.shipment_id);
    RETURN OLD;
  END IF;

  -- INSERT or UPDATE: sync the new receipt and shipment
  PERFORM _sync_receipt_allocation_status(NEW.receipt_id);
  PERFORM _sync_compliance_proceeds(NEW.shipment_id);

  -- On UPDATE: also sync the old receipt/shipment if they changed
  IF TG_OP = 'UPDATE' THEN
    IF OLD.receipt_id IS DISTINCT FROM NEW.receipt_id THEN
      PERFORM _sync_receipt_allocation_status(OLD.receipt_id);
    END IF;
    IF OLD.shipment_id IS DISTINCT FROM NEW.shipment_id THEN
      PERFORM _sync_compliance_proceeds(OLD.shipment_id);
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_allocation_side_effects
  AFTER INSERT OR UPDATE OR DELETE ON payment_allocations
  FOR EACH ROW EXECUTE FUNCTION sync_allocation_side_effects();

-- =============================================================================
-- FIX 6: SQL Verification Blocks
-- Each DO block is self-contained. Blocks that insert data use SAVEPOINT to
-- ensure no test rows remain after the block runs.
-- ASSERT raises an exception on failure, which aborts this migration.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- TEST A: BANK_CREDIT_ADVICE columns exist on payment_evidence
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_required TEXT[] := ARRAY[
    'credited_amount', 'credited_currency', 'credit_date',
    'bank_ref', 'payer_account', 'payer_name'
  ];
  v_col TEXT;
BEGIN
  FOREACH v_col IN ARRAY v_required
  LOOP
    ASSERT EXISTS (
      SELECT 1
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name   = 'payment_evidence'
         AND column_name  = v_col
    ), format('TEST FAIL: payment_evidence missing column "%s"', v_col);
  END LOOP;

  RAISE NOTICE 'TEST PASS [A]: All BANK_CREDIT_ADVICE fields present on payment_evidence';
END;
$$;

-- -----------------------------------------------------------------------------
-- TEST B: Strict credited <= instructed constraint is removed
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  ASSERT NOT EXISTS (
    SELECT 1
      FROM information_schema.table_constraints
     WHERE table_schema    = 'public'
       AND table_name      = 'payment_receipts'
       AND constraint_name = 'payment_receipts_credited_lte_instructed'
       AND constraint_type = 'CHECK'
  ), 'TEST FAIL: payment_receipts_credited_lte_instructed constraint still exists';

  RAISE NOTICE 'TEST PASS [B]: Strict credited <= instructed constraint removed';
END;
$$;

-- -----------------------------------------------------------------------------
-- TEST C: Discrepancy detection trigger flags mismatches and allows overpayments
-- Inserts test payment_receipts and checks auto-set discrepancy_status.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_exporter_id UUID;
  v_status      discrepancy_status;
BEGIN
  SAVEPOINT test_c;

  INSERT INTO exporters (legal_name, country)
    VALUES ('_test_exp_c_', 'NG')
    RETURNING id INTO v_exporter_id;

  INSERT INTO exporter_settings (exporter_id)
    VALUES (v_exporter_id);

  -- Exact match → CLEAN
  INSERT INTO payment_receipts (
    exporter_id, receipt_reference,
    instructed_amount, credited_amount, currency, credit_date
  ) VALUES (
    v_exporter_id, '_rcpt_clean_', 1000.00, 1000.00, 'USD', CURRENT_DATE
  ) RETURNING discrepancy_status INTO v_status;

  ASSERT v_status = 'CLEAN',
    format('TEST FAIL: exact match should be CLEAN, got %s', v_status);

  -- Overpayment exceeding tolerance (diff=100, tolerance=min(1000*2%,500)=20)
  INSERT INTO payment_receipts (
    exporter_id, receipt_reference,
    instructed_amount, credited_amount, currency, credit_date
  ) VALUES (
    v_exporter_id, '_rcpt_overpay_', 1000.00, 1100.00, 'USD', CURRENT_DATE
  ) RETURNING discrepancy_status INTO v_status;

  ASSERT v_status = 'AMOUNT_MISMATCH',
    format('TEST FAIL: overpayment should be AMOUNT_MISMATCH, got %s', v_status);

  -- Under-deduction exceeding tolerance (diff=100 > 20)
  INSERT INTO payment_receipts (
    exporter_id, receipt_reference,
    instructed_amount, credited_amount, currency, credit_date
  ) VALUES (
    v_exporter_id, '_rcpt_shortpay_', 1000.00, 900.00, 'USD', CURRENT_DATE
  ) RETURNING discrepancy_status INTO v_status;

  ASSERT v_status = 'AMOUNT_MISMATCH',
    format('TEST FAIL: under-credit should be AMOUNT_MISMATCH, got %s', v_status);

  -- Within tolerance (diff=10 <= 20): CLEAN
  INSERT INTO payment_receipts (
    exporter_id, receipt_reference,
    instructed_amount, credited_amount, currency, credit_date
  ) VALUES (
    v_exporter_id, '_rcpt_within_tol_', 1000.00, 990.00, 'USD', CURRENT_DATE
  ) RETURNING discrepancy_status INTO v_status;

  ASSERT v_status = 'CLEAN',
    format('TEST FAIL: within-tolerance deduction should be CLEAN, got %s', v_status);

  ROLLBACK TO SAVEPOINT test_c;
  RAISE NOTICE 'TEST PASS [C]: Discrepancy detection correctly handles matches, overpayments, and tolerance';
END;
$$;

-- -----------------------------------------------------------------------------
-- TEST D: All FOR ALL RLS policies have explicit WITH CHECK
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_tables TEXT[] := ARRAY[
    'exporter_settings', 'counterparties', 'counterparty_bank_accounts',
    'export_contracts', 'shipments', 'invoices', 'bills_of_lading',
    'compliance_records', 'payment_receipts', 'payment_evidence',
    'payment_allocations', 'bank_evidence_packs'
  ];
  v_tbl TEXT;
BEGIN
  FOREACH v_tbl IN ARRAY v_tables
  LOOP
    ASSERT EXISTS (
      SELECT 1
        FROM pg_policies
       WHERE schemaname = 'public'
         AND tablename  = v_tbl
         AND cmd        = 'ALL'
         AND qual       IS NOT NULL
         AND with_check IS NOT NULL
    ), format('TEST FAIL: table "%s" has no FOR ALL policy with explicit WITH CHECK', v_tbl);
  END LOOP;

  RAISE NOTICE 'TEST PASS [D]: All FOR ALL RLS policies carry explicit WITH CHECK clause';
END;
$$;

-- -----------------------------------------------------------------------------
-- TEST E: ComplianceRecord auto-created with correct deadline after B/L INSERT
-- Full chain: exporter → counterparty → contract → shipment → B/L → compliance
-- No FK to auth.users required in this chain.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_exporter_id     UUID;
  v_cp_id           UUID;
  v_contract_id     UUID;
  v_shipment_id     UUID;
  v_compliance_id   UUID;
  v_deadline        DATE;
  v_days_remaining  INTEGER;
  v_proceeds_req    DECIMAL(18,2);
BEGIN
  SAVEPOINT test_e;

  INSERT INTO exporters (legal_name, country)
    VALUES ('_test_exp_e_', 'NG')
    RETURNING id INTO v_exporter_id;

  INSERT INTO counterparties (
    exporter_id, legal_name, country_of_incorporation, counterparty_type
  ) VALUES (
    v_exporter_id, '_test_buyer_e_', 'DE', 'COMPANY'
  ) RETURNING id INTO v_cp_id;

  INSERT INTO export_contracts (
    exporter_id, counterparty_id, contract_reference,
    commodity, commodity_type, hs_code,
    contract_quantity, quantity_unit, contract_value, currency,
    unit_price, incoterms, destination_country, payment_terms,
    partial_shipment_allowed, contract_date
  ) VALUES (
    v_exporter_id, v_cp_id, '_test_ctr_e_',
    'Cocoa beans', 'NON_OIL', '1801.00',
    100, 'MT', 50000.00, 'USD',
    500.00, 'FOB', 'DE', 'TT',
    FALSE, CURRENT_DATE
  ) RETURNING id INTO v_contract_id;

  INSERT INTO shipments (
    exporter_id, contract_id, shipment_reference, shipment_sequence,
    nxp_reference, port_of_loading, port_of_discharge,
    shipment_quantity, shipment_value, currency
  ) VALUES (
    v_exporter_id, v_contract_id, '_test_shp_e_', 1,
    'NXP-TEST-E-001', 'Apapa, Lagos', 'Hamburg',
    100, 50000.00, 'USD'
  ) RETURNING id INTO v_shipment_id;

  -- B/L INSERT should auto-create compliance_record via trg_bl_auto_compliance_record
  INSERT INTO bills_of_lading (
    shipment_id, exporter_id, bl_number, bl_date, bl_type,
    shipper_name, consignee_name, description_of_goods, nxp_reference
  ) VALUES (
    v_shipment_id, v_exporter_id, '_test_bl_e_', CURRENT_DATE, 'ORIGINAL',
    '_test_shipper_', '_test_consignee_', 'Cocoa beans', 'NXP-TEST-E-001'
  );

  -- Verify compliance_record was created
  SELECT id, repatriation_deadline, days_remaining, proceeds_required
    INTO v_compliance_id, v_deadline, v_days_remaining, v_proceeds_req
    FROM compliance_records
   WHERE shipment_id = v_shipment_id;

  ASSERT v_compliance_id IS NOT NULL,
    'TEST FAIL: compliance_record not auto-created after B/L insert';

  -- NON_OIL contract, no exporter_settings → 180-day default
  ASSERT v_deadline = CURRENT_DATE + 180,
    format('TEST FAIL: repatriation_deadline expected %s, got %s',
      CURRENT_DATE + 180, v_deadline);

  ASSERT v_days_remaining = 180,
    format('TEST FAIL: days_remaining expected 180, got %s', v_days_remaining);

  ASSERT v_proceeds_req = 50000.00,
    format('TEST FAIL: proceeds_required expected 50000.00, got %s', v_proceeds_req);

  ROLLBACK TO SAVEPOINT test_e;
  RAISE NOTICE 'TEST PASS [E]: ComplianceRecord auto-created with correct deadline and proceeds_required';
END;
$$;

-- -----------------------------------------------------------------------------
-- TEST F: Allocation integrity trigger blocks over-allocation
-- Tests the trigger structurally and verifies it fires via BEFORE INSERT.
-- Full data test omitted here because payment_allocations.allocated_by
-- requires an auth.users FK; verify structural presence instead.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_trigger_count INTEGER;
  v_fn_count      INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_trigger_count
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
   WHERE c.relname = 'payment_allocations'
     AND t.tgname  = 'trg_allocation_integrity'
     AND t.tgtype & 2  > 0   -- BEFORE (tgtype bit 1)
     AND t.tgtype & 4  > 0   -- INSERT (tgtype bit 2)
     AND t.tgtype & 8  > 0;  -- UPDATE (tgtype bit 3)

  ASSERT v_trigger_count = 1,
    'TEST FAIL: trg_allocation_integrity BEFORE INSERT OR UPDATE not found on payment_allocations';

  SELECT COUNT(*) INTO v_fn_count
    FROM pg_proc
   WHERE proname = 'check_allocation_integrity';

  ASSERT v_fn_count = 1,
    'TEST FAIL: check_allocation_integrity function not found';

  RAISE NOTICE 'TEST PASS [F]: Allocation integrity trigger and function exist and are correctly wired';
END;
$$;

-- -----------------------------------------------------------------------------
-- TEST G: Sealed BankEvidencePack immutability trigger exists
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
   WHERE c.relname = 'bank_evidence_packs'
     AND t.tgname  = 'trg_bank_evidence_pack_sealed'
     AND t.tgtype & 2 > 0;  -- BEFORE

  ASSERT v_count = 1,
    'TEST FAIL: trg_bank_evidence_pack_sealed BEFORE trigger not found on bank_evidence_packs';

  RAISE NOTICE 'TEST PASS [G]: Sealed pack immutability trigger exists on bank_evidence_packs';
END;
$$;

-- -----------------------------------------------------------------------------
-- TEST H: payment_evidence immutability trigger covers new BANK_CREDIT_ADVICE fields
-- Checks the function source guards credited_amount and credit_date.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_src TEXT;
BEGIN
  SELECT prosrc INTO v_src
    FROM pg_proc
   WHERE proname = 'prevent_payment_evidence_mutation';

  ASSERT v_src IS NOT NULL,
    'TEST FAIL: prevent_payment_evidence_mutation function not found';

  ASSERT position('credited_amount'   IN v_src) > 0,
    'TEST FAIL: immutability trigger does not guard credited_amount';
  ASSERT position('credited_currency' IN v_src) > 0,
    'TEST FAIL: immutability trigger does not guard credited_currency';
  ASSERT position('credit_date'       IN v_src) > 0,
    'TEST FAIL: immutability trigger does not guard credit_date';
  ASSERT position('bank_ref'          IN v_src) > 0,
    'TEST FAIL: immutability trigger does not guard bank_ref';
  ASSERT position('payer_account'     IN v_src) > 0,
    'TEST FAIL: immutability trigger does not guard payer_account';
  ASSERT position('payer_name'        IN v_src) > 0,
    'TEST FAIL: immutability trigger does not guard payer_name';

  RAISE NOTICE 'TEST PASS [H]: payment_evidence immutability trigger guards all new BANK_CREDIT_ADVICE fields';
END;
$$;

COMMIT;
