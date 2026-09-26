---
name: Targeted pnpm installs
description: An environment-specific side effect of adding a dependency in this workspace.
---

After a scoped pnpm package addition, inspect the workspace package catalog and Replit configuration for unrelated rewrites. Restore incidental changes rather than treating them as part of the requested dependency update.

**Why:** A targeted dependency addition normalized the workspace YAML (dropping explanatory security comments and changing its formatting) and inserted an unrelated Nix channel into Replit configuration.

**How to apply:** When adding a dependency to an artifact, compare configuration changes against the intended package and lockfile update before finishing. Preserve existing security exclusions and comments.