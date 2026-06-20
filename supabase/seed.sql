-- =============================================================================
-- ExportOS v0.2 — Seed Data
-- One realistic Nigerian non-oil exporter scenario: AKOBO AGRI-EXPORT COMPANY LTD
-- Covers: exporter → contract → 2 shipments → B/Ls → compliance (auto-created)
--         → invoices → receipts → evidence → allocations → evidence packs
-- Run with superuser or service_role (BYPASSRLS).
-- Idempotent: all inserts use ON CONFLICT DO NOTHING.
-- =============================================================================

BEGIN;

-- =============================================================================
-- HARDCODED UUIDs (stable across re-runs)
-- =============================================================================
-- a0b00000-0000-0000-0000-000000000001  auth user  (operator@akoboexports.ng)
-- b0b00001-0000-0000-0000-000000000001  exporter
-- b0b00001-0000-0000-0000-000000000002  counterparty
-- b0b00001-0000-0000-0000-000000000003  counterparty_bank_account
-- b0b00001-0000-0000-0000-000000000004  export_contract
-- b0b00001-0000-0000-0000-000000000005  shipment 1
-- b0b00001-0000-0000-0000-000000000006  shipment 2
-- b0b00001-0000-0000-0000-000000000007  invoice 1
-- b0b00001-0000-0000-0000-000000000008  invoice 2
-- b0b00001-0000-0000-0000-000000000009  bill_of_lading 1
-- b0b00001-0000-0000-0000-000000000010  bill_of_lading 2
-- b0b00001-0000-0000-0000-000000000011  payment_receipt 1
-- b0b00001-0000-0000-0000-000000000012  payment_receipt 2
-- b0b00001-0000-0000-0000-000000000013  payment_evidence 1
-- b0b00001-0000-0000-0000-000000000014  payment_evidence 2
-- b0b00001-0000-0000-0000-000000000015  payment_allocation 1
-- b0b00001-0000-0000-0000-000000000016  payment_allocation 2
-- b0b00001-0000-0000-0000-000000000017  bank_evidence_pack 1 (sealed)
-- b0b00001-0000-0000-0000-000000000018  bank_evidence_pack 2 (unsealed)

-- =============================================================================
-- §1  AUTH USER
-- Supabase auth.users row for the seed operator account.
-- =============================================================================

INSERT INTO auth.users (
  id, instance_id, aud, role, email,
  encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at,
  confirmation_token, recovery_token,
  email_change_token_new, email_change
) VALUES (
  'a0b00000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated',
  'authenticated',
  'operator@akoboexports.ng',
  crypt('dev-seed-password', gen_salt('bf')),
  NOW(),
  '{"provider":"email","providers":["email"]}',
  '{}',
  NOW(), NOW(),
  '', '', '', ''
) ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- §2  EXPORTER
-- registration_number = RC number; tin = Nigerian Tax ID.
-- =============================================================================

INSERT INTO exporters (
  id, legal_name, country, registration_number, tin
) VALUES (
  'b0b00001-0000-0000-0000-000000000001',
  'AKOBO AGRI-EXPORT COMPANY LTD',
  'NG',
  'RC-1047832',
  'NG-TIN-20190045321'
) ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- §3  EXPORTER SETTINGS
-- charges_tolerance_pct stored as decimal fraction: 2% = 0.0200.
-- charges_tolerance_max_abs: absolute cap of $500.
-- Effective tolerance per receipt = LEAST(instructed × 0.02, 500.00).
-- =============================================================================

INSERT INTO exporter_settings (
  exporter_id,
  charges_tolerance_pct,
  charges_tolerance_max_abs,
  default_repatriation_days_non_oil,
  default_repatriation_days_oil_gas
) VALUES (
  'b0b00001-0000-0000-0000-000000000001',
  0.0200,
  500.00,
  180,
  90
) ON CONFLICT (exporter_id) DO NOTHING;

