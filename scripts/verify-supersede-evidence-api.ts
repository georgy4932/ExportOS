/**
 * Runtime verification for ExportOS v0.2 PATCH /payment-evidence/:id/supersede.
 *
 * Prerequisites:
 *   npm run db:reset        (applies migrations + seed)
 *   npm run api             (server running in a separate terminal)
 *   npm run verify-supersede-evidence-api
 *
 * Schema notes:
 *   - superseded_by is the only mutable field besides receipt_id
 *     (trg_payment_evidence_immutable BEFORE UPDATE allows both)
 *   - Once superseded_by is set it must not change (trigger also enforces this)
 *   - Both old and replacement rows must belong to the authenticated exporter
 *   - audit_events.action is TEXT NOT NULL — 'SUPERSEDE' is a valid free-text value
 *
 * Checks:
 *   1.  PATCH without auth → 401
 *   2.  PATCH missing replacement_id → 400
 *   3.  PATCH with self-reference (replacement_id = id) → 400
 *   4.  PATCH with unknown evidence id → 404
 *   5.  PATCH with unknown replacement_id → 400
 *   6.  Valid PATCH → 200, superseded_by = replacement_id
 *   7.  Response superseded_by matches replacement_id
 *   8.  Response exporter_id = authenticated exporter (IDOR integrity)
 *   9.  PATCH already-superseded evidence → 409
 *   10. Audit event written (entity_type = payment_evidence, entity_id = old id)
 *   11. Audit event action = SUPERSEDE
 *   12. Audit event actor_user_id = JWT sub
 *   13. GET /payment-evidence/:id returns updated row with superseded_by set
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

async function createEvidence(token: string, ref: string): Promise<string> {
  const { status, body } = await req('POST', '/payment-evidence', token, {
    evidence_type:       'MT103',
    source_document_ref: ref,
  })
  const data = (body as Record<string, unknown>).data as Record<string, unknown>
  if (status !== 201 || !data?.id) {
    console.error(`  Fatal: evidence creation failed (${status}): ${JSON.stringify(body).slice(0, 120)}`)
    process.exit(1)
  }
  return data.id as string
}

async function main() {
  console.log('=== ExportOS v0.2 — PATCH /payment-evidence/:id/supersede Verification ===')
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

  // Create two evidence rows to use throughout the checks
  const oldId  = await createEvidence(token, `SUPERSEDE-OLD-${Date.now()}`)
  const replId = await createEvidence(token, `SUPERSEDE-REPL-${Date.now()}`)
  console.log(`  (created evidence rows: old=${oldId}, replacement=${replId})\n`)

  const UNKNOWN_ID = '00000000-dead-dead-dead-000000000000'

  // ── Check 1: PATCH without auth → 401 ────────────────────────────────────
  {
    const { status } = await req('PATCH', `/payment-evidence/${oldId}/supersede`, undefined, { replacement_id: replId })
    if (status !== 401) fail('PATCH without auth', `expected 401, got ${status}`)
    else ok('PATCH /payment-evidence/:id/supersede without auth — 401')
  }

  // ── Check 2: PATCH missing replacement_id → 400 ──────────────────────────
  {
    const { status, body } = await req('PATCH', `/payment-evidence/${oldId}/supersede`, token, {})
    if (status !== 400) fail('PATCH missing replacement_id', `expected 400, got ${status}: ${JSON.stringify(body).slice(0, 80)}`)
    else ok('PATCH missing replacement_id — 400')
  }

  // ── Check 3: PATCH self-reference (replacement_id = id) → 400 ────────────
  {
    const { status } = await req('PATCH', `/payment-evidence/${oldId}/supersede`, token, { replacement_id: oldId })
    if (status !== 400) fail('PATCH self-reference', `expected 400, got ${status}`)
    else ok('PATCH replacement_id = id (self-reference) — 400')
  }

  // ── Check 4: PATCH unknown evidence id → 404 ─────────────────────────────
  {
    const { status } = await req('PATCH', `/payment-evidence/${UNKNOWN_ID}/supersede`, token, { replacement_id: replId })
    if (status !== 404) fail('PATCH unknown evidence id', `expected 404, got ${status}`)
    else ok('PATCH unknown evidence id — 404')
  }

  // ── Check 5: PATCH unknown replacement_id → 400 ──────────────────────────
  {
    const { status } = await req('PATCH', `/payment-evidence/${oldId}/supersede`, token, { replacement_id: UNKNOWN_ID })
    if (status !== 400) fail('PATCH unknown replacement_id', `expected 400, got ${status}`)
    else ok('PATCH unknown replacement_id — 400')
  }

  // ── Check 6: Valid PATCH → 200 ───────────────────────────────────────────
  let supersededData: Record<string, unknown> = {}
  {
    const { status, body } = await req('PATCH', `/payment-evidence/${oldId}/supersede`, token, { replacement_id: replId })
    const data = (body as Record<string, unknown>).data as Record<string, unknown>
    if (status !== 200 || !data?.id) {
      console.error(`  Fatal: supersede failed (${status}): ${JSON.stringify(body).slice(0, 120)}`)
      process.exit(1)
    }
    supersededData = data
    ok(`PATCH /payment-evidence/${oldId}/supersede — 200`)
  }

  // ── Check 7: Response superseded_by = replacement_id ────────────────────
  if (supersededData['superseded_by'] !== replId) {
    fail('Response superseded_by', `expected ${replId}, got ${supersededData['superseded_by']}`)
  } else {
    ok(`superseded_by = ${replId} (correct replacement)`)
  }

  // ── Check 8: Response exporter_id = authenticated exporter ───────────────
  if (supersededData['exporter_id'] !== EXPECTED_EXPORTER) {
    fail('Response exporter_id', `expected ${EXPECTED_EXPORTER}, got ${supersededData['exporter_id']}`)
  } else {
    ok(`exporter_id = ${supersededData['exporter_id']} (IDOR integrity confirmed)`)
  }

  // ── Check 9: PATCH already-superseded evidence → 409 ─────────────────────
  {
    const { status, body } = await req('PATCH', `/payment-evidence/${oldId}/supersede`, token, { replacement_id: replId })
    if (status !== 409) {
      fail('PATCH already-superseded', `expected 409, got ${status}: ${JSON.stringify(body).slice(0, 80)}`)
    } else {
      ok('PATCH already-superseded evidence — 409')
    }
  }

  // ── Check 10–12: Audit event ──────────────────────────────────────────────
  const { status: evStatus, body: evBody } = await req(
    'GET', `/audit-events?entity_type=payment_evidence&entity_id=${oldId}`, token,
  )
  const evData = (evBody as Record<string, unknown>).data as Record<string, unknown>[]

  if (evStatus !== 200 || !Array.isArray(evData) || evData.length === 0) {
    fail('Audit event written', `expected events, got ${evStatus}: ${JSON.stringify(evBody).slice(0, 100)}`)
    console.error('\n  Fatal: no audit event — cannot continue.')
    process.exit(1)
  }

  // Most recent event for this entity is the SUPERSEDE (audit-events are ordered DESC)
  const supersedeEv = evData.find(e => e['action'] === 'SUPERSEDE')

  // ── Check 10: Audit event written ────────────────────────────────────────
  if (!supersedeEv) {
    fail('Audit event written (action=SUPERSEDE)', `not found in ${evData.length} events`)
  } else {
    ok(`Audit event written — entity_type=payment_evidence, entity_id=${oldId}`)
  }

  if (supersedeEv) {
    // ── Check 11: action = SUPERSEDE ─────────────────────────────────────────
    if (supersedeEv['action'] !== 'SUPERSEDE') {
      fail('Audit event action', `expected SUPERSEDE, got ${supersedeEv['action']}`)
    } else {
      ok('Audit event action = SUPERSEDE')
    }

    // ── Check 12: actor_user_id = JWT sub ────────────────────────────────────
    if (supersedeEv['actor_user_id'] !== expectedUserId) {
      fail('Audit event actor_user_id', `expected ${expectedUserId}, got ${supersedeEv['actor_user_id']}`)
    } else {
      ok(`Audit event actor_user_id = ${supersedeEv['actor_user_id']} (server-derived from JWT)`)
    }
  } else {
    failed += 2 // count skipped sub-checks as failures
  }

  // ── Check 13: GET /:id returns updated row with superseded_by set ─────────
  {
    const { status, body } = await req('GET', `/payment-evidence/${oldId}`, token)
    const data = (body as Record<string, unknown>).data as Record<string, unknown>
    if (status !== 200 || data?.['superseded_by'] !== replId) {
      fail(
        'GET /:id shows superseded_by',
        `status=${status}, superseded_by=${data?.['superseded_by']}`,
      )
    } else {
      ok(`GET /payment-evidence/${oldId} — superseded_by=${data['superseded_by']}`)
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
