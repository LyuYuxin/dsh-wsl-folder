// Host half of dsh-wsl-folder.
//
// 1. Read-only JSON routes the browser half uses to browse WSL distributions:
//      GET /dsh-wsl-folder/distros               -> { distros: [{ name, default, version }] }
//      GET /dsh-wsl-folder/home?distro=X         -> { home }
//      GET /dsh-wsl-folder/list?distro=X&path=/  -> { distro, path, parent, unc, entries, truncated }
//      GET /dsh-wsl-folder/warm?distro=X         -> { ok }   (boots the distribution in the background)
//    Nothing on the hot path spawns wsl.exe (each spawn costs 1–3 s): distributions come from the
//    registry, the home directory from the distribution's own /etc/wsl.conf and /etc/passwd, and
//    listings from the \\wsl.localhost UNC view (a few ms once the distribution runs). wsl.exe is
//    only the fallback when those reads fail.
//
// 2. Sidebar terminals of a WSL workspace open inside the distribution. The terminal controller
//    spawns every sidebar terminal through `subprocess.spawnTerminal({ argv, cwd })` with the
//    Session's directory as `cwd`. While a sidebar terminal is being allocated (and only then,
//    tracked through AsyncLocalStorage), a `\\wsl.localhost\<distro>\<path>` cwd replaces the
//    Windows shell with `wsl.exe -d <distro> --cd <path>`. Agent tools and Windows workspaces are
//    untouched. Disable with `terminal: false` in this plugin row's config.

import { AsyncLocalStorage } from 'node:async_hooks'
import { execFile } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, posix } from 'node:path'

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
  const match = /^[\\/]{2}(?:wsl\.localhost|wsl\$)[\\/]([^\\/]+)(?:[\\/](.*))?$/i.exec(value)
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

function run(file, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      encoding: 'buffer',
      timeout,
      windowsHide: true,
      env: { ...process.env, WSL_UTF8: '1' },
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new RouteError('wsl-failed', (decode(stderr) || decode(stdout) || error.message).trim()))
        return
      }
      resolve(decode(stdout))
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

/** `[user] default=<name>` from /etc/wsl.conf, when present. */
export function wslConfDefaultUser(text) {
  let section = ''
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/[#;].*$/, '').trim()
    const header = /^\[(.+)\]$/.exec(line)
    if (header !== null) { section = header[1].trim().toLowerCase(); continue }
    const pair = /^default\s*=\s*"?([^"\s]+)"?$/i.exec(line)
    if (section === 'user' && pair !== null) return pair[1]
  }
  return undefined
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
  const conf = await readFile(`${root}etc\\wsl.conf`, 'utf8').catch(() => '')
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

async function listDirectory(distro, linuxPath) {
  const unc = toUnc(distro, linuxPath)
  let dirents
  try {
    dirents = await readdir(unc, { withFileTypes: true })
  } catch (error) {
    const code = error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? 'not-found'
      : error?.code === 'EACCES' || error?.code === 'EPERM' ? 'denied'
        : 'unreadable'
    throw new RouteError(code, String(error?.message ?? error))
  }
  const names = []
  const links = []
  for (const dirent of dirents) {
    if (dirent.isDirectory()) names.push(dirent.name)
    else if (dirent.isSymbolicLink()) links.push(dirent.name)
  }
  // A symlinked directory counts when it resolves through the UNC view.
  const base = unc.endsWith('\\') ? unc : `${unc}\\`
  const resolved = await Promise.all(links.slice(0, 200).map(async (entry) => {
    try {
      return (await stat(`${base}${entry}`)).isDirectory() ? entry : null
    } catch {
      return null
    }
  }))
  for (const entry of resolved) if (entry !== null) names.push(entry)
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
    unc,
    entries,
    truncated: names.length > MAX_ENTRIES,
  }
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

async function serve(request, response, handler) {
  if (request.method !== 'GET') {
    response.writeHead(405, { allow: 'GET' })
    response.end()
    return
  }
  // Browsers mark cross-site requests; only this page (or a direct navigation) may read listings.
  const site = header(request, 'sec-fetch-site')
  if (site !== '' && site !== 'same-origin' && site !== 'none') {
    answer(response, 403, { error: 'forbidden', message: 'cross-site request refused' })
    return
  }
  if (process.platform !== 'win32') {
    answer(response, 200, { error: 'unsupported', message: 'WSL is only available on a Windows host' })
    return
  }
  try {
    const query = new URL(request.url ?? '/', 'http://localhost').searchParams
    answer(response, 200, await handler(query))
  } catch (error) {
    if (error instanceof RouteError) answer(response, error.status, { error: error.code, message: error.message })
    else answer(response, 500, { error: 'internal', message: String(error?.message ?? error) })
  }
}

const handlers = {
  distros: async () => ({ distros: (await listDistros()).map(({ uid: _uid, ...rest }) => rest) }),
  home: async (query) => ({ home: await homeOf(requireDistro(query.get('distro'))) }),
  list: async (query) => listDirectory(requireDistro(query.get('distro')), requireLinuxPath(query.get('path') ?? '/')),
  warm: async (query) => warm(requireDistro(query.get('distro'))),
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

function installTerminalRedirect(ctx, terminalController, subprocess) {
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
    const target = mark === undefined ? undefined : parseWslUnc(spec?.cwd)
    if (mark !== undefined && target !== undefined && Array.isArray(spec.argv) && !isWslLauncher(spec.argv[0])) {
      mark.wsl = target
      spec = { ...spec, argv: [wslExe(), '-d', target.distro, '--cd', target.path] }
    }
    return original.call(this, spec, ...rest)
  })
  ctx.logger?.info?.('dsh-wsl-folder: sidebar terminals in WSL workspaces open inside the distribution')
  return () => {
    restoreSpawnTerminal()
    restoreSpawn()
  }
}

// ── plugin ─────────────────────────────────────────────────────────────────────

export const inject = ['webServer']

export function apply(ctx, config = {}) {
  for (const [key, handler] of Object.entries(handlers)) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE}/${key}`,
      handler: (request, response) => serve(request, response, handler),
    }), `dsh-wsl-folder: ${key} route`)
  }
  if (config?.terminal !== false) {
    ctx.inject(['terminalController', 'subprocess'], (inner) => {
      inner.effect(() => installTerminalRedirect(inner, inner.terminalController, inner.subprocess),
        'dsh-wsl-folder: WSL sidebar terminals')
    })
  }
}
