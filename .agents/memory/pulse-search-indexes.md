---
name: Pulse search indexes
description: Keeping literal substring search scalable with PostgreSQL trigram indexes.
---

Pulse search uses case-insensitive literal substring matching, including escaped `%` and `_` characters. PostgreSQL `pg_trgm` GIN indexes speed up the existing `ILIKE '%term%'` behavior without changing search semantics; terms shorter than three characters may still require a scan.

**Why:** Full-text search would alter the existing substring and punctuation behavior, while a normal B-tree cannot accelerate a leading-wildcard search.

**How to apply:** Keep the title/body trigram indexes and the `pg_trgm` extension available in both development and production. For Replit-managed production, do not run production DDL through the agent's SQL callback; ensure the extension is enabled through the Database SQL runner before publishing the indexes.
