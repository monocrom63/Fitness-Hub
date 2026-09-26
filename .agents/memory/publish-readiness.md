---
name: Publish readiness checks
description: How to confirm that a managed database schema change and its API rollout actually reached production.
---

Do not infer that a new feature is live solely from a successful Publish status. Check both the actual published route and the production database schema before calling it ready; the prior running build may still answer requests while a newer rollout has not reached the public endpoint.

**Why:** The publish status showed success while Pulse routes still returned 404 and its tables were absent in the production read replica. A later rollout brought both online, without any direct production SQL writes.

**How to apply:** For future managed-database releases, use read-only production schema inspection and a public route probe after publishing. Where a feature requires authenticated writes, distinguish route/schema readiness from an actual signed-in write/read verification.