// Database types for ExportOS v0.2.
//
// MAINTENANCE: This file is hand-written from migrations 0001–0003.
// It is NOT auto-generated. Every time a migration adds, removes, or renames a
// column, enum value, table, or view, the corresponding type(s) here must be
// updated to match. The recommended workflow:
//   1. Write the migration SQL.
//   2. Apply it locally: supabase db reset
//   3. Update this file to reflect the schema change.
//   4. Run: npm run typecheck   (must exit 0 before committing)
//
// Alternatively, replace this file with Supabase's generated types:
//   supabase gen types typescript --local > src/db/types.ts
// and adapt the exported aliases below to match.
//
// Do not add write mutations to this file or to src/db/queries/.

export type Json = string | number | boolean | null | { [key: string]: Json } | Json[]

// ─── Enums ──────────────────────────────────────────────────────────────────

export type ContractStatus =
  | 'DRAFT'
  | 'ACTIVE'
  | 'PARTIALLY_SHIPPED'
  | 'FULLY_SHIPPED'
  | 'CLOSED'
  | 'CANCELLED'

export type ShipmentStatus =
  | 'PENDING'
  | 'DEPARTED'
  | 'ARRIVED'
  | 'PROCEEDS_PARTIAL'
  | 'PROCEEDS_COMPLETE'
  | 'OVERDUE'

export type RepatriationStatus = 'NOT_DUE' | 'PARTIAL' | 'COMPLETE' | 'OVERDUE'

export type DiscrepancyStatus =
  | 'CLEAN'
  | 'AMOUNT_MISMATCH'
  | 'DATE_MISMATCH'
  | 'COUNTERPARTY_MISMATCH'
  | 'UNMATCHED'
  | 'MANUALLY_RESOLVED'

export type AllocationStatus = 'UNALLOCATED' | 'PARTIALLY_ALLOCATED' | 'FULLY_ALLOCATED'

export type AllocationMethod = 'MANUAL' | 'FIFO' | 'PRO_RATA' | 'INSTRUCTION_MATCHED'

export type EvidenceType =
  | 'MT103'
  | 'PACS008'
  | 'MT910'
  | 'BANK_CREDIT_ADVICE'
  | 'MT940_LINE'
  | 'MT950_LINE'
  | 'MANUAL'

export type BlType = 'ORIGINAL' | 'TELEX_RELEASE' | 'SEA_WAYBILL' | 'EXPRESS_BL'

export type DeadlineStatus = 'SAFE' | 'WARNING' | 'CRITICAL' | 'OVERDUE'

export type CounterpartyType = 'COMPANY' | 'INDIVIDUAL' | 'GOVERNMENT_ENTITY'

export type KycStatus = 'NOT_STARTED' | 'PENDING' | 'VERIFIED' | 'FLAGGED'

export type InvoiceType = 'PROFORMA' | 'COMMERCIAL'

export type ChargesCode = 'OUR' | 'SHA' | 'BEN'

export type CommodityType = 'NON_OIL' | 'OIL_GAS'

export type FreightTerms = 'PREPAID' | 'COLLECT'

// ─── Table Row types ─────────────────────────────────────────────────────────

