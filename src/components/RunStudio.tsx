'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { modelPaymentMeta } from '@/lib/platformModelUi'
import { failureKnowledgeUrl, modelProfileUrl, runLedgerUrl } from '@/lib/runResultLinks'

interface FieldDef {
  type?: string
  label?: string
  required?: boolean
  options?: Array<string | { label?: string; value?: string }>
  placeholder?: string
}

const ROUTE_MODES = [
  { value: 'balanced', label: '均衡' },
  { value: 'cheap', label: '成本优先' },
  { value: 'quality', label: '高质量' },
  { value: 'fast', label: '快速' },
]

const optionValue = (o: string | { label?: string; value?: string }) =>
  typeof o === 'string' ? o : (o.value ?? o.label ?? '')
const optionLabel = (o: string | { label?: string; value?: string }) =>
  typeof o === 'string' ? o : (o.label ?? o.value ?? '')

const DEMO_INPUT_BY_KEY: Record<string, string> = {
  audience: '25-30 岁职场女性',
  draft: '王总，资料我晚点给你，你先看下之前那个版本。',
  error: '401 unauthorized',
  goal: '让用户收藏',
  notes: '小张说登录页要改；下周一上线；老王负责后端。',
  plan: '完善企业 Registry 审批；补充失败库 Adapter 复验。',
  product: '无线耳机',
  question: '普通人如何提高长期执行力？',
  request: '帮我把这段材料整理成结构化摘要。',
  review: '用了三天右耳就没声音了，客服还一直让我重启。',
  role: '产品经理 / 格物 控制台',
  stance: '反对只靠鸡血',
  style: '专业',
  topic: '秋季护肤',
}

function demoValueFor(key: string, def: FieldDef) {
  if (def.type === 'select' && def.options?.length) return optionValue(def.options[0])
  if (DEMO_INPUT_BY_KEY[key]) return DEMO_INPUT_BY_KEY[key]
  if (def.placeholder) return def.placeholder.replace(/^如[:：]\s*/, '')
  return def.type === 'text' ? '这里是一段用于试跑的示例文本。' : '示例内容'
}

