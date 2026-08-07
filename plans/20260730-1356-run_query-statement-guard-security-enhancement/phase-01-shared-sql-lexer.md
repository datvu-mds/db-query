# Phase 01 — Shared SQL lexer (`stripToCode`)

## Context Links
- Plan: [plan.md](plan.md)
- Existing tokenizer: `src/query/single-statement.ts`
- Report note: "Reuse the `single-statement.ts` tokenizer to strip comments/strings first so it can't be comment-bypassed."

## Overview
- **Priority:** P1 (enabler for Phase 02).
- **Status:** ✅ Done.
- **Description:** Extract the comment/string/dollar-quote skipping logic that already lives inside `single-statement.ts` into one reusable lexer, so both the multi-statement check and the new statement guard read the SAME normalized view of the SQL. Prevents the two from drifting and closes comment-bypass by construction.

## Key Insights
- `single-statement.ts` already correctly skips: line comments (`--`), block comments (`/* */`), single-quoted strings with `''` escape, **E-strings** with backslash escape (the `E'\''` smuggle fix at `single-statement.ts:74` — MUST be preserved), double-quoted identifiers, and dollar-quoted bodies.
- The guard needs a "code-only" view: strings/comments/dollar-bodies blanked, code chars kept. A **same-length** blanking (replace non-code spans with spaces) keeps offsets stable and makes downstream checks trivial regexes.
- Refactoring is de-risked by the existing `single-statement.test.ts` suite — if it stays green, behavior is preserved.

## Requirements
- Functional: `stripToCode(sql)` returns a string of identical length where every character inside a comment, string literal (incl. E-strings), quoted identifier, or dollar-quoted body is replaced by a space; all other characters are unchanged.
- Non-functional: no new deps; pure function; O(n); < 200 lines.

## Architecture
New module `src/query/sql-lexer.ts`:
```
export function stripToCode(sql: string): string
```
- Single left-to-right scan mirroring `assertSingleStatement`'s branch structure (comments, `'`, E`'`, `"`, `$tag$`), but instead of *acting* on `;` it writes spaces for skipped spans and copies code chars into an output buffer.
- Port the E-string detection verbatim: `escapeString = (prev==='E'||prev==='e') && !isIdentChar(prevPrev)`. Reuse `DOLLAR_TAG` regex and `isIdentChar`.

Then refactor `single-statement.ts`:
- `assertSingleStatement(sql)` becomes: `const code = stripToCode(sql); const idx = code.indexOf(';'); if (idx !== -1 && code.slice(idx + 1).trim() !== '') throw …`.
- Keep the exact error message and the "single trailing `;` allowed" behavior.
- Retain the module's security doc-comment.

## Related Code Files
- **Create:** `src/query/sql-lexer.ts`
- **Modify:** `src/query/single-statement.ts` (consume `stripToCode`; keep public API + message identical)
- **Read for context:** `test/single-statement.test.ts`

## Implementation Steps
1. Create `sql-lexer.ts`; move `DOLLAR_TAG`, `isIdentChar`, and the scan loop; emit spaces for skipped spans, code chars otherwise.
2. Add focused doc-comment explaining the same-length blanking invariant and why E-string handling is load-bearing.
3. Refactor `assertSingleStatement` to scan the stripped string for a non-terminal `;`.
4. `npm run typecheck`.
5. Run `test/single-statement.test.ts` — must be green with **zero** test changes.

## Todo List
- [x] `sql-lexer.ts` with `stripToCode`
- [x] Port E-string + dollar-quote logic exactly
- [x] Refactor `single-statement.ts` to use it
- [x] typecheck green
- [x] `single-statement.test.ts` green unchanged

## Success Criteria
- `single-statement.test.ts` passes unmodified (incl. `SELECT E'\''; COMMIT; …` smuggle case).
- `stripToCode("SELECT 'a;b' /*;*/ ; x")` blanks the string+comment, leaving the top-level `;` and `x` visible.

## Risk Assessment
- **Reintroducing the E-string bug** during the port → mitigated by keeping `single-statement.test.ts` as the acceptance gate; do not touch the test.
- **Off-by-one in length preservation** → add a lexer unit test asserting `stripToCode(s).length === s.length` (Phase 04).

## Security Considerations
- This phase changes *structure only*, not behavior. The multi-statement defense's real backstop remains the extended wire protocol (`postgres-driver.ts`); this scanner stays defense-in-depth.

## Next Steps
- Phase 02 consumes `stripToCode` for leading-keyword + banned-function detection.
