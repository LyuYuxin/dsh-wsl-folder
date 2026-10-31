# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [1.1.0] - 2026-10-30

Release-quality pass: the host half now has a dependency-free test suite and a Windows CI workflow. The
internally patched members were verified against the `0.2.1-rc.3` sources extracted in this workspace and
against `0.2.1-rc.5` by `npm pack`-ing its official `@deepseek-ai/*` packages into a temporary directory
and comparing the same classes/prototypes (the temporary files were deleted; no rc.5 sources are kept in
the repository). No architecture changes; the fixes below are small and local.

### Added

- `node:test` suite (`test/host.test.mjs`, 34 tests) with no runtime dependencies. It covers the pure
  path/`wsl.conf`/registry helpers; the HTTP routes and `serve()` framing with mock `req`/`res`
  (method, cross-site `sec-fetch-site`, the loopback restriction and its `remote: true` opt-in,
  Content-Type, 4096-byte JSON body limit, error mapping, query parsing); terminal redirect, write
  support and path repair with fakes; the process-wide Node-fs patch (`installWslPathDiagnostics`) and
  its restore; diagnostics-log rotation; concurrent `pick` and `rememberFolder` writers; and the
  plugin's route registration/teardown. The real-WSL section keeps the real distribution and 9P-share
  checks but now skips cleanly when no distribution can boot. `serve`, `routes`, `decode`,
  `patchMethod`, `RouteError`, `isLoopbackAddress`, `rememberFolder` and `noteWslPath` are exported,
  and `installWslPathRepair` accepts a fixed distribution set, so the tests do not need a WSL
  installation; `resetForTests()` clears every cache.
- `.github/workflows/test.yml`: `windows-latest`, Node 22/24 matrix, `node --check` for both halves,
  `node --test`, and `npm pack --dry-run` so a wrong `files`/`exports` set fails the build.
- README badges (npm version, CI, license, DSH requirement), README tests sections rewritten, and the
  audit method (rc.3 sources + temporary rc.5 npm packs) documented in the requirements.

### Fixed

- **Security:** the five Host routes were reachable from any client that could reach DSH's web server
  when it listens on a LAN address, and `Sec-Fetch-Site` is only a CSRF signal (a missing header was
  accepted). They now accept loopback peers (`127.0.0.1`/`::1`, IPv4-mapped included) only; a new
  plugin-row option `remote: true` is the explicit opt-in for remote clients. Requests without a
  socket (e.g. synthetic/internal) are refused for these routes.
- Concurrent `pick` calls could race in the remembered-folder file: both used `<file>.<pid>.tmp`, so
  one rename could fail with `ENOENT` and lose the other entry. Writes are now serialized and use a
  unique temp name, and a shared loading promise stops a second caller from seeing the empty map
  before the first read finishes and overwriting the file with it.
- Remembered `dsh-wsl-folder.json` entries are now normalized and defended in depth: `path` must be an
  absolute Linux path, and `..`/NUL/backslash values or a non-drive-letter `target` are dropped
  (previously a corrupt entry could throw inside `wslTargetOf()` when a sidebar terminal was
  allocated). A direct `rememberFolder()` call rejects them with `bad-path`.
- WSL's UTF-16LE output whose text contains no ASCII (a Chinese-only `wsl.exe` error, for example) has
  no NUL byte to detect; the BOM now identifies it first, so the message is readable instead of
  mojibake.
- `drvfsWindowsPath()` now normalizes the automount root it is given (`/win`, `/win/`, `win/`), so a
  custom `[automount] root` maps `/win/c/...` to `C:\...` instead of failing; an empty root keeps
  WSL's `/mnt/` default.
- `parseWslUnc()` normalizes `.`/`..`/duplicate separators, and `.`/`..` are no longer accepted as a
  distribution name (they are valid filename characters but would become UNC traversal).
- `wslConfValue()` keeps quoted semicolons (`command = "a; b"`) and compares section/key names
  case-insensitively; `parseLxss()` no longer truncates a distribution name at the first space.
- The path-diagnostics log is now size-bounded: the size is checked on every write and the file is
  rotated to a single `.1` file when it exceeds 256 KiB, through one serialized writer, so a
  long-lived Host cannot grow it forever.
- Client: a malformed `dsh-wsl-folder.recent` localStorage value no longer throws during render or in
  the pick handler (previously an unhandled rejection), and the home-directory cache is revalidated
  instead of being kept for the page's lifetime.

### Changed

- `package.json` version `1.1.0`; `npm test` now runs `node --test` and `npm run check` runs the three
  syntax checks.
- README documents the process-global side effect of the `paths` repair (`node:fs` /
  `node:fs/promises` wrapping plus `syncBuiltinESMExports()`, all disabled by `paths: false`) and the
  new `remote` option.
- Readme screenshot URLs point at the `v1.1.0` tag.

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
  was never loaded there and the Sidebar's document preview failed. The separator is now restored
  in two places: `resolve`/`lstat` on the filesystem provider, and every Node filesystem call —
  the latter covers components that resolve the address-derived path themselves before reading
  (`dsh-better-sidebar` does). Paths naming an installed distribution only; the caller of any
  remaining wrong spelling is recorded in `<DSH home>/dsh-wsl-folder-diagnostics.log`. New `paths`
  option (default `true`) turns the repair off.

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

[1.1.0]: https://github.com/LyuYuxin/dsh-wsl-folder/releases/tag/v1.1.0
[1.0.1]: https://github.com/LyuYuxin/dsh-wsl-folder/releases/tag/v1.0.1
[1.0.0]: https://github.com/LyuYuxin/dsh-wsl-folder/releases/tag/v1.0.0
