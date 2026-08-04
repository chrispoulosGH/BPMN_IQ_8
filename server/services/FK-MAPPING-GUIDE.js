/**
 * FK Column Convention — How cross-tab references actually work
 *
 * NOTE: This file previously documented ForeignKeyRegistry.js / ForeignKeyResolver.js,
 * an in-memory FK system with admin/debug endpoints under /api/custom-factories/fk-*.
 * That system is NOT used by any client code (verified: nothing in client/src calls
 * those endpoints) and should be treated as dead code, not as documentation of current
 * behavior. This file now documents the system that IS actually live.
 */

// =============================================================================
// THE CONVENTION
// =============================================================================

/*
CSV/spreadsheet column header format:

  FK_<TargetTab>[<TargetSubtab>].<ColumnName>

Example: FK_System Components[Applications].APP_ID
  ├─ FK_          prefix identifying the column as a foreign key reference
  ├─ TargetTab     "System Components" — the outer tab holding the target data
  ├─ TargetSubtab  "Applications" — the subtab/data-type within that tab
  └─ ColumnName    "APP_ID" — the field on the target record to resolve against

Resolution is a TWO-STAGE process, and both stages must be generic — hardcoding
either one recreates the bug this file used to document:

  Stage 1 — Parse the header into { targetTab, targetSubtab, columnName }.
            Pure string/regex parsing. No target names should ever be hardcoded
            here — the whole point is that ANY "FK_X[Y].Z" header parses the
            same way regardless of what X/Y/Z are.

  Stage 2 — Resolve columnName ("APP_ID") against the target subtab's ACTUAL
            data field ("correlationId" on an ApplicationItem). The raw column
            in the target's own uploaded data might be spelled differently
            ("APP_ID Qualifier", "Application ID", etc.), so this stage is an
            alias/normalization lookup — it stays generic as long as new
            spellings get added to the alias list instead of being special-cased
            elsewhere.
*/

// =============================================================================
// STAGE 1 — HEADER PARSING (generic, no hardcoded targets)
// =============================================================================

/*
Server: server/routes/customFactories.js, parseForeignKeyColumnHeader()
  - Strips the "FK_" prefix (FK_COLUMN_PREFIX = /^fk_/i)
  - Splits the remainder on "." → [targetNamespace, targetColumnName]
  - Matches targetNamespace against /^(.+?)(?:\[(.+?)\])?$/
      group 1 → targetGroup   (the tab, e.g. "System Components")
      group 2 → targetScope   (the subtab, e.g. "Applications")
  - targetColumnNameBase strips a trailing " Qualifier" suffix for matching
    against target data that used the *_Qualifier CSV convention
  - Stored on the component as `foreignKeyColumns: [{ targetGroup, targetScope,
    targetColumnName, targetColumnNameBase, fieldName, ... }]`

Client: client/src/utils/fkValidation.ts, parseFkColumnHeader()
  and the equivalent inline regex in NeighborhoodFactory.tsx
  (/^FK_([^\[]+)\[([^\]]+)\]\.(.+)$/i) — same three groups, used to render a
  clickable link and to build a navigateToApplication event
  ({ targetTab, targetSubtab, searchField, searchValue }) that jumps to the
  target tab/subtab and pre-fills a search using targetColumnNameBase.

Both are pure parsing — verified against "FK_System Components[Applications].APP_ID"
resolving correctly to targetGroup="System Components", targetScope="Applications",
targetColumnName="APP_ID" even with the space in the tab name.
*/

// =============================================================================
// STAGE 2 — TARGET FIELD RESOLUTION (alias lookup, extend as needed)
// =============================================================================

/*
For "System Components" > "Applications": server/utils/applicationReferenceLookup.js,
buildApplicationItem(). Each canonical field (name, acronym, correlationId, ...) is
built via getFieldValue(values, [list of accepted raw-column aliases]). If a target
subtab's real CSV column isn't in the relevant alias list, that field comes back
empty even though Stage 1 parsed the FK header correctly — this is what happened
with APP_ID / APP_ID Qualifier not being recognized as a correlationId source
(fixed 2026-07 by adding those aliases).

Rule going forward: adding a new FK_ reference to a new-looking column name never
requires touching the parser (Stage 1) — only requires confirming the target
column's alias is present in the relevant Stage 2 alias list. If it's missing,
add the raw column spelling(s) there.

⚠ KNOWN GAP — not yet following this convention:
server/routes/servers.js and server/routes/databases.js each hardcode their own
APP_FK_FIELDS / APP_ACRONYM_FIELDS / APP_NAME_FIELDS arrays (duplicated between
the two files) to resolve a server/database row's linked Application for the
"Linked Applications" panel. These arrays only recognize a fixed, enumerated set
of literal header strings (e.g. 'FK_DATA[Applications].correlation_id'), NOT the
generic FK_<Tab>[<Subtab>].<Column> parse used everywhere else. A column named
FK_System Components[Applications].APP_ID will NOT populate a server's Linked
Applications panel, even though it works correctly for the generic click-through
navigation described above. Bringing servers.js/databases.js onto Stage
1-parsing + Stage 2-alias-lookup (instead of an enumerated string whitelist)
would close this gap — not yet done.
*/
