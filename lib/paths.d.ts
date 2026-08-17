import type { WslTransport } from "./types.js";
/**
 * Translate a Windows path into its WSL mount form (equivalent to
 * `wslpath -u` for drive-letter paths): `E:\work\sub` -> `/mnt/e/work/sub`.
 * UNC and already-POSIX paths only get backslashes swapped; the wsl transport
 * uses this for the bind-mount source, the docker-cli transport never does.
 */
export declare function toWslPath(p: string): string;
/**
 * Normalize a workspace root for -v and -w use: strip trailing separators,
 * keep a bare drive letter usable ("E:" -> "E:\\").
 */
export declare function normalizeRoot(root: string): string;
/** Whether a workdir is already a container-side path under the mount point. */
export declare function isContainerPath(p: string, mount: string): boolean;
/** The container-side working directory and mount facts derived for one spawn. */
export interface WorkdirPlan {
    /** Bind-mount source: the Windows path (docker-cli) or its /mnt/<drive> form (wsl). */
    mountSource: string;
    /** Windows-side cwd for the CLI process itself (always the workspace root). */
    hostCwd: string;
    /** Container-side working directory handed to `docker run -w`. */
    workdir: string;
    /** Whether the mount is read-only for this call. */
    readOnly: boolean;
    /** Whether the requested workdir lies outside the workspace (fallback + warning). */
    outsideWorkspace: boolean;
}
export interface PlanWorkdirOptions {
    /** Absolute Windows path of the workspace root (policy.workspaceRoot / config fallback). */
    workspaceRoot: string;
    /** Resolved spec workdir: a Windows absolute path or a container-side path. */
    workdir: string;
    /** Container mount point (config.workspaceMount, default /workspace). */
    workspaceMount: string;
    /** Active transport; only affects the mount source spelling. */
    transport: WslTransport;
    /** read-only session mounts :ro. */
    readOnly: boolean;
}
/**
 * Map one resolved workdir into the container world. Rules (design §4.2):
 * - a workdir already under the mount point passes through untouched;
 * - otherwise it is mapped relative to the workspace root (case-insensitive
 *   comparison, Windows semantics), falling back to the mount root with an
 *   `outsideWorkspace` flag when it escapes the root.
 */
export declare function planWorkdir(opts: PlanWorkdirOptions): WorkdirPlan;
