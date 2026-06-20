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
-- =============================================================================

INSERT INTO exporters (
  id, legal_name, country, tax_id, rcac_number, address
) VALUES (
  'b0b00001-0000-0000-0000-000000000001',
  'AKOBO AGRI-EXPORT COMPANY LTD',
  'NG',
  'NG-TIN-20190045321',
  'RC-1047832',
  '14 Marina Street, Lagos Island, Lagos, Nigeria'
) ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- §3  EXPORTER SETTINGS
-- 180-day repatriation window for non-oil. 2% or $500 discrepancy tolerance.
-- =============================================================================

INSERT INTO exporter_settings (
  exporter_id,
  default_repatriation_days_non_oil,
  default_repatriation_days_oil_gas,
  discrepancy_tolerance_pct,
  discrepancy_tolerance_max_abs
) VALUES (
  'b0b00001-0000-0000-0000-000000000001',
  180,
  90,
  2.00,
  500.00
) ON CONFLICT (exporter_id) DO NOTHING;

-- =============================================================================
-- §4  EXPORTER USER
-- Maps the seed auth user to the exporter as ADMIN.
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
-- registered_address is required for the ACTIVE contract constraint.
-- =============================================================================

INSERT INTO counterparties (
  id, exporter_id, legal_name, country, counterparty_type,
  registered_address, kyc_status
) VALUES (
  'b0b00001-0000-0000-0000-000000000002',
  'b0b00001-0000-0000-0000-000000000001',
  'EUROGRAIN HAMBURG GMBH',
  'DE',
  'BUYER',
  'Spitalerstrasse 12, 20095 Hamburg, Germany',
  'VERIFIED'
) ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- §6  COUNTERPARTY BANK ACCOUNT
-- =============================================================================

INSERT INTO counterparty_bank_accounts (
  id, exporter_id, counterparty_id, bank_name, bank_country,
  account_currency, swift_bic, iban, account_number
) VALUES (
  'b0b00001-0000-0000-0000-000000000003',
  'b0b00001-0000-0000-0000-000000000001',
  'b0b00001-0000-0000-0000-000000000002',
  'Deutsche Bank AG',
  'DE',
  'USD',
  'DEUTDEDB',
  'DE89370400440532013000',
  NULL
) ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- §7  EXPORT CONTRACT
-- CTR-2026-SES-001 — Sesame Seeds, NON_OIL, 100 MT, 80,000 USD, ACTIVE
-- =============================================================================

INSERT INTO export_contracts (
  id, exporter_id, counterparty_id,
  contract_reference, contract_date, commodity_type,
  commodity_description, quantity_mt, contract_value,
  contract_currency, payment_terms, status
) VALUES (
  'b0b00001-0000-0000-0000-000000000004',
  'b0b00001-0000-0000-0000-000000000001',
  'b0b00001-0000-0000-0000-000000000002',
  'CTR-2026-SES-001',
  '2025-11-15',
  'NON_OIL',
  'Sesame Seeds (hulled, natural, food grade)',
  100.00,
  80000.00,
  'USD',
  'T/T 30 days after B/L date',
  'ACTIVE'
) ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- §8  SHIPMENTS
-- Two shipments of 50 MT / 40,000 USD each.
-- Inserted at PENDING; updated to DEPARTED before allocations.
-- =============================================================================

INSERT INTO shipments (
  id, exporter_id, contract_id,
  shipment_reference, shipment_date, port_of_loading,
  port_of_discharge, shipment_value, shipment_currency,
  quantity_mt, status
) VALUES
  (
    'b0b00001-0000-0000-0000-000000000005',
    'b0b00001-0000-0000-0000-000000000001',
    'b0b00001-0000-0000-0000-000000000004',
    'SHP-2026-01',
    '2026-01-18',
    'APAPA, LAGOS',
    'HAMBURG, GERMANY',
    40000.00,
    'USD',
    50.00,
    'PENDING'
  ),
  (
    'b0b00001-0000-0000-0000-000000000006',
    'b0b00001-0000-0000-0000-000000000001',
    'b0b00001-0000-0000-0000-000000000004',
    'SHP-2026-02',
    '2026-03-12',
    'APAPA, LAGOS',
    'HAMBURG, GERMANY',
    40000.00,
    'USD',
    50.00,
    'PENDING'
  )
ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- §9  BILLS OF LADING
-- Triggers:
--   trg_bl_compute_deadline  → sets repatriation_deadline = bl_date + 180 days
--   trg_bl_auto_compliance_record → creates compliance_records automatically
-- BL 1: bl_date 2026-01-20 → deadline 2026-07-19 (WARNING band at seed date)
-- BL 2: bl_date 2026-03-15 → deadline 2026-09-11 (SAFE band at seed date)
-- =============================================================================

INSERT INTO bills_of_lading (
  id, exporter_id, shipment_id,
  bl_number, bl_date, bl_type,
  vessel_name, voyage_number, freight_terms
) VALUES
  (
    'b0b00001-0000-0000-0000-000000000009',
    'b0b00001-0000-0000-0000-000000000001',
    'b0b00001-0000-0000-0000-000000000005',
    'MSC-APAPA-2601',
    '2026-01-20',
    'OCEAN',
    'MSC AURORA',
    'AU2601W',
    'CFR'
  ),
  (
    'b0b00001-0000-0000-0000-000000000010',
    'b0b00001-0000-0000-0000-000000000001',
    'b0b00001-0000-0000-0000-000000000006',
    'MSC-APAPA-2602',
    '2026-03-15',
    'OCEAN',
    'MSC AURORA',
    'AU2602W',
    'CFR'
  )
