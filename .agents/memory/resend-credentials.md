---
name: Resend credential validation
description: Why connection and secret presence alone do not establish a working email sender
---

Treat Replit connection status and secret existence as configuration checks, not proof of working Resend credentials. A provider-side read-only request can still return "API key is invalid" through either the connector or a directly configured secret.

**Why:** In this project, both paths appeared configured but were independently rejected by the provider. Enabling a sender without a provider response would make the app appear ready when it cannot deliver.

**How to apply:** Before claiming transactional email delivery works, verify a harmless Resend API request with the active runtime credential. Never print or copy the key into logs or chat; ask for a replacement through the secrets flow if the provider rejects it.