---
name: Authentik transition
description: When to replace Fiudia's current sign-in with the planned Authentik OIDC and MFA.
---

Keep the current sign-in working while Authentik is only a product direction, not a configured service. Do not replace or weaken authentication based solely on the concept.

**Why:** A concept specifying Authentik does not establish a reachable issuer or a configured OIDC application. Switching before those exist would lock staff out.

**How to apply:** When the Authentik work resumes, confirm the live issuer and OIDC application through the approved integration and secrets flows. Migrate authentication as its own change, preserve existing staff access, and verify sign-in before retiring the current provider.