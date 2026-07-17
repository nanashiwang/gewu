#!/usr/bin/env node
/**
 * 格物 —— 本地 Skill Runner CLI
 *
 *   gewu login [--hub <url>]                设备码登录
 *   gewu whoami                             查看登录归属
 *   gewu rotate-token                       轮换本机 Runner 令牌
 *   gewu install <slug>                     安装 Skill 到本地 ~/.gewu/skills
 *   gewu list                               列出已安装 Skill
 *   gewu run <slug|file> [选项]              运行（已装则离线读本地）
 *   gewu outdated                           检查有更新的 Skill
 *   gewu update [<slug>]                    更新（不带 slug 则全部）
 *   gewu remove <slug>                      移除已安装 Skill
 *   gewu doctor [--endpoint <url>] [--model <m>]   体检：登录/endpoint/模型
 *
 * run 选项：--endpoint --model --key --hub --in key=value --raw
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { normalizeSkillSlug, resolveSkillDir } from './pathSafety.mjs'

const RUNNER_VERSION = '0.2.0'
const HOME = path.join(os.homedir(), '.gewu')
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
  if (!cfg.token) throw new Error('尚未登录，请先 gewu login')
  return { hub: (args.hub || cfg.hub || DEFAULT_HUB).replace(/\/$/, ''), token: cfg.token }
}
function bearer(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
}

// ───────── manifest 校验/验签 ─────────
function sortKeys(v) {
  return Array.isArray(v)
    ? v.map(sortKeys)
    : v && typeof v === 'object'
      ? Object.keys(v).sort().reduce((a, k) => ((a[k] = sortKeys(v[k])), a), {})
      : v
}
function canonical(obj) {
  return Buffer.from(JSON.stringify(sortKeys(obj)), 'utf8')
}
function verifyManifest(manifest, pubB64) {
  const { integrity = {}, ...core } = manifest
  const canon = canonical(core)
  const checksumOk =
    !integrity.checksum ||
    'sha256:' + crypto.createHash('sha256').update(canon).digest('hex') === integrity.checksum
  let signed = false
  let sigValid = false
  if (integrity.signature && pubB64) {
    signed = true
    try {
      const pub = crypto.createPublicKey({ key: Buffer.from(pubB64, 'base64'), format: 'der', type: 'spki' })
      sigValid = crypto.verify(null, canon, pub, Buffer.from(integrity.signature, 'base64'))
    } catch {
      /* invalid */
    }
  }
  return { checksumOk, signed, sigValid }
}
let _pub
async function getPublicKey(hub) {
  if (_pub !== undefined) return _pub
  try {
    const r = await fetch(`${hub}/v1/keys`)
    _pub = r.ok ? (await r.json()).publicKey || null : null
  } catch {
    _pub = null
  }
  return _pub
}

