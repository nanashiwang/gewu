import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { bindReportCookie } from '@/lib/reportCookie'

const key = 'synthetic-session-bound-key'
const owner = 'b'.repeat(43)
const job = 'privatejob123'
const session = (expires: number) => 'fixture.' + Buffer.from(JSON.stringify({ exp: expires })).toString('base64url') + '.signature'
const request = (token: string) => new Request('https://gewu.example', { headers: { Cookie: `payload-token=${token}` } })
beforeEach(() => vi.stubEnv('GEWU_INTERNAL_API_TOKEN', key))
afterEach(() => vi.unstubAllEnvs())

it('caps report access at the earlier of one hour and login expiry', () => {
  const now = Math.floor(Date.now() / 1000)
  expect(bindReportCookie(request(session(now + 7200)), job, owner).maxAge).toBeLessThanOrEqual(3600)
  expect(bindReportCookie(request(session(now + 30)), job, owner).maxAge).toBeLessThanOrEqual(30)
  expect(() => bindReportCookie(request(session(now - 1)), job, owner)).toThrow('到期')
  expect(() => bindReportCookie(new Request('https://gewu.example'), job, owner)).toThrow('不可用')
})

it('uses the same signed format as the detector and rejects another login or report', () => {
  const token = session(Math.floor(Date.now() / 1000) + 7200)
  const bound = bindReportCookie(request(token), job, owner)
  // Exercise the actual independent Python verifier using only its stdlib
  // module. This also catches cross-language newline/encoding disagreements.
  const script = `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('report_access','detector/web/report_access.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
key,job,value,session=json.loads(sys.argv[1])
print(json.dumps([m.account_cookie_owner(key,job,value,session),m.account_cookie_owner(key,job,value,'another-session'),m.account_cookie_owner(key,'anotherjob123',value,session)]))`
  const output = execFileSync('python3', ['-c', script, JSON.stringify([key, job, bound.value, token])], { encoding: 'utf8', timeout: 5000 })
  expect(JSON.parse(output)).toEqual([owner, '', ''])
  expect(bound.value).not.toContain(token)
})
