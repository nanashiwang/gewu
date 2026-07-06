import { getPayloadClient } from '@/lib/payload'
import { getPublicKeyInfo } from '@/lib/signing'
import { verifyScoreSnapshot } from '@/lib/scoreSnapshotVerify'
import { resolveRuntimeEnv } from '@/lib/deploymentSettings'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: '公开验签 · 衡术 Hengshu',
  description: '公开验证衡术 LocalScore 快照的 payloadHash 与 ed25519 签名。',
}

const STATUS: Record<string, { label: string; className: string }> = {
  valid: { label: '签名有效', className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' },
  unsigned: { label: '仅哈希', className: 'border-amber-500/30 bg-amber-500/10 text-amber-200' },
  key_unavailable: { label: '缺公钥', className: 'border-sky-500/30 bg-sky-500/10 text-sky-200' },
  tampered: { label: '异常', className: 'border-red-500/30 bg-red-500/10 text-red-200' },
}

function skillLabel(skill: any): string {
  if (!skill) return '—'
  if (typeof skill === 'object') return skill.title || skill.slug || skill.id || '—'
  return String(skill)
}

export default async function VerifyPage() {
  const payload = await getPayloadClient()
  const [snapshots, runtimeEnv] = await Promise.all([
    payload.find({
      collection: 'score-snapshots',
      depth: 1,
      limit: 100,
      overrideAccess: true,
      sort: '-createdAt',
    }),
    resolveRuntimeEnv(payload),
  ])
  const publicKey = getPublicKeyInfo(runtimeEnv)

  const rows = (snapshots.docs as any[]).map((s) => ({ snapshot: s, verify: verifyScoreSnapshot(s, publicKey) }))
  const okCount = rows.filter((r) => r.verify.status === 'valid').length
  const warnCount = rows.filter((r) => r.verify.status !== 'valid').length

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.2em] text-[var(--accent-2)]">Trust Ledger</p>
            <h1 className="mt-1 text-2xl font-semibold">公开验签</h1>
            <p className="mt-2 max-w-3xl text-sm text-[var(--muted)]">
              每次 LocalScore 变化都会写入 append-only 快照。这里用公开公钥复算规范化载荷哈希并校验
              ed25519 签名，证明历史分数不能无痕改写。
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center text-xs">
            <div className="rounded-xl border border-[var(--border)] px-3 py-2">
              <div className="text-lg font-semibold text-[var(--text)]">{snapshots.totalDocs}</div>
              <div className="text-[var(--faint)]">快照总数</div>
            </div>
            <div className="rounded-xl border border-[var(--border)] px-3 py-2">
              <div className="text-lg font-semibold text-emerald-300">{okCount}</div>
              <div className="text-[var(--faint)]">有效</div>
            </div>
            <div className="rounded-xl border border-[var(--border)] px-3 py-2">
              <div className="text-lg font-semibold text-amber-200">{warnCount}</div>
              <div className="text-[var(--faint)]">待处理</div>
            </div>
          </div>
        </div>

        <div className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3 text-xs text-[var(--muted)]">
          当前公钥：
          {publicKey ? (
            <span className="ml-1 font-mono text-[var(--text)]">
              {publicKey.keyId} · {publicKey.algorithm}
            </span>
          ) : (
            <span className="ml-1 text-amber-200">未配置 HENGSHU_SIGNING_KEY，新快照只能做哈希校验</span>
          )}
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--border)] p-10 text-center text-[var(--muted)]">
          还没有分数快照。产生兼容报告并重算 LocalScore 后会自动出现。
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
          <table className="w-full min-w-[920px] text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] bg-[var(--panel)] text-left text-xs text-[var(--muted)]">
                <th className="px-3 py-2 font-medium">状态</th>
                <th className="px-3 py-2 font-medium">Skill</th>
                <th className="px-3 py-2 text-right font-medium">分数</th>
                <th className="px-3 py-2 text-right font-medium">报告数</th>
                <th className="px-3 py-2 font-medium">payloadHash</th>
                <th className="px-3 py-2 font-medium">keyId</th>
                <th className="px-3 py-2 font-medium">签名时间</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ snapshot, verify }) => {
                const style = STATUS[verify.status] || STATUS.tampered
                return (
                  <tr key={snapshot.id} className="border-b border-[var(--border)] last:border-0">
                    <td className="px-3 py-2.5">
                      <span className={`rounded-full border px-2 py-0.5 text-xs ${style.className}`}>
                        {style.label}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">{skillLabel(snapshot.skill)}</td>
                    <td className="px-3 py-2.5 text-right font-semibold text-[var(--accent)]">
                      {snapshot.localScore}
                    </td>
                    <td className="px-3 py-2.5 text-right">{snapshot.reportCount || 0}</td>
                    <td className="px-3 py-2.5 font-mono text-[11px] text-[var(--muted)]">
                      {(verify.computedHash || snapshot.payloadHash || '').slice(0, 18)}…
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs">{snapshot.keyId || '—'}</td>
                    <td className="px-3 py-2.5 text-xs text-[var(--muted)]">
                      {snapshot.signedAt ? new Date(snapshot.signedAt).toLocaleString('zh-CN') : '—'}
                      <div className="mt-1 text-[11px] text-[var(--faint)]">{verify.reason}</div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 text-xs text-[var(--muted)]">
        外锚脚本：
        <code className="mx-1 rounded bg-[var(--panel-2)] px-1.5 py-0.5">npm run worker:export-score-anchors</code>
        会把快照哈希导出到
        <code className="mx-1 rounded bg-[var(--panel-2)] px-1.5 py-0.5">docs/anchors/score-snapshots.jsonl</code>
        ；将该文件提交到公开 Git 后，即形成第三方可复核的时间锚点。
      </div>
    </div>
  )
}
