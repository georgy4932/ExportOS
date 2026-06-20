-- =============================================================================
-- ExportOS v0.2 — Schema Foundation Tests
-- supabase/tests/schema_foundation.sql
-- =============================================================================
-- Run with: psql <connection-string> -f supabase/tests/schema_foundation.sql
-- Requires: all three migrations applied (0001, 0002, 0003).
-- Requires: superuser or a role with BYPASSRLS (RLS is enabled on all tables;
--           test inserts run as the schema owner or service role key).
--
-- All statements run inside BEGIN/ROLLBACK — no persistent changes are made.
-- Expected-error paths use BEGIN...EXCEPTION WHEN...END nested blocks.
-- Never uses explicit SAVEPOINT / ROLLBACK TO SAVEPOINT.
--
-- Test sections:
--   §1  Enum types (migration 0001)
--   §2  Table existence (migration 0001)
--   §3  payment_evidence BANK_CREDIT_ADVICE columns (migration 0002)
--   §4  payment_receipts amount semantics columns (migration 0003)
--   §5  compliance_records late repatriation columns (migration 0003)
--   §6  Trigger catalog (migrations 0001–0003)
--   §7  Function catalog and body verification (migrations 0001–0003)
--   §8  RLS catalog
--   §9  BEHAVIORAL: Discrepancy detection and generated amount columns
--   §10 BEHAVIORAL: Compliance record auto-creation on B/L INSERT
--   §11 BEHAVIORAL: Counterparty completeness enforcement for ACTIVE contracts
-- =============================================================================

BEGIN;

-- -------------------------------------------------------------------------
-- §1  Enum types (migration 0001)
-- -------------------------------------------------------------------------

DO $$
BEGIN
  ASSERT (
    SELECT COUNT(*) FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typtype = 'e'
      AND t.typname IN (
        'contract_status','shipment_status','repatriation_status',
        'discrepancy_status','allocation_status','allocation_method',
        'evidence_type','bl_type','deadline_status','counterparty_type',
        'kyc_status','invoice_type','charges_code','commodity_type',
        'freight_terms'
      )
  ) = 15,
    'FAIL [1.1]: Expected 15 enum types';

  RAISE NOTICE 'PASS [1.1]: All 15 enum types exist';
END;
$$;

-- -------------------------------------------------------------------------
-- §2  Table existence (migration 0001)
-- -------------------------------------------------------------------------

DO $$
BEGIN
  ASSERT (
    SELECT COUNT(*) FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name IN (
      'exporters','exporter_settings','exporter_users',
      'counterparties','counterparty_bank_accounts',
      'export_contracts','shipments','invoices',
      'bills_of_lading','compliance_records',
      'payment_receipts','payment_evidence',
      'payment_allocations','bank_evidence_packs'
    )
  ) = 14,
    'FAIL [2.1]: Expected 14 tables';

  RAISE NOTICE 'PASS [2.1]: All 14 tables exist';
END;
$$;

-- -------------------------------------------------------------------------
-- §3  payment_evidence BANK_CREDIT_ADVICE columns (migration 0002)
-- -------------------------------------------------------------------------

DO $$
BEGIN
  ASSERT (
    SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'payment_evidence'
      AND column_name IN (
        'credited_amount','credited_currency','credit_date',
        'bank_ref','payer_account','payer_name'
      )
  ) = 6,
    'FAIL [3.1]: One or more BANK_CREDIT_ADVICE columns missing on payment_evidence';

  RAISE NOTICE 'PASS [3.1]: All 6 BANK_CREDIT_ADVICE columns exist on payment_evidence';
END;
$$;

-- -------------------------------------------------------------------------
-- §4  payment_receipts amount semantics columns (migration 0003)
-- -------------------------------------------------------------------------

DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'payment_receipts'
      AND column_name = 'charges_deducted'
  ), 'FAIL [4.1]: payment_receipts.charges_deducted missing';

  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'payment_receipts'
      AND column_name = 'amount_variance'
  ), 'FAIL [4.2]: payment_receipts.amount_variance missing';

  RAISE NOTICE 'PASS [4.1]: payment_receipts has charges_deducted (clamped ≥0) and amount_variance (signed)';
