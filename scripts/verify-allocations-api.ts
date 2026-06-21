/**
 * Runtime verification for ExportOS v0.2 POST /payment-allocations.
 *
 * Prerequisites:
 *   npm run db:reset        (applies migrations + seed)
 *   npm run api             (server running in a separate terminal)
 *   npm run verify-allocations-api
 *
 * Schema notes:
 *   - payment_allocations: exporter_id + allocated_by server-derived from JWT
 *   - UNIQUE (receipt_id, shipment_id) — one allocation per receipt-shipment pair
 *   - trg_allocation_integrity (BEFORE INSERT): total allocated <= credited_amount
 *   - trg_allocation_side_effects (AFTER INSERT): syncs allocation_status on
 *     payment_receipts, proceeds_received + repatriation_status on compliance_records,
 *     and status on shipments (if departed)
 *
 * Seed data used:
 *   - SHIPMENT_2  = b0b00001-0000-0000-0000-000000000006
 *     (has a B/L and compliance_record; seeded allocation of 10,000 already exists)
 *
 * Test flow:
 *   - Create a fresh receipt with large credited_amount (no existing allocations)
 *   - Allocate the fresh receipt against SHIPMENT_2
 *   - Confirm receipt.allocation_status changed
 *   - Confirm compliance_records.proceeds_received increased
 *
 * Checks:
 *   1.  POST /payment-allocations without auth → 401
 *   2.  POST missing required fields → 400 with field list
 *   3.  POST with non-positive allocated_amount → 400
 *   4.  POST with invalid allocation_method → 400
 *   5.  POST with unknown receipt_id → 400
 *   6.  POST with unknown shipment_id → 400
 *   7.  POST valid allocation → 201 + allocation row
 *   8.  exporter_id server-derived (client value discarded)
 *   9.  allocated_by = JWT sub (client value discarded)
 *   10. Duplicate (same receipt_id + shipment_id) → 400
 *   11. Over-allocation → 400
 *   12. payment_receipt.allocation_status changed from UNALLOCATED
 *   13. compliance_records.proceeds_received increased after allocation
 *   14. Audit event written (entity_type=payment_allocation)
 *   15. Audit event action = CREATE
 *   16. Audit event actor_user_id = JWT sub
 *   17. GET /payment-allocations → 200 + includes new allocation
 *   18. GET /payment-allocations without auth → 401
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import jwt from 'jsonwebtoken'

const BASE              = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const EMAIL             = process.env.VERIFY_EMAIL       ?? 'operator@akoboexports.ng'
const PASSWORD          = process.env.VERIFY_PASSWORD    ?? 'dev-seed-password'
const EXPECTED_EXPORTER = process.env.VERIFY_EXPORTER_ID ?? 'b0b00001-0000-0000-0000-000000000001'

// Seeded shipment with a compliance record (BL inserted → compliance auto-created)
// Seeded allocation for this shipment: receipt_2 → shipment_2 = 10,000
const SHIPMENT_2 = 'b0b00001-0000-0000-0000-000000000006'

let passed = 0
let failed = 0

function ok(label: string)                   { console.log(`  ✓ ${label}`); passed++ }
function fail(label: string, detail: string) { console.error(`  ✗ ${label}: ${detail}`); failed++ }

async function req(
  method: 'GET' | 'POST',
  path: string,
  token?: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {}
  if (token) headers['Authorization'] = `Bearer ${token}`
  if (body)  headers['Content-Type']  = 'application/json'
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, body: await res.json() }
}

async function main() {
  console.log('=== ExportOS v0.2 — POST /payment-allocations Verification ===')
  console.log(`  server: ${BASE}\n`)

  // Authenticate
  const loginRes = await req('POST', '/auth/login', undefined, { email: EMAIL, password: PASSWORD })
  const loginBody = loginRes.body as Record<string, unknown>
  if (loginRes.status !== 200 || typeof loginBody.token !== 'string') {
    console.error(`  Fatal: login failed (${loginRes.status}): ${JSON.stringify(loginBody)}`)
    process.exit(1)
  }
  const token = loginBody.token as string
  const payload = jwt.decode(token) as Record<string, unknown>
  const expectedUserId = payload['sub'] as string
  console.log(`  (auth OK — userId=${expectedUserId})\n`)

  // Create a fresh receipt to allocate against (no prior allocations)
  const receiptRef = `ALLOC-TEST-${Date.now()}`
  let receiptId = ''
  {
    const { status, body } = await req('POST', '/payment-receipts', token, {
      receipt_reference: receiptRef,
      credit_date:       '2026-07-20',
      currency:          'USD',
      instructed_amount: 80000,
      credited_amount:   80000,
    })
    const data = (body as Record<string, unknown>).data as Record<string, unknown>
    if (status !== 201 || !data?.id) {
      console.error(`  Fatal: receipt creation failed (${status}): ${JSON.stringify(body).slice(0, 120)}`)
      process.exit(1)
    }
    receiptId = data.id as string
    console.log(`  (test receipt created: ${receiptId})\n`)
  }

  // Create a receipt with tiny credited_amount for over-allocation test
  let smallReceiptId = ''
  {
    const { status, body } = await req('POST', '/payment-receipts', token, {
      receipt_reference: `ALLOC-SMALL-${Date.now()}`,
      credit_date:       '2026-07-20',
      currency:          'USD',
      instructed_amount: 100,
      credited_amount:   100,
    })
    const data = (body as Record<string, unknown>).data as Record<string, unknown>
    if (status !== 201 || !data?.id) {
      console.error(`  Fatal: small receipt creation failed (${status}): ${JSON.stringify(body).slice(0, 120)}`)
      process.exit(1)
    }
    smallReceiptId = data.id as string
    console.log(`  (small receipt created: ${smallReceiptId})\n`)
  }

  // Get compliance proceeds_received for SHIPMENT_2 before our allocation
  let proceedsBeforeAllocation = 0
  {
    const { status, body } = await req('GET', `/compliance/${SHIPMENT_2}`, token)
    if (status !== 200) {
      console.error(`  Fatal: cannot fetch compliance for shipment_2 (${status}): ${JSON.stringify(body)}`)
      process.exit(1)
    }
    const data = (body as Record<string, unknown>).data as Record<string, unknown>
    proceedsBeforeAllocation = Number(data['proceeds_received'])
    console.log(`  (compliance.proceeds_received before allocation: ${proceedsBeforeAllocation})\n`)
  }

  // ── Check 1: POST without auth → 401 ─────────────────────────────────────
  {
    const { status } = await req('POST', '/payment-allocations', undefined, { receipt_id: receiptId })
    if (status !== 401) fail('POST /payment-allocations without auth', `expected 401, got ${status}`)
    else ok('POST /payment-allocations without auth — 401')
  }

  // ── Check 2: Missing required fields → 400 ───────────────────────────────
  {
    const { status, body } = await req('POST', '/payment-allocations', token, { receipt_id: receiptId })
    const b = body as Record<string, unknown>
    if (status !== 400 || !Array.isArray(b.fields) || (b.fields as string[]).length === 0) {
      fail('POST missing fields', `expected 400 + fields array, got ${status}: ${JSON.stringify(b).slice(0, 80)}`)
    } else {
      ok(`POST missing fields — 400 (fields: ${(b.fields as string[]).join(', ')})`)
    }
  }

  // ── Check 3: Non-positive allocated_amount → 400 ─────────────────────────
  {
    const { status } = await req('POST', '/payment-allocations', token, {
      receipt_id:        receiptId,
      shipment_id:       SHIPMENT_2,
      allocated_amount:  -500,
      allocation_method: 'MANUAL',
      allocation_date:   '2026-07-21',
    })
    if (status !== 400) fail('POST non-positive allocated_amount', `expected 400, got ${status}`)
    else ok('POST non-positive allocated_amount — 400')
  }

  // ── Check 4: Invalid allocation_method → 400 ─────────────────────────────
  {
    const { status } = await req('POST', '/payment-allocations', token, {
      receipt_id:        receiptId,
      shipment_id:       SHIPMENT_2,
      allocated_amount:  1000,
      allocation_method: 'INVALID_METHOD',
      allocation_date:   '2026-07-21',
    })
    if (status !== 400) fail('POST invalid allocation_method', `expected 400, got ${status}`)
    else ok('POST invalid allocation_method — 400')
  }

  // ── Check 5: Unknown receipt_id → 400 ────────────────────────────────────
  {
    const { status } = await req('POST', '/payment-allocations', token, {
      receipt_id:        '00000000-dead-dead-dead-000000000000',
      shipment_id:       SHIPMENT_2,
      allocated_amount:  1000,
      allocation_method: 'MANUAL',
      allocation_date:   '2026-07-21',
    })
    if (status !== 400) fail('POST unknown receipt_id', `expected 400, got ${status}`)
    else ok('POST unknown receipt_id — 400')
  }

  // ── Check 6: Unknown shipment_id → 400 ───────────────────────────────────
  {
    const { status } = await req('POST', '/payment-allocations', token, {
      receipt_id:        receiptId,
      shipment_id:       '00000000-dead-dead-dead-000000000000',
      allocated_amount:  1000,
      allocation_method: 'MANUAL',
      allocation_date:   '2026-07-21',
    })
    if (status !== 400) fail('POST unknown shipment_id', `expected 400, got ${status}`)
    else ok('POST unknown shipment_id — 400')
  }

  // ── Check 7: Valid POST → 201 + allocation row ────────────────────────────
  let allocationId = ''
  let allocationData: Record<string, unknown> = {}
  {
    const { status, body } = await req('POST', '/payment-allocations', token, {
      exporter_id:        '00000000-ffff-ffff-ffff-000000000000', // must be discarded
      allocated_by:       '00000000-ffff-ffff-ffff-000000000000', // must be discarded
      receipt_id:         receiptId,
      shipment_id:        SHIPMENT_2,
      allocated_amount:   20000,
      allocation_method:  'MANUAL',
      allocation_date:    '2026-07-21',
      notes:              'Test allocation — verify-allocations-api',
    })
    const data = (body as Record<string, unknown>).data as Record<string, unknown>
    if (status !== 201 || !data?.id) {
      console.error(`  Fatal: allocation creation failed (${status}): ${JSON.stringify(body).slice(0, 120)}`)
      process.exit(1)
    }
    allocationId   = data.id as string
    allocationData = data
    console.log(`  (allocation created: ${allocationId})\n`)
    ok(`POST /payment-allocations valid — 201 + id=${allocationId}`)
  }

  // ── Check 8: exporter_id server-derived ──────────────────────────────────
  if (allocationData['exporter_id'] !== EXPECTED_EXPORTER) {
    fail('exporter_id server-derived', `expected ${EXPECTED_EXPORTER}, got ${allocationData['exporter_id']}`)
  } else {
    ok(`exporter_id = ${allocationData['exporter_id']} (server-derived, client value discarded)`)
  }

  // ── Check 9: allocated_by = JWT sub ──────────────────────────────────────
  if (allocationData['allocated_by'] !== expectedUserId) {
    fail('allocated_by server-derived', `expected ${expectedUserId}, got ${allocationData['allocated_by']}`)
  } else {
    ok(`allocated_by = ${allocationData['allocated_by']} (server-derived from JWT, client value discarded)`)
  }

  // ── Check 10: Duplicate (receipt_id + shipment_id) → 400 ─────────────────
  {
    const { status, body } = await req('POST', '/payment-allocations', token, {
      receipt_id:        receiptId,
      shipment_id:       SHIPMENT_2,
      allocated_amount:  5000,
      allocation_method: 'MANUAL',
      allocation_date:   '2026-07-22',
    })
    if (status !== 400) {
      fail('Duplicate (receipt_id + shipment_id)', `expected 400, got ${status}: ${JSON.stringify(body).slice(0, 80)}`)
    } else {
      ok('Duplicate (receipt_id + shipment_id) → 400')
    }
  }

  // ── Check 11: Over-allocation → 400 ──────────────────────────────────────
  // smallReceiptId has credited_amount = 100; try to allocate 200
  {
    const { status } = await req('POST', '/payment-allocations', token, {
      receipt_id:        smallReceiptId,
      shipment_id:       SHIPMENT_2,
      allocated_amount:  200,
      allocation_method: 'MANUAL',
      allocation_date:   '2026-07-21',
    })
    if (status !== 400) fail('Over-allocation', `expected 400, got ${status}`)
    else ok('Over-allocation (200 > credited_amount 100) → 400')
  }

  // ── Check 12: payment_receipt.allocation_status changed ──────────────────
  {
    const { status, body } = await req('GET', `/payment-receipts/${receiptId}`, token)
    const data = (body as Record<string, unknown>).data as Record<string, unknown>
    if (status !== 200 || data?.['allocation_status'] === 'UNALLOCATED') {
      fail(
        'allocation_status changed from UNALLOCATED',
        `status ${status}, allocation_status=${data?.['allocation_status']}`,
      )
    } else {
      ok(`payment_receipt.allocation_status = ${data?.['allocation_status']} (trigger-set, no longer UNALLOCATED)`)
    }
  }

  // ── Check 13: compliance proceeds_received increased ─────────────────────
  {
    const { status, body } = await req('GET', `/compliance/${SHIPMENT_2}`, token)
    const data = (body as Record<string, unknown>).data as Record<string, unknown>
    const proceedsAfter = Number(data?.['proceeds_received'])
    if (status !== 200 || proceedsAfter <= proceedsBeforeAllocation) {
      fail(
        'compliance proceeds_received increased',
        `before=${proceedsBeforeAllocation}, after=${proceedsAfter}`,
      )
    } else {
      ok(`compliance.proceeds_received: ${proceedsBeforeAllocation} → ${proceedsAfter} (increased by 20,000)`)
    }
  }

  // Fetch audit event
  const { status: evStatus, body: evBody } = await req(
    'GET', `/audit-events?entity_type=payment_allocation&entity_id=${allocationId}`, token,
  )
  const evData = (evBody as Record<string, unknown>).data as Record<string, unknown>[]

  // ── Check 14: Audit event written ────────────────────────────────────────
  if (evStatus !== 200 || !Array.isArray(evData) || evData.length === 0) {
    fail('Audit event written', `expected 1 event, got ${evStatus}: ${JSON.stringify(evBody).slice(0, 100)}`)
    console.error('\n  Fatal: no audit event — cannot continue.')
    process.exit(1)
  }
  ok(`Audit event written — entity_type=payment_allocation, entity_id=${allocationId}`)

  const ev = evData[0]!

  // ── Check 15: action = CREATE ─────────────────────────────────────────────
  if (ev['action'] !== 'CREATE') fail('Audit event action', `expected CREATE, got ${ev['action']}`)
  else ok('Audit event action = CREATE')

  // ── Check 16: actor_user_id = JWT sub ────────────────────────────────────
  if (ev['actor_user_id'] !== expectedUserId) {
    fail('Audit event actor_user_id', `expected ${expectedUserId}, got ${ev['actor_user_id']}`)
  } else {
    ok(`Audit event actor_user_id = ${ev['actor_user_id']} (server-derived from JWT)`)
  }

  // ── Check 17: GET /payment-allocations includes new allocation ────────────
  {
    const { status, body } = await req('GET', '/payment-allocations', token)
    const b = body as Record<string, unknown>
    const list = b.data as Record<string, unknown>[]
    const found = Array.isArray(list) && list.some(a => a['id'] === allocationId)
    if (status !== 200 || !found) {
      fail('GET /payment-allocations includes new allocation', `status ${status}, found=${found}`)
    } else {
      ok(`GET /payment-allocations — new allocation in list (${list.length} total)`)
    }
  }

  // ── Check 18: GET without auth → 401 ─────────────────────────────────────
  {
    const { status } = await req('GET', '/payment-allocations')
    if (status !== 401) fail('GET /payment-allocations without auth', `expected 401, got ${status}`)
    else ok('GET /payment-allocations without auth — 401')
  }

  console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => {
  console.error(`\nFatal: ${err instanceof Error ? err.message : String(err)}`)
  console.error('Is the API server running? Start it with: npm run api')
  process.exit(1)
})
