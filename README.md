# dsh-shell-wsl

> English · [中文](README.zh.md)

A **real-Linux bash execution environment** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) on Windows: every `bash` tool call is routed into a **disposable Docker container** (Docker Desktop / WSL2 backend), with the workspace bind-mounted for two-way file sharing and automatic integration with the official permission presets.

```text
docker run --rm --name dsh-exec-<pid>-<seq> -i
  -v <session workspace>:/workspace[:ro] -w /workspace/<rel> -e ... ubuntu:24.04 bash -c <command>
```

The model keeps using the official `bash` tool (no new tools, no tool-layer changes); commands genuinely run in a container on the WSL2 Linux kernel. The executor declares the official `sandboxMode` capability bit (`workspace-write`), so permission presets (read-only / workspace-write / danger-full-access) integrate automatically — read-only sessions mount the workspace `:ro`, everything else mounts read-write.

See the design document: `dsh-shell-wsl-design.md` (checked line-by-line against the `@deepseek-ai/dsh` 0.1.0-rc.6 source contracts).

## Why a container, instead of the other approaches

On Windows, dsh exposes only `pwsh` by default (the official `tool-bash` is disabled on win32). The common community approaches to getting bash back each come with trade-offs:

| | **dsh-shell-wsl (this plugin)** | Git Bash (MSYS2) approaches | WSL distro-direct approaches |
|---|---|---|---|
| Runtime | **Real Linux**: WSL2 kernel + Ubuntu 24.04 userspace | MSYS2 emulation layer, not Linux | Real Linux, but tied to a specific installed distro |
| Isolation | Disposable container, destroyed via `--rm` after every call | No container isolation; runs as a host process | Distro lives forever; state accumulates across sessions |
| Permission-preset linkage | Native: read-only automatically mounts `:ro` | Most implementations require danger-full-access, or fail to start inside the sandbox | Common implementations let bash bypass the DSH file policy |
| Prerequisite | Docker Desktop only | Git for Windows | WSL2 + at least one distro |
| State & reproducibility | Stateless; every call starts from a pinned image | Stateless | Stateful; easy to pollute with earlier commands |

**The trade-off**: one container cold start per command buys you real Linux, isolation, and permission linkage. If you want a zero-dependency, millisecond-start POSIX-ish environment, a Git Bash approach fits better. If you want a stateful Linux environment deeply tied to your distro, a WSL-direct approach fits better. If you want a **clean, reproducible, permission-constrained real-Linux execution environment inside a Windows session**, this plugin is exactly that.

- **Real Linux**: genuine WSL2 kernel and Ubuntu userspace — Linux binaries, apt, pipes and process semantics work as-is
- **Zero pollution**: every command runs in a brand-new container that is destroyed afterwards; no leftover `cd`, variables, or apt installs
- **Permission linkage**: session permission presets map directly to read-only/read-write mounts (danger-full-access is equivalent to workspace-write under a container executor — see §7)
- **Complete lifecycle**: background jobs, timeout tree-kill, orphan-container cleanup, and infrastructure-error classification, all inherited from the official executor contract
- **Zero tool-layer changes**: the model keeps using the official `bash` tool; nothing new to learn

---

## 1. Environment requirements (P0 — verify before installing)

1. **Docker Desktop running** (WSL2 backend), with the `docker` CLI available on Windows:
   ```powershell
   docker version            # both client and server sections must print
   docker context show       # desktop-linux
   ```
2. **Pre-warm the image** (a first-time pull can exceed the default 120s timeout — pull it first):
   ```powershell
   docker pull ubuntu:24.04
   ```
3. **Verify the mount path** (replace the path with your workspace):
   ```powershell
   docker run --rm -v E:\your\workspace:/workspace -w /workspace ubuntu:24.04 bash -c "uname -a && pwd && ls"
   ```
   Expected: `Linux ... microsoft-standard-WSL2`, `/workspace`, and `ls` showing your Windows-side files.
4. A distro is only required for the `wsl` transport (the default docker-cli transport needs none):
   in that case also run `wsl --install -d Ubuntu` and enable WSL integration for that distro in Docker Desktop.

> Note: run the commands above in **your own terminal**. An agent's tool sandbox may block
> `docker`/WSL probing (E_ACCESSDENIED / named pipes); the plugin itself runs in the host
> process and is not affected.

## 2. Installation

```powershell
dsh plugin --profile web add dsh-shell-wsl
```

