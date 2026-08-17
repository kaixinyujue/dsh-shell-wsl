import type { Config as BashLocalConfig } from "@deepseek-ai/dsh-bash-local";

/** The two transports: Docker Desktop's CLI on the Windows side (default) or a WSL distro's docker CLI. */
export type WslTransport = "docker-cli" | "wsl";

/**
 * Composition-layer identity fields (configured on the cordis row), layered on
 * top of the base executor's budget fields. These deliberately do NOT live in
 * the settings section: the base constructor registers the `bash` settings
 * namespace with the BASE schema, so settings.yaml can hot-tune the budgets
 * (timeoutMs / maxOutputBytes / ...) but a runtime write of an identity field
 * (image, transport, ...) is rejected as an unknown key.
 */
export interface WslCompositionConfig {
  /** Command transport: "docker-cli" (default) or "wsl". */
  transport: WslTransport;
  /** WSL distro whose docker CLI is used; only meaningful for the wsl transport. */
  distro: string;
  /** Container image; must contain bash (e.g. ubuntu:24.04 — alpine has no bash). */
  image: string;
  /** Container mount point of the workspace. */
  workspaceMount: string;
  /** Fallback workspace root when the per-call policy carries none. */
  workspaceRoot?: string;
  /** Container-name prefix; names become <prefix>-<pid>-<seq>. */
  containerPrefix: string;
}

/** The sandbox modes the seam vocabulary uses (kept local to avoid a runtime dep). */
export type WslSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

/**
 * The config shape after schemastery applied the defaults: the base budget
 * fields become required (their defaults), `cwd`/`workspaceRoot` stay
 * optional, plus the identity fields.
 */
export type WslResolvedConfig = Required<Omit<BashLocalConfig, "cwd">> &
  Pick<BashLocalConfig, "cwd"> &
  WslCompositionConfig;
