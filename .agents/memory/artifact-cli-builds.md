---
name: Artifact CLI builds
description: Why direct shell validation can fail even when a managed artifact workflow runs normally
---

Running a Vite artifact's build command directly from a shell may not inherit the port and base-path values provided to its managed workflow. Provide the artifact's configured base path and a valid port when validating from a shell.

**Why:** A healthy preview and passing typecheck can coexist with a CLI build that fails before loading Vite because those workflow-only environment values are absent.

**How to apply:** When a direct build reports missing artifact runtime variables, inspect the artifact configuration for the expected base path; pass it and a valid port to the one-off build rather than changing working workflow configuration or app code.