-- =============================================================================
-- §4  EXPORTER USER
-- Maps the seed auth user to the exporter.
-- =============================================================================

INSERT INTO exporter_users (
  exporter_id, user_id, role
) VALUES (
  'b0b00001-0000-0000-0000-000000000001',
  'a0b00000-0000-0000-0000-000000000001',
  'ADMIN'
) ON CONFLICT (exporter_id, user_id) DO NOTHING;

-- =============================================================================
-- §5  COUNTERPARTY
-- counterparty_type must be COMPANY / INDIVIDUAL / GOVERNMENT_ENTITY.
-- country_of_incorporation (not country).
-- registered_address required before contract can be set ACTIVE.
-- =============================================================================

INSERT INTO counterparties (
  id, exporter_id, legal_name,
  country_of_incorporation, counterparty_type,
  registered_address, kyc_status
) VALUES (
  'b0b00001-0000-0000-0000-000000000002',
  'b0b00001-0000-0000-0000-000000000001',
  'EUROGRAIN HAMBURG GMBH',
  'DE',
  'COMPANY',
  'Spitalerstrasse 12, 20095 Hamburg, Germany',
  'VERIFIED'
) ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- §6  COUNTERPARTY BANK ACCOUNT
-- account_name is NOT NULL. No iban column exists — store IBAN as account_number.
-- =============================================================================

INSERT INTO counterparty_bank_accounts (
  id, counterparty_id, exporter_id,
  bank_name, bank_country, swift_bic,
  account_number, account_name,
  currency, is_primary
) VALUES (
  'b0b00001-0000-0000-0000-000000000003',
  'b0b00001-0000-0000-0000-000000000002',
  'b0b00001-0000-0000-0000-000000000001',
  'Deutsche Bank AG',
  'DE',
  'DEUTDEDB',
  'DE89370400440532013000',
  'EUROGRAIN HAMBURG GMBH',
  'USD',
  TRUE
) ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- §7  EXPORT CONTRACT
-- Required fields: commodity, hs_code, contract_quantity, quantity_unit,
--   unit_price, incoterms, destination_country, currency.
-- Sesame seeds HS code: 1207.40
-- =============================================================================

INSERT INTO export_contracts (
  id, contract_reference, exporter_id, counterparty_id,
  commodity, commodity_type, hs_code,
  contract_quantity, quantity_unit,
  contract_value, currency,
  unit_price, incoterms,
  destination_country, destination_port,
  payment_terms, partial_shipment_allowed,
  contract_date, status
) VALUES (
  'b0b00001-0000-0000-0000-000000000004',
  'CTR-2026-SES-001',
  'b0b00001-0000-0000-0000-000000000001',
  'b0b00001-0000-0000-0000-000000000002',
  'Sesame Seeds (hulled, natural, food grade)',
  'NON_OIL',
  '1207.40',
  100.0000,
  'MT',
  80000.00,
  'USD',
  800.0000,
  'CFR',
  'DE',
  'HAMBURG',
  'T/T 30 days after B/L date',
  TRUE,
  '2025-11-15',
  'ACTIVE'
) ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- §8  SHIPMENTS
-- shipment_sequence: required, must be unique within contract.
-- nxp_reference: required NOT NULL.
-- shipment_quantity (not quantity_mt). No shipment_date column.
-- vessel_name and voyage_number are on shipments (not bills_of_lading).
-- =============================================================================

