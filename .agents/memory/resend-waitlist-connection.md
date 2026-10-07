---
name: Resend connection for waitlist mail
description: Which credential path powers waitlist-promotion emails and how to repair it.
---

Waitlist promotion email delivery uses the existing Replit Resend connector, not a raw API key in application code. The connector credential and the workspace `RESEND_API_KEY` secret are separate; changing one does not change the other. Room-closure emails still use the workspace secret until that path is deliberately migrated.

**Why:** Resend is already connected to the project, and its credential should remain inside Replit's connector proxy. The prior direct-key path duplicated provider credentials and made it unclear which key needed repair.

**How to apply:** If the waitlist sender reports an invalid provider key, direct the user to update the existing Resend connection in Integrations → Manage → Edit; never ask them to paste a key into chat. After repair, recheck the sender domain before claiming queued deliveries.
