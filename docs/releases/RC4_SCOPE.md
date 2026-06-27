# RC4 Scope — Evidence Validation

**Date:** 2026-06-27
**ADR:** [ADR-012 — Evidence Validation Lifecycle](../adr/ADR-012-evidence-validation-lifecycle.md)
**Prerequisite:** RC3 complete (`f1f7efe`)

## RC4 Objective

Implement the evidence validation lifecycle defined in ADR-012. After RC4, a reviewer can accept or reject uploaded evidence documents, the exporter can re-submit after rejection, and every transition is recorded in an immutable audit log. The compliance record reflects validated state rather than uploaded state alone.

## In Scope

- `evidence_events` table — append-only audit log for every lifecycle transition
- `lifecycle_state` transitions: `uploaded → pending_review`, `pending_review → validated`, `pending_review → rejected`, `rejected → uploaded`, `validated → superseded`
- API endpoints for reviewer actions: validate, reject, supersede
- API enforcement of allowed-transitions table from ADR-012
- Actor type recorded on every transition (`exporter`, `reviewer`, `admin`, `system`)
- Reason field required for `reviewer` and `admin` transitions
- Compliance record boolean sync when evidence reaches `validated` (replacing current sync on `uploaded`)
- Frontend: reviewer action buttons (Validate / Reject) visible when `lifecycle_state = uploaded` or `pending_review`
- Frontend: rejection reason input before submitting a rejection
- Frontend: audit trail panel on each evidence item showing transition history
- Frontend: exporter re-upload path when `lifecycle_state = rejected`
- `pending_review` auto-assignment on upload (system actor, deferred reviewer queue)
- RLS policy on `evidence_events` — read-only for exporters on their own records; read-write for reviewers and admins
- Verify scripts covering all new transitions and 409 conflict responses

## Out of Scope

Per ADR-012 and permanent scope constraints:

- OCR or automated document content extraction
- AI-assisted validation
- External file storage changes
- Email or in-app notifications on state change
- CBN or government system integrations
- Payment movement, stablecoin wallets, FX trading, sanctions screening, TRMS submission
- Multi-reviewer consensus / quorum
- Deadline enforcement as a lifecycle state
- Reviewer role schema changes to `exporter_users` (reviewer identity is a separate design decision per ADR-012 open question 1)
- Frontend: marketing sections, scope expansion, invented customer data

## User Roles Affected

| Role | Change |
|---|---|
| Exporter / operator | Re-upload path after rejection; can no longer treat `uploaded` as terminal; sees rejection reason |
| Reviewer | New: can validate or reject items in `uploaded` or `pending_review` state |
| Admin | New: can supersede any item; required to supply a reason |
| System | Auto-transition `uploaded → pending_review` on PATCH mark_uploaded |

Reviewer and admin role infrastructure (role storage, middleware) must be scoped as part of RC4 database and API changes.

## Required Database Changes

1. **`evidence_events` table** — append-only; columns per ADR-012 audit requirements: `id`, `evidence_item_id`, `previous_state`, `new_state`, `actor_type`, `actor_id`, `occurred_at`, `reason`, `note`; no UPDATE or DELETE permitted; RLS enabled
2. **`lifecycle_state` CHECK constraint extension** on `evidence_items` — add `pending_review`, `rejected`, `superseded` to the allowed value set
3. **Reviewer role storage** — decision on ADR-012 open question 1 required before migration can be written; placeholder: `reviewer_users` table with `user_id`, `exporter_id` (scoped reviewer), `role` (`REVIEWER` / `ADMIN`)
4. **RLS policy on `evidence_events`** — exporters read their own records; reviewers read all records in scope; admins read/write all
5. **Index on `evidence_events(evidence_item_id, occurred_at)`** for audit trail fetch performance
6. **`compliance_records` boolean sync** — update sync trigger or service logic to fire on `validated` instead of (or in addition to) `uploaded`

## Required API Changes

