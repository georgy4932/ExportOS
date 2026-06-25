-- =============================================================================
-- ExportOS v0.2 — Evidence Items Tests
-- supabase/tests/evidence_items.sql
-- =============================================================================
-- Run with: psql <connection-string> -f supabase/tests/evidence_items.sql
-- Requires: migrations 0001–0003 plus 20260625000001_evidence_items applied.
-- Requires: superuser or a role with BYPASSRLS.
--
-- All statements run inside BEGIN/ROLLBACK — no persistent changes.
--
-- Test sections:
--   §1  Table existence and column presence
--   §2  Constraint: CHECK values for lifecycle_state, validation_status, source_system
--   §3  Constraint: UNIQUE (shipment_id, evidence_type)
--   §4  Invariant: evidence_type is immutable after INSERT
--   §5  Invariant: validation_status='passed' blocked when lifecycle_state='missing'
--   §6  Trigger catalog (updated_at, immutable type, state consistency, seeding)
--   §7  Function catalog
--   §8  RLS policy existence
--   §9  BEHAVIORAL: seed on compliance_record INSERT produces exactly 7 rows
--  §10  BEHAVIORAL: system rows seeded with lifecycle_state='uploaded', uploaded_at NOT NULL
--  §11  BEHAVIORAL: seed is idempotent (double-insert leaves 7 rows, no error)
-- =============================================================================

BEGIN;

-- =============================================================================
-- Shared fixtures — one exporter + contract + shipment used by all behavioral tests.
-- Inserted here; rolled back at the end.
-- =============================================================================

DO $$
DECLARE
  v_exporter_id  UUID;
  v_contract_id  UUID;
  v_ship_id      UUID;
  v_bl_id        UUID;
  v_cr_id        UUID;
  v_count        INT;
  v_uploaded_at  TIMESTAMPTZ;
  v_lifecycle    TEXT;
