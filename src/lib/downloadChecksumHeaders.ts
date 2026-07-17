export function downloadChecksumHeaders(checksum: string | null | undefined): Record<string, string> {
  const value = String(checksum || '')
  return {
    'X-Gewu-Checksum': value,
  }
}