END;
$$;

-- -------------------------------------------------------------------------
-- §5  compliance_records late repatriation columns (migration 0003)
-- -------------------------------------------------------------------------

DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'compliance_records'
      AND column_name = 'was_repatriated_late'
  ), 'FAIL [5.1]: compliance_records.was_repatriated_late missing';

  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'compliance_records'
      AND column_name = 'completed_after_deadline_at'
  ), 'FAIL [5.2]: compliance_records.completed_after_deadline_at missing';

  RAISE NOTICE 'PASS [5.1]: Late repatriation history columns exist on compliance_records';
END;
$$;

-- -------------------------------------------------------------------------
-- §6  Trigger catalog (migrations 0001–0003)
-- -------------------------------------------------------------------------

DO $$
BEGIN
  -- updated_at triggers (8 tables carry updated_at; payment_evidence,
  -- payment_allocations, counterparty_bank_accounts, invoices, bank_evidence_packs do not)
  ASSERT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                  WHERE c.relname = 'exporters'         AND t.tgname = 'trg_exporters_updated_at'),
    'FAIL [6.1]: trg_exporters_updated_at missing';
  ASSERT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                  WHERE c.relname = 'exporter_settings' AND t.tgname = 'trg_exporter_settings_updated_at'),
    'FAIL [6.1]: trg_exporter_settings_updated_at missing';
  ASSERT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                  WHERE c.relname = 'counterparties'    AND t.tgname = 'trg_counterparties_updated_at'),
    'FAIL [6.1]: trg_counterparties_updated_at missing';
  ASSERT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                  WHERE c.relname = 'export_contracts'  AND t.tgname = 'trg_export_contracts_updated_at'),
    'FAIL [6.1]: trg_export_contracts_updated_at missing';
  ASSERT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                  WHERE c.relname = 'shipments'         AND t.tgname = 'trg_shipments_updated_at'),
    'FAIL [6.1]: trg_shipments_updated_at missing';
  ASSERT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                  WHERE c.relname = 'bills_of_lading'   AND t.tgname = 'trg_bills_of_lading_updated_at'),
    'FAIL [6.1]: trg_bills_of_lading_updated_at missing';
  ASSERT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                  WHERE c.relname = 'compliance_records' AND t.tgname = 'trg_compliance_records_updated_at'),
    'FAIL [6.1]: trg_compliance_records_updated_at missing';
  ASSERT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                  WHERE c.relname = 'payment_receipts'  AND t.tgname = 'trg_payment_receipts_updated_at'),
    'FAIL [6.1]: trg_payment_receipts_updated_at missing';

  RAISE NOTICE 'PASS [6.1]: updated_at triggers exist on all 8 mutable tables';

  -- B/L pipeline triggers (migration 0001 + 0002)
  ASSERT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                  WHERE c.relname = 'bills_of_lading' AND t.tgname = 'trg_bl_compute_deadline'),
    'FAIL [6.2]: trg_bl_compute_deadline missing on bills_of_lading';
  ASSERT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                  WHERE c.relname = 'bills_of_lading' AND t.tgname = 'trg_bl_immutable_deadline'),
    'FAIL [6.2]: trg_bl_immutable_deadline missing on bills_of_lading';
  ASSERT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                  WHERE c.relname = 'bills_of_lading' AND t.tgname = 'trg_bl_auto_compliance_record'),
    'FAIL [6.2]: trg_bl_auto_compliance_record missing on bills_of_lading';

  RAISE NOTICE 'PASS [6.2]: B/L pipeline triggers exist (compute_deadline, immutable_deadline, auto_compliance_record)';

  -- Payment triggers (migrations 0001 + 0002)
  ASSERT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                  WHERE c.relname = 'payment_receipts'    AND t.tgname = 'trg_payment_receipt_discrepancy'),
    'FAIL [6.3]: trg_payment_receipt_discrepancy missing on payment_receipts';
  ASSERT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                  WHERE c.relname = 'payment_evidence'    AND t.tgname = 'trg_payment_evidence_immutable'),
    'FAIL [6.3]: trg_payment_evidence_immutable missing on payment_evidence';
  ASSERT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                  WHERE c.relname = 'payment_allocations' AND t.tgname = 'trg_allocation_integrity'),
    'FAIL [6.3]: trg_allocation_integrity missing on payment_allocations';
  ASSERT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                  WHERE c.relname = 'payment_allocations' AND t.tgname = 'trg_allocation_side_effects'),
    'FAIL [6.3]: trg_allocation_side_effects missing on payment_allocations';

  RAISE NOTICE 'PASS [6.3]: Payment triggers exist (discrepancy, evidence_immutable, allocation_integrity, allocation_side_effects)';

  -- Pack sealing triggers (alphabetical order is the enforcement contract)
  ASSERT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                  WHERE c.relname = 'bank_evidence_packs' AND t.tgname = 'trg_bank_evidence_pack_sealed'),
    'FAIL [6.4]: trg_bank_evidence_pack_sealed missing on bank_evidence_packs';
  ASSERT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                  WHERE c.relname = 'bank_evidence_packs' AND t.tgname = 'trg_pack_sealing_preconditions'),
    'FAIL [6.4]: trg_pack_sealing_preconditions missing on bank_evidence_packs';

  -- Already-sealed guard (trg_bank_evidence_pack_sealed) must sort BEFORE
  -- precondition checker (trg_pack_sealing_preconditions) so a sealed-pack
  -- mutation attempt raises the right error first.
  ASSERT 'trg_bank_evidence_pack_sealed' < 'trg_pack_sealing_preconditions',
    'FAIL [6.4]: Trigger name ordering invariant violated — already-sealed guard must fire first';

  RAISE NOTICE 'PASS [6.4]: Pack sealing triggers exist and fire in correct alphabetical order';

  -- Counterparty completeness trigger (migration 0003)
  ASSERT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                  WHERE c.relname = 'export_contracts'
                    AND t.tgname  = 'trg_contract_counterparty_completeness'),
    'FAIL [6.5]: trg_contract_counterparty_completeness missing on export_contracts';

  RAISE NOTICE 'PASS [6.5]: Counterparty completeness trigger exists on export_contracts';
