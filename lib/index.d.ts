import { LocalBashExecutor } from "@deepseek-ai/dsh-bash-local";
import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellRunResult } from "@deepseek-ai/dsh-shell";
import type { WslResolvedConfig, WslSandboxMode } from "./types.js";
export { DOCKER_RUNNER_FAILURE_RULES, WslContainerUnavailableError, classifyRunnerFailure, isRunnerSpawnFailure } from "./classify.js";
export { buildBashCommand, buildRunArgv, dockerProgram } from "./argv.js";
export { buildEnvArgs } from "./env.js";
export { makeContainerName, sanitizeContainerPrefix } from "./naming.js";
export { isContainerPath, normalizeRoot, planWorkdir, toWslPath } from "./paths.js";
export type { WslCompositionConfig, WslResolvedConfig, WslTransport } from "./types.js";
/**
 * Container shell executor for the DSH bash capability seam on Windows
 * (design: dsh-shell-wsl-design.md). Every command runs as
 *
 *   docker run --rm --name dsh-exec-<pid>-<seq> -i
 *     -v <workspace>:/workspace[:ro] -w /workspace/<rel> -e ...
 *     <image> bash -c <command>
 *
 * in Docker Desktop's WSL2 Linux engine; the workspace is bind-mounted so the
 * container and the Windows-side file tools see the same files. Lifecycle,
 * budgets, spill files, timeout escalation, and the [exit code: N] contract
 * are all inherited from LocalBashExecutor / ctx.subprocess — this class only
 * replaces the argv at the execution boundary and adds container cleanup.
 *
 * The executor declares the official `sandboxMode` capability bit
 * (workspace-write), so dsh-tool-bash advertises the escalation fields and
 * the per-call policy (mode + workspace root) is stamped on every spec.
 * read-only sessions mount the workspace :ro; workspace-write and
 * danger-full-access both mount it read-write (a container cannot grant host
 * access, so danger-full-access degrades to workspace-write — see README).
 */
export declare class WslContainerExecutor extends LocalBashExecutor {
    static inject: string[];
    /**
     * Base budget schema + the composition-layer identity fields. The cast to
     * the base schema type satisfies the class static-side check; cordis
     * validates row config against the actual runtime schema (base budget
     * defaults plus the identity defaults below).
     */
    static Config: typeof LocalBashExecutor.Config;
    private seq;
    /** Armed at construction (crash orphans from a previous host) and on every kill path. */
    private orphansDirty;
    private sweeping;
    /** Live container names: the reaper never removes a tracked container. */
    private readonly activeNames;
    private readonly processFacts;
    get config(): WslResolvedConfig;
    /** The capability fact the tool layer reads to advertise escalation fields. */
    get sandboxMode(): WslSandboxMode;
    private get policyService();
    /**
     * Stamp a complete per-call policy onto the spec: tool calls supply the
     * calling session's resolved policy, direct callers fall back to the
     * deployment policy (the same shape as dsh-bash-sandbox.resolve).
     */
    resolve(request: ShellExecRequest): ShellExecSpec;
    run(spec: ShellExecSpec): Promise<ShellRunResult>;
    start(spec: ShellExecSpec): ShellProcess;
    /**
     * Stamp per-process facts before `done` settles. Runner failures are
     * reported as `runnerFailed` on the process (never as command failures);
     * container names leave the active set here so a settled --rm'd container
     * can be reaped by a later sweep.
     */
    protected onProcessDone(proc: ShellProcess, stderr: string, spawnFailed: boolean, spawnError?: unknown): void;
    /** Compute argv, mount facts, and classification provenance for one spawn. */
    private plan;
    private nextContainerName;
    /**
     * Best-effort `docker rm -f` for one container, fire-and-forget. Called on
     * kill/timeout/abort paths only; normal exits trust `--rm` (zero extra
     * spawns on the happy path). Also arms the lazy reaper.
     */
    private forceRemove;
    /**
     * Lazy orphan reaper: runs before the next spawn when a kill happened (or
     * after a crash of a previous host process). Lists `dsh-exec-*` containers
     * once, force-removes every name not tracked as active. Never touches live
     * containers (names are unique per spawn).
     */
    private reapIfNeeded;
    private sweepOrphans;
}
export default WslContainerExecutor;
