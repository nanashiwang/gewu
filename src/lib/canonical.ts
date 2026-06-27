// 规范化 JSON（递归排序 key）—— checksum 与签名共用，保证可复现
export function sortKeys(v: any): any {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object') {
    return Object.keys(v)
      .sort()
      .reduce((acc: any, k) => {
        acc[k] = sortKeys(v[k])
        return acc
      }, {})
  }
  return v
}

export function canonicalString(obj: any): string {
  return JSON.stringify(sortKeys(obj))
}
