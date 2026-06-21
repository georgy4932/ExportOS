/**
 * Runtime verification for ExportOS v0.2 POST /payment-evidence.
 *
 * Prerequisites:
 *   npm run db:reset        (applies migrations + seed)
 *   npm run api             (server running in a separate terminal)
 *   npm run verify-evidence-api
 *
 * Schema notes:
 *   - payment_evidence is append-only
 *   - exporter_id and uploaded_by are server-derived from JWT
 *   - superseded_by is NOT accepted on create
 *   - BANK_CREDIT_ADVICE requires credited_amount, credited_currency, credit_date
 *   - All fields except receipt_id and superseded_by are immutable after creation
 *     (trg_payment_evidence_immutable BEFORE UPDATE)
 *   - receipt_id is optional; if provided, must belong to the authenticated exporter
 *
 * Required fields by evidence_type:
 *   - ALL types:            evidence_type
 *   - BANK_CREDIT_ADVICE:  credited_amount, credited_currency, credit_date (in addition)
 *
 * Checks:
 *   1.  POST /payment-evidence without auth → 401
 *   2.  POST missing evidence_type → 400 with field list
 *   3.  POST invalid evidence_type → 400
 *   4.  POST BANK_CREDIT_ADVICE missing credit fields → 400 with field list
 *   5.  POST invalid charges_code → 400
 *   6.  POST with unknown receipt_id → 400
 *   7.  POST valid generic evidence (MT103) without receipt_id → 201
 *   8.  exporter_id server-derived (client value discarded)
 *   9.  uploaded_by server-derived (client value discarded)
 *   10. superseded_by not accepted on create (silently discarded, row has null)
 *   11. POST valid BANK_CREDIT_ADVICE with full credit fields → 201
 *   12. BANK_CREDIT_ADVICE response includes credited_amount, credited_currency, credit_date
 *   13. POST with valid receipt_id linked → 201 with receipt_id in response
 *   14. Audit event written for generic evidence (entity_type=payment_evidence)
 *   15. Audit event action = CREATE
 *   16. Audit event actor_user_id = JWT sub
 *   17. GET /payment-evidence → 200 + array (new evidence present)
 *   18. GET /payment-evidence/:id → 200 + correct record
 *   19. GET /payment-evidence without auth → 401
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import jwt from 'jsonwebtoken'

const BASE              = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const EMAIL             = process.env.VERIFY_EMAIL       ?? 'operator@akoboexports.ng'
const PASSWORD          = process.env.VERIFY_PASSWORD    ?? 'dev-seed-password'
const EXPECTED_EXPORTER = process.env.VERIFY_EXPORTER_ID ?? 'b0b00001-0000-0000-0000-000000000001'

// Seeded receipt for receipt_id linkage test
const SEEDED_RECEIPT_1 = 'b0b00001-0000-0000-0000-000000000011'

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
  console.log('=== ExportOS v0.2 — POST /payment-evidence Verification ===')
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
    const { status } = await req('POST', '/payment-evidence', undefined, { evidence_type: 'MT103' })
    if (status !== 401) fail('POST /payment-evidence without auth', `expected 401, got ${status}`)
    else ok('POST /payment-evidence without auth — 401')
  }

  // ── Check 2: POST missing evidence_type → 400 ────────────────────────────
  {
    const { status, body } = await req('POST', '/payment-evidence', token, {})
    const b = body as Record<string, unknown>
    if (status !== 400 || !Array.isArray(b.fields) || !(b.fields as string[]).includes('evidence_type')) {
      fail('POST missing evidence_type', `expected 400 + fields=[evidence_type], got ${status}: ${JSON.stringify(b).slice(0, 80)}`)
    } else {
      ok('POST missing evidence_type — 400 + fields=[evidence_type]')
    }
  }

  // ── Check 3: POST invalid evidence_type → 400 ────────────────────────────
  {
    const { status } = await req('POST', '/payment-evidence', token, { evidence_type: 'SWIFT_GPI' })
    if (status !== 400) fail('POST invalid evidence_type', `expected 400, got ${status}`)
    else ok('POST invalid evidence_type — 400')
  }

  // ── Check 4: BANK_CREDIT_ADVICE missing credit fields → 400 ─────────────
  {
    const { status, body } = await req('POST', '/payment-evidence', token, {
      evidence_type: 'BANK_CREDIT_ADVICE',
      // deliberately omitting credited_amount, credited_currency, credit_date
      source_document_ref: 'BCA-MISSING-FIELDS',
    })
    const b = body as Record<string, unknown>
    if (status !== 400 || !Array.isArray(b.fields) || (b.fields as string[]).length === 0) {
      fail('BANK_CREDIT_ADVICE missing credit fields', `expected 400 + fields array, got ${status}: ${JSON.stringify(b).slice(0, 80)}`)
    } else {
      ok(`BANK_CREDIT_ADVICE missing credit fields — 400 (fields: ${(b.fields as string[]).join(', ')})`)
    }
  }

  // ── Check 5: Invalid charges_code → 400 ──────────────────────────────────
  {
    const { status } = await req('POST', '/payment-evidence', token, {
      evidence_type: 'MT103',
      charges_code:  'INVALID',
    })
    if (status !== 400) fail('POST invalid charges_code', `expected 400, got ${status}`)
    else ok('POST invalid charges_code — 400')
  }

  // ── Check 6: Unknown receipt_id → 400 ────────────────────────────────────
  {
    const { status } = await req('POST', '/payment-evidence', token, {
      evidence_type: 'MT103',
      receipt_id:    '00000000-dead-dead-dead-000000000000',
    })
    if (status !== 400) fail('POST unknown receipt_id', `expected 400, got ${status}`)
    else ok('POST unknown receipt_id — 400')
  }

  // ── Check 7: Valid generic evidence (MT103) without receipt_id → 201 ─────
  let genericId = ''
  let genericData: Record<string, unknown> = {}
  {
    const { status, body } = await req('POST', '/payment-evidence', token, {
      exporter_id:         '00000000-ffff-ffff-ffff-000000000000', // must be discarded
      uploaded_by:         '00000000-ffff-ffff-ffff-000000000000', // must be discarded
      superseded_by:       '00000000-ffff-ffff-ffff-000000000000', // must be discarded on create
      evidence_type:       'MT103',
      source_document_ref: `MT103-TEST-${Date.now()}`,
      instructed_amount:   50000,
      instructed_currency: 'usd',   // should be normalised to USD
      value_date:          '2026-07-20',
      charges_code:        'SHA',
      ordering_customer:   'EUROGRAIN HAMBURG GMBH',
      beneficiary_customer: 'AKOBO AGRI-EXPORT COMPANY LTD',
      remittance_info:     'CTR-2026-SES-001 / SHP-2026-03',
    })
    const data = (body as Record<string, unknown>).data as Record<string, unknown>
    if (status !== 201 || !data?.id) {
      console.error(`  Fatal: generic evidence creation failed (${status}): ${JSON.stringify(body).slice(0, 120)}`)
      process.exit(1)
    }
    genericId   = data.id as string
    genericData = data
    console.log(`  (generic evidence created: ${genericId})\n`)
    ok(`POST /payment-evidence (MT103) — 201 + id=${genericId}`)
  }

  // ── Check 8: exporter_id server-derived ──────────────────────────────────
  if (genericData['exporter_id'] !== EXPECTED_EXPORTER) {
    fail('exporter_id server-derived', `expected ${EXPECTED_EXPORTER}, got ${genericData['exporter_id']}`)
  } else {
    ok(`exporter_id = ${genericData['exporter_id']} (server-derived, client value discarded)`)
  }

  // ── Check 9: uploaded_by server-derived ──────────────────────────────────
  if (genericData['uploaded_by'] !== expectedUserId) {
    fail('uploaded_by server-derived', `expected ${expectedUserId}, got ${genericData['uploaded_by']}`)
  } else {
    ok(`uploaded_by = ${genericData['uploaded_by']} (server-derived from JWT, client value discarded)`)
  }

  // ── Check 10: superseded_by discarded on create ───────────────────────────
  if (genericData['superseded_by'] !== null) {
    fail('superseded_by discarded on create', `expected null, got ${genericData['superseded_by']}`)
  } else {
    ok('superseded_by = null (client value discarded on create)')
  }

  // ── Check 11: Valid BANK_CREDIT_ADVICE → 201 ─────────────────────────────
  let bcaId = ''
  let bcaData: Record<string, unknown> = {}
  {
    const { status, body } = await req('POST', '/payment-evidence', token, {
      evidence_type:       'BANK_CREDIT_ADVICE',
      source_document_ref: `BCA-GTB-TEST-${Date.now()}`,
      instructed_amount:   50000,
      instructed_currency: 'USD',
      value_date:          '2026-07-20',
      charges_code:        'SHA',
      ordering_customer:   'EUROGRAIN HAMBURG GMBH',
      beneficiary_customer: 'AKOBO AGRI-EXPORT COMPANY LTD',
      remittance_info:     'CTR-2026-SES-001 / SHP-2026-03',
      credited_amount:     49800,
      credited_currency:   'usd',  // should be normalised to USD
      credit_date:         '2026-07-20',
      bank_ref:            'GTB2607200099',
      payer_account:       'DE89370400440532013000',
      payer_name:          'EUROGRAIN HAMBURG GMBH',
    })
    const data = (body as Record<string, unknown>).data as Record<string, unknown>
    if (status !== 201 || !data?.id) {
      console.error(`  Fatal: BANK_CREDIT_ADVICE creation failed (${status}): ${JSON.stringify(body).slice(0, 120)}`)
      process.exit(1)
    }
    bcaId   = data.id as string
    bcaData = data
    console.log(`  (BANK_CREDIT_ADVICE evidence created: ${bcaId})\n`)
    ok(`POST /payment-evidence (BANK_CREDIT_ADVICE) — 201 + id=${bcaId}`)
  }

  // ── Check 12: BANK_CREDIT_ADVICE fields present in response ──────────────
  const creditedOk =
    Number(bcaData['credited_amount'])   === 49800  &&
    bcaData['credited_currency']         === 'USD'  &&
    bcaData['credit_date']               != null
  if (!creditedOk) {
    fail(
      'BANK_CREDIT_ADVICE credit fields in response',
      `credited_amount=${bcaData['credited_amount']}, credited_currency=${bcaData['credited_currency']}, credit_date=${bcaData['credit_date']}`,
    )
  } else {
    ok(`BANK_CREDIT_ADVICE: credited_amount=${bcaData['credited_amount']}, credited_currency=${bcaData['credited_currency']}, credit_date=${bcaData['credit_date']}`)
  }

  // ── Check 13: POST with valid receipt_id → 201 with receipt_id in response
  let linkedId = ''
  {
    const { status, body } = await req('POST', '/payment-evidence', token, {
      evidence_type:       'MANUAL',
      source_document_ref: `MANUAL-LINKED-${Date.now()}`,
      receipt_id:          SEEDED_RECEIPT_1,
    })
    const data = (body as Record<string, unknown>).data as Record<string, unknown>
    if (status !== 201 || !data?.id) {
      fail('POST with valid receipt_id', `expected 201, got ${status}: ${JSON.stringify(body).slice(0, 80)}`)
    } else {
      linkedId = data.id as string
      if (data['receipt_id'] !== SEEDED_RECEIPT_1) {
        fail('receipt_id linkage', `expected ${SEEDED_RECEIPT_1}, got ${data['receipt_id']}`)
      } else {
        ok(`POST with receipt_id linkage — 201, receipt_id=${data['receipt_id']}`)
      }
    }
  }

  // Fetch audit event for generic evidence
  const { status: evStatus, body: evBody } = await req(
    'GET', `/audit-events?entity_type=payment_evidence&entity_id=${genericId}`, token,
  )
  const evData = (evBody as Record<string, unknown>).data as Record<string, unknown>[]

  // ── Check 14: Audit event written ────────────────────────────────────────
  if (evStatus !== 200 || !Array.isArray(evData) || evData.length === 0) {
    fail('Audit event written', `expected 1 event, got ${evStatus}: ${JSON.stringify(evBody).slice(0, 100)}`)
    console.error('\n  Fatal: no audit event — cannot continue.')
    process.exit(1)
  }
  ok(`Audit event written — entity_type=payment_evidence, entity_id=${genericId}`)

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

  // ── Check 17: GET /payment-evidence → 200 + new evidence present ──────────
  {
    const { status, body } = await req('GET', '/payment-evidence', token)
    const b = body as Record<string, unknown>
    const list = b.data as Record<string, unknown>[]
    const found = Array.isArray(list) && list.some(e => e['id'] === genericId)
    if (status !== 200 || !found) {
      fail('GET /payment-evidence includes new evidence', `status ${status}, found=${found}`)
    } else {
      ok(`GET /payment-evidence — new evidence in list (${list.length} total)`)
    }
  }

  // ── Check 18: GET /payment-evidence/:id → 200 + correct record ───────────
  {
    const { status, body } = await req('GET', `/payment-evidence/${bcaId}`, token)
    const data = (body as Record<string, unknown>).data as Record<string, unknown>
    if (status !== 200 || data?.['id'] !== bcaId) {
      fail('GET /payment-evidence/:id', `status ${status}, id=${data?.['id']}`)
    } else {
      ok(`GET /payment-evidence/${bcaId} — 200, evidence_type=${data?.['evidence_type']}`)
    }
  }

  // ── Check 19: GET without auth → 401 ─────────────────────────────────────
  {
    const { status } = await req('GET', '/payment-evidence')
    if (status !== 401) fail('GET /payment-evidence without auth', `expected 401, got ${status}`)
    else ok('GET /payment-evidence without auth — 401')
  }

  console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => {
  console.error(`\nFatal: ${err instanceof Error ? err.message : String(err)}`)
  console.error('Is the API server running? Start it with: npm run api')
  process.exit(1)
})
