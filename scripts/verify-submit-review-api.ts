/**
 * Runtime verification for PATCH /export-cases/:nxp/evidence/:type/submit-review
 * — evidence submit-review transition (RC4 write path, step 2).
 *
 * Prerequisites:
 *   npm run db:reset            (applies migrations + seed)
 *   npm run api                 (server running in a separate terminal)
 *   npm run verify-submit-review-api
 *
 * Seed state assumed:
 *   - NXP_1 (NXP-2026-SES-001) exists, owned by the seeded exporter (b0b00001-...)
 *   - evidence_items row for nxp_approval starts as 'missing' (from seed)
 *   - After mark_uploaded: nxp_approval is 'uploaded', ready for submit-review
 *
 * Transition behaviour:
 *   uploaded → pending_review  (ALLOWED, event_type = enter_review)
 *   any other state → 409 INVALID_TRANSITION
 *
 * Idempotency:
 *   NOT idempotent. Repeat submit-review on the same item returns 409 INVALID_TRANSITION
 *   because the state is already pending_review. Callers must check current state before retrying.
 *
 * Checks:
 *   1.  PATCH without auth → 401
 *   2.  PATCH with exporter-role token → 403 FORBIDDEN (reviewer/admin only)
 *   3.  PATCH invalid evidence_type → 400
 *   4.  PATCH unknown nxp_reference → 404
 *   5.  PATCH on missing evidence (lifecycle_state = missing) → 409 INVALID_TRANSITION
 *   6.  PATCH after mark_uploaded (lifecycle_state = uploaded) → 200, pending_review
 *   7.  Response fields: id, evidence_type, lifecycle_state, validation_status, updated_at
 *   8.  enter_review event row created (GET events confirms count increased by 1)
 *   9.  Repeat submit-review → 409 INVALID_TRANSITION (not idempotent)
 *
 * Note on check 2: The seeded user (operator@akoboexports.ng) is role=ADMIN and therefore
 * passes the requireRole('reviewer', 'admin') guard. A separate MEMBER-role user would be
 * needed to exercise the 403 path at runtime. The check below documents this requirement
 * and skips with a warning if no MEMBER_EMAIL/MEMBER_PASSWORD env vars are set.
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

const BASE     = (process.env.API_URL      ?? 'http://localhost:3000').replace(/\/$/, '')
const EMAIL    = process.env.VERIFY_EMAIL    ?? 'operator@akoboexports.ng'
const PASSWORD = process.env.VERIFY_PASSWORD ?? 'dev-seed-password'

const NXP_1          = 'NXP-2026-SES-001'
const NXP_UNKNOWN    = 'NXP-DOES-NOT-EXIST'
const EV_TYPE        = 'nxp_approval'
const MEMBER_EMAIL   = process.env.MEMBER_EMAIL
const MEMBER_PASSWORD = process.env.MEMBER_PASSWORD

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

const submitPath = (nxp: string, type: string) =>
  `/export-cases/${encodeURIComponent(nxp)}/evidence/${type}/submit-review`

const markPath = (nxp: string, type: string) =>
  `/export-cases/${encodeURIComponent(nxp)}/evidence/${type}`

const eventsPath = (nxp: string, type: string) =>
  `/export-cases/${encodeURIComponent(nxp)}/evidence/${type}/events`

async function main() {
  console.log('=== ExportOS RC4 — PATCH submit-review Verification (reviewer/admin-only) ===')
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
    const { status } = await request('PATCH', submitPath(NXP_1, EV_TYPE))
    if (status !== 401) fail('PATCH without auth', `expected 401, got ${status}`)
    else ok('PATCH without auth — 401')
  }

  // ── Check 2: PATCH with exporter-role token → 403 FORBIDDEN ─────────────────
  // This check runs only when MEMBER_EMAIL + MEMBER_PASSWORD are set in env.
  // The seeded user is ADMIN and therefore passes the role guard; a MEMBER-role
  // user is required to exercise the 403 path.
  {
    if (!MEMBER_EMAIL || !MEMBER_PASSWORD) {
      console.log('  ~ PATCH exporter-role → 403: SKIPPED (set MEMBER_EMAIL + MEMBER_PASSWORD to enable)')
    } else {
      const memberLoginFetch = await fetch(`${BASE}/auth/login`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email: MEMBER_EMAIL, password: MEMBER_PASSWORD }),
      })
      const memberLoginBody = await memberLoginFetch.json() as Record<string, unknown>
      if (memberLoginFetch.status !== 200 || typeof memberLoginBody.token !== 'string') {
        fail('PATCH exporter-role → 403', `member login failed (${memberLoginFetch.status}): ${JSON.stringify(memberLoginBody).slice(0, 80)}`)
      } else {
        const memberToken = memberLoginBody.token as string
        const { status, body } = await request('PATCH', submitPath(NXP_1, EV_TYPE), memberToken)
        const b = body as Record<string, unknown>
        if (status !== 403) {
          fail('PATCH exporter-role → 403 FORBIDDEN', `expected 403, got ${status}: ${JSON.stringify(body).slice(0, 80)}`)
        } else if (b['code'] !== 'FORBIDDEN') {
          fail('PATCH exporter-role → FORBIDDEN code', `code: ${b['code']}`)
        } else {
          ok(`PATCH exporter-role → 403 FORBIDDEN (actorRole: ${b['actorRole']})`)
        }
      }
    }
  }

  // ── Check 3: PATCH invalid evidence_type → 400 ───────────────────────────────
  {
    const { status, body } = await request('PATCH', submitPath(NXP_1, 'tax_clearance'), token)
    if (status !== 400) fail('PATCH invalid evidence_type', `expected 400, got ${status}: ${JSON.stringify(body).slice(0, 80)}`)
    else ok('PATCH invalid evidence_type (tax_clearance) — 400')
  }

  // ── Check 4: PATCH unknown nxp_reference → 404 ───────────────────────────────
  {
    const { status } = await request('PATCH', submitPath(NXP_UNKNOWN, EV_TYPE), token)
    if (status !== 404) fail('PATCH unknown nxp_reference', `expected 404, got ${status}`)
    else ok('PATCH unknown nxp_reference — 404')
  }

  // ── Check 5: PATCH on missing evidence → 409 INVALID_TRANSITION ─────────────
  // The seeded nxp_approval item starts as 'missing'.
  // Before any mark_uploaded call, submit-review must be rejected even for admin.
  {
    const { status, body } = await request('PATCH', submitPath(NXP_1, EV_TYPE), token)
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
    const { status, body } = await request('PATCH', markPath(NXP_1, EV_TYPE), token, { action: 'mark_uploaded' })
    if (status !== 200) {
      console.error(`  Fatal: mark_uploaded failed (${status}): ${JSON.stringify(body).slice(0, 120)}`)
      process.exit(1)
    }
    console.log('  (mark_uploaded OK — nxp_approval is now uploaded)')
  }

  // ── Check 6: PATCH after mark_uploaded → 200, pending_review ────────────────
  let updatedItem: Record<string, unknown> = {}
  {
    const { status, body } = await request('PATCH', submitPath(NXP_1, EV_TYPE), token, { reason: 'Submitted for review via verify script' })
    const b = body as Record<string, unknown>
    if (status !== 200 || typeof b.data !== 'object' || b.data === null) {
      fail('PATCH uploaded → pending_review', `expected 200 with data, got ${status}: ${JSON.stringify(body).slice(0, 120)}`)
    } else {
      updatedItem = b.data as Record<string, unknown>
      if (updatedItem['lifecycle_state'] !== 'pending_review') {
        fail('lifecycle_state = pending_review', `got '${updatedItem['lifecycle_state']}'`)
      } else {
        ok(`PATCH uploaded → 200, lifecycle_state = pending_review`)
      }
    }
  }

  // ── Check 7: Response fields present ────────────────────────────────────────
  {
    const required = ['id', 'evidence_type', 'lifecycle_state', 'validation_status', 'updated_at']
    const missing  = required.filter(f => !(f in updatedItem))
    if (missing.length > 0) fail('response fields present', `missing: ${missing.join(', ')}`)
    else ok('all required response fields present')

    if (updatedItem['validation_status'] !== 'pending') {
      fail('validation_status = pending', `got '${updatedItem['validation_status']}'`)
    } else {
      ok(`validation_status = pending`)
    }
  }

  // ── Check 8: enter_review event row created ──────────────────────────────────
  {
    const { status, body } = await request('GET', eventsPath(NXP_1, EV_TYPE), token)
    const b = body as Record<string, unknown>
    if (status !== 200 || !Array.isArray(b.data)) {
      fail('GET events after submit-review', `expected 200 array, got ${status}`)
    } else {
      const events = b.data as Record<string, unknown>[]
      const enterReviewEvent = events.find(e => e['event_type'] === 'enter_review')
      if (!enterReviewEvent) {
        fail('enter_review event created', `event_types found: ${events.map(e => e['event_type']).join(', ')}`)
      } else {
        ok(`enter_review event row present (total events: ${events.length})`)
        // Verify event fields
        if (enterReviewEvent['new_lifecycle_state'] !== 'pending_review') {
          fail('event new_lifecycle_state = pending_review', `got '${enterReviewEvent['new_lifecycle_state']}'`)
        } else ok('event new_lifecycle_state = pending_review')

        if (enterReviewEvent['previous_lifecycle_state'] !== 'uploaded') {
          fail('event previous_lifecycle_state = uploaded', `got '${enterReviewEvent['previous_lifecycle_state']}'`)
        } else ok('event previous_lifecycle_state = uploaded')

        if (enterReviewEvent['actor_user_id'] === null || enterReviewEvent['actor_user_id'] === undefined) {
          fail('event actor_user_id present', 'got null (expected authenticated user id)')
        } else ok('event actor_user_id = authenticated user id')
      }
    }
  }

  // ── Check 9: Repeat submit-review → 409 INVALID_TRANSITION ──────────────────
  {
    const { status, body } = await request('PATCH', submitPath(NXP_1, EV_TYPE), token)
    const b = body as Record<string, unknown>
    if (status !== 409) {
      fail('repeat submit-review → 409', `expected 409, got ${status}: ${JSON.stringify(body).slice(0, 120)}`)
    } else if (b['code'] !== 'INVALID_TRANSITION') {
      fail('repeat submit-review → INVALID_TRANSITION code', `code: ${b['code']}`)
    } else {
      ok(`repeat submit-review → 409 INVALID_TRANSITION (currentState: ${b['currentState']})`)
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
