---
name: Authentik transition
description: Full Fiudia migration from Clerk to Authentik across team app, member app, and API.
---

The user wants Authentik to replace Clerk in both Fiudia apps and API. The issuer is `https://auth.parallelduck.site/application/o/member-platform-dev/`. Use OIDC Authorization Code with PKCE as a public client, so a client secret is not needed in browser code. Keep Clerk active until Authentik login is configured and verified; preserve existing records and never auto-select a membership when an identity matches multiple memberships.

**Why:** The user explicitly expanded the original staff-only migration to a complete replacement. Safe rollout must avoid locking out existing users or linking the wrong membership.

**How to apply:** Verify Authentik's public client ID and allowed callback URLs; map existing staff or member rows only on verified, unambiguous email matches, using the existing membership-connect flow for ambiguous member records. Remove Clerk dependencies and secrets only after both apps and API have passed real Authentik sign-in tests.