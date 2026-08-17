import test from "node:test";
import assert from "node:assert/strict";
import { makeContainerName, sanitizeContainerPrefix } from "../lib/naming.js";

test("sanitizeContainerPrefix keeps [a-z0-9-] only", () => {
  assert.equal(sanitizeContainerPrefix("Dsh_Exec!"), "dsh-exec");
  assert.equal(sanitizeContainerPrefix("  My Executor  "), "my-executor");
  assert.equal(sanitizeContainerPrefix("!!!"), "");
});

test("makeContainerName is deterministic, unique and well-formed", () => {
  const a = makeContainerName("dsh-exec", 1234, 1);
  const b = makeContainerName("dsh-exec", 1234, 2);
  assert.equal(a, "dsh-exec-1234-1");
  assert.equal(b, "dsh-exec-1234-2");
  assert.match(a, /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
  assert.ok(a.length <= 63);
});

test("makeContainerName truncates long prefixes and never ends with a hyphen", () => {
  const name = makeContainerName("x".repeat(200), 99999, 7);
  assert.ok(name.length <= 63);
  assert.match(name, /^[a-z0-9].*[a-z0-9]$/);
  assert.ok(name.endsWith("-99999-7"));
});

test("makeContainerName falls back when the prefix sanitizes to nothing", () => {
  assert.equal(makeContainerName("!!!", 1, 1), "dsh-exec-1-1");
});
