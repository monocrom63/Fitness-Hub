---
name: Pulse corrections
description: Product decisions for correcting and retracting team announcements.
---

When an author corrects a Pulse message, previously recorded reads should no longer count as having read the corrected version. Recipient scope stays unchanged. Retractions should remove messages from recipients' feeds while retaining the original record rather than deleting it permanently.

**Why:** A read receipt for old content would falsely suggest the correction was seen. A mistaken announcement should stop reaching recipients without removing the record that it existed.

**How to apply:** Keep new Pulse edit and read features consistent with version-sensitive receipts and retained retraction records. If recipient scope needs to change, publish a new message instead of silently changing the audience of an existing one.

For corrections made before revision tracking existed, never infer or fabricate the editor or previous values. Show that the details are unavailable instead.

**Why:** The prior message version and the correcting person's identity were not persisted, so an accurate history cannot be recovered from the current message.

**How to apply:** Present complete before/after details only for recorded corrections; label older corrections without records as lacking historical detail.