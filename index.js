// Host half of dsh-wsl-folder.
//
// 1. JSON routes the browser half uses to browse WSL distributions:
//      GET  /dsh-wsl-folder/distros               -> { distros: [{ name, default, version }] }
//      GET  /dsh-wsl-folder/home?distro=X         -> { home }
//      GET  /dsh-wsl-folder/list?distro=X&path=/  -> { distro, path, parent, target, entries, truncated }
//      GET  /dsh-wsl-folder/warm?distro=X         -> { ok }   (boots the distribution in the background)
//      POST /dsh-wsl-folder/pick {distro, path}   -> { target }  (the Windows path to register)
//    Nothing on the hot path spawns wsl.exe (each spawn costs 1–3 s): distributions come from the
//    registry, the home directory from the distribution's own /etc/wsl.conf and /etc/passwd, and
//    listings from the \\wsl.localhost UNC view (a few ms once the distribution runs).
//    WSL's UNC share cannot serve Windows drives mounted into the distribution (drvfs: /mnt/c,
//    /mnt/d, ... -> EPERM), so those paths are listed and registered as their real Windows paths
//    (D:\...). Any other directory the share refuses is listed by `find` inside the distribution.
//
// 2. Sidebar terminals of a WSL workspace open inside the distribution. The terminal controller
//    spawns every sidebar terminal through `subprocess.spawnTerminal({ argv, cwd })` with the
//    Session's directory as `cwd`. While a sidebar terminal is being allocated (and only then,
//    tracked through AsyncLocalStorage), a `\\wsl.localhost\<distro>\<path>` cwd, or a Windows
//    folder that was picked from WSL (remembered in <dshHome>/dsh-wsl-folder.json), replaces the
//    Windows shell with `wsl.exe -d <distro> --cd <path>`. Agent tools and other workspaces are
//    untouched. Disable with `terminal: false` in this plugin row's config.
//
// 3. The agent's write and edit tools work inside \\wsl.localhost workspaces. DSH's local
//    filesystem publishes a new file through a hard link (no-clobber create) and, on Windows,
//    replaces an existing one through GetFileSecurityW + ReplaceFileW. WSL's 9P share supports
//    neither (ENOTSUP / EIO). For targets on the share only, the plugin hands that one call the
//    equivalents the share does support: an exclusive copy (same EEXIST no-clobber result) and a
//    rename over the file. Everything else keeps DSH's own behavior. Disable with `write: false`.

import { AsyncLocalStorage } from 'node:async_hooks'
import { execFile } from 'node:child_process'
import nodeFs, { constants as fsConstants } from 'node:fs'
import nodeFsPromises, { appendFile, copyFile, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, posix, win32 } from 'node:path'

export const name = 'dsh-wsl-folder'

const ROUTE = '/dsh-wsl-folder'
const UNC_HOST = 'wsl.localhost'
const MAX_ENTRIES = 2000
const DISTRO_NAME = /^[A-Za-z0-9._-]{1,128}$/
const DISTRO_TTL_MS = 30_000
const LXSS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss'

class RouteError extends Error {
  constructor(code, message, status = 200) {
    super(message)
    this.code = code
    this.status = status
  }
}

// ── WSL path helpers ───────────────────────────────────────────────────────────

/** `\\wsl.localhost\D\a\b` or `\\wsl$\D\a\b` (either slash) -> { distro, path: '/a/b' }. */
export function parseWslUnc(value) {
  if (typeof value !== 'string') return undefined
  // Namespaced spellings (`\\?\UNC\wsl.localhost\...`) name the same share.
  const plain = value.replace(/^[\\/]{2}[?.][\\/]UNC[\\/]/i, '\\\\')
  const match = /^[\\/]{2}(?:wsl\.localhost|wsl\$)[\\/]([^\\/]+)(?:[\\/](.*))?$/i.exec(plain)
  if (match === null || !DISTRO_NAME.test(match[1])) return undefined
  const rest = (match[2] ?? '').split(/[\\/]+/).filter(Boolean)
  return { distro: match[1], path: `/${rest.join('/')}` }
}

export function toUnc(distro, linuxPath) {
  const rest = linuxPath === '/' ? '' : linuxPath.slice(1).split('/').join('\\')
  return `\\\\${UNC_HOST}\\${distro}\\${rest}`
}

