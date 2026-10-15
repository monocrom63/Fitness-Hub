---
name: Course CSV duplicate detection
description: Avoid creating duplicate scheduled courses when a CSV import is retried.
---

Before importing course rows, compare normalized course title, trainer, and start time against all scheduled or full courses in the explicitly selected studio. Do not rely on the ordinary course-list response for duplicate safety; it is a bounded display view. Keep repeated rows within the same CSV from importing twice, and rerun the server check when restoring an interrupted import.

**Why:** A partially completed import can be retried after the UI no longer knows whether a request reached the server, and the normal course list is capped. A partial or stale client-side comparison can create duplicate classes.

**How to apply:** Keep the duplicate check server-side and studio-authorized, chunk large imports to respect request limits, and only allow course creation after the current file's duplicate check has completed.
