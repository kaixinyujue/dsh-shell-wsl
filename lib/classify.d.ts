/** Whether the caller-owned spawn cwd can be entered. */
export declare function isUsableWorkdir(workdir: string): boolean;
/**
 * Attribute only Node ENOENT/EACCES failures whose error path equals argv[0]
 * after independently ruling out the caller-owned cwd — the same attribution
 * rule as @deepseek-ai/dsh-bash-sandbox. The workdir is checked at
 * classification time, not atomically with spawn.
 */
export declare function isRunnerSpawnFailure(error: unknown, runnerProgram: string, workdir: string): boolean;
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
export declare function classifyRunnerFailure(exitCode: number | null, stderr: string, rules: readonly RunnerFailureRule[]): {
    detail: string;
} | undefined;
/**
 * Runner-failure rules for the container executor (design §4.4). All of these
 * mean "the command never ran / the engine is broken", never "the command
 * failed": daemon down, docker CLI missing (wsl transport), image pull
 * failures, image without bash, or distro missing (wsl transport).
 */
export declare const DOCKER_RUNNER_FAILURE_RULES: readonly RunnerFailureRule[];
/**
 * Thrown when the container runner itself is unavailable: the command did not
 * run and retrying the same command will not help. The tool layer presents a
 * thrown error as an infrastructure failure (isError) — the same presentation
 * @deepseek-ai/dsh-bash-sandbox achieves with SandboxUnavailableError.
 */
export declare class WslContainerUnavailableError extends Error {
    constructor(detail: string);
}
