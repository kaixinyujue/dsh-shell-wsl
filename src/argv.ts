import { buildEnvArgs } from "./env.js";
import type { WslTransport } from "./types.js";

/**
 * The docker CLI argv prefix for the active transport. The wsl transport runs
 * the distro's docker CLI through wsl.exe; the default talks to Docker
 * Desktop's CLI on the Windows side directly.
 */
export function dockerProgram(transport: WslTransport, distro: string): string[] {
  return transport === "wsl" ? ["wsl.exe", "-d", distro, "--", "docker"] : ["docker"];
}

/**
 * Prepend a single stderr warning line before the model command, keeping the
 * command's own exit status as the script's exit status (the printf runs
 * first; the command is the last statement).
 */
export function buildBashCommand(command: string, warning: string | undefined): string {
  if (warning === void 0) return command;
  const escaped = warning.replace(/'/g, "'\\''");
  return `printf '%s\\n' '${escaped}' >&2\n${command}`;
}

export interface BuildRunArgvOptions {
  transport: WslTransport;
  distro: string;
  image: string;
  workspaceMount: string;
  /** Bind-mount source for this call (already transport-appropriate). */
  mountSource: string;
  /** Container-side working directory for -w. */
  workdir: string;
  /** read-only mount (:ro) under a read-only policy. */
  readOnly: boolean;
  /** Whether the requested workdir fell back to the mount root. */
  outsideWorkspace: boolean;
  /** The requested (Windows-side) workdir, for the fallback warning text. */
  requestedWorkdir: string;
  /** The workspace root, for the fallback warning text. */
  workspaceRoot: string;
  command: string;
  env: Record<string, string> | undefined;
  dshEnv: Record<string, string> | undefined;
  containerName: string;
}

export interface BuiltRunArgv {
  /** Full argv handed to ctx.subprocess.spawn. */
  argv: string[];
  /** argv[0] — the executable that establishes confinement (classification provenance). */
  runnerProgram: string;
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
export function buildRunArgv(opts: BuildRunArgvOptions): BuiltRunArgv {
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
