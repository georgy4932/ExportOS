# RC4 API Design — Evidence Validation

**Date:** 2026-06-27
**ADR:** [ADR-012 — Evidence Validation Lifecycle](../adr/ADR-012-evidence-validation-lifecycle.md)
**Scope:** [RC4_SCOPE.md](RC4_SCOPE.md)
**DB Design:** [RC4_DATABASE_DESIGN.md](RC4_DATABASE_DESIGN.md)
**Prerequisite:** RC3 complete (`f1f7efe`)

---

## Existing Endpoints Affected

### `PATCH /export-cases/:nxp_reference/evidence/:evidence_type`

Current behaviour: accepts `{ "action": "mark_uploaded" }` only.

RC4 change: no new action values added to this endpoint. It remains the exporter-only write path (`mark_uploaded`, `resubmit`). Reviewer and admin actions are handled by the new dedicated endpoints below. This keeps authorization straightforward — any authenticated exporter/operator can reach this endpoint; reviewer/admin actions require the separate paths with role middleware.

`resubmit` is functionally identical to `mark_uploaded` (sets `lifecycle_state = uploaded`) but applies only when the current state is `rejected`. The existing service layer in `markEvidenceUploaded` must distinguish the two to write the correct `event_type` to `evidence_events`. The request body remains `{ "action": "mark_uploaded" }` — the backend determines whether it is a first upload or a resubmit from the current state.

**Response shape:** unchanged.

### `GET /export-cases/:nxp_reference/evidence`

No request or response shape changes. The `lifecycle_state` field in each returned item will now carry additional values (`pending_review`, `validated`, `rejected`, `superseded`) once those states are reachable. Clients that switch on `lifecycle_state` must handle all ADR-012 states.

### `GET /export-cases/:nxp_reference/evidence/:evidence_type`

No shape changes. Same `lifecycle_state` caveat as above.

---

## New Endpoints

### 1. `GET /export-cases/:nxp_reference/evidence/:evidence_type/events`

Returns the complete ordered audit trail for a single evidence item.

**Authorization:** Any authenticated actor. Exporters are restricted to their own `exporter_id` by RLS and route-level tenant check. Reviewers and admins see all records within their scope.

**Request:** No body. Bearer token required.

**Response — 200:**
```json
{
  "data": [
    {
      "id": "uuid",
      "evidence_item_id": "uuid",
      "evidence_type": "credit_advice",
      "previous_lifecycle_state": "missing",
      "new_lifecycle_state": "uploaded",
      "previous_validation_status": "not_validated",
      "new_validation_status": "pending",
      "actor_user_id": "uuid | null",
      "actor_role": "exporter | reviewer | admin | system",
      "event_type": "mark_uploaded",
      "reason": "string | null",
      "created_at": "2026-06-27T23:28:27Z"
    }
  ],
  "error": null
}
```

Events are ordered `created_at ASC`. The first event will always be `event_type = system_seed` or `mark_uploaded`. `metadata` is excluded from the response by default; a future `?include=metadata` query parameter may expose it.

**Errors:** `404` if shipment or evidence item not found. `401` if unauthenticated.

---

### 2. `PATCH /export-cases/:nxp_reference/evidence/:evidence_type/submit-review`

Moves an evidence item from `uploaded` into `pending_review`, signalling that it has entered the formal review queue. This is a reviewer or admin action. In an automated future state, the system would call this transition internally after upload; for RC4 it is a manual endpoint.

**Authorization:** `reviewer`, `admin` only. Exporters receive `403`.

**Request body:**
```json
{
  "reason": "string (optional)"
}
```

**Response — 200:**
```json
{
  "data": {
    "id": "uuid",
    "evidence_type": "credit_advice",
    "lifecycle_state": "pending_review",
    "validation_status": "pending",
    "updated_at": "2026-06-27T..."
  },
  "error": null
}
```

**Allowed from states:** `uploaded` only. All other current states return `409 CONFLICT`.

**Audit event written:** `event_type = enter_review`, `actor_role = reviewer | admin`.

---

### 3. `PATCH /export-cases/:nxp_reference/evidence/:evidence_type/validate`

Marks an evidence item as validated. The document has been reviewed and confirmed accurate and complete.