INSERT INTO shipments (
  id, contract_id, exporter_id,
  shipment_reference, shipment_sequence, nxp_reference,
  port_of_loading, port_of_discharge,
  shipment_quantity, shipment_value, currency,
  vessel_name, voyage_number,
  status
) VALUES
  (
    'b0b00001-0000-0000-0000-000000000005',
    'b0b00001-0000-0000-0000-000000000004',
    'b0b00001-0000-0000-0000-000000000001',
    'SHP-2026-01', 1, 'NXP-2026-SES-001',
    'APAPA, LAGOS', 'HAMBURG, GERMANY',
    50.0000, 40000.00, 'USD',
    'MSC AURORA', 'AU2601W',
    'PENDING'
  ),
  (
    'b0b00001-0000-0000-0000-000000000006',
    'b0b00001-0000-0000-0000-000000000004',
    'b0b00001-0000-0000-0000-000000000001',
    'SHP-2026-02', 2, 'NXP-2026-SES-002',
    'APAPA, LAGOS', 'HAMBURG, GERMANY',
    50.0000, 40000.00, 'USD',
    'MSC AURORA', 'AU2602W',
    'PENDING'
  )
ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- §9  BILLS OF LADING
-- bl_type enum: ORIGINAL | TELEX_RELEASE | SEA_WAYBILL | EXPRESS_BL
-- freight_terms enum: PREPAID | COLLECT (nullable)
-- shipper_name, consignee_name, description_of_goods: NOT NULL
-- nxp_reference: NOT NULL (separate from shipments.nxp_reference)
-- vessel_name / voyage_number are NOT on bills_of_lading — they are on shipments.
--
-- Triggers fired on INSERT:
--   trg_bl_compute_deadline → repatriation_deadline = bl_date + 180
--   trg_bl_auto_compliance_record → creates compliance_records row
--
-- BL 1: bl_date 2026-01-20 → deadline 2026-07-19
-- BL 2: bl_date 2026-03-15 → deadline 2026-09-11
-- =============================================================================

INSERT INTO bills_of_lading (
  id, shipment_id, exporter_id,
  bl_number, bl_date, bl_type,
  shipper_name, consignee_name,
  description_of_goods,
  nxp_reference,
  freight_terms
) VALUES
  (
    'b0b00001-0000-0000-0000-000000000009',
    'b0b00001-0000-0000-0000-000000000005',
    'b0b00001-0000-0000-0000-000000000001',
    'MSC-APAPA-2601',
    '2026-01-20',
    'ORIGINAL',
    'AKOBO AGRI-EXPORT COMPANY LTD',
    'EUROGRAIN HAMBURG GMBH',
    'Sesame Seeds, hulled, natural, food grade, 50 MT',
    'NXP-2026-SES-001',
    'PREPAID'
  ),
  (
    'b0b00001-0000-0000-0000-000000000010',
    'b0b00001-0000-0000-0000-000000000006',
    'b0b00001-0000-0000-0000-000000000001',
    'MSC-APAPA-2602',
    '2026-03-15',
    'ORIGINAL',
    'AKOBO AGRI-EXPORT COMPANY LTD',
    'EUROGRAIN HAMBURG GMBH',
    'Sesame Seeds, hulled, natural, food grade, 50 MT',
    'NXP-2026-SES-002',
    'PREPAID'
  )
ON CONFLICT (id) DO NOTHING;

-- Compliance records auto-created by trg_bl_auto_compliance_record on each INSERT above.

-- =============================================================================
-- §10  INVOICES
-- invoice_number (not invoice_reference). currency column (not contract_currency).
-- =============================================================================

