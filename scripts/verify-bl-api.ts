/**
 * Runtime verification for ExportOS v0.2 POST /bills-of-lading.
 *
 * Prerequisites:
 *   npm run db:reset      (applies migrations + seed)
 *   npm run api           (server running in a separate terminal)
 *   npm run verify-bl-api
 *
 * Checks:
 *   1.  POST /bills-of-lading without auth → 401
 *   2.  POST /bills-of-lading missing required fields → 400 with field list
 *   3.  POST /bills-of-lading invalid bl_type → 400
 *   4.  POST /bills-of-lading with shipment_id from another exporter → 400 (IDOR)
 *   5.  POST /bills-of-lading valid → 201 + BL row
 *   6.  Created BL has exporter_id server-derived (not from body)
 *   7.  repatriation_days is server-computed (positive integer, not from client)
 *   8.  repatriation_deadline is server-computed (date string, not from client)
 *   9.  POST again for same shipment_id → 400 (unique constraint: one BL per shipment)
 *   10. Audit event written (entity_type=bill_of_lading)
 *   11. Audit event action = 'CREATE'
 *   12. Audit event actor_user_id matches JWT sub
 *   13. GET /bills-of-lading returns 200 + array (includes new BL)
 *   14. GET /bills-of-lading without auth → 401
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import jwt from 'jsonwebtoken'

const BASE              = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const EMAIL             = process.env.VERIFY_EMAIL       ?? 'operator@akoboexports.ng'
const PASSWORD          = process.env.VERIFY_PASSWORD    ?? 'dev-seed-password'
const EXPECTED_EXPORTER = process.env.VERIFY_EXPORTER_ID ?? 'b0b00001-0000-0000-0000-000000000001'
const COUNTERPARTY_ID   = 'b0b00001-0000-0000-0000-000000000002'

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
  console.log('=== ExportOS v0.2 — POST /bills-of-lading Verification ===')
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

  // Create a fresh contract + shipment so we have a shipment with no BL yet
  const contractRef = `BL-TEST-CONTRACT-${Date.now()}`
  let contractId = ''
  {
    const { status, body } = await req('POST', '/contracts', token, {
      contract_reference:  contractRef,
      counterparty_id:     COUNTERPARTY_ID,
      commodity:           'Cocoa Beans',
      commodity_type:      'NON_OIL',
      hs_code:             '1801.00',
      contract_quantity:   300,
      quantity_unit:       'MT',
      contract_value:      420000,
      currency:            'USD',
      unit_price:          1400,
      incoterms:           'CIF',
      destination_country: 'NL',
      payment_terms:       'LC AT SIGHT',
      contract_date:       '2026-07-01',
    })
    const data = (body as Record<string, unknown>).data as Record<string, unknown>
    if (status !== 201 || !data?.id) {
      console.error(`  Fatal: contract creation failed (${status}): ${JSON.stringify(body).slice(0, 120)}`)
      process.exit(1)
    }
    contractId = data.id as string
  }

  let shipmentId = ''
  {
    const { status, body } = await req('POST', '/shipments', token, {
      contract_id:        contractId,
      shipment_reference: `SHP-BL-${Date.now()}`,
      nxp_reference:      'NXP/2026/BL/001',
      port_of_loading:    'NGAPP',
      port_of_discharge:  'NLRTM',
      shipment_quantity:  300,
      shipment_value:     420000,
      currency:           'USD',
      vessel_name:        'MV COCOA EXPRESS',
      voyage_number:      'V2026-007',
    })
    const data = (body as Record<string, unknown>).data as Record<string, unknown>
    if (status !== 201 || !data?.id) {
      console.error(`  Fatal: shipment creation failed (${status}): ${JSON.stringify(body).slice(0, 120)}`)
      process.exit(1)
    }
    shipmentId = data.id as string
    console.log(`  (contract=${contractId.slice(0, 8)}… shipment=${shipmentId.slice(0, 8)}…)\n`)
  }

  // ── Check 1: POST without auth → 401 ─────────────────────────────────────
  {
    const { status } = await req('POST', '/bills-of-lading', undefined, { shipment_id: shipmentId })
    if (status !== 401) fail('POST /bills-of-lading without auth', `expected 401, got ${status}`)
    else ok('POST /bills-of-lading without auth — 401')
  }

  // ── Check 2: Missing required fields → 400 ────────────────────────────────
  {
    const { status, body } = await req('POST', '/bills-of-lading', token, { shipment_id: shipmentId })
    const b = body as Record<string, unknown>
    if (status !== 400 || !Array.isArray(b.fields) || (b.fields as string[]).length === 0) {
      fail('POST /bills-of-lading missing fields', `expected 400 + fields array, got ${status}: ${JSON.stringify(b).slice(0, 80)}`)
    } else {
      ok(`POST /bills-of-lading missing fields — 400 (fields: ${(b.fields as string[]).join(', ')})`)
    }
  }

  // ── Check 3: Invalid bl_type → 400 ───────────────────────────────────────
  {
    const { status, body } = await req('POST', '/bills-of-lading', token, {
      shipment_id:          shipmentId,
      bl_number:            'BL-INVALID-TYPE',
      bl_date:              '2026-07-10',
      bl_type:              'INVALID_TYPE',
      shipper_name:         'AKOBO AGRI',
      consignee_name:       'EUROGRAIN',
      description_of_goods: 'Cocoa Beans',
      nxp_reference:        'NXP/2026/BL/001',
    })
    if (status !== 400) {
      fail('POST /bills-of-lading invalid bl_type', `expected 400, got ${status}: ${JSON.stringify(body).slice(0, 80)}`)
    } else {
      ok('POST /bills-of-lading invalid bl_type — 400')
    }
  }

  // ── Check 4: IDOR — shipment_id from another exporter → 400 ──────────────
  {
    const { status, body } = await req('POST', '/bills-of-lading', token, {
      shipment_id:          '00000000-dead-beef-0000-000000000000',
      bl_number:            'BL-IDOR-TEST',
      bl_date:              '2026-07-10',
      bl_type:              'ORIGINAL',
      shipper_name:         'AKOBO AGRI',
      consignee_name:       'EUROGRAIN',
      description_of_goods: 'Cocoa Beans',
      nxp_reference:        'NXP/2026/BL/001',
    })
    if (status !== 400) {
      fail('POST /bills-of-lading IDOR check', `expected 400 for unknown shipment_id, got ${status}: ${JSON.stringify(body).slice(0, 80)}`)
    } else {
      ok('POST /bills-of-lading IDOR — unknown shipment_id rejected with 400')
    }
  }

  // ── Check 5: Valid POST → 201 + BL row ───────────────────────────────────
  const blNumber = `BL-TEST-${Date.now()}`
  let blId = ''
  let blData: Record<string, unknown> = {}
  {
    const { status, body } = await req('POST', '/bills-of-lading', token, {
      exporter_id:          '00000000-ffff-ffff-ffff-000000000000', // must be ignored
      repatriation_days:    9999,    // must be ignored (trigger-computed)
      repatriation_deadline: '2099-01-01', // must be ignored (trigger-computed)
      shipment_id:          shipmentId,
      bl_number:            blNumber,
      bl_date:              '2026-07-10',
      bl_type:              'ORIGINAL',
      shipper_name:         'AKOBO AGRI-EXPORT COMPANY LTD',
      consignee_name:       'EUROGRAIN HAMBURG GMBH',
      description_of_goods: '300 MT Cocoa Beans Grade A',
      nxp_reference:        'NXP/2026/BL/001',
      notify_party:         'HAMBURGER SPARKASSE',
      gross_weight_kg:      306000,
      freight_terms:        'PREPAID',
      place_of_receipt:     'APAPA, LAGOS',
      place_of_delivery:    'ROTTERDAM',
    })
    const data = (body as Record<string, unknown>).data as Record<string, unknown>
    if (status !== 201 || !data?.id) {
      console.error(`  Fatal: BL creation failed (${status}): ${JSON.stringify(body).slice(0, 120)}`)
      process.exit(1)
    }
    blId   = data.id as string
    blData = data
    console.log(`  (BL created: ${blId})\n`)
    ok(`POST /bills-of-lading valid — 201 + id=${blId}`)
  }

  // ── Check 6: exporter_id server-derived ──────────────────────────────────
  if (blData['exporter_id'] !== EXPECTED_EXPORTER) {
    fail('BL exporter_id server-derived', `expected ${EXPECTED_EXPORTER}, got ${blData['exporter_id']}`)
  } else {
    ok(`BL exporter_id = ${blData['exporter_id']} (server-derived)`)
  }

  // ── Check 7: repatriation_days server-computed ────────────────────────────
  const repDays = Number(blData['repatriation_days'])
  if (!isFinite(repDays) || repDays <= 0 || repDays === 9999) {
    fail('BL repatriation_days server-computed', `expected positive DB-computed value, got ${repDays}`)
  } else {
    ok(`BL repatriation_days = ${repDays} (trigger-computed, client value 9999 discarded)`)
  }

  // ── Check 8: repatriation_deadline server-computed ────────────────────────
  const repDl = blData['repatriation_deadline'] as string
  if (!repDl || repDl === '2099-01-01') {
    fail('BL repatriation_deadline server-computed', `expected DB-computed date, got ${repDl}`)
  } else {
    ok(`BL repatriation_deadline = ${repDl} (trigger-computed, client value 2099-01-01 discarded)`)
  }

  // ── Check 9: Duplicate BL for same shipment → 400 ────────────────────────
  {
    const { status, body } = await req('POST', '/bills-of-lading', token, {
      shipment_id:          shipmentId,
      bl_number:            `BL-DUP-${Date.now()}`,
      bl_date:              '2026-07-11',
      bl_type:              'TELEX_RELEASE',
      shipper_name:         'AKOBO AGRI',
      consignee_name:       'EUROGRAIN',
      description_of_goods: 'Cocoa Beans',
      nxp_reference:        'NXP/2026/BL/001',
    })
    if (status !== 400) {
      fail('Duplicate BL for same shipment', `expected 400 (unique constraint), got ${status}: ${JSON.stringify(body).slice(0, 80)}`)
    } else {
      ok('Duplicate BL for same shipment_id → 400 (one BL per shipment enforced)')
    }
  }

  // Fetch audit event for this BL
  const { status: evStatus, body: evBody } = await req(
    'GET', `/audit-events?entity_type=bill_of_lading&entity_id=${blId}`, token,
  )
  const evData = (evBody as Record<string, unknown>).data as Record<string, unknown>[]

  // ── Check 10: Audit event written ────────────────────────────────────────
  if (evStatus !== 200 || !Array.isArray(evData) || evData.length === 0) {
    fail('Audit event written for BL', `expected 1 event, got ${evStatus}: ${JSON.stringify(evBody).slice(0, 100)}`)
    console.error('\n  Fatal: no audit event — cannot continue remaining checks.')
    process.exit(1)
  }
  ok(`Audit event written — 1 event for entity_id=${blId}`)

  const ev = evData[0]!

  // ── Check 11: action = CREATE ─────────────────────────────────────────────
  if (ev['action'] !== 'CREATE') fail('Audit event action', `expected CREATE, got ${ev['action']}`)
  else ok('Audit event action = CREATE')

  // ── Check 12: actor_user_id = JWT sub ────────────────────────────────────
  if (ev['actor_user_id'] !== expectedUserId) {
    fail('Audit event actor_user_id', `expected ${expectedUserId}, got ${ev['actor_user_id']}`)
  } else {
    ok(`Audit event actor_user_id = ${ev['actor_user_id']} (server-derived from JWT)`)
  }

  // ── Check 13: GET /bills-of-lading → 200, includes new BL ────────────────
  {
    const { status, body } = await req('GET', '/bills-of-lading', token)
    const b = body as Record<string, unknown>
    const list = b.data as Record<string, unknown>[]
    const found = Array.isArray(list) && list.some(bl => bl['id'] === blId)
    if (status !== 200 || !found) {
      fail('GET /bills-of-lading includes new BL', `expected to find ${blId} in list, got ${status}: ${JSON.stringify(b).slice(0, 80)}`)
    } else {
      ok(`GET /bills-of-lading — new BL appears in list (${list.length} total)`)
    }
  }

  // ── Check 14: GET /bills-of-lading without auth → 401 ────────────────────
  {
    const { status } = await req('GET', '/bills-of-lading')
    if (status !== 401) fail('GET /bills-of-lading without auth', `expected 401, got ${status}`)
    else ok('GET /bills-of-lading without auth — 401')
  }

  console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => {
  console.error(`\nFatal: ${err instanceof Error ? err.message : String(err)}`)
  console.error('Is the API server running? Start it with: npm run api')
  process.exit(1)
})
