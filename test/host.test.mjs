// Host half checks with fakes (no DSH needed); the route section runs against the real WSL.
// Usage (Windows with WSL): node test/host.test.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import nodePath from 'node:path'
import { join } from 'node:path'
import { Readable } from 'node:stream'

// Keep the remembered-folder file out of the real DSH home.
const home = mkdtempSync(join(tmpdir(), 'dsh-wsl-folder-test-'))
process.env.DSH_HOME = home
const plugin = await import('../index.js')

// ── pure helpers ───────────────────────────────────────────────────────────────
assert.deepEqual(plugin.parseWslUnc('\\\\wsl.localhost\\Ubuntu-24.04-E\\home\\me\\proj'), { distro: 'Ubuntu-24.04-E', path: '/home/me/proj' })
assert.deepEqual(plugin.parseWslUnc('//wsl$/Debian/'), { distro: 'Debian', path: '/' })
assert.deepEqual(plugin.parseWslUnc('\\\\WSL.LOCALHOST\\Debian'), { distro: 'Debian', path: '/' })
assert.equal(plugin.parseWslUnc('C:\\Users\\me'), undefined)
assert.equal(plugin.parseWslUnc('\\\\server\\share\\x'), undefined)
assert.equal(plugin.toUnc('D', '/'), '\\\\wsl.localhost\\D\\')
assert.equal(plugin.toUnc('D', '/a/b'), '\\\\wsl.localhost\\D\\a\\b')
assert.equal(plugin.wslConfDefaultUser('[boot]\nsystemd=true\n[user]\ndefault=lvyuxin\n'), 'lvyuxin')
assert.equal(plugin.wslConfDefaultUser('[boot]\ndefault=x\n'), undefined)
assert.equal(plugin.wslConfAutomountRoot(''), '/mnt/')
assert.equal(plugin.wslConfAutomountRoot('[automount]\noptions="metadata"\n'), '/mnt/')
assert.equal(plugin.wslConfAutomountRoot('[automount]\nroot = /\n'), '/')
assert.equal(plugin.wslConfAutomountRoot('[automount]\nroot=/win\n'), '/win/')
assert.equal(plugin.drvfsWindowsPath('/mnt/d'), 'D:\\')
assert.equal(plugin.drvfsWindowsPath('/mnt/d/DSHworkarea/x'), 'D:\\DSHworkarea\\x')
assert.equal(plugin.drvfsWindowsPath('/mnt'), undefined)
assert.equal(plugin.drvfsWindowsPath('/mnt/wsl'), undefined)
assert.equal(plugin.drvfsWindowsPath('/home/me'), undefined)
assert.equal(plugin.drvfsWindowsPath('/c/Users', '/'), 'C:\\Users')
assert.equal(plugin.passwdHome('root:x:0:0::/root:/bin/bash\nme:x:1000:1000::/home/me:/bin/bash', 'me'), '/home/me')
assert.equal(plugin.passwdHome('root:x:0:0::/root:/bin/bash\nme:x:1000:1000::/home/me:/bin/bash', 0), '/root')
const lx = plugin.parseLxss('\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\r\n    DefaultDistribution    REG_SZ    {AAA}\r\n\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{aaa}\r\n    DistributionName    REG_SZ    Ubuntu\r\n    Version    REG_DWORD    0x2\r\n    DefaultUid    REG_DWORD    0x3e8\r\n\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{bbb}\r\n    DistributionName    REG_SZ    Debian\r\n')
assert.deepEqual(lx, [{ name: 'Ubuntu', default: true, version: 2, uid: 1000 }, { name: 'Debian', default: false, version: 2, uid: 0 }])
const remembered = new Map([['d:\\work', { distro: 'Ubuntu', path: '/mnt/d/work', target: 'D:\\work' }]])
assert.equal(plugin.findFolder(remembered, 'D:\\Work')?.distro, 'Ubuntu')
assert.equal(plugin.findFolder(remembered, 'D:\\work\\sub\\dir')?.distro, 'Ubuntu')
assert.equal(plugin.findFolder(remembered, 'D:\\workshop'), undefined)
assert.equal(plugin.findFolder(remembered, 'C:\\work'), undefined)
assert.deepEqual(plugin.wslTargetOf('D:\\work\\sub', remembered), { distro: 'Ubuntu', cd: 'D:\\work\\sub', path: '/mnt/d/work/sub' })
assert.deepEqual(plugin.wslTargetOf('\\\\wsl.localhost\\U\\home\\me', remembered), { distro: 'U', cd: '/home/me', path: '/home/me' })
assert.equal(plugin.wslTargetOf('E:\\other', remembered), undefined)
// A WSL UNC path that lost its leading separator can only mean the share; other paths are untouched.
const names = new Set(['ubuntu-24.04-e'])
assert.equal(plugin.repairWslSpelling('\\wsl.localhost\\Ubuntu-24.04-E\\home\\me\\AGENTS.md', names), '\\\\wsl.localhost\\Ubuntu-24.04-E\\home\\me\\AGENTS.md')
assert.equal(plugin.repairWslSpelling('/wsl.localhost/Ubuntu-24.04-E/home', names), '\\\\wsl.localhost/Ubuntu-24.04-E/home')
assert.equal(plugin.repairWslSpelling('\\\\wsl.localhost\\Ubuntu-24.04-E\\home', names), '\\\\wsl.localhost\\Ubuntu-24.04-E\\home')
assert.equal(plugin.repairWslSpelling('\\wsl.localhost\\Other\\x', names), '\\wsl.localhost\\Other\\x')
assert.equal(plugin.repairWslSpelling('C:\\Users\\me', names), 'C:\\Users\\me')
assert.equal(plugin.repairWslSpelling('\\Windows\\x', names), '\\Windows\\x')
assert.equal(plugin.repairWslSpelling('AGENTS.md', names), 'AGENTS.md')
assert.equal(plugin.repairWslSpelling(undefined, names), undefined)
assert.equal(plugin.repairWslSpelling('\\wsl$\\Ubuntu-24.04-E', names), '\\\\wsl$\\Ubuntu-24.04-E')
// The file-address round trip collapses `\\` to one `/`; once resolved it is drive-rooted.
assert.equal(plugin.repairWslSpelling('/wsl.localhost/Ubuntu-24.04-E/home/me/mr_description.md', names), '\\\\wsl.localhost/Ubuntu-24.04-E/home/me/mr_description.md')
assert.equal(plugin.repairWslSpelling('C:\\wsl.localhost\\Ubuntu-24.04-E\\home\\me\\mr_description.md', names), '\\\\wsl.localhost\\Ubuntu-24.04-E\\home\\me\\mr_description.md')
assert.equal(plugin.repairWslSpelling('D:\\wsl.localhost\\Ubuntu-24.04-E\\home', names), '\\\\wsl.localhost\\Ubuntu-24.04-E\\home')
assert.equal(plugin.repairWslSpelling('C:\\wsl.localhost\\Other\\home', names), 'C:\\wsl.localhost\\Other\\home')
assert.equal(plugin.repairWslSpelling('C:\\wsl.localhost', names), 'C:\\wsl.localhost')
assert.equal(plugin.repairWslSpelling('C:\\Users\\me\\wsl.localhost\\x', names), 'C:\\Users\\me\\wsl.localhost\\x')
console.log('helpers ok')

