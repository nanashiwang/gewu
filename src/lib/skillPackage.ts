import { createHash } from 'crypto'
import { mkdir, readdir, readFile, stat, writeFile } from 'fs/promises'
import path from 'path'
import { gunzipSync, inflateRawSync } from 'zlib'
import { parse as parseYaml } from 'yaml'
import {
  buildSkillComplianceReviewPrompt,
  normalizeSkillReviewDecision,
  packageStatusForReview,
  parseSkillReviewJson,
  SKILL_REVIEW_SYSTEM_PROMPT,
} from './skillComplianceReview'
import { chatCompletion } from './newapi'

export type PackageDecision = 'approve' | 'manual_review' | 'reject'
export type PackageType = 'zip' | 'tar.gz'

export interface SkillPackageEntry {
  name: string
  size: number
  compressedSize?: number
}

export interface SkillPackageIssue {
  level: 'blocker' | 'manual' | 'warning'
  code: string
  message: string
}

export interface SkillPackageAnalysis {
  fileName: string
  packageType: PackageType
  checksum: string
  fileSize: number
  sourceFormat?: 'gewu' | 'claude_skill' | 'gpts' | 'github_readme'
  entries: SkillPackageEntry[]
  manifestName?: string
  manifestText?: string
  manifest?: any
  readmeText?: string
  importedSourceName?: string
  importedSourceText?: string
  issues: SkillPackageIssue[]
  runtimeType?: string
  version: string
  systemPrompt?: string
  promptTemplate?: string
  inputSchema?: any
  outputSchema?: any
  recommendedModels?: any
  routePolicy?: any
  examples?: any
  license?: string
  minRunnerVersion?: string
  permissions?: {
    network?: boolean
    fileRead?: boolean
    fileWrite?: boolean
    shell?: boolean
  }
}

export interface SkillPackageReview {
  decision: PackageDecision
  riskLevel: 'low' | 'medium' | 'high'
  summary: string
  findings: string[]
  reviewedBy: 'ai' | 'rules'
  raw?: string
}

const MAX_PACKAGE_BYTES = 15 * 1024 * 1024
const MAX_ENTRY_COUNT = 300
const MAX_TOTAL_UNCOMPRESSED_BYTES = 25 * 1024 * 1024
const MAX_TEXT_BYTES = 96 * 1024
const MANIFEST_NAMES = new Set(['gewu.skill.yaml', 'gewu.skill.yml'])
const README_RE = /^readme\.(md|txt)$/i
const CLAUDE_SKILL_RE = /^skill\.md$/i
const GPTS_CONFIG_RE = /^(gpts?|gpt-config|actions)\.(json|yaml|yml)$/i
const SECRET_RE = /(^|\/)(\.env|id_rsa|id_dsa|id_ed25519|.*\.pem|.*\.p12|.*\.pfx|.*\.key)$/i
const RISKY_PATH_RE = /(^|\/)(node_modules|\.git|__pycache__|\.venv|venv|dist|build)(\/|$)/i
const EXECUTABLE_RE = /\.(sh|bash|zsh|ps1|bat|cmd|exe|dll|so|dylib|app|dmg|pkg)$/i

function sha256(buffer: Buffer) {
  return `sha256:${createHash('sha256').update(buffer).digest('hex')}`
}

function cleanEntryName(name: string): string | null {
  const clean = name.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!clean || clean.includes('\0')) return null
  if (clean.split('/').some((part) => part === '..')) return null
  return clean
}

function decodeText(buffer?: Buffer): string | undefined {
  if (!buffer) return undefined
  return buffer.slice(0, MAX_TEXT_BYTES).toString('utf8')
}

function inferPackageType(fileName: string): PackageType | null {
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.zip')) return 'zip'
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar.gz'
  return null
}

function findManifest(entries: Map<string, Buffer>) {
  const candidates = [...entries.keys()]
    .filter((name) => MANIFEST_NAMES.has(path.posix.basename(name).toLowerCase()))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length)
  return candidates[0]
}

function findReadme(entries: Map<string, Buffer>) {
  const candidates = [...entries.keys()]
    .filter((name) => README_RE.test(path.posix.basename(name)))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length)
  return candidates[0]
}

