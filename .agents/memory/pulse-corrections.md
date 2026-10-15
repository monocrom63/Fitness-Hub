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

The ordinary reader feed should show only the current announcement. Revision details and withdrawn announcements are for authorized managers within their existing organization, studio, and audience boundaries.

**Why:** Revision history is a management audit tool, not a second channel for distributing superseded or withdrawn content to recipients.

**How to apply:** Keep audit access separate from edit permission: a manager may review an announcement they can see without gaining permission to change someone else's announcement. Never broaden studio or organization access to display history.

Concurrent corrections must compare a monotonically increasing version while holding the message lock; do not rely on the edit timestamp as a concurrency token.

**Why:** Two corrections can have the same timestamp resolution, and a stale form must not overwrite another manager's correction or add a misleading audit entry.

**How to apply:** When adding a new correction path, require the version the editor saw and reject a mismatch before changing the message, history, or read receipts.