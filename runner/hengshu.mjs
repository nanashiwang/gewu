#!/usr/bin/env node
/**
 * 衡术 Hengshu —— 本地 Skill Runner CLI
 *
 *   hengshu login [--hub <url>]                设备码登录
 *   hengshu whoami                             查看登录归属
 *   hengshu install <slug>                     安装 Skill 到本地 ~/.hengshu/skills
 *   hengshu list                               列出已安装 Skill
 *   hengshu run <slug|file> [选项]              运行（已装则离线读本地）
 *   hengshu outdated                           检查有更新的 Skill
 *   hengshu update [<slug>]                    更新（不带 slug 则全部）
 *   hengshu remove <slug>                      移除已安装 Skill
 *   hengshu doctor [--endpoint <url>] [--model <m>]   体检：登录/endpoint/模型
 *
 * run 选项：--endpoint --model --key --hub --in key=value --raw
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

const RUNNER_VERSION = '0.2.0'
const HOME = path.join(os.homedir(), '.hengshu')
const CONFIG_PATH = path.join(HOME, 'config.json')
const SKILLS_DIR = path.join(HOME, 'skills')
const DEFAULT_HUB = 'http://localhost:3000'

// ───────── config / 本地 ─────────
function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  } catch {
    return {}
  }
}
function writeConfig(cfg) {
  fs.mkdirSync(HOME, { recursive: true })
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2))
  try {
    fs.chmodSync(CONFIG_PATH, 0o600)
  } catch {
    /* noop */
  }
}
function requireAuth(args) {
  const cfg = readConfig()
  if (!cfg.token) throw new Error('尚未登录，请先 hengshu login')
  return { hub: (args.hub || cfg.hub || DEFAULT_HUB).replace(/\/$/, ''), token: cfg.token }
}
function bearer(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
}

function skillDir(slug) {
  return path.join(SKILLS_DIR, slug)
}
function saveInstalled(slug, manifestYaml, meta) {
  const dir = skillDir(slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'skill.yaml'), manifestYaml)
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2))
}
function listInstalled() {
  try {
    return fs
      .readdirSync(SKILLS_DIR)
      .map((slug) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(SKILLS_DIR, slug, 'meta.json'), 'utf8'))
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}
function isInstalled(slug) {
  return fs.existsSync(path.join(skillDir(slug), 'skill.yaml'))
}
function removeInstalled(slug) {
  fs.rmSync(skillDir(slug), { recursive: true, force: true })
}

function parseArgs(argv) {
  const a = { _: [], in: {} }
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    if (t === '--in') {
      const kv = argv[++i] || ''
      const eq = kv.indexOf('=')
      if (eq > 0) a.in[kv.slice(0, eq)] = kv.slice(eq + 1)
    } else if (t.startsWith('--')) {
      const k = t.slice(2)
      if (k === 'raw') a.raw = true
      else a[k] = argv[++i]
    } else {
      a._.push(t)
    }
  }
  return a
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ───────── login / whoami ─────────
async function cmdLogin(args) {
  const cfg = readConfig()
  const hub = (args.hub || cfg.hub || DEFAULT_HUB).replace(/\/$/, '')
  const codeRes = await fetch(`${hub}/v1/auth/device/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runnerVersion: RUNNER_VERSION, os: process.platform, arch: process.arch }),
  })
  if (!codeRes.ok) throw new Error(`申请设备码失败（${codeRes.status}）`)
  const code = await codeRes.json()
  console.log('\n请在浏览器打开并输入设备码授权：\n')
  console.log(`   ${code.verification_uri}?code=${encodeURIComponent(code.user_code)}`)
  console.log(`   设备码：${code.user_code}\n等待授权中…`)
  const interval = (code.interval || 3) * 1000
  const deadline = Date.now() + (code.expires_in || 600) * 1000
  while (Date.now() < deadline) {
    await sleep(interval)
    const tRes = await fetch(`${hub}/v1/auth/device/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code: code.device_code }),
    })
    if (tRes.status === 202) continue
    const data = await tRes.json().catch(() => ({}))
    if (tRes.ok && data.access_token) {
      writeConfig({ hub, token: data.access_token, runnerId: data.runner_id })
      console.log(`\n✅ 登录成功，令牌已保存到 ${CONFIG_PATH}`)
      return
    }
    if (data.error && data.error !== 'authorization_pending') throw new Error(`登录失败：${data.error}`)
  }
  throw new Error('设备码已过期，请重新 hengshu login')
}

