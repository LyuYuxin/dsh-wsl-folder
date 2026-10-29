// Host half checks with fakes (no DSH needed); the route section runs against the real WSL.
// Usage (Windows with WSL): node test/host.test.mjs
import assert from 'node:assert/strict'
import * as plugin from '../index.js'

// pure helpers
assert.deepEqual(plugin.parseWslUnc('\\\\wsl.localhost\\Ubuntu-24.04-E\\home\\me\\proj'), { distro: 'Ubuntu-24.04-E', path: '/home/me/proj' })
assert.deepEqual(plugin.parseWslUnc('//wsl$/Debian/'), { distro: 'Debian', path: '/' })
assert.deepEqual(plugin.parseWslUnc('\\\\WSL.LOCALHOST\\Debian'), { distro: 'Debian', path: '/' })
assert.equal(plugin.parseWslUnc('C:\\Users\\me'), undefined)
assert.equal(plugin.parseWslUnc('\\\\server\\share\\x'), undefined)
assert.equal(plugin.toUnc('D', '/'), '\\\\wsl.localhost\\D\\')
assert.equal(plugin.toUnc('D', '/a/b'), '\\\\wsl.localhost\\D\\a\\b')
assert.equal(plugin.wslConfDefaultUser('[boot]\nsystemd=true\n[user]\ndefault=lvyuxin\n'), 'lvyuxin')
assert.equal(plugin.wslConfDefaultUser('[boot]\ndefault=x\n'), undefined)
assert.equal(plugin.passwdHome('root:x:0:0::/root:/bin/bash\nme:x:1000:1000::/home/me:/bin/bash', 'me'), '/home/me')
assert.equal(plugin.passwdHome('root:x:0:0::/root:/bin/bash\nme:x:1000:1000::/home/me:/bin/bash', 0), '/root')
const lx = plugin.parseLxss('\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\r\n    DefaultDistribution    REG_SZ    {AAA}\r\n\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{aaa}\r\n    DistributionName    REG_SZ    Ubuntu\r\n    Version    REG_DWORD    0x2\r\n    DefaultUid    REG_DWORD    0x3e8\r\n\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{bbb}\r\n    DistributionName    REG_SZ    Debian\r\n')
assert.deepEqual(lx, [{ name: 'Ubuntu', default: true, version: 2, uid: 1000 }, { name: 'Debian', default: false, version: 2, uid: 0 }])
console.log('helpers ok')

// terminal redirect with fakes
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
if (process.platform === 'win32') {
  const wslTerm = await controller.spawn({ cwd: '\\\\wsl.localhost\\Ubuntu-24.04-E\\home\\lvyuxin' })
  assert.match(wslTerm.handle.argv[0], /wsl\.exe$/i)
  assert.deepEqual(wslTerm.handle.argv.slice(1), ['-d', 'Ubuntu-24.04-E', '--cd', '/home/lvyuxin'])
  assert.equal(wslTerm.info.title, 'WSL · Ubuntu-24.04-E')
  const winTerm = await controller.spawn({ cwd: 'C:\\Users\\me' })
  assert.match(winTerm.handle.argv[0], /pwsh\.exe$/)
  // a spawn outside the sidebar-terminal path (an agent tool, say) is untouched
  const direct = await subprocess.spawnTerminal({ argv: ['pwsh.exe'], cwd: '\\\\wsl.localhost\\D\\x' })
  assert.deepEqual(direct.argv, ['pwsh.exe'])
  console.log('terminal redirect ok')
}

// real routes
async function call(path) {
  return new Promise((resolve) => {
    const res = { status: 0, writeHead(s) { this.status = s }, end(body) { resolve([this.status, JSON.parse(body ?? 'null')]) } }
    routes[path.split('?')[0]]({ method: 'GET', url: path, headers: {} }, res)
  })
}
const time = async (label, path) => {
  const start = performance.now()
  const result = await call(path)
  console.log(label.padEnd(18), String(Math.round(performance.now() - start)).padStart(5), 'ms', JSON.stringify(result[1]).slice(0, 110))
  return result
}
if (process.platform === 'win32') {
  const [, d] = await time('distros', '/dsh-wsl-folder/distros')
  const distro = d.distros.find((x) => x.default)?.name ?? d.distros[0].name
  await time('distros (cached)', '/dsh-wsl-folder/distros')
  await time('warm', `/dsh-wsl-folder/warm?distro=${distro}`)
  const [, home] = await time('home', `/dsh-wsl-folder/home?distro=${distro}`)
  await time('home (cached)', `/dsh-wsl-folder/home?distro=${distro}`)
  await time('list home', `/dsh-wsl-folder/list?distro=${distro}&path=${encodeURIComponent(home.home)}`)
  await time('list /usr/lib', `/dsh-wsl-folder/list?distro=${distro}&path=/usr/lib`)
  const [, nf] = await call(`/dsh-wsl-folder/list?distro=${distro}&path=/nope`)
  assert.equal(nf.error, 'not-found')
  const [bad] = await call('/dsh-wsl-folder/list?distro=bad%20name&path=/')
  assert.equal(bad, 400)
}

// disposal restores both prototypes and removes the routes
for (const d of disposers.reverse()) d?.()
const after = await controller.spawn({ cwd: '\\\\wsl.localhost\\Ubuntu-24.04-E\\home' })
assert.match(after.handle.argv[0], /pwsh\.exe$/)
assert.equal(Object.keys(routes).length, 0)
console.log('all ok')
