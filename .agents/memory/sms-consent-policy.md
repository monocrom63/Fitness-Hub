---
name: SMS consent policy
description: Product rule for consent, phone changes, and SMS delivery in Fiudia.
---

For OneSignal marketing SMS, require a separate, affirmative SMS consent; never infer SMS consent from the general marketing-consent field or from a stored phone number. Push and email marketing may continue to use the existing marketing consent.

**Why:** The user chose a separate SMS opt-in after OneSignal rejected a number as never subscribed; OneSignal requires SMS consent to be separately collected from email marketing consent.

**How to apply:** Keep the SMS opt-in unchecked by default, store its timestamp, reset it when the phone number changes, and recheck it on the server at send time.