INSERT INTO invoices (
  id, contract_id, shipment_id, exporter_id,
  invoice_number, invoice_type,
  invoice_date, invoice_amount, currency
) VALUES
  (
    'b0b00001-0000-0000-0000-000000000007',
    'b0b00001-0000-0000-0000-000000000004',
    'b0b00001-0000-0000-0000-000000000005',
    'b0b00001-0000-0000-0000-000000000001',
    'INV-2026-001',
    'COMMERCIAL',
    '2026-01-20',
    40000.00,
    'USD'
  ),
  (
    'b0b00001-0000-0000-0000-000000000008',
    'b0b00001-0000-0000-0000-000000000004',
    'b0b00001-0000-0000-0000-000000000006',
    'b0b00001-0000-0000-0000-000000000001',
    'INV-2026-002',
    'PROFORMA',
    '2026-03-15',
    40000.00,
    'USD'
  )
ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- §11  PAYMENT RECEIPTS
-- discrepancy_status set automatically by trg_payment_receipt_discrepancy.
-- charges_deducted and amount_variance are GENERATED — not inserted.
--
-- Receipt 1: instructed=40,200  credited=40,000
--   tolerance = LEAST(40200 × 0.02, 500) = LEAST(804, 500) = 500
--   diff = 200 ≤ 500 → CLEAN
--
-- Receipt 2: instructed=16,000  credited=15,900
--   tolerance = LEAST(16000 × 0.02, 500) = LEAST(320, 500) = 320
--   diff = 100 ≤ 320 → CLEAN
-- =============================================================================

INSERT INTO payment_receipts (
  id, exporter_id,
  receipt_reference,
  instructed_amount, credited_amount,
  currency, credit_date, value_date,
  domiciliary_account_ref,
  ordering_bank_bic, ordering_customer_name,
  remittance_info
) VALUES
  (
    'b0b00001-0000-0000-0000-000000000011',
    'b0b00001-0000-0000-0000-000000000001',
    'RCPT-2026-001',
    40200.00, 40000.00,
    'USD', '2026-02-20', '2026-02-20',
    'DOM-AKOBO-USD-001',
    'DEUTDEDB', 'EUROGRAIN HAMBURG GMBH',
    'CTR-2026-SES-001 / SHP-2026-01 / INV-2026-001'
  ),
  (
    'b0b00001-0000-0000-0000-000000000012',
    'b0b00001-0000-0000-0000-000000000001',
    'RCPT-2026-002',
    16000.00, 15900.00,
    'USD', '2026-04-10', '2026-04-10',
    'DOM-AKOBO-USD-001',
    'DEUTDEDB', 'EUROGRAIN HAMBURG GMBH',
    'CTR-2026-SES-001 / SHP-2026-02 / INV-2026-002 (partial)'
  )
ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- §12  PAYMENT EVIDENCE
-- BANK_CREDIT_ADVICE type with the six extra columns added by migration 0002:
--   credited_amount, credited_currency, credit_date, bank_ref, payer_account, payer_name.
-- receipt_id set at INSERT (the field is immutable after creation for core fields).
-- uploaded_by references auth.users(id).
-- =============================================================================

INSERT INTO payment_evidence (
  id, exporter_id, receipt_id,
  evidence_type, source_document_ref,
  instructed_amount, instructed_currency,
  value_date, charges_code,
  ordering_customer, beneficiary_customer,
  remittance_info,
  credited_amount, credited_currency,
  credit_date, bank_ref,
  payer_account, payer_name,
  uploaded_by
) VALUES
  (
    'b0b00001-0000-0000-0000-000000000013',
    'b0b00001-0000-0000-0000-000000000001',
    'b0b00001-0000-0000-0000-000000000011',
    'BANK_CREDIT_ADVICE',
    'BCA-GTB-20260220-0014',
    40200.00, 'USD',
    '2026-02-20', 'SHA',
    'EUROGRAIN HAMBURG GMBH',
    'AKOBO AGRI-EXPORT COMPANY LTD',
    'CTR-2026-SES-001 SHP-2026-01',
    40000.00, 'USD',
    '2026-02-20', 'GTB2602200014',
    'DE89370400440532013000', 'EUROGRAIN HAMBURG GMBH',
    'a0b00000-0000-0000-0000-000000000001'
  ),
  (
    'b0b00001-0000-0000-0000-000000000014',
    'b0b00001-0000-0000-0000-000000000001',
    'b0b00001-0000-0000-0000-000000000012',
    'BANK_CREDIT_ADVICE',
    'BCA-GTB-20260410-0031',
    16000.00, 'USD',
    '2026-04-10', 'SHA',
    'EUROGRAIN HAMBURG GMBH',
    'AKOBO AGRI-EXPORT COMPANY LTD',
    'CTR-2026-SES-001 SHP-2026-02 PARTIAL',
    15900.00, 'USD',
    '2026-04-10', 'GTB2604100031',
    'DE89370400440532013000', 'EUROGRAIN HAMBURG GMBH',
    'a0b00000-0000-0000-0000-000000000001'
  )
ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- §13  ADVANCE SHIPMENTS TO DEPARTED
-- _sync_compliance_proceeds mirrors status onto shipments only when
-- status IN ('DEPARTED', 'ARRIVED', 'PROCEEDS_PARTIAL', 'PROCEEDS_COMPLETE').
-- Must be done before inserting allocations.
-- =============================================================================

