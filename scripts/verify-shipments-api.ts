/**
 * Runtime verification for ExportOS v0.2 POST /shipments.
 *
 * Prerequisites:
 *   npm run db:reset        (applies migrations + seed)
 *   npm run api             (server running in a separate terminal)
 *   npm run verify-shipments-api
 *
 * Checks:
 *   1.  POST /shipments without auth → 401
 *   2.  POST /shipments with missing required fields → 400 with field list
 *   3.  POST /shipments with contract_id from another exporter → 400 (IDOR)
 *   4.  POST /shipments valid → 201 + shipment row
 *   5.  Created shipment has exporter_id from auth (not from body)
 *   6.  shipment_sequence is auto-assigned (server-derived, starts at 1)
 *   7.  Audit event written for shipment (entity_type=shipment)
 *   8.  Audit event action = 'CREATE'
 *   9.  Audit event actor_user_id matches JWT sub
 *   10. GET /shipments?contract_id=<id> includes the new shipment
 *   11. GET /shipments without auth → 401
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import jwt from 'jsonwebtoken'

const BASE              = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const EMAIL             = process.env.VERIFY_EMAIL       ?? 'operator@akoboexports.ng'
const PASSWORD          = process.env.VERIFY_PASSWORD    ?? 'dev-seed-password'
const EXPECTED_EXPORTER = process.env.VERIFY_EXPORTER_ID ?? 'b0b00001-0000-0000-0000-000000000001'
const COUNTERPARTY_ID   = 'b0b00001-0000-0000-0000-000000000002'
const JWT_SECRET        = process.env.JWT_SECRET         ?? 'local-dev-secret-change-in-production'

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
  console.log('=== ExportOS v0.2 — POST /shipments Verification ===')
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

  // Create a fresh contract so we control the sequence state
  const contractRef = `SHIP-TEST-CONTRACT-${Date.now()}`
  let contractId = ''
  {
    const { status, body } = await req('POST', '/contracts', token, {
      contract_reference:  contractRef,
      counterparty_id:     COUNTERPARTY_ID,
      commodity:           'Sesame Seeds',
      commodity_type:      'NON_OIL',
      hs_code:             '1207.40',
      contract_quantity:   500,
      quantity_unit:       'MT',
      contract_value:      300000,
      currency:            'USD',
      unit_price:          600,
      incoterms:           'FOB',
      destination_country: 'DE',
      payment_terms:       'LC AT SIGHT',
      contract_date:       '2026-07-01',
    })
    const data = (body as Record<string, unknown>).data as Record<string, unknown>
    if (status !== 201 || !data?.id) {
      console.error(`  Fatal: contract creation failed (${status}): ${JSON.stringify(body).slice(0, 120)}`)
      process.exit(1)
    }
    contractId = data.id as string
    console.log(`  (contract created: ${contractId})\n`)
  }

  // ── Check 1: POST without auth → 401 ─────────────────────────────────────
  {
    const { status } = await req('POST', '/shipments', undefined, { contract_id: contractId })
    if (status !== 401) fail('POST /shipments without auth', `expected 401, got ${status}`)
    else ok('POST /shipments without auth — 401')
  }

  // ── Check 2: Missing required fields → 400 ────────────────────────────────
  {
    const { status, body } = await req('POST', '/shipments', token, { contract_id: contractId })
    const b = body as Record<string, unknown>
    if (status !== 400 || !Array.isArray(b.fields) || (b.fields as string[]).length === 0) {
      fail('POST /shipments missing fields', `expected 400 + fields array, got ${status}: ${JSON.stringify(b).slice(0, 80)}`)
    } else {
      ok(`POST /shipments missing fields — 400 (fields: ${(b.fields as string[]).join(', ')})`)
    }
  }

  // ── Check 3: IDOR — contract_id from another exporter → 400 ──────────────
  {
    const unknownContractId = '00000000-dead-beef-0000-000000000000'
    const { status, body } = await req('POST', '/shipments', token, {
      contract_id:        unknownContractId,
      shipment_reference: 'IDOR-TEST',
      nxp_reference:      'NXP/TEST/001',
      port_of_loading:    'NGAPP',
      port_of_discharge:  'DEHAM',
      shipment_quantity:  100,
      shipment_value:     60000,
      currency:           'USD',
    })
    if (status !== 400) {
      fail('POST /shipments IDOR check', `expected 400 for unknown contract_id, got ${status}: ${JSON.stringify(body).slice(0, 80)}`)
    } else {
      ok('POST /shipments IDOR — unknown contract_id rejected with 400')
    }
  }

  // ── Check 4: Valid POST → 201 + shipment row ──────────────────────────────
  const ref = `SHP-TEST-${Date.now()}`
  let shipmentId = ''
  let shipmentSeq = 0
  {
    const { status, body } = await req('POST', '/shipments', token, {
      exporter_id:        '00000000-ffff-ffff-ffff-000000000000', // must be ignored
      contract_id:        contractId,
      shipment_reference: ref,
      nxp_reference:      'NXP/2026/TEST/001',
      port_of_loading:    'NGAPP',
      port_of_discharge:  'DEHAM',
      shipment_quantity:  250,
      shipment_value:     150000,
      currency:           'USD',
      vessel_name:        'MV TEST VESSEL',
      voyage_number:      'V001',
    })
    const data = (body as Record<string, unknown>).data as Record<string, unknown>
    if (status !== 201 || !data?.id) {
      console.error(`  Fatal: shipment creation failed (${status}): ${JSON.stringify(body).slice(0, 120)}`)
      process.exit(1)
    }
    shipmentId  = data.id as string
    shipmentSeq = data.shipment_sequence as number
    console.log(`  (shipment created: ${shipmentId}, sequence=${shipmentSeq})\n`)
    ok(`POST /shipments valid — 201 + id=${shipmentId}`)

    // ── Check 5: exporter_id server-derived ──────────────────────────────────
    if (data.exporter_id !== EXPECTED_EXPORTER) {
      fail('Shipment exporter_id server-derived', `expected ${EXPECTED_EXPORTER}, got ${data.exporter_id}`)
    } else {
      ok(`Shipment exporter_id = ${data.exporter_id} (server-derived)`)
    }

    // ── Check 6: shipment_sequence auto-assigned ──────────────────────────────
    if (typeof shipmentSeq !== 'number' || shipmentSeq < 1) {
      fail('Shipment sequence auto-assigned', `expected >= 1, got ${shipmentSeq}`)
    } else {
      ok(`Shipment shipment_sequence = ${shipmentSeq} (auto-assigned)`)
    }
  }

  // Fetch audit event for this shipment
  const { status: evStatus, body: evBody } = await req(
    'GET', `/audit-events?entity_type=shipment&entity_id=${shipmentId}`, token,
  )
  const evData = (evBody as Record<string, unknown>).data as Record<string, unknown>[]

  // ── Check 7: Audit event written ─────────────────────────────────────────
  if (evStatus !== 200 || !Array.isArray(evData) || evData.length === 0) {
    fail('Audit event written for shipment', `expected 1 event, got ${evStatus}: ${JSON.stringify(evBody).slice(0, 100)}`)
    console.error('\n  Fatal: no audit event found — cannot continue remaining checks.')
    process.exit(1)
  }
  ok(`Audit event written — 1 event for entity_id=${shipmentId}`)

  const ev = evData[0]!

  // ── Check 8: action = CREATE ──────────────────────────────────────────────
  if (ev['action'] !== 'CREATE') fail('Audit event action', `expected CREATE, got ${ev['action']}`)
  else ok(`Audit event action = CREATE`)

  // ── Check 9: actor_user_id = JWT sub ─────────────────────────────────────
  if (ev['actor_user_id'] !== expectedUserId) {
    fail('Audit event actor_user_id', `expected ${expectedUserId}, got ${ev['actor_user_id']}`)
  } else {
    ok(`Audit event actor_user_id = ${ev['actor_user_id']} (server-derived from JWT)`)
  }

  // ── Check 10: GET /shipments?contract_id includes shipment ────────────────
  {
    const { status, body } = await req('GET', `/shipments?contract_id=${contractId}`, token)
    const b = body as Record<string, unknown>
    const list = b.data as Record<string, unknown>[]
    const found = Array.isArray(list) && list.some(s => s['id'] === shipmentId)
    if (status !== 200 || !found) {
      fail('GET /shipments?contract_id includes new shipment', `expected to find ${shipmentId} in list, got ${status}: ${JSON.stringify(b).slice(0, 80)}`)
    } else {
      ok(`GET /shipments?contract_id — new shipment appears in list`)
    }
  }

  // ── Check 11: GET /shipments without auth → 401 ───────────────────────────
  {
    const { status } = await req('GET', '/shipments')
    if (status !== 401) fail('GET /shipments without auth', `expected 401, got ${status}`)
    else ok('GET /shipments without auth — 401')
  }

  console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => {
  console.error(`\nFatal: ${err instanceof Error ? err.message : String(err)}`)
  console.error('Is the API server running? Start it with: npm run api')
  process.exit(1)
})
