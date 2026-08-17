import z from "@deepseek-ai/schemastery";
import { LocalBashExecutor } from "@deepseek-ai/dsh-bash-local";
import { buildRunArgv, dockerProgram } from "./argv.js";
import { DOCKER_RUNNER_FAILURE_RULES, WslContainerUnavailableError, classifyRunnerFailure, isRunnerSpawnFailure } from "./classify.js";
import { makeContainerName } from "./naming.js";
import { planWorkdir } from "./paths.js";
export { DOCKER_RUNNER_FAILURE_RULES, WslContainerUnavailableError, classifyRunnerFailure, isRunnerSpawnFailure } from "./classify.js";
export { buildBashCommand, buildRunArgv, dockerProgram } from "./argv.js";
export { buildEnvArgs } from "./env.js";
export { makeContainerName, sanitizeContainerPrefix } from "./naming.js";
export { isContainerPath, normalizeRoot, planWorkdir, toWslPath } from "./paths.js";
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
export class WslContainerExecutor extends LocalBashExecutor {
    static inject = ["subprocess", "sandboxPolicy"];
    /**
     * Base budget schema + the composition-layer identity fields. The cast to
     * the base schema type satisfies the class static-side check; cordis
     * validates row config against the actual runtime schema (base budget
     * defaults plus the identity defaults below).
     */
    static Config = z.object({
        ...LocalBashExecutor.Config.dict,
        transport: z.union(["docker-cli", "wsl"]).default("docker-cli"),
        distro: z.string().default("Ubuntu"),
        image: z.string().default("ubuntu:24.04"),
        workspaceMount: z.string().default("/workspace"),
        workspaceRoot: z.string(),
        containerPrefix: z.string().default("dsh-exec"),
    });
    seq = 0;
    /** Armed at construction (crash orphans from a previous host) and on every kill path. */
    orphansDirty = true;
    sweeping = false;
    /** Live container names: the reaper never removes a tracked container. */
    activeNames = new Set();
    processFacts = new Map();
    get config() {
        return super.config;
    }
    /** The capability fact the tool layer reads to advertise escalation fields. */
    get sandboxMode() {
        return "workspace-write";
    }
    get policyService() {
        return this.ctx.sandboxPolicy;
    }
    /**
     * Stamp a complete per-call policy onto the spec: tool calls supply the
     * calling session's resolved policy, direct callers fall back to the
     * deployment policy (the same shape as dsh-bash-sandbox.resolve).
     */
    resolve(request) {
        return {
            ...super.resolve(request),
            sandboxPolicy: request.sandboxPolicy ?? this.policyService.resolve(),
        };
    }
    async run(spec) {
        this.reapIfNeeded();
        const containerName = this.nextContainerName();
        const plan = this.plan(spec, containerName);
        this.activeNames.add(containerName);
        let result;
        try {
            result = await this.runArgv({ ...spec, workdir: plan.hostCwd }, plan.argv);
        }
        catch (error) {
            this.activeNames.delete(containerName);
            if (spec.signal?.aborted === true)
                spec.signal.throwIfAborted();
            if (isRunnerSpawnFailure(error, plan.runnerProgram, plan.hostCwd)) {
                throw new WslContainerUnavailableError(String(error));
            }
            throw error;
        }
        const runnerFailure = classifyRunnerFailure(result.exitCode, result.stderr.text, DOCKER_RUNNER_FAILURE_RULES);
        if (runnerFailure !== void 0) {
            this.activeNames.delete(containerName);
            throw new WslContainerUnavailableError(runnerFailure.detail);
        }
        this.activeNames.delete(containerName);
        if (result.timedOut || result.aborted)
            this.forceRemove(containerName);
        return { ...result, sandbox: { mode: plan.mode, denied: false } };
    }
    start(spec) {
        this.reapIfNeeded();
        const containerName = this.nextContainerName();
        const plan = this.plan(spec, containerName);
        this.activeNames.add(containerName);
        let proc;
        try {
            proc = this.startArgv({ ...spec, workdir: plan.hostCwd }, plan.argv);
        }
        catch (error) {
            this.activeNames.delete(containerName);
            if (isRunnerSpawnFailure(error, plan.runnerProgram, plan.hostCwd)) {
                throw new WslContainerUnavailableError(String(error));
            }
            throw error;
        }
        const baseKill = proc.kill.bind(proc);
        proc.kill = () => {
            this.forceRemove(containerName);
            return baseKill();
        };
        this.processFacts.set(proc, {
            containerName,
            mode: plan.mode,
            runnerProgram: plan.runnerProgram,
            hostCwd: plan.hostCwd,
        });
        return proc;
    }
    /**
     * Stamp per-process facts before `done` settles. Runner failures are
     * reported as `runnerFailed` on the process (never as command failures);
     * container names leave the active set here so a settled --rm'd container
     * can be reaped by a later sweep.
     */
    onProcessDone(proc, stderr, spawnFailed, spawnError) {
        const facts = this.processFacts.get(proc);
        if (facts !== void 0) {
            this.processFacts.delete(proc);
            this.activeNames.delete(facts.containerName);
            const runnerFailed = spawnFailed
                ? isRunnerSpawnFailure(spawnError, facts.runnerProgram, facts.hostCwd)
                : classifyRunnerFailure(proc.exitCode, stderr, DOCKER_RUNNER_FAILURE_RULES) !== void 0;
            proc.sandbox = {
                mode: facts.mode,
                denied: false,
                ...(runnerFailed ? { runnerFailed: true } : {}),
            };
        }
        super.onProcessDone(proc, stderr, spawnFailed, spawnError);
    }
    /** Compute argv, mount facts, and classification provenance for one spawn. */
    plan(spec, containerName) {
        const policy = spec.sandboxPolicy ?? this.policyService.resolve();
        const config = this.config;
        const mapping = planWorkdir({
            workspaceRoot: policy.workspaceRoot ?? config.workspaceRoot ?? process.cwd(),
            workdir: spec.workdir,
            workspaceMount: config.workspaceMount,
            transport: config.transport,
            readOnly: policy.mode === "read-only",
        });
        const built = buildRunArgv({
            transport: config.transport,
            distro: config.distro,
            image: config.image,
            workspaceMount: config.workspaceMount,
            mountSource: mapping.mountSource,
            workdir: mapping.workdir,
            readOnly: mapping.readOnly,
            outsideWorkspace: mapping.outsideWorkspace,
            requestedWorkdir: spec.workdir,
            workspaceRoot: mapping.hostCwd,
            command: spec.command,
            env: spec.env,
            dshEnv: spec.dshEnv,
            containerName,
        });
        return {
            argv: built.argv,
            runnerProgram: built.runnerProgram,
            hostCwd: mapping.hostCwd,
            mode: policy.mode,
        };
    }
    nextContainerName() {
        this.seq += 1;
        return makeContainerName(this.config.containerPrefix, process.pid, this.seq);
    }
    /**
     * Best-effort `docker rm -f` for one container, fire-and-forget. Called on
     * kill/timeout/abort paths only; normal exits trust `--rm` (zero extra
     * spawns on the happy path). Also arms the lazy reaper.
     */
    forceRemove(containerName) {
        this.orphansDirty = true;
        const program = dockerProgram(this.config.transport, this.config.distro);
        try {
            this.ctx.subprocess.spawn({
                argv: [...program, "rm", "-f", containerName],
                cwd: this.config.workspaceRoot ?? process.cwd(),
                stdio: {
                    stdin: "ignore",
                    stdout: { maxBytes: 1 << 10 },
                    stderr: { maxBytes: 1 << 10 },
                },
                graceMs: 5000,
                env: {},
            });
        }
        catch {
            // best-effort; the reaper sweep covers this name later
        }
    }
    /**
     * Lazy orphan reaper: runs before the next spawn when a kill happened (or
     * after a crash of a previous host process). Lists `dsh-exec-*` containers
     * once, force-removes every name not tracked as active. Never touches live
     * containers (names are unique per spawn).
     */
    reapIfNeeded() {
        if (!this.orphansDirty || this.sweeping)
            return;
        this.orphansDirty = false;
        this.sweeping = true;
        void this.sweepOrphans().finally(() => {
            this.sweeping = false;
        });
    }
    async sweepOrphans() {
        const program = dockerProgram(this.config.transport, this.config.distro);
        const cwd = this.config.workspaceRoot ?? process.cwd();
        let names = [];
        try {
            const handle = this.ctx.subprocess.spawn({
                argv: [...program, "ps", "-a", "--format", "{{.Names}}", "--filter", `name=${this.config.containerPrefix}-`],
                cwd,
                stdio: {
                    stdin: "ignore",
                    stdout: { maxBytes: 1 << 20 },
                    stderr: { maxBytes: 1 << 20 },
                },
                graceMs: 5000,
                env: {},
            });
            const outcome = await handle.done;
            if (outcome.exitCode === 0) {
                const text = handle.collected.stdout?.readFrom(0).text ?? "";
                names = text.split(/\r?\n/).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
            }
        }
        catch {
            return;
        }
        for (const name of names) {
            if (this.activeNames.has(name))
                continue;
            try {
                this.ctx.subprocess.spawn({
                    argv: [...program, "rm", "-f", name],
                    cwd,
                    stdio: {
                        stdin: "ignore",
                        stdout: { maxBytes: 1 << 10 },
                        stderr: { maxBytes: 1 << 10 },
                    },
                    graceMs: 5000,
                    env: {},
                });
            }
            catch {
                // best-effort
            }
        }
    }
}
export default WslContainerExecutor;
