import { ENV_OVERRIDES } from "@deepseek-ai/dsh-bash-local";
import { toWslPath } from "./paths.js";
import type { WslTransport } from "./types.js";

/** A Windows absolute path (drive letter) — the only shape the wsl transport translates. */
const WINDOWS_DRIVE_PATH = /^[a-zA-Z]:[\\/]/;

/**
 * Materialize one execution's environment as `docker run -e KEY=VALUE` args.
 * Passing each entry as its own argv element avoids shell quoting entirely.
 * Layers (later wins, matching the local executor's merge order):
 *   ENV_OVERRIDES (NO_COLOR/TERM/PAGER/GIT_PAGER) -> spec.env -> spec.dshEnv
 * then a forced `LANG=C.UTF-8` (design: the container pins UTF-8 output).
 * Under the wsl transport, `DSH_*` values that are Windows paths are
 * translated to /mnt/<drive> form so they stay meaningful inside the distro.
 */
export function buildEnvArgs(
  env: Record<string, string> | undefined,
  dshEnv: Record<string, string> | undefined,
  transport: WslTransport,
): string[] {
  const merged: Record<string, string> = { ...ENV_OVERRIDES, ...env, ...dshEnv };
  if (transport === "wsl") {
    for (const key of Object.keys(merged)) {
      const value = merged[key];
      if (key.toUpperCase().startsWith("DSH_") && WINDOWS_DRIVE_PATH.test(value)) {
        merged[key] = toWslPath(value);
      }
    }
  }
  merged["LANG"] = "C.UTF-8";
  const args: string[] = [];
  for (const key of Object.keys(merged).sort()) args.push("-e", `${key}=${merged[key]}`);
  return args;
}
