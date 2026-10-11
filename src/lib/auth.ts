import { headers as nextHeaders } from 'next/headers'
import { getPayloadClient } from './payload'
import { cache } from 'react'

// 在 RSC / 服务端读取当前登录用户（无则 null）
export const getCurrentUser = cache(async function getCurrentUser() {
  try {
    const payload = await getPayloadClient()
    const { user } = await payload.auth({ headers: await nextHeaders() })
    return user || null
  } catch {
    return null
  }
})
