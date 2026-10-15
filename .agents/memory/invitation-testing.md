---
name: Invitation verification boundaries
description: Distinguish route-level tests, mounted API behavior and real provider verification when testing invitations.
---

Invitation acceptance tests must include the application's real API mounting order, not just the isolated invitation router.

**Why:** An isolated acceptance handler passed all identity and studio checks while the mounted API rejected new invitees in an earlier organization/module guard. New invitees necessarily lack the staff access that ordinary team-administration guards expect.

**How to apply:** Exercise the narrow acceptance route through the API entry router and confirm ordinary team-management routes remain guarded. Include a genuinely new identity with no staff assignment, not an existing manager.

Programmatic Clerk login verifies application behavior with a restored identity; it does not prove external OAuth, receipt of a verification email, or production authentication.

**Why:** The browser tester establishes identity without completing the external provider UI. Development and production also have isolated Clerk user stores, and fork changes cannot be verified live before merge.

**How to apply:** Report app return, acceptance and destination checks separately from real OAuth/email-provider checks. Mark a public production page load as a smoke check only, never as proof of the complete live invitation journey.
