import YAML from 'yaml'
import { createHash } from 'crypto'
import { canonicalString } from './canonical'
import { signCanonical, getSigningKeyId } from './signing'

function computeChecksum(core: any): string {
  return 'sha256:' + createHash('sha256').update(canonicalString(core), 'utf8').digest('hex')
}

// 构造 Hengshu Skill Spec v1 manifest（可移植、可校验、可验真）。
// 不含时间戳，保证同一版本每次导出字节一致、checksum/签名稳定。
export function buildManifest(skill: any, version: any, opts: { siteUrl?: string } = {}) {
  const author = typeof skill.author === 'object' ? skill.author?.username : undefined
  const category = typeof skill.category === 'object' ? skill.category?.slug : undefined
  const outputSchema = version?.outputSchema || {}
  const hasOutFields =
    outputSchema && typeof outputSchema === 'object' && Object.keys(outputSchema).length > 0

  const core: any = {
    schema_version: 'hengshu.skill/v1',
    id: skill.slug,
    name: skill.title,
    version: version?.version || '1.0.0',
    author: author || 'official',
    license: version?.license || 'CC-BY-NC-4.0',
    category: category || 'general',
    description: skill.description || '',
    runtime: {
      type: 'prompt',
      min_runner_version: version?.minRunnerVersion || '0.2.0',
      permissions: {
        network: !!version?.permissions?.network,
        file_read: !!version?.permissions?.fileRead,
        file_write: !!version?.permissions?.fileWrite,
        shell: !!version?.permissions?.shell,
      },
    },
    input_schema: version?.inputSchema || {},
    output_schema: hasOutFields ? { type: 'json', fields: outputSchema } : { type: 'text' },
    prompt: {
      system: version?.systemPrompt || '',
      user_template: version?.promptTemplate || '',
    },
    models: {
      local_recommended: version?.recommendedModels?.local || [],
      endpoint_type: ['ollama', 'lmstudio', 'openai_compatible'],
    },
    examples: Array.isArray(version?.examples) ? version.examples : [],
    source: 'hengshu',
  }
  if (opts.siteUrl) core.skill_url = `${opts.siteUrl}/skills/${skill.slug}`

  const integrity: any = { checksum: computeChecksum(core) }
  const signature = signCanonical(core)
  if (signature) {
    integrity.signature = signature
    integrity.keyId = getSigningKeyId()
    integrity.algorithm = 'ed25519'
  }
  return { ...core, integrity }
}

export function manifestToYaml(m: any): string {
  return YAML.stringify(m, { lineWidth: 0 })
}

export function manifestToJson(m: any): string {
  return JSON.stringify(m, null, 2)
}