// ── plugin with fakes ──────────────────────────────────────────────────────────
class FakeController {
  async spawn(agent) {
    const handle = await this.subprocess.spawnTerminal({ argv: ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', '-NoLogo'], cwd: agent.cwd })
    return { info: { title: 'pwsh.exe', cwd: agent.cwd, shell: {} }, handle }
  }
}
class FakeSubprocess { spawnTerminal(spec) { return Promise.resolve(spec) } }
const controller = new FakeController()
const subprocess = new FakeSubprocess()
controller.subprocess = subprocess
const routes = {}
const disposers = []
const ctx = {
  webServer: { register: (r) => { routes[r.path] = r.handler; return () => { delete routes[r.path] } } },
  effect: (fn) => { const d = fn(); disposers.push(d); return d },
  inject: (names, cb) => cb({ terminalController: controller, subprocess, effect: ctx.effect, logger: { info() {} } }),
}
plugin.apply(ctx, { terminal: true })

async function call(path, { method = 'GET', body, headers = {} } = {}) {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))])
  Object.assign(request, { method, url: path, headers })
  return new Promise((resolve) => {
    const res = { status: 0, writeHead(s) { this.status = s }, end(text) { resolve([this.status, text ? JSON.parse(text) : null]) } }
    routes[path.split('?')[0]](request, res)
  })
}
const time = async (label, path, options) => {
  const start = performance.now()
  const result = await call(path, options)
  console.log(label.padEnd(22), String(Math.round(performance.now() - start)).padStart(5), 'ms', JSON.stringify(result[1]).slice(0, 100))
  return result
}
const json = { 'content-type': 'application/json' }

