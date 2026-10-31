# dsh-wsl-folder

简体中文 | [English](README.en.md)

[![npm](https://img.shields.io/npm/v/dsh-wsl-folder?logo=npm&label=npm)](https://www.npmjs.com/package/dsh-wsl-folder)
[![test](https://github.com/LyuYuxin/dsh-wsl-folder/actions/workflows/test.yml/badge.svg)](https://github.com/LyuYuxin/dsh-wsl-folder/actions/workflows/test.yml)
[![license](https://img.shields.io/npm/l/dsh-wsl-folder)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-%3E%3D0.2.1--rc.3-blue)](https://github.com/deepseek-ai/deepseek-harness)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件，适用于 Windows 上的 Desktop 和 `dsh web`：在侧栏的「添加工作区」按钮里加入 **WSL 文件夹**，浏览 WSL 发行版，把任意 Linux 目录一键添加为工作区；这个工作区的侧栏终端会直接开在发行版里对应的 Linux 路径。当前版本 **1.1.0**。

## 截图

**第一步：选择文件夹来源。** 「Windows 文件夹」沿用系统选择器；下方是最近用过的 WSL 位置和使用提示。

![添加工作区：选择 Windows 文件夹或 WSL 文件夹](https://raw.githubusercontent.com/LyuYuxin/dsh-wsl-folder/v1.1.0/assets/screenshot-1.webp)

**第二步：浏览 WSL 目录。** 右上角切换发行版，面包屑跳转，铅笔图标直接输入路径，底部显示将要注册的路径。

![选择 WSL 目录对话框](https://raw.githubusercontent.com/LyuYuxin/dsh-wsl-folder/v1.1.0/assets/screenshot-2.webp)

**打开后：侧栏终端直接进入发行版**，标签为 `WSL · <发行版>`，起始目录就是工作区。

![WSL 工作区的侧栏终端](https://raw.githubusercontent.com/LyuYuxin/dsh-wsl-folder/v1.1.0/assets/screenshot-3.webp)

## 使用方法

1. 点侧栏工作区标题栏里的 **「+」（添加工作区）**，或新会话页工作区选择器里的「添加工作区」。
2. 选 **WSL 文件夹**（选「Windows 文件夹」则和原来一样弹出系统选择器）。
3. 右上角下拉框选发行版，默认是 WSL 的默认发行版，并从你的主目录开始。
4. 点文件夹进入下一级；点面包屑跳回上级；点铅笔图标可以直接输入 Linux 路径并回车。
5. 到达目标目录后点 **「打开」**，DSH 会把它注册为工作区并打开新会话。

使用提示：

- 在这个工作区里打开**侧栏终端**，进入的就是发行版的 shell，起始目录就是工作区。
- **agent** 通过 `\\wsl.localhost` 共享读写工作区文件；要跑 Linux 命令时，让它调用 `wsl.exe -e <命令>`，或直接在侧栏终端里操作。
- 第一步的「最近的 WSL 位置」可以一键重新添加用过的目录。
- 发行版处于停止状态时，第一次打开会稍等一两秒让它启动；插件在弹出第一个对话框时就已经在后台唤醒它。

## 功能

- **一个按钮、两种来源。** 点工作区标题栏原有的「+」（新会话页的工作区选择器同理），先选 **Windows 文件夹**（与原来一样的系统选择器）或 **WSL 文件夹**。
- **WSL 目录浏览器。** 选发行版、点面包屑跳转、点铅笔直接输入 Linux 路径、显示或隐藏点目录，最后点「打开」。Linux 目录以 `\\wsl.localhost\<发行版>\...` 的形式注册为工作区。
- **挂载进来的 Windows 盘也能选。** `/mnt/c`、`/mnt/d` 等目录（WSL 的 `\\wsl.localhost` 共享读不了它们）直接读对应的 Windows 盘；选中后注册成真实的 Windows 路径（如 `/mnt/d/proj` → `D:\proj`），agent 的工具可以原生读写。插件会记住它是从哪个发行版选的，所以这个工作区的侧栏终端同样开在 WSL 里。
- **最近位置。** 用过的 WSL 目录会出现在第一步的列表里，点一下直接添加。
- **终端开在 WSL 里。** 在 WSL 工作区里打开侧栏终端，得到的是 `wsl.exe -d <发行版> --cd <Linux 路径>`，也就是发行版的登录 shell，起始目录就是工作区；标签名为 `WSL · <发行版>`。Windows 工作区和 agent 自己的工具不受影响。
- **agent 能在 WSL 工作区里写文件。** DSH 自带的写入和编辑工具在 `\\wsl.localhost` 上会失败（新建文件报 `ENOTSUP`，修改文件报 `GetFileSecurityW EIO`），因为 WSL 的 9P 共享不支持硬链接和 Windows 安全描述符。插件只对这类路径改用共享支持的等价操作，写入行为（版本校验、不覆盖别人新建的文件、原子替换）保持不变。
- **快。** 发行版列表读注册表，主目录从发行版的 `/etc/wsl.conf` 与 `/etc/passwd` 解析，目录列表走 `\\wsl.localhost` 共享，热路径上不再调用 `wsl.exe`（每次调用要 1–3 秒）。打开对话框时就在后台唤醒发行版并预取主目录，列表结果会缓存，返回上一级时立即显示。
- **原生外观。** 对话框沿用 DSH 自带 Modal、按钮、菜单项和「选择工作区目录」对话框的结构与样式，只用 `--dsw-*` 主题变量，深浅色主题和皮肤都会跟随。

## 要求

- Windows 10/11，已安装 WSL（WSL2 推荐）。
- DeepSeek Harness `>= 0.2.1-rc.3`（Desktop 或 `dsh web`）。内部接口已对工作区里的 0.2.1-rc.3 源码核对，并用 `npm pack` 把 0.2.1-rc.5 的官方 `@deepseek-ai/*` 包临时下载到系统临时目录逐类比对（临时文件用完即删，仓库里没有 rc.5 源码）。
- 发行版里不需要安装任何东西。

## 安装

在 DSH 的「插件」页面按包名 `dsh-wsl-folder` 安装；或在终端执行：

```powershell
dsh plugin --profile desktop add dsh-wsl-folder
```

装好后**完全退出并重启** DSH，侧栏终端的重定向需要在 Host 启动时挂上。

## 配置

插件行的 `config` 有四个字段：

| 字段 | 默认 | 说明 |
|---|---|---|
| `terminal` | `true` | WSL 工作区的侧栏终端是否开在发行版里。设为 `false` 时终端保持 DSH 默认的 Windows shell |
| `write` | `true` | 是否让 agent 的写入、编辑工具能写 `\\wsl.localhost` 上的文件。设为 `false` 时保持 DSH 原样（在 WSL 工作区里写文件会失败） |
| `paths` | `true` | 是否修复丢了开头分隔符的 WSL 路径（见下方「路径修复」）。设为 `false` 时保持 DSH 原样，同时关闭对 Node 文件系统函数的进程级补丁 |
| `remote` | `false` | 是否允许非本机客户端调用插件的 5 个 Host 路由。默认只接受回环地址（`127.0.0.1`/`::1`）；DSH 的 Web 服务监听在局域网地址时，其他机器无法通过本插件浏览或注册 WSL 目录，只有显式设为 `true` 才放开 |

在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: dsh-wsl-folder
  name: 'dsh-wsl-folder'
  config:
    terminal: false
```

## 工作原理

- **按钮。** DSH 的工作区浏览器在「+」后面声明了一个目录选择插槽（`sidebar.workspaces.directoryFlow`，新会话页是 `conversation.hero.workspace.directoryFlow`）。本插件以更低的优先级占住这两个插槽，自己的对话框画在 `shell.overlay` 里；选 Windows 文件夹时调用的正是 DSH 原生选择器那一个接口。
- **Host 路由。** `GET /dsh-wsl-folder/{distros,home,list,warm}` 和 `POST /dsh-wsl-folder/pick`（JSON 请求体，决定要注册的路径），都拒绝跨站请求，并且默认只接受来自回环地址（`127.0.0.1`/`::1`）的客户端；Web 服务监听在局域网地址时，其他机器无法借这些路由浏览目录、写记忆文件或唤醒发行版。需要远程访问时把插件行的 `remote` 设为 `true`。
- **Windows 盘与兜底。** 路径落在自动挂载根（默认 `/mnt/`，读 `/etc/wsl.conf` 的 `[automount] root`）下的盘符目录时，直接读 Windows 路径；`\\wsl.localhost` 共享读不了的其他目录，改在发行版里用 `find` 列出。从 WSL 选中的 Windows 盘目录记在 `<DSH 主目录>/dsh-wsl-folder.json`。
- **终端。** 侧栏终端由 DSH 的 terminal controller 通过 `subprocess.spawnTerminal({ argv, cwd })` 创建。插件只在「正在分配侧栏终端」这一段调用里（用 `AsyncLocalStorage` 标记）检查 `cwd`：如果是 `\\wsl.localhost\<发行版>\<路径>`，或位于记录过的 Windows 盘目录里，就把 shell 换成 `wsl.exe -d <发行版> --cd <路径>`。插件卸载时恢复原方法。
- **写文件。** DSH 的本地文件系统（`LocalFileSystem`，沙箱版本继承自它）先把内容写进同目录下的临时文件，再「发布」：新建文件用硬链接（目标已存在就失败，避免覆盖别人刚建的文件），在 Windows 上修改文件则先复制安全描述符再调用 `ReplaceFileW`。插件包装它的 `writeText` / `editText`：目标在 `\\wsl.localhost` 上时，这一次调用改用排他复制（同样在目标已存在时失败）和 `rename` 覆盖；其他路径不经过任何改动。
- **路径修复。** Windows 上以单个 `\` 开头的路径是「当前盘根目录」，所以 `\wsl.localhost\...` 会被解析成 `C:\wsl.localhost\...`——一个不可能存在的路径。WSL 工作区里读 `AGENTS.md` 时报的就是这个错。DSH 自身不会生成这种写法，是某处调用链把开头的一个分隔符弄丢了；插件在文件系统唯一的入口 `resolve`（以及 `lstat`）上做修复：只对「开头一个分隔符 + `wsl.localhost`/`wsl$` + 已安装的发行版名」的路径补回分隔符，其他路径原样通过。另有一层「最后一公里」修复：进程级包装 `node:fs` 与 `node:fs/promises` 的一组读取函数（`stat`/`lstat`/`readFile`/`readdir`/`open`/`access`/`realpath` 及其同步版本），让已经自己解析过路径的组件（如侧栏文档预览）也走修复，并调用 `syncBuiltinESMExports()` 刷新 DSH 模块的具名导入。这是**进程全局的副作用**：`paths: false` 会同时关闭这两层修复和诊断日志。

## 已知限制

- **agent 的工具仍是 Windows 的。** 本插件管添加工作区、侧栏终端和共享上的写入；agent 的 shell 和文件工具照常在 Windows 侧运行，Linux 目录通过 `\\wsl.localhost` 共享访问（速度比原生 Linux 慢）。
- **WSL 共享上新建文件不是原子的。** 排他复制在极短时间内可能让别的程序看到写了一半的新文件（修改已有文件仍是原子的 `rename`）。
- **共享读不了的非 Windows 盘目录**（例如权限受限的目录）改由发行版里的 `find` 列出，每次要 1–3 秒；没有读权限时会明确提示。
- 在插件之外（比如 DSH 自带的系统选择器）直接添加的 Windows 目录不会被记录，它们的终端仍是 Windows shell。
- **WSL 工作区的终端总是开在 WSL 里**，即使在终端菜单里选了 PowerShell。需要 Windows shell 时把 `terminal` 设为 `false`。
- 终端里的 `DSH_SESSION_ID` 环境变量不会传进发行版。
- 终端重定向、写入修复和路径修复依赖 DSH 内部的 `TerminalController.spawn`、`spawnTerminal`、`LocalFileSystem` 的 `writeText` / `editText` / `internals` / `resolve`（路径修复还会进程级包装 Node 的 `fs` / `fs/promises` 读取函数）；DSH 改了这些地方时对应功能会退回 DSH 原样（终端变回 Windows shell、或在 WSL 工作区写文件、读 `AGENTS.md` 再次失败），添加 WSL 工作区仍然可用。

## 测试

```powershell
node --check index.js
node --check client.js
node --test
```

纯函数、`/etc/wsl.conf` 与注册表解析、HTTP 路由（用 mock 的 `req`/`res` 覆盖方法、跨站、回环限制、Content-Type、JSON 体积上限和错误映射）、终端重定向、写入修复、路径修复（含进程级 fs 包装的挂载/还原）和诊断日志轮转都有不依赖 DSH 的单元测试；在装有 WSL 的 Windows 上，还会对真实发行版跑一遍路由，并在真实的 9P 共享上验证新建、不覆盖、修改文件——WSL 不可用时这一节显示为 skipped，其余测试照常通过。CI 在 `windows-latest` + Node 22/24 上运行同样的命令，并用 `npm pack --dry-run` 校验发布文件清单（[workflow](.github/workflows/test.yml)）。

## 许可证

[MIT](LICENSE)
