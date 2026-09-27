import assert from "node:assert/strict";
import { test } from "node:test";
import {
  closureIntersectsInterval,
  localDateBoundary,
  nextLocalDate,
  resolutionRetryMatches,
} from "../src/lib/room-closures";

test("room closures include both local calendar dates and exclude touching boundaries", () => {
  const start = localDateBoundary("2026-04-10");
  const end = localDateBoundary(nextLocalDate("2026-04-12"));
  assert.equal(closureIntersectsInterval("2026-04-10", "2026-04-12", start, end), true);
  assert.equal(closureIntersectsInterval(
    "2026-04-10", "2026-04-12",
    new Date(start.getTime() - 60 * 60 * 1000), start,
  ), false, "a course ending exactly when the closure begins does not intersect");
  assert.equal(closureIntersectsInterval(
    "2026-04-10", "2026-04-12",
    end, new Date(end.getTime() + 60 * 60 * 1000),
  ), false, "a course starting exactly after the last closed local date does not intersect");
});

test("local date boundaries follow Europe/Berlin daylight-saving changes", () => {
  assert.equal(localDateBoundary("2026-03-29").toISOString(), "2026-03-28T23:00:00.000Z");
  assert.equal(localDateBoundary(nextLocalDate("2026-03-29")).toISOString(), "2026-03-29T22:00:00.000Z");
  assert.equal(closureIntersectsInterval(
    "2026-03-29", "2026-03-29",
    new Date("2026-03-29T21:30:00.000Z"),
    new Date("2026-03-29T22:00:00.000Z"),
  ), true);
});

test("a resolution retry must match closure, action, target room, and notification channel", () => {
  const prior = {
    idempotencyKey: "stable-key-123",
    closureId: 7,
    action: "relocate",
    targetRoom: "Studio B",
    channel: "email",
  };
  const base = {
    idempotencyKey: "stable-key-123",
    closureId: 7,
    action: "relocate" as const,
    room: " Studio B ",
    channel: "email",
  };
  assert.equal(resolutionRetryMatches(prior, base), true);
  assert.equal(resolutionRetryMatches(prior, { ...base, room: "Studio C" }), false);
  assert.equal(resolutionRetryMatches(prior, { ...base, channel: "in_app" }), false);
  assert.equal(resolutionRetryMatches(prior, { ...base, closureId: 8 }), false);
});