1. **`PATCH /export-cases/:nxp/evidence/:type`** — extend to support additional `action` values: `validate`, `reject`, `supersede`; current `mark_uploaded` action unchanged
2. **Transition guard** — enforce ADR-012 allowed-transitions table; return `409 CONFLICT` with `{ currentState, allowedActions }` for invalid transitions
3. **Actor resolution middleware** — extend `requireAuth` or add `requireRole` middleware to resolve actor type (`exporter`, `reviewer`, `admin`) from the JWT and role tables; attach to `res.locals`
4. **`reason` validation** — require non-empty `reason` in request body when actor is `reviewer` or `admin`; return `400` if absent
5. **`evidence_events` write** — every transition PATCH must write to `evidence_events` in the same DB transaction as the `evidence_items` UPDATE; rollback both on failure
6. **`GET /export-cases/:nxp/evidence/:type/history`** — returns the ordered `evidence_events` rows for a single evidence item; accessible to all authenticated actors for their own records
7. **`GET /export-cases/:nxp/evidence`** — no change to response shape; `lifecycle_state` will now reflect new states naturally

## Required Frontend Changes

1. **Evidence checklist** — show state-appropriate action button per row: Upload (missing/rejected), Review pending (pending_review), Validate / Reject (reviewer only, uploaded/pending_review), Supersede (admin only, validated)
2. **Rejection reason modal** — input required before reviewer can submit a rejection; sent as `reason` in the PATCH body
3. **Re-upload indicator** — when `lifecycle_state = rejected`, show rejection reason to exporter alongside the Upload button
4. **Audit trail panel** — collapsible per-evidence-item section showing `evidence_events` history: timestamp, actor, transition, reason
5. **State badge updates** — extend existing `lifecycle_state` display to cover `pending_review` (yellow), `validated` (green/confirmed), `rejected` (red), `superseded` (grey/muted)
6. **Role-gated UI** — Validate / Reject buttons must not render for exporter/operator role; Upload must not render for reviewer role on items they did not submit

## Required Tests

1. Verify script: `verify-evidence-validation-api.ts`
   - `PATCH validate` → 200, `lifecycle_state = validated`
   - `PATCH reject` with reason → 200, `lifecycle_state = rejected`
   - `PATCH reject` without reason → 400
   - `PATCH validate` on already-validated item → 409
   - `PATCH mark_uploaded` on rejected item → 200 (re-upload path)
   - `PATCH validate` by exporter actor → 403
   - `PATCH mark_uploaded` by reviewer actor → 403
   - `GET .../history` → ordered event list with correct actor/state fields
2. Verify script: `verify-evidence-audit-trail.ts`
   - Each transition produces exactly one `evidence_events` row
   - `occurred_at` is set by DB, not caller
   - Audit rows are immutable (no UPDATE/DELETE permitted via API)
3. Regression: `verify-mark-uploaded-api.ts` must continue to pass unchanged

## Definition of Done

- [ ] All `lifecycle_state` values from ADR-012 exist in the DB CHECK constraint
- [ ] `evidence_events` table exists with RLS enabled
- [ ] Every PATCH transition writes an audit row in the same transaction
- [ ] Reviewer can validate and reject; exporter cannot
- [ ] Exporter can re-upload after rejection
- [ ] Admin can supersede a validated item with a reason
- [ ] `GET .../history` returns complete audit trail in order
- [ ] Frontend shows correct action buttons per role and per state
- [ ] Rejection reason is displayed to exporter on rejected items
- [ ] `verify-evidence-validation-api.ts` passes 100%
- [ ] `verify-mark-uploaded-api.ts` passes without modification
- [ ] No frontend scope expansion beyond items listed above
- [ ] ADR-012 open questions 1, 3, and 4 answered before migration is written

## Risks and Constraints

| Risk | Severity | Mitigation |
|---|---|---|
| ADR-012 open question 1 (reviewer role storage) unresolved | High — blocks migration and middleware | Resolve before writing any RC4 code; choose `reviewer_users` table approach |
| Compliance boolean sync changes from `uploaded` to `validated` | Medium — existing compliance checks rely on `uploaded` | Audit all compliance read paths before changing sync trigger; consider syncing on both during transition |
| `evidence_events` written in same transaction as `evidence_items` UPDATE | Medium — increases transaction scope | Keep transactions short; no external calls inside transaction block |
| Existing `pending` `validation_status` rows (set on RC3 mark_uploaded) | Low — these are correct; `pending_review` lifecycle_state replaces the intent | Confirm no read path conflates `validation_status = pending` with `lifecycle_state = pending_review` |
| Role-gated UI rendered server-side vs client-side | Low | Role must come from the API (`/auth/me` extended with `actorType`); never inferred client-side from email or name |