if (process.platform === 'win32') {
  // terminal redirect: \\wsl.localhost workspace, Windows workspace, and a direct (non-sidebar) spawn
  const wslTerm = await controller.spawn({ cwd: '\\\\wsl.localhost\\Ubuntu-24.04-E\\home\\lvyuxin' })
  assert.match(wslTerm.handle.argv[0], /wsl\.exe$/i)
  assert.deepEqual(wslTerm.handle.argv.slice(1), ['-d', 'Ubuntu-24.04-E', '--cd', '/home/lvyuxin'])
  assert.equal(wslTerm.info.title, 'WSL · Ubuntu-24.04-E')
  const winTerm = await controller.spawn({ cwd: 'C:\\Users\\me' })
  assert.match(winTerm.handle.argv[0], /pwsh\.exe$/)
  const direct = await subprocess.spawnTerminal({ argv: ['pwsh.exe'], cwd: '\\\\wsl.localhost\\D\\x' })
  assert.deepEqual(direct.argv, ['pwsh.exe'])
  console.log('terminal redirect ok')

  // routes against the real distribution
  const [, d] = await time('distros', '/dsh-wsl-folder/distros')
  const distro = d.distros.find((x) => x.default)?.name ?? d.distros[0].name
  await time('warm', `/dsh-wsl-folder/warm?distro=${distro}`)
  const [, homeDir] = await time('home', `/dsh-wsl-folder/home?distro=${distro}`)
  await time('list home', `/dsh-wsl-folder/list?distro=${distro}&path=${encodeURIComponent(homeDir.home)}`)
  const [, mnt] = await time('list /mnt', `/dsh-wsl-folder/list?distro=${distro}&path=/mnt`)
  assert.ok(mnt.entries.some((e) => e.name === 'c'), '/mnt lists the c drive')
  const [status, drive] = await time('list /mnt/c (drvfs)', `/dsh-wsl-folder/list?distro=${distro}&path=/mnt/c`)
  assert.equal(status, 200)
  assert.equal(drive.error, undefined, `drvfs listing failed: ${drive.message}`)
  assert.equal(drive.target, 'C:\\')
  assert.ok(drive.entries.some((e) => e.name === 'Users'))
  const [, users] = await time('list /mnt/c/Users', `/dsh-wsl-folder/list?distro=${distro}&path=/mnt/c/Users`)
  assert.equal(users.target, 'C:\\Users')
  const [, nf] = await call(`/dsh-wsl-folder/list?distro=${distro}&path=/nope`)
  assert.equal(nf.error, 'not-found')
  const [bad] = await call('/dsh-wsl-folder/list?distro=bad%20name&path=/')
  assert.equal(bad, 400)

  // pick: Linux paths stay \\wsl.localhost; drvfs paths become Windows paths and are remembered
  const [, linuxPick] = await time('pick home', '/dsh-wsl-folder/pick', { method: 'POST', headers: json, body: { distro, path: homeDir.home } })
  assert.equal(linuxPick.target, plugin.toUnc(distro, homeDir.home))
  const [, drivePick] = await time('pick /mnt/c/Users', '/dsh-wsl-folder/pick', { method: 'POST', headers: json, body: { distro, path: '/mnt/c/Users' } })
  assert.equal(drivePick.target, 'C:\\Users')
  const saved = JSON.parse(readFileSync(join(home, 'dsh-wsl-folder.json'), 'utf8'))
  assert.deepEqual(saved.folders, [{ distro, path: '/mnt/c/Users', target: 'C:\\Users' }])
  const [missing] = await call('/dsh-wsl-folder/pick', { method: 'POST', headers: json, body: { distro, path: '/mnt/c/definitely-missing-dir' } })
  assert.equal(missing, 200)
  assert.equal((await call('/dsh-wsl-folder/pick', { method: 'POST', headers: json, body: { distro, path: '/mnt/c/definitely-missing-dir' } }))[1].error, 'not-found')
  assert.equal((await call('/dsh-wsl-folder/pick', { method: 'POST', body: { distro, path: '/' } }))[0], 415, 'POST needs JSON')
  assert.equal((await call('/dsh-wsl-folder/pick', { method: 'GET' }))[0], 405)
  assert.equal((await call('/dsh-wsl-folder/pick', { method: 'POST', headers: { ...json, 'sec-fetch-site': 'cross-site' }, body: { distro, path: '/' } }))[0], 403)

  // a sidebar terminal in the remembered Windows folder (or below it) opens in WSL too
  const driveTerm = await controller.spawn({ cwd: 'C:\\Users\\Public' })
  assert.deepEqual(driveTerm.handle.argv.slice(1), ['-d', distro, '--cd', 'C:\\Users\\Public'])
  assert.equal(driveTerm.info.cwd, '/mnt/c/Users/Public')
  console.log('drvfs ok')
}

