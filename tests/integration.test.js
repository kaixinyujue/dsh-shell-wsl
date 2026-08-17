// Real-docker integration tests (opt-in: DSH_WSL_INTEGRATION=1 node --test tests/integration.test.js).
// These run actual containers against Docker Desktop, so they need docker
// running and the ubuntu:24.04 image present (docker pull ubuntu:24.04).

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Context } from "@deepseek-ai/cordis";
import { LocalSubprocessRuntime } from "@deepseek-ai/dsh-subprocess-local";
import { WslContainerExecutor } from "../lib/index.js";

const enabled = process.env.DSH_WSL_INTEGRATION === "1";
const workspace = fileURLToPath(new URL("../", import.meta.url));

async function makeContext(policyMode = "workspace-write") {
  const ctx = new Context();
  const subprocessFiber = await ctx.plugin(LocalSubprocessRuntime);
  ctx.provide("sandboxPolicy", {
    resolve: () => ({ mode: policyMode, workspaceRoot: workspace }),
    defaultMode: policyMode,
  });
  const executorFiber = await ctx.plugin(WslContainerExecutor, { workspaceRoot: workspace });
  return {
    ctx,
    shell: ctx.shell,
    async dispose() {
      // executor first (no new spawns), then the subprocess service kills
      // every still-live process tree (docker CLIs included).
      await executorFiber.dispose();
      await subprocessFiber.dispose();
    },
  };
}

async function waitFor(cond, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

test("real docker: uname reports the Linux kernel", { skip: !enabled }, async () => {
  const { shell, dispose } = await makeContext();
  try {
    const result = await shell.run(shell.resolve({ command: "uname -s && pwd", timeoutMs: 120000 }));
    assert.equal(result.exitCode, 0, result.stderr.text);
    assert.match(result.stdout.text, /Linux/);
    assert.match(result.stdout.text, /\/workspace/);
  } finally {
    await dispose();
  }
});

test("real docker: workdir maps to /workspace/<rel> and sees Windows files", { skip: !enabled }, async () => {
  const { shell, dispose } = await makeContext();
  try {
    const result = await shell.run(
      shell.resolve({ command: "pwd && ls", workdir: path.join(workspace, "tests"), timeoutMs: 120000 }),
    );
    assert.equal(result.exitCode, 0, result.stderr.text);
    assert.match(result.stdout.text, /\/workspace\/tests/);
    assert.match(result.stdout.text, /paths\.test\.js/);
  } finally {
    await dispose();
  }
});

test("real docker: container writes are visible on the Windows side", { skip: !enabled }, async () => {
  const { shell, dispose } = await makeContext();
  const marker = path.join(workspace, ".wsl-exec-marker");
  try {
    const result = await shell.run(shell.resolve({ command: "echo written-from-container > /workspace/.wsl-exec-marker", timeoutMs: 120000 }));
    assert.equal(result.exitCode, 0, result.stderr.text);
    assert.equal(existsSync(marker), true);
  } finally {
    rmSync(marker, { force: true });
    await dispose();
  }
});

test("real docker: managed env arrives via -e flags", { skip: !enabled }, async () => {
  const { shell, dispose } = await makeContext();
  try {
    const result = await shell.run(
      shell.resolve({ command: 'printf "%s|%s" "$DSH_SHELL" "$NO_COLOR"', dshEnv: { DSH_SHELL: "1" }, timeoutMs: 120000 }),
    );
    assert.equal(result.exitCode, 0, result.stderr.text);
    assert.equal(result.stdout.text, "1|1");
  } finally {
    await dispose();
  }
});

test("real docker: nonzero exits are ordinary command failures", { skip: !enabled }, async () => {
  const { shell, dispose } = await makeContext();
  try {
    const result = await shell.run(shell.resolve({ command: "echo oops >&2; exit 5", timeoutMs: 120000 }));
    assert.equal(result.exitCode, 5);
    assert.match(result.stderr.text, /oops/);
    assert.equal(result.sandbox.denied, false);
  } finally {
    await dispose();
  }
});

test("real docker: read-only policy mounts :ro and blocks writes", { skip: !enabled }, async () => {
  const { shell, dispose } = await makeContext("read-only");
  try {
    const result = await shell.run(shell.resolve({ command: "touch /workspace/.should-fail && echo UNEXPECTED", timeoutMs: 120000 }));
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr.text, /[Rr]ead-only file system/);
    assert.equal(result.sandbox.denied, false);
  } finally {
    await dispose();
  }
});

test("real docker: timeout kills the tree and leaves no container behind", { skip: !enabled }, async () => {
  const { shell, dispose } = await makeContext();
  try {
    const result = await shell.run(shell.resolve({ command: "sleep 60", timeoutMs: 3000 }));
    assert.equal(result.timedOut, true);
    const clean = await waitFor(async () => {
      const probe = await shell.run(shell.resolve({ command: "echo probe" }));
      return probe.exitCode === 0;
    }, 30000);
    assert.equal(clean, true);
  } finally {
    await dispose();
  }
});

test("real docker: background jobs run, read, and kill cleanly", { skip: !enabled }, async () => {
  const { shell, dispose } = await makeContext();
  try {
    const proc = shell.start(shell.resolve({ command: "echo started; sleep 60" }));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const read = proc.readOutput();
    assert.match(read.delta, /started/);
    assert.equal(proc.kill(), true);
    await proc.done;
    assert.equal(proc.status, "killed");
  } finally {
    await dispose();
  }
});

test("real docker: an image without bash is a runner failure", { skip: !enabled }, async (t) => {
  const { execFile } = await import("node:child_process");
  const hasAlpine = await new Promise((resolve) => {
    execFile("docker", ["image", "inspect", "alpine:3.20"], { timeout: 30000 }, (error) => resolve(!error));
  });
  if (!hasAlpine) {
    t.diagnostic("skipping runner-failure probe: pull the image first with docker pull alpine:3.20");
    return;
  }
  const ctx = new Context();
  const subprocessFiber = await ctx.plugin(LocalSubprocessRuntime);
  ctx.provide("sandboxPolicy", {
    resolve: () => ({ mode: "workspace-write", workspaceRoot: workspace }),
    defaultMode: "workspace-write",
  });
  // alpine ships busybox ash, not bash -> docker exec failure, exit 126/127
  const executorFiber = await ctx.plugin(WslContainerExecutor, { workspaceRoot: workspace, image: "alpine:3.20" });
  try {
    await assert.rejects(
      () => ctx.shell.run(ctx.shell.resolve({ command: "true", timeoutMs: 120000 })),
      (error) => {
        assert.equal(error.name, "WslContainerUnavailableError");
        assert.match(error.message, /bash/i);
        return true;
      },
    );
  } finally {
    await executorFiber.dispose();
    await subprocessFiber.dispose();
  }
});
