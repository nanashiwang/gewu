#!/usr/bin/env node
/**
 * 衡术 Hengshu —— 本地 Skill Runner
 *
 * 下载一个 Skill 能力包后，用你自己的模型（本地 Ollama / LM Studio / vLLM，
 * 或任意 OpenAI 兼容 endpoint）运行它 —— 运行算力在你这边，不经过中央服务器。
 *
 * 用法：
 *   node runner/hengshu-run.mjs <manifest.yaml|.json | skill-slug> [选项]
 *
 * 选项：
 *   --endpoint <url>   OpenAI 兼容 endpoint（默认 http://localhost:11434/v1，即 Ollama）
 *   --model <name>     模型名（默认取 manifest.recommended_models.local[0]）
 *   --key <key>        API Key（本地模型一般留空）
 *   --hub <url>        传入 slug 时从该 Hub 拉取 manifest（默认 http://localhost:3000）
 *   --in <key=value>   预填输入字段（可重复）；未提供的必填字段会交互询问
 *   --raw              直接输出模型原文，不打印元信息
 *
 * 示例：
 *   node runner/hengshu-run.mjs xhs-title-generator.yaml --endpoint http://localhost:11434/v1 --model qwen2.5
 *   node runner/hengshu-run.mjs xhs-title-generator --hub http://localhost:3000 --in topic=秋季护肤
 */
import fs from 'node:fs'
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

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

async function loadManifest(ref, hub) {
  if (fs.existsSync(ref)) {
    const text = fs.readFileSync(ref, 'utf8')
    if (ref.endsWith('.yaml') || ref.endsWith('.yml')) {
      const YAML = (await import('yaml')).default
      return YAML.parse(text)
    }
    return JSON.parse(text)
  }
  // 当作 slug 从 Hub 拉取
  const base = (hub || 'http://localhost:3000').replace(/\/$/, '')
  const url = `${base}/v1/skills/${ref}/manifest?format=json`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`无法从 Hub 拉取 Skill：${url}（${res.status}）`)
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

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const ref = args._[0]
  if (!ref) {
    console.error('用法：node runner/hengshu-run.mjs <manifest 文件 | skill-slug> [选项]')
    process.exit(1)
  }

  const manifest = await loadManifest(ref, args.hub)
  const endpoint = (args.endpoint || 'http://localhost:11434/v1').replace(/\/$/, '')
  // 兼容 Spec v1（models.local_recommended）与旧字段（recommended_models.local）
  const model =
    args.model ||
    manifest.models?.local_recommended?.[0] ||
    manifest.recommended_models?.local?.[0] ||
    manifest.recommended_models?.cloud?.[0]
  if (!model) {
    console.error('未指定模型，且 manifest 无推荐模型。请用 --model 指定。')
    process.exit(1)
  }

  if (!args.raw) {
    console.log(`\n▸ Skill：${manifest.name}  (v${manifest.version})`)
    console.log(`▸ 模型：${model}  @  ${endpoint}\n`)
  }

  const vars = await collectInputs(manifest.input_schema, args.in)
  // Spec v1：prompt.{system,user_template}；兼容旧 prompt_template
  const userTemplate = manifest.prompt?.user_template ?? manifest.prompt_template ?? ''
  const systemTemplate = manifest.prompt?.system ?? ''
  const userContent = render(userTemplate, vars)
  const systemContent = render(systemTemplate, vars)
  const messages = [
    ...(systemContent ? [{ role: 'system', content: systemContent }] : []),
    { role: 'user', content: userContent },
  ]

  const start = Date.now()
  const res = await fetch(`${endpoint}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(args.key ? { Authorization: `Bearer ${args.key}` } : {}),
    },
    body: JSON.stringify({ model, messages }),
  })
  const latency = Date.now() - start

  if (!res.ok) {
    console.error(`模型调用失败（${res.status}）：${(await res.text()).slice(0, 300)}`)
    process.exit(1)
  }
  const data = await res.json()
  const text = data?.choices?.[0]?.message?.content ?? ''

  if (args.raw) {
    console.log(text)
  } else {
    console.log('—'.repeat(48))
    console.log(text)
    console.log('—'.repeat(48))
    const u = data.usage || {}
    console.log(`⏱  ${latency}ms   tokens: ${u.total_tokens ?? '?'}   （本地/自有算力，未经中央服务器）`)
  }
}

main().catch((e) => {
  console.error('运行失败：', e.message)
  process.exit(1)
})
