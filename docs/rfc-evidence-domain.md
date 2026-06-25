# RFC: Evidence Domain

**Status:** Draft  
**Branch:** feature/evidence-backend  
**Date:** 2026-06-25

---

## 1. Purpose

ExportOS tracks export compliance for Nigerian exporters operating under CBN foreign exchange repatriation rules. Each export case requires a fixed set of documents — NXP approval, bill of lading, CCI, payment evidence, credit advice — before a bank evidence pack can be sealed and submitted.

At present, the frontend derives evidence presence from raw boolean fields on the compliance record (`nxp_approved`, `bl_uploaded`, `cci_obtained`, etc.). These booleans carry no lifecycle state, no validation history, no timestamp, and no source attribution. They cannot express the difference between "uploaded but not yet reviewed," "reviewed and rejected," or "derived from an external system record." They also cannot be extended to support upload flows, reviewer workflows, OCR outputs, or audit logs without replacing them entirely.

The evidence domain establishes a first-class backend concept — the `evidence_item` — that gives each required document its own identity, lifecycle, and validation record. All future upload, review, validation, and reporting features build on this foundation. Without it, each feature would have to invent its own state representation, leading to inconsistency across the system.

This RFC defines evidence types, lifecycle states, validation states, the minimal data model, and the API contract the frontend will consume. It does not implement upload, storage, OCR, or review workflows; those follow after the domain is established.

---

## 2. Scope

### In scope

- Canonical list of evidence types and their properties
- Evidence lifecycle states and allowed transitions
- Validation states and how they differ from lifecycle states
- Relationship between evidence items and export cases
- Minimal backend data model (`evidence_items` table)
- API contract: three read/update endpoints
- Frontend contract: how `getEvidenceState()` evolves to read backend records

### Out of scope

- File upload implementation (multipart, presigned URL, etc.)
- Storage provider selection (S3, GCS, filesystem)
- OCR and document parsing
- Audit log schema and append-only event store
- Reviewer workflow (assignment, comments, approval queue)
- Document preview or download

These are follow-on RFCs. This RFC defines the domain they operate within.

---

## 3. Evidence Types

Seven evidence types are recognised by ExportOS. Each type maps to exactly one evidence item per export case.

| Key | Human Label | Code | Required for Compliance | Source |
|---|---|---|---|---|
| `nxp_approval` | NXP Approval | NXP | Yes | User-uploaded |
| `bill_of_lading` | Bill of Lading | BL | Yes | User-uploaded |
| `cci_document` | CCI Document | CCI | Yes | User-uploaded |
| `payment_evidence` | Payment Evidence | EVD | Yes | User-uploaded |
| `credit_advice` | Credit Advice | ADV | Yes | User-uploaded |
| `shipment_record` | Shipment Record | SHP | No | System-derived |
| `compliance_summary` | Compliance Summary | CMP | No | System-derived |

**Source definitions:**

- **User-uploaded** — the exporter or their agent uploads a file. The evidence item exists as a row from case creation; its lifecycle state begins as `missing` until a file is attached.
- **System-derived** — the record is created or confirmed by ExportOS from its own data (e.g. the shipment record is derived from the shipments table). No user upload is required; the evidence item transitions to `uploaded` automatically when the source data is present. System-derived types still appear in the evidence model as first-class rows.

The five compliance-required types are the gate for evidence pack readiness. `shipment_record` and `compliance_summary` are informational — they appear in the evidence workspace but do not block pack sealing.

---

## 4. Evidence Lifecycle

An evidence item moves through the following states. Transitions are conservative: a state can only advance forward; rejection resets to `missing` to require re-upload.

```
missing → uploaded → under_review → validated
                  ↘              ↘
                   rejected       rejected
                       ↓
                    missing
```

### States

**`missing`**  
No document has been provided. The evidence item exists as a record but has no attached file or confirmed external source. This is the initial state for all user-uploaded types. For system-derived types, `missing` indicates the source data is not yet available.