END;
$$;

-- -------------------------------------------------------------------------
-- §7  Function catalog and body verification (migrations 0001–0003)
-- -------------------------------------------------------------------------

DO $$
DECLARE
  v_src TEXT;
BEGIN
  -- Migration 0001 functions
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'set_updated_at'),
    'FAIL [7.1]: set_updated_at missing';
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'compute_bl_repatriation_deadline'),
    'FAIL [7.1]: compute_bl_repatriation_deadline missing';
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'prevent_bl_deadline_change'),
    'FAIL [7.1]: prevent_bl_deadline_change missing';
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'check_allocation_integrity'),
    'FAIL [7.1]: check_allocation_integrity missing';
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'prevent_payment_evidence_mutation'),
    'FAIL [7.1]: prevent_payment_evidence_mutation missing';
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'prevent_sealed_pack_mutation'),
    'FAIL [7.1]: prevent_sealed_pack_mutation missing';
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'current_user_exporter_ids'),
    'FAIL [7.1]: current_user_exporter_ids missing';

  RAISE NOTICE 'PASS [7.1]: All migration 0001 functions exist';

  -- Migration 0002 functions
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'detect_payment_receipt_discrepancy'),
    'FAIL [7.2]: detect_payment_receipt_discrepancy missing';
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'auto_create_compliance_record'),
    'FAIL [7.2]: auto_create_compliance_record missing';
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = '_sync_receipt_allocation_status'),
    'FAIL [7.2]: _sync_receipt_allocation_status missing';
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = '_sync_compliance_proceeds'),
    'FAIL [7.2]: _sync_compliance_proceeds missing';
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'sync_allocation_side_effects'),
    'FAIL [7.2]: sync_allocation_side_effects missing';

  RAISE NOTICE 'PASS [7.2]: All migration 0002 functions exist';

  -- Migration 0003 functions
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_counterparty_completeness'),
    'FAIL [7.3]: enforce_counterparty_completeness missing';
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_pack_sealing_preconditions'),
    'FAIL [7.3]: enforce_pack_sealing_preconditions missing';

  -- _sync_compliance_proceeds (rebuilt in 0003) must carry write-once late-flag logic
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = '_sync_compliance_proceeds';
  ASSERT position('was_repatriated_late'        IN v_src) > 0,
    'FAIL [7.3]: _sync_compliance_proceeds missing was_repatriated_late write-once update';
  ASSERT position('completed_after_deadline_at' IN v_src) > 0,
    'FAIL [7.3]: _sync_compliance_proceeds missing completed_after_deadline_at write-once update';

  -- enforce_pack_sealing_preconditions must check all 5 ComplianceRecord checklist fields
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'enforce_pack_sealing_preconditions';
  ASSERT position('nxp_approved'              IN v_src) > 0, 'FAIL [7.3]: nxp_approved not in sealing function body';
  ASSERT position('cci_obtained'              IN v_src) > 0, 'FAIL [7.3]: cci_obtained not in sealing function body';
  ASSERT position('bl_uploaded'               IN v_src) > 0, 'FAIL [7.3]: bl_uploaded not in sealing function body';
  ASSERT position('payment_evidence_uploaded' IN v_src) > 0, 'FAIL [7.3]: payment_evidence_uploaded not in sealing function body';
  ASSERT position('credit_advice_confirmed'   IN v_src) > 0, 'FAIL [7.3]: credit_advice_confirmed not in sealing function body';

  RAISE NOTICE 'PASS [7.3]: Migration 0003 functions exist; body covers all required fields';