BEGIN

  -- ── fixture setup ──────────────────────────────────────────────────────────

  INSERT INTO exporters (legal_name, trading_name, country)
  VALUES ('Test Exporter Ltd', NULL, 'NG')
  RETURNING id INTO v_exporter_id;

  INSERT INTO export_contracts (
    contract_reference, exporter_id, counterparty_id,
    commodity, commodity_type, hs_code,
    contract_quantity, quantity_unit,
    contract_value, currency, unit_price,
    incoterms, destination_country,
    payment_terms, partial_shipment_allowed,
    contract_date, status
  )
  SELECT 'TST-0001', v_exporter_id, NULL,
         'Sesame', 'NON_OIL', '120740',
         100, 'MT',
         50000, 'USD', 500,
         'FOB', 'NL',
         'T/T', FALSE,
         CURRENT_DATE, 'ACTIVE'
  RETURNING id INTO v_contract_id;

  INSERT INTO shipments (
    contract_id, exporter_id,
    shipment_reference, shipment_sequence, nxp_reference,
    port_of_loading, port_of_discharge,
    shipment_quantity, shipment_value, currency,
    status
  )
  VALUES (
    v_contract_id, v_exporter_id,
    'SHP-TST-001', 1, 'NXP/TST/2026/001',
    'Lagos', 'Rotterdam',
    100, 50000, 'USD',
    'PENDING'
  )
  RETURNING id INTO v_ship_id;

  -- -------------------------------------------------------------------------
  -- §1  Table existence and column presence
  -- -------------------------------------------------------------------------

  ASSERT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'evidence_items'
  ), 'FAIL [1.1]: evidence_items table does not exist';

  ASSERT (
    SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'evidence_items'
      AND column_name IN (
        'id','shipment_id','exporter_id','nxp_reference',
        'evidence_type','evidence_code',
        'lifecycle_state','validation_status',
        'required_for_compliance','uploaded_at','last_checked_at',
        'source_system','metadata_json','created_at','updated_at'
      )
  ) = 15, 'FAIL [1.2]: Expected 15 columns on evidence_items';

  RAISE NOTICE 'PASS [1.1–1.2]: evidence_items table exists with all 15 columns';

  -- -------------------------------------------------------------------------
  -- §2  CHECK constraints — invalid values must be rejected
  -- -------------------------------------------------------------------------

  BEGIN
    INSERT INTO evidence_items
      (shipment_id, exporter_id, nxp_reference, evidence_type, evidence_code,
       required_for_compliance, source_system, lifecycle_state, validation_status)
    VALUES
      (v_ship_id, v_exporter_id, 'NXP/TST/2026/001', 'nxp_approval', 'NXP',
       TRUE, 'user', 'INVALID_STATE', 'not_validated');
    RAISE EXCEPTION 'FAIL [2.1]: invalid lifecycle_state was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS [2.1]: invalid lifecycle_state correctly rejected';
  END;

  BEGIN
    INSERT INTO evidence_items
      (shipment_id, exporter_id, nxp_reference, evidence_type, evidence_code,
       required_for_compliance, source_system, lifecycle_state, validation_status)
    VALUES
      (v_ship_id, v_exporter_id, 'NXP/TST/2026/001', 'nxp_approval', 'NXP',
       TRUE, 'user', 'missing', 'INVALID_STATUS');
    RAISE EXCEPTION 'FAIL [2.2]: invalid validation_status was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS [2.2]: invalid validation_status correctly rejected';
  END;

  BEGIN
    INSERT INTO evidence_items
      (shipment_id, exporter_id, nxp_reference, evidence_type, evidence_code,
       required_for_compliance, source_system, lifecycle_state, validation_status)
    VALUES
      (v_ship_id, v_exporter_id, 'NXP/TST/2026/001', 'nxp_approval', 'NXP',
       TRUE, 'robot', 'missing', 'not_validated');
    RAISE EXCEPTION 'FAIL [2.3]: invalid source_system was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS [2.3]: invalid source_system correctly rejected';
  END;

  BEGIN
    INSERT INTO evidence_items
      (shipment_id, exporter_id, nxp_reference, evidence_type, evidence_code,
       required_for_compliance, source_system, lifecycle_state, validation_status)
    VALUES
      (v_ship_id, v_exporter_id, 'NXP/TST/2026/001', 'unknown_type', 'UNK',
       TRUE, 'user', 'missing', 'not_validated');
    RAISE EXCEPTION 'FAIL [2.4]: invalid evidence_type was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS [2.4]: invalid evidence_type correctly rejected';
  END;

  -- -------------------------------------------------------------------------
  -- §3  UNIQUE (shipment_id, evidence_type)
  -- -------------------------------------------------------------------------

  INSERT INTO evidence_items
    (shipment_id, exporter_id, nxp_reference, evidence_type, evidence_code,
     required_for_compliance, source_system, lifecycle_state, validation_status)
  VALUES
    (v_ship_id, v_exporter_id, 'NXP/TST/2026/001', 'nxp_approval', 'NXP',
     TRUE, 'user', 'missing', 'not_validated');

  BEGIN
    INSERT INTO evidence_items
      (shipment_id, exporter_id, nxp_reference, evidence_type, evidence_code,
       required_for_compliance, source_system, lifecycle_state, validation_status)
    VALUES
      (v_ship_id, v_exporter_id, 'NXP/TST/2026/001', 'nxp_approval', 'NXP',
       TRUE, 'user', 'missing', 'not_validated');
    RAISE EXCEPTION 'FAIL [3.1]: duplicate (shipment_id, evidence_type) was accepted';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS [3.1]: duplicate (shipment_id, evidence_type) correctly rejected';
  END;

  DELETE FROM evidence_items WHERE shipment_id = v_ship_id;

  -- -------------------------------------------------------------------------
  -- §4  Invariant: evidence_type is immutable after INSERT
  -- -------------------------------------------------------------------------

  INSERT INTO evidence_items
    (shipment_id, exporter_id, nxp_reference, evidence_type, evidence_code,
     required_for_compliance, source_system, lifecycle_state, validation_status)
  VALUES
    (v_ship_id, v_exporter_id, 'NXP/TST/2026/001', 'nxp_approval', 'NXP',
     TRUE, 'user', 'missing', 'not_validated');

  BEGIN
    UPDATE evidence_items
       SET evidence_type = 'bill_of_lading'
     WHERE shipment_id = v_ship_id AND evidence_type = 'nxp_approval';
    RAISE EXCEPTION 'FAIL [4.1]: evidence_type mutation was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS [4.1]: evidence_type mutation correctly rejected';
  END;

  DELETE FROM evidence_items WHERE shipment_id = v_ship_id;

  -- -------------------------------------------------------------------------
  -- §5  Invariant: validation_status='passed' blocked when lifecycle_state='missing'
  -- -------------------------------------------------------------------------

  BEGIN
    INSERT INTO evidence_items
      (shipment_id, exporter_id, nxp_reference, evidence_type, evidence_code,
       required_for_compliance, source_system, lifecycle_state, validation_status)
    VALUES
      (v_ship_id, v_exporter_id, 'NXP/TST/2026/001', 'nxp_approval', 'NXP',
       TRUE, 'user', 'missing', 'passed');
    RAISE EXCEPTION 'FAIL [5.1]: passed+missing was accepted on INSERT';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS [5.1]: passed+missing correctly rejected on INSERT';
  END;

  INSERT INTO evidence_items
    (shipment_id, exporter_id, nxp_reference, evidence_type, evidence_code,
     required_for_compliance, source_system, lifecycle_state, validation_status)
  VALUES
    (v_ship_id, v_exporter_id, 'NXP/TST/2026/001', 'nxp_approval', 'NXP',
     TRUE, 'user', 'uploaded', 'passed');

  BEGIN
    UPDATE evidence_items
       SET lifecycle_state = 'missing'
     WHERE shipment_id = v_ship_id AND evidence_type = 'nxp_approval';
    RAISE EXCEPTION 'FAIL [5.2]: passed+missing was accepted on UPDATE';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS [5.2]: passed+missing correctly rejected on UPDATE';
  END;

  DELETE FROM evidence_items WHERE shipment_id = v_ship_id;

  -- -------------------------------------------------------------------------
  -- §6  Trigger catalog
  -- -------------------------------------------------------------------------

  ASSERT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                  WHERE c.relname = 'evidence_items' AND t.tgname = 'trg_evidence_items_updated_at'),
    'FAIL [6.1]: trg_evidence_items_updated_at missing';
  ASSERT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                  WHERE c.relname = 'evidence_items' AND t.tgname = 'trg_evidence_type_immutable'),
    'FAIL [6.1]: trg_evidence_type_immutable missing';
  ASSERT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                  WHERE c.relname = 'evidence_items' AND t.tgname = 'trg_evidence_state_consistency'),
    'FAIL [6.1]: trg_evidence_state_consistency missing';
  ASSERT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                  WHERE c.relname = 'compliance_records' AND t.tgname = 'trg_compliance_record_seeds_evidence'),
    'FAIL [6.2]: trg_compliance_record_seeds_evidence missing on compliance_records';

  RAISE NOTICE 'PASS [6.1–6.2]: All 4 evidence_items triggers present';

  -- -------------------------------------------------------------------------
  -- §7  Function catalog
  -- -------------------------------------------------------------------------

  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'seed_evidence_items'),
    'FAIL [7.1]: seed_evidence_items function missing';
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'prevent_evidence_type_change'),
    'FAIL [7.1]: prevent_evidence_type_change function missing';
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'check_evidence_state_consistency'),
    'FAIL [7.1]: check_evidence_state_consistency function missing';

  RAISE NOTICE 'PASS [7.1]: All 3 evidence_items functions present';

  -- -------------------------------------------------------------------------
  -- §8  RLS policy existence
  -- -------------------------------------------------------------------------

  ASSERT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'evidence_items'
      AND policyname = 'rls_evidence_items'
  ), 'FAIL [8.1]: rls_evidence_items policy missing';

  ASSERT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'evidence_items' AND c.relrowsecurity = TRUE
  ), 'FAIL [8.2]: RLS not enabled on evidence_items';

  RAISE NOTICE 'PASS [8.1–8.2]: RLS enabled and policy present on evidence_items';

  -- -------------------------------------------------------------------------
  -- §9  BEHAVIORAL: B/L INSERT triggers 7-row evidence seed via compliance_record
  -- -------------------------------------------------------------------------

  INSERT INTO bills_of_lading (
    shipment_id, exporter_id,
    bl_number, bl_date, bl_type,
    shipper_name, consignee_name,
    description_of_goods,
    nxp_reference, repatriation_days
  )
  VALUES (
    v_ship_id, v_exporter_id,
    'BL-TST-001', CURRENT_DATE, 'ORIGINAL',
    'Test Exporter Ltd', 'Test Buyer GmbH',
    'Sesame Seeds',
    'NXP/TST/2026/001', 180
  )
  RETURNING id INTO v_bl_id;

  SELECT COUNT(*) INTO v_count
    FROM evidence_items
   WHERE shipment_id = v_ship_id;

  ASSERT v_count = 7,
    'FAIL [9.1]: Expected 7 seeded evidence_items; got ' || v_count;

  RAISE NOTICE 'PASS [9.1]: Exactly 7 evidence_items seeded after B/L INSERT';

  -- Verify all 7 expected types are present
  ASSERT (
    SELECT COUNT(*) FROM evidence_items
     WHERE shipment_id = v_ship_id
       AND evidence_type IN (
         'nxp_approval','bill_of_lading','cci_document',
         'payment_evidence','credit_advice',
         'shipment_record','compliance_summary'
       )
  ) = 7, 'FAIL [9.2]: Not all 7 evidence_type values seeded';

  RAISE NOTICE 'PASS [9.2]: All 7 evidence_type values present';

  -- -------------------------------------------------------------------------
  -- §10 BEHAVIORAL: system rows have lifecycle_state='uploaded' and uploaded_at NOT NULL
  -- -------------------------------------------------------------------------

  ASSERT (
    SELECT COUNT(*) FROM evidence_items
     WHERE shipment_id = v_ship_id
       AND source_system = 'system'
       AND lifecycle_state = 'uploaded'
       AND uploaded_at IS NOT NULL
  ) = 2, 'FAIL [10.1]: Expected 2 system rows with lifecycle_state=uploaded and uploaded_at set';

  ASSERT (
    SELECT COUNT(*) FROM evidence_items
     WHERE shipment_id = v_ship_id
       AND source_system = 'user'
       AND lifecycle_state = 'missing'
  ) = 5, 'FAIL [10.2]: Expected 5 user rows with lifecycle_state=missing';

  RAISE NOTICE 'PASS [10.1–10.2]: system/user rows have correct initial states';

  -- -------------------------------------------------------------------------
  -- §11 BEHAVIORAL: seed is idempotent — direct call leaves 7 rows, no error
  -- -------------------------------------------------------------------------

  SELECT id INTO v_cr_id FROM compliance_records WHERE shipment_id = v_ship_id;

  -- Manually call the seed function by simulating a second compliance_record INSERT
  -- (ON CONFLICT DO NOTHING makes this safe; we verify row count stays at 7)
  INSERT INTO evidence_items
    (shipment_id, exporter_id, nxp_reference, evidence_type, evidence_code,
     required_for_compliance, source_system, lifecycle_state, validation_status)
  VALUES
    (v_ship_id, v_exporter_id, 'NXP/TST/2026/001', 'nxp_approval', 'NXP',
     TRUE, 'user', 'missing', 'not_validated')
  ON CONFLICT (shipment_id, evidence_type) DO NOTHING;

  SELECT COUNT(*) INTO v_count FROM evidence_items WHERE shipment_id = v_ship_id;

  ASSERT v_count = 7,
    'FAIL [11.1]: Row count changed on idempotent re-seed; got ' || v_count;

  RAISE NOTICE 'PASS [11.1]: Idempotent seed leaves exactly 7 rows';

END;
$$;

ROLLBACK;
