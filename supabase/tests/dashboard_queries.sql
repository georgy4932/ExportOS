-- =============================================================================
-- ExportOS v0.2 — Dashboard Query Tests
-- Proves that the three views and trigger chain work correctly.
-- Wrapped in BEGIN/ROLLBACK: leaves no persistent data.
-- Requires superuser or service_role (BYPASSRLS).
-- =============================================================================
-- T1: v_export_contracts_summary   — shipment counts and allocated totals
-- T2: v_shipments_reconciliation   — fully_reconciled flag logic
-- T3: v_bills_of_lading_deadline   — all four deadline_status bands
-- T4: Compliance repatriation after allocation — COMPLETE vs PARTIAL
-- T5: Incomplete checklist blocks sealing  (BEGIN...EXCEPTION)
-- T6: Complete checklist allows sealing
-- =============================================================================

BEGIN;

DO $$
DECLARE
  -- -------------------------------------------------------------------------
  -- Auth user for FK columns (allocated_by, generated_by, uploaded_by).
  -- Rolled back with the rest of the transaction.
  -- -------------------------------------------------------------------------
  v_user_id     UUID := gen_random_uuid();

  -- -------------------------------------------------------------------------
  -- Core entity IDs
  -- -------------------------------------------------------------------------
  v_exporter_id UUID := gen_random_uuid();
  v_cp_id       UUID := gen_random_uuid();
  v_contract_id UUID := gen_random_uuid();

  -- Shipments: A=SAFE, B=WARNING, C=OVERDUE, D=CRITICAL (deadline band)
  v_ship_a UUID := gen_random_uuid();
  v_ship_b UUID := gen_random_uuid();
  v_ship_c UUID := gen_random_uuid();
  v_ship_d UUID := gen_random_uuid();

  v_bl_a UUID := gen_random_uuid();
  v_bl_b UUID := gen_random_uuid();
  v_bl_c UUID := gen_random_uuid();
  v_bl_d UUID := gen_random_uuid();

  v_receipt_a UUID := gen_random_uuid();
  v_receipt_b UUID := gen_random_uuid();

  v_alloc_a UUID := gen_random_uuid();
  v_alloc_b UUID := gen_random_uuid();

  v_pack_a UUID := gen_random_uuid();  -- all 5 checklist items TRUE → sealable
  v_pack_b UUID := gen_random_uuid();  -- only 3 of 5 TRUE → blocks seal

  -- -------------------------------------------------------------------------
  -- Result variables
  -- -------------------------------------------------------------------------
  v_shipment_count           BIGINT;
  v_total_shipped_value      DECIMAL(18,2);
  v_total_allocated_receipts DECIMAL(18,2);
  v_unallocated_value        DECIMAL(18,2);

  v_fully_reconciled_a BOOLEAN;
  v_fully_reconciled_b BOOLEAN;

  v_safe_count     BIGINT;
  v_warning_count  BIGINT;
  v_critical_count BIGINT;
  v_overdue_count  BIGINT;

  v_rep_status_a repatriation_status;
  v_rep_status_b repatriation_status;

  v_sealed BOOLEAN;
  v_raised BOOLEAN;

