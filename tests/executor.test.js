import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { WslContainerExecutor } from "../lib/index.js";

const dir = mkdtempSync(path.join(tmpdir(), "dsh-shell-wsl-exec-"));

/** Minimal ctx.subprocess fake: records spawn specs and settles programmatically. */
function makeFakeSubprocess() {
  const service = {
    spawns: [],
    handles: [],
    stdoutText: "",
    stderrText: "",
    exitCode: 0,
    spawnError: undefined,
    psNames: "",
    autoSettle: true,
    spawn(spec) {
      service.spawns.push(spec);
      const reader = (text) => ({ readFrom: () => ({ text, nextOffset: 0, lossy: false }) });
      const handle = {
        collected: { stdout: reader(service.stdoutText), stderr: reader(service.stderrText) },
        done: undefined,
        terminated: false,
        terminate() {
          handle.terminated = true;
        },
      };
      service.handles.push(handle);
      if (service.spawnError !== undefined) {
        handle.done = Promise.reject(service.spawnError);
        return handle;
      }
      const isPs = spec.argv[1] === "ps";
      let resolveDone;
      handle.done = new Promise((resolve) => {
        resolveDone = resolve;
      });
      handle.settle = (outcome) => resolveDone(outcome);
      // ps sweeps always complete quickly (mirrors reality); the knob only
      // controls the model-command handles.
      if (isPs || service.autoSettle) {
        queueMicrotask(() => {
          if (isPs) {
            handle.collected.stdout = reader(service.psNames);
            resolveDone({ exitCode: 0, signal: null });
          } else {
            resolveDone({ exitCode: service.exitCode, signal: null });
          }
        });
      }
      if (spec.signal !== undefined) {
        spec.signal.addEventListener(
          "abort",
          () => {
            handle.terminate();
            handle.settle({ exitCode: 1, signal: null });
          },
          { once: true },
        );
      }
      return handle;
    },
  };
  return service;
}

const runSpawn = (subprocess) => subprocess.spawns.find((spec) => spec.argv[1] === "run");

async function makeExecutor(overrides = {}) {
  const subprocess = makeFakeSubprocess();
  const ctx = new Context();
  const policy = overrides.policy ?? { mode: "workspace-write", workspaceRoot: dir };
  ctx.provide("subprocess", subprocess);
  ctx.provide("sandboxPolicy", { resolve: () => ({ ...policy }), defaultMode: policy.mode });
  await ctx.plugin(WslContainerExecutor, { ...(overrides.config ?? {}), workspaceRoot: dir });
  return { ctx, subprocess, shell: ctx.shell, policy };
}

test("sandboxMode advertises the workspace-write capability bit", async () => {
  const { shell } = await makeExecutor();
  assert.equal(shell.sandboxMode, "workspace-write");
});

test("resolve stamps the per-call sandbox policy", async () => {
  const { shell, policy } = await makeExecutor();
  const spec = shell.resolve({ command: "pwd" });
  assert.equal(spec.sandboxPolicy.mode, policy.mode);
  assert.equal(spec.sandboxPolicy.workspaceRoot, dir);
  assert.ok(spec.timeoutMs > 0);
});

test("run composes the docker argv with mapping and env flags", async () => {
  const { shell, subprocess } = await makeExecutor();
  const result = await shell.run(shell.resolve({ command: "echo hi", workdir: path.join(dir, "sub") }));
  assert.equal(result.exitCode, 0);
  const spec = runSpawn(subprocess);
  assert.equal(spec.argv[0], "docker");
  assert.deepEqual(spec.argv.slice(0, 4), ["docker", "run", "--rm", "--name"]);
  assert.match(spec.argv[4], /^dsh-exec-\d+-\d+$/);
  assert.equal(spec.argv[5], "-i");
  assert.equal(spec.argv[6], "-v");
  assert.equal(spec.argv[7], dir + ":/workspace");
  assert.deepEqual(spec.argv.slice(8, 10), ["-w", "/workspace/sub"]);
  assert.equal(spec.cwd, dir); // CLI runs on the Windows side
  assert.ok(spec.argv.includes("-e"));
  assert.ok(spec.argv.includes("LANG=C.UTF-8"));
  assert.ok(spec.argv.includes("TERM=dumb"));
  assert.deepEqual(spec.argv.slice(-4), ["ubuntu:24.04", "bash", "-c", "echo hi"]);
});

test("read-only policy mounts the workspace :ro", async () => {
  const { shell, subprocess } = await makeExecutor({ policy: { mode: "read-only", workspaceRoot: dir } });
  await shell.run(shell.resolve({ command: "true" }));
  assert.equal(runSpawn(subprocess).argv[7], dir + ":/workspace:ro");
});

test("container-path workdirs pass through", async () => {
  const { shell, subprocess } = await makeExecutor();
  await shell.run(shell.resolve({ command: "true", workdir: "/workspace/x" }));
  const spec = runSpawn(subprocess);
  assert.equal(spec.argv[9], "/workspace/x");
  assert.equal(spec.cwd, dir);
});