**Authorization:** `reviewer`, `admin` only. Exporters receive `403`.

**Request body:**
```json
{
  "reason": "string (required for reviewer and admin)"
}
```

`reason` must be a non-empty string. Missing or empty `reason` returns `400 VALIDATION_REQUIRED`.

**Response — 200:**
```json
{
  "data": {
    "id": "uuid",
    "evidence_type": "credit_advice",
    "lifecycle_state": "validated",
    "validation_status": "passed",
    "updated_at": "2026-06-27T..."
  },
  "error": null
}
```

**Allowed from states:** `uploaded`, `pending_review`. All other current states return `409 CONFLICT`.

**Note on `uploaded → validated`:** The API intentionally permits direct validation from `uploaded` (bypassing `pending_review`). This supports reviewer workflows where a document is reviewed immediately on upload without entering a formal queue. The frontend restricts the Validate button to `pending_review` rows only as a workflow guardrail; the API does not enforce this UI restriction.

**Audit event written:** `event_type = validate`, `actor_role = reviewer | admin`.

**Side effect:** Compliance boolean sync on `validated` is **deferred out of RC4** (see RC4_DATABASE_DESIGN open question 5). The validate endpoint does not touch `compliance_records` in RC4. The sync logic must be designed as an isolated step within the transaction so it can be enabled in a follow-on migration without restructuring the query.

---

### 4. `PATCH /export-cases/:nxp_reference/evidence/:evidence_type/reject`

Marks an evidence item as rejected. The exporter must re-submit.

**Authorization:** `reviewer`, `admin` only. Exporters receive `403`.

**Request body:**
```json
{
  "reason": "string (required)"
}
```

`reason` is always required for rejections regardless of actor role. Missing or empty `reason` returns `400 VALIDATION_REQUIRED`.

**Response — 200:**
```json
{
  "data": {
    "id": "uuid",
    "evidence_type": "credit_advice",
    "lifecycle_state": "rejected",
    "validation_status": "failed",
    "updated_at": "2026-06-27T..."
  },
  "error": null
}
```

**Allowed from states:** `uploaded`, `pending_review`. All other current states return `409 CONFLICT`.

**Audit event written:** `event_type = reject`, `actor_role = reviewer | admin`.

---

### 5. `PATCH /export-cases/:nxp_reference/evidence/:evidence_type/supersede` _(admin only)_

Marks a validated item as superseded when a newer version of the same document replaces it. This endpoint is not required for the core RC4 flow but is included in the design to complete the allowed-transitions table from ADR-012.

**Authorization:** `admin` only. Reviewers and exporters receive `403`.

**Request body:**
```json
{
  "reason": "string (required)"
}
```

**Response — 200:**
```json
{
  "data": {
    "id": "uuid",
    "evidence_type": "credit_advice",
    "lifecycle_state": "superseded",
    "validation_status": "not_applicable",
    "updated_at": "2026-06-27T..."
  },
  "error": null
}
```

**Allowed from states:** `validated` only. All other states return `409 CONFLICT`.

**Audit event written:** `event_type = supersede`, `actor_role = admin`.

---

## Authorization Rules by Actor Role

| Endpoint | exporter/operator | reviewer | admin |
|---|---|---|---|
| `PATCH .../evidence/:type` (mark_uploaded / resubmit) | ✓ | ✗ 403 | ✓ |
| `GET .../evidence/:type/events` | ✓ (own records) | ✓ | ✓ |
| `PATCH .../submit-review` | ✗ 403 | ✓ | ✓ |
| `PATCH .../validate` | ✗ 403 | ✓ | ✓ |
| `PATCH .../reject` | ✗ 403 | ✓ | ✓ |
| `PATCH .../supersede` | ✗ 403 | ✗ 403 | ✓ |

Actor role is resolved by `requireRole` middleware added to the request pipeline. Role is derived from the JWT `sub` → role table lookup performed in `requireAuth` (or a second call in `requireRole` — see open question 1). The resolved role is attached to `res.locals.actorRole`. Endpoints with role restrictions pass `requireRole('reviewer', 'admin')` (or `requireRole('admin')`) as middleware before the handler. The field is consistently named `actorRole` in `res.locals`, response bodies, and the frontend variable `_actorRole`.

