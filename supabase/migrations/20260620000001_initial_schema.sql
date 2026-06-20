-- =============================================================================
-- ExportOS v0.2 — Initial Schema Migration
-- =============================================================================
-- Scope: Database foundation only.
-- No frontend code. No REST APIs. No payment movement. No FX. No stablecoins.
-- No AI. No sanctions screening. No TRMS submission.
-- ExportOS is a system of record for export contracts, shipments, payment
-- evidence, reconciliation, compliance records, and bank evidence packs.
--
-- Governing principle:
--   Contract is commercial. Shipment is regulatory.
--   Payment is allocatable. Compliance is shipment-level.
-- =============================================================================

BEGIN;

-- =============================================================================
-- EXTENSIONS
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =============================================================================
-- ENUM TYPES
-- =============================================================================

CREATE TYPE contract_status AS ENUM (
  'DRAFT',
  'ACTIVE',
  'PARTIALLY_SHIPPED',
  'FULLY_SHIPPED',
  'CLOSED',
  'CANCELLED'
);

CREATE TYPE shipment_status AS ENUM (
  'PENDING',
  'DEPARTED',
  'ARRIVED',
  'PROCEEDS_PARTIAL',
  'PROCEEDS_COMPLETE',
  'OVERDUE'
);

CREATE TYPE repatriation_status AS ENUM (
  'NOT_DUE',
  'PARTIAL',
  'COMPLETE',
  'OVERDUE'
);

CREATE TYPE discrepancy_status AS ENUM (
  'CLEAN',
  'AMOUNT_MISMATCH',
  'DATE_MISMATCH',
  'COUNTERPARTY_MISMATCH',
  'UNMATCHED',
  'MANUALLY_RESOLVED'
);

CREATE TYPE allocation_status AS ENUM (
  'UNALLOCATED',
  'PARTIALLY_ALLOCATED',
  'FULLY_ALLOCATED'
);

CREATE TYPE allocation_method AS ENUM (
  'MANUAL',
  'FIFO',
  'PRO_RATA',
  'INSTRUCTION_MATCHED'
);

CREATE TYPE evidence_type AS ENUM (
  'MT103',
  'PACS008',
  'MT910',
  'BANK_CREDIT_ADVICE',
  'MT940_LINE',
  'MT950_LINE',
  'MANUAL'
);

CREATE TYPE bl_type AS ENUM (
  'ORIGINAL',
  'TELEX_RELEASE',
  'SEA_WAYBILL',
  'EXPRESS_BL'
);

CREATE TYPE deadline_status AS ENUM (
  'SAFE',
  'WARNING',
  'CRITICAL',
  'OVERDUE'
);

CREATE TYPE counterparty_type AS ENUM (
  'COMPANY',
  'INDIVIDUAL',
  'GOVERNMENT_ENTITY'
);

CREATE TYPE kyc_status AS ENUM (
  'NOT_STARTED',
  'PENDING',
  'VERIFIED',
  'FLAGGED'
);

CREATE TYPE invoice_type AS ENUM (
  'PROFORMA',
  'COMMERCIAL'
);

CREATE TYPE charges_code AS ENUM (
  'OUR',
  'SHA',
  'BEN'
);

CREATE TYPE commodity_type AS ENUM (
  'NON_OIL',
  'OIL_GAS'
);

CREATE TYPE freight_terms AS ENUM (
  'PREPAID',
  'COLLECT'
);

-- =============================================================================
-- TABLE: exporters
-- Multi-tenant root. Every tenant-scoped table carries exporter_id.
-- =============================================================================

