# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

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

[1.0.0]: https://github.com/LyuYuxin/dsh-wsl-folder/releases/tag/v1.0.0