function requireDistro(value) {
  if (typeof value !== 'string' || !DISTRO_NAME.test(value)) {
    throw new RouteError('bad-distro', `invalid distribution name: ${String(value)}`, 400)
  }
  return value
}

function requireLinuxPath(value) {
  if (typeof value !== 'string' || value === '' || value.includes('\0') || value.includes('\\')) {
    throw new RouteError('bad-path', `invalid Linux path: ${String(value)}`, 400)
  }
  const normalized = posix.normalize(value.startsWith('/') ? value : `/${value}`)
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : '/'
}

function wslExe() {
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe')
}

// ── process helpers ────────────────────────────────────────────────────────────

/** wsl.exe prints UTF-16LE unless WSL_UTF8 is honoured; accept both. */
function decode(buffer) {
  if (!buffer || buffer.length === 0) return ''
  const text = buffer.includes(0) ? buffer.toString('utf16le') : buffer.toString('utf8')
  return text.replace(/^\uFEFF/, '')
}

function run(file, args, timeout, { raw = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      encoding: 'buffer',
      timeout,
      windowsHide: true,
      env: { ...process.env, WSL_UTF8: '1' },
    }, (error, stdout, stderr) => {
      if (error) {
        const failure = new RouteError('wsl-failed', (decode(stderr) || decode(stdout) || error.message).trim())
        failure.exitCode = typeof error.code === 'number' ? error.code : undefined
        reject(failure)
        return
      }
      resolve(raw ? stdout : decode(stdout))
    })
  })
}

// ── distributions ──────────────────────────────────────────────────────────────

/** Parse `reg query <Lxss> /s`: one subkey per distribution, plus the default's GUID. */
export function parseLxss(text) {
  const defaultGuid = /DefaultDistribution\s+REG_SZ\s+(\{[^}]+\})/i.exec(text)?.[1]?.toLowerCase()
  const distros = []
  for (const block of text.split(/\r?\n(?=HKEY_)/)) {
    const guid = /\\Lxss\\(\{[^}]+\})/i.exec(block)?.[1]?.toLowerCase()
    const distroName = /DistributionName\s+REG_SZ\s+(\S+)/i.exec(block)?.[1]
    if (guid === undefined || distroName === undefined || !DISTRO_NAME.test(distroName)) continue
    const version = Number.parseInt(/\bVersion\s+REG_DWORD\s+(0x[0-9a-f]+)/i.exec(block)?.[1] ?? '0x2', 16)
    const uid = Number.parseInt(/DefaultUid\s+REG_DWORD\s+(0x[0-9a-f]+)/i.exec(block)?.[1] ?? '0x0', 16)
    distros.push({ name: distroName, default: guid === defaultGuid, version, uid })
  }
  return distros
}

async function distrosFromWslExe() {
  const text = await run(wslExe(), ['-l', '-v'], 20_000)
  const distros = []
  for (const raw of text.split(/\r?\n/)) {
    const match = /^\s*(\*)?\s*(\S+)\s+(\S+)\s+(\d+)\s*$/.exec(raw)
    if (match === null || !DISTRO_NAME.test(match[2])) continue
    distros.push({ name: match[2], default: match[1] === '*', version: Number(match[4]), uid: undefined })
  }
  return distros
}

let distroCache // { at, value: Promise<distro[]> }

function listDistros() {
  if (distroCache !== undefined && Date.now() - distroCache.at < DISTRO_TTL_MS) return distroCache.value
  const value = run('reg.exe', ['query', LXSS_KEY, '/s'], 10_000)
    .then(parseLxss)
    .catch(() => [])
    .then((found) => (found.length > 0 ? found : distrosFromWslExe()))
  distroCache = { at: Date.now(), value }
  value.catch(() => { distroCache = undefined })
  return value
}

// ── home directory ─────────────────────────────────────────────────────────────

const homeCache = new Map()

/** One `key = value` from an INI-style /etc/wsl.conf section, when present. */
export function wslConfValue(text, wantedSection, wantedKey) {
  let section = ''
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/[#;].*$/, '').trim()
    const header = /^\[(.+)\]$/.exec(line)
    if (header !== null) { section = header[1].trim().toLowerCase(); continue }
    const pair = /^([\w.-]+)\s*=\s*"?([^"]*?)"?\s*$/.exec(line)
    if (section === wantedSection && pair !== null && pair[1].toLowerCase() === wantedKey) return pair[2]
  }
  return undefined
}

