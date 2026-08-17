# dsh-shell-wsl

DSH 直连容器沙箱执行器：在 Windows（Docker Desktop / WSL2 后端）上为 DeepSeek Harness
提供**真实 Linux bash 执行环境**。每个 bash 工具调用被路由为一个一次性 Docker 容器：

```text
docker run --rm --name dsh-exec-<pid>-<seq> -i
  -v <workspace>:/workspace[:ro] -w /workspace/<rel> -e ... <image> bash -c <command>
```

模型继续使用官方 `bash` 工具（零新工具、零工具层改动）；命令真实运行在 WSL2 Linux
内核的容器里，工作区经 bind mount 双向共享。执行器声明官方 `sandboxMode` 能力位
（`workspace-write`），与权限 preset（read-only / workspace-write /
danger-full-access）自动集成——read-only 会话挂载 `:ro`，其余挂载读写。

对应设计文档：`dsh-shell-wsl-design.md`（0.1.0-rc.6 源码契约已逐行核对）。

---

## 1. 环境要求（P0，安装前必须验证）

1. **Docker Desktop 运行中**（WSL2 后端），Windows 侧 `docker` CLI 可用：
   ```powershell
   docker version            # 客户端与服务端都要有输出
   docker context show       # desktop-linux
   ```
2. **预热镜像**（首次拉取可能超过默认 120s 超时，务必先拉）：
   ```powershell
   docker pull ubuntu:24.04
   ```
3. **验证挂载链路**（把路径换成你的工作区）：
   ```powershell
   docker run --rm -v E:\your\workspace:/workspace -w /workspace ubuntu:24.04 bash -c "uname -a && pwd && ls"
   ```
   输出应为 `Linux ... microsoft-standard-WSL2`、`/workspace` 且 `ls` 能看到 Windows 侧文件。
4. 只有使用 `wsl` 传输才需要发行版（默认 docker-cli 传输不需要）：
   另需 `wsl --install -d Ubuntu` 并在 Docker Desktop 中开启该发行版的 WSL 集成。

> 注意：以上命令请在**你自己的终端**执行。agent 的工具沙箱可能拦掉 `docker`/WSL
> 探测（E_ACCESSDENIED / 命名管道），插件本身跑在宿主进程、不受此限制。

## 2. 安装

```powershell
dsh plugin --profile web add dsh-shell-wsl
```

等价于把包加入 `~/.dsh/profiles/web/package.json` 并写入 `dsh.profile.bundles`；
bundle 元数据 `dsh.bundle.patch` 使 `cordis.patch.yml` 自动进入补丁栈
（层序：bundle 层 → profile 层 → `$DSH_HOME/cordis.patch.yml` → `--patch` 层）。

补丁做两件事：插入 `shell-wsl` 行（win32 之外自动 disabled，保持可移植），并把
宿主 `pwsh-sandbox` 行 `disabled: true`（`ctx.shell` 只能有一个提供者，
双提供者重复服务注册会 fail loud）。

git 托管插件需按 pnpm 提示在 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds`
放行 prepare 脚本。

## 3. Web 界面：启用 wsl-container preset

Web 下宿主工具行由 dsh-web-app 禁用、工具归 agent preset，所以装完插件还要启用 preset：

```powershell
powershell -ExecutionPolicy Bypass -File <插件目录>\scripts\install-preset.ps1 -SetDefault
```

或手动：把 `presets/wsl-container/` 复制到 `~/.dsh/.agent-presets/wsl-container/`，
然后在 Web 设置页把默认 preset 切到 `WSL 容器模式`。该 preset 相对 standard 只改两行：
`tool-bash` → `disabled: false`，`tool-pwsh` → `disabled: true`（必须——
`tool-pwsh` 也消费 `ctx.shell`，留着会用容器执行器跑 pwsh 命令串，语义错乱）。

## 4. tui / headless 集成

tui/headless 的 agent 平面在宿主（base patch：win32 下 tool-bash disabled、tool-pwsh
enabled）。在 **profile patch**（不能写进 bundle patch——web 下会与 preset 双重注册
`bash` 工具名冲突）显式换行：

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- id: tool-bash
  disabled: false

- id: tool-pwsh
  disabled: true
```

## 5. 配置

### 5.1 组合层（cordis 行 config，改这里需编辑补丁层）

| 字段 | 默认 | 说明 |
|---|---|---|
| `transport` | `docker-cli` | `docker-cli`（Windows 侧 CLI）或 `wsl`（`wsl.exe -d <distro> -- docker`） |
| `distro` | `Ubuntu` | 仅 wsl 传输使用 |
| `image` | `ubuntu:24.04` | 必须含 bash（alpine/busybox 不含，会报 runner 失败） |
| `workspaceMount` | `/workspace` | 容器内挂载点 |
| `workspaceRoot` | 无（兜底） | 固定工作区根；正常走 per-call policy 的 workspaceRoot |
| `containerPrefix` | `dsh-exec` | 容器名前缀：`<prefix>-<pid>-<seq>`，≤63 字符 |

```yaml
# 例：换镜像（在 profile patch 里重写该行 config——patch 是整行 config 替换，需重述全部字段）
- id: shell-wsl
  config:
    transport: docker-cli
    image: debian:bookworm-slim
```

