/**
 * Runtime verification for ExportOS v0.2 evidence pack lifecycle API.
 *
 * Prerequisites:
 *   npm run db:reset        (applies migrations + seed)
 *   npm run api             (server running in a separate terminal)
 *   npm run verify-evidence-packs-api
 *
 * Checks:
 *   1.  POST without auth → 401
 *   2.  POST missing shipment_id → 400
 *   3.  POST unknown shipment_id → 400
 *   4.  POST shipment with no BL → 400
 *   5.  Valid POST → 201, version=1, all snapshot/ID fields present
 *   6.  Superseded payment evidence excluded from payment_evidence_ids
 *   7.  Second POST same shipment → 201, version=2
 *   8.  CREATE audit event written with correct actor_user_id
 *   9.  PATCH /seal without auth → 401
 *   10. PATCH /seal unknown pack → 404
 *   11. PATCH /seal compliance-incomplete pack → 400 (trigger message)
 *   12. PATCH /seal ready pack → 200, sealed=true
 *   13. compliance_records.bank_evidence_pack_generated = TRUE after seal
 *   14. PATCH /seal already-sealed pack → 409
 *   15. SEAL audit event written
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import jwt from 'jsonwebtoken'

const BASE     = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const EMAIL    = process.env.VERIFY_EMAIL    ?? 'operator@akoboexports.ng'
const PASSWORD = process.env.VERIFY_PASSWORD ?? 'dev-seed-password'

const CONTRACT    = 'b0b00001-0000-0000-0000-000000000004'
const SHIPMENT_2  = 'b0b00001-0000-0000-0000-000000000006'  // incomplete compliance, unsealed pack in seed

let passed = 0
let failed = 0

function ok(label: string)                   { console.log(`  ✓ ${label}`); passed++ }
function fail(label: string, detail: string) { console.error(`  ✗ ${label}: ${detail}`); failed++ }

async function req(
  method: 'GET' | 'POST' | 'PATCH',
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
  console.log('=== ExportOS v0.2 — Evidence Pack Lifecycle API Verification ===')
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

  // ── Setup: Create a new test shipment (no BL yet) ─────────────────────────
  const ts = Date.now()
  const { status: shipStatus, body: shipBody } = await req('POST', '/shipments', token, {
    contract_id:        CONTRACT,
    shipment_reference: `TEST-EP-${ts}`,
    nxp_reference:      `NXP-TEST-${ts}`,
    port_of_loading:    'APAPA, LAGOS',
    port_of_discharge:  'HAMBURG, GERMANY',
    shipment_quantity:  10,
    shipment_value:     8000,
    currency:           'USD',
  })
  if (shipStatus !== 201) {
    console.error(`  Fatal: could not create test shipment (${shipStatus}): ${JSON.stringify(shipBody)}`)
    process.exit(1)
  }
  const testShipmentId = ((shipBody as Record<string, unknown>).data as Record<string, unknown>)['id'] as string
  console.log(`  (test shipment created: id=${testShipmentId})\n`)

  const UNKNOWN_PACK     = '00000000-dead-dead-dead-000000000000'
  const UNKNOWN_SHIPMENT = '00000000-dead-dead-dead-000000000001'

  // ── Check 1: POST without auth → 401 ─────────────────────────────────────
  {
    const { status } = await req('POST', '/evidence-packs', undefined, { shipment_id: testShipmentId })
    if (status !== 401) fail('POST /evidence-packs without auth', `expected 401, got ${status}`)
    else ok('POST /evidence-packs without auth — 401')
  }

  // ── Check 2: POST missing shipment_id → 400 ───────────────────────────────
  {
    const { status } = await req('POST', '/evidence-packs', token, {})
    if (status !== 400) fail('POST missing shipment_id', `expected 400, got ${status}`)
    else ok('POST missing shipment_id — 400')
  }

  // ── Check 3: POST unknown shipment_id → 400 ───────────────────────────────
  {
    const { status } = await req('POST', '/evidence-packs', token, { shipment_id: UNKNOWN_SHIPMENT })
    if (status !== 400) fail('POST unknown shipment_id', `expected 400, got ${status}`)
    else ok('POST unknown shipment_id — 400')
  }

  // ── Check 4: POST shipment with no BL → 400 ───────────────────────────────
  {
    const { status } = await req('POST', '/evidence-packs', token, { shipment_id: testShipmentId })
    if (status !== 400) fail('POST shipment with no BL', `expected 400, got ${status}`)
    else ok('POST shipment with no BL — 400')
  }

  // ── Setup: Create BL for test shipment (triggers compliance record creation) ──
  const { status: blStatus, body: blBody } = await req('POST', '/bills-of-lading', token, {
    shipment_id:          testShipmentId,
    bl_number:            `BL-TEST-${ts}`,
    bl_date:              '2026-04-01',
    bl_type:              'ORIGINAL',
    shipper_name:         'AKOBO AGRI-EXPORT COMPANY LTD',
    consignee_name:       'EUROGRAIN HAMBURG GMBH',
    description_of_goods: 'Sesame Seeds, 10 MT',
    nxp_reference:        `NXP-TEST-${ts}`,
  })
  if (blStatus !== 201) {
    console.error(`  Fatal: could not create BL (${blStatus}): ${JSON.stringify(blBody)}`)
    process.exit(1)
  }
  console.log(`  (BL created — compliance record auto-created)\n`)

  // ── Setup: Create receipt, allocation, and two evidence records (supersede A with B) ──
  const { status: rcptStatus, body: rcptBody } = await req('POST', '/payment-receipts', token, {
    receipt_reference: `RCPT-TEST-${ts}`,
    instructed_amount: 8000,
    credited_amount:   8000,
    currency:          'USD',
    credit_date:       '2026-05-01',
  })
  if (rcptStatus !== 201) {
    console.error(`  Fatal: could not create receipt (${rcptStatus}): ${JSON.stringify(rcptBody)}`)
    process.exit(1)
  }
  const testReceiptId = ((rcptBody as Record<string, unknown>).data as Record<string, unknown>)['id'] as string

  const { status: allocStatus, body: allocBody } = await req('POST', '/payment-allocations', token, {
    receipt_id:       testReceiptId,
    shipment_id:      testShipmentId,
    allocated_amount: 8000,
    allocation_method: 'MANUAL',
    allocation_date:  '2026-05-01',
  })
  if (allocStatus !== 201) {
    console.error(`  Fatal: could not create allocation (${allocStatus}): ${JSON.stringify(allocBody)}`)
    process.exit(1)
  }
  const testAllocId = ((allocBody as Record<string, unknown>).data as Record<string, unknown>)['id'] as string

  const { status: evAStatus, body: evABody } = await req('POST', '/payment-evidence', token, {
    evidence_type: 'MT103',
    receipt_id:    testReceiptId,
    source_document_ref: `SWIFT-A-${ts}`,
  })
  if (evAStatus !== 201) {
    console.error(`  Fatal: could not create evidence A (${evAStatus}): ${JSON.stringify(evABody)}`)
    process.exit(1)
  }
  const evidenceAId = ((evABody as Record<string, unknown>).data as Record<string, unknown>)['id'] as string

  const { status: evBStatus, body: evBBody } = await req('POST', '/payment-evidence', token, {
    evidence_type: 'MT103',
    receipt_id:    testReceiptId,
    source_document_ref: `SWIFT-B-${ts}`,
  })
  if (evBStatus !== 201) {
    console.error(`  Fatal: could not create evidence B (${evBStatus}): ${JSON.stringify(evBBody)}`)
    process.exit(1)
  }
  const evidenceBId = ((evBBody as Record<string, unknown>).data as Record<string, unknown>)['id'] as string

  // Supersede A with B
  const { status: supStatus } = await req('PATCH', `/payment-evidence/${evidenceAId}/supersede`, token, {
    replacement_id: evidenceBId,
  })
  if (supStatus !== 200) {
    console.error(`  Fatal: could not supersede evidence A (${supStatus})`)
    process.exit(1)
  }
  console.log(`  (receipt+allocation+evidence setup done; evidence ${evidenceAId} superseded by ${evidenceBId})\n`)

  // ── Check 5: Valid POST → 201, version=1, snapshots/IDs present ──────────
  let packV1: Record<string, unknown> = {}
  {
    const { status, body } = await req('POST', '/evidence-packs', token, {
      shipment_id: testShipmentId,
      notes:       'First pack for test shipment.',
    })
    const data = (body as Record<string, unknown>).data as Record<string, unknown>
    if (status !== 201 || !data) {
      fail('Valid POST → 201', `expected 201, got ${status}: ${JSON.stringify(body).slice(0, 120)}`)
      console.error('\n  Fatal: valid POST failed — cannot continue.')
      process.exit(1)
    }
    packV1 = data
    const snapshotsOk =
      data['contract_snapshot']          != null &&
      data['shipment_snapshot']          != null &&
      data['compliance_status_snapshot'] != null
    const arraysOk =
      Array.isArray(data['invoice_ids'])           &&
      Array.isArray(data['payment_evidence_ids'])  &&
      Array.isArray(data['receipt_ids'])           &&
      Array.isArray(data['allocation_ids'])
    if (data['version'] !== 1 || !snapshotsOk || !arraysOk) {
      fail('POST valid fields', `version=${data['version']}, snapshots=${snapshotsOk}, arrays=${arraysOk}`)
    } else {
      ok(`Valid POST → 201, version=${data['version']}, snapshots present, ID arrays present`)
    }
  }

  // ── Check 6: Superseded evidence excluded ────────────────────────────────
  {
    const evIds = packV1['payment_evidence_ids'] as string[]
    const hasB   = evIds.includes(evidenceBId)
    const hasA   = evIds.includes(evidenceAId)
    if (!hasB || hasA) {
      fail('Superseded evidence excluded', `has_B=${hasB}, has_A(superseded)=${hasA}, ids=${JSON.stringify(evIds)}`)
    } else {
      ok(`Superseded evidence excluded — B present, A (superseded) absent`)
    }
    if (!((packV1['receipt_ids'] as string[]).includes(testReceiptId))) {
      fail('receipt_ids includes test receipt', `ids=${JSON.stringify(packV1['receipt_ids'])}`)
    } else {
      ok('receipt_ids includes test receipt')
    }
    if (!((packV1['allocation_ids'] as string[]).includes(testAllocId))) {
      fail('allocation_ids includes test allocation', `ids=${JSON.stringify(packV1['allocation_ids'])}`)
    } else {
      ok('allocation_ids includes test allocation')
    }
  }

  // ── Check 7: Second POST → version=2 ─────────────────────────────────────
  let packV2: Record<string, unknown> = {}
  {
    const { status, body } = await req('POST', '/evidence-packs', token, { shipment_id: testShipmentId })
    const data = (body as Record<string, unknown>).data as Record<string, unknown>
    if (status !== 201 || data?.['version'] !== 2) {
      fail('Second POST → version=2', `expected 201 v2, got ${status}: ${JSON.stringify(body).slice(0, 80)}`)
      console.error('\n  Fatal: second POST failed — cannot continue.')
      process.exit(1)
    }
    packV2 = data
    ok(`Second POST → 201, version=${data['version']}`)
  }

  // ── Check 8: CREATE audit event ───────────────────────────────────────────
  {
    const { status, body } = await req(
      'GET', `/audit-events?entity_type=bank_evidence_pack&entity_id=${packV1['id']}`, token,
    )
    const evData = (body as Record<string, unknown>).data as Record<string, unknown>[]
    if (status !== 200 || !Array.isArray(evData) || evData.length === 0) {
      fail('CREATE audit event', `expected ≥1 event, got ${status}: ${JSON.stringify(body).slice(0, 80)}`)
    } else {
      const ev = evData.find(e => e['action'] === 'CREATE') ?? evData[0]!
      if (ev['action'] !== 'CREATE') {
        fail('Audit event action=CREATE', `got ${ev['action']}`)
      } else {
        ok(`CREATE audit event written — entity_id=${packV1['id']}`)
      }
      if (ev['actor_user_id'] !== expectedUserId) {
        fail('Audit actor_user_id', `expected ${expectedUserId}, got ${ev['actor_user_id']}`)
      } else {
        ok(`CREATE audit actor_user_id = ${ev['actor_user_id']} (JWT-derived)`)
      }
    }
  }

  // ── Check 9: PATCH /seal without auth → 401 ──────────────────────────────
  {
    const { status } = await req('PATCH', `/evidence-packs/${packV2['id']}/seal`, undefined, {})
    if (status !== 401) fail('PATCH /seal without auth', `expected 401, got ${status}`)
    else ok('PATCH /evidence-packs/:id/seal without auth — 401')
  }

  // ── Check 10: PATCH unknown pack → 404 ───────────────────────────────────
  {
    const { status } = await req('PATCH', `/evidence-packs/${UNKNOWN_PACK}/seal`, token, {})
    if (status !== 404) fail('PATCH /seal unknown pack', `expected 404, got ${status}`)
    else ok('PATCH /seal unknown pack — 404')
  }

  // ── Check 11: PATCH seal compliance-incomplete pack → 400 ─────────────────
  // SHIPMENT_2 seed pack: cci_obtained=false, credit_advice_confirmed=false
  {
    const { status: listStatus, body: listBody } = await req(
      'GET', `/evidence-packs?shipment_id=${SHIPMENT_2}&sealed=false`, token,
    )
    const packs = (listBody as Record<string, unknown>).data as Record<string, unknown>[]
    if (listStatus !== 200 || !packs?.length) {
      fail('PATCH /seal compliance-incomplete', `could not fetch SHIPMENT_2 unsealed pack (${listStatus})`)
    } else {
      const shipment2PackId = packs[0]!['id'] as string
      const { status, body } = await req('PATCH', `/evidence-packs/${shipment2PackId}/seal`, token, {})
      if (status !== 400) {
        fail('PATCH /seal compliance-incomplete → 400', `expected 400, got ${status}: ${JSON.stringify(body).slice(0, 120)}`)
      } else {
        const msg = String((body as Record<string, unknown>).error ?? '')
        const mentionsChecklist = msg.includes('cci_obtained') || msg.includes('credit_advice_confirmed') || msg.toLowerCase().includes('compliance')
        if (!mentionsChecklist) {
          fail('Trigger message mentions missing fields', `got: ${msg.slice(0, 120)}`)
        } else {
          ok(`PATCH /seal compliance-incomplete → 400 (trigger: "${msg.slice(0, 80)}...")`)
        }
      }
    }
  }

  // ── Setup: Complete compliance for test shipment ──────────────────────────
  const { status: compStatus, body: compBody } = await req('PATCH', `/compliance/${testShipmentId}`, token, {
    nxp_submitted:            true,
    nxp_approved:             true,
    cci_obtained:             true,
    bl_uploaded:              true,
    payment_evidence_uploaded: true,
    credit_advice_confirmed:  true,
  })
  if (compStatus !== 200) {
    console.error(`  Fatal: could not complete compliance for test shipment (${compStatus}): ${JSON.stringify(compBody)}`)
    process.exit(1)
  }
  console.log(`  (compliance completed for test shipment)\n`)

  // ── Check 12: PATCH seal ready pack → 200, sealed=true ───────────────────
  {
    const { status, body } = await req('PATCH', `/evidence-packs/${packV2['id']}/seal`, token, {})
    const data = (body as Record<string, unknown>).data as Record<string, unknown>
    if (status !== 200 || data?.['sealed'] !== true) {
      fail('PATCH /seal ready pack → 200', `expected 200 sealed=true, got ${status}: ${JSON.stringify(body).slice(0, 120)}`)
      console.error('\n  Fatal: seal failed — cannot continue.')
      process.exit(1)
    }
    ok(`PATCH /seal ready pack → 200, sealed=true`)
  }

  // ── Check 13: compliance.bank_evidence_pack_generated = TRUE ─────────────
  {
    const { status, body } = await req('GET', `/compliance/${testShipmentId}`, token)
    const data = (body as Record<string, unknown>).data as Record<string, unknown>
    if (status !== 200 || data?.['bank_evidence_pack_generated'] !== true) {
      fail('bank_evidence_pack_generated=TRUE after seal', `got ${data?.['bank_evidence_pack_generated']}`)
    } else {
      ok('compliance_records.bank_evidence_pack_generated=TRUE after seal')
    }
  }

  // ── Check 14: PATCH already-sealed pack → 409 ────────────────────────────
  {
    const { status, body } = await req('PATCH', `/evidence-packs/${packV2['id']}/seal`, token, {})
    if (status !== 409) fail('PATCH already-sealed pack → 409', `expected 409, got ${status}: ${JSON.stringify(body).slice(0, 80)}`)
    else ok('PATCH already-sealed pack → 409')
  }

  // ── Check 15: SEAL audit event ────────────────────────────────────────────
  {
    const { status, body } = await req(
      'GET', `/audit-events?entity_type=bank_evidence_pack&entity_id=${packV2['id']}`, token,
    )
    const evData = (body as Record<string, unknown>).data as Record<string, unknown>[]
    if (status !== 200 || !Array.isArray(evData) || evData.length === 0) {
      fail('SEAL audit event', `expected ≥1 event, got ${status}`)
    } else {
      const ev = evData.find(e => e['action'] === 'SEAL')
      if (!ev) {
        fail('SEAL audit event action=SEAL', `events: ${JSON.stringify(evData.map(e => e['action']))}`)
      } else {
        ok(`SEAL audit event written — entity_id=${packV2['id']}`)
        if (ev['actor_user_id'] !== expectedUserId) {
          fail('SEAL audit actor_user_id', `expected ${expectedUserId}, got ${ev['actor_user_id']}`)
        } else {
          ok(`SEAL audit actor_user_id = ${ev['actor_user_id']} (JWT-derived)`)
        }
      }
    }
  }

  console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => {
  console.error(`\nFatal: ${err instanceof Error ? err.message : String(err)}`)
  console.error('Is the API server running? Start it with: npm run api')
  process.exit(1)
})
