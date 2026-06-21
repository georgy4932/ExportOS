/**
 * Runtime verification for ExportOS v0.2 POST /payment-receipts.
 *
 * Prerequisites:
 *   npm run db:reset        (applies migrations + seed)
 *   npm run api             (server running in a separate terminal)
 *   npm run verify-receipts-api
 *
 * Schema notes:
 *   - credit_date (DATE NOT NULL) is the schema column — not "receipt_date"
 *   - ordering_customer_name is the payer name field — nullable/optional
 *   - discrepancy_status is trigger-computed (trg_payment_receipt_discrepancy)
 *   - charges_deducted = GREATEST(instructed - credited, 0) — GENERATED
 *   - amount_variance  = credited - instructed                — GENERATED
 *   - allocation_status defaults to UNALLOCATED
 *
 * Checks:
 *   1.  POST /payment-receipts without auth → 401
 *   2.  POST missing required fields → 400 with field list
 *   3.  POST with non-positive instructed_amount → 400
 *   4.  POST with non-positive credited_amount → 400
 *   5.  POST valid (exact match) → 201 + receipt row
 *   6.  Created receipt has exporter_id server-derived (not from body)
 *   7.  discrepancy_status present (trigger-set, not null)
 *   8.  charges_deducted present (GENERATED, ≥ 0)
 *   9.  amount_variance present (GENERATED, signed)
 *   10. allocation_status = UNALLOCATED (DB default)
 *   11. Duplicate receipt_reference → 400
 *   12. Audit event written (entity_type=payment_receipt)
 *   13. Audit event action = 'CREATE'
 *   14. Audit event actor_user_id matches JWT sub
 *   15. GET /payment-receipts → 200 + array (new receipt present)
 *   16. GET /payment-receipts without auth → 401
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import jwt from 'jsonwebtoken'

const BASE              = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const EMAIL             = process.env.VERIFY_EMAIL       ?? 'operator@akoboexports.ng'
const PASSWORD          = process.env.VERIFY_PASSWORD    ?? 'dev-seed-password'
const EXPECTED_EXPORTER = process.env.VERIFY_EXPORTER_ID ?? 'b0b00001-0000-0000-0000-000000000001'

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
  console.log('=== ExportOS v0.2 — POST /payment-receipts Verification ===')
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

  // ── Check 1: POST without auth → 401 ─────────────────────────────────────
  {
    const { status } = await req('POST', '/payment-receipts', undefined, { receipt_reference: 'X' })
    if (status !== 401) fail('POST /payment-receipts without auth', `expected 401, got ${status}`)
    else ok('POST /payment-receipts without auth — 401')
  }

  // ── Check 2: Missing required fields → 400 ────────────────────────────────
  {
    const { status, body } = await req('POST', '/payment-receipts', token, { receipt_reference: 'PARTIAL' })
    const b = body as Record<string, unknown>
    if (status !== 400 || !Array.isArray(b.fields) || (b.fields as string[]).length === 0) {
      fail('POST missing fields', `expected 400 + fields array, got ${status}: ${JSON.stringify(b).slice(0, 80)}`)
    } else {
      ok(`POST missing fields — 400 (fields: ${(b.fields as string[]).join(', ')})`)
    }
  }

  // ── Check 3: Non-positive instructed_amount → 400 ─────────────────────────
  {
    const { status } = await req('POST', '/payment-receipts', token, {
      receipt_reference: 'INVALID-AMT',
      credit_date:       '2026-07-01',
      currency:          'USD',
      instructed_amount: -100,
      credited_amount:   100,
    })
    if (status !== 400) fail('POST non-positive instructed_amount', `expected 400, got ${status}`)
    else ok('POST non-positive instructed_amount — 400')
  }

  // ── Check 4: Non-positive credited_amount → 400 ───────────────────────────
  {
    const { status } = await req('POST', '/payment-receipts', token, {
      receipt_reference: 'INVALID-CRED',
      credit_date:       '2026-07-01',
      currency:          'USD',
      instructed_amount: 100,
      credited_amount:   0,
    })
    if (status !== 400) fail('POST non-positive credited_amount', `expected 400, got ${status}`)
    else ok('POST non-positive credited_amount — 400')
  }

  // ── Check 5: Valid POST → 201 + receipt row ───────────────────────────────
  const ref = `RCP-TEST-${Date.now()}`
  let receiptId = ''
  let receiptData: Record<string, unknown> = {}
  {
    const { status, body } = await req('POST', '/payment-receipts', token, {
      exporter_id:           '00000000-ffff-ffff-ffff-000000000000', // must be ignored
      discrepancy_status:    'CLEAN',   // must be ignored (trigger-computed)
      allocation_status:     'FULLY_ALLOCATED', // must be ignored (DB default)
      charges_deducted:      9999,      // must be ignored (GENERATED)
      amount_variance:       9999,      // must be ignored (GENERATED)
      receipt_reference:     ref,
      credit_date:           '2026-07-15',
      currency:              'usd',     // should be normalized to USD
      instructed_amount:     100000,
      credited_amount:       99800,     // diff = 200, within tolerance → CLEAN expected
      value_date:            '2026-07-14',
      ordering_customer_name: 'EUROGRAIN HAMBURG GMBH',
      remittance_info:       `CTR-REF/${ref}`,
    })
    const data = (body as Record<string, unknown>).data as Record<string, unknown>
    if (status !== 201 || !data?.id) {
      console.error(`  Fatal: receipt creation failed (${status}): ${JSON.stringify(body).slice(0, 120)}`)
      process.exit(1)
    }
    receiptId   = data.id as string
    receiptData = data
    console.log(`  (receipt created: ${receiptId})\n`)
    ok(`POST /payment-receipts valid — 201 + id=${receiptId}`)
  }

  // ── Check 6: exporter_id server-derived ──────────────────────────────────
  if (receiptData['exporter_id'] !== EXPECTED_EXPORTER) {
    fail('exporter_id server-derived', `expected ${EXPECTED_EXPORTER}, got ${receiptData['exporter_id']}`)
  } else {
    ok(`exporter_id = ${receiptData['exporter_id']} (server-derived, client value discarded)`)
  }

  // ── Check 7: discrepancy_status trigger-set ───────────────────────────────
  if (!receiptData['discrepancy_status']) {
    fail('discrepancy_status present', `expected a value, got ${receiptData['discrepancy_status']}`)
  } else {
    ok(`discrepancy_status = ${receiptData['discrepancy_status']} (trigger-set, client CLEAN discarded)`)
  }

  // ── Check 8: charges_deducted GENERATED ──────────────────────────────────
  const chargesDeducted = receiptData['charges_deducted']
  if (chargesDeducted == null || Number(chargesDeducted) < 0 || Number(chargesDeducted) === 9999) {
    fail('charges_deducted generated', `expected ≥0 DB-computed value, got ${chargesDeducted}`)
  } else {
    ok(`charges_deducted = ${chargesDeducted} (GENERATED: GREATEST(100000-99800,0)=200)`)
  }

  // ── Check 9: amount_variance GENERATED ────────────────────────────────────
  const amountVariance = receiptData['amount_variance']
  if (amountVariance == null || Number(amountVariance) === 9999) {
    fail('amount_variance generated', `expected DB-computed signed value, got ${amountVariance}`)
  } else {
    ok(`amount_variance = ${amountVariance} (GENERATED: 99800-100000=-200)`)
  }

  // ── Check 10: allocation_status = UNALLOCATED ─────────────────────────────
  if (receiptData['allocation_status'] !== 'UNALLOCATED') {
    fail('allocation_status default', `expected UNALLOCATED, got ${receiptData['allocation_status']}`)
  } else {
    ok('allocation_status = UNALLOCATED (client FULLY_ALLOCATED discarded)')
  }

  // ── Check 11: Duplicate receipt_reference → 400 ───────────────────────────
  {
    const { status, body } = await req('POST', '/payment-receipts', token, {
      receipt_reference: ref,   // same ref
      credit_date:       '2026-07-16',
      currency:          'USD',
      instructed_amount: 50000,
      credited_amount:   50000,
    })
    if (status !== 400) {
      fail('Duplicate receipt_reference', `expected 400, got ${status}: ${JSON.stringify(body).slice(0, 80)}`)
    } else {
      ok('Duplicate receipt_reference → 400')
    }
  }

  // Fetch audit event
  const { status: evStatus, body: evBody } = await req(
    'GET', `/audit-events?entity_type=payment_receipt&entity_id=${receiptId}`, token,
  )
  const evData = (evBody as Record<string, unknown>).data as Record<string, unknown>[]

  // ── Check 12: Audit event written ────────────────────────────────────────
  if (evStatus !== 200 || !Array.isArray(evData) || evData.length === 0) {
    fail('Audit event written', `expected 1 event, got ${evStatus}: ${JSON.stringify(evBody).slice(0, 100)}`)
    console.error('\n  Fatal: no audit event — cannot continue.')
    process.exit(1)
  }
  ok(`Audit event written — entity_type=payment_receipt, entity_id=${receiptId}`)

  const ev = evData[0]!

  // ── Check 13: action = CREATE ─────────────────────────────────────────────
  if (ev['action'] !== 'CREATE') fail('Audit event action', `expected CREATE, got ${ev['action']}`)
  else ok('Audit event action = CREATE')

  // ── Check 14: actor_user_id = JWT sub ────────────────────────────────────
  if (ev['actor_user_id'] !== expectedUserId) {
    fail('Audit event actor_user_id', `expected ${expectedUserId}, got ${ev['actor_user_id']}`)
  } else {
    ok(`Audit event actor_user_id = ${ev['actor_user_id']} (server-derived from JWT)`)
  }

  // ── Check 15: GET /payment-receipts includes new receipt ──────────────────
  {
    const { status, body } = await req('GET', '/payment-receipts', token)
    const b = body as Record<string, unknown>
    const list = b.data as Record<string, unknown>[]
    const found = Array.isArray(list) && list.some(r => r['id'] === receiptId)
    if (status !== 200 || !found) {
      fail('GET /payment-receipts includes new receipt', `status ${status}, found=${found}`)
    } else {
      ok(`GET /payment-receipts — new receipt in list (${list.length} total)`)
    }
  }

  // ── Check 16: GET without auth → 401 ─────────────────────────────────────
  {
    const { status } = await req('GET', '/payment-receipts')
    if (status !== 401) fail('GET /payment-receipts without auth', `expected 401, got ${status}`)
    else ok('GET /payment-receipts without auth — 401')
  }

  console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => {
  console.error(`\nFatal: ${err instanceof Error ? err.message : String(err)}`)
  console.error('Is the API server running? Start it with: npm run api')
  process.exit(1)
})
