import { describe, expect, it } from 'vitest'
import { downloadChecksumHeaders } from '@/lib/downloadChecksumHeaders'

describe('downloadChecksumHeaders', () => {
  it('returns the gewu checksum evidence header', () => {
    expect(downloadChecksumHeaders('sha256:abc')).toEqual({
      'X-Gewu-Checksum': 'sha256:abc',
    })
  })

  it('does not serialize missing checksums as undefined', () => {
    expect(downloadChecksumHeaders(undefined)['X-Gewu-Checksum']).toBe('')
  })
})
