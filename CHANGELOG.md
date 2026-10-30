# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [1.0.1] - 2026-10-29

### Fixed

- The agent's write and edit tools failed in `\\wsl.localhost` workspaces: creating a file reported
  `ENOTSUP ... link`, editing one `GetFileSecurityW EIO`, because WSL's 9P share supports neither
  hard links nor Windows security descriptors. For targets on the share only, DSH's own writer now
  publishes with an exclusive copy (same no-clobber `EEXIST` result) and a `rename` over the file.
  New `write` option (default `true`) turns this off.
- Browsing `/mnt/c`, `/mnt/d`, ... failed with `EPERM` because WSL's `\\wsl.localhost` share cannot
  serve Windows drives mounted into the distribution. Those directories are now read from the
  Windows drive directly (honouring `[automount] root` in `/etc/wsl.conf`).
- Picking such a directory registers its real Windows path (`/mnt/d/proj` → `D:\proj`) instead of an
  unusable `\\wsl.localhost\...\mnt\d\proj` path. The WSL origin is remembered in
  `<DSH home>/dsh-wsl-folder.json`, so sidebar terminals there still open inside the distribution.
- Other directories the share refuses are listed with `find` inside the distribution; unreadable
  ones report a short permission error instead of a raw command line.
- A WSL path that reached the filesystem with only one leading separator resolved to
  `C:\wsl.localhost\...` (a drive-rooted path that cannot exist), so the workspace's `AGENTS.md`
  was never loaded there. `resolve`/`lstat` now restore the separator for paths naming an installed
  distribution, whatever produced the short spelling. New `paths` option (default `true`) turns
  this off.

### Changed

- The path to register is decided by the Host (`POST /dsh-wsl-folder/pick`) rather than built in
  the browser; listings report it as `target`.

### Documentation

- README screenshots: the source chooser, the WSL directory browser, and a WSL sidebar terminal.

## [1.0.0] - 2026-10-29

### Added

- "WSL folder" choice behind the sidebar's Add workspace button and the New Session workspace
  picker; "Windows folder" keeps DSH's native system chooser.
- WSL directory browser: distribution selector, breadcrumb, editable Linux path, hidden-folder
  toggle; the chosen directory is registered as a `\\wsl.localhost\<distro>\...` workspace.
- Recent WSL locations for one-click re-adding.
- Sidebar terminals of a WSL workspace open inside the distribution
  (`wsl.exe -d <distro> --cd <path>`), titled `WSL · <distro>`; `terminal: false` turns this off.
- In-dialog usage tips.
- Chinese and English UI, plugin title, description and icon.

### Performance

- No `wsl.exe` spawn on the hot path: distributions come from the registry, the home directory
  from `/etc/wsl.conf` and `/etc/passwd`, listings from the `\\wsl.localhost` share.
- The distribution is booted and the home listing prefetched while the first dialog is open;
  listings are cached and revalidated in the background.

[1.0.1]: https://github.com/LyuYuxin/dsh-wsl-folder/releases/tag/v1.0.1
[1.0.0]: https://github.com/LyuYuxin/dsh-wsl-folder/releases/tag/v1.0.0
