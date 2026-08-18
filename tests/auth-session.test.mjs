import assert from "node:assert/strict";
import test from "node:test";

import { sessionDurationSeconds } from "../src/worker.js";

test("sessão mantida dura exatamente 24 horas", () => {
  assert.equal(sessionDurationSeconds(true), 24 * 60 * 60);
});

test("sessão não mantida dura exatamente 1 hora", () => {
  assert.equal(sessionDurationSeconds(false), 60 * 60);
  assert.equal(sessionDurationSeconds(undefined), 60 * 60);
});