UPDATE shipments
   SET status = 'DEPARTED'
 WHERE id IN (
   'b0b00001-0000-0000-0000-000000000005',
   'b0b00001-0000-0000-0000-000000000006'
 )
   AND status = 'PENDING';

-- =============================================================================
-- §14  PAYMENT ALLOCATIONS
-- trg_allocation_side_effects fires AFTER INSERT and updates:
--   payment_receipts.allocation_status
--   compliance_records.proceeds_received + repatriation_status
--   shipments.status (if departed)
--
-- Allocation 1: 40,000 → Ship 1 (credited=40,000, proceeds_required=40,000)
--   receipt 1:      FULLY_ALLOCATED (40,000 >= 40,000)
--   compliance 1:   COMPLETE        (40,000 >= 40,000)
--   shipment 1:     PROCEEDS_COMPLETE
--
-- Allocation 2: 10,000 → Ship 2 (credited=15,900, proceeds_required=40,000)
--   receipt 2:      PARTIALLY_ALLOCATED (10,000 < 15,900)
--   compliance 2:   PARTIAL             (10,000 < 40,000, not overdue)
--   shipment 2:     PROCEEDS_PARTIAL
-- =============================================================================

INSERT INTO payment_allocations (
  id, exporter_id, receipt_id, shipment_id, invoice_id,
  allocated_amount, allocation_method, allocation_date,
  allocated_by, notes
) VALUES
  (
    'b0b00001-0000-0000-0000-000000000015',
    'b0b00001-0000-0000-0000-000000000001',
    'b0b00001-0000-0000-0000-000000000011',
    'b0b00001-0000-0000-0000-000000000005',
    'b0b00001-0000-0000-0000-000000000007',
    40000.00,
    'MANUAL',
    '2026-02-21',
    'a0b00000-0000-0000-0000-000000000001',
    'Full proceeds for SHP-2026-01 — CTR-2026-SES-001'
  ),
  (
    'b0b00001-0000-0000-0000-000000000016',
    'b0b00001-0000-0000-0000-000000000001',
    'b0b00001-0000-0000-0000-000000000012',
    'b0b00001-0000-0000-0000-000000000006',
    'b0b00001-0000-0000-0000-000000000008',
    10000.00,
    'MANUAL',
    '2026-04-11',
    'a0b00000-0000-0000-0000-000000000001',
    'Partial proceeds for SHP-2026-02 — buyer balance pending'
  )
ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- §15  COMPLIANCE RECORD CHECKLISTS
-- The 5 fields checked by trg_pack_sealing_preconditions:
--   nxp_approved, cci_obtained, bl_uploaded,
--   payment_evidence_uploaded, credit_advice_confirmed
--
-- Compliance 1 (Shipment 1 — fully repatriated):
--   All 5 preconditions TRUE + bank_evidence_pack_generated TRUE.
--
-- Compliance 2 (Shipment 2 — partially repatriated):
--   3 of 5 preconditions TRUE; cci_obtained and credit_advice_confirmed FALSE.
--   Pack cannot be sealed.
-- =============================================================================

