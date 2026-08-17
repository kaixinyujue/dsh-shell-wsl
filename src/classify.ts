import { accessSync, constants, statSync } from "node:fs";

/** Node-local spawn codes proven to identify executable resolution or permission failure. */
const EXECUTABLE_SPAWN_CODES = new Set(["EACCES", "ENOENT"]);

/** Whether the caller-owned spawn cwd can be entered. */
export function isUsableWorkdir(workdir: string): boolean {
  try {
    if (!statSync(workdir).isDirectory()) return false;
    accessSync(workdir, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Attribute only Node ENOENT/EACCES failures whose error path equals argv[0]
 * after independently ruling out the caller-owned cwd — the same attribution
 * rule as @deepseek-ai/dsh-bash-sandbox. The workdir is checked at
 * classification time, not atomically with spawn.
 */
export function isRunnerSpawnFailure(error: unknown, runnerProgram: string, workdir: string): boolean {
  if (!isUsableWorkdir(workdir)) return false;
  if (typeof error !== "object" || error === null) return false;
  const err = error as { code?: unknown; path?: unknown; syscall?: unknown };
  if (typeof err.code !== "string" || !EXECUTABLE_SPAWN_CODES.has(err.code)) return false;
  if (typeof err.syscall !== "string") return false;
  const exactSyscall = `spawn ${runnerProgram}`;
  if (err.path === void 0) return err.syscall === exactSyscall;
  if (typeof err.path !== "string" || err.path.length === 0 || err.path !== runnerProgram) return false;
  return err.syscall === "spawn" || err.syscall === exactSyscall;
}

/** One structured runner-failure rule (the bash-sandbox dialect). */
export interface RunnerFailureRule {
  /** Optional exit-code gate; absent means any nonzero exit. */
  allowedExitCodes?: number[];
  /** Exact (lowercased) stderr lines that carry information, not failure. */
  informationalLines?: string[];
  /** Case-insensitive substrings that identify the runner failure. */
  fatalSignatures: string[];
}

/**
 * Classify one settled foreground run against the container runner's failure
 * dialect. Returns the first matching stderr line, or undefined when evidence
 * is insufficient.
 */
export function classifyRunnerFailure(
  exitCode: number | null,
  stderr: string,
  rules: readonly RunnerFailureRule[],
): { detail: string } | undefined {
  if (exitCode === null || exitCode === 0) return void 0;
  const lines = stderr.split(/\r?\n/);
  for (const rule of rules) {
    if (rule.allowedExitCodes !== void 0 && !rule.allowedExitCodes.includes(exitCode)) continue;
    const informationalLines = new Set((rule.informationalLines ?? []).map((line) => line.toLowerCase()));
    const fatalSignatures = rule.fatalSignatures
      .filter((signature) => signature.trim().length > 0)
      .map((signature) => signature.toLowerCase());
    for (const line of lines) {
      const lowered = line.toLowerCase();
      if (informationalLines.has(lowered)) continue;
      if (fatalSignatures.some((signature) => lowered.includes(signature))) return { detail: line };
    }
  }
  return void 0;
}

/**
 * Runner-failure rules for the container executor (design §4.4). All of these
 * mean "the command never ran / the engine is broken", never "the command
 * failed": daemon down, docker CLI missing (wsl transport), image pull
 * failures, image without bash, or distro missing (wsl transport).
 */
export const DOCKER_RUNNER_FAILURE_RULES: readonly RunnerFailureRule[] = [
  {
    allowedExitCodes: [125],
    fatalSignatures: [
      "cannot connect to the docker daemon",
      "error during connect",
      "the docker daemon is not running",
    ],
  },
  {
    fatalSignatures: [
      "pull access denied",
      "manifest unknown",
      "no such image",
      "repository does not exist",
      "failed to resolve reference",
    ],
  },
  {
    allowedExitCodes: [126, 127],
    fatalSignatures: ["exec: \"bash\": executable file not found", "executable file not found in $path"],
  },
  {
    allowedExitCodes: [127],
    fatalSignatures: ["bash: not found", "bash: command not found"],
  },
  {
    allowedExitCodes: [127],
    fatalSignatures: ["docker: command not found", "docker: not found"],
  },
  {
    fatalSignatures: ["no distribution with the supplied name", "there is no distribution with the supplied name"],
  },
];

/**
 * Thrown when the container runner itself is unavailable: the command did not
 * run and retrying the same command will not help. The tool layer presents a
 * thrown error as an infrastructure failure (isError) — the same presentation
 * @deepseek-ai/dsh-bash-sandbox achieves with SandboxUnavailableError.
 */
export class WslContainerUnavailableError extends Error {
  constructor(detail: string) {
    super(
      `dsh-shell-wsl: the container runner is unavailable — ${detail} (the command did not run; fix the Docker setup, not the command)`,
    );
    this.name = "WslContainerUnavailableError";
  }
}
