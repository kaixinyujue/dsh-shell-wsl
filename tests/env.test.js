import test from "node:test";
import assert from "node:assert/strict";
import { buildEnvArgs } from "../lib/env.js";

test("buildEnvArgs merges overrides, env, dshEnv and forces LANG", () => {
  const args = buildEnvArgs({ FOO: "bar", NO_COLOR: "0" }, { DSH_HOME: "C:\\Users\\me\\.dsh" }, "docker-cli");
  const map = Object.fromEntries(pairs(args));
  assert.equal(map["NO_COLOR"], "0"); // caller env wins over ENV_OVERRIDES
  assert.equal(map["FOO"], "bar");
  assert.equal(map["DSH_HOME"], "C:\\Users\\me\\.dsh");
  assert.equal(map["LANG"], "C.UTF-8"); // forced
  assert.equal(map["TERM"], "dumb");
});

test("buildEnvArgs emits sorted -e pairs", () => {
  const args = buildEnvArgs({ B: "2", A: "1" }, undefined, "docker-cli");
  assert.equal(args[0], "-e");
  assert.ok(args.every((entry, index) => (index % 2 === 1 ? entry.includes("=") : entry === "-e")));
});

test("buildEnvArgs translates DSH_* windows paths only under wsl transport", () => {
  const wsl = buildEnvArgs(undefined, { DSH_HOME: "C:\\Users\\me\\.dsh", DSH_SHELL: "1" }, "wsl");
  const map = Object.fromEntries(pairs(wsl));
  assert.equal(map["DSH_HOME"], "/mnt/c/Users/me/.dsh");
  assert.equal(map["DSH_SHELL"], "1");

  const cli = buildEnvArgs(undefined, { DSH_HOME: "C:\\Users\\me\\.dsh" }, "docker-cli");
  const cliMap = Object.fromEntries(pairs(cli));
  assert.equal(cliMap["DSH_HOME"], "C:\\Users\\me\\.dsh");
});

function pairs(args) {
  const out = [];
  for (let index = 0; index + 1 < args.length; index += 2) {
    const [key, ...rest] = args[index + 1].split("=");
    out.push([key, rest.join("=")]);
  }
  return out;
}