This adds the package to `~/.dsh/profiles/web/package.json` and writes `dsh.profile.bundles`;
the `dsh.bundle.patch` bundle metadata brings `cordis.patch.yml` into the patch stack
(layer order: bundle layer → profile layer → `$DSH_HOME/cordis.patch.yml` → `--patch` layer).

The patch does two things: inserts the `shell-wsl` row (auto-disabled outside win32, stays
portable), and sets the host `pwsh-sandbox` row `disabled: true` (`ctx.shell` can only have
one provider — duplicate service registration fails loud).

Git-hosted plugins need the prepare script allowed in the profile's `pnpm-workspace.yaml`
under `allowBuilds`, per pnpm's prompt.

## 3. Web UI: enable the wsl-container preset

Under the web surface the host tool rows are disabled by dsh-web-app and tools come from agent
presets, so enable the preset after installing the plugin:

```powershell
powershell -ExecutionPolicy Bypass -File <plugin dir>\scripts\install-preset.ps1 -SetDefault
```

Or manually: copy `presets/wsl-container/` to `~/.dsh/.agent-presets/wsl-container/` and switch
the default preset to `WSL 容器模式` on the Web settings page. The preset changes exactly two
rows relative to standard: `tool-bash` → `disabled: false` and `tool-pwsh` → `disabled: true`
(the latter is mandatory — `tool-pwsh` also consumes `ctx.shell`, and leaving it enabled would
run PowerShell command strings through the container executor, which makes no sense).

## 4. tui / headless integration

For tui/headless, the agent plane lives in the host (base patch: tool-bash disabled on win32,
tool-pwsh enabled). Flip the rows in the **profile patch** (not the bundle patch — under web
that would double-register the `bash` tool name against the preset):

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- id: tool-bash
  disabled: false

- id: tool-pwsh
  disabled: true
```

## 5. Configuration

### 5.1 Composition layer (cordis row config — edit this via the patch layers)

| Field | Default | Description |
| --- | --- | --- |
| `transport` | `docker-cli` | `docker-cli` (Windows-side CLI) or `wsl` (`wsl.exe -d <distro> -- docker`) |
| `distro` | `Ubuntu` | Used only by the wsl transport |
| `image` | `ubuntu:24.04` | Must include bash (alpine/busybox don't — that surfaces as a runner failure) |
| `workspaceMount` | `/workspace` | Mount point inside the container |
| `workspaceRoot` | none (fallback) | Fixed workspace root; normally the per-call policy's workspaceRoot is used |
| `containerPrefix` | `dsh-exec` | Container name prefix: `<prefix>-<pid>-<seq>`, ≤63 chars |

```yaml
# Example: switch images (rewrite the row config in the profile patch — patch replaces the
# whole row config, so restate every field)
- id: shell-wsl
  config:
    transport: docker-cli
    image: debian:bookworm-slim
```

### 5.2 Settings layer (settings.yaml, hot-reload, budget fields only)

```yaml
# ~/.dsh/settings.yaml
bash:
  timeoutMs: 120000
  maxTimeoutMs: 600000
  maxOutputBytes: 64000
  maxSpillBytes: 67108864
  graceMs: 3000
