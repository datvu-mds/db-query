# Code Reviewer Memory — pg-connection-pool

- [Schema caps are advisory](pgcp-schema-caps-advisory.md) — token `schemas` allow-list gates only the DECLARED target schema, not what the SQL body can touch (qualified cross-schema access bypasses it)
- [statement-guard quoted-identifier bypass](statement-guard-quoted-identifier-bypass.md) — banned-function scan runs over stripToCode (blanks `"quoted"` idents) so `SELECT "pg_read_file"(…)` slips past the denylist in read mode
- [relation-guard untagged-RangeVar walk hole](relation-guard-untagged-rangevar-walk-hole.md) — libpg-query emits typed RangeVar fields (INSERT/UPDATE/DELETE/SELECT-INTO targets) WITHOUT the `RangeVar` tag, so the key-based walk silently misses every write target (write-path caps/denylist bypass)
