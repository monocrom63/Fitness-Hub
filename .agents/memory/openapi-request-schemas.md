---
name: OpenAPI request schemas
description: Avoiding duplicate exported types when generating the API clients and Zod contracts.
---

In this workspace's Orval setup, an inline operation request-body schema can generate the same `*Body` name in both the Zod API module and its generated TypeScript types, causing an export collision.

**Why:** The generated API client and Zod contracts are both re-exported from shared package indexes, so matching operation-generated names conflict at compile time.

**How to apply:** Define request bodies as named OpenAPI component schemas and reference them from operations, then regenerate the clients and run the library typecheck.
