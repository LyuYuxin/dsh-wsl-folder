// Host half checks. Everything except the "real WSL" section runs with fakes and needs no DSH;
// that section skips cleanly on a non-Windows host or when WSL cannot boot a distribution.
// Usage: node --test
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import nodePath, { join } from 'node:path'
import { Readable } from 'node:stream'
import { after, test } from 'node:test'

// Keep the remembered-folder file and the diagnostics out of the real DSH home.
const home = mkdtempSync(join(tmpdir(), 'dsh-wsl-folder-test-'))
process.env.DSH_HOME = home
const plugin = await import('../index.js')

after(() => rmSync(home, { recursive: true, force: true }))

// ── HTTP helpers (mock node:http request/response) ─────────────────────────────

function mockRequest({ method = 'GET', url = '/', headers = {}, body, remoteAddress = '127.0.0.1' } = {}) {
  const chunks = body === undefined
    ? []
    : [Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  const request = Readable.from(chunks)
  Object.assign(request, { method, url, headers })
  // A real node:http request always carries a socket; `remoteAddress: null` models a missing peer.
  if (remoteAddress !== null && remoteAddress !== undefined) request.socket = { remoteAddress }
  return request
}

/** Run one request handler against mock objects and resolve with the complete response. */
function collectResponse(call, { method = 'GET', url = '/', headers = {}, body, remoteAddress = '127.0.0.1' } = {}) {
  const request = mockRequest({ method, url, headers, body, remoteAddress })
  return new Promise((resolve) => {
    const response = {
      status: 0,
      headers: {},
      writeHead(status, headers) { this.status = status; this.headers = headers ?? {}; return this },
      end(chunk) {
        const raw = chunk === undefined ? undefined : String(chunk)
        let json
        if (raw !== undefined) {
          try { json = JSON.parse(raw) } catch { json = undefined }
        }
        resolve({ status: this.status, headers: this.headers, raw, json })
      },
    }
    Promise.resolve(call(request, response)).catch((error) => resolve({ status: 0, error }))
  })
}

/** Run `serve` against mock objects and resolve with the complete response. */
function invoke(route, { platform = 'win32', allowRemote = false, ...options } = {}) {
  return collectResponse((request, response) => plugin.serve(request, response, route, { platform, allowRemote }), options)
}

const jsonHeaders = { 'content-type': 'application/json' }
const echoRoute = {
  method: 'GET',
  async handle(query) {
    return { name: query.get('name'), missing: query.get('missing') }
  },
}

// ── WSL path helpers ───────────────────────────────────────────────────────────

test('parseWslUnc accepts both share spellings and normalizes the path', () => {
  assert.deepEqual(plugin.parseWslUnc('\\\\wsl.localhost\\Ubuntu-24.04-E\\home\\me\\proj'), { distro: 'Ubuntu-24.04-E', path: '/home/me/proj' })
  assert.deepEqual(plugin.parseWslUnc('//wsl$/Debian/'), { distro: 'Debian', path: '/' })
  assert.deepEqual(plugin.parseWslUnc('\\\\WSL.LOCALHOST\\Debian'), { distro: 'Debian', path: '/' })
  assert.deepEqual(plugin.parseWslUnc('//wsl.localhost/Debian/home'), { distro: 'Debian', path: '/home' })
  assert.deepEqual(plugin.parseWslUnc('\\\\wsl.localhost\\Debian\\home\\'), { distro: 'Debian', path: '/home' })
  // Namespaced spelling of the same share.
  assert.deepEqual(plugin.parseWslUnc('\\\\?\\UNC\\wsl.localhost\\Debian\\home'), { distro: 'Debian', path: '/home' })
  // `.` / `..` / duplicate separators collapse so a UNC cwd and a Linux path agree.
  assert.deepEqual(plugin.parseWslUnc('\\\\wsl.localhost\\D\\a\\..\\b'), { distro: 'D', path: '/b' })
  assert.deepEqual(plugin.parseWslUnc('\\\\wsl.localhost\\D\\\\a//b'), { distro: 'D', path: '/a/b' })
  assert.deepEqual(plugin.parseWslUnc('\\\\wsl.localhost\\D\\..'), { distro: 'D', path: '/' })
})

test('parseWslUnc rejects anything that is not a valid WSL share path', () => {
  for (const value of [undefined, null, 42, {}, '', 'C:\\Users\\me', '\\\\server\\share\\x', '\\\\wsl.localhost', '\\\\wsl.localhost\\', '\\\\wsl.localhost\\bad!name\\x', '\\\\wsl.localhost\\D!\\x']) {
    assert.equal(plugin.parseWslUnc(value), undefined, `expected undefined for ${String(value)}`)
  }
  // `.`/`..` are legal filename characters but can never name a distribution (path traversal).
  assert.equal(plugin.parseWslUnc('\\\\wsl.localhost\\..\\Windows'), undefined)
  assert.equal(plugin.parseWslUnc('\\\\wsl.localhost\\.\\x'), undefined)
})

test('toUnc builds the share spelling', () => {
  assert.equal(plugin.toUnc('D', '/'), '\\\\wsl.localhost\\D\\')
  assert.equal(plugin.toUnc('D', '/a/b'), '\\\\wsl.localhost\\D\\a\\b')
  assert.equal(plugin.toUnc('D', '/a/b/'), '\\\\wsl.localhost\\D\\a\\b\\')
})

test('decode accepts UTF-8, BOMs and UTF-16LE', () => {
  assert.equal(plugin.decode(Buffer.alloc(0)), '')
  assert.equal(plugin.decode(Buffer.from('plain', 'utf8')), 'plain')
  assert.equal(plugin.decode(Buffer.from('\ufeffplain', 'utf8')), 'plain')
  assert.equal(plugin.decode(Buffer.from('\ufeffplain', 'utf16le')), 'plain')
  // UTF-16LE text with no ASCII has no NUL byte; the BOM still identifies it.
  assert.equal(plugin.decode(Buffer.from('\ufeff中文', 'utf16le')), '中文')
  assert.equal(plugin.decode(undefined), '')
})

// ── /etc/wsl.conf helpers ─────────────────────────────────────────────────────

test('wslConfValue reads one INI key with comments, quotes and case-insensitivity', () => {
  const conf = [
    '# comment',
    '[boot]',
    'systemd=true',
    'command = "echo ; not a comment"',
    '',
    '[User]',
    'Default = "lvyuxin"',
    '[automount]',
    'root = /win/',
  ].join('\r\n')
  assert.equal(plugin.wslConfValue(conf, 'user', 'default'), 'lvyuxin')
  assert.equal(plugin.wslConfValue(conf, 'User', 'Default'), 'lvyuxin')
  assert.equal(plugin.wslConfValue(conf, 'boot', 'command'), 'echo ; not a comment')
  assert.equal(plugin.wslConfValue(conf, 'automount', 'root'), '/win/')
  assert.equal(plugin.wslConfValue(conf, 'boot', 'missing'), undefined)
  assert.equal(plugin.wslConfValue(conf, 'other', 'root'), undefined)
  assert.equal(plugin.wslConfValue('', 'user', 'default'), undefined)
  assert.equal(plugin.wslConfValue(undefined, 'user', 'default'), undefined)
  // The first value of a repeated key within its section is returned.
  assert.equal(plugin.wslConfValue('[user]\ndefault=a\ndefault=b\n', 'user', 'default'), 'a')
})

test('wslConfDefaultUser only reports a non-empty [user] default', () => {
  assert.equal(plugin.wslConfDefaultUser('[boot]\nsystemd=true\n[user]\ndefault=lvyuxin\n'), 'lvyuxin')
  assert.equal(plugin.wslConfDefaultUser('[boot]\ndefault=x\n'), undefined)
  assert.equal(plugin.wslConfDefaultUser('[user]\ndefault=\n'), undefined)
  assert.equal(plugin.wslConfDefaultUser('[user]\ndefault=""\n'), undefined)
  assert.equal(plugin.wslConfDefaultUser(''), undefined)
})

test('wslConfAutomountRoot normalizes to /x/', () => {
  assert.equal(plugin.wslConfAutomountRoot(''), '/mnt/')
  assert.equal(plugin.wslConfAutomountRoot('[automount]\noptions="metadata"\n'), '/mnt/')
  assert.equal(plugin.wslConfAutomountRoot('[automount]\nroot = /\n'), '/')
  assert.equal(plugin.wslConfAutomountRoot('[automount]\nroot=/win\n'), '/win/')
  assert.equal(plugin.wslConfAutomountRoot('[automount]\nroot=/win//\n'), '/win/')
  assert.equal(plugin.wslConfAutomountRoot('[automount]\nroot=mnt\n'), '/mnt/')
})

test('drvfsWindowsPath honors the default and a custom automount root', () => {
  assert.equal(plugin.drvfsWindowsPath('/mnt/d'), 'D:\\')
  assert.equal(plugin.drvfsWindowsPath('/mnt/d/DSHworkarea/x'), 'D:\\DSHworkarea\\x')
  assert.equal(plugin.drvfsWindowsPath('/mnt/d/'), 'D:\\')
  assert.equal(plugin.drvfsWindowsPath('/mnt'), undefined)
  assert.equal(plugin.drvfsWindowsPath('/mntx/c'), undefined)
  assert.equal(plugin.drvfsWindowsPath('/mnt/wsl'), undefined)
  assert.equal(plugin.drvfsWindowsPath('/home/me'), undefined)
  // Custom roots are accepted with or without a trailing/leading separator, and are not prefixes.
  assert.equal(plugin.drvfsWindowsPath('/win/c/Users', '/win'), 'C:\\Users')
  assert.equal(plugin.drvfsWindowsPath('/win/c/Users', '/win//'), 'C:\\Users')
  assert.equal(plugin.drvfsWindowsPath('/win/c', 'win/'), 'C:\\')
  assert.equal(plugin.drvfsWindowsPath('/winner/c', '/win'), undefined)
  assert.equal(plugin.drvfsWindowsPath('/c/Users', '/'), 'C:\\Users')
  assert.equal(plugin.drvfsWindowsPath('/mnt/c/Users', '/'), undefined)
  assert.equal(plugin.drvfsWindowsPath('/win/c/Users', ''), undefined, 'an empty root defaults to /mnt/')
  assert.equal(plugin.drvfsWindowsPath('/mnt/c/Users', undefined), 'C:\\Users')
})

test('passwdHome looks up a user by name or uid', () => {
  const passwd = 'root:x:0:0::/root:/bin/bash\nme:x:1000:1000::/home/me:/bin/bash\nshort:x:1\n'
  assert.equal(plugin.passwdHome(passwd, 'me'), '/home/me')
  assert.equal(plugin.passwdHome(passwd, 0), '/root')
  assert.equal(plugin.passwdHome(passwd, 1000), '/home/me')
  assert.equal(plugin.passwdHome(passwd, 'root'), '/root')
  assert.equal(plugin.passwdHome(passwd, 'nobody'), undefined)
  assert.equal(plugin.passwdHome(passwd, 4242), undefined)
  // A malformed line with fewer than seven fields is ignored.
  assert.equal(plugin.passwdHome(passwd, 'short'), undefined)
  assert.equal(plugin.passwdHome('', 'me'), undefined)
})

// ── WSL spelling repair, remembered folders, terminals ────────────────────────

test('repairWslSpelling restores the leading separator of installed distributions only', () => {
  const names = new Set(['ubuntu-24.04-e'])
  const proper = '\\\\wsl.localhost\\Ubuntu-24.04-E\\home\\me\\AGENTS.md'
  assert.equal(plugin.repairWslSpelling('\\wsl.localhost\\Ubuntu-24.04-E\\home\\me\\AGENTS.md', names), proper)
  assert.equal(plugin.repairWslSpelling('/wsl.localhost/Ubuntu-24.04-E/home', names), '\\\\wsl.localhost/Ubuntu-24.04-E/home')
  assert.equal(plugin.repairWslSpelling('\\\\wsl.localhost\\Ubuntu-24.04-E\\home', names), '\\\\wsl.localhost\\Ubuntu-24.04-E\\home')
  assert.equal(plugin.repairWslSpelling('\\wsl$\\Ubuntu-24.04-E', names), '\\\\wsl$\\Ubuntu-24.04-E')
  assert.equal(plugin.repairWslSpelling('C:\\wsl.localhost\\Ubuntu-24.04-E\\home', names), '\\\\wsl.localhost\\Ubuntu-24.04-E\\home')
  assert.equal(plugin.repairWslSpelling('/wsl.localhost/Ubuntu-24.04-E/home/me/mr_description.md', names), '\\\\wsl.localhost/Ubuntu-24.04-E/home/me/mr_description.md')
  // Unknown distributions, ordinary paths and already-correct paths pass through untouched.
  assert.equal(plugin.repairWslSpelling('\\wsl.localhost\\Other\\x', names), '\\wsl.localhost\\Other\\x')
  assert.equal(plugin.repairWslSpelling('C:\\wsl.localhost\\Other\\home', names), 'C:\\wsl.localhost\\Other\\home')
  assert.equal(plugin.repairWslSpelling('C:\\wsl.localhost', names), 'C:\\wsl.localhost')
  assert.equal(plugin.repairWslSpelling('C:\\Users\\me\\wsl.localhost\\x', names), 'C:\\Users\\me\\wsl.localhost\\x')
  assert.equal(plugin.repairWslSpelling('AGENTS.md', names), 'AGENTS.md')
  assert.equal(plugin.repairWslSpelling('\\Windows\\x', names), '\\Windows\\x')
  assert.equal(plugin.repairWslSpelling(undefined, names), undefined)
  // Without a distribution set there is nothing to consult; a share spelling can only mean the share.
  assert.equal(plugin.repairWslSpelling('\\wsl.localhost\\Anything\\x', undefined), '\\\\wsl.localhost\\Anything\\x')
  assert.equal(plugin.repairWslSpelling('\\wsl.localhost\\Other\\x', new Set()), '\\wsl.localhost\\Other\\x')
})

test('findFolder matches the remembered folder and its descendants, case-insensitively', () => {
  const remembered = new Map([['d:\\work', { distro: 'Ubuntu', path: '/mnt/d/work', target: 'D:\\work' }]])
  assert.equal(plugin.findFolder(remembered, 'D:\\Work')?.distro, 'Ubuntu')
  assert.equal(plugin.findFolder(remembered, 'D:\\work\\sub\\dir')?.distro, 'Ubuntu')
  assert.equal(plugin.findFolder(remembered, 'D:/work/sub'), plugin.findFolder(remembered, 'D:\\work\\sub'))
  assert.equal(plugin.findFolder(remembered, 'D:\\workshop'), undefined)
  assert.equal(plugin.findFolder(remembered, 'C:\\work'), undefined)
  assert.equal(plugin.findFolder(remembered, 'work'), undefined)
  assert.equal(plugin.findFolder(remembered, undefined), undefined)
  assert.equal(plugin.findFolder(new Map(), 'D:\\work'), undefined)
  // A drive-root pick is remembered as `D:` and still covers everything below it.
  const root = new Map([['d:', { distro: 'Ubuntu', path: '/mnt/d', target: 'D:\\' }]])
  assert.equal(plugin.findFolder(root, 'D:\\anything')?.path, '/mnt/d')
  assert.equal(plugin.findFolder(remembered, 'D:\\'), undefined)
})

test('wslTargetOf resolves UNC workspaces and remembered Windows folders', () => {
  const remembered = new Map([['d:\\work', { distro: 'Ubuntu', path: '/mnt/d/work', target: 'D:\\work' }]])
  assert.deepEqual(plugin.wslTargetOf('D:\\work\\sub', remembered), { distro: 'Ubuntu', cd: 'D:\\work\\sub', path: '/mnt/d/work/sub' })
  assert.deepEqual(plugin.wslTargetOf('D:/work/sub/Deep', remembered), { distro: 'Ubuntu', cd: 'D:\\work\\sub\\Deep', path: '/mnt/d/work/sub/Deep' })
  assert.deepEqual(plugin.wslTargetOf('D:\\work', remembered), { distro: 'Ubuntu', cd: 'D:\\work', path: '/mnt/d/work' })
  assert.deepEqual(plugin.wslTargetOf('\\\\wsl.localhost\\U\\home\\me', remembered), { distro: 'U', cd: '/home/me', path: '/home/me' })
  assert.equal(plugin.wslTargetOf('E:\\other', remembered), undefined)
  assert.equal(plugin.wslTargetOf('D:\\work', new Map()), undefined)
  assert.equal(plugin.wslTargetOf('D:\\work', undefined), undefined)
})

test('rememberFolder serializes concurrent writers and normalizes stored paths', async () => {
  plugin.resetForTests()
  const file = join(home, 'dsh-wsl-folder.json')
  writeFileSync(file, JSON.stringify({
    version: 1,
    folders: [
      { distro: 'Ubuntu', path: '/mnt/c/../Windows', target: 'C:\\evil' },
      { distro: 'Ubuntu', path: 'relative/path', target: 'C:\\relative' },
      { distro: 'bad name', path: '/mnt/c/bad', target: 'C:\\bad' },
      { distro: 'Ubuntu', path: '/mnt/c//keep/', target: 'C:\\keep' },
    ],
  }))
  try {
    // Both writers start before either write lands: the shared load and the write queue must keep both.
    await Promise.all([
      plugin.rememberFolder({ distro: 'Ubuntu', path: '/mnt/c/first', target: 'C:\\first' }),
      plugin.rememberFolder({ distro: 'Debian', path: '/mnt/d/second', target: 'D:\\second' }),
    ])
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    assert.deepEqual(saved.folders.map((entry) => entry.target).sort(), ['C:\\first', 'C:\\keep', 'D:\\second'])
    assert.ok(saved.folders.some((entry) => entry.target === 'C:\\keep' && entry.path === '/mnt/c/keep'), 'stored paths are normalized')
    assert.deepEqual(readdirSync(home).filter((name) => name.endsWith('.tmp')), [], 'no temp files are left behind')
    // Unsafe/hand-edited values are rejected even by the direct writer.
    await assert.rejects(plugin.rememberFolder({ distro: 'Ubuntu', path: '/mnt/c/../Windows', target: 'C:\\evil' }), { code: 'bad-path' })
    await assert.rejects(plugin.rememberFolder({ distro: 'Ubuntu', path: '/mnt/c/x', target: 'relative\\target' }), { code: 'bad-path' })
  } finally {
    rmSync(file, { force: true })
    plugin.resetForTests()
  }
})

test('patchMethod wraps once and restores exactly what it replaced', () => {
  const owner = {
    value: 3,
    method(...args) { return { self: this, args } },
  }
  const original = owner.method
  let calls = 0
  const dispose = plugin.patchMethod(owner, 'method', (inner) => function (...args) {
    calls += 1
    return inner.apply(this, args)
  })
  assert.notEqual(owner.method, original)
  assert.equal(owner.method[Symbol.for('dsh-wsl-folder.wrapped')], true)
  assert.deepEqual(owner.method(1, 2).args, [1, 2])
  assert.equal(owner.method(1, 2).self, owner)
  assert.equal(calls, 2)
  // A second patch is a no-op while the first is installed, so it must not unwrap it.
  const noopDispose = plugin.patchMethod(owner, 'method', (inner) => inner)
  const wrapped = owner.method
  noopDispose()
  assert.equal(owner.method, wrapped)
  dispose()
  assert.equal(owner.method, original)
  // Disposal is idempotent and leaves a later owner in place.
  dispose()
  assert.equal(owner.method, original)
  const replacement = () => 'someone else'
  owner.method = replacement
  dispose()
  assert.equal(owner.method, replacement)
  // Non-functions and absent keys are ignored.
  const empty = {}
  plugin.patchMethod(empty, 'missing', (inner) => inner)
  assert.equal(empty.missing, undefined)
  plugin.patchMethod({ method: 3 }, 'method', (inner) => inner)
})

test('parseLxss reads distributions, default flag, version and uid', () => {
  const text = '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\r\n    DefaultDistribution    REG_SZ    {AAA}\r\n\r\n'
    + 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{aaa}\r\n    DistributionName    REG_SZ    Ubuntu\r\n    Version    REG_DWORD    0x2\r\n    DefaultUid    REG_DWORD    0x3e8\r\n\r\n'
    + 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{bbb}\r\n    DistributionName    REG_SZ    Debian\r\n'
  assert.deepEqual(plugin.parseLxss(text), [
    { name: 'Ubuntu', default: true, version: 2, uid: 1000 },
    { name: 'Debian', default: false, version: 2, uid: 0 },
  ])
  assert.deepEqual(plugin.parseLxss(''), [])
  assert.deepEqual(plugin.parseLxss(undefined ?? ''), [])
  // No default recorded, a bad name, and a default GUID in another case.
  const noDefault = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{ccc}\r\n    DistributionName    REG_SZ    Alpine\r\n    Version    REG_DWORD    0x1\r\n'
  assert.deepEqual(plugin.parseLxss(noDefault), [{ name: 'Alpine', default: false, version: 1, uid: 0 }])
  const badName = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{ddd}\r\n    DistributionName    REG_SZ    bad name\r\n'
  assert.deepEqual(plugin.parseLxss(badName), [])
  const lowerDefault = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\r\n    DefaultDistribution    REG_SZ    {ABC}\r\n\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{abc}\r\n    DistributionName    REG_SZ    Ubuntu\r\n'
  assert.equal(plugin.parseLxss(lowerDefault)[0].default, true)
})

// ── HTTP routes / serve ───────────────────────────────────────────────────────

test('serve rejects the wrong method with 405 and an allow header', async () => {
  const result = await invoke(plugin.routes.pick, { method: 'GET', url: '/dsh-wsl-folder/pick' })
  assert.equal(result.status, 405)
  assert.equal(result.headers.allow, 'POST')
  assert.equal(result.raw, undefined)
  const getResult = await invoke(echoRoute, { method: 'POST', url: '/x', headers: jsonHeaders, body: {} })
  assert.equal(getResult.status, 405)
  assert.equal(getResult.headers.allow, 'GET')
})

test('serve refuses cross-site requests and non-JSON POSTs', async () => {
  const base = { method: 'POST', url: '/dsh-wsl-folder/pick', body: { distro: 'bad name', path: '/' } }
  assert.equal((await invoke(plugin.routes.pick, { ...base, headers: { ...jsonHeaders, 'sec-fetch-site': 'cross-site' } })).status, 403)
  assert.equal((await invoke(plugin.routes.pick, { ...base, headers: { ...jsonHeaders, 'sec-fetch-site': 'same-site' } })).status, 403)
  assert.equal((await invoke(plugin.routes.pick, { ...base, headers: { ...jsonHeaders, 'sec-fetch-site': 'same-origin' } })).json.error, 'bad-distro')
  assert.equal((await invoke(plugin.routes.pick, { ...base, headers: { ...jsonHeaders, 'sec-fetch-site': 'none' } })).json.error, 'bad-distro')
  // Missing/proper content type.
  assert.equal((await invoke(plugin.routes.pick, { ...base, headers: {} })).status, 415)
  assert.equal((await invoke(plugin.routes.pick, { ...base, headers: { 'content-type': 'text/plain' } })).status, 415)
  assert.equal((await invoke(plugin.routes.pick, { ...base, headers: { 'content-type': 'application/jsonx' } })).status, 415)
  assert.equal((await invoke(plugin.routes.pick, { ...base, headers: { 'content-type': 'application/json; charset=utf-8' } })).json.error, 'bad-distro')
  // Header bags with a get() method (fetch Headers-like) work too.
  const headers = { get: (key) => (key === 'content-type' ? 'application/json' : undefined) }
  assert.equal((await invoke(plugin.routes.pick, { ...base, headers })).json.error, 'bad-distro')
})

test('serve requires one JSON object body of at most 4096 bytes', async () => {
  const route = { method: 'POST', handle: async (_query, body) => ({ received: body }) }
  const post = (body, headers = jsonHeaders) => invoke(route, { method: 'POST', url: '/x', headers, body })
  assert.deepEqual((await post('{"a":1}')).json, { received: { a: 1 } })
  for (const body of ['', 'not json', '[]', 'null', '"text"', '42']) {
    const result = await post(body)
    assert.equal(result.status, 400, `expected 400 for body ${JSON.stringify(body)}`)
    assert.equal(result.json.error, 'bad-request')
  }
  // Exactly the limit is accepted (whitespace is valid JSON around the object).
  const atLimit = `{"pad":"${'a'.repeat(4096 - 10)}"}`
  assert.equal(Buffer.byteLength(atLimit), 4096)
  assert.equal((await post(atLimit)).status, 200)
  const overLimit = `{"pad":"${'a'.repeat(4096 - 9)}"}`
  assert.equal(Buffer.byteLength(overLimit), 4097)
  const rejected = await post(overLimit)
  assert.equal(rejected.status, 400)
  assert.equal(rejected.json.message, 'expected a JSON object body')
  // A request that cannot carry a body still settles.
  assert.equal((await invoke(route, { method: 'POST', url: '/x', headers: jsonHeaders })).status, 400)
})

test('serve refuses non-loopback peers unless the remote flag is set', async () => {
  assert.equal(plugin.isLoopbackAddress('127.0.0.1'), true)
  assert.equal(plugin.isLoopbackAddress('127.8.8.8'), true)
  assert.equal(plugin.isLoopbackAddress('::1'), true)
  assert.equal(plugin.isLoopbackAddress('::ffff:127.0.0.1'), true)
  assert.equal(plugin.isLoopbackAddress('192.168.1.5'), false)
  assert.equal(plugin.isLoopbackAddress('::ffff:10.0.0.2'), false)
  assert.equal(plugin.isLoopbackAddress(undefined), false)
  const route = { method: 'GET', handle: async () => ({ ok: true }) }
  // Loopback peers (and the IPv4-mapped spelling) are accepted.
  assert.deepEqual((await invoke(route, { url: '/x' })).json, { ok: true })
  assert.deepEqual((await invoke(route, { url: '/x', remoteAddress: '::1' })).json, { ok: true })
  assert.deepEqual((await invoke(route, { url: '/x', remoteAddress: '::ffff:127.0.0.1' })).json, { ok: true })
  // The web server may listen on a LAN address; these routes stay loopback-only by default.
  for (const remoteAddress of ['192.168.1.5', '10.0.0.2', '::ffff:192.168.1.5', null]) {
    const refused = await invoke(route, { url: '/x', remoteAddress })
    assert.equal(refused.status, 403, `expected 403 for peer ${String(remoteAddress)}`)
    assert.equal(refused.json.error, 'forbidden')
    assert.match(refused.json.message, /loopback/)
  }
  // `remote: true` in the plugin row is the explicit opt-in.
  assert.deepEqual((await invoke(route, { url: '/x', remoteAddress: '192.168.1.5', allowRemote: true })).json, { ok: true })
})

test('serve maps route errors to JSON statuses', async () => {
  const notFound = await invoke({ method: 'GET', handle: async () => { throw new plugin.RouteError('not-found', 'gone') } }, { url: '/x' })
  assert.deepEqual(notFound.json, { error: 'not-found', message: 'gone' })
  assert.equal(notFound.status, 200)
  const denied = await invoke({ method: 'GET', handle: async () => { throw new plugin.RouteError('denied', 'nope', 403) } }, { url: '/x' })
  assert.equal(denied.status, 403)
  assert.deepEqual(denied.json, { error: 'denied', message: 'nope' })
  const internal = await invoke({ method: 'GET', handle: async () => { throw new Error('boom') } }, { url: '/x' })
  assert.equal(internal.status, 500)
  assert.deepEqual(internal.json, { error: 'internal', message: 'boom' })
  // A non-Windows host answers "unsupported" without touching the handler.
  let called = false
  const unsupported = await invoke({ method: 'GET', handle: async () => { called = true; return {} } }, { url: '/x', platform: 'linux' })
  assert.equal(unsupported.status, 200)
  assert.equal(unsupported.json.error, 'unsupported')
  assert.equal(called, false)
})

test('serve parses the query string and passes the parsed body', async () => {
  assert.deepEqual((await invoke(echoRoute, { url: '/dsh-wsl-folder/x?name=a%20b' })).json, { name: 'a b', missing: null })
  const route = { method: 'POST', handle: async (_query, body) => body }
  assert.deepEqual((await invoke(route, { method: 'POST', url: '/x', headers: jsonHeaders, body: { distro: 'U', path: '/' } })).json, { distro: 'U', path: '/' })
})

test('the real routes validate their input before touching WSL', async () => {
  const crossSite = await invoke(plugin.routes.pick, {
    method: 'POST', url: '/dsh-wsl-folder/pick', headers: { ...jsonHeaders, 'sec-fetch-site': 'cross-site' },
    body: { distro: 'Ubuntu', path: '/' },
  })
  assert.equal(crossSite.status, 403)
  const badDistro = await invoke(plugin.routes.pick, { method: 'POST', url: '/dsh-wsl-folder/pick', headers: jsonHeaders, body: { distro: 'bad name', path: '/' } })
  assert.equal(badDistro.status, 400)
  assert.equal(badDistro.json.error, 'bad-distro')
  const traversal = await invoke(plugin.routes.pick, { method: 'POST', url: '/dsh-wsl-folder/pick', headers: jsonHeaders, body: { distro: '..', path: '/' } })
  assert.equal(traversal.status, 400)
  assert.equal(traversal.json.error, 'bad-distro')
  const badPath = await invoke(plugin.routes.pick, { method: 'POST', url: '/dsh-wsl-folder/pick', headers: jsonHeaders, body: { distro: 'Ubuntu', path: 'a\\b' } })
  assert.equal(badPath.status, 400)
  assert.equal(badPath.json.error, 'bad-path')
  const missingBody = await invoke(plugin.routes.pick, { method: 'POST', url: '/dsh-wsl-folder/pick', headers: jsonHeaders, body: [] })
  assert.equal(missingBody.status, 400)
  assert.equal(missingBody.json.error, 'bad-request')
  // GET routes validate the distribution/path the same way.
  assert.equal((await invoke(plugin.routes.list, { url: '/dsh-wsl-folder/list?distro=bad%20name&path=/' })).json.error, 'bad-distro')
  assert.equal((await invoke(plugin.routes.list, { url: '/dsh-wsl-folder/list?path=/' })).json.error, 'bad-distro')
  assert.equal((await invoke(plugin.routes.list, { url: '/dsh-wsl-folder/list?distro=Ubuntu&path=%5Cbad' })).json.error, 'bad-path')
  assert.equal((await invoke(plugin.routes.list, { url: '/dsh-wsl-folder/list?distro=Ubuntu&path=%00' })).json.error, 'bad-path')
  assert.equal((await invoke(plugin.routes.home, { url: '/dsh-wsl-folder/home?distro=bad%2Fname' })).json.error, 'bad-distro')
  assert.equal((await invoke(plugin.routes.warm, { url: '/dsh-wsl-folder/warm' })).json.error, 'bad-distro')
})

// ── path diagnostics (process-wide fs patch + bounded log) ───────────────────

test('installWslPathDiagnostics wraps and restores the process-wide fs functions', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
  const fsModule = await import('node:fs')
  const promisesModule = await import('node:fs/promises')
  const fs = fsModule.default
  const promises = promisesModule.default
  const before = {
    stat: fs.stat,
    statSync: fs.statSync,
    existsSync: fs.existsSync,
    readFile: promises.readFile,
    readdir: promises.readdir,
    readFileNamed: fsModule.readFile,
  }
  const directory = mkdtempSync(join(tmpdir(), 'dsh-wsl-folder-diag-'))
  const file = join(directory, 'plain.txt')
  writeFileSync(file, 'plain')
  const dispose = plugin.installWslPathDiagnostics({ logger: {} })
  try {
    assert.notEqual(fs.stat, before.stat)
    assert.notEqual(fs.statSync, before.statSync)
    assert.notEqual(fs.existsSync, before.existsSync)
    assert.notEqual(promises.readFile, before.readFile)
    assert.notEqual(promises.readdir, before.readdir)
    assert.equal(fs.stat[Symbol.for('dsh-wsl-folder.wrapped')], true)
    // syncBuiltinESMExports() is what makes DSH's named imports see the patched functions.
    assert.notEqual(fsModule.readFile, before.readFileNamed)
    // Ordinary calls still delegate to the real filesystem.
    assert.equal(await promises.readFile(file, 'utf8'), 'plain')
    assert.equal(fs.readFileSync(file, 'utf8'), 'plain')
    assert.equal(fsModule.statSync(file).isFile(), true)
    // A share spelling without the leading separator is repaired before the real call: the error
    // names the UNC path, not the impossible drive-rooted `C:\wsl.localhost\...` spelling.
    const failure = await promises.stat('C:\\wsl.localhost\\NoSuchDistro\\missing').then(() => undefined, (error) => error)
    assert.ok(failure, 'the missing path still rejects')
    assert.match(String(failure.message), /wsl\.localhost/i)
    assert.doesNotMatch(String(failure.message), /C:\\wsl\.localhost/i)
  } finally {
    dispose()
    rmSync(directory, { recursive: true, force: true })
  }
  assert.equal(fs.stat, before.stat, 'disposal restores node:fs')
  assert.equal(fs.statSync, before.statSync)
  assert.equal(fs.existsSync, before.existsSync)
  assert.equal(promises.readFile, before.readFile, 'disposal restores node:fs/promises')
  assert.equal(promises.readdir, before.readdir)
  assert.equal(fsModule.readFile, before.readFileNamed, 'named ESM exports are refreshed back')
})

