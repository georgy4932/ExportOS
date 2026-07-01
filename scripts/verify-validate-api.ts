/**
 * Runtime verification for PATCH /export-cases/:nxp/evidence/:type/validate
 * — evidence validate transition (RC4 write path, step 3).
 *
 * Prerequisites:
 *   npm run db:reset            (applies migrations + seed)
 *   npm run api                 (server running in a separate terminal)
 *   npm run verify-validate-api
 *
 * Seed state assumed:
 *   - NXP_1 (NXP-2026-SES-001) exists, owned by the seeded exporter (b0b00001-...)
 *   - evidence_items row for nxp_approval starts as 'missing' (from seed)
 *   - After mark_uploaded: nxp_approval is 'uploaded'
 *
 * Transition behaviour (RC4_API_DESIGN.md §3):
 *   uploaded        → validated  (ALLOWED — direct validation, bypasses queue)
 *   pending_review  → validated  (ALLOWED — normal reviewed path)
 *   any other state → 409 INVALID_TRANSITION
 *
 * reason is REQUIRED for validate (unlike submit-review, where it is optional).
 * Missing or empty reason → 400 VALIDATION_REQUIRED.
 *
 * validation_status on success is 'passed' — the DB CHECK constraint on
 * evidence_items.validation_status does not include a 'valid' value; RC4_API_DESIGN.md's
 * own response example also uses 'passed'.
 *
 * Idempotency:
 *   NOT idempotent, by choice, for consistency with submit-review. Repeat validate
 *   on the same item finds lifecycle_state = 'validated' (not in ALLOWED_FROM) and
 *   returns 409 INVALID_TRANSITION.
 *
 * Checks:
 *   1.  PATCH without auth → 401
 *   2.  PATCH invalid evidence_type → 400
 *   3.  PATCH unknown nxp_reference → 404
 *   4.  PATCH missing reason → 400 VALIDATION_REQUIRED
 *   5.  PATCH on missing evidence (lifecycle_state = missing) → 409 INVALID_TRANSITION
 *   6.  PATCH after mark_uploaded (lifecycle_state = uploaded) → 200, validated (direct path)
 *   7.  Response fields: id, evidence_type, lifecycle_state, validation_status, updated_at
 *   8.  validate event row created (GET events confirms)
 *   9.  Repeat validate → 409 INVALID_TRANSITION (not idempotent)
 *   10. Second evidence item: uploaded → pending_review (submit-review) → validate → 200
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

const BASE     = (process.env.API_URL      ?? 'http://localhost:3000').replace(/\/$/, '')
const EMAIL    = process.env.VERIFY_EMAIL    ?? 'operator@akoboexports.ng'
const PASSWORD = process.env.VERIFY_PASSWORD ?? 'dev-seed-password'

const NXP_1       = 'NXP-2026-SES-001'
const NXP_UNKNOWN = 'NXP-DOES-NOT-EXIST'
const EV_TYPE_A   = 'nxp_approval'    // direct uploaded → validated
const EV_TYPE_B   = 'bill_of_lading'  // uploaded → pending_review → validated

let passed = 0
let failed = 0

function ok(label: string)                   { console.log(`  ✓ ${label}`); passed++ }
function fail(label: string, detail: string) { console.error(`  ✗ ${label}: ${detail}`); failed++ }

async function request(
  method: string,
  path:   string,
  token?: string,
  body?:  unknown,
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, body: await res.json() }
}

const validatePath = (nxp: string, type: string) =>
  `/export-cases/${encodeURIComponent(nxp)}/evidence/${type}/validate`

const submitReviewPath = (nxp: string, type: string) =>
  `/export-cases/${encodeURIComponent(nxp)}/evidence/${type}/submit-review`

const markPath = (nxp: string, type: string) =>
  `/export-cases/${encodeURIComponent(nxp)}/evidence/${type}`

const eventsPath = (nxp: string, type: string) =>
  `/export-cases/${encodeURIComponent(nxp)}/evidence/${type}/events`

async function main() {
  console.log('=== ExportOS RC4 — PATCH validate Verification ===')
  console.log(`  server: ${BASE}\n`)

  // Authenticate
  const loginFetch = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })
  const loginBody = await loginFetch.json() as Record<string, unknown>
  if (loginFetch.status !== 200 || typeof loginBody.token !== 'string') {
    console.error(`  Fatal: login failed (${loginFetch.status}): ${JSON.stringify(loginBody)}`)
    process.exit(1)
  }
  const token = loginBody.token as string
  console.log('  (auth OK)\n')

  // ── Check 1: PATCH without auth → 401 ────────────────────────────────────────
  {
    const { status } = await request('PATCH', validatePath(NXP_1, EV_TYPE_A))
    if (status !== 401) fail('PATCH without auth', `expected 401, got ${status}`)
    else ok('PATCH without auth — 401')
  }

  // ── Check 2: PATCH invalid evidence_type → 400 ───────────────────────────────
  {
    const { status, body } = await request('PATCH', validatePath(NXP_1, 'tax_clearance'), token, { reason: 'test' })
    if (status !== 400) fail('PATCH invalid evidence_type', `expected 400, got ${status}: ${JSON.stringify(body).slice(0, 80)}`)
    else ok('PATCH invalid evidence_type (tax_clearance) — 400')
  }

  // ── Check 3: PATCH unknown nxp_reference → 404 ───────────────────────────────
  {
    const { status } = await request('PATCH', validatePath(NXP_UNKNOWN, EV_TYPE_A), token, { reason: 'test' })
    if (status !== 404) fail('PATCH unknown nxp_reference', `expected 404, got ${status}`)
    else ok('PATCH unknown nxp_reference — 404')
  }

  // ── Check 4: PATCH missing reason → 400 VALIDATION_REQUIRED ──────────────────
  {
    const { status, body } = await request('PATCH', validatePath(NXP_1, EV_TYPE_A), token)
    const b = body as Record<string, unknown>
    if (status !== 400) {
      fail('PATCH missing reason → 400', `expected 400, got ${status}: ${JSON.stringify(body).slice(0, 100)}`)
    } else if (b['code'] !== 'VALIDATION_REQUIRED') {
      fail('PATCH missing reason → VALIDATION_REQUIRED code', `code: ${b['code']}`)
    } else {
      ok('PATCH missing reason → 400 VALIDATION_REQUIRED')
    }
  }
  {
    const { status, body } = await request('PATCH', validatePath(NXP_1, EV_TYPE_A), token, { reason: '   ' })
    const b = body as Record<string, unknown>
    if (status !== 400 || b['code'] !== 'VALIDATION_REQUIRED') {
      fail('PATCH blank reason → 400 VALIDATION_REQUIRED', `got ${status}: ${JSON.stringify(body).slice(0, 100)}`)
    } else {
      ok('PATCH blank (whitespace-only) reason → 400 VALIDATION_REQUIRED')
    }
  }

  // ── Check 5: PATCH on missing evidence → 409 INVALID_TRANSITION ─────────────
  // The seeded nxp_approval item starts as 'missing'.
  {
    const { status, body } = await request('PATCH', validatePath(NXP_1, EV_TYPE_A), token, { reason: 'Reviewed and confirmed' })
    const b = body as Record<string, unknown>
    if (status !== 409) {
      fail('PATCH on missing evidence → 409', `expected 409, got ${status}: ${JSON.stringify(body).slice(0, 120)}`)
    } else if (b['code'] !== 'INVALID_TRANSITION') {
      fail('PATCH on missing evidence → INVALID_TRANSITION code', `code: ${b['code']}`)
    } else {
      ok(`PATCH on missing evidence → 409 INVALID_TRANSITION (currentState: ${b['currentState']})`)
    }
  }

  // ── Precondition: mark nxp_approval as uploaded ──────────────────────────────
  {
    const { status, body } = await request('PATCH', markPath(NXP_1, EV_TYPE_A), token, { action: 'mark_uploaded' })
    if (status !== 200) {
      console.error(`  Fatal: mark_uploaded failed (${status}): ${JSON.stringify(body).slice(0, 120)}`)
      process.exit(1)
    }
    console.log('  (mark_uploaded OK — nxp_approval is now uploaded)')
  }

  // ── Check 6: PATCH after mark_uploaded → 200, validated (direct path) ───────
  let updatedItem: Record<string, unknown> = {}
  {
    const { status, body } = await request('PATCH', validatePath(NXP_1, EV_TYPE_A), token, { reason: 'Reviewed and confirmed accurate' })
    const b = body as Record<string, unknown>
    if (status !== 200 || typeof b.data !== 'object' || b.data === null) {
      fail('PATCH uploaded → validated (direct)', `expected 200 with data, got ${status}: ${JSON.stringify(body).slice(0, 120)}`)
    } else {
      updatedItem = b.data as Record<string, unknown>
      if (updatedItem['lifecycle_state'] !== 'validated') {
        fail('lifecycle_state = validated', `got '${updatedItem['lifecycle_state']}'`)
      } else {
        ok('PATCH uploaded → 200, lifecycle_state = validated (direct path)')
      }
    }
  }

  // ── Check 7: Response fields present ────────────────────────────────────────
  {
    const required = ['id', 'evidence_type', 'lifecycle_state', 'validation_status', 'updated_at']
    const missing  = required.filter(f => !(f in updatedItem))
    if (missing.length > 0) fail('response fields present', `missing: ${missing.join(', ')}`)
    else ok('all required response fields present')

    if (updatedItem['validation_status'] !== 'passed') {
      fail("validation_status = 'passed'", `got '${updatedItem['validation_status']}'`)
    } else {
      ok(`validation_status = 'passed'`)
    }
  }

  // ── Check 8: validate event row created ──────────────────────────────────────
  {
    const { status, body } = await request('GET', eventsPath(NXP_1, EV_TYPE_A), token)
    const b = body as Record<string, unknown>
    if (status !== 200 || !Array.isArray(b.data)) {
      fail('GET events after validate', `expected 200 array, got ${status}`)
    } else {
      const events = b.data as Record<string, unknown>[]
      const validateEvent = events.find(e => e['event_type'] === 'validate')
      if (!validateEvent) {
        fail('validate event created', `event_types found: ${events.map(e => e['event_type']).join(', ')}`)
      } else {
        ok(`validate event row present (total events: ${events.length})`)
        if (validateEvent['new_lifecycle_state'] !== 'validated') {
          fail('event new_lifecycle_state = validated', `got '${validateEvent['new_lifecycle_state']}'`)
        } else ok('event new_lifecycle_state = validated')

        if (validateEvent['previous_lifecycle_state'] !== 'uploaded') {
          fail('event previous_lifecycle_state = uploaded', `got '${validateEvent['previous_lifecycle_state']}'`)
        } else ok('event previous_lifecycle_state = uploaded')

        if (validateEvent['new_validation_status'] !== 'passed') {
          fail("event new_validation_status = 'passed'", `got '${validateEvent['new_validation_status']}'`)
        } else ok("event new_validation_status = 'passed'")

        if (validateEvent['reason'] !== 'Reviewed and confirmed accurate') {
          fail('event reason recorded', `got '${validateEvent['reason']}'`)
        } else ok('event reason recorded correctly')
      }
    }
  }

  // ── Check 9: Repeat validate → 409 INVALID_TRANSITION ────────────────────────
  {
    const { status, body } = await request('PATCH', validatePath(NXP_1, EV_TYPE_A), token, { reason: 'Second attempt' })
    const b = body as Record<string, unknown>
    if (status !== 409) {
      fail('repeat validate → 409', `expected 409, got ${status}: ${JSON.stringify(body).slice(0, 120)}`)
    } else if (b['code'] !== 'INVALID_TRANSITION') {
      fail('repeat validate → INVALID_TRANSITION code', `code: ${b['code']}`)
    } else {
      ok(`repeat validate → 409 INVALID_TRANSITION (currentState: ${b['currentState']})`)
    }
  }

  // ── Check 10: pending_review → validated path (via a second evidence item) ──
  {
    const mark = await request('PATCH', markPath(NXP_1, EV_TYPE_B), token, { action: 'mark_uploaded' })
    if (mark.status !== 200) {
      fail('precondition: mark_uploaded on bill_of_lading', `expected 200, got ${mark.status}`)
    } else {
      const enterReview = await request('PATCH', submitReviewPath(NXP_1, EV_TYPE_B), token, { reason: 'Entering queue' })
      if (enterReview.status !== 200) {
        fail('precondition: submit-review on bill_of_lading', `expected 200, got ${enterReview.status}`)
      } else {
        const { status, body } = await request('PATCH', validatePath(NXP_1, EV_TYPE_B), token, { reason: 'Reviewed via pending_review queue' })
        const b = body as Record<string, unknown>
        const data = b.data as Record<string, unknown> | undefined
        if (status !== 200 || data?.['lifecycle_state'] !== 'validated') {
          fail('PATCH pending_review → validated', `expected 200 validated, got ${status}: ${JSON.stringify(body).slice(0, 120)}`)
        } else {
          ok('PATCH pending_review → 200, lifecycle_state = validated (queued path)')
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