BEGIN

  -- ===========================================================================
  -- SETUP: auth user (rolled back at end of outer transaction)
  -- ===========================================================================

  INSERT INTO auth.users (
    id, instance_id, aud, role, email,
    encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at,
    confirmation_token, recovery_token,
    email_change_token_new, email_change
  ) VALUES (
    v_user_id,
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated',
    'test-dashboard@exportos.test',
    crypt('test-password', gen_salt('bf')),
    NOW(),
    '{"provider":"email","providers":["email"]}', '{}',
    NOW(), NOW(),
    '', '', '', ''
  );

  -- ===========================================================================
  -- SETUP: exporter + settings + counterparty + contract
  -- 4 shipments × 10,000 USD each = contract_value 40,000 USD
  -- ===========================================================================

  INSERT INTO exporters (id, legal_name, country)
    VALUES (v_exporter_id, '_dashboard_test_exporter_', 'NG');

  -- tolerance: 1% or $10 — tight band so exact-match receipts are clearly CLEAN
  INSERT INTO exporter_settings (
    exporter_id,
    charges_tolerance_pct,
    charges_tolerance_max_abs,
    default_repatriation_days_non_oil,
    default_repatriation_days_oil_gas
  ) VALUES (
    v_exporter_id, 0.0100, 10.00, 180, 90
  );

  INSERT INTO counterparties (
    id, exporter_id, legal_name,
    country_of_incorporation, counterparty_type,
    registered_address
  ) VALUES (
    v_cp_id, v_exporter_id,
    '_test_buyer_',
    'DE', 'COMPANY',
    '1 Test Strasse, Berlin, Germany'
  );

  -- contract_value = 4 × 10,000 = 40,000
  INSERT INTO export_contracts (
    id, contract_reference, exporter_id, counterparty_id,
    commodity, commodity_type, hs_code,
    contract_quantity, quantity_unit,
    contract_value, currency,
    unit_price, incoterms,
    destination_country, payment_terms,
    contract_date, status
  ) VALUES (
    v_contract_id, '_TEST-CTR-DQ-001_',
    v_exporter_id, v_cp_id,
    'Test Commodity', 'NON_OIL', '1207.40',
    40.0000, 'MT',
    40000.00, 'USD',
    1000.0000, 'CFR',
    'DE', 'T/T',
    CURRENT_DATE - 90, 'ACTIVE'
  );

  -- ===========================================================================
  -- SETUP: 4 shipments, each 10,000 USD / 10 MT
  -- shipment_sequence and nxp_reference are NOT NULL.
  -- vessel_name and voyage_number live on shipments, not on bills_of_lading.
  -- ===========================================================================

  INSERT INTO shipments (
    id, contract_id, exporter_id,
    shipment_reference, shipment_sequence, nxp_reference,
    port_of_loading, port_of_discharge,
    shipment_quantity, shipment_value, currency,
    status
  ) VALUES
    (v_ship_a, v_contract_id, v_exporter_id, 'SHP-DQ-A', 1, 'NXP-DQ-A', 'APAPA', 'HAMBURG', 10.0000, 10000.00, 'USD', 'PENDING'),
    (v_ship_b, v_contract_id, v_exporter_id, 'SHP-DQ-B', 2, 'NXP-DQ-B', 'APAPA', 'HAMBURG', 10.0000, 10000.00, 'USD', 'PENDING'),
    (v_ship_c, v_contract_id, v_exporter_id, 'SHP-DQ-C', 3, 'NXP-DQ-C', 'APAPA', 'HAMBURG', 10.0000, 10000.00, 'USD', 'PENDING'),
    (v_ship_d, v_contract_id, v_exporter_id, 'SHP-DQ-D', 4, 'NXP-DQ-D', 'APAPA', 'HAMBURG', 10.0000, 10000.00, 'USD', 'PENDING');

  -- ===========================================================================
  -- SETUP: bills of lading — one per shipment, bl_date chosen for each band
  --
  -- Repatriation window = 180 days (NON_OIL, default settings).
  -- deadline = bl_date + 180 (set by trg_bl_compute_deadline on INSERT).
  --
  -- With CURRENT_DATE as the reference point:
  --   SAFE     deadline > TODAY+30 → bl_date = TODAY-120 → deadline = TODAY+60
  --   WARNING  TODAY+7 < deadline ≤ TODAY+30 → bl_date = TODAY-160 → deadline = TODAY+20
  --   CRITICAL TODAY   < deadline ≤ TODAY+7  → bl_date = TODAY-175 → deadline = TODAY+5
  --   OVERDUE  deadline < TODAY              → bl_date = TODAY-181 → deadline = TODAY-1
  --
  -- bl_type:     ORIGINAL | TELEX_RELEASE | SEA_WAYBILL | EXPRESS_BL
  -- freight_terms: PREPAID | COLLECT (nullable)
  -- shipper_name, consignee_name, description_of_goods: NOT NULL
  -- nxp_reference: NOT NULL (separate from shipments.nxp_reference)
  -- No vessel_name / voyage_number on bills_of_lading.
  --
  -- trg_bl_auto_compliance_record fires AFTER INSERT → creates compliance_records.
  -- ===========================================================================

  INSERT INTO bills_of_lading (
    id, shipment_id, exporter_id,
    bl_number, bl_date, bl_type,
    shipper_name, consignee_name, description_of_goods,
    nxp_reference, freight_terms
  ) VALUES
    (v_bl_a, v_ship_a, v_exporter_id, 'BL-DQ-A', CURRENT_DATE - 120, 'ORIGINAL',
     '_test_shipper_', '_test_consignee_', 'Test Commodity 10 MT', 'NXP-DQ-A', 'PREPAID'),
    (v_bl_b, v_ship_b, v_exporter_id, 'BL-DQ-B', CURRENT_DATE - 160, 'ORIGINAL',
     '_test_shipper_', '_test_consignee_', 'Test Commodity 10 MT', 'NXP-DQ-B', 'PREPAID'),
    (v_bl_c, v_ship_c, v_exporter_id, 'BL-DQ-C', CURRENT_DATE - 181, 'ORIGINAL',
     '_test_shipper_', '_test_consignee_', 'Test Commodity 10 MT', 'NXP-DQ-C', 'PREPAID'),
    (v_bl_d, v_ship_d, v_exporter_id, 'BL-DQ-D', CURRENT_DATE - 175, 'ORIGINAL',
     '_test_shipper_', '_test_consignee_', 'Test Commodity 10 MT', 'NXP-DQ-D', 'PREPAID');

  -- Compliance records auto-created by trg_bl_auto_compliance_record.

  -- Advance all 4 shipments to DEPARTED so allocation trigger mirrors to shipment status.
  UPDATE shipments
     SET status = 'DEPARTED'
   WHERE id IN (v_ship_a, v_ship_b, v_ship_c, v_ship_d);

  -- ===========================================================================
  -- SETUP: receipts and allocations
  --   Receipt A: instructed=10,000  credited=10,000 → diff=0 → CLEAN
  --   Receipt B: instructed=5,000   credited=5,000  → diff=0 → CLEAN
  --   Alloc A: 10,000 to Ship A → receipt FULLY_ALLOCATED, compliance COMPLETE
  --   Alloc B:  5,000 to Ship B → receipt PARTIALLY_ALLOCATED, compliance PARTIAL
  -- ===========================================================================

  INSERT INTO payment_receipts (
    id, exporter_id, receipt_reference,
    instructed_amount, credited_amount, currency, credit_date
  ) VALUES
    (v_receipt_a, v_exporter_id, '_RCPT-DQ-A_', 10000.00, 10000.00, 'USD', CURRENT_DATE - 30),
    (v_receipt_b, v_exporter_id, '_RCPT-DQ-B_',  5000.00,  5000.00, 'USD', CURRENT_DATE - 20);

  INSERT INTO payment_allocations (
    id, exporter_id, receipt_id, shipment_id,
    allocated_amount, allocation_method, allocation_date, allocated_by
  ) VALUES
    (v_alloc_a, v_exporter_id, v_receipt_a, v_ship_a,
     10000.00, 'MANUAL', CURRENT_DATE - 29, v_user_id),
    (v_alloc_b, v_exporter_id, v_receipt_b, v_ship_b,
      5000.00, 'MANUAL', CURRENT_DATE - 19, v_user_id);

  -- ===========================================================================
  -- SETUP: compliance checklists for pack sealing tests
  --   Pack A ship: all 5 preconditions TRUE → sealable
  --   Pack B ship: only nxp_approved + bl_uploaded + payment_evidence_uploaded TRUE → blocks seal
  -- ===========================================================================

  UPDATE compliance_records
     SET nxp_approved              = TRUE,
         cci_obtained              = TRUE,
         bl_uploaded               = TRUE,
         payment_evidence_uploaded = TRUE,
         credit_advice_confirmed   = TRUE,
         bank_evidence_pack_generated = TRUE
   WHERE shipment_id = v_ship_a;

  UPDATE compliance_records
     SET nxp_approved              = TRUE,
         bl_uploaded               = TRUE,
         payment_evidence_uploaded = TRUE
   WHERE shipment_id = v_ship_b;

  -- ===========================================================================
  -- SETUP: bank_evidence_packs (both start unsealed)
  -- ===========================================================================

  INSERT INTO bank_evidence_packs (
    id, shipment_id, exporter_id, version, generated_by,
    contract_snapshot, shipment_snapshot,
    invoice_ids, bl_id, nxp_reference,
    payment_evidence_ids, receipt_ids, allocation_ids,
    compliance_status_snapshot, repatriation_status, sealed
  ) VALUES
    (
      v_pack_a, v_ship_a, v_exporter_id, 1, v_user_id,
      '{"ref":"_TEST-CTR-DQ-001_"}', '{"ref":"SHP-DQ-A"}',
      '{}', v_bl_a, 'NXP-DQ-A',
      '{}', '{}', '{}',
      '{"nxp_approved":true,"cci_obtained":true,"bl_uploaded":true,"payment_evidence_uploaded":true,"credit_advice_confirmed":true}',
      'COMPLETE', FALSE
    ),
    (
      v_pack_b, v_ship_b, v_exporter_id, 1, v_user_id,
      '{"ref":"_TEST-CTR-DQ-001_"}', '{"ref":"SHP-DQ-B"}',
      '{}', v_bl_b, 'NXP-DQ-B',
      '{}', '{}', '{}',
      '{"nxp_approved":true,"cci_obtained":false,"bl_uploaded":true,"payment_evidence_uploaded":true,"credit_advice_confirmed":false}',
      'PARTIAL', FALSE
    );

  -- ===========================================================================
  -- T1: v_export_contracts_summary
  --     4 shipments × 10,000 = total_shipped_value 40,000
  --     alloc_a(10,000) + alloc_b(5,000) = total_allocated_receipts 15,000
  --     unallocated = 40,000 − 15,000 = 25,000
  -- ===========================================================================

  SELECT shipment_count, total_shipped_value,
         total_allocated_receipts, unallocated_contract_value
    INTO v_shipment_count, v_total_shipped_value,
         v_total_allocated_receipts, v_unallocated_value
    FROM v_export_contracts_summary
   WHERE id = v_contract_id;

  ASSERT v_shipment_count = 4,
    format('T1 FAIL: expected shipment_count=4, got %s', v_shipment_count);
  ASSERT v_total_shipped_value = 40000.00,
    format('T1 FAIL: expected total_shipped_value=40000, got %s', v_total_shipped_value);
  ASSERT v_total_allocated_receipts = 15000.00,
    format('T1 FAIL: expected total_allocated_receipts=15000, got %s', v_total_allocated_receipts);
  ASSERT v_unallocated_value = 25000.00,
    format('T1 FAIL: expected unallocated_contract_value=25000, got %s', v_unallocated_value);

  RAISE NOTICE 'PASS [T1]: v_export_contracts_summary — shipment_count=4, shipped=40000, allocated=15000, unallocated=25000';

  -- ===========================================================================
  -- T2: v_shipments_reconciliation
  --     Ship A: allocated 10,000 = shipment_value 10,000 → fully_reconciled TRUE
  --     Ship B: allocated  5,000 < shipment_value 10,000 → fully_reconciled FALSE
  -- ===========================================================================

  SELECT fully_reconciled INTO v_fully_reconciled_a
    FROM v_shipments_reconciliation WHERE id = v_ship_a;
  SELECT fully_reconciled INTO v_fully_reconciled_b
    FROM v_shipments_reconciliation WHERE id = v_ship_b;

  ASSERT v_fully_reconciled_a = TRUE,
    format('T2 FAIL: Ship A should be fully_reconciled, got %s', v_fully_reconciled_a);
  ASSERT v_fully_reconciled_b = FALSE,
    format('T2 FAIL: Ship B should NOT be fully_reconciled, got %s', v_fully_reconciled_b);

  RAISE NOTICE 'PASS [T2]: v_shipments_reconciliation — Ship A fully reconciled, Ship B not';

  -- ===========================================================================
  -- T3: v_bills_of_lading_deadline
  --     Exactly 1 B/L in each of the four deadline_status bands.
  --     Counts are scoped to this test's exporter_id to avoid interference
  --     from any persistent seed data present in the same database.
  -- ===========================================================================

  SELECT COUNT(*) FILTER (WHERE deadline_status = 'SAFE')     INTO v_safe_count
    FROM v_bills_of_lading_deadline WHERE exporter_id = v_exporter_id;
  SELECT COUNT(*) FILTER (WHERE deadline_status = 'WARNING')   INTO v_warning_count
    FROM v_bills_of_lading_deadline WHERE exporter_id = v_exporter_id;
  SELECT COUNT(*) FILTER (WHERE deadline_status = 'CRITICAL')  INTO v_critical_count
    FROM v_bills_of_lading_deadline WHERE exporter_id = v_exporter_id;
  SELECT COUNT(*) FILTER (WHERE deadline_status = 'OVERDUE')   INTO v_overdue_count
    FROM v_bills_of_lading_deadline WHERE exporter_id = v_exporter_id;

  ASSERT v_safe_count = 1,
    format('T3 FAIL: expected 1 SAFE B/L, got %s', v_safe_count);
  ASSERT v_warning_count = 1,
    format('T3 FAIL: expected 1 WARNING B/L, got %s', v_warning_count);
  ASSERT v_critical_count = 1,
    format('T3 FAIL: expected 1 CRITICAL B/L, got %s', v_critical_count);
  ASSERT v_overdue_count = 1,
    format('T3 FAIL: expected 1 OVERDUE B/L, got %s', v_overdue_count);

  RAISE NOTICE 'PASS [T3]: v_bills_of_lading_deadline — SAFE=1, WARNING=1, CRITICAL=1, OVERDUE=1';

  -- ===========================================================================
  -- T4: Compliance repatriation_status after allocation
  --     Ship A: allocated 10,000 = proceeds_required 10,000 → COMPLETE
  --     Ship B: allocated  5,000 < proceeds_required 10,000 → PARTIAL
  -- ===========================================================================

  SELECT repatriation_status INTO v_rep_status_a
    FROM compliance_records WHERE shipment_id = v_ship_a;
  SELECT repatriation_status INTO v_rep_status_b
    FROM compliance_records WHERE shipment_id = v_ship_b;

  ASSERT v_rep_status_a = 'COMPLETE',
    format('T4 FAIL: Ship A compliance should be COMPLETE, got %s', v_rep_status_a);
  ASSERT v_rep_status_b = 'PARTIAL',
    format('T4 FAIL: Ship B compliance should be PARTIAL, got %s', v_rep_status_b);

  RAISE NOTICE 'PASS [T4]: compliance repatriation — Ship A=COMPLETE, Ship B=PARTIAL';

  -- ===========================================================================
  -- T5: Incomplete checklist blocks sealing (Pack B)
  --     cci_obtained=FALSE and credit_advice_confirmed=FALSE → trigger raises.
  -- ===========================================================================

  v_raised := FALSE;
  BEGIN
    UPDATE bank_evidence_packs SET sealed = TRUE WHERE id = v_pack_b;
  EXCEPTION
    WHEN check_violation THEN v_raised := TRUE;
    WHEN OTHERS          THEN v_raised := TRUE;
  END;

  ASSERT v_raised = TRUE,
    'T5 FAIL: sealing an incomplete evidence pack should have raised an error';

  SELECT sealed INTO v_sealed FROM bank_evidence_packs WHERE id = v_pack_b;
  ASSERT v_sealed = FALSE,
    format('T5 FAIL: Pack B should still be unsealed after failed attempt, got sealed=%s', v_sealed);

  RAISE NOTICE 'PASS [T5]: incomplete checklist blocks pack sealing';

  -- ===========================================================================
  -- T6: Complete checklist allows sealing (Pack A)
  --     All 5 preconditions TRUE → UPDATE sealed=TRUE succeeds.
  -- ===========================================================================

  UPDATE bank_evidence_packs SET sealed = TRUE WHERE id = v_pack_a;

  SELECT sealed INTO v_sealed FROM bank_evidence_packs WHERE id = v_pack_a;
  ASSERT v_sealed = TRUE,
    format('T6 FAIL: Pack A should now be sealed, got sealed=%s', v_sealed);

  RAISE NOTICE 'PASS [T6]: complete checklist allows pack sealing';

  RAISE NOTICE '=== ALL DASHBOARD QUERY TESTS PASSED ===';

END;
$$;

ROLLBACK;
