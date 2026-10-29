# dsh-wsl-folder

简体中文 | [English](README.en.md)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件，适用于 Windows 上的 Desktop 和 `dsh web`：在侧栏的「添加工作区」按钮里加入 **WSL 文件夹**，浏览 WSL 发行版，把任意 Linux 目录一键添加为工作区；这个工作区的侧栏终端会直接开在发行版里对应的 Linux 路径。

## 功能

- **一个按钮、两种来源。** 点工作区标题栏原有的「+」（新会话页的工作区选择器同理），先选 **Windows 文件夹**（与原来一样的系统选择器）或 **WSL 文件夹**。
- **WSL 目录浏览器。** 选发行版、点面包屑跳转、点铅笔直接输入 Linux 路径、显示或隐藏点目录，最后点「打开」。选中的目录以 `\\wsl.localhost\<发行版>\...` 的形式注册为工作区。
- **最近位置。** 用过的 WSL 目录会出现在第一步的列表里，点一下直接添加。
- **终端开在 WSL 里。** 在 WSL 工作区里打开侧栏终端，得到的是 `wsl.exe -d <发行版> --cd <Linux 路径>`，也就是发行版的登录 shell，起始目录就是工作区；标签名为 `WSL · <发行版>`。Windows 工作区和 agent 自己的工具不受影响。
- **快。** 发行版列表读注册表，主目录从发行版的 `/etc/wsl.conf` 与 `/etc/passwd` 解析，目录列表走 `\\wsl.localhost` 共享，热路径上不再调用 `wsl.exe`（每次调用要 1–3 秒）。打开对话框时就在后台唤醒发行版并预取主目录，列表结果会缓存，返回上一级时立即显示。
- **原生外观。** 对话框沿用 DSH 自带 Modal、按钮、菜单项和「选择工作区目录」对话框的结构与样式，只用 `--dsw-*` 主题变量，深浅色主题和皮肤都会跟随。

## 要求

- Windows 10/11，已安装 WSL（WSL2 推荐）。
- DeepSeek Harness `>= 0.2.1-rc.3`（Desktop 或 `dsh web`）。
- 发行版里不需要安装任何东西。

## 安装

在 DSH 的「插件」页面按包名 `dsh-wsl-folder` 安装；或在终端执行：

```powershell
dsh plugin --profile desktop add dsh-wsl-folder
```

装好后**完全退出并重启** DSH，侧栏终端的重定向需要在 Host 启动时挂上。

## 配置

插件行的 `config` 只有一个字段：

| 字段 | 默认 | 说明 |
|---|---|---|
| `terminal` | `true` | WSL 工作区的侧栏终端是否开在发行版里。设为 `false` 时终端保持 DSH 默认的 Windows shell |

在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: dsh-wsl-folder
  name: 'dsh-wsl-folder'
  config:
    terminal: false
```

## 工作原理

- **按钮。** DSH 的工作区浏览器在「+」后面声明了一个目录选择插槽（`sidebar.workspaces.directoryFlow`，新会话页是 `conversation.hero.workspace.directoryFlow`）。本插件以更低的优先级占住这两个插槽，自己的对话框画在 `shell.overlay` 里；选 Windows 文件夹时调用的正是 DSH 原生选择器那一个接口。
- **Host 路由。** 只读接口 `GET /dsh-wsl-folder/{distros,home,list,warm}`，拒绝跨站请求。
- **终端。** 侧栏终端由 DSH 的 terminal controller 通过 `subprocess.spawnTerminal({ argv, cwd })` 创建。插件只在「正在分配侧栏终端」这一段调用里（用 `AsyncLocalStorage` 标记）检查 `cwd`：如果是 `\\wsl.localhost\<发行版>\<路径>`，就把 shell 换成 `wsl.exe -d <发行版> --cd <路径>`。插件卸载时恢复原方法。

## 已知限制

- **agent 的工具仍是 Windows 的。** 本插件只管添加工作区和侧栏终端；agent 的 shell 和文件工具照常在 Windows 侧运行，通过 `\\wsl.localhost` 共享访问文件（速度比原生 Linux 慢）。
- **WSL 工作区的终端总是开在 WSL 里**，即使在终端菜单里选了 PowerShell。需要 Windows shell 时把 `terminal` 设为 `false`。
- 终端里的 `DSH_SESSION_ID` 环境变量不会传进发行版。
- 终端重定向依赖 DSH 内部的 `TerminalController.spawn` 与 `spawnTerminal` 方法；DSH 改了这两处时重定向会失效（不会报错，终端退回 Windows shell），添加 WSL 工作区仍然可用。

## 测试

```powershell
node test/host.test.mjs
```

纯函数和终端重定向用假对象测试；在装有 WSL 的 Windows 上还会对真实发行版跑一遍路由并打印耗时。

## 许可证

[MIT](LICENSE)