ON CONFLICT (id) DO NOTHING;

-- Compliance records for both shipments are now auto-created by trigger.

-- =============================================================================
-- §10  INVOICES
-- Commercial invoice for Shipment 1, Proforma for Shipment 2.
-- =============================================================================

INSERT INTO invoices (
  id, exporter_id, shipment_id, contract_id,
  invoice_reference, invoice_date, invoice_type,
  invoice_amount, invoice_currency
) VALUES
  (
    'b0b00001-0000-0000-0000-000000000007',
    'b0b00001-0000-0000-0000-000000000001',
    'b0b00001-0000-0000-0000-000000000005',
    'b0b00001-0000-0000-0000-000000000004',
    'INV-2026-001',
    '2026-01-20',
    'COMMERCIAL',
    40000.00,
    'USD'
  ),
  (
    'b0b00001-0000-0000-0000-000000000008',
    'b0b00001-0000-0000-0000-000000000001',
    'b0b00001-0000-0000-0000-000000000006',
    'b0b00001-0000-0000-0000-000000000004',
    'INV-2026-002',
    '2026-03-15',
    'PROFORMA',
    40000.00,
    'USD'
  )
ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- §11  PAYMENT RECEIPTS
-- Receipt 1: instructed=40,200  credited=40,000  diff=200 ≤ $500 → CLEAN
-- Receipt 2: instructed=16,000  credited=15,900  diff=100 ≤ $500 → CLEAN
-- charges_deducted and amount_variance are GENERATED columns — not inserted.
-- discrepancy_status auto-set by trg_detect_payment_receipt_discrepancy.
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
-- BANK_CREDIT_ADVICE documents for each receipt.
-- receipt_id set at INSERT (immutable after creation).
-- =============================================================================

INSERT INTO payment_evidence (
  id, exporter_id, receipt_id,
  evidence_type,
  source_document_ref,
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
-- _sync_compliance_proceeds only mirrors status if shipment is already
-- in ('DEPARTED', 'ARRIVED', 'PROCEEDS_PARTIAL', 'PROCEEDS_COMPLETE').
-- Must happen before inserting allocations.
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
-- Triggers (trg_allocation_side_effects) update:
--   payment_receipts.allocation_status
--   compliance_records.proceeds_received + repatriation_status
--   shipments.status
--
-- Allocation 1: 40,000 → Ship 1 (full shipment value)
--   → receipt 1: FULLY_ALLOCATED
--   → compliance 1: proceeds_received=40,000 = proceeds_required=40,000 → COMPLETE
--   → shipment 1: PROCEEDS_COMPLETE
--
-- Allocation 2: 10,000 → Ship 2 (partial, proceeds_required=40,000)
--   → receipt 2: FULLY_ALLOCATED (credited=15,900 allocated=10,000 partial; wait—
--     actually: PARTIALLY_ALLOCATED since 10,000 < 15,900 credited)
--   → compliance 2: proceeds_received=10,000 < 40,000 → PARTIAL
--   → shipment 2: PROCEEDS_PARTIAL
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
    'Partial proceeds for SHP-2026-02 — buyer payment pending'
  )
ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- §15  COMPLIANCE RECORD CHECKLISTS
-- Updated after allocations so repatriation_status is already set by trigger.
--
-- Compliance 1 (Shipment 1 — fully repatriated):
--   All 5 sealing preconditions TRUE; bank_evidence_pack_generated TRUE.
--
-- Compliance 2 (Shipment 2 — partially repatriated):
--   nxp_approved=TRUE, bl_uploaded=TRUE, payment_evidence_uploaded=TRUE;
--   cci_obtained=FALSE, credit_advice_confirmed=FALSE → cannot be sealed.
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
-- =============================================================================

INSERT INTO bank_evidence_packs (
  id, shipment_id, exporter_id, version,
  generated_by,
  contract_snapshot,
  shipment_snapshot,
  invoice_ids,
  bl_id,
  nxp_reference,
  payment_evidence_ids,
  receipt_ids,
  allocation_ids,
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
    '{"contract_reference":"CTR-2026-SES-001","commodity":"NON_OIL","value":80000}',
    '{"shipment_reference":"SHP-2026-01","shipment_value":40000,"quantity_mt":50}',
    ARRAY['b0b00001-0000-0000-0000-000000000007']::UUID[],
    'b0b00001-0000-0000-0000-000000000009',
    'NXP-2026-001-GTB',
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
    '{"contract_reference":"CTR-2026-SES-001","commodity":"NON_OIL","value":80000}',
    '{"shipment_reference":"SHP-2026-02","shipment_value":40000,"quantity_mt":50}',
    ARRAY['b0b00001-0000-0000-0000-000000000008']::UUID[],
    'b0b00001-0000-0000-0000-000000000010',
    'NXP-2026-002-GTB',
    ARRAY['b0b00001-0000-0000-0000-000000000014']::UUID[],
    ARRAY['b0b00001-0000-0000-0000-000000000012']::UUID[],
    ARRAY['b0b00001-0000-0000-0000-000000000016']::UUID[],
    '{"nxp_approved":true,"cci_obtained":false,"bl_uploaded":true,"payment_evidence_uploaded":true,"credit_advice_confirmed":false}',
    'PARTIAL',
    FALSE
  )
ON CONFLICT (id) DO NOTHING;

-- Seal Pack 1: WHERE NOT sealed prevents duplicate errors on re-run.
UPDATE bank_evidence_packs
   SET sealed = TRUE
 WHERE id = 'b0b00001-0000-0000-0000-000000000017'
   AND NOT sealed;

COMMIT;
