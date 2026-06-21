-- Fix enforce_pack_sealing_preconditions trigger function.
--
-- The original definition in migration 0003 used:
--   v_missing := v_missing || 'field_name'
-- PostgreSQL resolves the untyped string literal as text[] (not text),
-- causing ERRCODE 22P02 (malformed array literal) instead of the intended
-- 23514 (check_violation) when fields are missing.
--
-- Fix: use array_append() to unambiguously append a text element.

CREATE OR REPLACE FUNCTION enforce_pack_sealing_preconditions()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  v_cr      compliance_records%ROWTYPE;
  v_missing TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF NOT (OLD.sealed = FALSE AND NEW.sealed = TRUE) THEN
    RETURN NEW;
  END IF;

  SELECT *
    INTO v_cr
    FROM compliance_records
   WHERE shipment_id = NEW.shipment_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Cannot seal BankEvidencePack: no ComplianceRecord exists for shipment_id %.',
      NEW.shipment_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_cr.nxp_approved              IS NOT TRUE THEN v_missing := array_append(v_missing, 'nxp_approved');             END IF;
  IF v_cr.cci_obtained              IS NOT TRUE THEN v_missing := array_append(v_missing, 'cci_obtained');             END IF;
  IF v_cr.bl_uploaded               IS NOT TRUE THEN v_missing := array_append(v_missing, 'bl_uploaded');              END IF;
  IF v_cr.payment_evidence_uploaded IS NOT TRUE THEN v_missing := array_append(v_missing, 'payment_evidence_uploaded'); END IF;
  IF v_cr.credit_advice_confirmed   IS NOT TRUE THEN v_missing := array_append(v_missing, 'credit_advice_confirmed');  END IF;

  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION
      'Cannot seal BankEvidencePack: compliance checklist incomplete — missing: [%]. '
      'Update the ComplianceRecord and retry.',
      array_to_string(v_missing, ', ')
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
