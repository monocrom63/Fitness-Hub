---
name: Post-merge workflow ports
description: Diagnose failed artifact workflows that report occupied ports after a task merge.
---

After a task merge, managed artifact workflows can report port-in-use failures while earlier child processes still serve those same ports. A successful curl alone does not prove the current workflow is running the new code.

**Why:** The workflow manager may mark its replacement process failed while older process groups remain alive, leaving the preview superficially healthy but the workflow unhealthy.

**How to apply:** When post-merge restart logs show EADDRINUSE, inspect the port listener and process ancestry before changing app code or restarting repeatedly. Stop only the confirmed stale artifact process groups, then restart the managed workflows once and check both their status and the routed endpoint.