/** Only quoted, credential-free public post URLs in the reviewed news snapshot. */
export function isPublicNewsPostMatch(relative: string, source: string, start: number, length: number): boolean {
  if (relative !== 'detector/web/data/updates.json') return false
  const pattern = /"source_url"\s*:\s*"(https:\/\/(?:x\.com|twitter\.com)\/[A-Za-z0-9_]{1,15}\/status\/[0-9]{1,20})"/g
  for (const match of source.matchAll(pattern)) {
    const urlStart = match.index! + match[0].indexOf(match[1])
    if (start >= urlStart && start + length <= urlStart + match[1].length) return true
  }
  return false
}