test("out-of-workspace workdirs fall back with a stderr warning", async () => {
  const { shell, subprocess } = await makeExecutor();
  await shell.run(shell.resolve({ command: "pwd", workdir: "C:\\Windows" }));
  const spec = runSpawn(subprocess);
  assert.equal(spec.argv[9], "/workspace");
  const script = spec.argv[spec.argv.length - 1];
  assert.ok(script.startsWith("printf '%s\\n'"));
  assert.match(script, /outside the mounted workspace/);
});

test("runner failures throw WslContainerUnavailableError", async () => {
  const { shell, subprocess } = await makeExecutor();
  subprocess.stderrText = "Cannot connect to the Docker daemon at npipe:////./pipe/docker_engine. Is the docker daemon running?";
  subprocess.exitCode = 125;
  await assert.rejects(() => shell.run(shell.resolve({ command: "true" })), (error) => {
    assert.equal(error.name, "WslContainerUnavailableError");
    assert.match(error.message, /cannot connect/i);
    return true;
  });
});

test("runner spawn failures (docker missing) throw WslContainerUnavailableError", async () => {
  const { shell, subprocess } = await makeExecutor();
  subprocess.spawnError = Object.assign(new Error("spawn docker ENOENT"), {
    code: "ENOENT",
    path: "docker",
    syscall: "spawn docker",
  });
  await assert.rejects(() => shell.run(shell.resolve({ command: "true" })), (error) => {
    assert.equal(error.name, "WslContainerUnavailableError");
    return true;
  });
});

test("ordinary nonzero exits are command failures, not runner failures", async () => {
  const { shell, subprocess } = await makeExecutor();
  subprocess.exitCode = 5;
  subprocess.stderrText = "make: *** [all] Error 5";
  const result = await shell.run(shell.resolve({ command: "make" }));
  assert.equal(result.exitCode, 5);
  assert.deepEqual(result.sandbox, { mode: "workspace-write", denied: false });
});

test("aborts force-remove the container", async () => {
  const { shell, subprocess } = await makeExecutor();
  subprocess.autoSettle = false;
  const ac = new AbortController();
  const pending = shell.run(shell.resolve({ command: "sleep 100", signal: ac.signal }));
  await new Promise((resolve) => setImmediate(resolve));
  ac.abort();
  const result = await pending;
  assert.equal(result.aborted, true);
  const run = runSpawn(subprocess);
  const rm = subprocess.spawns.find((spec) => spec.argv[1] === "rm");
  assert.ok(rm !== undefined);
  assert.deepEqual(rm.argv.slice(0, 3), ["docker", "rm", "-f"]);
  assert.equal(rm.argv[3], run.argv[4]);
});

test("background kill decorates with docker rm -f and stamps sandbox facts", async () => {
  const { shell, subprocess } = await makeExecutor();
  subprocess.autoSettle = false;
  const proc = shell.start(shell.resolve({ command: "sleep 100" }));
  const runHandle = subprocess.handles[subprocess.handles.length - 1];
  assert.equal(proc.status, "running");
  assert.equal(proc.kill(), true);
  assert.equal(subprocess.spawns.some((spec) => spec.argv[1] === "rm"), true);
  const run = runSpawn(subprocess);
  runHandle.settle({ exitCode: 1, signal: null });
  await proc.done;
  assert.equal(proc.status, "killed");
  assert.deepEqual(proc.sandbox, { mode: "workspace-write", denied: false });
  assert.equal(run.argv[4], subprocess.spawns.find((spec) => spec.argv[1] === "rm").argv[3]);
});

test("background spawn failures stamp runnerFailed", async () => {
  const { shell, subprocess } = await makeExecutor();
  subprocess.spawnError = Object.assign(new Error("spawn docker ENOENT"), {
    code: "ENOENT",
    path: "docker",
    syscall: "spawn docker",
  });
  const proc = shell.start(shell.resolve({ command: "true" }));
  await proc.done;
  assert.equal(proc.sandbox.runnerFailed, true);
  assert.equal(proc.sandbox.denied, false);
});

test("the lazy reaper sweeps orphan names before the next spawn", async () => {
  const { shell, subprocess } = await makeExecutor();
  subprocess.autoSettle = false;
  // arm the reaper via a kill path
  const proc = shell.start(shell.resolve({ command: "sleep 100" }));
  const runHandle = subprocess.handles[subprocess.handles.length - 1];
  proc.kill();
  runHandle.settle({ exitCode: 1, signal: null });
  await proc.done;
  // let the initial sweep's finally clear the sweeping gate before the next spawn
  await new Promise((resolve) => setTimeout(resolve, 10));
  subprocess.spawns.length = 0;
  subprocess.handles.length = 0;
  subprocess.autoSettle = true;
  subprocess.psNames = "dsh-exec-orphan-999\n";
  await shell.run(shell.resolve({ command: "pwd" }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  const ps = subprocess.spawns.find((spec) => spec.argv[1] === "ps");
  assert.ok(ps !== undefined);
  assert.equal(ps.argv[2], "-a");
  const rm = subprocess.spawns.find((spec) => spec.argv[1] === "rm" && spec.argv[3] === "dsh-exec-orphan-999");
  assert.ok(rm !== undefined);
});

test.after(() => {
  rmSync(dir, { recursive: true, force: true });
});
