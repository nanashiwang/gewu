import { RelaySiteForm } from '@/components/relay/RelaySiteForm'

export default function NewRelayPage() {
  return <div className="mx-auto max-w-4xl space-y-5"><div><h1 className="text-xl font-bold">添加中转站</h1><p className="mt-1 text-sm text-[var(--muted)]">API Key 只用于检测并加密保存；联系方式默认不公开。</p></div><RelaySiteForm /></div>
}
