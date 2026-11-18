---
name: SMS consent policy
description: Product rule for consent, phone changes, and SMS delivery in Fiudia.
---

For OneSignal marketing SMS, require a separate, affirmative SMS consent; never infer SMS consent from the general marketing-consent field or from a stored phone number. Push and email marketing may continue to use the existing marketing consent.

**Why:** The user chose a separate SMS opt-in after OneSignal rejected a number as never subscribed; OneSignal requires SMS consent to be separately collected from email marketing consent.

**How to apply:** Keep the SMS opt-in unchecked by default, store its timestamp, reset it when the phone number changes, and recheck it on the server at send time.

The chosen provider for Fiudia marketing SMS is Twilio connected through the existing OneSignal app, not OneSignal-managed SMS.

**Why:** The user selected Twilio after confirming their OneSignal app currently has email configured but no SMS provider.

**How to apply:** Configure the Twilio sender inside OneSignal and keep Fiudia's SMS delivery routed through OneSignal. Never request or expose Twilio credentials in chat.

OneSignal push-only marketing sends do not require Fiudia's paid marketing subscription; SMS and mixed SMS-plus-push sends still do.

**Why:** The user chose to keep OneSignal's free push capability available without Fiudia's monthly charge.

**How to apply:** Keep the checkout gate channel-specific on both client and server; do not gate push-only sends when adjusting marketing billing.