**`uploaded`**  
A document has been provided (file uploaded by user, or source data confirmed for system-derived types). The content has not been reviewed or validated. This is the state the current frontend booleans approximate — they move directly from absent to present with no intermediate states.

**`under_review`**  
The document has been submitted for validation and a review is in progress. No user action is required. This state gates the transition to `validated` or `rejected`. It will not be entered until the reviewer workflow is implemented; it is defined here so the data model accommodates it from the start.

**`validated`**  
The document has been confirmed as correct, complete, and consistent with the case record by an authorised reviewer or automated check. This is the terminal success state.

**`rejected`**  
The document was reviewed and found unacceptable (wrong document, unreadable, inconsistent data, etc.). The item returns to `missing` so the user can re-upload. The rejection reason is stored in `metadata_json`.

### Transition rules

Allowed:

- `missing` → `uploaded`: triggered by successful file attachment or source data confirmation.
- `uploaded` → `under_review`: triggered by reviewer workflow initiation (future).
- `under_review` → `validated` or `rejected`: triggered by reviewer decision (future).
- `rejected` → `missing`: automatic on rejection; clears the attached file reference.
- System-derived types skip `under_review` and transition directly from `uploaded` to `validated` once confirmed.

Explicitly disallowed:

- `missing → validated` — an item cannot be validated without first being uploaded. Any transition that skips `uploaded` is rejected.
- `missing → under_review`, `missing → rejected` — no review or rejection can occur without an uploaded document.
- Silent validation — `validation_status` cannot advance to `passed` while `lifecycle_state` is `missing`. A backend check must enforce this.
- Delete as reset — required evidence items must not be hard-deleted to reset state. Rejection (`under_review → rejected → missing`) is the only valid reset path. Soft-delete is out of scope until an audit log is introduced.

---

## 5. Validation Status

Validation status is a separate concept from lifecycle state. The two axes answer different questions:

- **Does this evidence exist?** → `lifecycle_state` (`missing` vs `uploaded` and beyond)
- **Is this evidence valid?** → `validation_status` (`not_validated`, `pending`, `passed`, `failed`)
- **Is this evidence required?** → `required_for_compliance` (a property of the type, not a state)

These three must not be collapsed. A document can exist (`uploaded`) but be unvalidated (`not_validated`). A document can be required (`required_for_compliance = true`) but absent (`missing`). A document can be present and required but have a failing validation (`failed`). Each combination is meaningful and drives different UI states and workflow actions.

Lifecycle state answers "where is this document in its journey?" Validation status answers "what do we know about its accuracy and completeness?" They are independent axes and should never be inferred from each other.

| Status | Meaning |
|---|---|
| `not_validated` | No validation has been attempted. Default state for newly uploaded documents. |
| `pending` | Validation has been initiated (e.g. OCR queued, reviewer assigned) but has not completed. |
| `passed` | Validation completed successfully. The document content matches the expected data for this case. |
| `failed` | Validation completed but the document did not pass (wrong values, mismatched references, expired dates, etc.). Does not automatically reject the lifecycle — a human decision is required. |
| `not_applicable` | Used for system-derived types where user-initiated validation does not apply. The system confirms accuracy directly. |

The frontend currently shows `validationStatus: 'Not validated'` as a hardcoded string in `getEvidenceState()`. Once backend evidence records exist, this field is read directly from the stored `validation_status` value.

---

## 6. Evidence Invariants

These invariants must hold at all times and must be enforced in application logic. They are not optional optimisations — violating any of them produces an inconsistent evidence record that cannot be trusted for compliance reporting.

1. **One current record per `(export_case_id, evidence_type)`.** The `evidence_items` table has a unique constraint on `(export_case_id, evidence_type)`. There is exactly one active evidence item per type per case at any time. History is preserved in a future audit/history table, not by adding rows to `evidence_items`.

2. **`evidence_type` is immutable after creation.** The type is set at row creation and never updated. If a user uploads the wrong document type, the correction is a replacement on the correct row, not a reclassification of an existing row.

