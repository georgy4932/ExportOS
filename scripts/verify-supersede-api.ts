/**
 * Runtime verification for PATCH /export-cases/:nxp/evidence/:type/supersede
 * — evidence supersede transition (RC4 write path, step 5).
 *
 * Prerequisites:
 *   npm run db:reset            (applies migrations + seed)
 *   npm run api                 (server running in a separate terminal)
 *   npm run verify-supersede-api
 *
 * Seed state assumed:
 *   - NXP_1 (NXP-2026-SES-001) exists, owned by the seeded exporter (b0b00001-...)
 *   - evidence_items row for nxp_approval starts as 'missing' (from seed)
 *   - After mark_uploaded + validate: nxp_approval is 'validated'
 *
 * Transition behaviour (RC4_API_DESIGN.md §5):
 *   validated       → superseded (ALLOWED — the only allowed source state)
 *   any other state → 409 INVALID_TRANSITION
 *
 * reason is REQUIRED. Missing or empty reason → 400 VALIDATION_REQUIRED.
 *
 * validation_status on success is 'not_applicable' — matches the DB CHECK
 * constraint on evidence_items.validation_status and RC4_API_DESIGN.md's own
 * response example.
 *
 * Authorization: admin ONLY — unlike submit-review/validate/reject, which allow
 * reviewer+admin, supersede rejects reviewers with 403 as well as exporters.
 * The seeded user (operator@akoboexports.ng) is role=ADMIN, so it passes the guard.
 * A REVIEWER-role user is required to exercise the reviewer-403 path; see check 3.
 *
 * Idempotency:
 *   NOT idempotent, for consistency with submit-review/validate/reject. Repeat
 *   supersede on the same item finds lifecycle_state = 'superseded' (not in
 *   ALLOWED_FROM) and returns 409 INVALID_TRANSITION.
 *
 * Checks:
 *   1.  PATCH without auth → 401
 *   2.  PATCH invalid evidence_type → 400
 *   3.  PATCH with reviewer-role token → 403 FORBIDDEN (skipped unless REVIEWER_EMAIL/REVIEWER_PASSWORD set)
 *   4.  PATCH unknown nxp_reference → 404
 *   5.  PATCH missing reason → 400 VALIDATION_REQUIRED
 *   6.  PATCH blank (whitespace-only) reason → 400 VALIDATION_REQUIRED
 *   7.  PATCH on missing evidence (lifecycle_state = missing) → 409 INVALID_TRANSITION
 *   8.  PATCH on uploaded (not yet validated) → 409 INVALID_TRANSITION
 *   9.  PATCH after validate (lifecycle_state = validated) → 200, superseded
 *   10. Response fields: id, evidence_type, lifecycle_state, validation_status, updated_at
 *   11. supersede event row created (GET events confirms, reason recorded)
 *   12. Repeat supersede → 409 INVALID_TRANSITION (not idempotent)
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

const BASE     = (process.env.API_URL      ?? 'http://localhost:3000').replace(/\/$/, '')
const EMAIL    = process.env.VERIFY_EMAIL    ?? 'operator@akoboexports.ng'
const PASSWORD = process.env.VERIFY_PASSWORD ?? 'dev-seed-password'
const REVIEWER_EMAIL    = process.env.REVIEWER_EMAIL
const REVIEWER_PASSWORD = process.env.REVIEWER_PASSWORD

const NXP_1       = 'NXP-2026-SES-001'
const NXP_UNKNOWN = 'NXP-DOES-NOT-EXIST'
const EV_TYPE_A   = 'nxp_approval'

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

const supersedePath = (nxp: string, type: string) =>
  `/export-cases/${encodeURIComponent(nxp)}/evidence/${type}/supersede`

const validatePath = (nxp: string, type: string) =>
  `/export-cases/${encodeURIComponent(nxp)}/evidence/${type}/validate`

const markPath = (nxp: string, type: string) =>
  `/export-cases/${encodeURIComponent(nxp)}/evidence/${type}`

const eventsPath = (nxp: string, type: string) =>
  `/export-cases/${encodeURIComponent(nxp)}/evidence/${type}/events`

async function main() {
  console.log('=== ExportOS RC4 — PATCH supersede Verification ===')
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
    const { status } = await request('PATCH', supersedePath(NXP_1, EV_TYPE_A))
    if (status !== 401) fail('PATCH without auth', `expected 401, got ${status}`)
    else ok('PATCH without auth — 401')
  }

  // ── Check 2: PATCH invalid evidence_type → 400 ───────────────────────────────
  {
    const { status, body } = await request('PATCH', supersedePath(NXP_1, 'tax_clearance'), token, { reason: 'test' })
    if (status !== 400) fail('PATCH invalid evidence_type', `expected 400, got ${status}: ${JSON.stringify(body).slice(0, 80)}`)
    else ok('PATCH invalid evidence_type (tax_clearance) — 400')
  }

  // ── Check 3: PATCH with reviewer-role token → 403 FORBIDDEN ──────────────────
  // Distinguishing test for supersede: reviewers are rejected here, unlike
  // submit-review/validate/reject where reviewer+admin are both allowed.
  {
    if (!REVIEWER_EMAIL || !REVIEWER_PASSWORD) {
      console.log('  ~ PATCH reviewer-role → 403: SKIPPED (set REVIEWER_EMAIL + REVIEWER_PASSWORD to enable)')
    } else {
      const reviewerLoginFetch = await fetch(`${BASE}/auth/login`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email: REVIEWER_EMAIL, password: REVIEWER_PASSWORD }),
      })
      const reviewerLoginBody = await reviewerLoginFetch.json() as Record<string, unknown>
      if (reviewerLoginFetch.status !== 200 || typeof reviewerLoginBody.token !== 'string') {
        fail('PATCH reviewer-role → 403', `reviewer login failed (${reviewerLoginFetch.status}): ${JSON.stringify(reviewerLoginBody).slice(0, 80)}`)
      } else {
        const reviewerToken = reviewerLoginBody.token as string
        const { status, body } = await request('PATCH', supersedePath(NXP_1, EV_TYPE_A), reviewerToken, { reason: 'test' })
        const b = body as Record<string, unknown>
        if (status !== 403) {
          fail('PATCH reviewer-role → 403 FORBIDDEN', `expected 403, got ${status}: ${JSON.stringify(body).slice(0, 80)}`)
        } else if (b['code'] !== 'FORBIDDEN') {
          fail('PATCH reviewer-role → FORBIDDEN code', `code: ${b['code']}`)
        } else {
          ok(`PATCH reviewer-role → 403 FORBIDDEN (actorRole: ${b['actorRole']})`)
        }
      }
    }
  }

  // ── Check 4: PATCH unknown nxp_reference → 404 ───────────────────────────────
  {
    const { status } = await request('PATCH', supersedePath(NXP_UNKNOWN, EV_TYPE_A), token, { reason: 'test' })
    if (status !== 404) fail('PATCH unknown nxp_reference', `expected 404, got ${status}`)
    else ok('PATCH unknown nxp_reference — 404')
  }

  // ── Check 5: PATCH missing reason → 400 VALIDATION_REQUIRED ──────────────────
  {
    const { status, body } = await request('PATCH', supersedePath(NXP_1, EV_TYPE_A), token)
    const b = body as Record<string, unknown>
    if (status !== 400) {
      fail('PATCH missing reason → 400', `expected 400, got ${status}: ${JSON.stringify(body).slice(0, 100)}`)
    } else if (b['code'] !== 'VALIDATION_REQUIRED') {
      fail('PATCH missing reason → VALIDATION_REQUIRED code', `code: ${b['code']}`)
    } else {
      ok('PATCH missing reason → 400 VALIDATION_REQUIRED')
    }
  }

  // ── Check 6: PATCH blank reason → 400 VALIDATION_REQUIRED ────────────────────
  {
    const { status, body } = await request('PATCH', supersedePath(NXP_1, EV_TYPE_A), token, { reason: '   ' })
    const b = body as Record<string, unknown>
    if (status !== 400 || b['code'] !== 'VALIDATION_REQUIRED') {
      fail('PATCH blank reason → 400 VALIDATION_REQUIRED', `got ${status}: ${JSON.stringify(body).slice(0, 100)}`)
    } else {
      ok('PATCH blank (whitespace-only) reason → 400 VALIDATION_REQUIRED')
    }
  }

  // ── Check 7: PATCH on missing evidence → 409 INVALID_TRANSITION ─────────────
  // The seeded nxp_approval item starts as 'missing'.
  {
    const { status, body } = await request('PATCH', supersedePath(NXP_1, EV_TYPE_A), token, { reason: 'Newer document available' })
    const b = body as Record<string, unknown>
    if (status !== 409) {
      fail('PATCH on missing evidence → 409', `expected 409, got ${status}: ${JSON.stringify(body).slice(0, 120)}`)
    } else if (b['code'] !== 'INVALID_TRANSITION') {
      fail('PATCH on missing evidence → INVALID_TRANSITION code', `code: ${b['code']}`)
    } else {
      ok(`PATCH on missing evidence → 409 INVALID_TRANSITION (currentState: ${b['currentState']})`)
    }
  }

  // ── Precondition: mark nxp_approval as uploaded, then validate ──────────────
  {
    const mark = await request('PATCH', markPath(NXP_1, EV_TYPE_A), token, { action: 'mark_uploaded' })
    if (mark.status !== 200) {
      console.error(`  Fatal: mark_uploaded failed (${mark.status}): ${JSON.stringify(mark.body).slice(0, 120)}`)
      process.exit(1)
    }
    console.log('  (mark_uploaded OK — nxp_approval is now uploaded)')
  }

  // ── Check 8: PATCH on uploaded (not yet validated) → 409 INVALID_TRANSITION ─
  {
    const { status, body } = await request('PATCH', supersedePath(NXP_1, EV_TYPE_A), token, { reason: 'Newer document available' })
    const b = body as Record<string, unknown>
    if (status !== 409) {
      fail('PATCH on uploaded (pre-validate) → 409', `expected 409, got ${status}: ${JSON.stringify(body).slice(0, 120)}`)
    } else if (b['code'] !== 'INVALID_TRANSITION') {
      fail('PATCH on uploaded → INVALID_TRANSITION code', `code: ${b['code']}`)
    } else {
      ok(`PATCH on uploaded (pre-validate) → 409 INVALID_TRANSITION (currentState: ${b['currentState']})`)
    }
  }

  // ── Precondition: validate nxp_approval (uploaded → validated, direct path) ─
  {
    const validate = await request('PATCH', validatePath(NXP_1, EV_TYPE_A), token, { reason: 'Reviewed and confirmed accurate' })
    if (validate.status !== 200) {
      console.error(`  Fatal: validate failed (${validate.status}): ${JSON.stringify(validate.body).slice(0, 120)}`)
      process.exit(1)
    }
    console.log('  (validate OK — nxp_approval is now validated)')
  }

  // ── Check 9: PATCH after validate → 200, superseded ─────────────────────────
  let updatedItem: Record<string, unknown> = {}
  {
    const { status, body } = await request('PATCH', supersedePath(NXP_1, EV_TYPE_A), token, { reason: 'Newer nxp_approval document supersedes this one' })
    const b = body as Record<string, unknown>
    if (status !== 200 || typeof b.data !== 'object' || b.data === null) {
      fail('PATCH validated → superseded', `expected 200 with data, got ${status}: ${JSON.stringify(body).slice(0, 120)}`)
    } else {
      updatedItem = b.data as Record<string, unknown>
      if (updatedItem['lifecycle_state'] !== 'superseded') {
        fail('lifecycle_state = superseded', `got '${updatedItem['lifecycle_state']}'`)
      } else {
        ok('PATCH validated → 200, lifecycle_state = superseded')
      }
    }
  }

  // ── Check 10: Response fields present ───────────────────────────────────────
  {
    const required = ['id', 'evidence_type', 'lifecycle_state', 'validation_status', 'updated_at']
    const missing  = required.filter(f => !(f in updatedItem))
    if (missing.length > 0) fail('response fields present', `missing: ${missing.join(', ')}`)
    else ok('all required response fields present')

    if (updatedItem['validation_status'] !== 'not_applicable') {
      fail("validation_status = 'not_applicable'", `got '${updatedItem['validation_status']}'`)
    } else {
      ok(`validation_status = 'not_applicable'`)
    }
  }

  // ── Check 11: supersede event row created ────────────────────────────────────
  {
    const { status, body } = await request('GET', eventsPath(NXP_1, EV_TYPE_A), token)
    const b = body as Record<string, unknown>
    if (status !== 200 || !Array.isArray(b.data)) {
      fail('GET events after supersede', `expected 200 array, got ${status}`)
    } else {
      const events = b.data as Record<string, unknown>[]
      const supersedeEvent = events.find(e => e['event_type'] === 'supersede')
      if (!supersedeEvent) {
        fail('supersede event created', `event_types found: ${events.map(e => e['event_type']).join(', ')}`)
      } else {
        ok(`supersede event row present (total events: ${events.length})`)
        if (supersedeEvent['new_lifecycle_state'] !== 'superseded') {
          fail('event new_lifecycle_state = superseded', `got '${supersedeEvent['new_lifecycle_state']}'`)
        } else ok('event new_lifecycle_state = superseded')

        if (supersedeEvent['previous_lifecycle_state'] !== 'validated') {
          fail('event previous_lifecycle_state = validated', `got '${supersedeEvent['previous_lifecycle_state']}'`)
        } else ok('event previous_lifecycle_state = validated')

        if (supersedeEvent['new_validation_status'] !== 'not_applicable') {
          fail("event new_validation_status = 'not_applicable'", `got '${supersedeEvent['new_validation_status']}'`)
        } else ok("event new_validation_status = 'not_applicable'")

        if (supersedeEvent['reason'] !== 'Newer nxp_approval document supersedes this one') {
          fail('event reason recorded', `got '${supersedeEvent['reason']}'`)
        } else ok('event reason recorded correctly')
      }
    }
  }

  // ── Check 12: Repeat supersede → 409 INVALID_TRANSITION ──────────────────────
  {
    const { status, body } = await request('PATCH', supersedePath(NXP_1, EV_TYPE_A), token, { reason: 'Second attempt' })
    const b = body as Record<string, unknown>
    if (status !== 409) {
      fail('repeat supersede → 409', `expected 409, got ${status}: ${JSON.stringify(body).slice(0, 120)}`)
    } else if (b['code'] !== 'INVALID_TRANSITION') {
      fail('repeat supersede → INVALID_TRANSITION code', `code: ${b['code']}`)
    } else {
      ok(`repeat supersede → 409 INVALID_TRANSITION (currentState: ${b['currentState']})`)
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
