---
name: Organization module availability
description: Manual module controls are not proof of a commercial entitlement.
---

Treat organization module switches as operational availability controls, not as a billing or subscription source of truth. Organizations that existed before module controls default to enabled for compatibility.

**Why:** No purchasing or billing integration exists for module entitlements. Calling the switches "purchased" would imply enforcement that the product cannot currently verify, while disabling all older organizations by default would unexpectedly remove their existing tools.

**How to apply:** If commercial plans are introduced, model verified entitlement separately and combine it with the operational switch at the API boundary; migrate defaults deliberately rather than silently changing existing access.