---
name: Trainer absence policy
description: Manager ownership, privacy, availability, and notification-channel decisions for trainer absences.
---

Only managers report a trainer's sickness and record a replacement trainer's acceptance. A request to a candidate is an off-app coordination state, not an automated message or an in-app trainer account. An external trainer is manually recorded, not booked through a provider. Illness details belong in manager-only views and alerts; members receive only a neutral change or cancellation notice. Availability compares the entire course interval with Berlin-local absence days, ending exclusively at midnight after the final day.

**Why:** The user explicitly chose manager-only operation and did not want trainers to have their own login. Members need actionable schedule changes, not health information. Checking only the course's start day misses overnight classes that reach an absent day; a class ending exactly at the first midnight does not overlap.

**How to apply:** Keep request and confirmed-replacement states distinct. For availability, treat overlapping courses and a 30-minute changeover on either side as conflicts, and respect recorded absences using the full interval in the studio's local timezone. Deliver member updates in-app plus push where a subscription exists; do not present E-Mail or WhatsApp as delivered channels until those services are actually configured and verified.