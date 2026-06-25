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
- **System-derived** — the record is created or confirmed by ExportOS from its own data (e.g. the shipment record is derived from the shipments table). No user upload is required; the evidence item transitions to `uploaded` automatically when the source data is present.

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

- `missing` → `uploaded`: triggered by successful file attachment or source data confirmation.
- `uploaded` → `under_review`: triggered by reviewer workflow initiation (future).
- `under_review` → `validated` or `rejected`: triggered by reviewer decision (future).
- `rejected` → `missing`: automatic on rejection; clears the attached file reference.
- No backward transitions except via rejection.
- System-derived types (`shipment_record`, `compliance_summary`) skip `under_review` and transition directly from `uploaded` to `validated` once confirmed.

---

## 5. Validation Status

Validation status is a separate concept from lifecycle state. Lifecycle state answers "where is this document in its journey?" Validation status answers "what do we know about its accuracy and completeness?"

A document can be `uploaded` (lifecycle) but `pending` (validation) — it arrived but has not been checked. It can be `validated` (lifecycle) and `passed` (validation) — fully confirmed. These two axes are independent and should not be collapsed.

| Status | Meaning |
|---|---|
| `not_validated` | No validation has been attempted. Default state for newly uploaded documents. |
| `pending` | Validation has been initiated (e.g. OCR queued, reviewer assigned) but has not completed. |
| `passed` | Validation completed successfully. The document content matches the expected data for this case. |
| `failed` | Validation completed but the document did not pass (wrong values, mismatched references, expired dates, etc.). Does not automatically reject the lifecycle — a human decision is required. |
| `not_applicable` | Used for system-derived types where user-initiated validation does not apply. The system confirms accuracy directly. |

The frontend currently shows `validationStatus: 'Not validated'` as a hardcoded string in `getEvidenceState()`. Once backend evidence records exist, this field is read directly from the stored `validation_status` value.

---

## 6. Data Model Draft

### Table: `evidence_items`

One row per evidence type per export case. Rows are created at case creation time for all known types; they begin in `missing` / `not_validated` state.

```sql
CREATE TABLE evidence_items (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nxp_reference         TEXT NOT NULL,
  evidence_type         TEXT NOT NULL,
  evidence_code         TEXT NOT NULL,
  lifecycle_state       TEXT NOT NULL DEFAULT 'missing',
  validation_status     TEXT NOT NULL DEFAULT 'not_validated',
  required_for_compliance BOOLEAN NOT NULL DEFAULT TRUE,
  uploaded_at           TIMESTAMPTZ,
  last_checked_at       TIMESTAMPTZ,
  source_system         TEXT NOT NULL DEFAULT 'user',
  metadata_json         JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (nxp_reference, evidence_type)
);
```

**Field notes:**

- `nxp_reference` — foreign key to the export case, using the CBN reference as the join key. See Open Questions §9 for risks.
- `evidence_type` — one of the seven keys defined in §3.
- `evidence_code` — denormalised short code (NXP, BL, CCI, etc.) for display without lookup.
- `lifecycle_state` — constrained to values in §4: `missing`, `uploaded`, `under_review`, `validated`, `rejected`.
- `validation_status` — constrained to values in §5: `not_validated`, `pending`, `passed`, `failed`, `not_applicable`.
- `required_for_compliance` — seeded from the type definition; can be overridden per-case if compliance rules evolve.
- `uploaded_at` — set when lifecycle transitions to `uploaded`; cleared on rejection.
- `last_checked_at` — set whenever validation status is updated.
- `source_system` — `'user'` for uploaded types, `'system'` for derived types.
- `metadata_json` — unstructured field for rejection reasons, OCR outputs, reviewer notes, and other per-item data that does not warrant dedicated columns yet.

**Constraints to enforce in application logic (not DDL):**

- `lifecycle_state` transitions follow the rules in §4.
- `validation_status` is `not_applicable` for all system-derived types.
- `uploaded_at` must be non-null when `lifecycle_state` is `uploaded`, `under_review`, or `validated`.

---

## 7. API Draft

Three endpoints cover the minimum the frontend needs. No upload endpoint is included in this RFC.

### `GET /export-cases/{nxp_reference}/evidence`

Returns all evidence items for a case in a single response.

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