3. **`validation_status` cannot be `passed` when `lifecycle_state` is `missing`.** An item that does not exist cannot be valid. This combination must be rejected at the application layer before any write.

4. **Required evidence must not be hard-deleted.** Rows with `required_for_compliance = true` are permanent for the life of the case. The reset path is rejection → `missing`, not deletion. If a case is fully cancelled (out of scope for this RFC), soft-deletion rules apply and are defined separately.

5. **Replacing uploaded evidence preserves prior history.** Overwriting a file reference updates the existing row but does not erase it silently. The previous state, timestamps, and metadata must be captured in a future `evidence_item_history` table before the replacement is written. Until that table exists, the `updated_at` timestamp and `metadata_json` field serve as a minimal record.

6. **Lifecycle state and validation status are separate axes.** No code should infer one from the other. `lifecycle_state = 'validated'` does not imply `validation_status = 'passed'` (a reviewer may validate the lifecycle without the document content passing automated checks). `validation_status = 'failed'` does not imply `lifecycle_state = 'rejected'` (a human decision is required).

7. **System-derived evidence appears in the evidence model as rows.** `shipment_record` and `compliance_summary` are not special-cased in the API or frontend. They are evidence items with `source_system = 'system'` and `validation_status = 'not_applicable'`. The evidence workspace renders them identically to user-uploaded types, with the source surfaced as a display property.

---

## 7. Data Model Draft

### Identity decision

Database relationships use `export_case_id` (a surrogate UUID) as the foreign key. The `nxp_reference` string is denormalised onto the row for API exposure and display, but all joins and constraints use the internal ID.

Rationale: `nxp_reference` is issued by the CBN and its format, stability, and correction behaviour are outside ExportOS's control. Using it as a join key risks cascading updates if a reference is corrected or reissued. The public API continues to accept and expose `nxp_reference` in URL paths and response bodies; the backend resolves it to `export_case_id` at the controller layer.

This decision is not open to re-evaluation during implementation. See §10 for the gate on this.

### Schema mapping: Export Case → `shipments`

In the current ExportOS schema there is no `export_cases` table. The Export Case aggregate is represented by the `shipments` table, which the schema explicitly designates as the regulatory unit — each shipment has its own NXP reference, bill of lading date, compliance clock, payment allocation, and evidence pack. Consequently, `export_case_id` in this RFC maps to `shipment_id` in the implementation; the migration uses `shipment_id UUID NOT NULL REFERENCES shipments(id)` and the UNIQUE constraint is `(shipment_id, evidence_type)`.

This mapping is intentional and architecturally correct for the current product. A dedicated `export_cases` table should only be introduced if a future regulatory requirement needs to group multiple partial shipments under a single regulatory case. Until that need arises, adding the table would create an identity layer that maps 1:1 with `shipments` in every real use case, adding join cost with no structural benefit.

### Table: `evidence_items`

One row per evidence type per export case. Rows are created at case creation time for all known types; they begin in `missing` / `not_validated` state.

```sql
CREATE TABLE evidence_items (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  export_case_id          UUID NOT NULL REFERENCES export_cases(id),
  nxp_reference           TEXT NOT NULL,  -- denormalised; do not join on this field
  evidence_type           TEXT NOT NULL,
  evidence_code           TEXT NOT NULL,
  lifecycle_state         TEXT NOT NULL DEFAULT 'missing',
  validation_status       TEXT NOT NULL DEFAULT 'not_validated',
  required_for_compliance BOOLEAN NOT NULL DEFAULT TRUE,
  uploaded_at             TIMESTAMPTZ,
  last_checked_at         TIMESTAMPTZ,
  source_system           TEXT NOT NULL DEFAULT 'user',
  metadata_json           JSONB,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (export_case_id, evidence_type)
);
```

**Field notes:**