CREATE TABLE exporters (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name          VARCHAR(300) NOT NULL,
  trading_name        VARCHAR(300),
  country             CHAR(2)      NOT NULL,
  registration_number VARCHAR(100),
  tin                 VARCHAR(100),
  is_active           BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- TABLE: exporter_settings
-- Per-exporter configurable tolerance bands and repatriation day rules.
-- Schema decision #2: charges_tolerance_pct + charges_tolerance_max_abs.
-- Schema decision: repatriation days configurable here; 180/90 are spec defaults.
-- =============================================================================

CREATE TABLE exporter_settings (
  id                                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  exporter_id                       UUID         NOT NULL UNIQUE
                                      REFERENCES exporters(id) ON DELETE CASCADE,
  charges_tolerance_pct             DECIMAL(5,4) NOT NULL DEFAULT 0.0200
                                      CHECK (charges_tolerance_pct BETWEEN 0 AND 1),
  charges_tolerance_max_abs         DECIMAL(18,2) NOT NULL DEFAULT 500.00
                                      CHECK (charges_tolerance_max_abs >= 0),
  default_repatriation_days_non_oil INTEGER      NOT NULL DEFAULT 180
                                      CHECK (default_repatriation_days_non_oil > 0),
  default_repatriation_days_oil_gas INTEGER      NOT NULL DEFAULT 90
                                      CHECK (default_repatriation_days_oil_gas > 0),
  created_at                        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at                        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- TABLE: exporter_users
-- Maps Supabase Auth users to exporters. This table is the RLS authority.
-- One user can belong to multiple exporters (e.g. a group CFO).
-- =============================================================================

CREATE TABLE exporter_users (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  exporter_id UUID        NOT NULL REFERENCES exporters(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role        VARCHAR(50) NOT NULL DEFAULT 'MEMBER',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT exporter_users_unique UNIQUE (exporter_id, user_id)
);

CREATE INDEX idx_exporter_users_user_id     ON exporter_users (user_id);
CREATE INDEX idx_exporter_users_exporter_id ON exporter_users (exporter_id);

-- =============================================================================
-- TABLE: counterparties
-- Foreign buyer entities. Scoped to exporter; reusable across contracts.
-- legal_name is the canonical identifier and must be unique per exporter.
-- =============================================================================

CREATE TABLE counterparties (
  id                         UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
  exporter_id                UUID              NOT NULL REFERENCES exporters(id),
  legal_name                 VARCHAR(300)      NOT NULL,
  trading_name               VARCHAR(300),
  country_of_incorporation   CHAR(2)           NOT NULL,
  registered_address         TEXT,
  registration_number        VARCHAR(100),
  tin                        VARCHAR(100),
  counterparty_type          counterparty_type NOT NULL,
  beneficial_owner_disclosed BOOLEAN           NOT NULL DEFAULT FALSE,
  beneficial_owner_name      VARCHAR(300),
  kyc_status                 kyc_status        NOT NULL DEFAULT 'NOT_STARTED',
  kyc_notes                  TEXT,
  is_sanctioned_flag         BOOLEAN           NOT NULL DEFAULT FALSE,
  created_at                 TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
  CONSTRAINT counterparties_unique_legal_name_per_exporter
    UNIQUE (exporter_id, legal_name)
);

CREATE INDEX idx_counterparties_exporter_id ON counterparties (exporter_id);

-- =============================================================================
-- TABLE: counterparty_bank_accounts
-- Child table (1:N). Supports multiple banking relationships per counterparty.
-- =============================================================================

CREATE TABLE counterparty_bank_accounts (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  counterparty_id UUID         NOT NULL REFERENCES counterparties(id) ON DELETE CASCADE,
  exporter_id     UUID         NOT NULL REFERENCES exporters(id),
  bank_name       VARCHAR(200) NOT NULL,
  bank_country    CHAR(2)      NOT NULL,
  swift_bic       VARCHAR(11)  NOT NULL,
  account_number  VARCHAR(50),
  account_name    VARCHAR(200) NOT NULL,
  currency        CHAR(3)      NOT NULL,
  is_primary      BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_counterparty_bank_accounts_counterparty_id
  ON counterparty_bank_accounts (counterparty_id);
CREATE INDEX idx_counterparty_bank_accounts_exporter_id
  ON counterparty_bank_accounts (exporter_id);

-- =============================================================================
-- TABLE: export_contracts
-- Root commercial object. One contract may span multiple shipments and invoices.
-- commodity_type stored here per schema decision #1 (contract is oil or non-oil;
-- a shipment inherits the parent type).
-- Single currency per contract per schema decision #3 (multi-currency is v0.3).
-- =============================================================================

CREATE TABLE export_contracts (
  id                       UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_reference       VARCHAR(100)    NOT NULL,
  exporter_id              UUID            NOT NULL REFERENCES exporters(id),
  counterparty_id          UUID            NOT NULL REFERENCES counterparties(id),
  commodity                VARCHAR(200)    NOT NULL,
  commodity_type           commodity_type  NOT NULL,
  hs_code                  VARCHAR(20)     NOT NULL,
  contract_quantity        DECIMAL(18,4)   NOT NULL CHECK (contract_quantity > 0),
  quantity_unit            VARCHAR(20)     NOT NULL,
  contract_value           DECIMAL(18,2)   NOT NULL CHECK (contract_value > 0),
  currency                 CHAR(3)         NOT NULL,
  unit_price               DECIMAL(18,4)   NOT NULL CHECK (unit_price > 0),
  incoterms                VARCHAR(10)     NOT NULL,
  destination_country      CHAR(2)         NOT NULL,
  destination_port         VARCHAR(100),
  payment_terms            VARCHAR(50)     NOT NULL,
  partial_shipment_allowed BOOLEAN         NOT NULL DEFAULT FALSE,
  contract_date            DATE            NOT NULL,
  expiry_date              DATE,
  status                   contract_status NOT NULL DEFAULT 'DRAFT',
  notes                    TEXT,
  created_at               TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  CONSTRAINT export_contracts_unique_reference_per_exporter
    UNIQUE (exporter_id, contract_reference),
  CONSTRAINT export_contracts_expiry_after_contract_date
    CHECK (expiry_date IS NULL OR expiry_date > contract_date)
);

CREATE INDEX idx_export_contracts_exporter_id    ON export_contracts (exporter_id);
CREATE INDEX idx_export_contracts_counterparty_id ON export_contracts (counterparty_id);
CREATE INDEX idx_export_contracts_status          ON export_contracts (status);

-- =============================================================================
-- TABLE: shipments
-- Regulatory unit. Each shipment has its own B/L date and compliance clock.
-- Compliance obligations tracked here, not at contract level.
-- =============================================================================

CREATE TABLE shipments (
  id                 UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id        UUID            NOT NULL REFERENCES export_contracts(id),
  exporter_id        UUID            NOT NULL REFERENCES exporters(id),
  shipment_reference VARCHAR(100)    NOT NULL,
  shipment_sequence  INTEGER         NOT NULL CHECK (shipment_sequence >= 1),
  nxp_reference      VARCHAR(50)     NOT NULL,
  port_of_loading    VARCHAR(100)    NOT NULL,
  port_of_discharge  VARCHAR(100)    NOT NULL,
  shipment_quantity  DECIMAL(18,4)   NOT NULL CHECK (shipment_quantity > 0),
  shipment_value     DECIMAL(18,2)   NOT NULL CHECK (shipment_value > 0),
  currency           CHAR(3)         NOT NULL,
  shipping_line      VARCHAR(200),
  vessel_name        VARCHAR(200),
  voyage_number      VARCHAR(100),
  status             shipment_status NOT NULL DEFAULT 'PENDING',
  created_at         TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  CONSTRAINT shipments_unique_reference_per_contract
    UNIQUE (contract_id, shipment_reference),
  CONSTRAINT shipments_unique_sequence_per_contract
    UNIQUE (contract_id, shipment_sequence)
);

CREATE INDEX idx_shipments_contract_id ON shipments (contract_id);
CREATE INDEX idx_shipments_exporter_id ON shipments (exporter_id);
CREATE INDEX idx_shipments_status       ON shipments (status);

-- =============================================================================
-- TABLE: invoices
-- Proforma and commercial invoices. shipment_id nullable per schema decision #4
-- (proforma invoices exist before shipment assignment; binding required before
-- BankEvidencePack can be sealed).
-- =============================================================================

CREATE TABLE invoices (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id    UUID         NOT NULL REFERENCES export_contracts(id),
  shipment_id    UUID         REFERENCES shipments(id),
  exporter_id    UUID         NOT NULL REFERENCES exporters(id),
  invoice_number VARCHAR(100) NOT NULL,
  invoice_type   invoice_type NOT NULL,
  invoice_date   DATE         NOT NULL,
  invoice_amount DECIMAL(18,2) NOT NULL CHECK (invoice_amount > 0),
  currency       CHAR(3)      NOT NULL,
  description    TEXT,
  document_url   TEXT,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT invoices_unique_number_per_exporter UNIQUE (exporter_id, invoice_number)
);

CREATE INDEX idx_invoices_contract_id ON invoices (contract_id);
CREATE INDEX idx_invoices_shipment_id ON invoices (shipment_id);
CREATE INDEX idx_invoices_exporter_id ON invoices (exporter_id);

-- =============================================================================
-- TABLE: bills_of_lading
-- One per shipment (enforced by UNIQUE constraint).
-- bl_date is the compliance clock anchor.
-- repatriation_days and repatriation_deadline are set by trigger on INSERT
-- from the contract's commodity_type and exporter_settings, then are immutable.
-- The defaults below are placeholders; the BEFORE INSERT trigger always overrides them.
-- =============================================================================

CREATE TABLE bills_of_lading (
  id                   UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id          UUID          NOT NULL UNIQUE REFERENCES shipments(id),
  exporter_id          UUID          NOT NULL REFERENCES exporters(id),
  bl_number            VARCHAR(100)  NOT NULL,
  bl_date              DATE          NOT NULL,
  bl_type              bl_type       NOT NULL,
  shipper_name         VARCHAR(200)  NOT NULL,
  consignee_name       VARCHAR(200)  NOT NULL,
  notify_party         VARCHAR(200),
  description_of_goods TEXT          NOT NULL,
  gross_weight_kg      DECIMAL(18,3) CHECK (gross_weight_kg > 0),
  number_of_packages   INTEGER       CHECK (number_of_packages > 0),
  container_numbers    TEXT[],
  freight_terms        freight_terms,
  place_of_receipt     VARCHAR(200),
  place_of_delivery    VARCHAR(200),
  nxp_reference        VARCHAR(50)   NOT NULL,
  -- Set by trg_bl_compute_deadline on INSERT; immutable thereafter.
  repatriation_days    INTEGER       NOT NULL DEFAULT 180 CHECK (repatriation_days > 0),
  repatriation_deadline DATE         NOT NULL DEFAULT CURRENT_DATE + 180,
  document_url         TEXT,
  created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CONSTRAINT bills_of_lading_unique_bl_number_per_exporter
    UNIQUE (exporter_id, bl_number)
);

CREATE INDEX idx_bills_of_lading_shipment_id           ON bills_of_lading (shipment_id);
CREATE INDEX idx_bills_of_lading_repatriation_deadline ON bills_of_lading (repatriation_deadline);
CREATE INDEX idx_bills_of_lading_exporter_id           ON bills_of_lading (exporter_id);

-- =============================================================================
-- TABLE: compliance_records
-- One per shipment. Tracks regulatory status, document checklist, evidence status.
-- days_remaining must be refreshed by the application layer on a daily schedule;
-- it cannot be a generated column because it depends on the current date changing.
-- proceeds_outstanding is a generated column: proceeds_required - proceeds_received.
-- =============================================================================

CREATE TABLE compliance_records (
  id                           UUID                PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id                  UUID                NOT NULL UNIQUE REFERENCES shipments(id),
  exporter_id                  UUID                NOT NULL REFERENCES exporters(id),
  repatriation_deadline        DATE                NOT NULL,
  days_remaining               INTEGER             NOT NULL DEFAULT 0,
  repatriation_status          repatriation_status NOT NULL DEFAULT 'NOT_DUE',
  proceeds_required            DECIMAL(18,2)       NOT NULL CHECK (proceeds_required > 0),
  proceeds_received            DECIMAL(18,2)       NOT NULL DEFAULT 0
                                 CHECK (proceeds_received >= 0),
  proceeds_outstanding         DECIMAL(18,2)       GENERATED ALWAYS AS
                                 (proceeds_required - proceeds_received) STORED,
  nxp_submitted                BOOLEAN             NOT NULL DEFAULT FALSE,
  nxp_approved                 BOOLEAN             NOT NULL DEFAULT FALSE,
  cci_obtained                 BOOLEAN             NOT NULL DEFAULT FALSE,
  bl_uploaded                  BOOLEAN             NOT NULL DEFAULT FALSE,
  payment_evidence_uploaded    BOOLEAN             NOT NULL DEFAULT FALSE,
  credit_advice_confirmed      BOOLEAN             NOT NULL DEFAULT FALSE,
  bank_evidence_pack_generated BOOLEAN             NOT NULL DEFAULT FALSE,
  compliance_flags             TEXT[],
  last_reviewed_at             TIMESTAMPTZ,
  notes                        TEXT,
  created_at                   TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
  updated_at                   TIMESTAMPTZ         NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_compliance_records_shipment_id          ON compliance_records (shipment_id);
CREATE INDEX idx_compliance_records_exporter_id          ON compliance_records (exporter_id);
CREATE INDEX idx_compliance_records_repatriation_status  ON compliance_records (repatriation_status);
CREATE INDEX idx_compliance_records_repatriation_deadline ON compliance_records (repatriation_deadline);

-- =============================================================================
-- TABLE: payment_receipts
-- Synthesised, authoritative payment record. credited_amount is the compliance
-- authority. instructed_amount retained for reconciliation audit only.
-- charges_deducted is generated: instructed_amount - credited_amount.
-- =============================================================================

CREATE TABLE payment_receipts (
  id                      UUID               PRIMARY KEY DEFAULT gen_random_uuid(),
  exporter_id             UUID               NOT NULL REFERENCES exporters(id),
  receipt_reference       VARCHAR(100)       NOT NULL,
  instructed_amount       DECIMAL(18,2)      NOT NULL CHECK (instructed_amount > 0),
  credited_amount         DECIMAL(18,2)      NOT NULL CHECK (credited_amount > 0),
  charges_deducted        DECIMAL(18,2)      GENERATED ALWAYS AS
                            (instructed_amount - credited_amount) STORED,
  currency                CHAR(3)            NOT NULL,
  credit_date             DATE               NOT NULL,
  value_date              DATE,
  domiciliary_account_ref VARCHAR(100),
  ordering_bank_bic       VARCHAR(11),
  ordering_customer_name  VARCHAR(200),
  remittance_info         TEXT,
  discrepancy_status      discrepancy_status NOT NULL DEFAULT 'UNMATCHED',
  discrepancy_notes       TEXT,
  allocation_status       allocation_status  NOT NULL DEFAULT 'UNALLOCATED',
  created_at              TIMESTAMPTZ        NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ        NOT NULL DEFAULT NOW(),
  CONSTRAINT payment_receipts_unique_reference_per_exporter
    UNIQUE (exporter_id, receipt_reference),
  -- credited_amount must never exceed instructed_amount (charges_deducted >= 0)
  CONSTRAINT payment_receipts_credited_lte_instructed
    CHECK (credited_amount <= instructed_amount)
);

CREATE INDEX idx_payment_receipts_exporter_id       ON payment_receipts (exporter_id);
CREATE INDEX idx_payment_receipts_allocation_status ON payment_receipts (allocation_status);
CREATE INDEX idx_payment_receipts_credit_date        ON payment_receipts (credit_date);
CREATE INDEX idx_payment_receipts_discrepancy_status ON payment_receipts (discrepancy_status);

-- =============================================================================
-- TABLE: payment_evidence
-- Raw source-level payment documents. Append-only and immutable after creation.
-- Corrections: create a new row, then set superseded_by on the old row.
-- Only receipt_id (initial assignment) and superseded_by are updatable.
-- All other fields are guarded by trg_payment_evidence_immutable.
-- =============================================================================

CREATE TABLE payment_evidence (
  id                   UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  exporter_id          UUID          NOT NULL REFERENCES exporters(id),
  receipt_id           UUID          REFERENCES payment_receipts(id),
  evidence_type        evidence_type NOT NULL,
  source_document_ref  VARCHAR(200),
  sender_bic           VARCHAR(11),
  receiver_bic         VARCHAR(11),
  instructed_amount    DECIMAL(18,2) CHECK (instructed_amount > 0),
  instructed_currency  CHAR(3),
  value_date           DATE,
  charges_code         charges_code,
  ordering_customer    VARCHAR(200),
  beneficiary_customer VARCHAR(200),
  remittance_info      TEXT,
  document_url         TEXT,
  superseded_by        UUID          REFERENCES payment_evidence(id),
  uploaded_by          UUID          NOT NULL REFERENCES auth.users(id),
  created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW()
  -- No updated_at: row body is immutable; only receipt_id/superseded_by may change.
);

CREATE INDEX idx_payment_evidence_exporter_id  ON payment_evidence (exporter_id);
CREATE INDEX idx_payment_evidence_receipt_id   ON payment_evidence (receipt_id);
CREATE INDEX idx_payment_evidence_superseded_by ON payment_evidence (superseded_by);

-- =============================================================================
-- TABLE: payment_allocations
-- Allocates one PaymentReceipt to one or more Shipments (or Invoices).
-- SUM(allocated_amount) per receipt must not exceed credited_amount —
-- enforced by trg_allocation_integrity.
-- =============================================================================

CREATE TABLE payment_allocations (
  id                UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
  exporter_id       UUID              NOT NULL REFERENCES exporters(id),
  receipt_id        UUID              NOT NULL REFERENCES payment_receipts(id),
  shipment_id       UUID              NOT NULL REFERENCES shipments(id),
  invoice_id        UUID              REFERENCES invoices(id),
  allocated_amount  DECIMAL(18,2)     NOT NULL CHECK (allocated_amount > 0),
  allocation_method allocation_method NOT NULL,
  allocation_date   DATE              NOT NULL,
  allocated_by      UUID              NOT NULL REFERENCES auth.users(id),
  notes             TEXT,
  created_at        TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
  CONSTRAINT payment_allocations_unique_receipt_shipment
    UNIQUE (receipt_id, shipment_id)
);

CREATE INDEX idx_payment_allocations_exporter_id ON payment_allocations (exporter_id);
CREATE INDEX idx_payment_allocations_receipt_id  ON payment_allocations (receipt_id);
CREATE INDEX idx_payment_allocations_shipment_id ON payment_allocations (shipment_id);

-- =============================================================================
-- TABLE: bank_evidence_packs
-- Generated, versioned, sealed output. Point-in-time snapshot per shipment.
-- Once sealed = TRUE, the row is immutable; new version must be created.
-- =============================================================================

CREATE TABLE bank_evidence_packs (
  id                         UUID                PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id                UUID                NOT NULL REFERENCES shipments(id),
  exporter_id                UUID                NOT NULL REFERENCES exporters(id),
  version                    INTEGER             NOT NULL DEFAULT 1 CHECK (version >= 1),
  generated_at               TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
  generated_by               UUID                NOT NULL REFERENCES auth.users(id),
  contract_snapshot          JSONB               NOT NULL,
  shipment_snapshot          JSONB               NOT NULL,
  invoice_ids                UUID[]              NOT NULL DEFAULT '{}',
  bl_id                      UUID                NOT NULL REFERENCES bills_of_lading(id),
  nxp_reference              VARCHAR(50)         NOT NULL,
  payment_evidence_ids       UUID[]              NOT NULL DEFAULT '{}',
  receipt_ids                UUID[]              NOT NULL DEFAULT '{}',
  allocation_ids             UUID[]              NOT NULL DEFAULT '{}',
  compliance_status_snapshot JSONB               NOT NULL,
  repatriation_status        repatriation_status NOT NULL,
  pack_url                   TEXT,
  sealed                     BOOLEAN             NOT NULL DEFAULT FALSE,
  notes                      TEXT,
  CONSTRAINT bank_evidence_packs_unique_shipment_version
    UNIQUE (shipment_id, version)
);

CREATE INDEX idx_bank_evidence_packs_shipment_id ON bank_evidence_packs (shipment_id);
CREATE INDEX idx_bank_evidence_packs_exporter_id ON bank_evidence_packs (exporter_id);

-- =============================================================================
-- FUNCTION: set_updated_at
-- Generic BEFORE UPDATE trigger function that stamps updated_at = NOW().
-- =============================================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_exporters_updated_at
  BEFORE UPDATE ON exporters
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_exporter_settings_updated_at
  BEFORE UPDATE ON exporter_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_counterparties_updated_at
  BEFORE UPDATE ON counterparties
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_export_contracts_updated_at
  BEFORE UPDATE ON export_contracts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_shipments_updated_at
  BEFORE UPDATE ON shipments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_bills_of_lading_updated_at
  BEFORE UPDATE ON bills_of_lading
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_compliance_records_updated_at
  BEFORE UPDATE ON compliance_records
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_payment_receipts_updated_at
  BEFORE UPDATE ON payment_receipts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- FUNCTION & TRIGGER: Bill of Lading compliance deadline computation
-- Fires BEFORE INSERT on bills_of_lading.
-- Reads commodity_type from the parent contract and repatriation day counts
-- from exporter_settings (falling back to spec defaults: 180 non-oil, 90 oil/gas).
-- Sets repatriation_days and repatriation_deadline on the incoming row.
-- =============================================================================

CREATE OR REPLACE FUNCTION compute_bl_repatriation_deadline()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  v_exporter_id         UUID;
  v_commodity_type      commodity_type;
  v_days_non_oil        INTEGER;
  v_days_oil_gas        INTEGER;
  v_deadline_days       INTEGER;
BEGIN
  SELECT ec.exporter_id, ec.commodity_type
    INTO v_exporter_id, v_commodity_type
    FROM shipments s
    JOIN export_contracts ec ON ec.id = s.contract_id
   WHERE s.id = NEW.shipment_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Shipment % not found when computing B/L repatriation deadline',
      NEW.shipment_id;
  END IF;

  SELECT
    es.default_repatriation_days_non_oil,
    es.default_repatriation_days_oil_gas
    INTO v_days_non_oil, v_days_oil_gas
    FROM exporter_settings es
   WHERE es.exporter_id = v_exporter_id;

  -- Fall back to spec defaults if no exporter_settings row exists yet
  v_days_non_oil := COALESCE(v_days_non_oil, 180);
  v_days_oil_gas := COALESCE(v_days_oil_gas, 90);

  v_deadline_days := CASE v_commodity_type
    WHEN 'OIL_GAS' THEN v_days_oil_gas
    ELSE v_days_non_oil
  END;

  NEW.repatriation_days     := v_deadline_days;
  NEW.repatriation_deadline := NEW.bl_date + v_deadline_days;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_bl_compute_deadline
  BEFORE INSERT ON bills_of_lading
  FOR EACH ROW EXECUTE FUNCTION compute_bl_repatriation_deadline();

-- =============================================================================
-- FUNCTION & TRIGGER: Prevent retroactive B/L date and deadline changes
-- bl_date and the system-computed deadline fields are immutable after creation.
-- Per spec: "never recalculated retroactively". If a B/L date must be amended,
-- a new bills_of_lading record is created and the compliance record is versioned.
-- =============================================================================

CREATE OR REPLACE FUNCTION prevent_bl_deadline_change()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.bl_date IS DISTINCT FROM NEW.bl_date THEN
    RAISE EXCEPTION
      'bills_of_lading.bl_date is immutable (repatriation clock anchor). '
      'Create a new bill_of_lading record to correct the B/L date.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.repatriation_deadline IS DISTINCT FROM NEW.repatriation_deadline THEN
    RAISE EXCEPTION
      'bills_of_lading.repatriation_deadline is system-computed and immutable.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.repatriation_days IS DISTINCT FROM NEW.repatriation_days THEN
    RAISE EXCEPTION
      'bills_of_lading.repatriation_days is system-computed and immutable.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_bl_immutable_deadline
  BEFORE UPDATE ON bills_of_lading
  FOR EACH ROW EXECUTE FUNCTION prevent_bl_deadline_change();

-- =============================================================================
-- FUNCTION & TRIGGER: Payment allocation integrity
-- SUM(payment_allocations.allocated_amount) for a given receipt_id must not
-- exceed payment_receipts.credited_amount.
-- Fires BEFORE INSERT OR UPDATE on payment_allocations.
-- On INSERT: NEW.id is not yet in the table, so the aggregate excludes no rows.
-- On UPDATE: excludes the row being updated via id <> NEW.id, then adds NEW amount.
-- =============================================================================

CREATE OR REPLACE FUNCTION check_allocation_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  v_already_allocated DECIMAL(18,2);
  v_credited_amount   DECIMAL(18,2);
  v_new_total         DECIMAL(18,2);
BEGIN
  SELECT COALESCE(SUM(allocated_amount), 0)
    INTO v_already_allocated
    FROM payment_allocations
   WHERE receipt_id = NEW.receipt_id
     AND id <> NEW.id;

  v_new_total := v_already_allocated + NEW.allocated_amount;

  SELECT credited_amount
    INTO v_credited_amount
    FROM payment_receipts
   WHERE id = NEW.receipt_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PaymentReceipt % not found', NEW.receipt_id;
  END IF;

  IF v_new_total > v_credited_amount THEN
    RAISE EXCEPTION
      'Allocation integrity violation: total allocated (%) would exceed '
      'receipt credited_amount (%) for receipt_id %',
      v_new_total, v_credited_amount, NEW.receipt_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_allocation_integrity
  BEFORE INSERT OR UPDATE ON payment_allocations
  FOR EACH ROW EXECUTE FUNCTION check_allocation_integrity();

-- =============================================================================
-- FUNCTION & TRIGGER: payment_evidence immutability
-- Core document fields are immutable after creation per spec.
-- Only receipt_id (initial assignment to a receipt) and superseded_by
-- (correction chain pointer) are permitted to change after INSERT.
-- =============================================================================

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
     OLD.created_at           IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION
      'payment_evidence core fields are immutable after creation. '
      'Create a new row and set superseded_by on this row to issue a correction.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_payment_evidence_immutable
  BEFORE UPDATE ON payment_evidence
  FOR EACH ROW EXECUTE FUNCTION prevent_payment_evidence_mutation();

-- =============================================================================
-- FUNCTION & TRIGGER: BankEvidencePack sealing
-- Once sealed = TRUE, the pack is a permanent archive record.
-- Any further mutation is blocked; the next version must be created instead.
-- =============================================================================

CREATE OR REPLACE FUNCTION prevent_sealed_pack_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.sealed = TRUE THEN
    RAISE EXCEPTION
      'BankEvidencePack (id=%, version=%) is sealed and cannot be modified. '
      'Create a new version (next: %) for this shipment instead.',
      OLD.id, OLD.version, OLD.version + 1
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_bank_evidence_pack_sealed
  BEFORE UPDATE ON bank_evidence_packs
  FOR EACH ROW EXECUTE FUNCTION prevent_sealed_pack_mutation();

-- =============================================================================
-- VIEWS: Derived / computed fields (not stored in tables per spec)
-- =============================================================================

-- B/L deadline status (SAFE / WARNING / CRITICAL / OVERDUE) and days_to_deadline.
-- These are always calculated from the current date; never stored.
CREATE OR REPLACE VIEW v_bills_of_lading_deadline AS
SELECT
  bl.*,
  (bl.repatriation_deadline - CURRENT_DATE)        AS days_to_deadline,
  CASE
    WHEN bl.repatriation_deadline <  CURRENT_DATE       THEN 'OVERDUE'::deadline_status
    WHEN bl.repatriation_deadline <= CURRENT_DATE + 7   THEN 'CRITICAL'::deadline_status
    WHEN bl.repatriation_deadline <= CURRENT_DATE + 30  THEN 'WARNING'::deadline_status
    ELSE                                                     'SAFE'::deadline_status
  END                                              AS deadline_status
FROM bills_of_lading bl;

-- Contract-level aggregates: total shipped value, allocated receipts,
-- unallocated balance, shipment count. Always derived; never stored.
CREATE OR REPLACE VIEW v_export_contracts_summary AS
SELECT
  ec.*,
  COALESCE(sv.total_shipped_value, 0)                              AS total_shipped_value,
  COALESCE(sv.shipment_count, 0)                                   AS shipment_count,
  COALESCE(av.total_allocated_receipts, 0)                         AS total_allocated_receipts,
  ec.contract_value - COALESCE(av.total_allocated_receipts, 0)     AS unallocated_contract_value
FROM export_contracts ec
LEFT JOIN (
  SELECT
    contract_id,
    SUM(shipment_value) AS total_shipped_value,
    COUNT(*)            AS shipment_count
  FROM shipments
  GROUP BY contract_id
) sv ON sv.contract_id = ec.id
LEFT JOIN (
  SELECT
    s.contract_id,
    SUM(pa.allocated_amount) AS total_allocated_receipts
  FROM payment_allocations pa
  JOIN shipments s ON s.id = pa.shipment_id
  GROUP BY s.contract_id
) av ON av.contract_id = ec.id;

-- Shipment-level reconciliation: total allocated and outstanding balance.
CREATE OR REPLACE VIEW v_shipments_reconciliation AS
SELECT
  s.*,
  COALESCE(pa.total_allocated, 0)                    AS total_allocated,
  s.shipment_value - COALESCE(pa.total_allocated, 0) AS outstanding_balance,
  (s.shipment_value - COALESCE(pa.total_allocated, 0)) <= 0 AS fully_reconciled
FROM shipments s
LEFT JOIN (
  SELECT
    shipment_id,
    SUM(allocated_amount) AS total_allocated
  FROM payment_allocations
  GROUP BY shipment_id
) pa ON pa.shipment_id = s.id;

-- =============================================================================
-- RLS HELPER FUNCTION
-- Returns the set of exporter_ids the current Supabase Auth user belongs to.
-- SECURITY DEFINER so it can read exporter_users without the caller needing
-- direct SELECT on that table.
-- =============================================================================

CREATE OR REPLACE FUNCTION current_user_exporter_ids()
RETURNS SETOF UUID
LANGUAGE sql
STABLE
SECURITY DEFINER AS $$
  SELECT exporter_id
    FROM exporter_users
   WHERE user_id = auth.uid();
$$;

-- =============================================================================
-- ROW LEVEL SECURITY
-- All tenant-scoped tables restrict reads and writes to the owning exporter.
-- The current user's exporter membership is resolved via current_user_exporter_ids().
-- Supabase service role bypasses RLS by default (for backend jobs and migrations).
-- =============================================================================

ALTER TABLE exporters                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE exporter_settings          ENABLE ROW LEVEL SECURITY;
ALTER TABLE exporter_users             ENABLE ROW LEVEL SECURITY;
ALTER TABLE counterparties             ENABLE ROW LEVEL SECURITY;
ALTER TABLE counterparty_bank_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE export_contracts           ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipments                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE bills_of_lading            ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance_records         ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_receipts           ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_evidence           ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_allocations        ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_evidence_packs        ENABLE ROW LEVEL SECURITY;

-- exporters: visible only if the user is a member
CREATE POLICY rls_exporters_select ON exporters
  FOR SELECT USING (id IN (SELECT current_user_exporter_ids()));

-- exporter_settings: full access scoped to user's exporters
CREATE POLICY rls_exporter_settings ON exporter_settings
  FOR ALL USING (exporter_id IN (SELECT current_user_exporter_ids()));

-- exporter_users: users can see membership rows for their exporters
CREATE POLICY rls_exporter_users ON exporter_users
  FOR SELECT USING (exporter_id IN (SELECT current_user_exporter_ids()));

-- All remaining tables: full access scoped by exporter_id
CREATE POLICY rls_counterparties ON counterparties
  FOR ALL USING (exporter_id IN (SELECT current_user_exporter_ids()));

CREATE POLICY rls_counterparty_bank_accounts ON counterparty_bank_accounts
  FOR ALL USING (exporter_id IN (SELECT current_user_exporter_ids()));

CREATE POLICY rls_export_contracts ON export_contracts
  FOR ALL USING (exporter_id IN (SELECT current_user_exporter_ids()));

CREATE POLICY rls_shipments ON shipments
  FOR ALL USING (exporter_id IN (SELECT current_user_exporter_ids()));

CREATE POLICY rls_invoices ON invoices
  FOR ALL USING (exporter_id IN (SELECT current_user_exporter_ids()));

CREATE POLICY rls_bills_of_lading ON bills_of_lading
  FOR ALL USING (exporter_id IN (SELECT current_user_exporter_ids()));

CREATE POLICY rls_compliance_records ON compliance_records
  FOR ALL USING (exporter_id IN (SELECT current_user_exporter_ids()));

CREATE POLICY rls_payment_receipts ON payment_receipts
  FOR ALL USING (exporter_id IN (SELECT current_user_exporter_ids()));

CREATE POLICY rls_payment_evidence ON payment_evidence
  FOR ALL USING (exporter_id IN (SELECT current_user_exporter_ids()));

CREATE POLICY rls_payment_allocations ON payment_allocations
  FOR ALL USING (exporter_id IN (SELECT current_user_exporter_ids()));

CREATE POLICY rls_bank_evidence_packs ON bank_evidence_packs
  FOR ALL USING (exporter_id IN (SELECT current_user_exporter_ids()));

COMMIT;