Updates the lifecycle state or validation status of an evidence item. The request body contains only the fields being changed. Transitions are validated server-side against the rules in §4 and §5.

Request:
```json
{
  "lifecycle_state": "uploaded"
}
```

Response: the updated evidence item (same shape as the GET single response).

Invalid transitions return `422 Unprocessable Entity` with an error body describing the rejected transition.

---

## 8. Frontend Contract

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

1. The compliance API response currently includes boolean fields (`nxp_approved`, `bl_uploaded`, etc.) alongside case data. The backend should continue to include these during the transition period so existing screens do not break.

2. When the `GET /export-cases/{nxp_reference}/evidence` endpoint is live, the frontend fetches evidence items per case on case open and caches them in a `_evidenceItems` map keyed by `nxp_reference`.

3. `getEvidenceState(caseRecord, evidenceType, shipRecord)` is updated to look up `_evidenceItems[caseRecord.nxp_reference]?.[evidenceType]` first. If a backend record is found, its `lifecycle_state` and `validation_status` are returned directly. If not found (during the transition), the existing boolean fallback remains.

4. Once all clients consume the evidence endpoint, the boolean fields are deprecated from the compliance response and eventually removed.

This approach means no frontend screen changes are required at migration time — only `getEvidenceState()` itself changes, and all callers pick up the backend data automatically.

---

## 9. Risks and Open Questions

**1. Is `nxp_reference` stable enough as a foreign key?**  
The NXP reference is issued by the CBN and used as the primary identifier throughout ExportOS. It appears in compliance records, shipment records, and evidence items. However, it is a string assigned by an external authority: format changes, re-issuance, or correction procedures could make it unstable as a join key. Risk is low given the current scale, but the data model should eventually introduce a surrogate `export_case_id` UUID if the system grows. For this RFC, `nxp_reference` is acceptable.

**2. Should evidence records be generated at case creation?**  
Yes. Evidence items for all seven types should be created as rows with `lifecycle_state = 'missing'` when an export case is first registered. This makes the "what is outstanding" query straightforward (filter by `lifecycle_state = 'missing' AND required_for_compliance = true`) and avoids the need to infer missing evidence from absent rows. Absent rows are ambiguous: does a missing row mean the evidence doesn't exist, or that it was never initialised?

**3. How should system-derived evidence be represented?**  
`shipment_record` and `compliance_summary` have `source_system = 'system'` and `validation_status = 'not_applicable'`. Their `lifecycle_state` should be set to `uploaded` automatically when the underlying source data exists (i.e. a shipment row is linked to the case). A background job or trigger handles this transition; no user action is required. These types should never appear in an upload prompt.

**4. How does validation differ from user upload?**  
Upload is a user action: the user provides a file. Validation is a system or reviewer action: a check confirms the file's content is correct. A file can be uploaded but invalid (wrong document type, unreadable scan, mismatched reference numbers). Treating these as a single boolean — as the current system does — collapses two independent concerns. Keeping them separate allows the system to prompt the user for a re-upload without discarding the validation history.

**5. Should missing required evidence exist as rows or be inferred?**  
As rows (see question 2). Inferring missing evidence from the type list at read time is simpler to implement initially but produces inconsistent query behaviour: some evidence queries hit the database, others are computed in application code. A row per type per case keeps the query surface uniform and allows attaching timestamps, metadata, and history to the "missing" state itself.

---

## 10. Recommendation

The smallest viable next step after RFC approval is:

1. **Create the `evidence_items` table** as specified in §6, with `nxp_reference`, `evidence_type`, `lifecycle_state`, `validation_status`, and the remaining fields. Apply as a migration.

2. **Seed evidence rows at case creation.** When a compliance record is created, insert one row per evidence type (all seven) with `lifecycle_state = 'missing'`. For system-derived types, immediately check whether the source data exists and advance to `uploaded` if so.

3. **Implement `GET /export-cases/{nxp_reference}/evidence`** only. This is the one endpoint the frontend needs to begin consuming real evidence state. The PATCH and single-item GET endpoints can follow once the list endpoint is validated.

4. **Update `getEvidenceState()` to read from the evidence endpoint** with the boolean fallback retained during the transition period.

This sequence delivers a working evidence domain without implementing upload, review, or validation logic. It replaces the boolean fields as the source of truth for evidence state and establishes the API contract all future evidence features build on.
