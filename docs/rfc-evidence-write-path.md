# RFC: Evidence Write Path — Phase W0 Design

**Status:** Draft — awaiting approval before implementation  
**Date:** 2026-06-25  
**Scope:** `evidence_items` write path only — no file storage, no UI redesign

---

## 1. Purpose

The read model (`evidence_items` + `_evidenceCache` + `getEvidenceState()`) is now in place. Before any upload or PATCH work begins, this document defines the write-path contract: which transitions are allowed, who owns document-presence state, how legacy boolean fields are kept consistent, and what the smallest safe W1 endpoint looks like.

Defining ownership and invariants here prevents a class of bugs where `evidence_items` and `compliance_records` boolean fields diverge silently and the UI renders different answers depending on which source `getEvidenceState()` falls back to.

---

## 2. Scope

### In scope

- Document presence state (`lifecycle_state`: `missing` → `uploaded`)
- Ownership rule between `evidence_items` and legacy `compliance_records` booleans
- API shape for a single PATCH endpoint (Phase W1)
- Backend invariants that must be enforced at the service layer
- Migration path for existing boolean data
- Frontend integration contract (re-fetch, no fake local state)

### Out of scope

- File storage, S3/object keys, presigned URLs
- Document viewer / inline preview
- OCR or automated extraction
- Validation / reviewer workflow (`under_review → validated / rejected`)
- Audit history table implementation
- UI redesign — Upload buttons retain their existing appearance

---

## 3. Ownership Rule

**`evidence_items` is the single source of truth for document presence.**

`compliance_records` boolean fields (`nxp_approved`, `bl_uploaded`, `cci_obtained`, `payment_evidence_uploaded`, `credit_advice_confirmed`) become derived compatibility fields. They exist for:
- backward compatibility with Overview / Work Queue / Deadlines views that load before a case is opened (cache is empty at that point)
- any reporting queries that predate the evidence domain

**The invariant:** only `evidence_items` is written directly. Boolean fields are derived from it. The two are never treated as independent writable sources.

---

## 4. First Transition

Phase W1 supports exactly one lifecycle transition:

```
missing → uploaded
```

No other transitions are in scope for W1. Existing rows with non-`missing` states (e.g. `under_review`, `validated`, `rejected`) are preserved as-is; the endpoint must reject attempts to overwrite them.

Reverse transitions (`uploaded → missing`) are forbidden — evidence items are never soft-deleted or demoted through the API in W1.

Forward transitions beyond `uploaded` (`→ under_review → validated / rejected`) belong to the future validation/reviewer workflow and are explicitly out of scope.

---

## 5. Legacy Boolean Synchronisation

### Direction

One-way only: write `evidence_items` first, then derive and update the corresponding `compliance_records` boolean.

Never update the boolean first and infer `evidence_items` state later.

### Field map

| `evidence_items.evidence_type` | `compliance_records` boolean field |
|---|---|
| `nxp_approval` | `nxp_approved` |
| `bill_of_lading` | `bl_uploaded` |
| `cci_document` | `cci_obtained` |
| `payment_evidence` | `payment_evidence_uploaded` |
| `credit_advice` | `credit_advice_confirmed` |

System-derived types (`shipment_record`, `compliance_summary`) have no corresponding boolean field and are not affected by this sync.

### Sync mechanism — W1 decision: service-layer transaction

The PATCH handler updates both `evidence_items` and the derived `compliance_records` boolean in a single `BEGIN / COMMIT` transaction at the service layer.

**Rationale:**
- W1 exposes a named business action (`mark_uploaded`); the service layer should own orchestration of the business effect, not a hidden DB trigger.
- Cross-table compatibility writes must be explicit and testable in isolation.
- DB triggers remain reserved for structural invariants and seeding (e.g. `trg_evidence_state_consistency`, `trg_compliance_record_seeds_evidence`) — not for business workflow orchestration.
- Service-layer ownership keeps future upload, validation, and audit behaviour easier to reason about and extend.

---

## 6. API Draft

### Endpoint

```
PATCH /export-cases/:nxp_reference/evidence/:evidence_type
```

Auth: `requireAuth` middleware — `exporterId` bound from JWT (same pattern as all existing routes).

### Request body (W1)

```json
{ "action": "mark_uploaded" }
```

Using a named action rather than raw `lifecycle_state` in the body:
- prevents callers from writing arbitrary states
- makes the contract explicit and extensible (future actions: `mark_under_review`, etc.)
- avoids exposing the internal state machine directly to the API surface

### Behaviour

1. Validate `evidence_type` against the 7-item whitelist.
2. Resolve `nxp_reference` → `shipment_id` for the authenticated `exporterId` (reuse `resolveShipmentId`).
3. Fetch the current `evidence_items` row.
4. Reject if `lifecycle_state` is already `uploaded` (idempotent — return 200 or 409; TBD).
5. Reject if `lifecycle_state` is anything other than `missing` (W1 does not allow overwriting `under_review` / `validated` / `rejected`).
6. Update `evidence_items`: set `lifecycle_state = 'uploaded'`, `uploaded_at = NOW()` (if currently `NULL`), `validation_status = 'pending'`.
7. In the same transaction: update the corresponding `compliance_records` boolean to `true` (see §5 sync decision).
8. Return updated row.

