---
name: Stripe connector runtime
description: Runtime access to the connected Stripe account from Fiudia's API.
---

Use `@replit/connectors-sdk` to proxy Stripe API requests from the app. In this workspace, the older connection-secret endpoint returned no key inside the API workflow even though the Stripe connection was added; the connector proxy worked. Stripe POST requests must be form encoded with `application/x-www-form-urlencoded`.

**Why:** the API workflow failed to start when it tried to fetch a Stripe secret directly, while the connected account's proxy requests succeeded.

**How to apply:** app-side Stripe requests should use the connector proxy rather than extracting or storing an API key. Keep writes idempotent and never create a subscription or charge during setup.
