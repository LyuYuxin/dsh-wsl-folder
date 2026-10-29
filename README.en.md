# dsh-wsl-folder

[简体中文](README.md) | English

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin for Desktop and `dsh web` on Windows. It adds **WSL folder** to the sidebar's Add workspace button: browse a WSL distribution and add any Linux directory as a workspace in one click. Sidebar terminals of that workspace open inside the distribution, at the matching Linux path.

## Usage

1. Click **"+" (Add workspace)** in the sidebar's workspace header, or Add workspace in the New Session page's workspace picker.
2. Choose **WSL folder** (Windows folder opens the system chooser as before).
3. Pick a distribution in the top-right list; it defaults to your default WSL distribution and starts in your home directory.
4. Click a folder to enter it, a breadcrumb to go back up, or the pencil to type a Linux path and press Enter.
5. Click **Open** in the target directory. DSH registers it as a workspace and opens a new session.

Tips:

- **Sidebar terminals** in that workspace open the distribution's shell, starting in the workspace.
- The **agent** reads and writes workspace files through the `\\wsl.localhost` share; for Linux commands ask it to call `wsl.exe -e <command>`, or use the sidebar terminal yourself.
- "Recent WSL locations" in the first step re-adds a directory in one click.
- A stopped distribution needs a second or two to boot the first time; the plugin already starts it in the background when the first dialog opens.

## Features

- **One button, two sources.** The existing "+" in the workspace header (and the workspace picker on the New Session page) first asks for a **Windows folder** (the same system chooser as before) or a **WSL folder**.
- **WSL directory browser.** Pick a distribution, jump through the breadcrumb, click the pencil to type a Linux path, show or hide dot directories, then click Open. The directory is registered as a workspace at `\\wsl.localhost\<distro>\...`.
- **Recent locations.** WSL directories you added before appear in the first step; one click adds them again.
- **Terminals open in WSL.** A sidebar terminal in a WSL workspace runs `wsl.exe -d <distro> --cd <linux path>`, the distribution's login shell started in the workspace, titled `WSL · <distro>`. Windows workspaces and the agent's own tools are unaffected.
- **Fast.** Distributions come from the registry, the home directory from the distribution's `/etc/wsl.conf` and `/etc/passwd`, and listings from the `\\wsl.localhost` share, so nothing on the hot path spawns `wsl.exe` (1–3 s per spawn). Opening the dialog boots the distribution and prefetches the home listing in the background; listings are cached, so stepping back is instant.
- **Native look.** The dialogs follow the structure and styles of DSH's own Modal, Button, menu items and Select Workspace Directory dialog and use only `--dsw-*` theme tokens, so light/dark themes and skins apply.

## Requirements

- Windows 10/11 with WSL (WSL2 recommended).
- DeepSeek Harness `>= 0.2.1-rc.3` (Desktop or `dsh web`).
- Nothing to install inside the distribution.

## Install

Install `dsh-wsl-folder` from DSH's Plugins page, or run:

```powershell
dsh plugin --profile desktop add dsh-wsl-folder
```

Then **quit and restart** DSH completely: the terminal redirect is installed when the Host starts.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `terminal` | `true` | Open sidebar terminals of WSL workspaces inside the distribution. `false` keeps DSH's default Windows shell |

Override it in your profile's `cordis.patch.yml`:

```yaml
- id: dsh-wsl-folder
  name: 'dsh-wsl-folder'
  config:
    terminal: false
```

## How it works

- **Button.** DSH's workspace browser declares a directory-flow slot behind "+" (`sidebar.workspaces.directoryFlow`, and `conversation.hero.workspace.directoryFlow` on the New Session page). This plugin occupies both at a lower priority and draws its dialogs in `shell.overlay`; the Windows choice calls the very same API as DSH's native chooser.
- **Host routes.** Read-only `GET /dsh-wsl-folder/{distros,home,list,warm}`; cross-site requests are refused.
- **Terminals.** DSH's terminal controller creates sidebar terminals through `subprocess.spawnTerminal({ argv, cwd })`. Only inside that allocation (tracked with `AsyncLocalStorage`) the plugin checks `cwd`; a `\\wsl.localhost\<distro>\<path>` replaces the shell with `wsl.exe -d <distro> --cd <path>`. Unloading the plugin restores the original methods.

## Known limitations

- **The agent's tools stay on Windows.** This plugin adds workspaces and redirects sidebar terminals; the agent's shell and file tools still run on Windows and reach files through the `\\wsl.localhost` share, which is slower than native Linux access.
- **Terminals of a WSL workspace always open in WSL**, even when PowerShell is chosen in the terminal menu. Set `terminal: false` for Windows shells.
- `DSH_SESSION_ID` is not forwarded into the distribution.
- The terminal redirect wraps DSH's internal `TerminalController.spawn` and `spawnTerminal`. If DSH changes them, the redirect silently stops (terminals fall back to the Windows shell); adding WSL workspaces keeps working.

## Tests

```powershell
node test/host.test.mjs
```

Pure helpers and the terminal redirect are tested with fakes; on Windows with WSL the routes also run against the real distribution and print timings.

## License

[MIT](LICENSE)
