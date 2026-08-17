import test from "node:test";
import assert from "node:assert/strict";
import { DOCKER_RUNNER_FAILURE_RULES, WslContainerUnavailableError, classifyRunnerFailure, isRunnerSpawnFailure, isUsableWorkdir } from "../lib/classify.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "dsh-shell-wsl-test-"));

test("isUsableWorkdir accepts a real directory", () => {
  assert.equal(isUsableWorkdir(dir), true);
  assert.equal(isUsableWorkdir(path.join(dir, "missing")), false);
});

test("isRunnerSpawnFailure attributes ENOENT for the runner program", () => {
  const error = Object.assign(new Error("spawn docker ENOENT"), {
    code: "ENOENT",
    path: "docker",
    syscall: "spawn docker",
  });
  assert.equal(isRunnerSpawnFailure(error, "docker", dir), true);
  // different program provenance -> not attributed
  assert.equal(isRunnerSpawnFailure(error, "wsl.exe", dir), false);
  // non-executable code -> not attributed
  const other = Object.assign(new Error("boom"), { code: "EINVAL", path: "docker", syscall: "spawn docker" });
  assert.equal(isRunnerSpawnFailure(other, "docker", dir), false);
});

test("classifyRunnerFailure matches the daemon-down dialect", () => {
  const hit = classifyRunnerFailure(125, "Cannot connect to the Docker daemon at npipe://... Is the docker daemon running?", DOCKER_RUNNER_FAILURE_RULES);
  assert.ok(hit !== undefined);
  assert.match(hit.detail, /Cannot connect/);
});

test("classifyRunnerFailure matches missing bash in the image", () => {
  const hit = classifyRunnerFailure(127, "docker: Error response from daemon: failed to create task for container: exec: \"bash\": executable file not found in $PATH", DOCKER_RUNNER_FAILURE_RULES);
  assert.ok(hit !== undefined);
});

test("classifyRunnerFailure ignores clean and ordinary nonzero exits", () => {
  assert.equal(classifyRunnerFailure(0, "", DOCKER_RUNNER_FAILURE_RULES), undefined);
  assert.equal(classifyRunnerFailure(1, "make: *** [all] Error 1", DOCKER_RUNNER_FAILURE_RULES), undefined);
});

test("WslContainerUnavailableError names the executor problem", () => {
  const error = new WslContainerUnavailableError("daemon down");
  assert.equal(error.name, "WslContainerUnavailableError");
  assert.match(error.message, /container runner is unavailable/);
  assert.match(error.message, /daemon down/);
});

test.after(() => {
  rmSync(dir, { recursive: true, force: true });
});
