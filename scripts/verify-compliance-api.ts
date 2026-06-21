/**
 * Runtime verification for ExportOS v0.2 compliance API.
 *
 * Prerequisites:
 *   npm run db:reset        (applies migrations + seed)
 *   npm run api             (server running in a separate terminal)
 *   npm run verify-compliance-api
 *
 * Schema notes:
 *   - compliance_records are auto-created by trg_auto_create_compliance_record
 *     when a bill_of_lading is inserted (seeded data provides one via SHIPMENT_2).
 *   - Patchable operator fields: nxp_submitted, nxp_approved, cci_obtained,
 *     bl_uploaded, payment_evidence_uploaded, credit_advice_confirmed,
 *     compliance_flags, last_reviewed_at, notes.
 *   - System/trigger fields (repatriation_status, proceeds_*, deadlines, etc.)
 *     cannot be set by client.
 *
 * Checks:
 *   1.  PATCH without auth → 401
 *   2.  PATCH unknown shipment → 404
 *   3.  PATCH empty body → 400
 *   4.  PATCH only ignored/system fields → 400
 *   5.  PATCH invalid boolean → 400
 *   6.  PATCH invalid compliance_flags (not array) → 400
 *   7.  PATCH invalid compliance_flags (array with non-string) → 400
 *   8.  PATCH valid fields → 200 + updated values
 *   9.  System fields unchanged after patch
 *   10. updated_at changed via DB trigger
 *   11. Audit event written (entity_type=compliance_record, action=UPDATE)
 *   12. Audit event actor_user_id = JWT sub
 *   13. GET /compliance/:shipmentId reflects updated values
 *   14. GET /compliance without auth → 401
 *   15. PATCH compliance_flags null → clears flags
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import jwt from 'jsonwebtoken'

const BASE              = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const EMAIL             = process.env.VERIFY_EMAIL       ?? 'operator@akoboexports.ng'
const PASSWORD          = process.env.VERIFY_PASSWORD    ?? 'dev-seed-password'
const SHIPMENT_2        = 'b0b00001-0000-0000-0000-000000000006'  // seeded shipment with BL + compliance

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
  console.log('=== ExportOS v0.2 — Compliance API Verification ===')
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

  const UNKNOWN_SHIPMENT = '00000000-dead-dead-dead-000000000000'

  // ── Check 1: PATCH without auth → 401 ────────────────────────────────────
  {
    const { status } = await req('PATCH', `/compliance/${SHIPMENT_2}`, undefined, { nxp_submitted: true })
    if (status !== 401) fail('PATCH /compliance/:shipmentId without auth', `expected 401, got ${status}`)
    else ok('PATCH /compliance/:shipmentId without auth — 401')
  }

  // ── Check 2: PATCH unknown shipment → 404 ────────────────────────────────
  {
    const { status } = await req('PATCH', `/compliance/${UNKNOWN_SHIPMENT}`, token, { nxp_submitted: true })
    if (status !== 404) fail('PATCH unknown shipment', `expected 404, got ${status}`)
    else ok('PATCH unknown/missing compliance record — 404')
  }

  // ── Check 3: PATCH empty body → 400 ──────────────────────────────────────
  {
    const { status, body } = await req('PATCH', `/compliance/${SHIPMENT_2}`, token, {})
    if (status !== 400) fail('PATCH empty body', `expected 400, got ${status}: ${JSON.stringify(body).slice(0, 80)}`)
    else ok('PATCH empty body — 400')
  }

  // ── Check 4: PATCH only system/ignored fields → 400 ──────────────────────
  {
    const { status } = await req('PATCH', `/compliance/${SHIPMENT_2}`, token, {
      repatriation_status:      'PENDING',
      proceeds_required:        100000,
      proceeds_received:        0,
      proceeds_outstanding:     100000,
      repatriation_deadline:    '2026-09-01',
      was_repatriated_late:     false,
      bank_evidence_pack_generated: false,
    })
    if (status !== 400) fail('PATCH only system fields', `expected 400, got ${status}`)
    else ok('PATCH only system/ignored fields — 400')
  }

  // ── Check 5: PATCH invalid boolean → 400 ─────────────────────────────────
  {
    const { status } = await req('PATCH', `/compliance/${SHIPMENT_2}`, token, {
      nxp_submitted: 'yes',
    })
    if (status !== 400) fail('PATCH invalid boolean', `expected 400, got ${status}`)
    else ok('PATCH invalid boolean (string) — 400')
  }

  // ── Check 6: PATCH compliance_flags not array → 400 ──────────────────────
  {
    const { status } = await req('PATCH', `/compliance/${SHIPMENT_2}`, token, {
      compliance_flags: 'LATE_SUBMISSION',
    })
    if (status !== 400) fail('PATCH compliance_flags not array', `expected 400, got ${status}`)
    else ok('PATCH compliance_flags not array — 400')
  }

  // ── Check 7: PATCH compliance_flags array with non-string → 400 ──────────
  {
    const { status } = await req('PATCH', `/compliance/${SHIPMENT_2}`, token, {
      compliance_flags: ['LATE_SUBMISSION', 42],
    })
    if (status !== 400) fail('PATCH compliance_flags with non-string element', `expected 400, got ${status}`)
    else ok('PATCH compliance_flags with non-string element — 400')
  }

  // ── Fetch baseline record ─────────────────────────────────────────────────
  const { status: getStatus, body: getBody } = await req('GET', `/compliance/${SHIPMENT_2}`, token)
  const baseline = (getBody as Record<string, unknown>).data as Record<string, unknown>
  if (getStatus !== 200 || !baseline) {
    console.error(`  Fatal: could not fetch compliance record for SHIPMENT_2 (${getStatus})`)
    process.exit(1)
  }
  console.log(`  (baseline compliance record: id=${baseline['id']})\n`)

  // ── Check 8: PATCH valid fields → 200 + updated values ───────────────────
  let patchedData: Record<string, unknown> = {}
  {
    const { status, body } = await req('PATCH', `/compliance/${SHIPMENT_2}`, token, {
      nxp_submitted:   true,
      compliance_flags: ['NXP_PENDING_REVIEW'],
      notes:           'Submitted NXP to CBN branch.',
    })
    const data = (body as Record<string, unknown>).data as Record<string, unknown>
    if (status !== 200 || !data) {
      fail('PATCH valid fields', `expected 200, got ${status}: ${JSON.stringify(body).slice(0, 120)}`)
      console.error('\n  Fatal: valid PATCH failed — cannot continue.')
      process.exit(1)
    }
    patchedData = data
    ok(`PATCH valid fields — 200, nxp_submitted=${data['nxp_submitted']}, notes present=${!!data['notes']}`)
  }

  // ── Check 9: System fields unchanged ─────────────────────────────────────
  const systemFieldsSame =
    patchedData['repatriation_status']  === baseline['repatriation_status']  &&
    patchedData['proceeds_required']    === baseline['proceeds_required']     &&
    patchedData['proceeds_received']    === baseline['proceeds_received']     &&
    patchedData['repatriation_deadline'] === baseline['repatriation_deadline']
  if (!systemFieldsSame) {
    fail('System fields unchanged', `repatriation_status=${patchedData['repatriation_status']}, proceeds_required=${patchedData['proceeds_required']}`)
  } else {
    ok('System/trigger fields unchanged after PATCH')
  }

  // ── Check 10: updated_at changed ─────────────────────────────────────────
  if (patchedData['updated_at'] === baseline['updated_at']) {
    fail('updated_at changed via trigger', `before=${baseline['updated_at']}, after=${patchedData['updated_at']}`)
  } else {
    ok(`updated_at changed (trigger) — was ${baseline['updated_at']}, now ${patchedData['updated_at']}`)
  }

  // ── Check 11–12: Audit event ──────────────────────────────────────────────
  const { status: evStatus, body: evBody } = await req(
    'GET', `/audit-events?entity_type=compliance_record&entity_id=${patchedData['id']}`, token,
  )
  const evData = (evBody as Record<string, unknown>).data as Record<string, unknown>[]

  if (evStatus !== 200 || !Array.isArray(evData) || evData.length === 0) {
    fail('Audit event written', `expected ≥1 event, got ${evStatus}: ${JSON.stringify(evBody).slice(0, 100)}`)
    console.error('\n  Fatal: no audit event — cannot continue.')
    process.exit(1)
  }
  ok(`Audit event written — entity_type=compliance_record, entity_id=${patchedData['id']}`)

  const ev = evData.find(e => e['action'] === 'UPDATE') ?? evData[0]!
  if (ev['action'] !== 'UPDATE') {
    fail('Audit event action', `expected UPDATE, got ${ev['action']}`)
  } else {
    ok('Audit event action = UPDATE')
  }
  if (ev['actor_user_id'] !== expectedUserId) {
    fail('Audit event actor_user_id', `expected ${expectedUserId}, got ${ev['actor_user_id']}`)
  } else {
    ok(`Audit event actor_user_id = ${ev['actor_user_id']} (server-derived from JWT)`)
  }

  // ── Check 13: GET reflects updated values ────────────────────────────────
  {
    const { status, body } = await req('GET', `/compliance/${SHIPMENT_2}`, token)
    const data = (body as Record<string, unknown>).data as Record<string, unknown>
    const flagsMatch = JSON.stringify(data?.['compliance_flags']) === JSON.stringify(['NXP_PENDING_REVIEW'])
    if (status !== 200 || data?.['nxp_submitted'] !== true || !flagsMatch) {
      fail('GET reflects updated values', `nxp_submitted=${data?.['nxp_submitted']}, flags=${JSON.stringify(data?.['compliance_flags'])}`)
    } else {
      ok('GET /compliance/:shipmentId reflects patched values')
    }
  }

  // ── Check 14: GET without auth → 401 ─────────────────────────────────────
  {
    const { status } = await req('GET', '/compliance')
    if (status !== 401) fail('GET /compliance without auth', `expected 401, got ${status}`)
    else ok('GET /compliance without auth — 401')
  }

  // ── Check 15: PATCH compliance_flags null → clears flags ─────────────────
  {
    const { status, body } = await req('PATCH', `/compliance/${SHIPMENT_2}`, token, {
      compliance_flags: null,
    })
    const data = (body as Record<string, unknown>).data as Record<string, unknown>
    if (status !== 200 || data?.['compliance_flags'] !== null) {
      fail('PATCH compliance_flags null clears flags', `status=${status}, flags=${JSON.stringify(data?.['compliance_flags'])}`)
    } else {
      ok('PATCH compliance_flags=null clears flags — 200')
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
