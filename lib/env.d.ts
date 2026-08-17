import type { WslTransport } from "./types.js";
/**
 * Materialize one execution's environment as `docker run -e KEY=VALUE` args.
 * Passing each entry as its own argv element avoids shell quoting entirely.
 * Layers (later wins, matching the local executor's merge order):
 *   ENV_OVERRIDES (NO_COLOR/TERM/PAGER/GIT_PAGER) -> spec.env -> spec.dshEnv
 * then a forced `LANG=C.UTF-8` (design: the container pins UTF-8 output).
 * Under the wsl transport, `DSH_*` values that are Windows paths are
 * translated to /mnt/<drive> form so they stay meaningful inside the distro.
 */
export declare function buildEnvArgs(env: Record<string, string> | undefined, dshEnv: Record<string, string> | undefined, transport: WslTransport): string[];