export interface ExporterRow {
  id: string
  legal_name: string
  trading_name: string | null
  country: string
  registration_number: string | null
  tin: string | null
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface ExporterSettingsRow {
  id: string
  exporter_id: string
  charges_tolerance_pct: number
  charges_tolerance_max_abs: number
  default_repatriation_days_non_oil: number
  default_repatriation_days_oil_gas: number
  created_at: string
  updated_at: string
}

export interface ExporterUserRow {
  id: string
  exporter_id: string
  user_id: string
  role: string
  created_at: string
}

export interface CounterpartyRow {
  id: string
  exporter_id: string
  legal_name: string
  trading_name: string | null
  country_of_incorporation: string
  registered_address: string | null
  registration_number: string | null
  tin: string | null
  counterparty_type: CounterpartyType
  beneficial_owner_disclosed: boolean
  beneficial_owner_name: string | null
  kyc_status: KycStatus
  kyc_notes: string | null
  is_sanctioned_flag: boolean
  created_at: string
  updated_at: string
}

export interface CounterpartyBankAccountRow {
  id: string
  counterparty_id: string
  exporter_id: string
  bank_name: string
  bank_country: string
  swift_bic: string
  account_number: string | null
  account_name: string
  currency: string
  is_primary: boolean
  created_at: string
}

export interface ExportContractRow {
  id: string
  contract_reference: string
  exporter_id: string
  counterparty_id: string
  commodity: string
  commodity_type: CommodityType
  hs_code: string
  contract_quantity: number
  quantity_unit: string
  contract_value: number
  currency: string
  unit_price: number
  incoterms: string
  destination_country: string
  destination_port: string | null
  payment_terms: string
  partial_shipment_allowed: boolean
  contract_date: string
  expiry_date: string | null
  status: ContractStatus
  notes: string | null
  created_at: string
  updated_at: string
}

export interface ShipmentRow {
  id: string
  contract_id: string
  exporter_id: string
  shipment_reference: string
  shipment_sequence: number
  nxp_reference: string
  port_of_loading: string
  port_of_discharge: string
  shipment_quantity: number
  shipment_value: number
  currency: string
  shipping_line: string | null
  vessel_name: string | null
  voyage_number: string | null
  status: ShipmentStatus
  created_at: string
  updated_at: string
}

export interface InvoiceRow {
  id: string
  contract_id: string
  shipment_id: string | null
  exporter_id: string
  invoice_number: string
  invoice_type: InvoiceType
  invoice_date: string
  invoice_amount: number
  currency: string
  description: string | null
  document_url: string | null
  created_at: string
}

export interface BillOfLadingRow {
  id: string
  shipment_id: string
  exporter_id: string
  bl_number: string
  bl_date: string
  bl_type: BlType
  shipper_name: string
  consignee_name: string
  notify_party: string | null
  description_of_goods: string
  gross_weight_kg: number | null
  number_of_packages: number | null
  container_numbers: string[] | null
  freight_terms: FreightTerms | null
  place_of_receipt: string | null
  place_of_delivery: string | null
  nxp_reference: string
  repatriation_days: number
  repatriation_deadline: string
  document_url: string | null
  created_at: string
  updated_at: string
}

export interface ComplianceRecordRow {
  id: string
  shipment_id: string
  exporter_id: string
  repatriation_deadline: string
  days_remaining: number
  repatriation_status: RepatriationStatus
  proceeds_required: number
  proceeds_received: number
  proceeds_outstanding: number        // GENERATED: proceeds_required - proceeds_received
  nxp_submitted: boolean
  nxp_approved: boolean
  cci_obtained: boolean
  bl_uploaded: boolean
  payment_evidence_uploaded: boolean
  credit_advice_confirmed: boolean
  bank_evidence_pack_generated: boolean
  compliance_flags: string[] | null
  last_reviewed_at: string | null
  notes: string | null
  was_repatriated_late: boolean       // migration 0003
  completed_after_deadline_at: string | null  // migration 0003
  created_at: string
  updated_at: string
}

export interface PaymentReceiptRow {
  id: string
  exporter_id: string
  receipt_reference: string
  instructed_amount: number
  credited_amount: number
  charges_deducted: number | null   // GENERATED: GREATEST(instructed - credited, 0)
  amount_variance: number | null    // GENERATED: credited - instructed (migration 0003)
  currency: string
  credit_date: string
  value_date: string | null
  domiciliary_account_ref: string | null
  ordering_bank_bic: string | null
  ordering_customer_name: string | null
  remittance_info: string | null
  discrepancy_status: DiscrepancyStatus
  discrepancy_notes: string | null
  allocation_status: AllocationStatus
  created_at: string
  updated_at: string
}

export interface PaymentEvidenceRow {
  id: string
  exporter_id: string
  receipt_id: string | null
  evidence_type: EvidenceType
  source_document_ref: string | null
  sender_bic: string | null
  receiver_bic: string | null
  instructed_amount: number | null
  instructed_currency: string | null
  value_date: string | null
  charges_code: ChargesCode | null
  ordering_customer: string | null
  beneficiary_customer: string | null
  remittance_info: string | null
  document_url: string | null
  superseded_by: string | null
  uploaded_by: string
  created_at: string
  // BANK_CREDIT_ADVICE fields — migration 0002
  credited_amount: number | null
  credited_currency: string | null
  credit_date: string | null
  bank_ref: string | null
  payer_account: string | null
  payer_name: string | null
}

export interface PaymentAllocationRow {
  id: string
  exporter_id: string
  receipt_id: string
  shipment_id: string
  invoice_id: string | null
  allocated_amount: number
  allocation_method: AllocationMethod
  allocation_date: string
  allocated_by: string
  notes: string | null
  created_at: string
}

export interface BankEvidencePackRow {
  id: string
  shipment_id: string
  exporter_id: string
  version: number
  generated_at: string
  generated_by: string
  contract_snapshot: Json
  shipment_snapshot: Json
  invoice_ids: string[]
  bl_id: string
  nxp_reference: string
  payment_evidence_ids: string[]
  receipt_ids: string[]
  allocation_ids: string[]
  compliance_status_snapshot: Json
  repatriation_status: RepatriationStatus
  pack_url: string | null
  sealed: boolean
  notes: string | null
}

// ─── View Row types ──────────────────────────────────────────────────────────

export interface ContractSummaryRow extends ExportContractRow {
  total_shipped_value: number
  shipment_count: number
  total_allocated_receipts: number
  unallocated_contract_value: number
}

export interface ShipmentReconciliationRow extends ShipmentRow {
  total_allocated: number
  outstanding_balance: number
  fully_reconciled: boolean
}

export interface BLDeadlineRow extends BillOfLadingRow {
  days_to_deadline: number | null
  deadline_status: DeadlineStatus
}

// ─── Database interface (used by createClient<Database>) ─────────────────────

type T<R> = { Row: R; Insert: Partial<R>; Update: Partial<R> }
type V<R> = { Row: R }

export interface Database {
  public: {
    Tables: {
      exporters:                  T<ExporterRow>
      exporter_settings:          T<ExporterSettingsRow>
      exporter_users:             T<ExporterUserRow>
      counterparties:             T<CounterpartyRow>
      counterparty_bank_accounts: T<CounterpartyBankAccountRow>
      export_contracts:           T<ExportContractRow>
      shipments:                  T<ShipmentRow>
      invoices:                   T<InvoiceRow>
      bills_of_lading:            T<BillOfLadingRow>
      compliance_records:         T<ComplianceRecordRow>
      payment_receipts:           T<PaymentReceiptRow>
      payment_evidence:           T<PaymentEvidenceRow>
      payment_allocations:        T<PaymentAllocationRow>
      bank_evidence_packs:        T<BankEvidencePackRow>
    }
    Views: {
      v_export_contracts_summary: V<ContractSummaryRow>
      v_shipments_reconciliation: V<ShipmentReconciliationRow>
      v_bills_of_lading_deadline: V<BLDeadlineRow>
    }
    Functions: {
      current_user_exporter_ids: { Args: Record<string, never>; Returns: string[] }
    }
    Enums: {
      contract_status:      ContractStatus
      shipment_status:      ShipmentStatus
      repatriation_status:  RepatriationStatus
      discrepancy_status:   DiscrepancyStatus
      allocation_status:    AllocationStatus
      allocation_method:    AllocationMethod
      evidence_type:        EvidenceType
      bl_type:              BlType
      deadline_status:      DeadlineStatus
      counterparty_type:    CounterpartyType
      kyc_status:           KycStatus
      invoice_type:         InvoiceType
      charges_code:         ChargesCode
      commodity_type:       CommodityType
      freight_terms:        FreightTerms
    }
    CompositeTypes: Record<string, never>
  }
}