```

Environment identity fields (transport/image/…) must **not** go into settings.yaml — the base
constructor registers the `bash` settings namespace with the base schema, and unknown keys are
rejected by the schema.

## 6. Behavior semantics

- **Normal exit costs nothing extra**: `--rm` is trusted; no additional docker command is spawned.
- **kill / timeout / cancel**: the docker.exe tree is killed with `taskkill /T /F` on the Windows
  side, then a best-effort `docker rm -f <name>` is appended; the lazy reaper is armed.
- **Lazy reaper**: before the next spawn (only when a kill happened, or on the first spawn of this
  executor instance — covering host-crash recovery) a `docker ps -a` prefix scan force-removes
  every leftover container not in the live-handle table. The reaper never runs during normal operation.
- **Infrastructure error classification**: daemon down, docker CLI missing, image pull failure,
  image without bash, distro missing → `WslContainerUnavailableError` (isError, the model stops
  retrying); a command's own nonzero exit stays an ordinary `[exit code: N]`.
- **read-only**: mounts `:ro`; writing /workspace inside the container is an ordinary EROFS-class
  command error. **workspace-write / danger-full-access**: both mount read-write (a container
  executor cannot grant host-wide access, so danger-full-access is equivalent to workspace-write).
- **workdir**: Windows absolute paths map to `/workspace/<rel>` by case-insensitive prefix match
  against the workspace root; container paths already under `/workspace` pass through; paths
  outside the workspace fall back to `/workspace` with a one-line stderr warning (non-blocking).
- **env**: `ENV_OVERRIDES` (NO_COLOR/TERM/PAGER/GIT_PAGER) + spec.env + spec.dshEnv materialize as
  `-e KEY=VALUE` (passed as argv parameters, no quoting issues), and `LANG=C.UTF-8` is forced.
  Under the wsl transport, Windows paths in `DSH_*` are translated to `/mnt/<drive>/...`.
- **stdin**: `docker run -i` keeps stdin open, so hooks' stdin data channel works.
- Background jobs, timeouts, output caps, spill files, and the `[exit code: N]` marker contract
  are all inherited from `LocalBashExecutor` / `ctx.subprocess` — zero reimplementation.

## 7. Known limitations

- **No interactive PTY / persistent shell**: every call is a brand-new container (matching the
  official fresh-shell semantics; apt installs, `cd` and variables don't survive across calls).
  If you need a persistent shell / PTY, extend via the official `terminal` capability family —
  this plugin deliberately keeps the one-shot semantics.
- **Occasional timeouts on short commands**: usually a first-time image pull; pre-warm with
  `docker pull` (see §1).
- **Mount I/O is slower than native Windows**: inherent to Docker Desktop file sharing
  (9p / grpcfuse).
- **`rm -rf` inside the mount is not blocked by ACL**: the container can only see the mounted
  volume and has no write access to the system drive — the same risk surface as workspace-write mode.
- **danger-full-access is equivalent to workspace-write**: a container executor cannot grant
  host-wide access; both mount read-write (see §6).
- **No `docker` / `wsl.exe` inside the container, on purpose**: do Docker/WSL troubleshooting
  in **the user's own terminal** (probing from inside the agent sandbox is unreliable too).
- **Private image registries**: the docker-cli transport shares Docker Desktop credentials; the
  wsl transport needs a credential helper configured inside the distro.
- **Chinese / UTF-8 output**: the container forces `LANG=C.UTF-8`; rendering is normal.

## 8. Acceptance checklist (mirrors design doc §9)

> This plugin has completed a full acceptance round: the runtime chain (tool table / real Linux /
> mount / workdir mapping / two-way file sharing / background jobs / timeout / no orphan
> containers / read-only mount enforcement / file-tool regression) and the unit + integration
> test suites all pass. The checklist below is kept for re-verification and regression runs.

1. The `bash` tool appears; `uname -s` → `Linux`.
2. With `workdir` set to `E:\…\sub`, `pwd` inside the container → `/workspace/sub`; files are visible in both directions.
3. `run_in_background` + `job_output` / `job_kill` work end-to-end.
4. After timeout/kill, `docker ps -a --filter name=dsh-exec-` is empty; also empty after normal runs.
5. With Docker Desktop stopped, a bash call surfaces as an infrastructure error (runner failure), not a command failure.
6. In a read-only session, writing /workspace inside the container fails (ro mount); workspace-write can write.
7. Under the `wsl-container` preset there is only `bash`, no `pwsh`.
8. Windows-side read/write/edit file tools behave unchanged (regression).
9. `npm test` is fully green (6 test files, 49 cases); `$env:DSH_WSL_INTEGRATION="1"; npm run test:integration` is fully green (9 cases, requires Docker Desktop running).

## 9. Development

```powershell
# One-time environment prep: junction the deps to the local DSH install's node_modules
# (avoids installing peer dependencies)
New-Item -ItemType Directory -Force node_modules | Out-Null
cmd /c mklink /J node_modules\@deepseek-ai "$env:APPDATA\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai"
cmd /c mklink /J node_modules\@types       "$env:APPDATA\npm\node_modules\@deepseek-ai\dsh\node_modules\@types"
# TypeScript lives outside the plugin dir (npm reify ELOOPs on junctioned node_modules)
npm install --prefix ..\.dsh-dev-tools --no-save --no-package-lock typescript

npm run build                    # tsc → lib/
npm test                         # unit tests (pure functions + executor tests with a fake subprocess)
$env:DSH_WSL_INTEGRATION = "1"
npm run test:integration         # real-docker integration tests (requires Docker Desktop running)
```

Layout: `src/` (pure functions: paths/env/naming/classify/argv + the executor index) → compiled to
`lib/`; `tests/` (unit + optional integration); `cordis.patch.yml` (bundle patch layer);
`presets/wsl-container/` (web preset); `scripts/install-preset.ps1`.

## License

MIT
