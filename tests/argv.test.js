import test from "node:test";
import assert from "node:assert/strict";
import { buildBashCommand, buildRunArgv, dockerProgram } from "../lib/argv.js";

test("dockerProgram composes both transports", () => {
  assert.deepEqual(dockerProgram("docker-cli", "Ubuntu"), ["docker"]);
  assert.deepEqual(dockerProgram("wsl", "Ubuntu"), ["wsl.exe", "-d", "Ubuntu", "--", "docker"]);
});

test("buildBashCommand passes plain commands through", () => {
  assert.equal(buildBashCommand("echo hi", undefined), "echo hi");
});

test("buildBashCommand prepends a single-quote-safe stderr warning", () => {
  const script = buildBashCommand("exit 3", "workdir 'odd' is outside");
  const [first, second] = script.split("\n");
  assert.equal(first, "printf '%s\\n' 'workdir '\\''odd'\\'' is outside' >&2");
  assert.equal(second, "exit 3");
});

test("buildRunArgv emits the docker run argv with mount, workdir, env and bash", () => {
  const { argv, runnerProgram } = buildRunArgv({
    transport: "docker-cli",
    distro: "Ubuntu",
    image: "ubuntu:24.04",
    workspaceMount: "/workspace",
    mountSource: "E:\\work",
    workdir: "/workspace/sub",
    readOnly: true,
    outsideWorkspace: false,
    requestedWorkdir: "E:\\work\\sub",
    workspaceRoot: "E:\\work",
    command: "pwd",
    env: undefined,
    dshEnv: { DSH_SHELL: "1" },
    containerName: "dsh-exec-1-1",
  });
  assert.equal(runnerProgram, "docker");
  assert.deepEqual(argv.slice(0, 7), ["docker", "run", "--rm", "--name", "dsh-exec-1-1", "-i", "-v"]);
  assert.equal(argv[7], "E:\\work:/workspace:ro");
  assert.equal(argv[8], "-w");
  assert.equal(argv[9], "/workspace/sub");
  const last = argv.slice(-4);
  assert.deepEqual(last, ["ubuntu:24.04", "bash", "-c", "pwd"]);
  assert.ok(argv.includes("-e"));
  assert.ok(argv.includes("DSH_SHELL=1"));
  assert.ok(argv.includes("LANG=C.UTF-8"));
});

test("buildRunArgv warns on stderr for out-of-workspace workdirs", () => {
  const { argv } = buildRunArgv({
    transport: "wsl",
    distro: "Ubuntu",
    image: "ubuntu:24.04",
    workspaceMount: "/workspace",
    mountSource: "/mnt/e/work",
    workdir: "/workspace",
    readOnly: false,
    outsideWorkspace: true,
    requestedWorkdir: "C:\\Windows",
    workspaceRoot: "E:\\work",
    command: "pwd",
    env: undefined,
    dshEnv: undefined,
    containerName: "dsh-exec-9-9",
  });
  assert.deepEqual(argv.slice(0, 6), ["wsl.exe", "-d", "Ubuntu", "--", "docker", "run"]);
  const script = argv[argv.length - 1];
  const [first, second] = script.split("\n");
  assert.ok(first.startsWith("printf '%s\\n'"));
  assert.match(first, /outside the mounted workspace/);
  assert.equal(second, "pwd");
});
