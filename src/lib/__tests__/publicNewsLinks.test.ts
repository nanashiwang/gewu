import { describe, expect, it } from 'vitest'
import { isPublicNewsPostMatch } from '../../../scripts/public-news-links'

const file = 'detector/web/data/updates.json'
const post = ['https://x.com', 'OpenAI', 'status', '2116186509384815084'].join('/')

function check(url: string, field = 'source_url', relative = file) {
  const source = JSON.stringify({ [field]: url })
  return isPublicNewsPostMatch(relative, source, source.indexOf(url), url.length)
}

describe('public news URLs in secret scanning', () => {
  it('recognizes only public numeric post URLs in the news source field', () => {
    expect(check(post)).toBe(true)
    expect(check(post.replace('x.com', 'twitter.com'))).toBe(true)
    expect(check(post, 'content')).toBe(false)
    expect(check(post, 'source_url', 'config.json')).toBe(false)
  })

  it('does not exempt credentials, query strings or arbitrary tokens', () => {
    for (const url of [post + '?key=secret', post + '#secret', post + '/extra',
      post.replace('x.com', 'x.com.evil.example'), post.replace('https://', 'https://secret@'),
      post.replace('/OpenAI/', '/account_name_far_too_long/'), post.replace(/\d+$/, 'secret-token')]) {
      expect(check(url)).toBe(false)
    }
  })

  it('keeps scanning values beside or overlapping a public URL', () => {
    const source = JSON.stringify({ source_url: post, key: 'another-value' })
    expect(isPublicNewsPostMatch(file, source, source.indexOf('another-value'), 13)).toBe(false)
    expect(isPublicNewsPostMatch(file, source, source.indexOf(post), post.length + 1)).toBe(false)
  })
})
