-- What staff may change on their own hospital
--
-- The row level security policy already limits a staff account to the hospital
-- it is assigned to. This migration adds the second half of that question:
-- which columns, on that row.
--
-- Row security answers "which rows". Column privileges answer "which fields".
-- Both are needed, because a staff member should be able to correct a wrong
-- phone number without also being able to move the pin.
--
-- Name and location stay with the administrator on purpose. A wrong phone
-- number wastes a call. A wrong coordinate sends an ambulance to the wrong
-- place, and the person acting on it has no way to tell.

revoke update on hospitals from authenticated;

grant update (
  -- The twice-daily report
  emergency_beds,
  icu_beds,
  general_beds,
  oxygen_available,
  ambulance_available,
  updated_by,

  -- Contact details, which the hospital itself is the authority on
  main_phone,
  address,
  region_area,
  type,
  notes
) on hospitals to authenticated;

-- Deliberately not granted: name, location, listing_status,
-- location_confidence, hefra_licence. Those are administrator decisions.
--
-- An attempt to update one of them fails with a permission error even when the
-- staff member owns the row, so the limit holds regardless of what the browser
-- sends.
