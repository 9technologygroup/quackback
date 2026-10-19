import {
  DEFAULT_LOCALE,
  loadMessages,
  loadPortalMessages,
  seedAreaMessages,
  type SupportedLocale,
} from '@/lib/shared/i18n'

/** The strings the /device page renders with: its own area plus what it borrows. */
export async function loadDeviceMessages(requested: SupportedLocale | undefined) {
  const locale = requested ?? DEFAULT_LOCALE
  const messages = await seedAreaMessages(locale, 'deviceSignIn')
  // The sign-in-again dialog renders the portal sign-in form, so it needs the
  // portal catalog; the capability picker is shared with API keys, and its
  // labels live there.
  const shared: Record<string, string> = { ...(await loadPortalMessages(locale)) }
  if (locale !== DEFAULT_LOCALE) {
    for (const [key, value] of Object.entries(await loadMessages(locale))) {
      if (key.startsWith('apiKeys.scopes.')) shared[key] = value
    }
  }
  return { locale, messages, shared }
}