export function RunStudio({
  slug,
  skillId,
  organizationId,
  inputSchema,
  loggedIn,
  models,
  platformModels,
  hasByok,
}: {
  slug: string
  skillId: string
  organizationId?: string
  inputSchema: Record<string, FieldDef>
  loggedIn: boolean
  models: string[]
  platformModels: string[]
  hasByok: boolean
}) {
  const router = useRouter()
  const fields = Object.entries(inputSchema || {})
  const selectableModels = models.filter((m) => !modelPaymentMeta(m, platformModels, hasByok).disabled)
  const [values, setValues] = useState<Record<string, string>>({})
  const [mode, setMode] = useState<'single' | 'compare'>('single')
  const [routeMode, setRouteMode] = useState('balanced')
  const [selected, setSelected] = useState<string[]>(
    selectableModels.slice(0, Math.min(2, selectableModels.length)),
  )
  const [loading, setLoading] = useState(false)
  const [single, setSingle] = useState<any>(null)
  const [compare, setCompare] = useState<any[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const set = (k: string, v: string) => setValues((s) => ({ ...s, [k]: v }))
  const fillDemoInput = () => {
    const demo = Object.fromEntries(fields.map(([key, def]) => [key, demoValueFor(key, def)]))
    setValues((current) => ({ ...demo, ...Object.fromEntries(Object.entries(current).filter(([, v]) => v)) }))
  }
  const toggleModel = (m: string) => {
    const meta = modelPaymentMeta(m, platformModels, hasByok)
    if (meta.disabled) return
    setSelected((s) => (s.includes(m) ? s.filter((x) => x !== m) : [...s, m]))
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!loggedIn) {
      router.push('/login')
      return
    }
    setLoading(true)
    setError(null)
    setSingle(null)
    setCompare(null)
    try {
      if (mode === 'single') {
        const res = await fetch(`/v1/skills/${slug}/run`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input: values, routeMode, organizationId }),
        })
        const data = await res.json().catch(() => ({}))
        if (res.status === 401) return setError('请先登录后再运行。')
        if (!res.ok || data.ok === false)
          return setError((data.errors && data.errors.join('；')) || data.error || '运行失败')
        setSingle(data)
      } else {
        if (selected.length === 0) return setError('请至少选择一个模型')
        const res = await fetch(`/v1/skills/${slug}/compare`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input: values, models: selected, organizationId }),
        })
        const data = await res.json().catch(() => ({}))
        if (res.status === 401) return setError('请先登录后再运行。')
        if (!res.ok) return setError(data.error || '对比失败')
        setCompare(data.results || [])
      }
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[360px_1fr]">
      {/* 控制面板 */}
      <form onSubmit={onSubmit} className="card h-fit space-y-4 p-5">
        {fields.length === 0 && (
          <p className="text-sm text-[var(--muted)]">该 Skill 无需输入，直接运行即可。</p>
        )}
        {fields.length > 0 && (
          <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-3 text-xs text-[var(--muted)]">
            <div className="flex items-center justify-between gap-3">
              <span>第一次试跑可以先用演示输入，快速看到输出、成本、延迟和台账记录。</span>
              <button
                type="button"
                onClick={fillDemoInput}
                className="shrink-0 rounded-full border border-emerald-500/40 px-3 py-1 text-emerald-200 hover:border-emerald-300"
              >
                填入演示输入
              </button>
            </div>
          </div>
        )}
        {fields.map(([key, def]) => (
          <div key={key}>
            <label className="mb-1 block text-sm">
              {def.label || key}
              {def.required && <span className="ml-1 text-[var(--danger)]">*</span>}
            </label>
            {def.type === 'select' && def.options ? (
              <select className="input" value={values[key] || ''} onChange={(e) => set(key, e.target.value)}>
                <option value="">请选择…</option>
                {def.options.map((o, i) => (
                  <option key={i} value={optionValue(o)}>
                    {optionLabel(o)}
                  </option>
                ))}
              </select>
            ) : def.type === 'text' ? (
              <textarea
                value={values[key] || ''}
                onChange={(e) => set(key, e.target.value)}
                placeholder={def.placeholder}
                rows={4}
                className="input"
              />
            ) : (
              <input
                value={values[key] || ''}
                onChange={(e) => set(key, e.target.value)}
                placeholder={def.placeholder}
                className="input"
              />
            )}
          </div>
        ))}

        {/* 模式切换 */}
        <div className="flex rounded-lg border border-[var(--border)] p-1 text-sm">
          {(['single', 'compare'] as const).map((m) => (
            <button
              type="button"
              key={m}
              onClick={() => setMode(m)}
              className={`flex-1 rounded-md py-1.5 transition-colors ${
                mode === m ? 'bg-[var(--accent)] text-white' : 'text-[var(--muted)]'
              }`}
            >
              {m === 'single' ? '单次运行' : '多模型对比'}
            </button>
          ))}
        </div>

        {mode === 'single' ? (
          <div>
            <label className="mb-1 block text-sm">路由模式</label>
            <p className="mb-2 text-xs text-[var(--muted)]">
              未绑定 BYOK 时仅使用「平台代付」模型；境外/非白名单模型需在设置中绑定自带 Key。
            </p>
            <div className="flex flex-wrap gap-2">
              {ROUTE_MODES.map((m) => (
                <button
                  type="button"
                  key={m.value}
                  onClick={() => setRouteMode(m.value)}
                  className={`chip ${routeMode === m.value ? 'chip-active' : ''}`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div>
            <label className="mb-1 block text-sm">
              选择模型对比 <span className="text-[var(--faint)]">（最多 4 个）</span>
            </label>
            {models.length === 0 ? (
              <p className="text-xs text-[var(--muted)]">该 Skill 未配置推荐模型。</p>
            ) : (
              <div className="space-y-1.5">
                {models.map((m) => {
                  const meta = modelPaymentMeta(m, platformModels, hasByok)
                  const disabled = meta.disabled || (!selected.includes(m) && selected.length >= 4)
                  return (
                    <label
                      key={m}
                      title={meta.help}
                      className={`flex items-center gap-2 rounded-md border border-[var(--border)] px-3 py-2 text-xs ${
                        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={selected.includes(m)}
                        onChange={() => toggleModel(m)}
                        disabled={disabled}
                      />
                      <span className="min-w-0 flex-1 truncate font-mono">{m}</span>
                      <span
                        className={`shrink-0 rounded border px-1.5 py-0.5 ${
                          meta.kind === 'platform'
                            ? 'border-[var(--accent-2)] text-[var(--accent-2)]'
                            : meta.kind === 'byok'
                              ? 'border-[var(--accent)] text-[var(--accent)]'
                              : 'border-[var(--warn)] text-[var(--warn)]'
                        }`}
                      >
                        {meta.label}
                      </span>
                    </label>
                  )
                })}
              </div>
            )}
          </div>
        )}

        <button disabled={loading} className="btn btn-primary w-full">
          {loading
            ? mode === 'compare'
              ? '对比运行中…'
              : '运行中…'
            : !loggedIn
              ? '登录后运行'
              : mode === 'compare'
                ? `▶ 对比运行（${selected.length}）`
                : '▶ 运行 Skill'}
        </button>
        {!loggedIn && (
          <p className="text-center text-xs text-[var(--muted)]">
            点击将前往{' '}
            <Link href="/login" className="link-accent">
              登录
            </Link>
          </p>
        )}
      </form>

      {/* 结果 */}
      <div className="space-y-4">
        {error && (
          <div className="card border-[var(--danger)] p-4 text-sm text-[var(--danger)]">{error}</div>
        )}

        {!error && !single && !compare && (
          <div className="card p-8 text-center text-sm text-[var(--muted)]">
            填写左侧表单 → 选择「单次运行」或「多模型对比」→ 点击运行
          </div>
        )}

        {single && <ResultCard r={single} skillId={skillId} />}

        {compare && compare.length > 0 && (
          <>
            <CompareTable results={compare} />
            <div className="grid gap-4 xl:grid-cols-2">
              {compare.map((r, i) => (
                <ResultCard key={i} r={r} skillId={skillId} title={r.model} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function ResultBadges({ r }: { r: any }) {
  return (
    <div className="flex flex-wrap gap-1.5 text-[11px]">
      {r.mocked && (
        <span className="rounded border border-[var(--warn)] px-1.5 py-0.5 text-[var(--warn)]">MOCK</span>
      )}
      <Badge>{r.ok ? '成功' : '失败'}</Badge>
      <Badge>¥{r.cost ?? 0}</Badge>
      <Badge>{r.latencyMs ?? 0}ms</Badge>
      {r.tokens && <Badge>{r.tokens.total} tok</Badge>}
      <span
        className={`rounded border px-1.5 py-0.5 ${
          r.formatValid
            ? 'border-[var(--accent-2)] text-[var(--accent-2)]'
            : 'border-[var(--border)] text-[var(--faint)]'
        }`}
      >
        格式{r.formatValid ? '✓' : '✗'}
      </span>
      {r.savedAmount > 0 && (
        <span className="rounded border border-[var(--accent-2)] px-1.5 py-0.5 text-[var(--accent-2)]">
          降本¥{r.savedAmount}
        </span>
      )}
      {r.cheaperViaByok && (
        <span
          className="rounded border border-[var(--warn)] px-1.5 py-0.5 text-[var(--warn)]"
          title="本次走平台代付(含加价)；在设置里绑定自己的模型 Key(BYOK)可直连供应商"
        >
          BYOK 成本更低
        </span>
      )}
    </div>
  )
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[var(--muted)]">
      {children}
    </span>
  )
}

function ResultCard({ r, skillId, title }: { r: any; skillId: string; title?: string }) {
  const model = r.model ? String(r.model) : ''
  const modelVersion = r.modelVersion ? String(r.modelVersion) : undefined
  const ledgerHref = r.runLedgerUrl || runLedgerUrl(skillId, model, r.ok, modelVersion)
  const modelHref = r.modelProfileUrl || modelProfileUrl(model, modelVersion) || '/models'
  const failureHref =
    r.failureKnowledgeUrl ||
    failureKnowledgeUrl({ skillId, model, modelVersion, errorCode: r.errorCode, success: r.ok })
  return (
    <div className="card space-y-3 p-4">
      {title && <div className="font-mono text-xs text-[var(--accent)]">{title}</div>}
      <ResultBadges r={r} />
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-[var(--panel-2)] p-3 text-sm">
        {r.output || (r.errors && r.errors.join('；')) || '（无输出）'}
      </pre>
      <div className="rounded-lg border border-[var(--border)] bg-[var(--panel-2)] p-3 text-xs">
        <div className="font-medium text-[var(--text)]">下一步：把这次运行变成你的私人资产</div>
        <p className="mt-1 text-[var(--muted)]">
          这次结果已进入私人台账；你可以回台账换模型重跑、看该模型画像，失败时直接查失败库。
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Link
            href={ledgerHref}
            className="rounded border border-[var(--border)] px-2 py-1 text-[var(--accent)] hover:border-[var(--accent)]"
          >
            去私人台账 / 重跑
          </Link>
          <Link
            href={modelHref}
            className="rounded border border-[var(--border)] px-2 py-1 text-[var(--accent)] hover:border-[var(--accent)]"
          >
            看模型画像
          </Link>
          {!r.ok && (
            <Link
              href={failureHref}
              className="rounded border border-[var(--border)] px-2 py-1 text-[var(--accent)] hover:border-[var(--accent)]"
            >
              查失败库
            </Link>
          )}
        </div>
      </div>
    </div>
  )
}

function CompareTable({ results }: { results: any[] }) {
  const best = (key: 'cost' | 'latencyMs', dir: 'min') => {
    const vals = results.filter((r) => r.ok).map((r) => r[key] ?? Infinity)
    return vals.length ? Math.min(...vals) : null
  }
  const minCost = best('cost', 'min')
  const minLat = best('latencyMs', 'min')
  return (
    <div className="card overflow-x-auto p-0">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--border)] text-left text-xs text-[var(--muted)]">
            <th className="px-3 py-2 font-medium">模型</th>
            <th className="px-3 py-2 text-center font-medium">状态</th>
            <th className="px-3 py-2 text-right font-medium">成本</th>
            <th className="px-3 py-2 text-right font-medium">耗时</th>
            <th className="px-3 py-2 text-right font-medium">tokens</th>
            <th className="px-3 py-2 text-center font-medium">格式</th>
          </tr>
        </thead>
        <tbody>
          {results.map((r, i) => (
            <tr key={i} className="border-b border-[var(--border)] last:border-0">
              <td className="px-3 py-2 font-mono text-xs">{r.model}</td>
              <td className="px-3 py-2 text-center">{r.ok ? '✓' : '✗'}</td>
              <td
                className={`px-3 py-2 text-right ${r.ok && r.cost === minCost ? 'font-semibold text-[var(--accent-2)]' : ''}`}
              >
                ¥{r.cost ?? '—'}
              </td>
              <td
                className={`px-3 py-2 text-right ${r.ok && r.latencyMs === minLat ? 'font-semibold text-[var(--accent-2)]' : ''}`}
              >
                {r.latencyMs ?? '—'}ms
              </td>
              <td className="px-3 py-2 text-right text-[var(--muted)]">{r.tokens?.total ?? '—'}</td>
              <td className="px-3 py-2 text-center">{r.formatValid ? '✓' : '✗'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