function skillDir(slug) {
  return resolveSkillDir(SKILLS_DIR, slug)
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
      .map((directoryName) => {
        try {
          const slug = normalizeSkillSlug(directoryName)
          const meta = JSON.parse(fs.readFileSync(path.join(skillDir(slug), 'meta.json'), 'utf8'))
          return { ...meta, slug }
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
  const BOOL = new Set(['raw', 'report', 'anon', 'allow-unsigned'])
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    if (t === '--in') {
      const kv = argv[++i] || ''
      const eq = kv.indexOf('=')
      if (eq > 0) a.in[kv.slice(0, eq)] = kv.slice(eq + 1)
    } else if (t.startsWith('--')) {
      const k = t.slice(2)
      if (BOOL.has(k)) a[k] = true
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
  throw new Error('设备码已过期，请重新 gewu login')
}

async function cmdWhoami(args) {
  const { hub, token } = requireAuth(args)
  const res = await fetch(`${hub}/v1/runner/me`, { headers: bearer(token) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || '令牌无效，请重新登录')
  console.log(`用户：${data.user?.username}  ·  Runner：${data.runnerId}  ·  信任级别：${data.trustedLevel}`)
}

async function cmdRotateToken(args) {
  const cfg = readConfig()
  const { hub, token } = requireAuth(args)
  const res = await fetch(`${hub}/v1/runner/rotate`, { method: 'POST', headers: bearer(token) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.access_token) throw new Error(data.error || '轮换失败，请重新登录')
  writeConfig({ ...cfg, hub, token: data.access_token, runnerId: data.runner_id || cfg.runnerId })
  console.log(`✅ Runner 令牌已轮换并保存到 ${CONFIG_PATH}`)
}

// ───────── install / list / remove ─────────
async function installSlug(hub, token, slug, opts = {}) {
  const safeSlug = normalizeSkillSlug(slug)
  const res = await fetch(`${hub}/v1/runner/install`, {
    method: 'POST',
    headers: bearer(token),
    body: JSON.stringify({ slug: safeSlug }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.ok) throw new Error(data.error || `安装失败（${res.status}）`)
  const responseSlug = normalizeSkillSlug(data.slug || safeSlug)
  if (responseSlug !== safeSlug) throw new Error('Hub 返回的 Skill slug 与请求不一致，已拒绝安装')

  // 校验和 + ed25519 验签：默认强制"有校验和 + 已签名 + 签名有效"，杜绝克隆站镜像换签/去签重分发。
  // --allow-unsigned 显式豁免（自建/离线调试用）。
  const allowUnsigned = !!opts.allowUnsigned
  let verify = { signed: false }
  try {
    const YAML = (await import('yaml')).default
    const manifest = YAML.parse(data.manifest)
    const pub = await getPublicKey(hub)
    verify = verifyManifest(manifest, pub)
    if (!verify.checksumOk) throw new Error('manifest 校验和不匹配，拒绝安装')
    if (verify.signed && !verify.sigValid) throw new Error('manifest 签名无效，拒绝安装')
    if (!allowUnsigned) {
      if (!manifest.integrity?.checksum) throw new Error('manifest 缺少校验和，拒绝安装（--allow-unsigned 可跳过）')
      if (!verify.signed) throw new Error('manifest 未签名，拒绝安装（--allow-unsigned 可跳过）')
    }
  } catch (e) {
    if (/拒绝安装/.test(e.message)) throw e
    // 非"拒绝安装"类错误(YAML 解析/取公钥失败)默认也拒装——静默放行=换签攻击面；除非 --allow-unsigned
    if (!allowUnsigned) throw new Error(`manifest 校验失败，拒绝安装：${e.message}（--allow-unsigned 可跳过）`)
  }

  saveInstalled(safeSlug, data.manifest, {
    slug: safeSlug,
    name: data.name,
    version: data.version,
    checksum: data.checksum,
    installedAt: new Date().toISOString(),
  })
  data._verify = verify
  return data
}
async function cmdInstall(args) {
  const { hub, token } = requireAuth(args)
  if (!args._[0]) throw new Error('用法：gewu install <slug> [--allow-unsigned]')
  const slug = normalizeSkillSlug(args._[0])
  const data = await installSlug(hub, token, slug, { allowUnsigned: !!args['allow-unsigned'] })
  console.log(`✅ 已安装 ${data.name} (v${data.version}) → ${skillDir(slug)}/skill.yaml`)
  const v = data._verify || {}
  const tag = v.signed ? (v.sigValid ? '· ✓ 签名有效' : '· ✗ 签名无效') : '· ⚠ 未签名'
  console.log(`   checksum ${data.checksum}  ${tag}`)
  if (data.playbook?.nextActions?.length) {
    console.log('   下一步：')
    for (const action of data.playbook.nextActions.slice(0, 4)) {
      console.log(`   · ${action.label}：${action.description}`)
    }
  }
}
function cmdList() {
  const items = listInstalled()
  if (items.length === 0) return console.log('（暂无已安装 Skill，用 gewu install <slug> 安装）')
  console.log('已安装 Skill：')
  for (const m of items) console.log(`  · ${m.slug}  v${m.version}  ${(m.checksum || '').slice(0, 26)}…`)
}
async function cmdRemove(args) {
  if (!args._[0]) throw new Error('用法：gewu remove <slug>')
  const slug = normalizeSkillSlug(args._[0])
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
  const updates = Array.isArray(data.updates)
    ? data.updates.map((update) => ({ ...update, slug: normalizeSkillSlug(update?.slug) }))
    : []
  updates._playbook = data.playbook
  return updates
}
function printUpdatePlaybook(updates) {
  const playbook = updates?._playbook
  if (!playbook?.nextActions?.length) return
  console.log('下一步：')
  for (const action of playbook.nextActions.slice(0, 3)) {
    console.log(`  · ${action.label}：${action.description}`)
  }
}
async function cmdOutdated(args) {
  const { hub, token } = requireAuth(args)
  const installed = listInstalled()
  if (installed.length === 0) return console.log('（暂无已安装 Skill）')
  const updates = await checkUpdates(hub, token, installed.map((m) => ({ slug: m.slug, checksum: m.checksum })))
  const out = updates.filter((u) => u.outdated)
  if (out.length === 0) {
    console.log('✅ 全部为最新')
    printUpdatePlaybook(updates)
    return
  }
  console.log('有更新：')
  for (const u of out) console.log(`  · ${u.slug}  → v${u.version}`)
  printUpdatePlaybook(updates)
}
async function cmdUpdate(args) {
  const { hub, token } = requireAuth(args)
  const only = args._[0] ? normalizeSkillSlug(args._[0]) : undefined
  const installed = listInstalled().filter((m) => (only ? m.slug === only : true))
  if (installed.length === 0) return console.log('（无可更新项）')
  const updates = await checkUpdates(hub, token, installed.map((m) => ({ slug: m.slug, checksum: m.checksum })))
  const out = updates.filter((u) => u.outdated)
  if (out.length === 0) return console.log('✅ 全部为最新')
  for (const u of out) {
    const data = await installSlug(hub, token, u.slug, { allowUnsigned: !!args['allow-unsigned'] })
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
  const slug = normalizeSkillSlug(ref)
  const base = (hub || DEFAULT_HUB).replace(/\/$/, '')
  const res = await fetch(`${base}/v1/skills/${encodeURIComponent(slug)}/manifest?format=json`)
  if (!res.ok) throw new Error(`无法从 Hub 拉取 Skill：${slug}（${res.status}）`)
  return res.json()
}
function render(template, vars) {
  return (template || '').replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m, k) => {
    const v = vars[k]
    return v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v)
  })
}
function bkt(n) {
  const v = n || 0
  if (v < 100) return '0-100'
  if (v < 500) return '100-500'
  if (v < 2000) return '500-2k'
  if (v < 8000) return '2k-8k'
  return '8k+'
}
function providerFromEndpoint(ep) {
  if (/11434/.test(ep)) return 'ollama'
  if (/1234/.test(ep)) return 'lmstudio'
  if (/localhost|127\.0\.0\.1/.test(ep)) return 'local'
  return 'openai_compatible'
}
function tryJson(text) {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    /* noop */
  }
  const f = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (f) {
    try {
      return JSON.parse(f[1])
    } catch {
      /* noop */
    }
  }
  const b = text.match(/\{[\s\S]*\}/)
  if (b) {
    try {
      return JSON.parse(b[0])
    } catch {
      /* noop */
    }
  }
  return null
}
function checkFormat(outputSchema, text) {
  if (!outputSchema || outputSchema.type !== 'json' || !outputSchema.fields) return true
  const parsed = tryJson(text)
  if (!parsed || typeof parsed !== 'object') return false
  return Object.keys(outputSchema.fields).every((k) => k in parsed)
}
async function collectInputs(schema, preset) {
  const vars = { ...preset }
  const entries = Object.entries(schema || {})
  const pending = entries.filter(([k]) => vars[k] == null || vars[k] === '')
  if (pending.length === 0) return vars

  // 非交互（管道/脚本）：必填缺失报错，可选跳过
  if (!process.stdin.isTTY) {
    for (const [key, def] of pending) {
      if (def && def.required) {
        console.error(`缺少必填字段：${(def && def.label) || key}（非交互模式请用 --in 提供）`)
        process.exit(1)
      }
    }
    return vars
  }

  const rl = readline.createInterface({ input, output })
  try {
    for (const [key, def] of pending) {
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
  if (!ref) throw new Error('用法：gewu run <slug|file> [选项]')

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
  let res = null
  let errorType
  try {
    res = await fetch(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(args.key ? { Authorization: `Bearer ${args.key}` } : {}) },
      body: JSON.stringify({ model, messages }),
    })
  } catch {
    errorType = 'network'
  }
  const latency = Date.now() - start

  let success = false
  let text = ''
  let usage = {}
  if (res && res.ok) {
    const data = await res.json()
    text = data?.choices?.[0]?.message?.content ?? ''
    usage = data.usage || {}
    success = true
  } else if (res) {
    errorType = `http_${res.status}`
  }

  if (success) {
    if (args.raw) console.log(text)
    else {
      console.log('—'.repeat(48))
      console.log(text)
      console.log('—'.repeat(48))
      console.log(`⏱  ${latency}ms   tokens: ${usage.total_tokens ?? '?'}   （本地/自有算力，未经中央服务器）`)
    }
  } else {
    console.error(`模型调用失败：${errorType}`)
  }

  // --report：回传可聚合指标（不含输入/输出原文）
  if (args.report && cfg.token) {
    const slug = manifest.id || ref
    const inputChars = messages.reduce((a, m) => a + (m.content || '').length, 0)
    const payload = {
      slug,
      model,
      modelProvider: providerFromEndpoint(endpoint),
      success,
      latencyMs: latency,
      formatValid: success ? checkFormat(manifest.output_schema, text) : false,
      errorType,
      checksum: manifest.integrity?.checksum,
      inputSizeBucket: bkt(inputChars),
      outputSizeBucket: bkt(text.length),
      anon: !!args.anon,
    }
    const hub = (args.hub || cfg.hub || DEFAULT_HUB).replace(/\/$/, '')
    try {
      const r = await fetch(`${hub}/v1/runner/report`, { method: 'POST', headers: bearer(cfg.token), body: JSON.stringify(payload) })
      const d = await r.json().catch(() => ({}))
      if (!args.raw && d.ok) console.log(`📡 已提交兼容报告${args.anon ? '（匿名）' : ''}　LocalScore=${d.localScore}`)
    } catch {
      /* best-effort */
    }
  }

  // 已安装 + 已登录 → 刷新活跃时间（best-effort）
  if (offline && cfg.token) {
    const hub = (args.hub || cfg.hub || DEFAULT_HUB).replace(/\/$/, '')
    fetch(`${hub}/v1/runner/touch`, { method: 'POST', headers: bearer(cfg.token), body: JSON.stringify({ slug: ref }) }).catch(() => {})
  }

  if (!success) process.exit(1)
}

// ───────── doctor ─────────
async function cmdDoctor(args) {
  const cfg = readConfig()
  const ok = (b) => (b ? '✓' : '✗')
  console.log('格物 Runner 体检：')
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
    'rotate-token': cmdRotateToken,
    install: cmdInstall,
    list: cmdList,
    run: cmdRun,
    outdated: cmdOutdated,
    update: cmdUpdate,
    remove: cmdRemove,
    doctor: cmdDoctor,
  }
  if (table[cmd]) return table[cmd](args)
  console.log('用法：gewu <login|whoami|rotate-token|install|list|run|outdated|update|remove|doctor> [选项]')
  process.exit(cmd ? 1 : 0)
}

main().catch((e) => {
  console.error('错误：', e.message)
  process.exit(1)
})
