---
name: Member account linking
description: Why Fiudia does not connect a member account by email alone.
---

Do not automatically assign an existing membership to a newly signed-in account using only its email address. Require a verified primary email and an explicit membership identifier (or a future one-time, studio-scoped invitation).

**Why:** The same email address can legitimately occur in membership records at different studios. Automatic selection would make the wrong studio's private check-ins and bookings visible.

**How to apply:** Any future member-onboarding or account-recovery flow must prove control of the email and identify the intended membership unambiguously; never choose the first matching row.