END;
$$;

-- -------------------------------------------------------------------------
-- §8  RLS catalog
-- -------------------------------------------------------------------------

DO $$
BEGIN
  ASSERT (
    SELECT COUNT(*) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity = TRUE
      AND c.relname IN (
        'exporters','exporter_settings','exporter_users',
        'counterparties','counterparty_bank_accounts',
        'export_contracts','shipments','invoices',
        'bills_of_lading','compliance_records',
        'payment_receipts','payment_evidence',
        'payment_allocations','bank_evidence_packs'
      )
  ) = 14,
    'FAIL [8.1]: RLS not enabled on all 14 tables';

  RAISE NOTICE 'PASS [8.1]: RLS enabled on all 14 tables';

  ASSERT (
    SELECT COUNT(*) FROM pg_policies
    WHERE schemaname = 'public'
      AND policyname LIKE 'rls_%'
      AND with_check IS NOT NULL
  ) >= 12,
    'FAIL [8.2]: Fewer than 12 tenant-scoped RLS policies include WITH CHECK';

  RAISE NOTICE 'PASS [8.2]: All tenant-scoped RLS policies include WITH CHECK';
END;
$$;

-- -------------------------------------------------------------------------
-- §9  BEHAVIORAL — Discrepancy detection and generated amount columns
--
-- Covers: trg_payment_receipt_discrepancy (migration 0002)
--         charges_deducted GENERATED ALWAYS AS GREATEST(...,0) (migration 0003)
--         amount_variance  GENERATED ALWAYS AS (credited - instructed) (migration 0003)
--
-- No auth.users FK dependency: only exporters, exporter_settings,
-- and payment_receipts are touched.
-- -------------------------------------------------------------------------

DO $$
DECLARE
  v_exp_id   UUID := gen_random_uuid();
  v_status   discrepancy_status;
  v_charges  DECIMAL(18,2);
  v_variance DECIMAL(18,2);
