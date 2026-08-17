import { buildEnvArgs } from "./env.js";
/**
 * The docker CLI argv prefix for the active transport. The wsl transport runs
 * the distro's docker CLI through wsl.exe; the default talks to Docker
 * Desktop's CLI on the Windows side directly.
 */
export function dockerProgram(transport, distro) {
    return transport === "wsl" ? ["wsl.exe", "-d", distro, "--", "docker"] : ["docker"];
}
/**
 * Prepend a single stderr warning line before the model command, keeping the
 * command's own exit status as the script's exit status (the printf runs
 * first; the command is the last statement).
 */
export function buildBashCommand(command, warning) {
    if (warning === void 0)
        return command;
    const escaped = warning.replace(/'/g, "'\\''");
    return `printf '%s\\n' '${escaped}' >&2\n${command}`;
}
/**
 * Compose the exact `docker run` argv for one execution (design §4.1):
 *
 *   docker run --rm --name <name> -i -v <source>:<mount>[:ro] -w <workdir>
 *     -e <K>=<V> ... <image> bash -c <command>
 *
 * `--rm` removes the container on normal exit; the executor adds
 * `docker rm -f` fallbacks on kill paths (see WslContainerExecutor).
 * `-i` keeps stdin open so the subprocess stdin channel can feed data.
 */
export function buildRunArgv(opts) {
    const program = dockerProgram(opts.transport, opts.distro);
    const warning = opts.outsideWorkspace
        ? `dsh-shell-wsl: workdir ${JSON.stringify(opts.requestedWorkdir)} is outside the mounted workspace ${JSON.stringify(opts.workspaceRoot)}; running in ${opts.workspaceMount} (bind-mount only exposes the workspace)`
        : void 0;
    const argv = [
        ...program,
        "run",
        "--rm",
        "--name",
        opts.containerName,
        "-i",
        "-v",
        `${opts.mountSource}:${opts.workspaceMount}${opts.readOnly ? ":ro" : ""}`,
        "-w",
        opts.workdir,
        ...buildEnvArgs(opts.env, opts.dshEnv, opts.transport),
        opts.image,
        "bash",
        "-c",
        buildBashCommand(opts.command, warning),
    ];
    return { argv, runnerProgram: program[0] };
}