/** `[user] default=<name>` from /etc/wsl.conf, when present. */
export function wslConfDefaultUser(text) {
  const user = wslConfValue(text, 'user', 'default')
  return user === undefined || user === '' ? undefined : user
}

/** `[automount] root=` from /etc/wsl.conf, normalized to `/x/`; WSL's default is `/mnt/`. */
export function wslConfAutomountRoot(text) {
  const root = wslConfValue(text, 'automount', 'root')
  if (root === undefined || root.trim() === '') return '/mnt/'
  const trimmed = root.trim().replace(/\/+$/, '')
  return `${trimmed.startsWith('/') ? '' : '/'}${trimmed}/`.replace(/\/+/g, '/')
}

/**
 * The Windows path behind a drvfs mount: `/mnt/d/a/b` -> `D:\a\b` (with the distribution's
 * automount root). Returns undefined for any other Linux path.
 */
export function drvfsWindowsPath(linuxPath, root = '/mnt/') {
  const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`^${escaped}([a-zA-Z])(?:/(.*))?$`).exec(linuxPath)
  if (match === null) return undefined
  const rest = (match[2] ?? '').split('/').filter(Boolean).join('\\')
  return `${match[1].toUpperCase()}:\\${rest}`
}

const confCache = new Map() // distro -> { at, value: Promise<string> }

function wslConf(distro) {
  const cached = confCache.get(distro)
  if (cached !== undefined && Date.now() - cached.at < DISTRO_TTL_MS) return cached.value
  const value = readFile(`${toUnc(distro, '/')}etc\\wsl.conf`, 'utf8').catch(() => '')
  confCache.set(distro, { at: Date.now(), value })
  return value
}

async function automountRoot(distro) {
  return wslConfAutomountRoot(await wslConf(distro))
}

export function passwdHome(text, user) {
  for (const line of text.split(/\r?\n/)) {
    const fields = line.split(':')
    if (fields.length < 7) continue
    if (typeof user === 'string' ? fields[0] === user : Number(fields[2]) === user) return fields[5]
  }
  return undefined
}

async function homeFromFiles(distro) {
  const root = toUnc(distro, '/')
  const passwd = await readFile(`${root}etc\\passwd`, 'utf8')
  const conf = await wslConf(distro)
  const user = wslConfDefaultUser(conf)
  if (user !== undefined) return passwdHome(passwd, user)
  const uid = (await listDistros()).find((d) => d.name === distro)?.uid
  return uid === undefined ? undefined : passwdHome(passwd, uid)
}

async function resolveHome(distro) {
  let home
  try {
    home = await homeFromFiles(distro)
  } catch {
    home = undefined
  }
  if (typeof home !== 'string' || !home.startsWith('/')) {
    home = (await run(wslExe(), ['-d', distro, '-e', 'sh', '-c', 'printf %s "$HOME"'], 30_000)).trim()
  }
  return home.startsWith('/') ? requireLinuxPath(home) : '/'
}

function homeOf(distro) {
  let pending = homeCache.get(distro)
  if (pending === undefined) {
    pending = resolveHome(distro)
    homeCache.set(distro, pending)
    pending.catch(() => homeCache.delete(distro))
  }
  return pending
}

// ── listing ────────────────────────────────────────────────────────────────────

function errorCode(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? 'not-found'
    : error?.code === 'EACCES' || error?.code === 'EPERM' ? 'denied'
      : 'unreadable'
}

/** Subdirectory names read through a Windows-visible path (UNC share or drive letter). */
async function namesFromWindows(source) {
  const dirents = await readdir(source, { withFileTypes: true })
  const names = []
  const links = []
  for (const dirent of dirents) {
    if (dirent.isDirectory()) names.push(dirent.name)
    else if (dirent.isSymbolicLink()) links.push(dirent.name)
  }
  // A symlinked directory (or a junction on a Windows drive) counts when it resolves.
  const base = source.endsWith('\\') ? source : `${source}\\`
  const resolved = await Promise.all(links.slice(0, 200).map(async (entry) => {
    try {
      return (await stat(`${base}${entry}`)).isDirectory() ? entry : null
    } catch {
      return null
    }
  }))
  for (const entry of resolved) if (entry !== null) names.push(entry)
  return names
}