test('noteWslPath rotates the diagnostics file at 256 KiB', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-wsl-folder-log-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = directory
  try {
    plugin.resetForTests()
    const file = join(directory, 'dsh-wsl-folder-diagnostics.log')
    const initial = 'x'.repeat(256 * 1024 + 1)
    writeFileSync(file, initial)
    await plugin.noteWslPath({ logger: {} }, 'test', 'a value', 'stack')
    const rotated = readFileSync(`${file}.1`, 'utf8')
    assert.equal(rotated.length, initial.length, 'the oversized file is moved aside')
    const current = readFileSync(file, 'utf8')
    assert.match(current, /test "a value" stack/)
    assert.ok(current.length < 1024, 'the new file only holds the new line')
    // A small file keeps appending without another rotation.
    await plugin.noteWslPath({ logger: {} }, 'test', 'second')
    assert.match(readFileSync(file, 'utf8'), /second/)
    assert.equal(readFileSync(`${file}.1`, 'utf8').length, initial.length)
  } finally {
    process.env.DSH_HOME = previousHome
    plugin.resetForTests()
    rmSync(directory, { recursive: true, force: true })
  }
})

// ── publication primitives and prototype discovery ────────────────────────────

class FakeLocalFileSystem {
  internals = { marker: 'own' }
  locks = new Map()
  async withLock(_key, op) { return op() }
  async resolve(path) { return { targetKey: path, displayPath: path } }
  async writeText(target) {
    return { platform: this.internals.platform ?? 'win32', linkFile: typeof this.internals.linkFile, targetKey: target.targetKey }
  }
  async editText(target) {
    return { platform: this.internals.platform ?? 'win32', targetKey: target.targetKey }
  }
}
class FakeSandboxedFileSystem extends FakeLocalFileSystem {
  async writeText(...args) { this.subclassCalls = (this.subclassCalls ?? 0) + 1; return super.writeText(...args) }
  async editText(...args) { this.subclassCalls = (this.subclassCalls ?? 0) + 1; return super.editText(...args) }
}

