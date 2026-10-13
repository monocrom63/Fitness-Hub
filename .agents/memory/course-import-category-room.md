---
name: Course CSV room mapping
description: Fiudia course-planning CSV category values identify the course room.
---

Treat each course CSV row's `Kategorie` value as the intended course-room name.

**Why:** The user wants imported courses assigned to their rooms automatically rather than selecting one room for every studio.

**How to apply:** Match category values to rooms within the selected target studio. If no matching room exists, require an explicit choice rather than silently assigning a different room.
