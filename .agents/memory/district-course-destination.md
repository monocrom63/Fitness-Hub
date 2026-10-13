---
name: District course destination
description: Why cross-studio course creation should require an intentional destination.
---

For district managers planning a course, require an explicit destination studio rather than defaulting to the first accessible studio. Retain the choice when a submission fails so the manager can correct the course without losing their intended destination. Course CSV imports are scoped to the currently active studio: rows for other studios in the file are ignored.

**Why:** A course created in the wrong studio affects real schedules and notifications. An alphabetical or otherwise implicit default can silently direct it to the wrong location.

**How to apply:** Keep course-planning forms' destination choice deliberate. Validate studio access on the server even if the studio list was previously loaded in the client. For CSV import, use the active studio context and never create imported rows in multiple studios from one file.