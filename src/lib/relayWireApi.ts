import catalog from '../../detector/src/relay_detector/data/wire_apis.json'

export type RelayWireApi = keyof typeof catalog
export const relayWireApiOptions = Object.entries(catalog).map(([value, item]) => ({ value: value as RelayWireApi, label: item.label, protocols: item.protocols as string[] }))

/** Missing metadata means the interface used before explicit selection existed. */
export function resolveRelayWireApi(protocol: string, value?: unknown): RelayWireApi {
  const api = value == null || value === '' ? (protocol === 'anthropic' ? 'messages' : 'chat_completions') : String(value)
  const option = relayWireApiOptions.find((item) => item.value === api)
  if (!option?.protocols.includes(protocol)) throw new Error('检测协议与接口类型不匹配')
  return api as RelayWireApi
}

export function relayWireApiLabel(item: { protocol?: string; wireApi?: unknown }): string {
  try { return catalog[resolveRelayWireApi(String(item.protocol), item.wireApi)].label }
  catch { return '接口信息未知' }
}

export function sameRelayConfiguration(a: any, b: any): boolean {
  try {
    return a.protocol === b.protocol && a.model === b.model && (a.mode || 'standard') === (b.mode || 'standard') &&
      resolveRelayWireApi(a.protocol, a.wireApi) === resolveRelayWireApi(b.protocol, b.wireApi)
  } catch { return false }
}