// ── agent writes on the WSL share ──────────────────────────────────────────────
// FakeLocalFs mirrors how DSH's LocalFileSystem publishes (see dsh-fs-local writeFileAtomic):
// a staged temp file, then a hard link for a new file, ReplaceFileW for an existing file on
// Windows, or rename elsewhere — all chosen through `this.internals`.
class FakeLocalFs {
  internals = {}
  locks = new Map()
  async withLock(key, op) {
    const run = (this.locks.get(key) ?? Promise.resolve()).then(op, op)
    this.locks.set(key, run.then(() => undefined, () => undefined))
    return run
  }
  async writeText(target, content, expected) {
    return this.withLock(target.targetKey, () => publish(this.internals, target.targetKey, content, expected?.kind === 'createIfAbsent'))
  }
  async editText(target, edit) {
    return this.withLock(target.targetKey, async () => {
      const text = (await fsp.readFile(target.targetKey, 'utf8')).replace(edit.old, edit.new)
      return publish(this.internals, target.targetKey, text, false)
    })
  }
}
class FakeSandboxedFs extends FakeLocalFs {
  async writeText(...args) { this.fenced = (this.fenced ?? 0) + 1; return super.writeText(...args) }
}
async function publish(internals, file, content, create) {
  const staging = `${file}.${process.pid}.tmpdir`
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
const fsp = await import('node:fs/promises')
assert.equal(plugin.findLocalFileSystemProto(new FakeSandboxedFs()), FakeLocalFs.prototype)
assert.equal(plugin.findLocalFileSystemProto({}), undefined)
if (process.platform === 'win32') {
  const share = '\\\\wsl.localhost\\Ubuntu-24.04-E\\tmp\\dsh-wsl-folder-test'
  await fsp.rm(share, { recursive: true, force: true })
  await fsp.mkdir(share, { recursive: true })
  const local = mkdtempSync(join(tmpdir(), 'dsh-wsl-folder-local-'))
  const fs = new FakeSandboxedFs()
  const at = (file) => ({ targetKey: file, displayPath: file })

  // without the plugin: DSH's publication fails on the share exactly as reported
  await assert.rejects(fs.writeText(at(`${share}\\before.txt`), 'x', { kind: 'createIfAbsent' }), { code: 'ENOTSUP' })
  await fsp.writeFile(`${share}\\edit.txt`, 'old\n')
  await assert.rejects(fs.editText(at(`${share}\\edit.txt`), { old: 'old', new: 'new' }), { code: 'EIO' })

  const dispose = plugin.installWslWriteSupport({ logger: {} }, fs)
  // new file, no-clobber create, and edit of an existing file all work on the share
  assert.equal((await fs.writeText(at(`${share}\\new.txt`), 'created\n', { kind: 'createIfAbsent' })).operation, 'create')
  assert.equal(await fsp.readFile(`${share}\\new.txt`, 'utf8'), 'created\n')
  await assert.rejects(fs.writeText(at(`${share}\\new.txt`), 'clobber\n', { kind: 'createIfAbsent' }), { code: 'EEXIST' })
  assert.equal(await fsp.readFile(`${share}\\new.txt`, 'utf8'), 'created\n', 'no-clobber kept the first file')
  await fs.editText(at(`${share}\\edit.txt`), { old: 'old', new: 'new' })
  assert.equal(await fsp.readFile(`${share}\\edit.txt`, 'utf8'), 'new\n')
  assert.equal(fs.fenced, 3, 'the subclass (sandbox) layer still runs')
  assert.ok(fs.locks.has(`${share}\\new.txt`), 'locks live on the real instance')
  assert.deepEqual(fs.internals, {}, 'the instance keeps DSH\'s own internals')
  // a Windows path keeps DSH's own primitives (hard link works on NTFS)
  await fs.writeText(at(join(local, 'win.txt')), 'win\n', { kind: 'createIfAbsent' })
  assert.equal(await fsp.readFile(join(local, 'win.txt'), 'utf8'), 'win\n')
  await assert.rejects(fs.editText(at(join(local, 'win.txt')), { old: 'win', new: 'x' }), { code: 'EIO' }, 'Windows edits still take the Windows branch')
  const lines = (await fsp.readdir(share)).sort()
  assert.deepEqual(lines, ['edit.txt', 'new.txt'], 'no staging leftovers')

  dispose()
  await assert.rejects(fs.writeText(at(`${share}\\after.txt`), 'x', { kind: 'createIfAbsent' }), { code: 'ENOTSUP' }, 'disposal restores DSH\'s behavior')
  await fsp.rm(share, { recursive: true, force: true })
  rmSync(local, { recursive: true, force: true })
  console.log('wsl writes ok')

  // ── WSL path repair ──────────────────────────────────────────────────────────
  // FakeLocalFs mirrors fs-local's resolve: an absolute path is resolved against the provider cwd,
  // which turns a single leading separator into a drive-rooted path — the reported failure.
  class FakeResolvingFs extends FakeLocalFs {
    async resolve(path, opts) {
      const cwd = opts?.cwd ?? 'C:\\Users\\me\\proj'
      return { targetKey: nodePath.win32.resolve(cwd, path), displayPath: path }
    }
    async lstat(path, opts) {
      return { targetKey: nodePath.win32.resolve(opts?.cwd ?? 'C:\\Users\\me\\proj', path) }
    }
  }
  const resolving = new FakeResolvingFs()
  const broken = '\\wsl.localhost\\Ubuntu-24.04-E\\home\\lvyuxin\\work\\EmbodiedAI\\AGENTS.md'
  assert.equal((await resolving.resolve(broken)).targetKey, 'C:\\wsl.localhost\\Ubuntu-24.04-E\\home\\lvyuxin\\work\\EmbodiedAI\\AGENTS.md', 'the reported path reproduces without the repair')
  const repairDispose = plugin.installWslPathRepair({ logger: {} }, resolving)
  await new Promise((r) => setTimeout(r, 300)) // the repair warms its distribution list
  assert.equal((await resolving.resolve(broken)).targetKey, `\\\\wsl.localhost\\Ubuntu-24.04-E\\home\\lvyuxin\\work\\EmbodiedAI\\AGENTS.md`)
  assert.equal((await resolving.lstat(broken)).targetKey, `\\\\wsl.localhost\\Ubuntu-24.04-E\\home\\lvyuxin\\work\\EmbodiedAI\\AGENTS.md`)
  assert.equal((await resolving.resolve('C:\\Users\\me\\x')).targetKey, 'C:\\Users\\me\\x', 'ordinary paths pass through')
  assert.equal((await resolving.resolve('\\wsl.localhost\\NoSuchDistro\\x')).targetKey, 'C:\\wsl.localhost\\NoSuchDistro\\x', 'unknown distributions are left alone')
  repairDispose()
  assert.equal((await resolving.resolve(broken)).targetKey, 'C:\\wsl.localhost\\Ubuntu-24.04-E\\home\\lvyuxin\\work\\EmbodiedAI\\AGENTS.md', 'disposal restores resolve')
  console.log('wsl path repair ok')
}

// disposal restores both prototypes and removes the routes
for (const dispose of disposers.reverse()) dispose?.()
const after = await controller.spawn({ cwd: '\\\\wsl.localhost\\Ubuntu-24.04-E\\home' })
assert.match(after.handle.argv[0], /pwsh\.exe$/)
assert.equal(Object.keys(routes).length, 0)
rmSync(home, { recursive: true, force: true })
console.log('all ok')