async function cmdWhoami(args) {
  const { hub, token } = requireAuth(args)
  const res = await fetch(`${hub}/v1/runner/me`, { headers: bearer(token) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || '令牌无效，请重新登录')
  console.log(`用户：${data.user?.username}  ·  Runner：${data.runnerId}  ·  信任级别：${data.trustedLevel}`)
}

// ───────── install / list / remove ─────────
async function installSlug(hub, token, slug) {
  const res = await fetch(`${hub}/v1/runner/install`, {
    method: 'POST',
    headers: bearer(token),
    body: JSON.stringify({ slug }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.ok) throw new Error(data.error || `安装失败（${res.status}）`)
  saveInstalled(slug, data.manifest, {
    slug: data.slug,
    name: data.name,
    version: data.version,
    checksum: data.checksum,
    installedAt: new Date().toISOString(),
  })
  return data
}
async function cmdInstall(args) {
  const { hub, token } = requireAuth(args)
  const slug = args._[0]
  if (!slug) throw new Error('用法：hengshu install <slug>')
  const data = await installSlug(hub, token, slug)
  console.log(`✅ 已安装 ${data.name} (v${data.version}) → ${skillDir(slug)}/skill.yaml`)
  console.log(`   checksum ${data.checksum}`)
}
function cmdList() {
  const items = listInstalled()
  if (items.length === 0) return console.log('（暂无已安装 Skill，用 hengshu install <slug> 安装）')
  console.log('已安装 Skill：')
  for (const m of items) console.log(`  · ${m.slug}  v${m.version}  ${(m.checksum || '').slice(0, 26)}…`)
}
async function cmdRemove(args) {
  const slug = args._[0]
  if (!slug) throw new Error('用法：hengshu remove <slug>')
  removeInstalled(slug)
  try {
    const { hub, token } = requireAuth(args)
    await fetch(`${hub}/v1/runner/uninstall`, { method: 'POST', headers: bearer(token), body: JSON.stringify({ slug }) })
  } catch {
    /* 未登录也允许删本地 */
  }
  console.log(`✅ 已移除 ${slug}`)
}

// ───────── outdated / update ─────────
async function checkUpdates(hub, token, items) {
  const res = await fetch(`${hub}/v1/runner/check`, {
    method: 'POST',
    headers: bearer(token),
    body: JSON.stringify({ items }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || '检查更新失败')
  return data.updates || []
}
async function cmdOutdated(args) {
  const { hub, token } = requireAuth(args)
  const installed = listInstalled()
  if (installed.length === 0) return console.log('（暂无已安装 Skill）')
  const updates = await checkUpdates(hub, token, installed.map((m) => ({ slug: m.slug, checksum: m.checksum })))
  const out = updates.filter((u) => u.outdated)
  if (out.length === 0) return console.log('✅ 全部为最新')
  console.log('有更新：')
  for (const u of out) console.log(`  · ${u.slug}  → v${u.version}`)
}
async function cmdUpdate(args) {
  const { hub, token } = requireAuth(args)
  const only = args._[0]
  const installed = listInstalled().filter((m) => (only ? m.slug === only : true))
  if (installed.length === 0) return console.log('（无可更新项）')
  const updates = await checkUpdates(hub, token, installed.map((m) => ({ slug: m.slug, checksum: m.checksum })))
  const out = updates.filter((u) => u.outdated)
  if (out.length === 0) return console.log('✅ 全部为最新')
  for (const u of out) {
    const data = await installSlug(hub, token, u.slug)
    console.log(`⬆️  ${u.slug} 已更新到 v${data.version}`)
  }
}

// ───────── run ─────────
async function loadManifest(ref, hub) {
  if (fs.existsSync(ref)) {
    const text = fs.readFileSync(ref, 'utf8')
    if (ref.endsWith('.yaml') || ref.endsWith('.yml')) {
      const YAML = (await import('yaml')).default
      return YAML.parse(text)
    }
    return JSON.parse(text)
  }
  const base = (hub || DEFAULT_HUB).replace(/\/$/, '')
  const res = await fetch(`${base}/v1/skills/${ref}/manifest?format=json`)
  if (!res.ok) throw new Error(`无法从 Hub 拉取 Skill：${ref}（${res.status}）`)
  return res.json()
}
function render(template, vars) {
  return (template || '').replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m, k) => {
    const v = vars[k]
    return v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v)
  })
}
async function collectInputs(schema, preset) {
  const vars = { ...preset }
  const rl = readline.createInterface({ input, output })
  try {
    for (const [key, def] of Object.entries(schema || {})) {
      if (vars[key] != null && vars[key] !== '') continue
      const label = (def && def.label) || key
      const req = def && def.required ? '（必填）' : '（可选，回车跳过）'
      const opts = def && def.options ? `[${def.options.map((o) => (typeof o === 'string' ? o : o.value || o.label)).join('/')}] ` : ''
      const ans = (await rl.question(`· ${label}${req} ${opts}`)).trim()
      if (ans) vars[key] = ans
      else if (def && def.required) {
        console.error(`缺少必填字段：${label}`)
        process.exit(1)
      }
    }
  } finally {
    rl.close()
  }
  return vars
}
async function cmdRun(args) {
  const cfg = readConfig()
  const ref = args._[0]
  if (!ref) throw new Error('用法：hengshu run <slug|file> [选项]')

  // 已安装的 slug → 离线读本地；否则按文件或从 Hub 拉取
  let manifestRef = ref
  let offline = false
  if (!fs.existsSync(ref) && isInstalled(ref)) {
    manifestRef = path.join(skillDir(ref), 'skill.yaml')
    offline = true
  }
  const manifest = await loadManifest(manifestRef, args.hub || cfg.hub)
  const endpoint = (args.endpoint || 'http://localhost:11434/v1').replace(/\/$/, '')
  const model =
    args.model ||
    manifest.models?.local_recommended?.[0] ||
    manifest.recommended_models?.local?.[0] ||
    manifest.recommended_models?.cloud?.[0]
  if (!model) throw new Error('未指定模型，且 manifest 无推荐模型。请用 --model 指定。')

  if (!args.raw) {
    console.log(`\n▸ Skill：${manifest.name}  (v${manifest.version})${offline ? '  [本地已安装]' : ''}`)
    console.log(`▸ 模型：${model}  @  ${endpoint}\n`)
  }

  const vars = await collectInputs(manifest.input_schema, args.in)
  const userTemplate = manifest.prompt?.user_template ?? manifest.prompt_template ?? ''
  const systemTemplate = manifest.prompt?.system ?? ''
  const sys = render(systemTemplate, vars)
  const messages = [...(sys ? [{ role: 'system', content: sys }] : []), { role: 'user', content: render(userTemplate, vars) }]

  const start = Date.now()
  const res = await fetch(`${endpoint}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(args.key ? { Authorization: `Bearer ${args.key}` } : {}) },
    body: JSON.stringify({ model, messages }),
  })
  const latency = Date.now() - start
  if (!res.ok) throw new Error(`模型调用失败（${res.status}）：${(await res.text()).slice(0, 300)}`)
  const data = await res.json()
  const text = data?.choices?.[0]?.message?.content ?? ''

  if (args.raw) console.log(text)
  else {
    console.log('—'.repeat(48))
    console.log(text)
    console.log('—'.repeat(48))
    const u = data.usage || {}
    console.log(`⏱  ${latency}ms   tokens: ${u.total_tokens ?? '?'}   （本地/自有算力，未经中央服务器）`)
  }

  // 已安装 + 已登录 → 刷新活跃时间（best-effort）
  if (offline && cfg.token) {
    const hub = (args.hub || cfg.hub || DEFAULT_HUB).replace(/\/$/, '')
    fetch(`${hub}/v1/runner/touch`, { method: 'POST', headers: bearer(cfg.token), body: JSON.stringify({ slug: ref }) }).catch(() => {})
  }
}

// ───────── doctor ─────────
async function cmdDoctor(args) {
  const cfg = readConfig()
  const ok = (b) => (b ? '✓' : '✗')
  console.log('衡术 Runner 体检：')
  console.log(`  ${ok(fs.existsSync(CONFIG_PATH))} 配置文件 ${CONFIG_PATH}`)
  // 登录
  let loginOk = false
  if (cfg.token) {
    try {
      const hub = (cfg.hub || DEFAULT_HUB).replace(/\/$/, '')
      const r = await fetch(`${hub}/v1/runner/me`, { headers: bearer(cfg.token) })
      loginOk = r.ok
    } catch {
      /* noop */
    }
  }
  console.log(`  ${ok(loginOk)} 登录状态（${cfg.token ? (loginOk ? '有效' : '令牌失效') : '未登录'}）`)
  // endpoint
  const endpoint = (args.endpoint || 'http://localhost:11434/v1').replace(/\/$/, '')
  let models = []
  let epOk = false
  try {
    const r = await fetch(`${endpoint}/models`, {
      headers: args.key ? { Authorization: `Bearer ${args.key}` } : {},
    })
    if (r.ok) {
      const j = await r.json()
      models = (j.data || []).map((m) => m.id)
      epOk = true
    }
  } catch {
    /* noop */
  }
  console.log(`  ${ok(epOk)} endpoint ${endpoint}（${epOk ? `${models.length} 个模型` : '不可达'}）`)
  // model
  if (args.model) {
    const has = models.includes(args.model)
    console.log(`  ${ok(has)} 模型 ${args.model}（${epOk ? (has ? '可用' : '不在列表') : '无法确认'}）`)
  }
  console.log(`  · 已安装 Skill：${listInstalled().length} 个`)
}

// ───────── main ─────────
async function main() {
  const argv = process.argv.slice(2)
  const cmd = argv[0]
  const args = parseArgs(argv.slice(1))
  const table = {
    login: cmdLogin,
    whoami: cmdWhoami,
    install: cmdInstall,
    list: cmdList,
    run: cmdRun,
    outdated: cmdOutdated,
    update: cmdUpdate,
    remove: cmdRemove,
    doctor: cmdDoctor,
  }
  if (table[cmd]) return table[cmd](args)
  console.log('用法：hengshu <login|whoami|install|list|run|outdated|update|remove|doctor> [选项]')
  process.exit(cmd ? 1 : 0)
}

main().catch((e) => {
  console.error('错误：', e.message)
  process.exit(1)
})
