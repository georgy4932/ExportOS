# ADR-012 — Evidence Validation Lifecycle

**Status:** Proposed
**Date:** 2026-06-27

## Context

RC3 completed the write path for evidence upload: operators can mark an evidence item as `uploaded` via the PATCH endpoint and the UI reflects the change. The `evidence_items` table currently carries two state fields:

- `lifecycle_state` — operational presence of the document (`missing`, `uploaded`)
- `validation_status` — accuracy/authenticity of the document (`not_validated`, `pending`, `not_applicable`)

Neither field is sufficient on its own to express the full validation lifecycle that a document must pass through before an export case can be considered compliant. There is no concept of reviewer action, rejection, supersession, or immutable audit history. Before implementing any of these, the state model and actor boundaries must be formally agreed.

## Decision

Extend the evidence lifecycle into a defined set of states with explicit allowed transitions, a named actor model, and a mandatory audit trail. The current `evidence_items` table remains the source of truth for current state. A future `evidence_events` table (not part of RC4 schema) will hold immutable transition history.

## Evidence Lifecycle States

| State | Meaning |
|---|---|
| `missing` | No document has been submitted. Initial state for all user-facing evidence types. |
| `uploaded` | The exporter has asserted the document exists. Content not yet reviewed. |
| `pending_review` | A reviewer has been assigned or the document has entered the review queue. |
| `validated` | A reviewer has confirmed the document is accurate and complete. Terminal positive state. |
| `rejected` | A reviewer has found the document unacceptable. Exporter must re-submit. |
| `superseded` | A newer version of the document has been accepted; this version is retained for audit but is no longer active. |

System-derived types (`shipment_record`, `compliance_summary`) are seeded directly to `uploaded` with `validation_status = not_applicable` and do not participate in the review lifecycle.

## Allowed Transitions

| From | To | Actor | Condition |
|---|---|---|---|
| `missing` | `uploaded` | exporter/operator | Document submitted via mark_uploaded |
| `uploaded` | `pending_review` | system / reviewer | Review queue assignment |
| `uploaded` | `rejected` | reviewer | Immediate rejection without full review |
| `pending_review` | `validated` | reviewer | Document confirmed accurate and complete |
| `pending_review` | `rejected` | reviewer | Document found unacceptable |
| `rejected` | `uploaded` | exporter/operator | Exporter re-submits after rejection |
| `validated` | `superseded` | admin / system | Newer version accepted for same evidence type |
| Any | `superseded` | admin | Manual supersession by administrator |

Transitions not listed in this table are not permitted. An attempt to transition outside this set must return a `409 CONFLICT` with the current state included in the response body.

## Actor Model

| Actor | Role |
|---|---|
| `exporter` / `operator` | Submits documents; re-submits after rejection. Cannot validate or reject their own submissions. |
| `reviewer` | Inspects uploaded documents; moves items to `validated` or `rejected`. Cannot submit documents. |
| `admin` | Can perform any transition including supersession and manual corrections. Requires explicit audit note. |
| `system` | Automated transitions triggered by platform events (queue assignment, cascade on new B/L, etc.). Actor recorded as `system` with the triggering event name as the reason. |

Actor identity is resolved from the JWT `sub` claim and the `exporter_users` / `reviewer_users` role tables (reviewer and admin roles are not yet modelled in the schema — this is an open question).

## Audit Requirements

Every lifecycle transition must produce an audit record. No transition may be committed without a corresponding audit entry in the same database transaction.

Each audit record must capture:

| Field | Required | Notes |
|---|---|---|
| `evidence_item_id` | yes | FK to `evidence_items.id` |
| `previous_state` | yes | `lifecycle_state` before the transition |
| `new_state` | yes | `lifecycle_state` after the transition |
| `actor_type` | yes | One of: `exporter`, `reviewer`, `admin`, `system` |
| `actor_id` | yes | UUID of the acting user or `null` for system |
| `occurred_at` | yes | Transaction timestamp; set by the database, not the caller |
| `reason` | conditional | Required when actor is `reviewer` or `admin`; optional for `exporter` and `system` |
| `note` | optional | Free-text annotation; stored but not surfaced in UI by default |

Audit records are append-only. No audit record may be updated or deleted. Access to the audit log requires `admin` actor role.

## Current Snapshot vs Append-Only History

**`evidence_items` (current state — exists)**
Holds exactly one row per `(shipment_id, evidence_type)`. Updated in-place on every transition. This is the authoritative current state for all read paths, the compliance check, and the UI. Foreign key constraints and the `lifecycle_state` CHECK constraint enforce structural integrity.

**`evidence_events` (immutable history — future table, not RC4)**
Will hold one row per transition, in insertion order. Never updated or deleted. Provides the full audit trail for a given `evidence_item_id`. Schema, indexes, and RLS policy are deferred to the sprint that implements reviewer actions. The table name and column list defined here serve as the agreed interface contract.

These two tables together give a current-state-plus-history model identical in principle to the event sourcing pattern, without requiring full event sourcing of the rest of the schema.

## Out of Scope for RC4

The following are explicitly excluded from the RC4 implementation:

- **OCR / automated content extraction** — document contents are not parsed
- **AI validation** — no model-assisted review of document accuracy
- **External storage changes** — file storage integration is not part of ExportOS v0.2; this ADR governs metadata state only
- **Notifications** — email or in-app alerts on state transitions are deferred
- **Government / CBN integrations** — no submission to regulatory systems as part of this lifecycle
- **Reviewer and admin role schema** — the actor model is defined here but the `reviewer_users` table and role-based middleware are deferred
- **`evidence_events` table creation** — the schema is described above as a contract; the migration is deferred

## Consequences

**Positive**
- Transitions are explicit and enumerable; the frontend can derive the set of available actions from the current state without additional API calls.
- The audit requirement is defined before any code exists, preventing retroactive addition of incomplete records.
- Supersession allows document replacement without losing history.
- Reviewer and exporter roles are kept strictly separate from the start.

**Negative**
- Adding `pending_review` as a distinct state requires a reviewer assignment mechanism that does not yet exist. Until reviewer infrastructure exists, items will move directly from `uploaded` to `validated` or `rejected`.
- The two-table model (current + history) requires both to be written in the same transaction on every transition. If `evidence_events` does not exist yet, the transition must be deferred until the table is present.

## Open Questions

1. **Reviewer role storage:** Should reviewer identity live in `exporter_users` with a `role` discriminator, or in a separate `reviewer_users` table? The latter is cleaner but adds schema complexity.

2. **Multi-reviewer consensus:** Does validation require a single reviewer sign-off or a quorum? Not defined here; deferred to reviewer workflow design.

3. **Rejection re-upload:** When an exporter re-submits after rejection, should the rejected item move back to `uploaded` in-place (current proposal) or should a new `evidence_items` row be created and the old one marked `superseded`? The in-place approach is simpler but loses the rejected document reference unless `evidence_events` is present.

4. **`pending_review` automation:** What event triggers the `uploaded → pending_review` transition — a reviewer claiming the item, a scheduled job, or a manual admin action? This determines whether the transition is actor-driven or system-driven.

5. **Deadline enforcement:** The `evidence_items` table has no deadline field. Compliance deadlines live on `bills_of_lading`. Should deadline breach produce a synthetic state (e.g. `overdue`) or remain an external computed property?

6. **`validated` immutability:** Should a `validated` item ever be re-opened without going through `superseded`? Current proposal says no — `validated` is terminal unless explicitly superseded by an admin.
