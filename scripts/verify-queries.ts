/**
 * Runs all five read-only query functions against the seeded local database
 * and prints a summary. Exits 1 if any query returns an error.
 *
 * Prerequisites:
 *   supabase start
 *   supabase db reset        # applies migrations + seed.sql
 *   cp .env.example .env.local
 *   npm install
 *   npm run verify
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import { createDbClient } from '../src/db/client'
import {
  listContractSummaries,
  listShipmentReconciliation,
  listBLDeadlines,
  listComplianceRecords,
  listEvidencePacks,
} from '../src/db/queries/index'

async function main() {
  const dbUrl      = process.env.DATABASE_URL
  const exporterId = process.env.VERIFY_EXPORTER_ID

  if (!dbUrl || !exporterId) {
    console.error('Missing env vars. Copy .env.example to .env.local and fill in values.')
    process.exit(1)
  }

  const client = createDbClient(dbUrl)
  let failed = false

  function pass(label: string) {
    console.log(`  ✓ ${label}`)
  }

  function fail(label: string, err: unknown) {
    const msg = err && typeof err === 'object' && 'message' in err
      ? (err as { message: string }).message
      : String(err)
    console.error(`  ✗ ${label}: ${msg}`)
    failed = true
  }

  console.log('=== ExportOS v0.2 — Read-Only Data Access Verification ===')
  console.log(`  exporter_id: ${exporterId}\n`)

  // ─── 1: Contract summaries ─────────────────────────────────────────────────
  console.log('[1/5] Contract summaries (v_export_contracts_summary)')
  {
    const { data, error } = await listContractSummaries(client, { exporterId })
    if (error || !data) {
      fail('query', error ?? 'no data')
    } else {
      pass(`${data.length} contract(s)`)
      for (const c of data) {
        console.log(
          `      ${c.contract_reference} | ${c.status} | ${c.currency} ${c.contract_value}` +
          ` | shipped: ${c.total_shipped_value} | allocated: ${c.total_allocated_receipts}` +
          ` | unallocated: ${c.unallocated_contract_value}`,
        )
      }
    }
  }

  // ─── 2: Shipment reconciliation ────────────────────────────────────────────
  console.log('\n[2/5] Shipment reconciliation (v_shipments_reconciliation)')
  {
    const { data, error } = await listShipmentReconciliation(client, { exporterId })
    if (error || !data) {
      fail('query', error ?? 'no data')
    } else {
      pass(`${data.length} shipment(s)`)
      for (const s of data) {
        console.log(
          `      ${s.shipment_reference} | ${s.status}` +
          ` | value: ${s.shipment_value} | allocated: ${s.total_allocated}` +
          ` | outstanding: ${s.outstanding_balance} | reconciled: ${s.fully_reconciled}`,
        )
      }
    }
  }

  // ─── 3: B/L deadline status ────────────────────────────────────────────────
  console.log('\n[3/5] B/L deadline status (v_bills_of_lading_deadline)')
  {
    const { data, error } = await listBLDeadlines(client, { exporterId })
    if (error || !data) {
      fail('query', error ?? 'no data')
    } else {
      pass(`${data.length} bill(s) of lading`)
      for (const bl of data) {
        console.log(
          `      ${bl.bl_number} | deadline: ${bl.repatriation_deadline}` +
          ` | ${bl.deadline_status} | days: ${bl.days_to_deadline}`,
        )
      }
    }
  }

  // ─── 4: Compliance records ──────────────────────────────────────────────────
  console.log('\n[4/5] Compliance records')
  {
    const { data, error } = await listComplianceRecords(client, { exporterId })
    if (error || !data) {
      fail('query', error ?? 'no data')
    } else {
      pass(`${data.length} record(s)`)
      for (const cr of data) {
        const checklist = [
          cr.nxp_approved              ? 'nxp'      : null,
          cr.cci_obtained              ? 'cci'      : null,
          cr.bl_uploaded               ? 'bl'       : null,
          cr.payment_evidence_uploaded ? 'evidence' : null,
          cr.credit_advice_confirmed   ? 'advice'   : null,
        ].filter(Boolean)
        console.log(
          `      shipment: ${cr.shipment_id.slice(-4)} | ${cr.repatriation_status}` +
          ` | received: ${cr.proceeds_received} / ${cr.proceeds_required}` +
          ` | outstanding: ${cr.proceeds_outstanding}` +
          ` | late: ${cr.was_repatriated_late}` +
          ` | checklist: [${checklist.join(', ')}]`,
        )
      }
    }
  }

  // ─── 5: Bank evidence packs ─────────────────────────────────────────────────
  console.log('\n[5/5] Bank evidence packs')
  {
    const { data, error } = await listEvidencePacks(client, { exporterId })
    if (error || !data) {
      fail('query', error ?? 'no data')
    } else {
      pass(`${data.length} pack(s)`)
      for (const pack of data) {
        console.log(
          `      v${pack.version} | shipment: ...${pack.shipment_id.slice(-4)}` +
          ` | sealed: ${pack.sealed} | status: ${pack.repatriation_status}`,
        )
      }
    }
  }

  await client.end()
  console.log(failed ? '\n✗ One or more queries failed.' : '\n✓ All 5 queries executed successfully.')
  process.exit(failed ? 1 : 0)
}

main()
