---
name: Managed Clerk publishing
description: How Replit-managed Clerk behaves when Fiudia is published.
---

For a Replit-managed Clerk tenant, do not advise manually replacing development keys merely because the development preview warns about them. Replit switches to its production Clerk environment during Publish; development and production users are separate.

**Why:** A development `pk_test` warning was mistaken for a live-launch blocker even though the tenant is managed. This led to incorrect manual-key advice that needed correction.

**How to apply:** Confirm the tenant is managed, then distinguish development preview behavior from the published app. If reviewing launch readiness, still check production schema and live sign-in independently. Do not presume a development user exists in production.