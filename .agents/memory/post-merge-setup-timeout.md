---
name: Post-merge setup timeout
description: Handle post-merge setup timeouts when dependency installation and schema synchronization run together.
---

Set the post-merge timeout for the combined setup script, not only for the database command. Keep the script non-interactive and rerun the full setup after adjusting the timeout.

**Why:** A 20-second limit stopped the schema push after dependency installation had already used 17 seconds; a 60-second limit let the same setup and workflow reconciliation complete successfully.

**How to apply:** When post-merge setup times out, inspect stdout/stderr to identify time spent before the interrupted command, increase the configured limit with a reasonable buffer, then rerun the setup and verify both setup and workflow reconciliation report success.
