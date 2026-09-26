---
name: Backend test runtime
description: Why API integration tests need a compatible module format in this pnpm workspace.
---

Do not assume Node's native TypeScript loader or an ESM bundle can execute the backend's mixed workspace and CommonJS dependencies directly.

**Why:** Native loading rejected directory imports in workspace TypeScript modules, while an ESM bundle failed on a dependency's dynamic CommonJS require. These were test-loader failures, not failures in the API behavior.

**How to apply:** When adding backend integration tests, use a runtime that handles the complete dependency graph, such as a bundled CommonJS test. Keep test fixtures isolated in a rollback transaction so failed tests cannot leave business data behind.