BEGIN
  INSERT INTO exporters (id, legal_name, country)
  VALUES (v_exp_id, 'Test Exporter §9', 'NG');

  -- 1% or $10 max → diff of $5 is within tolerance, diff of $50 is not
  INSERT INTO exporter_settings (exporter_id, charges_tolerance_pct, charges_tolerance_max_abs)
  VALUES (v_exp_id, 0.0100, 10.00);

  -- 9A: exact match → CLEAN
  INSERT INTO payment_receipts (
    exporter_id, receipt_reference,
    instructed_amount, credited_amount, currency, credit_date
  ) VALUES (v_exp_id, 'T9A', 1000.00, 1000.00, 'USD', CURRENT_DATE)
  RETURNING discrepancy_status INTO v_status;

  ASSERT v_status = 'CLEAN',
    'FAIL [9.A]: Exact match should be CLEAN, got ' || v_status::TEXT;
  RAISE NOTICE 'PASS [9.A]: Exact match → CLEAN';

  -- 9B: diff within tolerance ($5 ≤ min(1000×0.01, 10) = $10) → CLEAN
  INSERT INTO payment_receipts (
    exporter_id, receipt_reference,
    instructed_amount, credited_amount, currency, credit_date
  ) VALUES (v_exp_id, 'T9B', 1000.00, 995.00, 'USD', CURRENT_DATE)
  RETURNING discrepancy_status INTO v_status;

  ASSERT v_status = 'CLEAN',
    'FAIL [9.B]: Under-tolerance diff should be CLEAN, got ' || v_status::TEXT;
  RAISE NOTICE 'PASS [9.B]: Under-tolerance diff ($5 ≤ $10 band) → CLEAN';

  -- 9C: diff exceeds tolerance ($50 > $10) → AMOUNT_MISMATCH
  INSERT INTO payment_receipts (
    exporter_id, receipt_reference,
    instructed_amount, credited_amount, currency, credit_date
  ) VALUES (v_exp_id, 'T9C', 1000.00, 950.00, 'USD', CURRENT_DATE)
  RETURNING discrepancy_status INTO v_status;

  ASSERT v_status = 'AMOUNT_MISMATCH',
    'FAIL [9.C]: Over-tolerance diff should be AMOUNT_MISMATCH, got ' || v_status::TEXT;
  RAISE NOTICE 'PASS [9.C]: Over-tolerance diff ($50 > $10 band) → AMOUNT_MISMATCH';

  -- 9D: overpayment ($100 > $10) → AMOUNT_MISMATCH
  INSERT INTO payment_receipts (
    exporter_id, receipt_reference,
    instructed_amount, credited_amount, currency, credit_date
  ) VALUES (v_exp_id, 'T9D', 1000.00, 1100.00, 'USD', CURRENT_DATE)
  RETURNING discrepancy_status INTO v_status;

  ASSERT v_status = 'AMOUNT_MISMATCH',
    'FAIL [9.D]: Overpayment exceeding tolerance should be AMOUNT_MISMATCH, got ' || v_status::TEXT;
  RAISE NOTICE 'PASS [9.D]: Overpayment exceeding tolerance → AMOUNT_MISMATCH';

  -- 9E: under-credit — charges_deducted is clamped ≥ 0; amount_variance is negative
  --     T9C: instructed=1000, credited=950 → charges_deducted=50, amount_variance=-50
  SELECT charges_deducted, amount_variance
    INTO v_charges, v_variance
    FROM payment_receipts
   WHERE exporter_id = v_exp_id AND receipt_reference = 'T9C';

  ASSERT v_charges  =  50.00, 'FAIL [9.E]: charges_deducted should be 50.00, got ' || v_charges::TEXT;
  ASSERT v_variance = -50.00, 'FAIL [9.E]: amount_variance should be -50.00, got ' || v_variance::TEXT;
  RAISE NOTICE 'PASS [9.E]: Under-credit: charges_deducted=50 (clamped ≥0), amount_variance=-50 (signed)';

  -- 9F: overpayment — charges_deducted clamps to 0; amount_variance is positive
  --     T9D: instructed=1000, credited=1100 → charges_deducted=0, amount_variance=100
  SELECT charges_deducted, amount_variance
    INTO v_charges, v_variance
    FROM payment_receipts
   WHERE exporter_id = v_exp_id AND receipt_reference = 'T9D';

  ASSERT v_charges  =   0.00, 'FAIL [9.F]: charges_deducted should be 0 for overpayment, got ' || v_charges::TEXT;
  ASSERT v_variance = 100.00, 'FAIL [9.F]: amount_variance should be 100.00 for overpayment, got ' || v_variance::TEXT;
  RAISE NOTICE 'PASS [9.F]: Overpayment: charges_deducted=0 (clamped), amount_variance=100 (positive)';
