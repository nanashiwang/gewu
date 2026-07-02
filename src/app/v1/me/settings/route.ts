import { getPayload } from 'payload'
import config from '@payload-config'
import { headers as nextHeaders } from 'next/headers'

// POST /v1/me/settings —— 用户自助设置。当前支持 BYOK 模型网关 Key。
// { newapiKey?: string }：非空则设置，空串清除。仅改本人。
export async function POST(request: Request) {
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await nextHeaders() })
  if (!user) return Response.json({ error: '请先登录' }, { status: 401 })
  if ((user as any).accountStatus === 'banned') return Response.json({ error: '账号已被封禁' }, { status: 403 })

  let body: any = {}
  try {
    body = await request.json()
  } catch {
    /* 容忍空 body */
  }

  const data: Record<string, unknown> = {}
  if (typeof body.newapiKey === 'string') {
    const k = body.newapiKey.trim()
    data.newapiKeyEncrypted = k || null // 空串清除
  }
  if (typeof body.bio === 'string') data.bio = body.bio.slice(0, 500)

  if (Object.keys(data).length === 0) {
    return Response.json({ error: '无可更新字段' }, { status: 400 })
  }

  try {
    await payload.update({ collection: 'users', id: user.id, data, overrideAccess: true })
    return Response.json({ ok: true })
  } catch (e) {
    payload.logger?.error(`更新用户设置失败: ${(e as Error).message}`)
    return Response.json({ error: '保存失败，请重试' }, { status: 500 })
  }
}
