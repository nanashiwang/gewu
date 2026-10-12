import catalog from '../../detector/src/relay_detector/data/model_catalog.json'

// Python, public picker and account form share this reviewed source.
export const relayModelCatalog = catalog
export function isRelayCatalogStale(now = new Date()): boolean {
  const reviewed = Date.parse(`${catalog.verified_on}T00:00:00Z`)
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  return !Number.isFinite(reviewed) || (today - reviewed) / 86_400_000 > catalog.review_interval_days
}
export const relayVendors = [...catalog.vendors, { id: 'other', label: '其他厂商 / 自定义模型', route: 'openai', source: '', models: [] }]
export function catalogProtocol(route: string): string {
  return route === 'claude' ? 'anthropic' : route
}
export function initialModelSelection(model?: string, protocol = 'openai') {
  const vendor = relayVendors.find((vendor) => vendor.models.includes(model || ''))
  if (model) return { vendor: vendor?.id || 'other', model, protocol }
  const fallback = relayVendors.find((vendor) => catalogProtocol(vendor.route) === protocol) || relayVendors[1]
  return { vendor: fallback.id, model: fallback.models[0] || '', protocol }
}
export function modelChoiceLabel(model: string) {
  const note = (catalog.model_notes as Record<string, string>)[model]
  return note ? `${model}（${note}）` : model
}
