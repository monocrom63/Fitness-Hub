---
name: Course-change delivery
description: Durable notification handling when a studio changes a booked course because of a room closure.
---

Never make a course-change notification's only record a browser session or a record that disappears when the triggering room closure is removed. Preserve delivery outcomes for other managers to inspect and retry; a failed external send must never be reported as delivered.

**Why:** An initial implementation kept retry context in the current tab and let deleting a closure cascade into unsent email records. That would leave a relocated or cancelled course changed while its booked members could remain uninformed.

**How to apply:** When adding a notification channel or changing closure lifecycle rules, keep an independent, durable delivery record with explicit recipient outcomes and stable retry identity. Check that cleanup and cross-session views cannot erase pending work.