/** Subdirectory names read by `find` inside the distribution: slow, but it sees every mount. */
async function namesFromDistribution(distro, linuxPath) {
  const script = '[ -d "$1" ] || exit 3; [ -r "$1" ] && [ -x "$1" ] || exit 4; '
    + 'find -L "$1" -mindepth 1 -maxdepth 1 -type d -printf "%f\\0" 2>/dev/null; exit 0'
  let output
  try {
    output = await run(wslExe(), ['-d', distro, '-e', 'sh', '-c', script, 'sh', linuxPath], 30_000, { raw: true })
  } catch (error) {
    if (error?.exitCode === 3) throw new RouteError('not-found', `${linuxPath}: no such directory`)
    if (error?.exitCode === 4) throw new RouteError('denied', `${linuxPath}: permission denied for the distribution's default user`)
    throw error
  }
  return output.toString('utf8').split('\0').filter((entry) => entry !== '')
}

async function listDirectory(distro, linuxPath) {
  const windowsDrive = drvfsWindowsPath(linuxPath, await automountRoot(distro))
  const target = windowsDrive ?? toUnc(distro, linuxPath)
  let names
  try {
    names = await namesFromWindows(target)
  } catch (error) {
    // The UNC share refuses some mounts (EPERM); the distribution itself can still list them.
    if (windowsDrive !== undefined || errorCode(error) !== 'denied') throw new RouteError(errorCode(error), String(error?.message ?? error))
    names = await namesFromDistribution(distro, linuxPath)
  }
  names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }))
  const entries = names.slice(0, MAX_ENTRIES).map((entry) => ({
    name: entry,
    path: linuxPath === '/' ? `/${entry}` : `${linuxPath}/${entry}`,
    hidden: entry.startsWith('.'),
  }))
  return {
    distro,
    path: linuxPath,
    parent: linuxPath === '/' ? null : posix.dirname(linuxPath),
    target,
    entries,
    truncated: names.length > MAX_ENTRIES,
  }
}

// ── folders picked from WSL that live on a Windows drive ───────────────────────

/** Where the WSL origin of Windows-drive workspaces is remembered (survives restarts). */
function memoryFile() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-wsl-folder.json')
}

const folderKey = (windowsPath) => win32.normalize(windowsPath).replace(/\\+$/, '').toLowerCase()

let folders // Map<folderKey, { distro, path, target }>, loaded once

async function loadFolders() {
  if (folders !== undefined) return folders
  folders = new Map()
  try {
    const saved = JSON.parse(await readFile(memoryFile(), 'utf8'))
    for (const entry of Array.isArray(saved?.folders) ? saved.folders : []) {
      if (typeof entry?.target === 'string' && DISTRO_NAME.test(entry?.distro ?? '')) folders.set(folderKey(entry.target), entry)
    }
  } catch {
    // No memory yet.
  }
  return folders
}

