---
name: Unpatched braces advisory
description: Handling braces 3.x security findings when no patched release exists.
---

When `pnpm audit` flags `braces@3.0.3` and no patched release is available, trace every workspace dependency path and remove or replace avoidable usages rather than forcing the same vulnerable version through an override.

**Why:** There is no upstream fixed version to select, and an override would not remediate the vulnerable implementation.

**How to apply:** Use `pnpm why braces` across the workspace, then remove each unnecessary dependency path or replace only the small use case that pulls it in. Re-run the full audit afterward.
