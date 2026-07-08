'use client'

import { useState } from 'react'

interface Category {
  slug: string
  name: string
}

type SubmitResult = {
  id?: string
  slug?: string
  status?: string
  contractUrl?: string
  passportUrl?: string
  certificateUrl?: string
  certificateVerifyPageUrl?: string
  autoPublished?: boolean
  requiresHumanReview?: boolean
  playbook?: {
    customerValue: string
    decision: 'maintain' | 'review' | 'revise'
    nextActions: Array<{ label: string; description: string; href?: string | null }>
  }
  review?: {
    decision?: string
    riskLevel?: string
    summary?: string
    findings?: string[]
    reviewedBy?: string
  }
}

const MAX_PACKAGE_MB = 15

// 创作者发布 Skill：前台只收市场展示信息 + 标准 Skill 包，包内 manifest 负责运行声明。
export function SkillForm({ categories }: { categories: Category[] }) {
  const [submissionKey, setSubmissionKey] = useState(() => newSubmissionKey())
  const [form, setForm] = useState({
    title: '',
    categorySlug: '',
    description: '',
    visibility: 'public',
  })
  const [skillPackage, setSkillPackage] = useState<File | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<SubmitResult | null>(null)
  const set = (k: string, v: string) => setForm((s) => ({ ...s, [k]: v }))

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.title.trim()) {
      setError('请填写 Skill 名称')
      return
    }
    if (!skillPackage) {
      setError('请上传 Skill 压缩包')
      return
    }
    if (!isSupportedPackage(skillPackage.name)) {
      setError('Skill 包仅支持 .zip、.tar.gz、.tgz')
      return
    }
    if (skillPackage.size > MAX_PACKAGE_MB * 1024 * 1024) {
      setError(`Skill 包不能超过 ${MAX_PACKAGE_MB}MB`)
      return
    }

    setLoading(true)
    setError(null)
    try {
      const body = new FormData()
      body.set('title', form.title)
      body.set('categorySlug', form.categorySlug)
      body.set('description', form.description)
      body.set('visibility', form.visibility)
      body.set('idempotencyKey', submissionKey)
      body.set('skillPackage', skillPackage)
      const res = await fetch('/v1/skills', {
        method: 'POST',
        credentials: 'include',
        body,
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(d?.error || '发布失败')
        return
      }
      setDone(d)
    } catch (e: any) {
      setError(e.message || '网络异常，发布失败')
    } finally {
      setLoading(false)
    }
  }

  if (done) {
    const published = done.status === 'published' || done.autoPublished
    const aiRejected = done.review?.decision === 'reject'
    return (
      <div className="max-w-2xl rounded-lg border border-[var(--border)] bg-[var(--panel)] p-6 text-sm">
        <p className="mb-2 text-base font-medium">
          {published
            ? '✓ AI 审核通过，已自动上架'
            : aiRejected
              ? 'AI 未通过，已转人工审核'
              : '✓ 已提交，等待人工审核'}
        </p>
        <p className="mb-3 text-[var(--muted)]">
          {done.review?.summary ||
            (published ? 'Skill 已进入市场。' : '审核员确认后再上架。')}
        </p>
        {!published ? (
          <p className="mb-3 text-xs text-[var(--muted)]">
            下面是作者预览证据；审核发布后，Passport 会刷新为当前状态，证书才可能从预备状态变成正式达标。
          </p>
        ) : null}
        {done.review?.findings?.length ? (
          <ul className="mb-4 list-disc space-y-1 pl-5 text-xs text-[var(--muted)]">
            {done.review.findings.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        ) : null}
        {done.playbook ? (
          <div className="mb-4 rounded-lg border border-[var(--border)] bg-[var(--panel-2)] p-3 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <b>发布后维护指引</b>
              <span className="rounded-full border border-[var(--border)] px-2 py-0.5 text-[var(--muted)]">
                {done.playbook.decision === 'maintain'
                  ? '持续维护'
                  : done.playbook.decision === 'revise'
                    ? '先修改再提交'
                    : '等待审核'}
              </span>
            </div>
            <p className="mt-2 text-[var(--muted)]">{done.playbook.customerValue}</p>
            <div className="mt-3 grid gap-2 md:grid-cols-2">
              {done.playbook.nextActions.map((action) => (
                <a
                  key={action.label}
                  href={action.href || '#'}
                  className="rounded border border-[var(--border)] p-2 text-[var(--muted)] hover:border-[var(--accent)]"
                >
                  <div className="font-medium text-[var(--text)]">{action.label}</div>
                  <div className="mt-1">{action.description}</div>
                </a>
              ))}
            </div>
          </div>
        ) : null}
        <div className="mb-4 grid gap-2 text-xs md:grid-cols-3">
          <a
            href={done.contractUrl || (done.slug ? `/v1/skills/${done.slug}/contract` : '#')}
            className="rounded-md border border-[var(--border)] px-3 py-2 text-[var(--accent)]"
          >
            查看 Contract
          </a>
          <a
            href={done.passportUrl || (done.slug ? `/v1/skills/${done.slug}/passport` : '#')}
            className="rounded-md border border-[var(--border)] px-3 py-2 text-[var(--accent)]"
          >
            查看 Passport
          </a>
          <a
            href={done.certificateVerifyPageUrl || (done.slug ? `/verify?certificateUrl=${encodeURIComponent(done.certificateUrl || `/v1/skills/${encodeURIComponent(done.slug)}/certificate`)}` : '#')}
            className="rounded-md border border-[var(--border)] px-3 py-2 text-[var(--accent)]"
          >
            查看证书{published ? '' : '预览'}
          </a>
        </div>
        <div className="flex flex-wrap gap-4">
          {done.slug ? (
            <a href={`/skills/${done.slug}`} className="text-[var(--accent)]">
              查看 Skill
            </a>
          ) : null}
          <a href="/console/skills" className="text-[var(--accent)]">
            我的作品
          </a>
          <a href="/console" className="text-[var(--accent)]">
            控制台
          </a>
          <button
            type="button"
            onClick={() => {
              setDone(null)
              setSubmissionKey(newSubmissionKey())
              setSkillPackage(null)
              setForm({
                title: '',
                categorySlug: '',
                description: '',
                visibility: 'public',
              })
            }}
            className="text-[var(--accent)]"
          >
            再发一个
          </button>
        </div>
      </div>
    )
  }

  const inputCls =
    'w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]'
  const labelCls = 'block text-sm font-medium mb-1'
  const hintCls = 'text-xs text-[var(--muted)] mb-1'

  return (
    <form onSubmit={submit} className="max-w-2xl space-y-4">
      {error && (
        <div className="rounded-md bg-[var(--panel-2)] px-3 py-2 text-sm text-[var(--danger)]">
          {error}
        </div>
      )}

      <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4 text-xs text-[var(--muted)]">
        <p className="mb-2 font-medium text-[var(--text)]">Skill 包要求</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            上传 .zip / .tar.gz / .tgz；建议包含 README，便于 AI 理解用途。
          </li>
          <li>
            <code>hengshu.skill.yaml</code> 是推荐标准
            manifest；提供后可生成更明确的 Skill
            Contract、在线运行表单和本地安装体验。
          </li>
          <li>
            请在包内写清输入 schema、输出
            schema、示例、权限和推荐模型；这些会进入 Passport /
            达标证书的证据链。
          </li>
          <li>
            低风险 Skill
            会自动上架；含网络、文件、Shell、脚本或不确定风险时转人工审核。
          </li>
        </ul>
      </div>

      <div className="grid gap-3 text-xs md:grid-cols-3">
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel-2)] p-3">
          <div className="font-medium text-[var(--text)]">1. Contract</div>
          <p className="mt-1 text-[var(--muted)]">
            先把能力、输入输出和权限边界写清楚。
          </p>
        </div>
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel-2)] p-3">
          <div className="font-medium text-[var(--text)]">2. Passport</div>
          <p className="mt-1 text-[var(--muted)]">
            发布后沉淀身份、签名、兼容、失败和治理证据。
          </p>
        </div>
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel-2)] p-3">
          <div className="font-medium text-[var(--text)]">3. 适配维护</div>
          <p className="mt-1 text-[var(--muted)]">
            后续用失败库和 Adapter 建议持续修复模型差异。
          </p>
        </div>
      </div>

      <div>
        <label className={labelCls}>Skill 名称 *</label>
        <input
          value={form.title}
          onChange={(e) => set('title', e.target.value)}
          className={inputCls}
          placeholder="如：小红书标题生成器"
          required
        />
      </div>

      <div>
        <label className={labelCls}>分类</label>
        <select
          value={form.categorySlug}
          onChange={(e) => set('categorySlug', e.target.value)}
          className={inputCls}
        >
          <option value="">（不选）</option>
          {categories.map((c) => (
            <option key={c.slug} value={c.slug}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className={labelCls}>可见性</label>
        <select
          value={form.visibility}
          onChange={(e) => set('visibility', e.target.value)}
          className={inputCls}
        >
          <option value="public">公开</option>
          <option value="unlisted">不公开列出</option>
          <option value="private">私有</option>
        </select>
      </div>

      <div>
        <label className={labelCls}>简介</label>
        <textarea
          value={form.description}
          onChange={(e) => set('description', e.target.value)}
          rows={3}
          className={inputCls}
          placeholder="一句话说明这个 Skill 做什么、适合谁使用"
        />
      </div>

      <div>
        <label className={labelCls}>Skill 压缩包 *</label>
        <p className={hintCls}>
          推荐提供 manifest；标准入口命名为 hengshu.skill.yaml /
          hengshu.skill.yml，可提升 Contract/Passport 质量。
        </p>
        <input
          type="file"
          accept=".zip,.tar.gz,.tgz,application/zip,application/gzip"
          onChange={(e) => setSkillPackage(e.target.files?.[0] || null)}
          className={inputCls}
          required
        />
        {skillPackage && (
          <p className="mt-1 text-xs text-[var(--muted)]">
            已选择：{skillPackage.name}（{(skillPackage.size / 1024).toFixed(1)}{' '}
            KB）
          </p>
        )}
      </div>

      <div className="flex items-center gap-3 pt-1">
        <button
          disabled={loading}
          className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {loading ? 'AI 审核中…' : '提交并自动审核'}
        </button>
        <span className="text-xs text-[var(--muted)]">
          AI 通过会自动上架；不确定风险转人工。
        </span>
      </div>
    </form>
  )
}

function isSupportedPackage(fileName: string): boolean {
  const lower = fileName.toLowerCase()
  return (
    lower.endsWith('.zip') ||
    lower.endsWith('.tar.gz') ||
    lower.endsWith('.tgz')
  )
}

function newSubmissionKey(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
      return `skill:${crypto.randomUUID()}`
  } catch {
    // ignore
  }
  return `skill:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`
}
