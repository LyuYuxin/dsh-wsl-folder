# dsh-wsl-folder

[简体中文](README.md) | English

[![npm](https://img.shields.io/npm/v/dsh-wsl-folder?logo=npm&label=npm)](https://www.npmjs.com/package/dsh-wsl-folder)
[![test](https://github.com/LyuYuxin/dsh-wsl-folder/actions/workflows/test.yml/badge.svg)](https://github.com/LyuYuxin/dsh-wsl-folder/actions/workflows/test.yml)
[![license](https://img.shields.io/npm/l/dsh-wsl-folder)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-%3E%3D0.2.1--rc.3-blue)](https://github.com/deepseek-ai/deepseek-harness)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin for Desktop and `dsh web` on Windows. It adds **WSL folder** to the sidebar's Add workspace button: browse a WSL distribution and add any Linux directory as a workspace in one click. Sidebar terminals of that workspace open inside the distribution, at the matching Linux path. Current version: **1.1.0**.

## Screenshots

**Step 1: choose where the folder is.** Windows folder keeps the system chooser; below are recent WSL locations and usage tips.

![Add workspace: Windows folder or WSL folder](https://raw.githubusercontent.com/LyuYuxin/dsh-wsl-folder/v1.1.0/assets/screenshot-1.webp)

**Step 2: browse the distribution.** Switch distributions at the top right, jump through the breadcrumb, or click the pencil to type a path; the footer shows the path that will be registered.

![Select WSL Directory dialog](https://raw.githubusercontent.com/LyuYuxin/dsh-wsl-folder/v1.1.0/assets/screenshot-2.webp)

**Then: sidebar terminals open inside the distribution**, titled `WSL · <distro>` and starting in the workspace.

![Sidebar terminal of a WSL workspace](https://raw.githubusercontent.com/LyuYuxin/dsh-wsl-folder/v1.1.0/assets/screenshot-3.webp)

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
- **WSL directory browser.** Pick a distribution, jump through the breadcrumb, click the pencil to type a Linux path, show or hide dot directories, then click Open. Linux directories are registered as `\\wsl.localhost\<distro>\...` workspaces.
- **Windows drives mounted into WSL work too.** Directories under `/mnt/c`, `/mnt/d`, ... (which WSL's `\\wsl.localhost` share cannot serve) are read from the Windows drive directly and registered as their real Windows path (`/mnt/d/proj` → `D:\proj`), so the agent's tools access them natively. The plugin remembers which distribution they were picked from, so their sidebar terminals open in WSL as well.
- **Recent locations.** WSL directories you added before appear in the first step; one click adds them again.
- **Terminals open in WSL.** A sidebar terminal in a WSL workspace runs `wsl.exe -d <distro> --cd <linux path>`, the distribution's login shell started in the workspace, titled `WSL · <distro>`. Windows workspaces and the agent's own tools are unaffected.
- **The agent can write files in WSL workspaces.** DSH's write and edit tools fail on `\\wsl.localhost` (`ENOTSUP` for a new file, `GetFileSecurityW EIO` for an edit) because WSL's 9P share supports neither hard links nor Windows security descriptors. For those paths only, the plugin swaps in equivalent operations the share supports; the write semantics (version guard, no-clobber create, atomic replacement) stay the same.
- **Fast.** Distributions come from the registry, the home directory from the distribution's `/etc/wsl.conf` and `/etc/passwd`, and listings from the `\\wsl.localhost` share, so nothing on the hot path spawns `wsl.exe` (1–3 s per spawn). Opening the dialog boots the distribution and prefetches the home listing in the background; listings are cached, so stepping back is instant.
- **Native look.** The dialogs follow the structure and styles of DSH's own Modal, Button, menu items and Select Workspace Directory dialog and use only `--dsw-*` theme tokens, so light/dark themes and skins apply.

## Requirements

- Windows 10/11 with WSL (WSL2 recommended).
- DeepSeek Harness `>= 0.2.1-rc.3` (Desktop or `dsh web`). The internal APIs were checked against the 0.2.1-rc.3 sources in this workspace, and against 0.2.1-rc.5 by `npm pack`-ing its official `@deepseek-ai/*` packages into a temporary directory and comparing the same classes/prototypes (the temporary files were deleted; no rc.5 sources are kept in the repository).
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
| `write` | `true` | Let the agent's write and edit tools write files on `\\wsl.localhost`. `false` keeps DSH unchanged (writes in WSL workspaces fail) |
| `paths` | `true` | Repair WSL paths that lost their leading separator (see "Path repair" below). `false` keeps DSH unchanged and also disables the process-wide Node filesystem patch |
| `remote` | `false` | Let non-loopback clients call the plugin's five Host routes. By default only `127.0.0.1`/`::1` peers are accepted, so when DSH's web server listens on a LAN address other machines cannot use this plugin to browse or register WSL directories; set it to `true` to allow them |

Override it in your profile's `cordis.patch.yml`:

```yaml
- id: dsh-wsl-folder
  name: 'dsh-wsl-folder'
  config:
    terminal: false
```

## How it works

- **Button.** DSH's workspace browser declares a directory-flow slot behind "+" (`sidebar.workspaces.directoryFlow`, and `conversation.hero.workspace.directoryFlow` on the New Session page). This plugin occupies both at a lower priority and draws its dialogs in `shell.overlay`; the Windows choice calls the very same API as DSH's native chooser.
- **Host routes.** `GET /dsh-wsl-folder/{distros,home,list,warm}` and `POST /dsh-wsl-folder/pick` (JSON body; decides the path to register). Cross-site requests are refused, and only loopback peers (`127.0.0.1`/`::1`) are accepted by default, so when the web server listens on a LAN address other machines cannot use these routes to browse directories, write the remembered-folder file or boot distributions. Set `remote: true` on the plugin row to allow them.
- **Windows drives and fallback.** A path on a drive under the automount root (default `/mnt/`, read from `[automount] root` in `/etc/wsl.conf`) is read from the Windows path directly; any other directory the `\\wsl.localhost` share refuses is listed by `find` inside the distribution. Windows-drive folders picked from WSL are remembered in `<DSH home>/dsh-wsl-folder.json`.
- **Terminals.** DSH's terminal controller creates sidebar terminals through `subprocess.spawnTerminal({ argv, cwd })`. Only inside that allocation (tracked with `AsyncLocalStorage`) the plugin checks `cwd`; a `\\wsl.localhost\<distro>\<path>`, or a directory inside a remembered Windows-drive folder, replaces the shell with `wsl.exe -d <distro> --cd <path>`. Unloading the plugin restores the original methods.
- **Writes.** DSH's local filesystem (`LocalFileSystem`, which the sandboxed one extends) writes the content to a temp file beside the target and then publishes it: a new file through a hard link (failing if the target appeared meanwhile, so another creator's file is never overwritten), and on Windows an existing file through a security-descriptor copy plus `ReplaceFileW`. The plugin wraps its `writeText` / `editText`: when the target is on `\\wsl.localhost`, that one call uses an exclusive copy (which fails the same way if the target exists) and a `rename` over the file. Other paths go through untouched.
- **Path repair.** On Windows a path starting with a single `\` is rooted on the current drive, so `\wsl.localhost\...` resolves to `C:\wsl.localhost\...`, which cannot exist — that is the error raised when a WSL workspace's `AGENTS.md` is read. DSH never produces that spelling itself, so some caller drops the leading separator; the plugin repairs it at the filesystem's one funnel, `resolve` (and `lstat`): a path of one separator plus `wsl.localhost`/`wsl$` plus an installed distribution gets the separator back, everything else passes through. A second "last mile" layer wraps a set of process-wide `node:fs` / `node:fs/promises` reads (`stat`/`lstat`/`readFile`/`readdir`/`open`/`access`/`realpath` and their sync variants) and calls `syncBuiltinESMExports()`, so components that resolved the path themselves (the sidebar document preview, for example) are repaired too. This is a **process-global side effect**: `paths: false` turns both layers, and the diagnostics log, off.

## Known limitations

- **The agent's tools stay on Windows.** This plugin adds workspaces, redirects sidebar terminals and repairs writes on the share; the agent's shell and file tools still run on Windows and reach Linux directories through the `\\wsl.localhost` share, which is slower than native Linux access.
- **Creating a file on the WSL share is not atomic.** The exclusive copy can briefly expose a partly written new file to other programs (edits of existing files still use an atomic `rename`).
- **Non-drive directories the share refuses** (restricted permissions, for example) are listed by `find` in the distribution, which takes 1–3 s each time; unreadable ones report a clear permission error.
- Windows folders added outside this plugin (DSH's own system chooser, for example) are not remembered, so their terminals stay on the Windows shell.
- **Terminals of a WSL workspace always open in WSL**, even when PowerShell is chosen in the terminal menu. Set `terminal: false` for Windows shells.
- `DSH_SESSION_ID` is not forwarded into the distribution.
- The terminal redirect and the write repair wrap DSH internals: `TerminalController.spawn`, `spawnTerminal`, and `LocalFileSystem`'s `writeText` / `editText` with its `internals`; the path repair additionally wraps process-wide Node `fs` / `fs/promises` reads. If DSH changes them, the affected feature falls back to DSH's own behavior (Windows shell terminals, or failing writes in WSL workspaces); adding WSL workspaces keeps working.

## Tests

```powershell
node --check index.js
node --check client.js
node --test
```

Dependency-free unit tests cover the pure helpers, the `/etc/wsl.conf` and registry parsers, the HTTP routes (mock `req`/`res` for method, cross-site, loopback restriction, Content-Type, JSON body limit and error mapping), the terminal redirect, the write repair, the path repair (including mounting/restoring the process-wide fs patch) and the diagnostics-log rotation. On Windows with a bootable WSL distribution a real-distribution section also exercises the routes and checks new-file, no-clobber and edit writes on the real 9P share; when WSL is unavailable that section is skipped and everything else still passes. CI runs the same commands on `windows-latest` with Node 22/24 and verifies the published file list with `npm pack --dry-run` ([workflow](.github/workflows/test.yml)).

## License

[MIT](LICENSE)