`/auth/me` response is extended to include `actorRole` so the frontend can gate UI elements without a separate request.

---

## State Transition Enforcement

The route handler checks `current_lifecycle_state` before applying any write. If the requested transition is not permitted by the ADR-012 allowed-transitions table, the handler returns `409 CONFLICT` immediately, before opening a DB transaction.

Enforcement is implemented in the query layer (`markEvidenceUploaded` pattern) rather than in a DB trigger, to return structured JSON errors rather than Postgres exceptions. A DB-level CHECK guard (trigger or generated column) may be added as a secondary safety net but is not the primary enforcement mechanism.

**Transition guard pseudocode:**
```
ALLOWED = {
  mark_uploaded:  { from: ['missing'] },
  resubmit:       { from: ['rejected'] },
  enter_review:   { from: ['uploaded'] },
  validate:       { from: ['uploaded', 'pending_review'] },
  reject:         { from: ['uploaded', 'pending_review'] },
  supersede:      { from: ['validated'] },
}

if current_state NOT IN ALLOWED[action].from:
  return 409 { error: INVALID_TRANSITION, currentState, allowedFrom }
```

---

## Error Model

All error responses follow the existing `{ data: null, error: "message" }` envelope. RC4 adds a structured `code` field for programmatic handling.

| Code | HTTP | Condition |
|---|---|---|
| `NOT_FOUND` | 404 | Shipment or evidence item does not exist for the authenticated exporter |
| `INVALID_TRANSITION` | 409 | Requested transition is not permitted from the current `lifecycle_state` |
| `FORBIDDEN` | 403 | Actor role is not permitted to call this endpoint |
| `VALIDATION_REQUIRED` | 400 | `reason` field is missing or empty where required |
| `INVALID_EVIDENCE_TYPE` | 400 | `evidence_type` path param not in the permitted set (existing) |
| `SYSTEM_TYPE_NOT_WRITABLE` | 400 | Attempt to write to a system-derived evidence type (existing) |
| `DB_ERROR` | 500 | Unhandled database error |

**`INVALID_TRANSITION` response body:**
```json
{
  "data": null,
  "error": "Transition not permitted: evidence_type 'credit_advice' is currently 'validated'",
  "code": "INVALID_TRANSITION",
  "currentState": "validated",
  "allowedFrom": ["uploaded", "pending_review"]
}
```

**`FORBIDDEN` response body:**
```json
{
  "data": null,
  "error": "Actor role 'exporter' is not permitted to call this endpoint",
  "code": "FORBIDDEN",
  "actorRole": "exporter"
}
```

---

## Audit Event Creation Behaviour

Every successful write to `evidence_items` via the new endpoints must produce exactly one row in `evidence_events` in the same database transaction.

Rules:
- Both writes (`UPDATE evidence_items`, `INSERT INTO evidence_events`) share a single `BEGIN … COMMIT` block in the query layer.
- `evidence_events.created_at` is set by `DEFAULT NOW()` in the DB; the API never sends a timestamp.
- `actor_user_id` is taken from `res.locals.userId` (JWT `sub`). For future system-originated events it is `null`.
- `actor_role` is taken from `res.locals.actorRole`.
- `previous_lifecycle_state` and `previous_validation_status` are read from the `evidence_items` row inside the transaction before the UPDATE (using `SELECT … FOR UPDATE` to prevent concurrent writes).
- If the `evidence_events` INSERT fails (e.g. constraint violation), the transaction rolls back and the `evidence_items` UPDATE is not committed. The API returns `500 DB_ERROR`.

No partial writes are permitted. An `evidence_items` row that changes state without a corresponding `evidence_events` row is a data integrity violation.

---

## Idempotency Considerations

| Endpoint | Idempotent? | Behaviour on repeat call |
|---|---|---|
| `PATCH .../evidence/:type` (mark_uploaded) | No | `409 CONFLICT` — item already `uploaded` (existing behaviour) |
| `PATCH .../evidence/:type` (resubmit after reject) | No | `409 CONFLICT` — item already `uploaded` |
| `PATCH .../submit-review` | No | `409 CONFLICT` — item already `pending_review` |
| `PATCH .../validate` | No | `409 CONFLICT` — item already `validated` |
| `PATCH .../reject` | No | `409 CONFLICT` — item already `rejected` |
| `PATCH .../supersede` | No | `409 CONFLICT` — item already `superseded` |
| `GET .../events` | Yes (read-only) | Returns current event list; safe to retry |