function findClaudeSkill(entries: Map<string, Buffer>) {
  const candidates = [...entries.keys()]
    .filter((name) => CLAUDE_SKILL_RE.test(path.posix.basename(name)))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length)
  return candidates[0]
}

function findGptsConfig(entries: Map<string, Buffer>) {
  const candidates = [...entries.keys()]
    .filter((name) => GPTS_CONFIG_RE.test(path.posix.basename(name)))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length)
  return candidates[0]
}

function safeParseStructured(text?: string, fileName?: string) {
  if (!text) return undefined
  try {
    return fileName?.toLowerCase().endsWith('.json') ? JSON.parse(text) : parseYaml(text)
  } catch {
    return undefined
  }
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function inferExternalImport(args: {
  manifest?: any
  readmeText?: string
  claudeSkillName?: string
  claudeSkillText?: string
  gptsConfigName?: string
  gptsConfigText?: string
}): {
  sourceFormat?: SkillPackageAnalysis['sourceFormat']
  importedSourceName?: string
  importedSourceText?: string
  systemPrompt?: string
  promptTemplate?: string
  inputSchema?: any
  outputSchema?: any
  examples?: any
  permissions?: SkillPackageAnalysis['permissions']
  description?: string
} {
  if (args.manifest) return { sourceFormat: 'gewu' }

  if (args.claudeSkillText) {
    const text = args.claudeSkillText.trim()
    return {
      sourceFormat: 'claude_skill',
      importedSourceName: args.claudeSkillName,
      importedSourceText: text,
      systemPrompt: '你正在运行从 Claude Skill 导入的 Skill。请遵循原始 SKILL.md 的说明，并在能力不足时明确说明。',
      promptTemplate: [
        '原始 Claude Skill 说明：',
        text,
        '',
        '用户本次任务：',
        '{{request}}',
      ].join('\n'),
      inputSchema: {
        request: { type: 'text', label: '本次任务', required: true },
      },
      permissions: { network: false, fileRead: false, fileWrite: false, shell: false },
    }
  }

  if (args.gptsConfigText) {
    const config = safeParseStructured(args.gptsConfigText, args.gptsConfigName) || {}
    const instructions = firstString(config.instructions, config.instruction, config.system_prompt, config.systemPrompt, config.prompt)
    const starters = Array.isArray(config.conversation_starters || config.conversationStarters)
      ? (config.conversation_starters || config.conversationStarters)
      : undefined
    return {
      sourceFormat: 'gpts',
      importedSourceName: args.gptsConfigName,
      importedSourceText: args.gptsConfigText.trim(),
      systemPrompt: instructions || '你正在运行从 GPTs 配置导入的 Skill。',
      promptTemplate: [
        instructions || '请按导入的 GPTs 配置完成任务。',
        '',
        '用户本次任务：',
        '{{request}}',
      ].join('\n'),
      inputSchema: {
        request: { type: 'text', label: '本次任务', required: true },
      },
      examples: starters?.slice(0, 8).map((s: unknown) => ({ input: { request: String(s) } })),
      permissions: {
        network: Boolean(config.actions || config.tools || config.capabilities?.web_browsing),
        fileRead: Boolean(config.capabilities?.code_interpreter),
        fileWrite: false,
        shell: false,
      },
      description: firstString(config.description),
    }
  }

  if (args.readmeText) {
    const text = args.readmeText.trim()
    return {
      sourceFormat: 'github_readme',
      importedSourceName: 'README',
      importedSourceText: text,
      systemPrompt: '你正在运行从 GitHub/README 导入的 Skill。请只根据 README 中可确认的能力执行。',
      promptTemplate: [
        '项目 README：',
        text,
        '',
        '用户本次任务：',
        '{{request}}',
      ].join('\n'),
      inputSchema: {
        request: { type: 'text', label: '本次任务', required: true },
      },
      permissions: { network: false, fileRead: false, fileWrite: false, shell: false },
    }
  }

  return {}
}

function readUInt16(buffer: Buffer, offset: number) {
  return offset + 2 <= buffer.length ? buffer.readUInt16LE(offset) : 0
}

function readUInt32(buffer: Buffer, offset: number) {
  return offset + 4 <= buffer.length ? buffer.readUInt32LE(offset) : 0
}

function parseZip(buffer: Buffer): { entries: SkillPackageEntry[]; texts: Map<string, Buffer>; issues: SkillPackageIssue[] } {
  const issues: SkillPackageIssue[] = []
  const entries: SkillPackageEntry[] = []
  const texts = new Map<string, Buffer>()
  let eocd = -1
  const min = Math.max(0, buffer.length - 0xffff - 22)
  for (let i = buffer.length - 22; i >= min; i--) {
    if (readUInt32(buffer, i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('ZIP 结构无效：找不到中央目录')
  const count = readUInt16(buffer, eocd + 10)
  let ptr = readUInt32(buffer, eocd + 16)
  if (count > MAX_ENTRY_COUNT) {
    issues.push({ level: 'blocker', code: 'TOO_MANY_FILES', message: `包内文件过多：${count} 个，最多 ${MAX_ENTRY_COUNT} 个` })
  }
  let total = 0
  for (let i = 0; i < count && ptr + 46 <= buffer.length; i++) {
    if (readUInt32(buffer, ptr) !== 0x02014b50) break
    const flag = readUInt16(buffer, ptr + 8)
    const method = readUInt16(buffer, ptr + 10)
    const compressedSize = readUInt32(buffer, ptr + 20)
    const size = readUInt32(buffer, ptr + 24)
    const nameLen = readUInt16(buffer, ptr + 28)
    const extraLen = readUInt16(buffer, ptr + 30)
    const commentLen = readUInt16(buffer, ptr + 32)
    const localOffset = readUInt32(buffer, ptr + 42)
    const rawName = buffer.slice(ptr + 46, ptr + 46 + nameLen).toString('utf8')
    ptr += 46 + nameLen + extraLen + commentLen
    const name = cleanEntryName(rawName)
    if (!name || name.endsWith('/')) continue
    total += size
    entries.push({ name, size, compressedSize })
    if ((flag & 1) === 1) {
      issues.push({ level: 'blocker', code: 'ENCRYPTED_ZIP_ENTRY', message: `不接受加密 ZIP 文件：${name}` })
      continue
    }
    if (size > MAX_TEXT_BYTES && !MANIFEST_NAMES.has(path.posix.basename(name).toLowerCase()) && !README_RE.test(path.posix.basename(name))) continue
    if (localOffset + 30 > buffer.length || readUInt32(buffer, localOffset) !== 0x04034b50) continue
    const localNameLen = readUInt16(buffer, localOffset + 26)
    const localExtraLen = readUInt16(buffer, localOffset + 28)
    const start = localOffset + 30 + localNameLen + localExtraLen
    const compressed = buffer.slice(start, start + compressedSize)
    try {
      if (method === 0) texts.set(name, compressed.slice(0, MAX_TEXT_BYTES))
      else if (method === 8) texts.set(name, inflateRawSync(compressed).slice(0, MAX_TEXT_BYTES))
    } catch {
      issues.push({ level: 'manual', code: 'ZIP_EXTRACT_FAILED', message: `文件无法解压，需要人工确认：${name}` })
    }
  }
  if (total > MAX_TOTAL_UNCOMPRESSED_BYTES) {
    issues.push({ level: 'blocker', code: 'PACKAGE_TOO_LARGE_UNCOMPRESSED', message: '包解压后体积过大，已拒绝自动审核' })
  }
  return { entries, texts, issues }
}

function parseTarGz(buffer: Buffer): { entries: SkillPackageEntry[]; texts: Map<string, Buffer>; issues: SkillPackageIssue[] } {
  const entries: SkillPackageEntry[] = []
  const texts = new Map<string, Buffer>()
  const issues: SkillPackageIssue[] = []
  const tar = gunzipSync(buffer)
  let offset = 0
  let total = 0
  while (offset + 512 <= tar.length) {
    const header = tar.slice(offset, offset + 512)
    if (header.every((b) => b === 0)) break
    const rawName = header.slice(0, 100).toString('utf8').replace(/\0.*$/, '')
    const prefix = header.slice(345, 500).toString('utf8').replace(/\0.*$/, '')
    const name = cleanEntryName(prefix ? `${prefix}/${rawName}` : rawName)
    const sizeRaw = header.slice(124, 136).toString('utf8').replace(/\0.*$/, '').trim()
    const size = Number.parseInt(sizeRaw || '0', 8) || 0
    const type = header.slice(156, 157).toString('utf8')
    offset += 512
    if (name && type !== '5') {
      entries.push({ name, size })
      total += size
      if (size <= MAX_TEXT_BYTES || MANIFEST_NAMES.has(path.posix.basename(name).toLowerCase()) || README_RE.test(path.posix.basename(name))) {
        texts.set(name, tar.slice(offset, offset + Math.min(size, MAX_TEXT_BYTES)))
      }
    }
    offset += Math.ceil(size / 512) * 512
    if (entries.length > MAX_ENTRY_COUNT) break
  }
  if (entries.length > MAX_ENTRY_COUNT) {
    issues.push({ level: 'blocker', code: 'TOO_MANY_FILES', message: `包内文件过多，最多 ${MAX_ENTRY_COUNT} 个` })
  }
  if (total > MAX_TOTAL_UNCOMPRESSED_BYTES) {
    issues.push({ level: 'blocker', code: 'PACKAGE_TOO_LARGE_UNCOMPRESSED', message: '包解压后体积过大，已拒绝自动审核' })
  }
  return { entries, texts, issues }
}

function normalizePermissions(raw: any): SkillPackageAnalysis['permissions'] {
  return {
    network: raw?.network === true,
    fileRead: raw?.file_read === true || raw?.fileRead === true,
    fileWrite: raw?.file_write === true || raw?.fileWrite === true,
    shell: raw?.shell === true,
  }
}

function collectStaticIssues(analysis: SkillPackageAnalysis) {
  const issues = analysis.issues
  if (!analysis.manifestName) {
    issues.push({ level: 'manual', code: 'MANIFEST_MISSING', message: '未提供 gewu.skill.yaml/yml，只能进入 Imported / 人工审核，不能自动 Verified 上架' })
  } else if (analysis.manifestName.split('/').length > 1) {
    issues.push({ level: 'warning', code: 'MANIFEST_NESTED', message: '建议把 gewu.skill.yaml 放在压缩包根目录' })
  }
  const schema = String(analysis.manifest?.schema_version || analysis.manifest?.schemaVersion || '')
  if (analysis.manifest && schema !== 'gewu.skill/v1') {
    issues.push({ level: 'blocker', code: 'SCHEMA_VERSION_INVALID', message: 'schema_version 必须是 gewu.skill/v1' })
  }
  if (analysis.manifest && !analysis.promptTemplate) {
    issues.push({ level: 'manual', code: 'PROMPT_ENTRY_MISSING', message: '当前平台自动上架仅支持包含 prompt.user_template 的 Skill 包' })
  }
  const runtime = String(analysis.runtimeType || '')
  const supportedRuntime = ['prompt', 'structured', 'structured_output', 'read_only_workflow', 'workflow'].includes(runtime)
  if (analysis.manifest && !supportedRuntime) {
    issues.push({ level: 'manual', code: 'RUNTIME_UNSUPPORTED', message: `runtime.type 暂不支持自动上架：${runtime || '未声明'}` })
  }
  const p = analysis.permissions || {}
  if (p.shell || p.fileWrite || p.fileRead || p.network) {
    issues.push({ level: 'manual', code: 'PERMISSIONS_REQUIRED', message: '声明了网络/文件/Shell 权限，需要人工审核后再上架' })
  }
  for (const e of analysis.entries) {
    if (SECRET_RE.test(e.name)) issues.push({ level: 'blocker', code: 'SECRET_FILE_INCLUDED', message: `包内疑似包含密钥/配置文件：${e.name}` })
    if (RISKY_PATH_RE.test(e.name)) issues.push({ level: 'manual', code: 'RISKY_PATH_INCLUDED', message: `包内包含不适合分发的目录：${e.name}` })
    if (EXECUTABLE_RE.test(e.name)) issues.push({ level: 'manual', code: 'EXECUTABLE_INCLUDED', message: `包内包含可执行/脚本文件，需要人工确认：${e.name}` })
  }
}

export function analyzeSkillPackage(fileName: string, input: Buffer): SkillPackageAnalysis {
  const packageType = inferPackageType(fileName)
  if (!packageType) throw new Error('仅支持 .zip、.tar.gz、.tgz 格式的 Skill 包')
  if (input.byteLength <= 0) throw new Error('Skill 包为空')
  if (input.byteLength > MAX_PACKAGE_BYTES) throw new Error(`Skill 包不能超过 ${Math.round(MAX_PACKAGE_BYTES / 1024 / 1024)}MB`)

  const parsed = packageType === 'zip' ? parseZip(input) : parseTarGz(input)
  const manifestName = findManifest(parsed.texts)
  const readmeName = findReadme(parsed.texts)
  const claudeSkillName = findClaudeSkill(parsed.texts)
  const gptsConfigName = findGptsConfig(parsed.texts)
  const manifestText = decodeText(manifestName ? parsed.texts.get(manifestName) : undefined)
  const readmeText = decodeText(readmeName ? parsed.texts.get(readmeName) : undefined)
  const claudeSkillText = decodeText(claudeSkillName ? parsed.texts.get(claudeSkillName) : undefined)
  const gptsConfigText = decodeText(gptsConfigName ? parsed.texts.get(gptsConfigName) : undefined)
  let manifest: any
  const issues = [...parsed.issues]
  if (manifestText) {
    try {
      manifest = parseYaml(manifestText)
    } catch {
      issues.push({ level: 'blocker', code: 'MANIFEST_INVALID_YAML', message: 'gewu.skill.yaml 不是合法 YAML' })
    }
  }
  const prompt = manifest?.prompt || {}
  const runtimeType = typeof manifest?.runtime === 'object' ? String(manifest.runtime?.type || '') : String(manifest?.runtime || '')
  const imported = inferExternalImport({ manifest, readmeText, claudeSkillName, claudeSkillText, gptsConfigName, gptsConfigText })
  const permissions = manifest ? normalizePermissions(manifest?.permissions || manifest?.runtime?.permissions) : imported.permissions
  const analysis: SkillPackageAnalysis = {
    fileName,
    packageType,
    checksum: sha256(input),
    fileSize: input.byteLength,
    sourceFormat: imported.sourceFormat || (manifest ? 'gewu' : undefined),
    entries: parsed.entries,
    manifestName,
    manifestText,
    manifest,
    readmeText,
    importedSourceName: imported.importedSourceName,
    importedSourceText: imported.importedSourceText,
    issues,
    runtimeType,
    version: String(manifest?.version || '1.0.0'),
    systemPrompt: typeof prompt.system === 'string' ? prompt.system : imported.systemPrompt,
    promptTemplate: typeof prompt.user_template === 'string' ? prompt.user_template : typeof prompt.userTemplate === 'string' ? prompt.userTemplate : imported.promptTemplate,
    inputSchema: manifest?.input_schema || manifest?.inputSchema || imported.inputSchema,
    outputSchema: manifest?.output_schema || manifest?.outputSchema || imported.outputSchema,
    recommendedModels: manifest?.models || manifest?.recommended_models || manifest?.recommendedModels,
    routePolicy: manifest?.route_policy || manifest?.routePolicy,
    examples: manifest?.examples || imported.examples,
    license: typeof manifest?.license === 'string' ? manifest.license : undefined,
    minRunnerVersion: typeof manifest?.runtime?.min_runner_version === 'string' ? manifest.runtime.min_runner_version : undefined,
    permissions,
  }
  collectStaticIssues(analysis)
  return analysis
}

export async function reviewSkillPackage(args: {
  title: string
  category?: string
  description?: string
  analysis: SkillPackageAnalysis
  env?: Record<string, string | undefined>
}): Promise<SkillPackageReview> {
  const { analysis } = args
  const blockers = analysis.issues.filter((i) => i.level === 'blocker')
  if (blockers.length > 0) {
    return {
      decision: 'reject',
      riskLevel: 'high',
      summary: blockers[0].message,
      findings: blockers.map((i) => i.message),
      reviewedBy: 'rules',
    }
  }

  const env = args.env || process.env
  const baseUrl = env.MODEL_GATEWAY_BASE_URL?.trim()
  const apiKey = env.MODEL_GATEWAY_KEY?.trim()
  if (!baseUrl || !apiKey) {
    return {
      decision: 'manual_review',
      riskLevel: 'medium',
      summary: '模型网关未配置，AI 审核未执行，需人工审核',
      findings: ['缺少 MODEL_GATEWAY_BASE_URL 或 MODEL_GATEWAY_KEY'],
      reviewedBy: 'rules',
    }
  }

  try {
    const result = await chatCompletion({
      model: env.SKILL_REVIEW_MODEL || env.MODEL_GATEWAY_DEFAULT_MODEL || 'deepseek-chat',
      gateway: { baseUrl, apiKey },
      temperature: 0,
      maxTokens: 700,
      messages: [
        { role: 'system', content: SKILL_REVIEW_SYSTEM_PROMPT },
        { role: 'user', content: buildSkillComplianceReviewPrompt(args) },
      ],
      metadata: { source: 'skill-package-review' },
    })
    const parsed = parseSkillReviewJson(result.text)
    const decision = normalizeSkillReviewDecision(parsed?.decision)
    const manualIssues = analysis.issues.filter((i) => i.level === 'manual')
    const finalDecision = decision === 'approve' && manualIssues.length === 0 ? 'approve' : decision === 'reject' ? 'reject' : 'manual_review'
    return {
      decision: finalDecision,
      riskLevel: parsed?.riskLevel === 'high' || parsed?.riskLevel === 'low' ? parsed.riskLevel : finalDecision === 'approve' ? 'low' : 'medium',
      summary: typeof parsed?.summary === 'string' ? parsed.summary.slice(0, 500) : 'AI 审核结果需要人工复核',
      findings: Array.isArray(parsed?.findings) ? parsed.findings.map((x: unknown) => String(x).slice(0, 300)).slice(0, 8) : [],
      reviewedBy: 'ai',
      raw: result.text.slice(0, 2000),
    }
  } catch (e) {
    return {
      decision: 'manual_review',
      riskLevel: 'medium',
      summary: `AI 审核调用失败，需人工审核：${(e as Error).message.slice(0, 160)}`,
      findings: ['AI 审核不可用时不自动上架'],
      reviewedBy: 'rules',
    }
  }
}

export { packageStatusForReview }

export function reviewToChangelog(review: SkillPackageReview, analysis: SkillPackageAnalysis) {
  const lines = [
    `自动审核：${review.decision}（${review.reviewedBy}，风险 ${review.riskLevel}）`,
    review.summary,
    ...review.findings.map((f) => `- ${f}`),
    '',
    `包：${analysis.fileName}`,
    `校验和：${analysis.checksum}`,
  ]
  return lines.filter(Boolean).join('\n').slice(0, 4000)
}

function mediaRoot() {
  return path.resolve(process.env.MEDIA_DIR || path.join(process.cwd(), 'media'))
}

function packageDir() {
  return path.join(mediaRoot(), 'skill-packages')
}

function packageExt(type: PackageType) {
  return type === 'zip' ? '.zip' : '.tar.gz'
}

export async function storeSkillPackage(args: {
  skillId: string
  versionId: string
  analysis: SkillPackageAnalysis
  buffer: Buffer
}) {
  const dir = packageDir()
  await mkdir(dir, { recursive: true })
  const digest = args.analysis.checksum.replace(/^sha256:/, '').slice(0, 16)
  const filename = `${args.skillId}-${args.versionId}-${digest}${packageExt(args.analysis.packageType)}`
  const dest = path.resolve(dir, filename)
  if (!dest.startsWith(path.resolve(dir) + path.sep)) throw new Error('Skill 包路径非法')
  await writeFile(dest, args.buffer)
  return { filename, path: dest, url: `/media/skill-packages/${filename}` }
}

export async function findStoredSkillPackage(skillId: string, versionId: string) {
  const dir = packageDir()
  let files: string[] = []
  try {
    files = await readdir(dir)
  } catch {
    return null
  }
  const prefix = `${skillId}-${versionId}-`
  const filename = files.find((f) => f.startsWith(prefix) && (f.endsWith('.zip') || f.endsWith('.tar.gz')))
  if (!filename) return null
  const fullPath = path.resolve(dir, filename)
  if (!fullPath.startsWith(path.resolve(dir) + path.sep)) return null
  const info = await stat(fullPath).catch(() => null)
  if (!info?.isFile()) return null
  const buffer = await readFile(fullPath)
  return {
    filename,
    path: fullPath,
    size: info.size,
    checksum: sha256(buffer),
    type: filename.endsWith('.zip') ? 'application/zip' : 'application/gzip',
    buffer,
  }
}
