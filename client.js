// Client half of dsh-wsl-folder.
//
// The workspace browser declares a `single` directory-flow hole beside "Add workspace" (and one in
// the New Session hero picker). The shipped occupant opens the Windows folder chooser. This plugin
// occupies both holes at a lower priority (the lowest renders), so the same button now offers
// "Windows folder" or "WSL folder". The Windows choice runs exactly the call the shipped native
// occupant makes; the WSL choice opens an in-app browser over this package's Host routes and
// reports a \\wsl.localhost\<distro>\... path through the owner's onPicked.
//
// The dialogs render in the frame-wide `shell.overlay` slot. Their markup and CSS follow DSH's own
// Modal, Button, Menu item and Select Workspace Directory dialog, restyled under the `dwf-` prefix
// with only `--dsw-*` theme tokens, so light/dark themes and skins apply unchanged.
window.__ModuleLoader__.load({
  id: 'dsh-wsl-folder',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'dshWslFolder'
    const ROUTE = '/dsh-wsl-folder'
    const HOLES = ['sidebar.workspaces.directoryFlow', 'conversation.hero.workspace.directoryFlow']
    const RECENT_KEY = 'dsh-wsl-folder.recent'
    const DISTRO_KEY = 'dsh-wsl-folder.distro'

    const zh = {
      title: '添加工作区',
      chooseHint: '要添加的文件夹在哪里？',
      windows: 'Windows 文件夹',
      windowsDesc: '使用系统文件夹选择器',
      wsl: 'WSL 文件夹',
      wslDesc: '浏览 WSL 发行版中的 Linux 目录',
      recent: '最近的 WSL 位置',
      wslTitle: '选择 WSL 目录',
      distro: '发行版',
      editPath: '编辑路径',
      back: '返回',
      showHidden: '显示隐藏文件',
      loading: '加载中…',
      empty: '没有子文件夹',
      truncated: '文件夹过多，仅显示前 {count} 个。',
      noDistro: '没有找到 WSL 发行版。请先在 Windows 中安装 WSL。',
      cancel: '取消',
      close: '关闭',
      open: '打开',
      adding: '正在添加…',
      'error.not-found': '目录不存在',
      'error.denied': '没有权限读取这个目录',
      'error.unreadable': '无法读取这个目录',
      'error.wsl-failed': '调用 wsl.exe 失败',
      'error.unsupported': 'Host 不是 Windows，无法使用 WSL',
      'error.network': '无法连接到插件的 Host 路由',
      'error.generic': '出错了',
    }
    const en = {
      title: 'Add workspace',
      chooseHint: 'Where is the folder you want to add?',
      windows: 'Windows folder',
      windowsDesc: 'Use the system folder chooser',
      wsl: 'WSL folder',
      wslDesc: 'Browse Linux directories in a WSL distribution',
      recent: 'Recent WSL locations',
      wslTitle: 'Select WSL Directory',
      distro: 'Distribution',
      editPath: 'Edit path',
      back: 'Back',
      showHidden: 'Show hidden files',
      loading: 'Loading…',
      empty: 'No subfolders',
      truncated: 'Too many folders; only the first {count} are shown.',
      noDistro: 'No WSL distribution found. Install WSL on Windows first.',
      cancel: 'Cancel',
      close: 'Close',
      open: 'Open',
      adding: 'Adding…',
      'error.not-found': 'The directory does not exist',
      'error.denied': 'Permission denied',
      'error.unreadable': 'The directory cannot be read',
      'error.wsl-failed': 'wsl.exe failed',
      'error.unsupported': 'The Host is not Windows; WSL is unavailable',
      'error.network': 'Cannot reach the plugin\'s Host routes',
      'error.generic': 'Something went wrong',
    }

    // Copied from DSH's Modal / Button / Menu primitives and its directory browser dialog.
    const CSS = `
.dwf-root{pointer-events:auto;position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:max(24px,var(--dsh-frame-overlay-top,24px)) 24px}
.dwf-mask{position:absolute;inset:var(--dsh-frame-chrome-top,0px) 0 0;backdrop-filter:var(--dsw-mask-blur)}
.dwf-mask:after{content:"";position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1);animation:dwf-enter var(--ds-transition-duration,.2s) var(--ds-ease-in-out,ease-in-out)}
.dwf-dialog{box-sizing:border-box;position:relative;z-index:1;display:flex;flex-direction:column;gap:0;width:min(380px,100%);padding:0;overflow:hidden;border:0;border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent);animation:dwf-enter var(--ds-transition-duration,.2s) var(--ds-ease-in-out,ease-in-out)}
.dwf-dialog:focus{outline:none}
@keyframes dwf-enter{0%{opacity:0}to{opacity:1}}
@media(prefers-reduced-motion:reduce){.dwf-mask:after,.dwf-dialog{animation:none}}
.dwf-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:22px 14px 4px 24px}
.dwf-title{flex:1;min-width:0;margin:0;font-size:16px;line-height:24px;font-weight:510;color:var(--dsw-alias-label-primary)}
.dwf-iconbtn{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:none;border-radius:var(--dsw-radius-sm);background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary)}
.dwf-iconbtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dwf-iconbtn:disabled{opacity:.4;cursor:not-allowed}
.dwf-iconbtn:focus-visible,.dwf-item:focus-visible,.dwf-row:focus-visible,.dwf-crumb:focus-visible,.dwf-btn:focus-visible,.dwf-select:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
.dwf-desc{margin:0;padding:0 24px;font-size:14px;line-height:22px;color:var(--dsw-alias-label-secondary)}
.dwf-menu{display:flex;flex-direction:column;padding:12px 16px 20px}
.dwf-item{display:flex;align-items:center;gap:10px;width:100%;min-height:34px;padding:8px;border:none;border-radius:var(--dsw-radius-md);background:transparent;cursor:pointer;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);text-align:left}
.dwf-item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dwf-item:disabled{opacity:.4;cursor:not-allowed}
.dwf-item-icon{display:inline-flex;flex:none;width:20px;height:20px;align-items:center;justify-content:center;color:var(--dsw-alias-menu-icon,var(--dsw-alias-label-secondary))}
.dwf-item-text{display:flex;flex-direction:column;min-width:0;flex:1}
.dwf-item-title{font-size:14px;line-height:22px;font-weight:500}
.dwf-item-sub,.dwf-item-mono{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dwf-item-mono{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}
.dwf-item-tag{flex:none;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dwf-label{padding:6px 8px;margin-top:4px;font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary)}
.dwf-sep{height:.5px;margin:3px 2px;background:var(--dsw-alias-border-l2)}
.dwf-error{padding:4px 8px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);word-break:break-word}
.dwf-browser{width:min(680px,100%);height:min(500px,100dvh - 32px);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}
.dwf-bhead{border-bottom:.5px solid var(--dsw-alias-border-l3);display:flex;flex-direction:column;flex:none;gap:8px;padding:16px 14px 8px 24px}
.dwf-titlerow{display:flex;align-items:center;gap:8px;min-height:28px}
.dwf-titlerow .dwf-iconbtn{margin-left:-8px}
.dwf-select{box-sizing:border-box;height:28px;max-width:220px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;cursor:pointer;outline:none}
.dwf-select option{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dwf-crumbbar{box-sizing:border-box;border-radius:var(--dsw-radius-sm);border:1px solid transparent;display:flex;align-items:center;gap:4px;min-height:24px;margin-left:-9px;padding:0 8px}
.dwf-crumbbar:has(.dwf-editzone:enabled:hover),.dwf-crumbbar:has(.dwf-editzone:focus-visible),.dwf-crumbbar:has(.dwf-pathinput){border-color:var(--dsw-alias-border-l2)}
.dwf-trail{scrollbar-width:none;flex:0 1 auto;display:flex;align-items:center;gap:4px;min-width:0;overflow-x:auto}
.dwf-crumbseat{flex:none;display:inline-flex;align-items:center;gap:4px;min-width:0}
.dwf-crumb{text-overflow:ellipsis;white-space:nowrap;max-width:160px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:none;border:none;padding:0;font-size:13px;font-weight:500;line-height:20px;overflow:hidden}
.dwf-crumb:hover{color:var(--dsw-alias-label-primary)}
.dwf-crumb-last{color:var(--dsw-alias-label-primary)}
.dwf-chev{color:var(--dsw-alias-label-tertiary);flex:none}
.dwf-editzone{cursor:text;background:none;border:none;outline:none;flex:1 0 34px;display:flex;justify-content:flex-end;align-items:center;min-width:34px;height:22px;padding:0;color:var(--dsw-alias-label-tertiary)}
.dwf-editzone:enabled:hover,.dwf-editzone:focus-visible{color:var(--dsw-alias-label-primary)}
.dwf-editzone:disabled{cursor:default;color:var(--dsw-alias-label-caption)}
.dwf-pathinput{box-sizing:border-box;flex:1 1 0;min-width:0;height:22px;padding:0;border:none;outline:none;background:none;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.dwf-content{display:flex;flex-direction:column;flex:1 1 0;min-height:0;padding:16px 16px 16px 24px;position:relative}
.dwf-column{display:flex;flex-direction:column;flex:1 1 0;gap:2px;min-height:0;padding-right:8px;overflow-y:auto}
.dwf-row{border-radius:var(--dsw-radius-sm);text-align:left;cursor:pointer;background:none;border:none;flex:none;display:flex;align-items:center;gap:4px;width:100%;height:28px;padding:4px}
.dwf-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dwf-row:disabled{cursor:default}
.dwf-row-icon{color:var(--dsw-alias-label-secondary);flex:none}
.dwf-row-name{text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1 1 0;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px;overflow:hidden}
.dwf-row-hidden .dwf-row-name{color:var(--dsw-alias-label-secondary)}
.dwf-status{padding:4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dwf-content .dwf-error{padding:4px}
.dwf-float{position:absolute;bottom:8px;right:16px;padding:2px 8px;background:var(--dsw-alias-bg-layer-2);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dwf-foot{border-top:.5px solid var(--dsw-alias-border-l3);flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:16px 24px}
.dwf-toggle{display:inline-flex;align-items:center;gap:4px;padding:0;border:none;background:none;cursor:pointer;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:13px;font-weight:500;line-height:20px}
.dwf-toggle:hover{color:var(--dsw-alias-label-primary)}
.dwf-toggle[aria-pressed=true]{color:var(--dsw-alias-label-primary)}
.dwf-gap{flex:1 1 0}
.dwf-unc{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dwf-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:36px;min-width:72px;padding:0 14px;border:none;border-radius:var(--dsw-radius-md);cursor:pointer;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);background:transparent}
.dwf-btn:disabled{cursor:not-allowed;opacity:.4}
.dwf-btn-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.dwf-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dwf-btn-outline{border:.5px solid var(--dsw-alias-border-l3)}
.dwf-btn-outline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
`

    // ── glyphs (original artwork, 16px grid, currentColor) ─────────────────────────
    const svg = (size, ...children) => h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true }, ...children)
    const stroke = { stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round' }
    const IconFolder = (size = 16) => svg(size, h('path', { d: 'M2 4.5A1.5 1.5 0 0 1 3.5 3h2.8l1.4 1.5h4.8A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z', ...stroke }))
    const IconTerminal = (size = 16) => svg(size, h('rect', { x: 1.75, y: 2.75, width: 12.5, height: 10.5, rx: 2, ...stroke }), h('path', { d: 'M4.5 6.5 6.5 8l-2 1.5M8.5 10h3', ...stroke }))
    const IconWindows = (size = 16) => svg(size, h('path', { d: 'M2.5 3.8 7 3.2v4.3H2.5zM8.2 3 13.5 2.3v5.2H8.2zM2.5 8.5H7v4.3l-4.5-.6zM8.2 8.5h5.3v5.2L8.2 13z', fill: 'currentColor' }))
    const IconChevron = (size = 14) => svg(size, h('path', { d: 'm6 4 4 4-4 4', ...stroke }))
    const IconBack = (size = 16) => svg(size, h('path', { d: 'm10 4-4 4 4 4', ...stroke }))
    const IconClose = (size = 16) => svg(size, h('path', { d: 'm4 4 8 8M12 4l-8 8', ...stroke }))
    const IconEdit = (size = 14) => svg(size, h('path', { d: 'M10.5 3.2 12.8 5.5 6 12.3 3.3 12.7 3.7 10z', ...stroke }))
    const IconCheck = (size = 14) => svg(size, h('path', { d: 'm3.5 8.5 3 3 6-7', ...stroke }))
    const IconClock = (size = 16) => svg(size, h('circle', { cx: 8, cy: 8, r: 5.75, ...stroke }), h('path', { d: 'M8 5v3.2l2 1.3', ...stroke }))

    // ── small helpers ──────────────────────────────────────────────────────────────
    function createStore() {
      let state = null
      const listeners = new Set()
      return {
        get: () => state,
        set(next) { state = next; for (const listener of [...listeners]) listener() },
        subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
      }
    }

    function readJson(key, fallback) {
      try {
        const raw = globalThis.localStorage?.getItem(key)
        return raw ? JSON.parse(raw) : fallback
      } catch { return fallback }
    }
    function writeJson(key, value) {
      try { globalThis.localStorage?.setItem(key, JSON.stringify(value)) } catch { /* storage unavailable */ }
    }
    function rememberRecent(entry) {
      const list = readJson(RECENT_KEY, []).filter((item) => !(item && item.distro === entry.distro && item.path === entry.path))
      list.unshift({ distro: entry.distro, path: entry.path })
      writeJson(RECENT_KEY, list.slice(0, 5))
      writeJson(DISTRO_KEY, entry.distro)
    }

    function toUnc(distro, path) {
      const rest = path === '/' ? '' : path.replace(/^\/+/, '').split('/').join('\\')
      return `\\\\wsl.localhost\\${distro}\\${rest}`
    }

    async function getJson(route, params, signal) {
      const query = new URLSearchParams(params || {}).toString()
      let response
      try {
        response = await fetch(`${ROUTE}/${route}${query ? `?${query}` : ''}`, { headers: { accept: 'application/json' }, signal })
      } catch (error) {
        if (error && error.name === 'AbortError') throw error
        throw Object.assign(new Error(String((error && error.message) || error)), { code: 'network' })
      }
      let body = null
      try { body = await response.json() } catch { /* not JSON */ }
      if (body === null) throw Object.assign(new Error(`HTTP ${response.status}`), { code: 'network' })
      if (body.error) throw Object.assign(new Error(body.message || body.error), { code: body.error })
      return body
    }

    // Page-lifetime caches: reopening the dialog or stepping back lands instantly, and every
    // cached view is revalidated in the background.
    const cache = { distros: null, homes: new Map(), lists: new Map() }
    const listKey = (distro, path) => `${distro}\u0000${path}`
    function fetchDistros(signal) {
      return getJson('distros', {}, signal).then((r) => { cache.distros = Array.isArray(r.distros) ? r.distros : []; return cache.distros })
    }
    function fetchHome(distro, signal) {
      if (cache.homes.has(distro)) return Promise.resolve(cache.homes.get(distro))
      return getJson('home', { distro }, signal).then((r) => { const home = r.home || '/'; cache.homes.set(distro, home); return home })
    }
    function fetchList(distro, path, signal) {
      return getJson('list', { distro, path }, signal).then((r) => { cache.lists.set(listKey(distro, r.path), r); return r })
    }
    function preferredDistro(list) {
      const remembered = readJson(DISTRO_KEY, '')
      return (list.find((d) => d.name === remembered) || list.find((d) => d.default) || list[0])?.name ?? ''
    }
    /** Boot the distribution and fill the caches while the user is still reading the first dialog. */
    function prefetch() {
      const run = async () => {
        const list = cache.distros ?? await fetchDistros()
        const distro = preferredDistro(list)
        if (!distro) return
        getJson('warm', { distro }).catch(() => {})
        const home = await fetchHome(distro)
        if (!cache.lists.has(listKey(distro, home))) await fetchList(distro, home)
      }
      run().catch(() => {})
    }

    function describeError(t, error) {
      if (!error) return ''
      const key = `error.${error.code || 'generic'}`
      const label = t(key)
      const head = label === key ? t('error.generic') : label
      return error.message && error.message !== head ? `${head} — ${error.message}` : head
    }

    /** Escape closes; Tab stays inside the dialog. */
    function useDialogKeys(ref, onEscape) {
      return (event) => {
        if (event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); onEscape(); return }
        if (event.key !== 'Tab' || ref.current === null) return
        const focusables = [...ref.current.querySelectorAll('button:not(:disabled),select:not(:disabled),input:not(:disabled),[tabindex="0"]')]
        if (focusables.length === 0) return
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        const active = ref.current.ownerDocument.activeElement
        if (event.shiftKey && (active === first || active === ref.current)) { event.preventDefault(); last.focus() }
        else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus() }
      }
    }

    function Frame({ className, label, onDismiss, children, cardRef, onKeyDown }) {
      return h('div', { className: 'dwf-root' },
        h('div', { className: 'dwf-mask', onMouseDown: onDismiss }),
        h('div', {
          ref: cardRef, className: `dwf-dialog ${className || ''}`, role: 'dialog', 'aria-modal': true,
          'aria-label': label, tabIndex: -1, onKeyDown,
        }, children))
    }

    // ── hole occupant: bridges the owner's flow conversation into the store ─────────
    let requestSeq = 0
    function FlowBridge(props) {
      const { open, busy, store, hole } = props
      const latest = React.useRef(props)
      latest.current = props
      const token = React.useRef(null)

      React.useEffect(() => {
        if (!open) {
          if (token.current !== null && store.get()?.token === token.current) store.set(null)
          token.current = null
          return
        }
        if (token.current !== null) return
        const mine = ++requestSeq
        token.current = mine
        store.set({ token: mine, hole, busy: !!latest.current.busy, owner: latest })
      }, [open])

      React.useEffect(() => {
        const current = store.get()
        if (current !== null && current.token === token.current && current.busy !== !!busy) store.set({ ...current, busy: !!busy })
      }, [busy])

      React.useEffect(() => () => {
        if (token.current !== null && store.get()?.token === token.current) store.set(null)
      }, [])
      return null
    }

    // ── overlay ────────────────────────────────────────────────────────────────────
    function PickerOverlay(props) {
      const request = React.useSyncExternalStore(props.store.subscribe, props.store.get, props.store.get)
      if (request === null) return null
      return h(React.Fragment, null,
        h('style', null, CSS),
        h(PickerFlow, { key: request.token, request, t: props.tf, nativePick: props.nativePick }))
    }

    function PickerFlow({ request, t, nativePick }) {
      const [view, setView] = React.useState('choose')
      const [nativeError, setNativeError] = React.useState(null)
      const owner = request.owner
      const busy = request.busy

      const cancel = () => { if (!busy) owner.current.onCancel() }
      const pickWindows = () => {
        setView('native')
        setNativeError(null)
        Promise.resolve().then(() => nativePick()).then((path) => {
          if (path === null || path === undefined) owner.current.onCancel()
          else owner.current.onPicked(path)
        }, (reason) => {
          setView('choose')
          setNativeError(reason instanceof Error ? reason.message : String(reason))
        })
      }
      const pickWsl = (distro, path) => {
        rememberRecent({ distro, path })
        owner.current.onPicked(toUnc(distro, path))
      }

      // The native chooser is a separate window, exactly as with DSH's own button.
      if (view === 'native') return null
      if (view === 'wsl') return h(WslBrowser, { t, busy, onBack: () => setView('choose'), onCancel: cancel, onPick: pickWsl })
      return h(ChooseDialog, { t, busy, nativeError, onWindows: pickWindows, onWsl: () => setView('wsl'), onRecent: pickWsl, onCancel: cancel })
    }

    function ChooseDialog({ t, busy, nativeError, onWindows, onWsl, onRecent, onCancel }) {
      const cardRef = React.useRef(null)
      const firstRef = React.useRef(null)
      const recents = React.useMemo(() => readJson(RECENT_KEY, []).filter((item) => item && typeof item.distro === 'string' && typeof item.path === 'string'), [])
      React.useEffect(() => { prefetch(); (firstRef.current || cardRef.current)?.focus() }, [])
      const item = (key, icon, title, sub, onClick, ref) => h('button', {
        key, ref, type: 'button', className: 'dwf-item', onClick, disabled: busy,
      },
      h('span', { className: 'dwf-item-icon' }, icon),
      h('span', { className: 'dwf-item-text' },
        h('span', { className: 'dwf-item-title' }, title),
        h('span', { className: 'dwf-item-sub' }, sub)))
      return h(Frame, {
        cardRef, label: t('title'), onDismiss: onCancel, onKeyDown: useDialogKeys(cardRef, onCancel),
      },
      h('div', { className: 'dwf-head' },
        h('h2', { className: 'dwf-title' }, t('title')),
        h('button', { type: 'button', className: 'dwf-iconbtn', 'aria-label': t('close'), title: t('close'), onClick: onCancel, disabled: busy }, IconClose())),
      h('p', { className: 'dwf-desc' }, busy ? t('adding') : t('chooseHint')),
      h('div', { className: 'dwf-menu' },
        item('windows', IconWindows(16), t('windows'), t('windowsDesc'), onWindows),
        item('wsl', IconTerminal(18), t('wsl'), t('wslDesc'), onWsl, firstRef),
        nativeError ? h('div', { className: 'dwf-error', role: 'alert' }, nativeError) : null,
        recents.length > 0 ? h('div', { className: 'dwf-sep' }) : null,
        recents.length > 0 ? h('div', { className: 'dwf-label' }, t('recent')) : null,
        recents.map((entry) => h('button', {
          key: `${entry.distro}:${entry.path}`, type: 'button', className: 'dwf-item', disabled: busy,
          title: toUnc(entry.distro, entry.path), onClick: () => onRecent(entry.distro, entry.path),
        },
        h('span', { className: 'dwf-item-icon' }, IconClock(14)),
        h('span', { className: 'dwf-item-mono' }, entry.path),
        h('span', { className: 'dwf-item-tag' }, entry.distro)))))
    }

    function WslBrowser({ t, busy, onBack, onCancel, onPick }) {
      const cardRef = React.useRef(null)
      const listRef = React.useRef(null)
      const [distros, setDistros] = React.useState(cache.distros)
      const [distro, setDistro] = React.useState(() => (cache.distros ? preferredDistro(cache.distros) : ''))
      const [listing, setListing] = React.useState(() => {
        if (!cache.distros) return null
        const d = preferredDistro(cache.distros)
        const home = cache.homes.get(d)
        return home === undefined ? null : cache.lists.get(listKey(d, home)) ?? null
      })
      const [loading, setLoading] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [showHidden, setShowHidden] = React.useState(false)
      const [editing, setEditing] = React.useState(null) // draft path while the path editor is open
      const inflight = React.useRef(null)

      const begin = () => {
        inflight.current?.abort()
        const controller = new AbortController()
        inflight.current = controller
        setLoading(true)
        setError(null)
        return controller
      }
      const settle = (controller, reason) => {
        if (controller.signal.aborted) return
        setLoading(false)
        if (reason !== undefined) setError(reason)
      }

      const navigate = (name, target) => {
        if (!name) return
        const cached = cache.lists.get(listKey(name, target))
        if (cached) { setListing(cached); listRef.current?.scrollTo?.(0, 0) }
        const controller = begin()
        fetchList(name, target, controller.signal).then((result) => {
          if (controller.signal.aborted) return
          setListing(result)
          if (!cached) listRef.current?.scrollTo?.(0, 0)
          settle(controller)
        }, (reason) => settle(controller, reason))
      }
      const goHome = (name) => {
        const controller = begin()
        getJson('warm', { distro: name }).catch(() => {})
        fetchHome(name, controller.signal).then((home) => {
          if (!controller.signal.aborted) navigate(name, home)
        }, (reason) => { if (!controller.signal.aborted) navigate(name, '/'); else settle(controller, reason) })
      }

      React.useEffect(() => {
        cardRef.current?.focus()
        const controller = begin()
        fetchDistros(controller.signal).then((list) => {
          if (controller.signal.aborted) return
          setDistros(list)
          if (list.length === 0) { settle(controller); return }
          const initial = preferredDistro(list)
          setDistro(initial)
          if (listing !== null && listing.distro === initial) navigate(initial, listing.path)
          else goHome(initial)
        }, (reason) => { setDistros((current) => current ?? []); settle(controller, reason) })
        return () => inflight.current?.abort()
      }, [])

      const changeDistro = (name) => {
        setDistro(name)
        setListing(null)
        setEditing(null)
        goHome(name)
      }

      const entries = listing ? listing.entries.filter((entry) => showHidden || !entry.hidden) : []
      const current = listing !== null && listing.distro === distro ? listing : null
      const canOpen = !busy && current !== null
      const segments = current === null ? [] : current.path.split('/').filter(Boolean)

      const submitPath = () => {
        const target = (editing ?? '').trim()
        setEditing(null)
        if (target) navigate(distro, target.startsWith('/') ? target : `/${target}`)
      }

      let body
      if (distros === null || (loading && current === null)) body = h('div', { className: 'dwf-status' }, t('loading'))
      else if (distros.length === 0 && !error) body = h('div', { className: 'dwf-status' }, t('noDistro'))
      else if (current === null) body = null
      else if (entries.length === 0) body = h('div', { className: 'dwf-status' }, t('empty'))
      else {
        body = entries.map((entry) => h('button', {
          key: entry.path, type: 'button', disabled: busy, title: entry.name,
          className: `dwf-row${entry.hidden ? ' dwf-row-hidden' : ''}`,
          onClick: () => navigate(distro, entry.path),
        },
        h('span', { className: 'dwf-row-icon' }, IconFolder(16)),
        h('span', { className: 'dwf-row-name' }, entry.name),
        h('span', { className: 'dwf-chev' }, IconChevron(14))))
      }

      const crumbs = current === null ? null : h('div', { className: 'dwf-trail' },
        h('span', { className: 'dwf-crumbseat' },
          h('button', {
            type: 'button', className: `dwf-crumb${segments.length === 0 ? ' dwf-crumb-last' : ''}`,
            onClick: () => navigate(distro, '/'), disabled: busy,
          }, '/')),
        segments.map((segment, index) => h('span', { key: index, className: 'dwf-crumbseat' },
          index === 0 ? null : h('span', { className: 'dwf-chev' }, IconChevron(12)),
          h('button', {
            type: 'button', disabled: busy,
            className: `dwf-crumb${index === segments.length - 1 ? ' dwf-crumb-last' : ''}`,
            onClick: () => navigate(distro, `/${segments.slice(0, index + 1).join('/')}`),
          }, segment))))

      const onKeyDown = useDialogKeys(cardRef, () => {
        if (editing !== null) { setEditing(null); cardRef.current?.focus() } else onCancel()
      })

      return h(Frame, { className: 'dwf-browser', cardRef, label: t('wslTitle'), onDismiss: onCancel, onKeyDown },
        h('div', { className: 'dwf-bhead' },
          h('div', { className: 'dwf-titlerow' },
            h('button', { type: 'button', className: 'dwf-iconbtn', 'aria-label': t('back'), title: t('back'), onClick: onBack, disabled: busy }, IconBack()),
            h('h2', { className: 'dwf-title' }, t('wslTitle')),
            h('select', {
              className: 'dwf-select', value: distro, 'aria-label': t('distro'), title: t('distro'),
              disabled: busy || !distros || distros.length === 0,
              onChange: (event) => changeDistro(event.target.value),
            }, (distros || []).map((d) => h('option', { key: d.name, value: d.name }, d.name))),
            h('button', { type: 'button', className: 'dwf-iconbtn', 'aria-label': t('close'), title: t('close'), onClick: onCancel, disabled: busy }, IconClose())),
          h('div', { className: 'dwf-crumbbar' },
            editing !== null
              ? h('input', {
                className: 'dwf-pathinput', value: editing, spellCheck: false, autoFocus: true, 'aria-label': t('editPath'),
                onChange: (event) => setEditing(event.target.value),
                onKeyDown: (event) => { if (event.key === 'Enter') { event.preventDefault(); submitPath() } },
                onBlur: () => setEditing(null),
              })
              : h(React.Fragment, null,
                crumbs,
                h('button', {
                  type: 'button', className: 'dwf-editzone', 'aria-label': t('editPath'), title: t('editPath'),
                  disabled: busy || !distro,
                  onClick: () => setEditing(current === null ? '/' : current.path === '/' ? '/' : `${current.path}/`),
                }, IconEdit(14))))),
        h('div', { className: 'dwf-content' },
          error ? h('div', { className: 'dwf-error', role: 'alert' }, describeError(t, error)) : null,
          h('div', { ref: listRef, className: 'dwf-column', role: 'list', 'aria-busy': loading }, body),
          current && current.truncated ? h('div', { className: 'dwf-status' }, t('truncated', { count: current.entries.length })) : null,
          loading && current !== null ? h('div', { className: 'dwf-float', role: 'status' }, t('loading')) : null),
        h('div', { className: 'dwf-foot' },
          h('button', {
            type: 'button', className: 'dwf-toggle', 'aria-pressed': showHidden,
            onClick: () => setShowHidden((value) => !value),
          }, showHidden ? IconCheck(14) : null, t('showHidden')),
          h('span', { className: 'dwf-gap' }),
          current ? h('span', { className: 'dwf-unc', title: current.unc }, busy ? t('adding') : current.unc) : null,
          h('button', { type: 'button', className: 'dwf-btn dwf-btn-outline', onClick: onCancel, disabled: busy }, t('cancel')),
          h('button', {
            type: 'button', className: 'dwf-btn dwf-btn-primary', disabled: !canOpen,
            onClick: () => canOpen && onPick(current.distro, current.path),
          }, t('open'))))
    }

    return {
      inject: ['slots', 'locale', 'uiWorkspace'],
      apply(ctx) {
        const store = createStore()
        ctx.effect(() => {
          const disposers = [ctx.locale.register(NS, 'zh', zh), ctx.locale.register(NS, 'en', en)]
          return () => { for (const dispose of disposers) dispose() }
        }, 'dsh-wsl-folder: dictionaries')
        const tf = ctx.locale.bind(NS)
        // Exactly what DSH's shipped native occupant calls for a Windows folder.
        const nativePick = () => {
          const desktop = globalThis.__DSH_DIRECTORY_PICKER__
          return desktop === undefined ? ctx.uiWorkspace.pickDirectory() : desktop.pick()
        }
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-wsl-folder.dialog',
          inject: () => ({ store, tf, nativePick }),
        }, PickerOverlay))
        for (const hole of HOLES) {
          // Lower priority than the shipped occupant (0): the lowest priority renders.
          ctx.slots.inject(hole, () => ctx.slots.register({
            name: hole,
            priority: -10,
            inject: () => ({ store, hole }),
          }, FlowBridge))
        }
      },
    }
  },
})