test('wslWriteInternals keeps DSH internals and publishes no-clobber', async () => {
  const base = { marker: 'own' }
  const internals = plugin.wslWriteInternals(base)
  assert.equal(internals.platform, 'linux')
  assert.equal(internals.marker, 'own')
  assert.equal(base.platform, undefined, 'the caller internals are not mutated')
  const directory = await mkdtemp(join(tmpdir(), 'dsh-wsl-folder-copy-'))
  try {
    const source = join(directory, 'source')
    const destination = join(directory, 'destination')
    await writeFile(source, 'content')
    assert.equal(typeof internals.linkFile, 'function')
    await internals.linkFile(source, destination)
    assert.equal(await readFile(destination, 'utf8'), 'content')
    await assert.rejects(internals.linkFile(source, destination), { code: 'EEXIST' })
    assert.equal(await readFile(destination, 'utf8'), 'content')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('findLocalFileSystemProto finds the base class behind a sandbox subclass', () => {
  assert.equal(plugin.findLocalFileSystemProto(new FakeSandboxedFileSystem()), FakeLocalFileSystem.prototype)
  assert.equal(plugin.findLocalFileSystemProto(new FakeLocalFileSystem()), FakeLocalFileSystem.prototype)
  assert.equal(plugin.findLocalFileSystemProto({}), undefined)
  assert.equal(plugin.findLocalFileSystemProto(undefined), undefined)
  assert.equal(plugin.findResolveProto(new FakeLocalFileSystem()), FakeLocalFileSystem.prototype)
})

// ── sidebar terminals (Windows fake) ─────────────────────────────────────────

class FakeController {
  constructor(subprocess) { this.subprocess = subprocess }
  async spawn(agent) {
    const handle = await this.subprocess.spawnTerminal({ argv: ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', '-NoLogo'], cwd: agent.cwd })
    return { info: { title: 'pwsh.exe', cwd: agent.cwd, shell: {} }, handle }
  }
}
class FakeSubprocess { spawnTerminal(spec) { return Promise.resolve(spec) } }

test('terminal redirect opens WSL workspaces in the distribution only', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
  const subprocess = new FakeSubprocess()
  const controller = new FakeController(subprocess)
  const dispose = plugin.installTerminalRedirect({ logger: {} }, controller, subprocess)
  try {
    const wslTerm = await controller.spawn({ cwd: '\\\\wsl.localhost\\Ubuntu-24.04-E\\home\\lvyuxin' })
    assert.match(wslTerm.handle.argv[0], /wsl\.exe$/i)
    assert.deepEqual(wslTerm.handle.argv.slice(1), ['-d', 'Ubuntu-24.04-E', '--cd', '/home/lvyuxin'])
    assert.equal(wslTerm.info.title, 'WSL · Ubuntu-24.04-E')
    assert.equal(wslTerm.info.cwd, '/home/lvyuxin')
    const winTerm = await controller.spawn({ cwd: 'C:\\Users\\me' })
    assert.match(winTerm.handle.argv[0], /pwsh\.exe$/)
    assert.equal(winTerm.info.title, 'pwsh.exe')
    // A terminal spawned outside the sidebar allocation is untouched.
    const direct = await subprocess.spawnTerminal({ argv: ['pwsh.exe'], cwd: '\\\\wsl.localhost\\D\\x' })
    assert.deepEqual(direct.argv, ['pwsh.exe'])
  } finally {
    dispose()
  }
  const after = await controller.spawn({ cwd: '\\\\wsl.localhost\\Ubuntu-24.04-E\\home' })
  assert.match(after.handle.argv[0], /pwsh\.exe$/, 'disposal restores the Windows shell')
})

// ── agent writes on the WSL share (Windows fake) ──────────────────────────────

test('WSL write support patches only calls whose target is on the share', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
  const fs = new FakeSandboxedFileSystem()
  const shareTarget = '\\\\wsl.localhost\\Ubuntu-24.04-E\\home\\me\\file.txt'
  const dispose = plugin.installWslWriteSupport({ logger: {} }, fs)
  try {
    const onShare = await fs.writeText({ targetKey: shareTarget, displayPath: '/home/me/file.txt' }, 'x')
    assert.equal(onShare.platform, 'linux')
    assert.equal(onShare.linkFile, 'function')
    assert.equal(onShare.targetKey, shareTarget)
    const onShareEdit = await fs.editText({ targetKey: shareTarget, displayPath: '/home/me/file.txt' }, {})
    assert.equal(onShareEdit.platform, 'linux')
    const local = await fs.writeText({ targetKey: 'C:\\Users\\me\\file.txt', displayPath: 'C:\\Users\\me\\file.txt' }, 'x')
    assert.equal(local.platform, 'win32')
    assert.equal(fs.subclassCalls, 3, 'the sandbox subclass still runs')
    assert.deepEqual(fs.internals, { marker: 'own' }, 'the real instance keeps its internals')
    assert.ok(fs.locks instanceof Map)
  } finally {
    dispose()
  }
  const after = await fs.writeText({ targetKey: shareTarget, displayPath: '/home/me/file.txt' }, 'x')
  assert.equal(after.platform, 'win32', 'disposal restores DSH behavior')
})

// ── WSL path repair (Windows fake) ────────────────────────────────────────────

class FakeResolvingFs {
  constructor(cwd = 'C:\\Users\\me\\proj') { this.cwd = cwd }
  async resolve(path, opts) {
    return { targetKey: nodePath.win32.resolve(opts?.cwd ?? this.cwd, path), displayPath: path }
  }
  async lstat(path, opts) {
    return { targetKey: nodePath.win32.resolve(opts?.cwd ?? this.cwd, path) }
  }
}

test('installWslPathRepair restores resolve/lstat and disposes', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
  const fs = new FakeResolvingFs()
  const broken = '\\wsl.localhost\\Ubuntu-24.04-E\\home\\lvyuxin\\work\\EmbodiedAI\\AGENTS.md'
  const repaired = '\\\\wsl.localhost\\Ubuntu-24.04-E\\home\\lvyuxin\\work\\EmbodiedAI\\AGENTS.md'
  assert.equal((await fs.resolve(broken)).targetKey, 'C:\\wsl.localhost\\Ubuntu-24.04-E\\home\\lvyuxin\\work\\EmbodiedAI\\AGENTS.md', 'the reported path reproduces without the repair')
  const dispose = plugin.installWslPathRepair({ logger: {} }, fs, { distroNames: new Set(['ubuntu-24.04-e']) })
  try {
    assert.equal((await fs.resolve(broken)).targetKey, repaired)
    assert.equal((await fs.lstat(broken)).targetKey, repaired)
    assert.equal((await fs.resolve('C:\\Users\\me\\x')).targetKey, 'C:\\Users\\me\\x', 'ordinary paths pass through')
    assert.equal((await fs.resolve('\\wsl.localhost\\NoSuchDistro\\x')).targetKey, 'C:\\wsl.localhost\\NoSuchDistro\\x', 'unknown distributions are left alone')
  } finally {
    dispose()
  }
  assert.equal((await fs.resolve(broken)).targetKey, 'C:\\wsl.localhost\\Ubuntu-24.04-E\\home\\lvyuxin\\work\\EmbodiedAI\\AGENTS.md', 'disposal restores resolve')
})

test('installWslPathRepair without a resolve() reports and does nothing', { skip: process.platform !== 'win32' && 'Windows only' }, () => {
  const fs = {}
  const messages = []
  const dispose = plugin.installWslPathRepair({ logger: { warn: (message) => messages.push(message) } }, fs, { distroNames: new Set() })
  assert.equal(messages.length, 1)
  assert.match(messages[0], /no resolve/)
  assert.doesNotThrow(() => dispose())
})

// ── plugin wiring ────────────────────────────────────────────────────────────

test('concurrent pick requests both persist in the remembered-folder file', { skip: process.platform !== 'win32' && 'Windows only' }, async (t) => {
  plugin.resetForTests()
  const file = join(home, 'dsh-wsl-folder.json')
  rmSync(file, { force: true })
  const pick = (path) => invoke(plugin.routes.pick, {
    method: 'POST',
    url: '/dsh-wsl-folder/pick',
    headers: jsonHeaders,
    body: { distro: 'Ubuntu', path },
  })
  try {
    // Both requests run their load and their write at the same time; without the shared load
    // promise and the serialized writer one of these entries used to be lost.
    const [users, windows] = await Promise.all([pick('/mnt/c/Users'), pick('/mnt/c/Windows')])
    const isDrive = (target) => typeof target === 'string' && /^[A-Z]:\\/i.test(target)
    if (!isDrive(users.json?.target) || !isDrive(windows.json?.target)) {
      // A distribution with a non-default `[automount] root` cannot map `/mnt/c` this way; that
      // branch is covered by the direct rememberFolder test instead.
      t.skip('the distribution does not mount drives at /mnt/')
      return
    }
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    const targets = saved.folders.map((entry) => entry.target)
    assert.ok(targets.includes('C:\\Users'), `missing C:\\Users in ${JSON.stringify(targets)}`)
    assert.ok(targets.includes('C:\\Windows'), `missing C:\\Windows in ${JSON.stringify(targets)}`)
    assert.ok(saved.folders.every((entry) => entry.distro === 'Ubuntu' && entry.path.startsWith('/mnt/c/')))
  } finally {
    rmSync(file, { force: true })
    plugin.resetForTests()
  }
})

test('apply registers the five routes and a remembered Windows folder redirects terminals', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
  plugin.resetForTests()
  const memory = join(home, 'dsh-wsl-folder.json')
  writeFileSync(memory, `${JSON.stringify({ version: 1, folders: [{ distro: 'Ubuntu', path: '/mnt/d/work', target: 'D:\\work' }] })}\n`)
  const subprocess = new FakeSubprocess()
  const controller = new FakeController(subprocess)
  const registered = new Map()
  const disposers = []
  const fakeCtx = {
    webServer: { register: (route) => { registered.set(route.path, route.handler); return () => { registered.delete(route.path) } } },
    effect: (fn) => { const dispose = fn(); disposers.push(dispose); return dispose },
    inject: (_names, callback) => callback({ terminalController: controller, subprocess, effect: fakeCtx.effect, logger: {} }),
  }
  try {
    plugin.apply(fakeCtx, { write: false, paths: false })
    assert.deepEqual([...registered.keys()].sort(), [
      '/dsh-wsl-folder/distros',
      '/dsh-wsl-folder/home',
      '/dsh-wsl-folder/list',
      '/dsh-wsl-folder/pick',
      '/dsh-wsl-folder/warm',
    ])
    // The remembered map is loaded asynchronously when the plugin applies.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (plugin.wslTargetOf('D:\\work\\sub') !== undefined) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.notEqual(plugin.wslTargetOf('D:\\work\\sub'), undefined, 'the remembered folders loaded')
    const terminal = await controller.spawn({ cwd: 'D:\\work\\sub' })
    assert.deepEqual(terminal.handle.argv.slice(1), ['-d', 'Ubuntu', '--cd', 'D:\\work\\sub'])
    assert.equal(terminal.info.title, 'WSL · Ubuntu')
    assert.equal(terminal.info.cwd, '/mnt/d/work/sub')
  } finally {
    for (const dispose of disposers.reverse()) dispose?.()
    rmSync(memory, { force: true })
    plugin.resetForTests()
  }
  assert.equal(registered.size, 0, 'disposal removes the routes')
  const after = await controller.spawn({ cwd: 'D:\\work\\sub' })
  assert.match(after.handle.argv[0], /pwsh\.exe$/, 'disposal restores the terminal spawn')
})

test('apply forwards the remote flag to the registered handlers', async () => {
  const registerWith = (config) => {
    const handlers = new Map()
    const disposers = []
    const ctx = {
      webServer: { register: (route) => { handlers.set(route.path, route.handler); return () => { handlers.delete(route.path) } } },
      effect: (fn) => { const dispose = fn(); disposers.push(dispose); return dispose },
      inject: () => {},
    }
    plugin.apply(ctx, { terminal: false, write: false, paths: false, ...config })
    return { handlers, dispose: () => { for (const dispose of disposers.reverse()) dispose?.() } }
  }
  const defaults = registerWith({})
  const remote = registerWith({ remote: true })
  try {
    const warm = (set) => collectResponse(set.handlers.get('/dsh-wsl-folder/warm'), {
      url: '/dsh-wsl-folder/warm?distro=bad%20name',
      remoteAddress: '192.168.1.5',
    })
    assert.equal((await warm(defaults)).status, 403, 'default is loopback-only')
    // 400 (bad-distro) proves the guard passed and the real handler ran, still without touching WSL.
    assert.equal((await warm(remote)).status, 400)
    assert.equal((await warm(remote)).json.error, 'bad-distro')
  } finally {
    defaults.dispose()
    remote.dispose()
  }
})

// ── real WSL (skipped unless a distribution can run) ─────────────────────────

function wslExePath() {
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe')
}

function runWsl(args) {
  return new Promise((resolve) => {
    execFile(wslExePath(), args, { encoding: 'buffer', timeout: 60_000, windowsHide: true, env: { ...process.env, WSL_UTF8: '1' } },
      (error, stdout, stderr) => resolve({
        ok: error === null,
        output: plugin.decode(stdout),
        detail: error === null ? '' : (plugin.decode(stderr) || plugin.decode(stdout) || error.message).trim(),
      }))
  })
}

async function probeWsl() {
  if (process.platform !== 'win32') return { skip: 'not a Windows host' }
  const listed = await runWsl(['-l', '-q'])
  if (!listed.ok) return { skip: `wsl.exe -l -q failed: ${listed.detail.slice(0, 200)}` }
  const distro = listed.output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0]
  if (distro === undefined) return { skip: 'no WSL distribution is installed' }
  const live = await runWsl(['-d', distro, '-e', 'true'])
  if (!live.ok) return { skip: `WSL cannot boot ${distro}: ${live.detail.slice(0, 200)}` }
  return { distro }
}

