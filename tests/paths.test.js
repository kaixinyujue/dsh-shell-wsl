import test from "node:test";
import assert from "node:assert/strict";
import { isContainerPath, normalizeRoot, planWorkdir, toWslPath } from "../lib/paths.js";

test("toWslPath translates drive-letter paths", () => {
  assert.equal(toWslPath("E:\\work_place\\harness_place"), "/mnt/e/work_place/harness_place");
  assert.equal(toWslPath("C:/Users/me/.dsh"), "/mnt/c/Users/me/.dsh");
  assert.equal(toWslPath("e:\\mixed/slashes\\x"), "/mnt/e/mixed/slashes/x");
});

test("toWslPath passes through POSIX and UNC shapes", () => {
  assert.equal(toWslPath("/workspace/sub"), "/workspace/sub");
  assert.equal(toWslPath("\\\\server\\share\\dir"), "//server/share/dir");
});

test("normalizeRoot strips separators and keeps drive roots usable", () => {
  assert.equal(normalizeRoot("E:\\work\\"), "E:\\work");
  assert.equal(normalizeRoot("E:\\"), "E:\\");
  assert.equal(normalizeRoot("C:/"), "C:\\");
});

test("isContainerPath recognizes the mount prefix only at path boundaries", () => {
  assert.equal(isContainerPath("/workspace", "/workspace"), true);
  assert.equal(isContainerPath("/workspace/sub", "/workspace"), true);
  assert.equal(isContainerPath("/workspaces/x", "/workspace"), false);
  assert.equal(isContainerPath("/w", "/workspace"), false);
});

test("planWorkdir maps a Windows workdir under the root (case-insensitive)", () => {
  const plan = planWorkdir({
    workspaceRoot: "E:\\work_place\\harness_place",
    workdir: "E:\\work_place\\harness_place\\sub\\deep",
    workspaceMount: "/workspace",
    transport: "docker-cli",
    readOnly: false,
  });
  assert.deepEqual(plan, {
    mountSource: "E:\\work_place\\harness_place",
    hostCwd: "E:\\work_place\\harness_place",
    workdir: "/workspace/sub/deep",
    readOnly: false,
    outsideWorkspace: false,
  });
});

test("planWorkdir maps the root itself and mismatched case", () => {
  const plan = planWorkdir({
    workspaceRoot: "E:\\Work_Place\\Harness_Place",
    workdir: "e:\\work_place\\harness_place",
    workspaceMount: "/workspace",
    transport: "docker-cli",
    readOnly: true,
  });
  assert.equal(plan.workdir, "/workspace");
  assert.equal(plan.readOnly, true);
  assert.equal(plan.outsideWorkspace, false);
});

test("planWorkdir passes container paths through untouched", () => {
  const plan = planWorkdir({
    workspaceRoot: "E:\\work",
    workdir: "/workspace/elsewhere",
    workspaceMount: "/workspace",
    transport: "docker-cli",
    readOnly: false,
  });
  assert.equal(plan.workdir, "/workspace/elsewhere");
  assert.equal(plan.hostCwd, "E:\\work");
});

test("planWorkdir falls back for out-of-root workdirs", () => {
  const otherDrive = planWorkdir({
    workspaceRoot: "E:\\work",
    workdir: "C:\\Windows",
    workspaceMount: "/workspace",
    transport: "docker-cli",
    readOnly: false,
  });
  assert.equal(otherDrive.workdir, "/workspace");
  assert.equal(otherDrive.outsideWorkspace, true);

  const parent = planWorkdir({
    workspaceRoot: "E:\\work\\harness",
    workdir: "E:\\work\\other",
    workspaceMount: "/workspace",
    transport: "docker-cli",
    readOnly: false,
  });
  assert.equal(parent.workdir, "/workspace");
  assert.equal(parent.outsideWorkspace, true);
});

test("planWorkdir translates the mount source under the wsl transport", () => {
  const plan = planWorkdir({
    workspaceRoot: "E:\\work_place\\harness_place",
    workdir: "E:\\work_place\\harness_place\\sub",
    workspaceMount: "/workspace",
    transport: "wsl",
    readOnly: false,
  });
  assert.equal(plan.mountSource, "/mnt/e/work_place/harness_place");
  assert.equal(plan.hostCwd, "E:\\work_place\\harness_place");
  assert.equal(plan.workdir, "/workspace/sub");
});