async function rememberFolder(entry) {
  const map = await loadFolders()
  map.set(folderKey(entry.target), entry)
  const file = memoryFile()
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify({ version: 1, folders: [...map.values()] }, null, 2)}\n`, 'utf8')
  await rename(temp, file)
}

/** The remembered WSL folder containing `cwd` (the workspace itself or a directory below it). */
export function findFolder(map, cwd) {
  if (typeof cwd !== 'string' || !/^[a-zA-Z]:[\\/]/.test(cwd)) return undefined
  let key = folderKey(cwd)
  for (;;) {
    const hit = map.get(key)
    if (hit !== undefined) return hit
    const parent = win32.dirname(key)
    if (parent === key || parent.length < 3) return map.get(parent.replace(/\\+$/, ''))
    key = parent.replace(/\\+$/, '')
  }
}

async function pick(body) {
  const distro = requireDistro(body?.distro)
  const linuxPath = requireLinuxPath(body?.path)
  const windowsDrive = drvfsWindowsPath(linuxPath, await automountRoot(distro))
  if (windowsDrive === undefined) return { target: toUnc(distro, linuxPath) }
  try {
    if (!(await stat(windowsDrive)).isDirectory()) throw new RouteError('not-found', `${windowsDrive} is not a directory`)
  } catch (error) {
    if (error instanceof RouteError) throw error
    throw new RouteError(errorCode(error), String(error?.message ?? error))
  }
  await rememberFolder({ distro, path: linuxPath, target: windowsDrive })
  return { target: windowsDrive }
}

const warming = new Map()

function warm(distro) {
  // Touching the UNC root boots a stopped distribution; the first real listing then lands fast.
  if (!warming.has(distro)) {
    const pending = stat(toUnc(distro, '/')).then(() => true, () => false)
      .finally(() => setTimeout(() => warming.delete(distro), 60_000).unref?.())
    warming.set(distro, pending)
    homeOf(distro).catch(() => {})
  }
  return { ok: true }
}

// ── HTTP ───────────────────────────────────────────────────────────────────────

function answer(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(payload))
}

function header(request, key) {
  const headers = request?.headers
  if (!headers) return ''
  const value = typeof headers.get === 'function' ? headers.get(key) : headers[key]
  return typeof value === 'string' ? value : ''
}

const MAX_BODY_BYTES = 4096

/** One bounded JSON object body; settles on every exit path of a node:http request. */
function readJsonBody(request) {
  return new Promise((resolve) => {
    if (request === null || typeof request?.on !== 'function') { resolve(undefined); return }
    const chunks = []
    let size = 0
    let settled = false
    const finish = (value) => { if (!settled) { settled = true; resolve(value) } }
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) { finish(undefined); request.resume(); return }
      chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        finish(value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined)
      } catch {
        finish(undefined)
      }
    })
    request.on('error', () => finish(undefined))
    request.on('aborted', () => finish(undefined))
    request.on('close', () => finish(undefined))
  })
}

async function serve(request, response, route) {
  if (request.method !== route.method) {
    response.writeHead(405, { allow: route.method })
    response.end()
    return
  }
  // Browsers mark cross-site requests; only this page (or a direct navigation) may use the routes.
  const site = header(request, 'sec-fetch-site')
  if (site !== '' && site !== 'same-origin' && site !== 'none') {
    answer(response, 403, { error: 'forbidden', message: 'cross-site request refused' })
    return
  }
  // A JSON content type cannot be sent cross-site without a preflight, which this server never grants.
  if (route.method === 'POST' && !/^application\/json\s*(?:;|$)/i.test(header(request, 'content-type'))) {
    answer(response, 415, { error: 'bad-request', message: 'expected application/json' })
    return
  }
  if (process.platform !== 'win32') {
    answer(response, 200, { error: 'unsupported', message: 'WSL is only available on a Windows host' })
    return
  }
  try {
    const query = new URL(request.url ?? '/', 'http://localhost').searchParams
    const body = route.method === 'POST' ? await readJsonBody(request) : undefined
    if (route.method === 'POST' && body === undefined) throw new RouteError('bad-request', 'expected a JSON object body', 400)
    answer(response, 200, await route.handle(query, body))
  } catch (error) {
    if (error instanceof RouteError) answer(response, error.status, { error: error.code, message: error.message })
    else answer(response, 500, { error: 'internal', message: String(error?.message ?? error) })
  }
}

const routes = {
  distros: { method: 'GET', handle: async () => ({ distros: (await listDistros()).map(({ uid: _uid, ...rest }) => rest) }) },
  home: { method: 'GET', handle: async (query) => ({ home: await homeOf(requireDistro(query.get('distro'))) }) },
  list: { method: 'GET', handle: async (query) => listDirectory(requireDistro(query.get('distro')), requireLinuxPath(query.get('path') ?? '/')) },
  warm: { method: 'GET', handle: async (query) => warm(requireDistro(query.get('distro'))) },
  pick: { method: 'POST', handle: async (_query, body) => pick(body) },
}

// ── terminal redirection ───────────────────────────────────────────────────────

const sidebarTerminal = new AsyncLocalStorage()
const WRAPPED = Symbol.for('dsh-wsl-folder.wrapped')

function isWslLauncher(path) {
  // wsl.exe itself, or the legacy System32 bash.exe launcher (Git Bash is a Windows shell).
  return /(^|[\\/])wsl(\.exe)?$/i.test(String(path ?? '')) || /[\\/]system32[\\/]bash\.exe$/i.test(String(path ?? ''))
}

/**
 * Replace `owner[key]` with `wrap(original)` and return the restoring disposer. The disposer
 * leaves a later replacement by someone else in place.
 */
function patchMethod(owner, key, wrap) {
  const original = owner[key]
  if (typeof original !== 'function' || original[WRAPPED] === true) return () => {}
  const replacement = wrap(original)
  replacement[WRAPPED] = true
  owner[key] = replacement
  return () => {
    if (owner[key] === replacement) owner[key] = original
  }
}

/**
 * Where a sidebar terminal for `cwd` should start inside WSL, if anywhere: a `\\wsl.localhost`
 * workspace, or a Windows folder (or a directory below one) that was picked from WSL.
 * `cd` is what `wsl.exe --cd` receives (a Linux path, or an absolute Windows path it translates);
 * `path` is the Linux path shown to the user.
 */
export function wslTargetOf(cwd, remembered = folders) {
  const unc = parseWslUnc(cwd)
  if (unc !== undefined) return { distro: unc.distro, cd: unc.path, path: unc.path }
  const folder = remembered === undefined ? undefined : findFolder(remembered, cwd)
  if (folder === undefined) return undefined
  const below = win32.normalize(cwd).slice(win32.normalize(folder.target).replace(/\\+$/, '').length)
  const tail = below.split(/[\\/]+/).filter(Boolean).join('/')
  return { distro: folder.distro, cd: win32.normalize(cwd), path: tail ? `${folder.path.replace(/\/+$/, '')}/${tail}` : folder.path }
}

export function installTerminalRedirect(ctx, terminalController, subprocess) {
  if (process.platform !== 'win32') return () => {}
  // Prototype methods: the controller calls `this.spawn(...)`, and every Session resolves the
  // same subprocess provider class through `agent.ctx.get('subprocess')`.
  const controllerProto = Object.getPrototypeOf(terminalController)
  const subprocessProto = Object.getPrototypeOf(subprocess)
  const restoreSpawn = patchMethod(controllerProto, 'spawn', (original) => async function (...args) {
    const mark = {}
    const terminal = await sidebarTerminal.run(mark, () => original.apply(this, args))
    if (mark.wsl !== undefined && terminal?.info !== undefined) {
      try {
        terminal.info = {
          ...terminal.info,
          title: `WSL · ${mark.wsl.distro}`,
          cwd: mark.wsl.path,
        }
      } catch {
        // Cosmetic only.
      }
    }
    return terminal
  })
  const restoreSpawnTerminal = patchMethod(subprocessProto, 'spawnTerminal', (original) => function (spec, ...rest) {
    const mark = sidebarTerminal.getStore()
    const target = mark === undefined ? undefined : wslTargetOf(spec?.cwd)
    if (mark !== undefined && target !== undefined && Array.isArray(spec.argv) && !isWslLauncher(spec.argv[0])) {
      mark.wsl = target
      spec = { ...spec, argv: [wslExe(), '-d', target.distro, '--cd', target.cd] }
    }
    return original.call(this, spec, ...rest)
  })
  ctx.logger?.info?.('dsh-wsl-folder: sidebar terminals in WSL workspaces open inside the distribution')
  return () => {
    restoreSpawnTerminal()
    restoreSpawn()
  }
}

// ── agent writes on the WSL share ──────────────────────────────────────────────

/**
 * Publication primitives for one write whose target is on WSL's 9P share. `platform: 'linux'`
 * selects DSH's POSIX publication (rename over the file) instead of the Windows DACL copy and
 * ReplaceFileW, which the share rejects; an exclusive copy stands in for the hard link that
 * publishes a new file, keeping its no-clobber result (EEXIST when someone created the file first).
 */
export function wslWriteInternals(base = {}) {
  return {
    ...base,
    platform: 'linux',
    linkFile: (source, destination) => copyFile(source, destination, fsConstants.COPYFILE_EXCL),
  }
}

/**
 * The prototype that implements DSH's local filesystem writes: the nearest one on the chain that
 * owns `writeText`, `editText` and the per-target `withLock`. Subclasses (the sandboxed filesystem)
 * reach it through `super`, so one patch serves every instance in the process.
 */
export function findLocalFileSystemProto(fs) {
  for (let proto = Object.getPrototypeOf(fs ?? {}); proto !== null && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    const own = (key) => typeof Object.getOwnPropertyDescriptor(proto, key)?.value === 'function'
    if (own('writeText') && own('editText') && own('withLock')) return proto
  }
  return undefined
}

/**
 * Restore the leading separator of a WSL UNC path that lost one. Two spellings reach the host:
 * the file-address grammar (`dsh-resource://file/session/<id>/<path>`) collapses a UNC path's
 * leading `\\` into one `/`, and by the time such a path has been resolved it has become
 * `C:\wsl.localhost\...` (drive-rooted, so the drive is the process's current one). Both can only
 * ever mean the share, so both are restored when the second segment names an installed distro.
 * @param value - requested path, absolute, relative or unrelated.
 * @returns the UNC spelling when the value looks like a WSL path missing its leading separator.
 */
export function repairWslSpelling(value, distroNames) {
  if (typeof value !== 'string') return value
  const match = /^(?:[a-zA-Z]:)?[\\/](wsl\.localhost|wsl\$)([\\/].*)?$/.exec(value)
  if (match === null) return value
  const rest = match[2] ?? '\\'
  if (distroNames !== undefined) {
    const distro = /^[\\/]([^\\/]+)/.exec(rest)?.[1]
    if (distro === undefined || !distroNames.has(distro.toLowerCase())) return value
  }
  return `\\\\${match[1]}${rest}`
}

/** The prototype that implements DSH's path resolution: the nearest one owning `resolve`. */
export function findResolveProto(fs) {
  for (let proto = Object.getPrototypeOf(fs ?? {}); proto !== null && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    if (typeof Object.getOwnPropertyDescriptor(proto, 'resolve')?.value === 'function') return proto
  }
  return undefined
}

/** Append one diagnostic line (bounded file) so a mis-spelled WSL path names its caller. */
export function noteWslPath(ctx, kind, value, extra) {
  const line = `${new Date().toISOString()} ${kind} ${JSON.stringify(value)}${extra === undefined ? '' : ` ${extra}`}\n`
  const file = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-wsl-folder-diagnostics.log')
  appendFile(file, line).catch(() => {})
  ctx.logger?.debug?.(`dsh-wsl-folder: ${line.trim()}`)
}

/** Distributions seen by the last refresh, shared by both repair layers. */
let knownDistros

/** Refresh the synchronous distribution set the repairs consult. */
function watchDistros(ctx) {
  const refresh = () => {
    listDistros().then((list) => { knownDistros = new Set(list.map((entry) => entry.name.toLowerCase())) },
      (error) => ctx.logger?.warn?.(`dsh-wsl-folder: could not list distributions: ${String(error)}`))
  }
  refresh()
  const timer = setInterval(refresh, DISTRO_TTL_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}

/**
 * Repair the WSL spelling at the last mile: every Node filesystem call. A component that resolved
 * the address-derived path itself (`dsh-better-sidebar` reading a document, for instance) already
 * holds `C:\wsl.localhost\...` by then, which the parsed-path funnel never sees; rewriting here
 * fixes any caller, and the recording keeps naming the ones that still hand over a wrong spelling.
 * Only paths naming an installed distribution are touched; everything else passes through.
 */
export function installWslPathDiagnostics(ctx) {
  if (process.platform !== 'win32') return () => {}
  // Only a path that *starts* with the share spelling can be repaired; directory names that merely
  // contain it (a session folder named after its workspace, say) are left alone and not recorded.
  const badShape = /^(?:[a-zA-Z]:)?[\\/]wsl\.(?:localhost|\$)/i
  const wrap = (target, key) => {
    const original = target[key]
    if (typeof original !== 'function' || original[WRAPPED] === true) return () => {}
    const replacement = function (value, ...rest) {
      let repaired = value
      if (typeof value === 'string' && badShape.test(value)) {
        repaired = repairWslSpelling(value, knownDistros)
        const stack = String(new Error().stack ?? '').split('\n').slice(2, 9).map((row) => row.trim()).join(' | ')
        noteWslPath(ctx, repaired === value ? `call:${key}` : `lastmile:${key}`, value, stack)
      }
      return original.call(this, repaired, ...rest)
    }
    replacement[WRAPPED] = true
    target[key] = replacement
    return () => { if (target[key] === replacement) target[key] = original }
  }
  const restores = []
  for (const key of ['stat', 'lstat', 'readFile', 'readdir', 'open', 'access', 'realpath', 'statSync', 'lstatSync', 'readFileSync', 'readdirSync', 'openSync', 'existsSync']) {
    restores.push(wrap(nodeFs, key))
    if (key.endsWith('Sync') || key === 'existsSync') continue
    restores.push(wrap(nodeFsPromises, key))
  }
  // ESM named imports (`import { stat } from 'node:fs/promises'`) bind the original functions;
  // this refreshes them to the patched ones, which is what DSH's own modules use.
  try { syncBuiltinESMExports() } catch (error) { ctx.logger?.warn?.(`dsh-wsl-folder: could not refresh builtin exports: ${String(error)}`) }
  ctx.logger?.info?.('dsh-wsl-folder: WSL paths are repaired for every filesystem call')
  return () => {
    for (const restore of restores.reverse()) restore()
    try { syncBuiltinESMExports() } catch { /* best effort */ }
  }
}

/**
 * Repair the WSL UNC spelling at the one funnel every filesystem consumer goes through, so a
 * caller that lost a separator (`agent-instructions` walking up from the workspace, for example)
 * still reaches the real file. Only paths naming an installed distribution are touched.
 */
export function installWslPathRepair(ctx, fs) {
  if (process.platform !== 'win32') return () => {}
  const proto = findResolveProto(fs)
  if (proto === undefined) {
    ctx.logger?.warn?.('dsh-wsl-folder: the filesystem provider has no resolve(); WSL path repair is off')
    return () => {}
  }
  const stopWatching = watchDistros(ctx)
  const restores = []
  for (const key of ['resolve', 'lstat']) {
    restores.push(patchMethod(proto, key, (original) => function (value, ...rest) {
      const fixed = repairWslSpelling(value, knownDistros)
      if (fixed !== value) {
        const stack = String(new Error().stack ?? '').split('\n').slice(2, 8).map((row) => row.trim()).join(' | ')
        noteWslPath(ctx, `repair:${key}`, value, stack)
      }
      return original.call(this, fixed, ...rest)
    }))
  }
  ctx.logger?.info?.('dsh-wsl-folder: WSL UNC paths missing a leading separator are repaired on resolve')
  return () => {
    stopWatching()
    for (const restore of restores.reverse()) restore()
  }
}

export function installWslWriteSupport(ctx, fs) {
  if (process.platform !== 'win32') return () => {}
  const proto = findLocalFileSystemProto(fs)
  if (proto === undefined) {
    ctx.logger?.warn?.('dsh-wsl-folder: the filesystem provider is not DSH\'s local filesystem; WSL write support is off')
    return () => {}
  }
  // A per-call view of the instance: only `internals` differs, and every other member (locks,
  // config) still resolves to the real instance through the prototype.
  const onShare = (self, target) => (parseWslUnc(target?.targetKey) === undefined
    ? self
    : Object.create(self, { internals: { value: wslWriteInternals(self.internals), configurable: true, writable: true } }))
  const restoreWrite = patchMethod(proto, 'writeText', (original) => function (target, ...rest) {
    return original.call(onShare(this, target), target, ...rest)
  })
  const restoreEdit = patchMethod(proto, 'editText', (original) => function (target, ...rest) {
    return original.call(onShare(this, target), target, ...rest)
  })
  ctx.logger?.info?.('dsh-wsl-folder: agent writes inside WSL workspaces use publication the WSL share supports')
  return () => {
    restoreEdit()
    restoreWrite()
  }
}

// ── plugin ─────────────────────────────────────────────────────────────────────

export const inject = ['webServer']

export function apply(ctx, config = {}) {
  for (const [key, route] of Object.entries(routes)) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE}/${key}`,
      handler: (request, response) => serve(request, response, route),
    }), `dsh-wsl-folder: ${key} route`)
  }
  if (config?.terminal !== false) {
    // Load the remembered Windows-drive folders before the first terminal can ask for them.
    loadFolders().catch(() => {})
    ctx.inject(['terminalController', 'subprocess'], (inner) => {
      inner.effect(() => installTerminalRedirect(inner, inner.terminalController, inner.subprocess),
        'dsh-wsl-folder: WSL sidebar terminals')
    })
  }
  if (config?.write !== false) {
    ctx.inject(['fs'], (inner) => {
      inner.effect(() => installWslWriteSupport(inner, inner.fs), 'dsh-wsl-folder: agent writes on the WSL share')
    })
  }
  if (config?.paths !== false) {
    ctx.inject(['fs'], (inner) => {
      inner.effect(() => installWslPathRepair(inner, inner.fs), 'dsh-wsl-folder: WSL path repair')
    })
    // The last mile: any component that resolved the path itself before calling Node's fs.
    ctx.effect(() => installWslPathDiagnostics(ctx), 'dsh-wsl-folder: WSL filesystem call repair')
  }
}

/** Test seam: forget cached state so a test can point the memory file elsewhere. */
export function resetForTests() {
  folders = undefined
  confCache.clear()
  homeCache.clear()
  distroCache = undefined
}
