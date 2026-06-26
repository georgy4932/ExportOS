# ADR-011 — Evidence Source of Truth

## Status

Accepted

Accepted at release tags:

- `v0.4-evidence-mark-uploaded`
- `v0.4.1-evidence-consistent-readwrite`

---

## Context

Originally, evidence presence existed in two representations:

- `evidence_items`
- legacy boolean fields in `compliance_records`

Over time, different UI surfaces read different representations. The backend write path and the frontend rendering logic gradually diverged, producing situations where two components on the same screen could display contradictory evidence state immediately after an upload.

This ADR records the architectural decision that resolves that inconsistency.

---

## Decision

`evidence_items` is the operational source of truth for evidence presence.

Operational state transitions (for example `missing → uploaded`) are owned exclusively by `evidence_items`.

`compliance_records` remains a compatibility projection. Compatibility fields are updated transactionally by the backend during evidence state changes but are not treated as an independent writable authority.

Frontend operational workflows derive evidence presence through:

```
getEvidenceState()
```

rather than directly inspecting legacy boolean fields.

---

## Rationale

This architecture provides:

- one authoritative operational model
- transactional backend writes
- deterministic frontend rendering
- elimination of contradictory UI state
- simpler future evolution of validation workflows

It also preserves backward compatibility for existing reporting surfaces while avoiding duplicate ownership.

---

## Implementation

### v0.4 — Evidence mark_uploaded write loop

Completed:

- transactional backend write path
- `PATCH mark_uploaded`
- service-layer transaction
- compatibility boolean synchronization
- frontend upload wiring

Release tag: `v0.4-evidence-mark-uploaded`

---

### v0.4.1 — Evidence consistent read/write

Completed:

- Export Case reads migrated to `getEvidenceState()`
- Evidence Pack Workspace reads migrated
- live pack readiness
- consistent Next Required Action
- consistent Follow-Up calculations
- removal of same-screen contradictory evidence state

Release tag: `v0.4.1-evidence-consistent-readwrite`

---

## Current Architecture

**Operational flow:**

```
PATCH mark_uploaded
        │
        ▼
evidence_items
        │
   transaction
        ▼
compliance_records
```

**Operational UI:**

```
evidence_items
        │
getEvidenceState()
        │
  Export Case
Evidence Pack
Evidence Item
```

Compatibility surfaces may continue to read `compliance_records` until migrated.

---

## Consequences

**Benefits:**

- single operational authority
- transactional consistency
- simpler reasoning
- easier testing
- foundation for validation workflow

**Trade-off:**

Legacy compatibility fields remain temporarily until the remaining overview surfaces are migrated.

---

## Future Work

Remaining compatibility consumers include:

- Overview
- Work Queue
- Compliance list
- Seal modal

These may be migrated in future phases.

No future feature should introduce a second operational source of truth for evidence presence.

---

## References

Release tags:

- `v0.4-evidence-mark-uploaded`
- `v0.4.1-evidence-consistent-readwrite`

Related RFC:

- `docs/rfc-evidence-write-path.md`