### 5.2 设置层（settings.yaml，热更新，仅预算字段）

```yaml
# ~/.dsh/settings.yaml
bash:
  timeoutMs: 120000
  maxTimeoutMs: 600000
  maxOutputBytes: 64000
  maxSpillBytes: 67108864
  graceMs: 3000
```

环境身份字段（transport/image/…）**不能**写进 settings.yaml——基类构造函数用基类
schema 注册了 `bash` 设置命名空间，未知键会被 schema 拒绝。

## 6. 行为语义

- **正常退出零开销**：信任 `--rm`，不额外 spawn 任何 docker 命令。
- **kill / 超时 / 取消**：Windows 侧 `taskkill /T /F` 杀掉 docker.exe 树后，
  追加 best-effort `docker rm -f <name>`；并武装懒清理 reaper。
- **懒清理 reaper**：下一次 spawn 前（仅当发生过 kill，或本次执行器实例启动后的首次
  spawn——覆盖宿主崩溃恢复）执行一次 `docker ps -a` 前缀扫描，force-remove 所有
  不在活动句柄表里的遗留容器。正常运行期间 reaper 不触发。
- **基础设施错误分类**（§4.4）：daemon 未运行、docker CLI 缺失、镜像拉取失败、镜像
  无 bash、发行版缺失 → `WslContainerUnavailableError`（isError，模型停止重试）；
  命令自身非零退出 → 普通 `[exit code: N]`。
- **read-only**：挂载 `:ro`，容器内写 /workspace 是 EROFS 类普通命令错误；
  **workspace-write / danger-full-access**：均挂载读写（容器执行器无法授予宿主全权，
  danger-full-access 等价于 workspace-write）。
- **workdir**：Windows 绝对路径按工作区根做大小写不敏感前缀映射为
  `/workspace/<rel>`；已是 `/workspace` 前缀的容器路径透传；工作区之外的路径回退
  `/workspace` 并在 stderr 追加一行告警（不阻断）。
- **env**：`ENV_OVERRIDES`（NO_COLOR/TERM/PAGER/GIT_PAGER）+ spec.env + spec.dshEnv
  物化为 `-e KEY=VALUE`（argv 逐参数传递，无引号问题），强制 `LANG=C.UTF-8`。
  wsl 传输下 `DSH_*` 中的 Windows 路径翻译为 `/mnt/<drive>/...`。
- **stdin**：`docker run -i` 保持 stdin 打开，hooks 的 stdin 数据通道可用。
- 后台任务、超时、输出上限、spill 落盘、`[exit code: N]` 标记契约全部继承自
  `LocalBashExecutor` / `ctx.subprocess`，零重写。

## 7. 已知限制

- 无交互式 PTY / 持久 shell（官方 seam 无该词汇）。
- Docker Desktop 文件共享（grpcfuse / 9p）IO 比原生慢；容器内写入的属主映射有怪癖。
- `rm -rf` 在挂载卷内不会被 ACL 拦截（与 workspace-write 模式风险面相同）；对系统盘
  无写权限（容器只看得见挂载卷）。
- 首次拉取大镜像可能超时（P0 预热规避；README 明示）。
- 私有镜像仓库：docker-cli 传输共享 Docker Desktop 凭据；wsl 传输需在发行版内配
  credential helper。

## 8. 验收清单（对照设计文档 §9）

1. `bash` 工具出现；`uname -s` → `Linux`。
2. `workdir` 传 `E:\…\sub` 时容器内 `pwd` → `/workspace/sub`，双向文件可见。
3. `run_in_background` + `job_output` / `job_kill` 全链路可用。
4. 超时/kill 之后 `docker ps -a --filter name=dsh-exec-` 为空；正常运行后同样为空。
5. 停止 Docker Desktop 后调用 bash：呈现为基础设施错误（runner 失败），非命令失败。
6. read-only 会话容器内写 /workspace 失败（ro 挂载）；workspace-write 可写。
7. `wsl-container` preset 下只有 `bash`、没有 `pwsh`。
8. Windows 侧 read/write/edit 文件工具行为不变（回归）。

## 9. 开发

```powershell
# 一次性环境准备：把依赖 junction 到本机 DSH 安装的 node_modules（免装 peer 依赖）
New-Item -ItemType Directory -Force node_modules | Out-Null
cmd /c mklink /J node_modules\@deepseek-ai "$env:APPDATA\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai"
cmd /c mklink /J node_modules\@types       "$env:APPDATA\npm\node_modules\@deepseek-ai\dsh\node_modules\@types"
# TypeScript 构建工具装在插件目录外（npm 在含 junction 的 node_modules 里 reify 会 ELOOP）
npm install --prefix ..\.dsh-dev-tools --no-save --no-package-lock typescript

npm run build                    # tsc → lib/
npm test                         # 单元测试（纯函数 + 假 subprocess 的执行器测试）
$env:DSH_WSL_INTEGRATION = "1"
npm run test:integration         # 真实 docker 集成测试（需 Docker Desktop 运行）
```

结构：`src/`（纯函数：paths/env/naming/classify/argv + 执行器 index）→ 编译到
`lib/`；`tests/`（单元 + 可选集成）；`cordis.patch.yml`（bundle 补丁层）；
`presets/wsl-container/`（web preset）；`scripts/install-preset.ps1`。
