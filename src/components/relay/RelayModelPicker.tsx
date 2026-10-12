'use client'

import { useEffect, useState } from 'react'
import { catalogProtocol, initialModelSelection, isRelayCatalogStale, modelChoiceLabel, relayModelCatalog, relayVendors } from '@/lib/relayModelCatalog'
import { relayWireApiOptions, resolveRelayWireApi } from '@/lib/relayWireApi'

export function RelayModelPicker({ model, protocol = 'openai', wireApi }: { model?: string; protocol?: string; wireApi?: string | null }) {
  const [selection, setSelection] = useState(() => initialModelSelection(model, protocol))
  const [api, setApi] = useState(() => resolveRelayWireApi(protocol, wireApi))
  const vendor = relayVendors.find((item) => item.id === selection.vendor)!
  const [custom, setCustom] = useState(Boolean(model && !vendor.models.includes(model)))
  const [stale, setStale] = useState(false)
  useEffect(() => { setStale(isRelayCatalogStale()) }, [])
  return <fieldset className="relay-model-picker md:col-span-2">
    <legend className="text-sm font-medium">选择检测模型</legend>
    <div className="mt-3 grid gap-4 md:grid-cols-2">
      <label className="space-y-1 text-sm"><span>模型厂商</span>
        <select className="input" value={selection.vendor} onChange={(event) => {
          const next = relayVendors.find((item) => item.id === event.target.value)!
          setSelection({ vendor: next.id, model: next.models[0] || '', protocol: catalogProtocol(next.route) })
          setApi(resolveRelayWireApi(catalogProtocol(next.route)))
          setCustom(next.models.length === 0)
        }}>{relayVendors.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
      </label>
      <label className="space-y-1 text-sm"><span>目标模型</span>
        <select className="input" value={custom ? '__custom__' : selection.model} onChange={(event) => {
          setCustom(event.target.value === '__custom__')
          setSelection({ ...selection, model: event.target.value === '__custom__' ? '' : event.target.value })
        }}>{vendor.models.map((item) => <option key={item} value={item}>{modelChoiceLabel(item)}</option>)}<option value="__custom__">使用本站的其他模型 ID</option></select>
      </label>
      {custom ? <label className="space-y-1 text-sm md:col-span-2"><span>本站模型 ID</span><input className="input" name="model" required maxLength={160} value={selection.model} onChange={(event) => setSelection({ ...selection, model: event.target.value })} placeholder="与中转站提供的模型 ID 完全一致" /></label> : <input type="hidden" name="model" value={selection.model} />}
      <label className="space-y-1 text-sm"><span>检测协议</span><select className="input" name="protocol" value={selection.protocol} onChange={(event) => { setSelection({ ...selection, protocol: event.target.value }); setApi(resolveRelayWireApi(event.target.value)) }}><option value="openai">OpenAI</option><option value="anthropic">Claude / Anthropic</option><option value="gemini">Gemini</option></select></label>
      <label className="space-y-1 text-sm"><span>请求接口</span><select className="input" name="wireApi" value={api} onChange={(event) => setApi(resolveRelayWireApi(selection.protocol, event.target.value))}>{relayWireApiOptions.filter((item) => item.protocols.includes(selection.protocol)).map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
      <div className="self-end text-xs text-[var(--muted)]">目录核对：{relayModelCatalog.verified_on}{vendor.source && <> · <a href={vendor.source} target="_blank" rel="noreferrer" className="text-[var(--accent)]">官方来源 ↗</a></>}</div>
    </div>
    {['responses', 'interactions', 'generate_content'].includes(api) && <p className="mt-3 text-xs text-[var(--muted)]">快速 / 标准 / 完整最多发送 2 / 3 / 5 次请求，每次输出上限 4096 tokens。用量由你的 Key 承担；无自动重试、付费预检或接口切换。仅检测本次接口能力，不证明模型身份，不与其他接口混合比较。Gemini 原生地址填到 /v1beta 或服务商指定的版本前缀。</p>}
    {stale && <p role="status" className="mt-3 text-xs text-[var(--muted)]">模型目录已超过复核期限，请先查看官方来源，并确认本站实际可用的模型 ID。</p>}
    <p className="mt-3 text-xs text-[var(--muted)]">选择厂商会推荐对应协议；代理站采用其他协议时可手动调整。目录只提供候选名称，不代表此站已开通模型，也不证明实际模型身份。</p>
  </fieldset>
}