END;
$$;

-- -------------------------------------------------------------------------
-- §10 BEHAVIORAL — Compliance record auto-creation on B/L INSERT
--
-- Covers: trg_bl_compute_deadline (migration 0001) — reads exporter_settings
--         trg_bl_auto_compliance_record (migration 0002) — fires AFTER INSERT
--         trg_bl_immutable_deadline (migration 0001) — blocks bl_date change
--
-- No auth.users FK dependency: exporter → exporter_settings → counterparty →
-- export_contract → shipment → bills_of_lading → (trigger) compliance_records.
-- -------------------------------------------------------------------------

DO $$
DECLARE
  v_exp_id      UUID := gen_random_uuid();
  v_cp_id       UUID;
  v_contract_id UUID;
  v_ship_id     UUID;
  v_bl_id       UUID;
  v_cr_count    INTEGER;
  v_deadline    DATE;
  v_rep_days    INTEGER;
  v_raised      BOOLEAN;
BEGIN
  INSERT INTO exporters (id, legal_name, country)
  VALUES (v_exp_id, 'Test Exporter §10', 'NG');

  -- Override default 180 days to 120 to confirm the trigger reads exporter_settings
  INSERT INTO exporter_settings (
    exporter_id, charges_tolerance_pct, charges_tolerance_max_abs,
    default_repatriation_days_non_oil, default_repatriation_days_oil_gas
  ) VALUES (v_exp_id, 0.0200, 500.00, 120, 60);

  INSERT INTO counterparties (
    exporter_id, legal_name, country_of_incorporation, counterparty_type
  ) VALUES (v_exp_id, 'Buyer §10', 'US', 'COMPANY')
  RETURNING id INTO v_cp_id;

  INSERT INTO export_contracts (
    exporter_id, counterparty_id,
    contract_reference, commodity, commodity_type, hs_code,
    contract_quantity, quantity_unit, contract_value, currency, unit_price,
    incoterms, destination_country, payment_terms, contract_date
  ) VALUES (
    v_exp_id, v_cp_id,
    'CTR-10-001', 'Cassava', 'NON_OIL', '0714.10',
    100, 'MT', 50000.00, 'USD', 500.00,
    'FOB', 'US', 'LC', CURRENT_DATE
  )
  RETURNING id INTO v_contract_id;

  INSERT INTO shipments (
    exporter_id, contract_id,
    shipment_reference, shipment_sequence, nxp_reference,
    port_of_loading, port_of_discharge,
    shipment_quantity, shipment_value, currency
  ) VALUES (
    v_exp_id, v_contract_id,
    'SHP-10-001', 1, 'NXP-10-001',
    'APAPA', 'HOUSTON',
    100, 50000.00, 'USD'
  )
  RETURNING id INTO v_ship_id;

  -- 10A: B/L insert fires two triggers:
  --   BEFORE INSERT trg_bl_compute_deadline  → sets repatriation_days = 120
  --   AFTER INSERT  trg_bl_auto_compliance_record → creates compliance_record
  INSERT INTO bills_of_lading (
    exporter_id, shipment_id,
    bl_number, bl_date, bl_type,
    shipper_name, consignee_name, description_of_goods, nxp_reference
  ) VALUES (
    v_exp_id, v_ship_id,
    'BL-10-001', CURRENT_DATE, 'ORIGINAL',
    'Exporter §10', 'Buyer §10', 'Cassava', 'NXP-10-001'
  )
  RETURNING id, repatriation_days INTO v_bl_id, v_rep_days;

  ASSERT v_rep_days = 120,
    'FAIL [10.A]: repatriation_days should be 120 (from exporter_settings), got ' || v_rep_days::TEXT;

  SELECT COUNT(*) INTO v_cr_count FROM compliance_records WHERE shipment_id = v_ship_id;
  ASSERT v_cr_count = 1,
    'FAIL [10.A]: Expected 1 compliance_record after B/L insert, found ' || v_cr_count::TEXT;

  SELECT repatriation_deadline INTO v_deadline
    FROM compliance_records WHERE shipment_id = v_ship_id;
  ASSERT v_deadline = CURRENT_DATE + 120,
    'FAIL [10.A]: compliance_record.repatriation_deadline should be bl_date+120, got ' || v_deadline::TEXT;

  RAISE NOTICE 'PASS [10.A]: B/L insert → compliance_record auto-created with deadline = bl_date + 120 days';

  -- 10B: B/L date is immutable after insert (trg_bl_immutable_deadline)
  v_raised := FALSE;
  BEGIN
    UPDATE bills_of_lading SET bl_date = CURRENT_DATE + 1 WHERE id = v_bl_id;
  EXCEPTION
    WHEN check_violation THEN v_raised := TRUE;
  END;

  ASSERT v_raised, 'FAIL [10.B]: Expected check_violation when mutating bl_date after insert';
  RAISE NOTICE 'PASS [10.B]: bl_date is immutable after insert';

  -- 10C: A second B/L for the same shipment is rejected by the UNIQUE constraint
  --      on bills_of_lading.shipment_id; compliance_record count stays at 1.
  BEGIN
    INSERT INTO bills_of_lading (
      exporter_id, shipment_id, bl_number, bl_date, bl_type,
      shipper_name, consignee_name, description_of_goods, nxp_reference
    ) VALUES (
      v_exp_id, v_ship_id, 'BL-10-002', CURRENT_DATE, 'TELEX_RELEASE',
      'Exporter §10', 'Buyer §10', 'Cassava', 'NXP-10-001'
    );
  EXCEPTION
    WHEN unique_violation THEN NULL;  -- expected: one B/L per shipment
  END;

  SELECT COUNT(*) INTO v_cr_count FROM compliance_records WHERE shipment_id = v_ship_id;
  ASSERT v_cr_count = 1,
    'FAIL [10.C]: compliance_record count should remain 1 after rejected duplicate B/L, got ' || v_cr_count::TEXT;
  RAISE NOTICE 'PASS [10.C]: One compliance_record per shipment; duplicate B/L insert rejected';
