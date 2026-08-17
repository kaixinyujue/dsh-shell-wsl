import path from "node:path";
/**
 * Translate a Windows path into its WSL mount form (equivalent to
 * `wslpath -u` for drive-letter paths): `E:\work\sub` -> `/mnt/e/work/sub`.
 * UNC and already-POSIX paths only get backslashes swapped; the wsl transport
 * uses this for the bind-mount source, the docker-cli transport never does.
 */
export function toWslPath(p) {
    const drive = /^([a-zA-Z]):[\\/](.*)$/.exec(p);
    if (drive !== null)
        return `/mnt/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, "/")}`;
    return p.replace(/\\/g, "/");
}
/**
 * Normalize a workspace root for -v and -w use: strip trailing separators,
 * keep a bare drive letter usable ("E:" -> "E:\\").
 */
export function normalizeRoot(root) {
    const stripped = root.replace(/[\\/]+$/, "");
    if (/^[a-zA-Z]:$/.test(stripped))
        return `${stripped}\\`;
    return stripped;
}
/** Whether a workdir is already a container-side path under the mount point. */
export function isContainerPath(p, mount) {
    return p === mount || p.startsWith(`${mount}/`);
}
/**
 * Map one resolved workdir into the container world. Rules (design §4.2):
 * - a workdir already under the mount point passes through untouched;
 * - otherwise it is mapped relative to the workspace root (case-insensitive
 *   comparison, Windows semantics), falling back to the mount root with an
 *   `outsideWorkspace` flag when it escapes the root.
 */
export function planWorkdir(opts) {
    const root = normalizeRoot(opts.workspaceRoot);
    const mount = opts.workspaceMount;
    let workdir = mount;
    let outsideWorkspace = false;
    if (isContainerPath(opts.workdir, mount)) {
        workdir = opts.workdir;
    }
    else {
        const rel = path.win32.relative(root, opts.workdir);
        if (rel !== "" && !rel.startsWith("..") && !path.win32.isAbsolute(rel)) {
            workdir = `${mount}/${rel.replace(/\\/g, "/")}`;
        }
        else if (rel !== "") {
            outsideWorkspace = true;
        }
    }
    return {
        mountSource: opts.transport === "wsl" ? toWslPath(root) : root,
        hostCwd: root,
        workdir,
        readOnly: opts.readOnly,
        outsideWorkspace,
    };
}
