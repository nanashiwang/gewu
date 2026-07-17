import { randomUUID } from 'crypto'

export async function getRegistrationEmailRequired(payload: {
  findGlobal: (args: { slug: 'site-settings' }) => Promise<any>
}): Promise<boolean> {
  const settings = await payload.findGlobal({ slug: 'site-settings' }).catch(() => null)
  return settings?.registrationEmailRequired === true
}

export function normalizeRegistrationEmail(email: unknown): string {
  return typeof email === 'string' ? email.trim().toLowerCase() : ''
}

export function generatedRegistrationEmail(): string {
  return `user-${randomUUID()}@users.gewu.invalid`
}

export function resolveRegistrationEmail(email: unknown, required: boolean): string {
  const normalized = normalizeRegistrationEmail(email)
  if (normalized) return normalized
  return required ? '' : generatedRegistrationEmail()
}
