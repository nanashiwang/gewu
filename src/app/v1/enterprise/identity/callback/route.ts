import { getPayload } from 'payload'
import config from '@payload-config'
import { readEnterpriseOptionalQuery } from '@/lib/enterpriseRequest'
import { buildEnterpriseOidcTokenRequest, resolveEnterpriseSsoMemberBinding, verifyEnterpriseOidcIdTokenClaims, verifyEnterpriseSsoState } from '@/lib/enterprise'

// GET /v1/enterprise/identity/callback —— OIDC 回调：校验 state，可选校验 id_token claims 并绑定组织成员。
export async function GET(request: Request) {
  const url = new URL(request.url)
  const codeParam = readEnterpriseOptionalQuery(url.searchParams, 'code', 4000)
  if (typeof codeParam !== 'string') return Response.json({ ok: false, error: codeParam.error }, { status: codeParam.status })
  const stateParam = readEnterpriseOptionalQuery(url.searchParams, 'state', 500)
  if (typeof stateParam !== 'string') return Response.json({ ok: false, error: stateParam.error }, { status: stateParam.status })
  const errorParam = readEnterpriseOptionalQuery(url.searchParams, 'error', 200)
  if (typeof errorParam !== 'string') return Response.json({ ok: false, error: errorParam.error }, { status: errorParam.status })
  const errorDescriptionParam = readEnterpriseOptionalQuery(url.searchParams, 'error_description', 1000)
  if (typeof errorDescriptionParam !== 'string') return Response.json({ ok: false, error: errorDescriptionParam.error }, { status: errorDescriptionParam.status })
  const idTokenParam = readEnterpriseOptionalQuery(url.searchParams, 'id_token', 8000)
  if (typeof idTokenParam !== 'string') return Response.json({ ok: false, error: idTokenParam.error }, { status: idTokenParam.status })
  const code = codeParam
  const state = stateParam
  const error = errorParam
  if (error) return Response.json({ ok: false, error, errorDescription: errorDescriptionParam || null }, { status: 400 })
  if (!code || !state) return Response.json({ ok: false, error: '缺少 OIDC code 或 state' }, { status: 400 })
  const stateCheck = verifyEnterpriseSsoState(state)
  if (!stateCheck.ok) return Response.json({ ok: false, error: stateCheck.reason }, { status: 400 })
  const payload = await getPayload({ config })
  const org = await payload.findByID({
    collection: 'organizations' as any,
    id: stateCheck.payload.organizationId,
    depth: 0,
    overrideAccess: true,
  }).catch(() => null) as any
  if (!org || org.status === 'suspended') return Response.json({ ok: false, error: '组织不存在或已暂停' }, { status: 404 })
  const callbackUrl = `${url.origin}/v1/enterprise/identity/callback`
  const tokenExchange = buildEnterpriseOidcTokenRequest(org.identityPolicy, { code, callbackUrl })
  const idTokenCheck = idTokenParam
    ? verifyEnterpriseOidcIdTokenClaims(org.identityPolicy, {
        idToken: idTokenParam,
        nonce: stateCheck.payload.nonce,
      })
    : null
  const memberBinding = idTokenCheck?.ok
    ? await resolveEnterpriseSsoMemberBinding(payload, {
        organizationId: stateCheck.payload.organizationId,
        email: idTokenCheck.email,
      })
    : null
  const ready = idTokenCheck?.ok && memberBinding?.ok
  return Response.json({
    ok: Boolean(ready),
    status: ready ? 'sso_verified_member_bound' : 'callback_received',
    codeReceived: true,
    stateReceived: true,
    organizationId: stateCheck.payload.organizationId,
    redirectPath: stateCheck.payload.redirectPath,
    nonceReceived: Boolean(stateCheck.payload.nonce),
    tokenExchange: tokenExchange.ok ? tokenExchange.tokenRequest : { error: tokenExchange.reason, issues: tokenExchange.issues || [] },
    idTokenCheck: idTokenCheck
      ? idTokenCheck.ok
        ? { ok: true, email: idTokenCheck.email, warnings: idTokenCheck.warnings }
        : { ok: false, code: idTokenCheck.code, reason: idTokenCheck.reason, warnings: idTokenCheck.warnings || [] }
      : null,
    memberBinding: memberBinding
      ? memberBinding.ok
        ? memberBinding.binding
        : { ok: false, code: memberBinding.code, reason: memberBinding.reason, binding: memberBinding.binding || null }
      : null,
    next: ready
      ? '已完成 state、ID Token claims/JWKS、邮箱域和组织 active 成员绑定校验；真实登录会话签发仍应在服务端完成。'
      : '已完成 state 签名校验并还原组织上下文；下一步按 tokenExchange 在服务端换 token，再提交 ID Token 做 claims、邮箱域和组织成员绑定校验。',
  }, { status: ready ? 200 : 501 })
}
