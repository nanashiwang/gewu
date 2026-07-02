import { Section } from '@/components/console/ConsoleUI'
import { SettingsForm } from '@/components/console/SettingsForm'
import { getCurrentUser } from '@/lib/auth'
import { getPayloadClient } from '@/lib/payload'

export const dynamic = 'force-dynamic'

export default async function SettingsPage() {
  const user = await getCurrentUser()
  const payload = await getPayloadClient()
  // 取本人完整记录以判断是否已配置 Key（不回显明文）
  const full = user
    ? ((await payload
        .findByID({ collection: 'users', id: user.id, overrideAccess: true, depth: 0 })
        .catch(() => null)) as any)
    : null

  return (
    <Section title="设置">
      <SettingsForm hasKey={!!full?.newapiKeyEncrypted} bio={full?.bio || ''} />
    </Section>
  )
}