- `export_case_id` — foreign key to the export cases table. Primary relationship key; all joins use this.
- `nxp_reference` — denormalised copy of the CBN reference for API responses and display. Kept in sync with the case record; never used as a join key inside the database.
- `evidence_type` — one of the seven keys defined in §3. Immutable after creation (see §6, invariant 2).
- `evidence_code` — denormalised short code (NXP, BL, CCI, etc.) for display without lookup.
- `lifecycle_state` — constrained to values in §4: `missing`, `uploaded`, `under_review`, `validated`, `rejected`.
- `validation_status` — constrained to values in §5: `not_validated`, `pending`, `passed`, `failed`, `not_applicable`.
- `required_for_compliance` — seeded from the type definition; can be overridden per-case if compliance rules evolve.
- `uploaded_at` — set when lifecycle transitions to `uploaded`; cleared on rejection.
- `last_checked_at` — set whenever validation status is updated.
- `source_system` — `'user'` for uploaded types, `'system'` for derived types.
- `metadata_json` — unstructured field for rejection reasons, OCR outputs, reviewer notes, and other per-item data that does not warrant dedicated columns yet.

**Constraints to enforce in application logic (not DDL):**

- `lifecycle_state` transitions follow the allowed rules in §4; disallowed transitions (including `missing → validated`) are rejected before write.
- `validation_status` cannot be `passed` when `lifecycle_state` is `missing` (see §6, invariant 3).
- `validation_status` is `not_applicable` for all system-derived types.
- `uploaded_at` must be non-null when `lifecycle_state` is `uploaded`, `under_review`, or `validated`.

---

## 8. API Draft

Three endpoints cover the minimum the frontend needs. No upload endpoint is included in this RFC. GET endpoints must be implemented and validated before PATCH behaviour is finalised.

### `GET /export-cases/{nxp_reference}/evidence`

Returns all evidence items for a case in a single response. The `{nxp_reference}` path parameter is resolved to `export_case_id` at the controller layer.

```json
{
  "nxp_reference": "NXP/CBN/2026/001",
  "evidence": [
    {
      "evidence_type": "nxp_approval",
      "evidence_code": "NXP",
      "lifecycle_state": "uploaded",
      "validation_status": "not_validated",
      "required_for_compliance": true,
      "uploaded_at": "2026-05-10T09:14:00Z",
      "last_checked_at": null,
      "source_system": "user"
    },
    {
      "evidence_type": "cci_document",
      "evidence_code": "CCI",
      "lifecycle_state": "missing",
      "validation_status": "not_validated",
      "required_for_compliance": true,
      "uploaded_at": null,
      "last_checked_at": null,
      "source_system": "user"
    }
  ]
}
```

Used by the Evidence Pack Workspace to populate all items in a single fetch.

### `GET /export-cases/{nxp_reference}/evidence/{evidence_type}`

Returns the evidence item for a single type. Used by the Evidence Item detail view when opening a specific document.

```json
{
  "nxp_reference": "NXP/CBN/2026/001",
  "evidence_type": "nxp_approval",
  "evidence_code": "NXP",
  "lifecycle_state": "uploaded",
  "validation_status": "not_validated",
  "required_for_compliance": true,
  "uploaded_at": "2026-05-10T09:14:00Z",
  "last_checked_at": null,
  "source_system": "user",
  "metadata_json": null
}
```

### `PATCH /export-cases/{nxp_reference}/evidence/{evidence_type}`

Updates the lifecycle state or validation status of an evidence item. The request body contains only the fields being changed. Transitions are validated server-side against the rules in §4 and §5, including the disallowed transitions defined in §4 and the invariants in §6.

Request:
```json
{
  "lifecycle_state": "uploaded"
}
```

Response: the updated evidence item (same shape as the GET single response).

Invalid transitions return `422 Unprocessable Entity` with an error body naming the rejected transition and the reason. PATCH behaviour must not be finalised or implemented until the GET endpoints have been validated against a live backend (see §10).

---

## 9. Frontend Contract

The current frontend helper in `public/app/index.html`:

