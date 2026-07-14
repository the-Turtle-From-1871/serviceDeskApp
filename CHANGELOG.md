# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/).

## 2026-07-14

### Added
- **Home-unit auto-detection on item import.** When mass-importing items, each
  item's home unit is now derived from its device name — the device name is
  split on `-`/`_` and matched (case-insensitively, in any position) against a
  reference list of unit abbreviations. Example: `HI-DCSIM-LT-001` → `DCSIM`.
  Detection only fills the home unit when the CSV leaves it blank; an explicit
  value is always preserved.
- **Interactive, learn-as-you-go resolution.** Device names whose unit code
  isn't recognized appear in a resolve step during import: pick which segment is
  the unit code and give it a name once. The mapping is saved and then applied
  automatically to every other item sharing that code — in the same import and
  in all future imports.
- **`Unit` reference table**, seeded with the 71 HIARNG unit abbreviations.
- **Select-all on the items table.** A tri-state header checkbox (none / some /
  all) that operates only on selectable (active) rows; retired items have no
  checkbox and never count toward a selection.
- **Device-name search.** The items list search now matches device name in
  addition to make, model, and serial number.

### Changed
- **Item import is now a two-phase flow:** upload → *analyze* (reports what will
  import, what's auto-detected, and what needs a unit — writes nothing) →
  resolve unknowns → *confirm* (writes items in a single transaction). Nothing
  is saved until you confirm; unresolved device names still import, just with a
  blank home unit.

### Fixed
- QR code page: a long item URL now wraps onto its own line on narrow screens
  instead of overflowing.

### Notes
- Database: adds migration `20260714184046_add_unit_table`. In production the
  `Unit` table was created and seeded via `prisma/manual/2026-07-14_add_unit_table_prod.sql`
  (idempotent) rather than `db:seed`, to avoid touching the admin account.