const wsl = await probeWsl()

test('real WSL: routes list, browse, pick and write on the real share', { skip: wsl.skip }, async () => {
  const distro = wsl.distro
  plugin.resetForTests()
  const route = (name, query = '') => `/dsh-wsl-folder/${name}${query}`
  const get = (name, query) => invoke(plugin.routes[name], { url: route(name, query) })
  const pick = (path) => invoke(plugin.routes.pick, { method: 'POST', url: route('pick'), headers: jsonHeaders, body: { distro, path } })

  const distros = await get('distros')
  assert.equal(distros.status, 200)
  assert.ok(distros.json.distros.some((entry) => entry.name === distro), 'the registry/`wsl -l` list contains the probe distribution')
  assert.equal(distros.json.distros[0].uid, undefined, 'uid is host-internal and not exposed')
  assert.deepEqual((await get('warm', `?distro=${encodeURIComponent(distro)}`)).json, { ok: true })
  const homeDir = await get('home', `?distro=${encodeURIComponent(distro)}`)
  assert.equal(homeDir.status, 200)
  assert.equal(homeDir.json.error, undefined)
  assert.ok(homeDir.json.home.startsWith('/'))

  const listing = await get('list', `?distro=${encodeURIComponent(distro)}&path=${encodeURIComponent(homeDir.json.home)}`)
  assert.equal(listing.status, 200)
  assert.ok(Array.isArray(listing.json.entries))
  assert.equal(listing.json.target, plugin.toUnc(distro, homeDir.json.home))
  const missing = await get('list', `?distro=${encodeURIComponent(distro)}&path=%2Fdefinitely-missing-dsh-wsl-folder`)
  assert.equal(missing.json.error, 'not-found')

  const pickedHome = await pick(homeDir.json.home)
  assert.equal(pickedHome.json.target, plugin.toUnc(distro, homeDir.json.home))

  // A drive mounted through drvfs is browsed and registered as its real Windows path.
  const root = await get('list', `?distro=${encodeURIComponent(distro)}&path=%2F`)
  assert.equal(root.json.error, undefined)
  const mount = root.json.entries.find((entry) => entry.name === 'mnt')
  if (mount !== undefined) {
    const mounts = await get('list', `?distro=${encodeURIComponent(distro)}&path=%2Fmnt`)
    const drive = (mounts.json.entries ?? []).find((entry) => /^[a-zA-Z]$/.test(entry.name) && /^[A-Z]:\\$/.test(entry.target ?? ''))
    if (drive !== undefined) {
      const drives = await get('list', `?distro=${encodeURIComponent(distro)}&path=${encodeURIComponent(`/mnt/${drive.name}`)}`)
      assert.equal(drives.json.error, undefined)
      assert.equal(drives.json.target, `${drive.name.toUpperCase()}:\\`)
      const pickedDrive = await pick(`/mnt/${drive.name}`)
      assert.equal(pickedDrive.json.target, `${drive.name.toUpperCase()}:\\`)
      const saved = JSON.parse(await readFile(join(home, 'dsh-wsl-folder.json'), 'utf8'))
      assert.ok(saved.folders.some((entry) => entry.target === `${drive.name.toUpperCase()}:\\` && entry.distro === distro))
    }
  }

  // Publication primitives that DSH ships fail on the 9P share; the plugin's stand-ins succeed.
  const shareRoot = `\\\\wsl.localhost\\${distro}\\tmp\\dsh-wsl-folder-test-${process.pid}`
  const fsp = await import('node:fs/promises')
  await fsp.rm(shareRoot, { recursive: true, force: true })
  await fsp.mkdir(shareRoot, { recursive: true })
  try {
    class ShareFs {
      internals = {}
      locks = new Map()
      async withLock(key, op) {
        const run = (this.locks.get(key) ?? Promise.resolve()).then(op, op)
        this.locks.set(key, run.then(() => undefined, () => undefined))
        return run
      }
      async writeText(target, content, expected) {
        return this.withLock(target.targetKey, () => publishShare(this.internals, target.targetKey, content, expected?.kind === 'createIfAbsent'))
      }
      async editText(target, edit) {
        return this.withLock(target.targetKey, async () => {
          const text = (await fsp.readFile(target.targetKey, 'utf8')).replace(edit.old, edit.new)
          return publishShare(this.internals, target.targetKey, text, false)
        })
      }
    }
    const at = (file) => ({ targetKey: file, displayPath: file })
    const fs = new ShareFs()
    await assert.rejects(fs.writeText(at(`${shareRoot}\\before.txt`), 'x', { kind: 'createIfAbsent' }))
    await fsp.writeFile(`${shareRoot}\\edit.txt`, 'old\n')
    await assert.rejects(fs.editText(at(`${shareRoot}\\edit.txt`), { old: 'old', new: 'new' }))
    const dispose = plugin.installWslWriteSupport({ logger: {} }, fs)
    try {
      await fs.writeText(at(`${shareRoot}\\new.txt`), 'created\n', { kind: 'createIfAbsent' })
      assert.equal(await fsp.readFile(`${shareRoot}\\new.txt`, 'utf8'), 'created\n')
      await assert.rejects(fs.writeText(at(`${shareRoot}\\new.txt`), 'clobber\n', { kind: 'createIfAbsent' }), { code: 'EEXIST' })
      assert.equal(await fsp.readFile(`${shareRoot}\\new.txt`, 'utf8'), 'created\n', 'no-clobber kept the first file')
      await fs.editText(at(`${shareRoot}\\edit.txt`), { old: 'old', new: 'new' })
      assert.equal(await fsp.readFile(`${shareRoot}\\edit.txt`, 'utf8'), 'new\n')
      assert.deepEqual((await fsp.readdir(shareRoot)).sort(), ['edit.txt', 'new.txt'], 'no staging leftovers')
    } finally {
      dispose()
    }
    await assert.rejects(fs.writeText(at(`${shareRoot}\\after.txt`), 'x', { kind: 'createIfAbsent' }))
  } finally {
    await fsp.rm(shareRoot, { recursive: true, force: true })
  }
})

/** Mirrors DSH's local publication: hard link for a new file, ReplaceFileW/rename otherwise. */
async function publishShare(internals, file, content, create) {
  const staging = `${file}.${process.pid}.tmpdir`
  const fsp = await import('node:fs/promises')
  await fsp.mkdir(staging)
  const temp = join(staging, 'f.tmp')
  try {
    await fsp.writeFile(temp, content, { flag: 'wx' })
    const platform = internals.platform ?? process.platform
    if (create) await (internals.linkFile ?? fsp.link)(temp, file)
    else if (platform === 'win32') throw Object.assign(new Error('GetFileSecurityW EIO (Win32 1)'), { code: 'EIO' })
    else await fsp.rename(temp, file)
    return { operation: create ? 'create' : 'update', lockShared: true }
  } finally {
    await fsp.rm(staging, { recursive: true, force: true })
  }
}
