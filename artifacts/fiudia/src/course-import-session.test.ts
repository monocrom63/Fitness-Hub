import assert from "node:assert/strict";
import { test } from "node:test";
import { clearCourseImportSession, courseImportSessionKey, loadCourseImportSession, saveCourseImportSession } from "./course-import-session";

test("course import progress is isolated to the studio that created it", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  const session = {
    version: 1 as const,
    studioId: 11,
    fileName: "courses.csv",
    parsed: { rows: [{ line: 2 }] },
    duration: "60",
    capacity: "20",
    roomMap: {},
    progress: 1,
    createdLines: [2],
    skippedLines: [],
    results: [],
  };

  assert.notEqual(courseImportSessionKey(11), courseImportSessionKey(12));
  assert.equal(saveCourseImportSession(session, storage), true);
  assert.deepEqual(loadCourseImportSession(11, storage), session);
  assert.equal(loadCourseImportSession(12, storage), null);
  clearCourseImportSession(11, storage);
  assert.equal(loadCourseImportSession(11, storage), null);
});