### Response

```json
{
  "data": { /* updated evidence_items row */ },
  "error": null
}
```

### Forbidden in W1

- `uploaded → missing` (reversal)
- `uploaded → validated` (skipping review)
- Writing `validation_status` directly from the client
- Deleting evidence items
- File upload payloads (multipart/form-data) — W1 is metadata-only

---

## 7. Backend Invariants

These must be enforced at the service layer (and reinforced by existing DB constraints where possible):

| Invariant | Enforcement |
|---|---|
| `evidence_type` must be one of the 7 valid values | Route-level validation (same whitelist as existing GET routes); DB `CHECK` constraint as backstop |
| Request must be scoped to the authenticated exporter | `resolveShipmentId(nxpRef, exporterId)` — returns null if shipment belongs to another tenant; route returns 404 |
| `required_for_compliance` rows cannot be deleted | No DELETE endpoint in W1; guard at service layer if DELETE is ever added |
| `validation_status = 'passed'` cannot coexist with `lifecycle_state = 'missing'` | Existing DB trigger `trg_evidence_state_consistency` enforces this; service layer must not produce this combination |
| `uploaded_at` must be set when `lifecycle_state = 'uploaded'` | Service layer sets `uploaded_at = NOW()` on transition; never leaves it NULL for uploaded rows |
| `lifecycle_state` and `validation_status` are separate axes | W1 sets `validation_status = 'pending'` on upload; never conflates the two fields |
| System-derived rows (`source_system = 'system'`) are not writable via user-facing PATCH | Service layer checks `source_system`; rejects with 403 if caller attempts to write `shipment_record` or `compliance_summary` |

---

## 8. Frontend Impact

### Upload button behaviour

Existing Upload buttons (currently no-ops or stub handlers) should, after W1 is available:
1. Call `PATCH /export-cases/:nxp_reference/evidence/:evidence_type` with `{ "action": "mark_uploaded" }`.
2. On success: call `fetchEvidenceItems(nxpRef)` to replace the stale cache entry with the server's response.
3. On error: surface the error; do not mutate local state.

**No optimistic/fake local state.** The UI must not set `_evidenceCache` entries locally before the PATCH response arrives. `getEvidenceState()` reads from cache; fake cache entries would render incorrect state if the server rejects the write.

### Re-fetch

`fetchEvidenceItems(nxpRef)` already performs a full cache replace for the given NXP reference. Calling it after a successful PATCH is sufficient to update all evidence display surfaces without a page reload.

---

## 9. Risks / Open Questions

**Q1 — Should system-derived rows be writable?**  
`shipment_record` and `compliance_summary` are seeded at `lifecycle_state = 'uploaded'` by the DB trigger. Making them writable via PATCH risks callers resetting them to `missing`. Recommendation: guard at service layer (see §7 invariant).

**Q2 — Named action vs. raw `lifecycle_state` in PATCH body**  
`{ "action": "mark_uploaded" }` vs. `{ "lifecycle_state": "uploaded" }`. Named action wins for W1 (explicit contract, safe extension surface). Raw field exposure risks callers writing `under_review` or `validated` before the validation workflow exists.

**Recorded decision — Sync mechanism: service-layer transaction** (resolved, see §5)  
DB trigger approach was considered and rejected. The PATCH handler owns both writes in a single transaction. Rationale documented in §5.

**Q3 — Backfilling existing boolean data into `evidence_items`**  
Demo / legacy shipments have `compliance_records` booleans set to `true` but `evidence_items` rows at `lifecycle_state = 'missing'` (seeded by the trigger chain). If W1 ships without a backfill, `getEvidenceState()` will show `missing` for evidence that the legacy booleans say is present. A one-off migration script (`UPDATE evidence_items SET lifecycle_state='uploaded', uploaded_at=NOW() WHERE shipment_id IN (SELECT shipment_id FROM compliance_records WHERE nxp_approved = true) AND evidence_type = 'nxp_approval'` etc.) should be written before W1 goes to a real database. Not needed for the mock-data demo environment.

---

## 10. Recommendation

**Smallest safe W1 implementation:**

1. Add `PATCH /export-cases/:nxp_reference/evidence/:evidence_type` to `src/api/routes/export-cases.ts`.
2. Accept `{ "action": "mark_uploaded" }` only.
3. Implement sync via **service-layer transaction** — both `evidence_items` and the derived `compliance_records` boolean updated in one `BEGIN / COMMIT` (see §5).
4. Enforce all invariants in §7 at the route handler.
5. Do not implement file upload, validation transitions, or audit history in W1.
6. Write a backfill migration for legacy boolean data before any real-database deployment.
7. Frontend: wire the stub Upload button for one evidence type as a proof-of-concept after W1 route is confirmed working.

This keeps the blast radius small: one new route, one new service function, one transaction. Everything else (`_evidenceCache`, `getEvidenceState()`, display surfaces) already handles the updated state correctly once the re-fetch fires.