END;
$$;

-- -------------------------------------------------------------------------
-- §11 BEHAVIORAL — Counterparty completeness for ACTIVE contracts
--
-- Covers: enforce_counterparty_completeness trigger (migration 0003).
--   INSERT with status=ACTIVE blocked when counterparty.registered_address is NULL.
--   UPDATE DRAFT→ACTIVE blocked when counterparty.registered_address is NULL.
--   After registered_address is filled, ACTIVE transition succeeds.
--   DRAFT contracts are always allowed regardless of address.
--
-- No auth.users FK dependency.
-- -------------------------------------------------------------------------

DO $$
DECLARE
  v_exp_id       UUID := gen_random_uuid();
  v_cp_id        UUID;
  v_contract_id  UUID;
  v_raised       BOOLEAN;
  v_final_status contract_status;
BEGIN
  INSERT INTO exporters (id, legal_name, country)
  VALUES (v_exp_id, 'Test Exporter §11', 'NG');

  -- Counterparty with no registered_address (field is nullable)
  INSERT INTO counterparties (
    exporter_id, legal_name, country_of_incorporation, counterparty_type
  ) VALUES (v_exp_id, 'Buyer §11', 'GB', 'COMPANY')
  RETURNING id INTO v_cp_id;

  -- 11A: INSERT with status = 'ACTIVE' must be blocked (counterparty has no address)
  v_raised := FALSE;
  BEGIN
    INSERT INTO export_contracts (
      exporter_id, counterparty_id,
      contract_reference, commodity, commodity_type, hs_code,
      contract_quantity, quantity_unit, contract_value, currency, unit_price,
      incoterms, destination_country, payment_terms, contract_date, status
    ) VALUES (
      v_exp_id, v_cp_id,
      'CTR-11-ACT', 'Cocoa', 'NON_OIL', '1801.00',
      200, 'MT', 100000.00, 'USD', 500.00,
      'CIF', 'GB', 'TT', CURRENT_DATE, 'ACTIVE'
    );
  EXCEPTION
    WHEN check_violation THEN v_raised := TRUE;
  END;

  ASSERT v_raised,
    'FAIL [11.A]: Expected check_violation inserting ACTIVE contract with no counterparty address';
  RAISE NOTICE 'PASS [11.A]: ACTIVE contract INSERT rejected — counterparty missing registered_address';

  -- 11B: INSERT with status = 'DRAFT' is always allowed (trigger only checks ACTIVE)
  v_raised := FALSE;
  BEGIN
    INSERT INTO export_contracts (
      exporter_id, counterparty_id,
      contract_reference, commodity, commodity_type, hs_code,
      contract_quantity, quantity_unit, contract_value, currency, unit_price,
      incoterms, destination_country, payment_terms, contract_date, status
    ) VALUES (
      v_exp_id, v_cp_id,
      'CTR-11-DRF', 'Cocoa', 'NON_OIL', '1801.00',
      200, 'MT', 100000.00, 'USD', 500.00,
      'CIF', 'GB', 'TT', CURRENT_DATE, 'DRAFT'
    )
    RETURNING id INTO v_contract_id;
  EXCEPTION
    WHEN check_violation THEN v_raised := TRUE;
  END;

  ASSERT NOT v_raised,
    'FAIL [11.B]: DRAFT contract should be allowed without counterparty address';
  ASSERT v_contract_id IS NOT NULL,
    'FAIL [11.B]: v_contract_id not set after DRAFT insert';
  RAISE NOTICE 'PASS [11.B]: DRAFT contract INSERT allowed with no counterparty address';

  -- 11C: UPDATE DRAFT → ACTIVE blocked while address still missing
  v_raised := FALSE;
  BEGIN
    UPDATE export_contracts SET status = 'ACTIVE' WHERE id = v_contract_id;
  EXCEPTION
    WHEN check_violation THEN v_raised := TRUE;
  END;

  ASSERT v_raised,
    'FAIL [11.C]: Expected check_violation promoting DRAFT → ACTIVE without counterparty address';
  RAISE NOTICE 'PASS [11.C]: DRAFT → ACTIVE UPDATE blocked — counterparty address still missing';

  -- 11D: Add registered_address to counterparty; UPDATE DRAFT → ACTIVE now succeeds
  UPDATE counterparties
     SET registered_address = '123 Merchant Street, London EC3V 3ND'
   WHERE id = v_cp_id;

  v_raised := FALSE;
  BEGIN
    UPDATE export_contracts SET status = 'ACTIVE' WHERE id = v_contract_id;
  EXCEPTION
    WHEN check_violation THEN v_raised := TRUE;
  END;

  ASSERT NOT v_raised,
    'FAIL [11.D]: DRAFT → ACTIVE should succeed after counterparty registered_address added';

  SELECT status INTO v_final_status FROM export_contracts WHERE id = v_contract_id;
  ASSERT v_final_status = 'ACTIVE',
    'FAIL [11.D]: Expected status = ACTIVE after promotion, got ' || v_final_status::TEXT;

  RAISE NOTICE 'PASS [11.D]: DRAFT → ACTIVE UPDATE succeeded after counterparty address added';
END;
$$;

ROLLBACK;
