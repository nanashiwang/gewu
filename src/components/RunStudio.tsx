'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'

interface FieldDef {
  type?: string
  label?: string
  required?: boolean
  options?: Array<string | { label?: string; value?: string }>
  placeholder?: string
}

const ROUTE_MODES = [
  { value: 'balanced', label: '均衡' },
  { value: 'cheap', label: '省钱' },
  { value: 'quality', label: '高质量' },
  { value: 'fast', label: '快速' },
]

const optionValue = (o: string | { label?: string; value?: string }) =>
  typeof o === 'string' ? o : (o.value ?? o.label ?? '')
const optionLabel = (o: string | { label?: string; value?: string }) =>
  typeof o === 'string' ? o : (o.label ?? o.value ?? '')

export function RunStudio({
  slug,
  inputSchema,
  loggedIn,
  models,
}: {
  slug: string
  inputSchema: Record<string, FieldDef>
  loggedIn: boolean
  models: string[]
}) {
  const router = useRouter()
  const fields = Object.entries(inputSchema || {})
  const [values, setValues] = useState<Record<string, string>>({})
  const [mode, setMode] = useState<'single' | 'compare'>('single')
  const [routeMode, setRouteMode] = useState('balanced')
  const [selected, setSelected] = useState<string[]>(models.slice(0, Math.min(2, models.length)))
  const [loading, setLoading] = useState(false)
  const [single, setSingle] = useState<any>(null)
  const [compare, setCompare] = useState<any[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const set = (k: string, v: string) => setValues((s) => ({ ...s, [k]: v }))
  const toggleModel = (m: string) =>
    setSelected((s) => (s.includes(m) ? s.filter((x) => x !== m) : [...s, m]))

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
          body: JSON.stringify({ input: values, routeMode }),
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
          body: JSON.stringify({ input: values, models: selected }),
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
                {models.map((m) => (
                  <label
                    key={m}
                    className="flex cursor-pointer items-center gap-2 rounded-md border border-[var(--border)] px-3 py-2 text-xs"
                  >
                    <input
                      type="checkbox"
                      checked={selected.includes(m)}
                      onChange={() => toggleModel(m)}
                      disabled={!selected.includes(m) && selected.length >= 4}
                    />
                    <span className="font-mono">{m}</span>
                  </label>
                ))}
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

        {single && <ResultCard r={single} />}

        {compare && compare.length > 0 && (
          <>
            <CompareTable results={compare} />
            <div className="grid gap-4 xl:grid-cols-2">
              {compare.map((r, i) => (
                <ResultCard key={i} r={r} title={r.model} />
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
          省¥{r.savedAmount}
        </span>
      )}
      {r.cheaperViaByok && (
        <span
          className="rounded border border-[var(--warn)] px-1.5 py-0.5 text-[var(--warn)]"
          title="本次走平台代付(含加价)；在设置里绑定自己的模型 Key(BYOK)直连供应商可更省"
        >
          BYOK更省
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

function ResultCard({ r, title }: { r: any; title?: string }) {
  return (
    <div className="card space-y-3 p-4">
      {title && <div className="font-mono text-xs text-[var(--accent)]">{title}</div>}
      <ResultBadges r={r} />
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-[var(--panel-2)] p-3 text-sm">
        {r.output || (r.errors && r.errors.join('；')) || '（无输出）'}
      </pre>
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
