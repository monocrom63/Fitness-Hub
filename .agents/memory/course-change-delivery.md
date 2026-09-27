---
name: Course-change delivery
description: Durable notification handling when a studio changes a booked course because of a room closure.
---

Never make a course-change notification's only record a browser session or a record that disappears when the triggering room closure is removed. Preserve delivery outcomes for other managers to inspect and retry; a failed external send must never be reported as delivered.

**Why:** An initial implementation kept retry context in the current tab and let deleting a closure cascade into unsent email records. That would leave a relocated or cancelled course changed while its booked members could remain uninformed.

**How to apply:** When adding a notification channel or changing closure lifecycle rules, keep an independent, durable delivery record with explicit recipient outcomes and stable retry identity. Check that cleanup and cross-session views cannot erase pending work.

Before changing a course for an email notification, reject provider configurations already known to be unusable. Do not require a broad provider key merely to inspect domains: a sending-only key may be unable to list them, yet still be able to deliver mail.

**Why:** An existing key was rejected by the provider, so checking only that a secret exists would let a course change while all sends fail. Conversely, requiring domain-list permission would unnecessarily force broader credentials than sending needs.

**How to apply:** Treat a confirmed invalid key or unverified domain as unavailable before a new resolution. Treat missing permission to inspect domains as inconclusive, attempt delivery, and preserve per-recipient failures for inspection and retry.