---
name: District studio context
description: Product boundary between the district manager's selected studio and organization-wide work.
---

Selecting a studio narrows operational work, but organization-level communication and team administration stay organization-wide. Course creation still requires an explicit target studio; the active studio is not permission to silently choose a course destination. While the district studio choice is unresolved, do not fall back to an unfiltered organization-wide operational query. The district manager's active city follows the active accessible studio instead of being a separate, potentially contradictory selection.

**Why:** The switch should prevent work from appearing under the wrong location without hiding cross-studio announcements or invitations. A saved choice must also win over an old room deep link once the manager explicitly switches again. An unfiltered request during studio loading or failure can show courses from other studios under the wrong context. Keeping city and studio linked prevents a saved city from disagreeing with the operational studio after reload or reassignment.

**How to apply:** For new views, decide whether their information belongs to one studio or the whole organization. Derive city choices from accessible studios; selecting a city activates an accessible studio there, while direct studio changes update the displayed city. Narrow studio-specific reads before result limits, retain server-side access checks, disable scoped queries until the valid studio is known, distinguish loading/error/empty selection states, and reset or isolate in-flight page feedback when the selected studio changes.