None of the write endpoints are idempotent. Callers that need retry safety must check the current state via `GET .../evidence/:type` before retrying a PATCH.

---

## Test Requirements

All tests written in the existing verify-script pattern (`tsx scripts/verify-*.ts`).

### `verify-evidence-validation-api.ts` (new)

1. `PATCH .../validate` as reviewer → 200, `lifecycle_state = validated`
2. `PATCH .../validate` missing reason → 400 `VALIDATION_REQUIRED`
3. `PATCH .../validate` as exporter → 403 `FORBIDDEN`
4. `PATCH .../validate` on already-validated item → 409 `INVALID_TRANSITION`
5. `PATCH .../reject` as reviewer with reason → 200, `lifecycle_state = rejected`
6. `PATCH .../reject` missing reason → 400 `VALIDATION_REQUIRED`
7. `PATCH .../reject` as exporter → 403 `FORBIDDEN`
8. `PATCH .../reject` on already-rejected item → 409 `INVALID_TRANSITION`
9. `PATCH .../submit-review` as reviewer → 200, `lifecycle_state = pending_review`
10. `PATCH .../submit-review` as exporter → 403 `FORBIDDEN`
11. `PATCH .../evidence/:type` (mark_uploaded) after rejection → 200, `lifecycle_state = uploaded` (resubmit path)
12. `PATCH .../supersede` as admin on validated item → 200, `lifecycle_state = superseded`
13. `PATCH .../supersede` as reviewer → 403 `FORBIDDEN`

### `verify-evidence-audit-trail.ts` (new)

1. After each transition, `GET .../events` returns one additional event
2. Events are ordered `created_at ASC`
3. `previous_lifecycle_state` on each event matches `new_lifecycle_state` of the previous event
4. `actor_role` on each event matches the role of the actor that triggered it
5. `reason` is present on validate/reject events; null on mark_uploaded events
6. `evidence_events` rows cannot be modified via the API (no UPDATE/DELETE endpoints exist)

### Regression

- `verify-mark-uploaded-api.ts` must pass without modification
- `verify-export-cases-api.ts` must pass without modification

---

## Open Questions

1. **`requireRole` middleware placement.** Should `actorRole` be resolved in `requireAuth` (one DB call resolving both `exporterId` and `actorRole`) or in a separate `requireRole` middleware (second DB call)? A single combined lookup is more efficient but couples auth and role concerns. Recommendation: extend `requireAuth` to resolve `actorRole` from `exporter_users.role` in the same query; attach to `res.locals`.

2. **`/auth/me` response extension.** RC4 Scope specifies adding `actorRole` to the `/auth/me` response so the frontend can gate UI elements. Confirm whether `actorRole` is a single value (the user's role within their primary exporter) or a map if multi-exporter is ever supported.

3. **Reviewer scope.** As noted in ADR-012 open question 1, reviewers may be scoped to a specific exporter or global. The `resolveShipmentId` helper currently validates `exporter_id` against the authenticated user's exporter. Reviewers must bypass this check (they are reviewing on behalf of, not as, the exporter). A reviewer must be able to resolve any shipment `nxp_reference`, not just those belonging to their own exporter. This changes how `resolveShipmentId` behaves for reviewer actors.

4. **`compliance_records` sync point.** RC4 Scope specifies that compliance boolean sync should move from `uploaded` to `validated`. Until this is decided, the validate endpoint should not touch `compliance_records`. If the sync change is deferred beyond RC4, the validate endpoint can write `compliance_records` updates at the point of validation without changing the mark_uploaded path. Design the compliance write as an isolated step within the transaction so it can be toggled without restructuring the query.

5. **`submit-review` automation.** If `uploaded → pending_review` is eventually auto-triggered on mark_uploaded (system actor), the `submit-review` endpoint may become internal only. Design the transition guard and event write so both the HTTP endpoint and an internal function call share the same service-layer code, to avoid duplication when automation is added.
