-- Apply the loaner NAMING CONVENTION to the devices that already follow it.
--
-- DATA ONLY, no DDL. `Item.isLoaner` already exists (#129); what is new is that
-- the flag now follows the device name (see modules/items/loaner-name.ts).
-- Every write path derives it from now on, but a device whose name is not
-- CHANGING never passes through one of those paths — so without this, the 51
-- devices already named NGHINB-LOAN-### would stay unflagged until somebody
-- renamed them, which is exactly the wrong way round.
--
-- SETS ONLY, NEVER CLEARS. A device flagged by hand whose name does not follow
-- the convention keeps its flag: the admin toggle is still real, and this
-- migration has no business overruling a person's standing decision on a device
-- the convention says nothing about. Measured before writing it: 51 rows match
-- the pattern, 0 rows are currently flagged, and 0 flagged rows would have been
-- cleared had this been symmetric.
--
-- The pattern is kept in step with `LOANER_NAME` in loaner-name.ts by hand —
-- one is Postgres, one is JavaScript, and there is no shared form. It is
-- anchored and case-insensitive for the reasons written up there.
UPDATE "Item"
SET "isLoaner" = true
WHERE "isLoaner" = false
  AND btrim("deviceName") ~* '^NGHINB-LOAN-[0-9]+$';