UPDATE compliance_records
   SET nxp_approved              = TRUE,
       cci_obtained              = TRUE,
       bl_uploaded               = TRUE,
       payment_evidence_uploaded = TRUE,
       credit_advice_confirmed   = TRUE,
       bank_evidence_pack_generated = TRUE
 WHERE shipment_id = 'b0b00001-0000-0000-0000-000000000005';

UPDATE compliance_records
   SET nxp_approved              = TRUE,
       bl_uploaded               = TRUE,
       payment_evidence_uploaded = TRUE
 WHERE shipment_id = 'b0b00001-0000-0000-0000-000000000006';

-- =============================================================================
-- §16  BANK EVIDENCE PACKS
-- Pack 1 (Shipment 1): inserted unsealed, then sealed (all preconditions met).
-- Pack 2 (Shipment 2): inserted unsealed, seal not attempted (checklist incomplete).
-- nxp_reference: the CBN NXP number for this pack.
-- =============================================================================

INSERT INTO bank_evidence_packs (
  id, shipment_id, exporter_id, version,
  generated_by,
  contract_snapshot, shipment_snapshot,
  invoice_ids, bl_id, nxp_reference,
  payment_evidence_ids, receipt_ids, allocation_ids,
  compliance_status_snapshot,
  repatriation_status,
  sealed
) VALUES
  (
    'b0b00001-0000-0000-0000-000000000017',
    'b0b00001-0000-0000-0000-000000000005',
    'b0b00001-0000-0000-0000-000000000001',
    1,
    'a0b00000-0000-0000-0000-000000000001',
    '{"contract_reference":"CTR-2026-SES-001","commodity_type":"NON_OIL","contract_value":80000}',
    '{"shipment_reference":"SHP-2026-01","shipment_value":40000,"shipment_quantity":50}',
    ARRAY['b0b00001-0000-0000-0000-000000000007']::UUID[],
    'b0b00001-0000-0000-0000-000000000009',
    'NXP-2026-SES-001',
    ARRAY['b0b00001-0000-0000-0000-000000000013']::UUID[],
    ARRAY['b0b00001-0000-0000-0000-000000000011']::UUID[],
    ARRAY['b0b00001-0000-0000-0000-000000000015']::UUID[],
    '{"nxp_approved":true,"cci_obtained":true,"bl_uploaded":true,"payment_evidence_uploaded":true,"credit_advice_confirmed":true}',
    'COMPLETE',
    FALSE
  ),
  (
    'b0b00001-0000-0000-0000-000000000018',
    'b0b00001-0000-0000-0000-000000000006',
    'b0b00001-0000-0000-0000-000000000001',
    1,
    'a0b00000-0000-0000-0000-000000000001',
    '{"contract_reference":"CTR-2026-SES-001","commodity_type":"NON_OIL","contract_value":80000}',
    '{"shipment_reference":"SHP-2026-02","shipment_value":40000,"shipment_quantity":50}',
    ARRAY['b0b00001-0000-0000-0000-000000000008']::UUID[],
    'b0b00001-0000-0000-0000-000000000010',
    'NXP-2026-SES-002',
    ARRAY['b0b00001-0000-0000-0000-000000000014']::UUID[],
    ARRAY['b0b00001-0000-0000-0000-000000000012']::UUID[],
    ARRAY['b0b00001-0000-0000-0000-000000000016']::UUID[],
    '{"nxp_approved":true,"cci_obtained":false,"bl_uploaded":true,"payment_evidence_uploaded":true,"credit_advice_confirmed":false}',
    'PARTIAL',
    FALSE
  )
ON CONFLICT (id) DO NOTHING;

-- Seal Pack 1. WHERE NOT sealed prevents duplicate-seal errors on re-run.
UPDATE bank_evidence_packs
   SET sealed = TRUE
 WHERE id = 'b0b00001-0000-0000-0000-000000000017'
   AND NOT sealed;

COMMIT;
