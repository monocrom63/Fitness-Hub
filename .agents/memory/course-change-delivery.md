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

Do not target member-specific OneSignal messages using a client-declared external ID unless the member identity is verified server-side. A public Web SDK App ID is sufficient for browser opt-in, not for secure recipient binding or sending.

**Why:** An unauthenticated browser can otherwise claim another member's external ID and potentially receive private course-change messages intended for that member.

**How to apply:** For targeted push delivery, use OneSignal identity verification or bind subscription IDs to authenticated members on the server, then obtain server-side sending authorization. Verify the full path before presenting push as a delivered channel.

Treat push click navigation as recipient-specific and asynchronous: retain a validated click until the member app knows who signed in, then route only if that member is the intended recipient.

**Why:** The browser may open the app from a push before authentication or member-home loading finishes, and browser subscriptions can outlive a tab. A course ID alone can be applied to the wrong signed-in member on a shared device. A fixed production launch URL can also send development pushes into a different environment and database.

**How to apply:** Send recipient context with each course-change push, validate it against the authenticated member before consuming a queued click, clear pending clicks on identity changes, and keep course authorization on the server. Do not solve click routing by guessing a deployment domain or hardcoding a cross-environment launch URL.

For ordinary course edits, keep external push copy neutral and direct the member to the current course details; preserve the specific change in the in-app notice. Every course-detail mutation, including room-closure and trainer-absence resolutions, must advance the shared course revision and invalidate older queued edit pushes. Do not report an in-flight send as unsent merely because a newer change superseded it.

**Why:** A provider call cannot reliably be retracted after it begins. A cancellation, opt-out, or later edit can commit between the final eligibility check and provider acceptance; detailed old push copy would then show wrong times or rooms, while marking it skipped would misstate what actually happened.

**How to apply:** Recheck recipient eligibility before every attempt, use the shared revision for stale-form protection, keep provider results truthful for already-started sends, and avoid course-specific details in any push that could race a later change.

Keep operational course scheduling focused on upcoming classes while giving managers a separate, studio-scoped delivery history that remains readable after a class starts or is cancelled. Historical visibility must not imply historical retry eligibility.

**Why:** A push failure may only be noticed after its course disappears from the upcoming schedule. Expanding the scheduling list just to reach delivery records conflates two different jobs.

**How to apply:** Preserve manager access to past delivery outcomes through an authorized history path; allow re-queueing only terminal failures for the current revision of a future, still-booked course with an active subscription.