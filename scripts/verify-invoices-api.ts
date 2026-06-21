/**
 * Runtime verification for ExportOS v0.2 invoices API.
 *
 * Prerequisites:
 *   npm run db:reset        (applies migrations + seed)
 *   npm run api             (server running in a separate terminal)
 *   npm run verify-invoices-api
 *
 * Schema notes:
 *   - invoices.exporter_id is always server-derived from JWT
 *   - shipment_id is nullable: PROFORMA invoices may exist before shipment assignment
 *   - UNIQUE (exporter_id, invoice_number) — 23505 → 400
 *   - No triggers on the invoices table itself
 *   - invoice_type enum: PROFORMA | COMMERCIAL
 *
 * Test flow:
 *   - Create a contract dynamically (uses seeded COUNTERPARTY_ID)
 *   - Create invoices against that contract
 *   - Validate all IDOR and validation paths
 *
 * Checks:
 *   1.  POST without auth → 401
 *   2.  POST missing required fields → 400 + fields array
 *   3.  POST invalid invoice_type → 400
 *   4.  POST invoice_amount ≤ 0 → 400
 *   5.  POST unknown contract_id → 400
 *   6.  POST valid PROFORMA invoice (no shipment_id) → 201
 *   7.  exporter_id server-derived (client value discarded)
 *   8.  POST duplicate invoice_number same exporter → 400
 *   9.  POST valid COMMERCIAL invoice with shipment_id → 201
 *   10. shipment_id present in response
 *   11. POST with unknown shipment_id → 400
 *   12. Audit event written (entity_type=invoice)
 *   13. Audit event action = CREATE, actor_user_id = JWT sub
 *   14. GET /invoices → 200 + new invoices in list
 *   15. GET /invoices/:id → 200 + correct record
 *   16. GET /invoices without auth → 401
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import jwt from 'jsonwebtoken'

const BASE              = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const EMAIL             = process.env.VERIFY_EMAIL       ?? 'operator@akoboexports.ng'
const PASSWORD          = process.env.VERIFY_PASSWORD    ?? 'dev-seed-password'
const EXPECTED_EXPORTER = process.env.VERIFY_EXPORTER_ID ?? 'b0b00001-0000-0000-0000-000000000001'
const COUNTERPARTY_ID   = 'b0b00001-0000-0000-0000-000000000002'  // EUROGRAIN HAMBURG GMBH (seeded)
const SHIPMENT_2        = 'b0b00001-0000-0000-0000-000000000006'  // seeded shipment with BL + compliance

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
  console.log('=== ExportOS v0.2 — Invoices API Verification ===')
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

  // Create a contract to use throughout the checks
  const contractRef = `INV-TEST-CONTRACT-${Date.now()}`
  const contractRes = await req('POST', '/contracts', token, {
    contract_reference:  contractRef,
    counterparty_id:     COUNTERPARTY_ID,
    commodity:           'Sesame Seeds',
    commodity_type:      'NON_OIL',
    hs_code:             '1207.40',
    contract_quantity:   500,
    quantity_unit:       'MT',
    contract_value:      250000,
    currency:            'USD',
    unit_price:          500,
    incoterms:           'FOB',
    destination_country: 'DE',
    payment_terms:       'LC at sight',
    contract_date:       '2026-06-01',
  })
  const contractData = (contractRes.body as Record<string, unknown>).data as Record<string, unknown>
  if (contractRes.status !== 201 || !contractData?.id) {
    console.error(`  Fatal: contract creation failed (${contractRes.status}): ${JSON.stringify(contractRes.body).slice(0, 120)}`)
    process.exit(1)
  }
  const contractId = contractData.id as string
  console.log(`  (contract created: ${contractId})\n`)

  const UNKNOWN_ID = '00000000-dead-dead-dead-000000000000'

  // ── Check 1: POST without auth → 401 ─────────────────────────────────────
  {
    const { status } = await req('POST', '/invoices', undefined, {
      contract_id: contractId, invoice_number: 'INV-001',
      invoice_type: 'PROFORMA', invoice_date: '2026-06-15',
      invoice_amount: 50000, currency: 'USD',
    })
    if (status !== 401) fail('POST /invoices without auth', `expected 401, got ${status}`)
    else ok('POST /invoices without auth — 401')
  }

  // ── Check 2: POST missing required fields → 400 + fields array ───────────
  {
    const { status, body } = await req('POST', '/invoices', token, {})
    const b = body as Record<string, unknown>
    const fields = b.fields as string[] | undefined
    const allRequired = ['contract_id', 'invoice_number', 'invoice_type', 'invoice_date', 'invoice_amount', 'currency']
    const allPresent = Array.isArray(fields) && allRequired.every(f => fields.includes(f))
    if (status !== 400 || !allPresent) {
      fail('POST missing required fields', `expected 400 + all required fields, got ${status}: ${JSON.stringify(b).slice(0, 100)}`)
    } else {
      ok(`POST missing required fields — 400 (fields: ${fields!.join(', ')})`)
    }
  }

  // ── Check 3: POST invalid invoice_type → 400 ─────────────────────────────
  {
    const { status } = await req('POST', '/invoices', token, {
      contract_id: contractId, invoice_number: 'INV-X',
      invoice_type: 'DRAFT', invoice_date: '2026-06-15',
      invoice_amount: 50000, currency: 'USD',
    })
    if (status !== 400) fail('POST invalid invoice_type', `expected 400, got ${status}`)
    else ok('POST invalid invoice_type — 400')
  }

  // ── Check 4: POST invoice_amount ≤ 0 → 400 ───────────────────────────────
  {
    const { status } = await req('POST', '/invoices', token, {
      contract_id: contractId, invoice_number: 'INV-X',
      invoice_type: 'PROFORMA', invoice_date: '2026-06-15',
      invoice_amount: 0, currency: 'USD',
    })
    if (status !== 400) fail('POST invoice_amount <= 0', `expected 400, got ${status}`)
    else ok('POST invoice_amount = 0 — 400')
  }

  // ── Check 5: POST unknown contract_id → 400 ──────────────────────────────
  {
    const { status } = await req('POST', '/invoices', token, {
      contract_id: UNKNOWN_ID, invoice_number: 'INV-X',
      invoice_type: 'PROFORMA', invoice_date: '2026-06-15',
      invoice_amount: 50000, currency: 'USD',
    })
    if (status !== 400) fail('POST unknown contract_id', `expected 400, got ${status}`)
    else ok('POST unknown contract_id — 400')
  }

  // ── Check 6: Valid PROFORMA invoice (no shipment_id) → 201 ───────────────
  const invoiceNumber1 = `INV-PROFORMA-${Date.now()}`
  let invoiceId1 = ''
  let invoiceData1: Record<string, unknown> = {}
  {
    const { status, body } = await req('POST', '/invoices', token, {
      exporter_id:    '00000000-ffff-ffff-ffff-000000000000',  // must be discarded
      contract_id:    contractId,
      invoice_number: invoiceNumber1,
      invoice_type:   'PROFORMA',
      invoice_date:   '2026-06-15',
      invoice_amount: 50000,
      currency:       'usd',   // should be normalised to USD
      description:    '500MT Sesame Seeds — proforma',
    })
    const data = (body as Record<string, unknown>).data as Record<string, unknown>
    if (status !== 201 || !data?.id) {
      console.error(`  Fatal: PROFORMA invoice creation failed (${status}): ${JSON.stringify(body).slice(0, 120)}`)
      process.exit(1)
    }
    invoiceId1   = data.id as string
    invoiceData1 = data
    console.log(`  (PROFORMA invoice created: ${invoiceId1})\n`)
    ok(`POST /invoices (PROFORMA) — 201, id=${invoiceId1}`)
  }

  // ── Check 7: exporter_id server-derived ──────────────────────────────────
  if (invoiceData1['exporter_id'] !== EXPECTED_EXPORTER) {
    fail('exporter_id server-derived', `expected ${EXPECTED_EXPORTER}, got ${invoiceData1['exporter_id']}`)
  } else {
    ok(`exporter_id = ${invoiceData1['exporter_id']} (server-derived, client value discarded)`)
  }

  // ── Check 8: Duplicate invoice_number → 400 ──────────────────────────────
  {
    const { status, body } = await req('POST', '/invoices', token, {
      contract_id: contractId, invoice_number: invoiceNumber1,
      invoice_type: 'COMMERCIAL', invoice_date: '2026-06-16',
      invoice_amount: 49000, currency: 'USD',
    })
    if (status !== 400) {
      fail('POST duplicate invoice_number', `expected 400, got ${status}: ${JSON.stringify(body).slice(0, 80)}`)
    } else {
      ok('POST duplicate invoice_number — 400')
    }
  }

  // ── Check 9: Valid COMMERCIAL invoice with shipment_id → 201 ─────────────
  let invoiceId2 = ''
  let invoiceData2: Record<string, unknown> = {}
  {
    const { status, body } = await req('POST', '/invoices', token, {
      contract_id:    contractId,
      shipment_id:    SHIPMENT_2,
      invoice_number: `INV-COMMERCIAL-${Date.now()}`,
      invoice_type:   'COMMERCIAL',
      invoice_date:   '2026-06-20',
      invoice_amount: 48500,
      currency:       'USD',
      description:    '500MT Sesame Seeds — commercial',
      document_url:   'https://docs.example.com/inv-001.pdf',
    })
    const data = (body as Record<string, unknown>).data as Record<string, unknown>
    if (status !== 201 || !data?.id) {
      fail('POST COMMERCIAL invoice with shipment_id', `expected 201, got ${status}: ${JSON.stringify(body).slice(0, 120)}`)
    } else {
      invoiceId2   = data.id as string
      invoiceData2 = data
      console.log(`  (COMMERCIAL invoice created: ${invoiceId2})\n`)
      ok(`POST /invoices (COMMERCIAL + shipment_id) — 201, id=${invoiceId2}`)
    }
  }

  // ── Check 10: shipment_id present in response ─────────────────────────────
  if (invoiceId2) {
    if (invoiceData2['shipment_id'] !== SHIPMENT_2) {
      fail('shipment_id in response', `expected ${SHIPMENT_2}, got ${invoiceData2['shipment_id']}`)
    } else {
      ok(`shipment_id = ${invoiceData2['shipment_id']} (correct)`)
    }
  } else {
    fail('shipment_id in response', 'skipped — COMMERCIAL invoice creation failed')
  }

  // ── Check 11: POST with unknown shipment_id → 400 ────────────────────────
  {
    const { status } = await req('POST', '/invoices', token, {
      contract_id:    contractId,
      shipment_id:    UNKNOWN_ID,
      invoice_number: `INV-BAD-SHIP-${Date.now()}`,
      invoice_type:   'COMMERCIAL',
      invoice_date:   '2026-06-20',
      invoice_amount: 48500,
      currency:       'USD',
    })
    if (status !== 400) fail('POST unknown shipment_id', `expected 400, got ${status}`)
    else ok('POST unknown shipment_id — 400')
  }

  // ── Check 12–13: Audit event ──────────────────────────────────────────────
  const { status: evStatus, body: evBody } = await req(
    'GET', `/audit-events?entity_type=invoice&entity_id=${invoiceId1}`, token,
  )
  const evData = (evBody as Record<string, unknown>).data as Record<string, unknown>[]

  if (evStatus !== 200 || !Array.isArray(evData) || evData.length === 0) {
    fail('Audit event written', `expected 1 event, got ${evStatus}: ${JSON.stringify(evBody).slice(0, 100)}`)
    console.error('\n  Fatal: no audit event — cannot continue.')
    process.exit(1)
  }
  ok(`Audit event written — entity_type=invoice, entity_id=${invoiceId1}`)

  const ev = evData[0]!

  // ── Check 13: action = CREATE + actor_user_id = JWT sub ──────────────────
  if (ev['action'] !== 'CREATE') {
    fail('Audit event action', `expected CREATE, got ${ev['action']}`)
  } else {
    ok('Audit event action = CREATE')
  }
  if (ev['actor_user_id'] !== expectedUserId) {
    fail('Audit event actor_user_id', `expected ${expectedUserId}, got ${ev['actor_user_id']}`)
  } else {
    ok(`Audit event actor_user_id = ${ev['actor_user_id']} (server-derived from JWT)`)
  }

  // ── Check 14: GET /invoices → 200 + new invoices present ─────────────────
  {
    const { status, body } = await req('GET', '/invoices', token)
    const b = body as Record<string, unknown>
    const list = b.data as Record<string, unknown>[]
    const found = Array.isArray(list) && list.some(i => i['id'] === invoiceId1)
    if (status !== 200 || !found) {
      fail('GET /invoices includes new invoice', `status ${status}, found=${found}`)
    } else {
      ok(`GET /invoices — new invoice in list (${list.length} total)`)
    }
  }

  // ── Check 15: GET /invoices/:id → 200 + correct record ───────────────────
  {
    const { status, body } = await req('GET', `/invoices/${invoiceId1}`, token)
    const data = (body as Record<string, unknown>).data as Record<string, unknown>
    if (status !== 200 || data?.['id'] !== invoiceId1) {
      fail('GET /invoices/:id', `status ${status}, id=${data?.['id']}`)
    } else {
      ok(`GET /invoices/${invoiceId1} — 200, invoice_type=${data['invoice_type']}, currency=${data['currency']}`)
    }
  }

  // ── Check 16: GET without auth → 401 ─────────────────────────────────────
  {
    const { status } = await req('GET', '/invoices')
    if (status !== 401) fail('GET /invoices without auth', `expected 401, got ${status}`)
    else ok('GET /invoices without auth — 401')
  }

  console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => {
  console.error(`\nFatal: ${err instanceof Error ? err.message : String(err)}`)
  console.error('Is the API server running? Start it with: npm run api')
  process.exit(1)
})
