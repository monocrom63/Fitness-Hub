---
name: Staff invitation return
description: Auth navigation and identity freshness after team invitation acceptance.
---

Keep a team invitation's return destination in the current tab across sign-in and sign-up, and require explicit acceptance before entering the assigned workspace. Clear the pending destination only after successful acceptance or a deliberate exit; after acceptance, discard any pre-invitation identity and module cache before navigating.

**Why:** An auth provider can lose a query-string return URL while moving between login, registration, and callbacks. A user who visited the dashboard before accepting may also have an old, unassigned identity cached, causing a misleading onboarding redirect even though the server granted access to the invited studio.

**How to apply:** Keep invitation tokens out of persistent cross-tab storage and arbitrary redirect parameters. Both auth screens should derive the same internal invitation destination, while failed acceptance retains it for retry. Re-evaluate role and organization permissions from fresh server state after success.