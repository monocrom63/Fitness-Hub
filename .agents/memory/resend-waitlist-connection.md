---
name: Resend connection for Fiudia email
description: Which credential path powers Fiudia server-side emails and how to repair it.
---

All Fiudia server-side email delivery uses the existing Replit Resend connector, not a raw API key in application code. `RESEND_FROM_EMAIL` configures the sender address; it is not a provider credential. The connector credential and any workspace `RESEND_API_KEY` secret are separate.

**Why:** Resend is already connected to the project, and its credential should remain inside Replit's connector proxy. A second direct-key path duplicated credentials and made it unclear which key needed repair.

**How to apply:** If any Fiudia email reports an invalid provider key, direct the user to update the existing Resend connection in Integrations → Manage → Edit; never ask them to paste a key into chat. Check the sender domain through that connection before accepting a new email-notification action.