```javascript
function getEvidenceState(caseRecord, evidenceType, shipRecord) {
  var present;
  switch (evidenceType) {
    case 'nxp_approval':     present = !!caseRecord.nxp_approved;              break;
    case 'bill_of_lading':   present = !!caseRecord.bl_uploaded;               break;
    case 'cci_document':     present = !!caseRecord.cci_obtained;              break;
    case 'payment_evidence': present = !!caseRecord.payment_evidence_uploaded; break;
    case 'credit_advice':    present = !!caseRecord.credit_advice_confirmed;   break;
    // ...
  }
  var state = present ? 'uploaded' : 'missing';
  return {
    state:            state,
    validationStatus: 'Not validated',   // hardcoded
    lastChecked:      'Unavailable',     // hardcoded
  };
}
```

This function is the seam the backend plugs into. No other part of the frontend contains evidence state logic — it is the single call site contract established by the R1 and R2 refactors.

**Migration path:**

1. **Boolean fields remain during migration.** The compliance API response continues to include `nxp_approved`, `bl_uploaded`, etc. alongside case data for the duration of the transition. No frontend screen should break during the cutover.

2. **Backend records become source of truth when present.** When `GET /export-cases/{nxp_reference}/evidence` is live, the frontend fetches evidence items per case on case open and caches them in a `_evidenceItems` map keyed by `nxp_reference`.

3. **`getEvidenceState()` uses backend records first, boolean fallback second.** The function is updated to look up `_evidenceItems[caseRecord.nxp_reference]?.[evidenceType]` first. If a backend record is found, its `lifecycle_state` and `validation_status` are returned directly. If no backend record is found (case not yet migrated), the existing boolean fallback applies. All callers pick up backend data automatically — no screen-level changes are required.

4. **The fallback is temporary and must be removed.** Once all cases have evidence rows and all clients consume the evidence endpoint, the boolean switch inside `getEvidenceState()` is deleted and the boolean fields are removed from the compliance API response. This removal should be treated as a migration milestone, not left as permanent dead code.

---

## 10. Backend Implementation Gate

Backend implementation must not begin until the following decisions are accepted in writing (approval of this RFC constitutes acceptance):

- **Identity decision accepted** — `export_case_id` UUID is the database relationship key; `nxp_reference` is denormalised for API exposure only. This is resolved and not open during implementation.
- **Invariants accepted** — all seven invariants in §6 are enforced in application logic from day one, not added later.
- **Lifecycle transitions accepted** — the allowed and disallowed transitions in §4 are implemented as a state machine in the backend. No transition outside the allowed set reaches the database.
- **GET endpoints agreed before PATCH** — `GET /export-cases/{nxp_reference}/evidence` and `GET /export-cases/{nxp_reference}/evidence/{evidence_type}` are implemented, deployed, and validated against real data before PATCH behaviour is finalised or shipped.

If any of the above is not accepted, implementation stops and the RFC is revised before proceeding.

---

## 11. Recommendation

The smallest viable next step after RFC approval is:

1. **Create the `evidence_items` table** as specified in §7, with `export_case_id` as the FK, `nxp_reference` denormalised, and the UNIQUE constraint on `(export_case_id, evidence_type)`. Apply as a migration.

2. **Seed evidence rows at case creation.** When a compliance record is created, insert one row per evidence type (all seven) with `lifecycle_state = 'missing'`. For system-derived types, immediately check whether the source data exists and advance to `uploaded` if so.

3. **Implement `GET /export-cases/{nxp_reference}/evidence`** only. This is the one endpoint the frontend needs to begin consuming real evidence state. The PATCH and single-item GET endpoints follow once the list endpoint is validated (see §10).

4. **Update `getEvidenceState()` to read from the evidence endpoint** with the boolean fallback retained during the transition period. Schedule a milestone to remove the fallback once migration is complete.

This sequence delivers a working evidence domain without implementing upload, review, or validation logic. It replaces the boolean fields as the source of truth for evidence state and establishes the API contract all future evidence features build on.
