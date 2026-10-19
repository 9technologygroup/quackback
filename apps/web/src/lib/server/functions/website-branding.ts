import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { requireAuth, policyActorFromAuth } from './auth-helpers'
import {
  acceptWebsiteBrandingOffer,
  declineWebsiteBrandingOffer,
  ensureAutomaticWebsiteBranding,
  getAutomaticWebsiteBrandingStatus,
  lookupWebsiteBrandingForSite,
  undoAutomaticWebsiteBranding,
} from '@/lib/server/domains/assistant/automatic-website-branding.service'

export const startAutomaticWebsiteBrandingFn = createServerFn({ method: 'POST' }).handler(
  async () => {
    const actor = await policyActorFromAuth(await requireAuth())
    return ensureAutomaticWebsiteBranding(actor)
  }
)
export const getAutomaticWebsiteBrandingStatusFn = createServerFn({ method: 'GET' }).handler(
  async () => {
    const actor = await policyActorFromAuth(await requireAuth())
    return getAutomaticWebsiteBrandingStatus(actor)
  }
)
export const acceptWebsiteBrandingOfferFn = createServerFn({ method: 'POST' }).handler(async () => {
  const actor = await policyActorFromAuth(await requireAuth())
  return acceptWebsiteBrandingOffer(actor)
})
export const declineWebsiteBrandingOfferFn = createServerFn({ method: 'POST' }).handler(
  async () => {
    const actor = await policyActorFromAuth(await requireAuth())
    return declineWebsiteBrandingOffer(actor)
  }
)
export const undoAutomaticWebsiteBrandingFn = createServerFn({ method: 'POST' }).handler(
  async () => {
    const actor = await policyActorFromAuth(await requireAuth())
    return undoAutomaticWebsiteBranding(actor)
  }
)
export const lookupWebsiteBrandingFn = createServerFn({ method: 'POST' })
  .validator(z.object({ site: z.string().trim().min(1).max(2048) }))
  .handler(async ({ data }) => {
    const actor = await policyActorFromAuth(await requireAuth())
    return lookupWebsiteBrandingForSite(actor, data.site)
  })
