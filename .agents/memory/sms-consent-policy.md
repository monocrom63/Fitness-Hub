---
name: SMS consent policy
description: Product rule for consent, phone changes, and SMS delivery in Fiudia.
---

For OneSignal marketing messages, reuse Fiudia's existing documented marketing consent; do not ask members for a duplicate SMS-only checkbox. The user confirmed that this existing consent is recorded with membership/contract information. Push and SMS marketing audiences must be limited to members with this consent.

**Why:** The user wants the existing contract-area consent to remain the source of truth across marketing channels.

**How to apply:** Recheck current marketing consent on the server at send time and never rely only on client-selected member IDs.
