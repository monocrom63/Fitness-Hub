---
name: Backlog verification
description: Selecting new Fiudia work when task titles lag the actual implementation.
---

Pending task titles are not reliable proof that a feature or regression test is missing. Verify the full relevant implementation and test files, including their tails, before choosing a “next” task.

**Why:** A stale pending entry and a partial test-file inspection suggested a missing concurrency regression test, but the complete file already covered the race. A duplicate test would have added no protection.

**How to apply:** When continuing from the backlog, compare the intended behavior with the whole current code and tests; if it is already present, choose a genuinely missing outcome instead of implementing the title again. Check the audience and data source too: staff Pulse announcements and private member course notices are separate feeds, so search in one does not make older records in the other reachable.