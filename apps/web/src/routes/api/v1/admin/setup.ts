import { createFileRoute } from '@tanstack/react-router'
import { eq } from 'drizzle-orm'
import { generateId } from '@quackback/ids'
import type { UserId } from '@quackback/ids'
import { db, principal, settings, user, USE_CASE_TYPES } from '@/lib/server/db'
import type { SetupState, UseCaseType } from '@/lib/server/db'
import { invalidateTierLimitsCache } from '@/lib/server/domains/settings/tier-limits.service'
import { resetAuth } from '@/lib/server/auth/index'
import { authenticateAdminToken } from '@/lib/server/domains/api-keys/admin-token-auth'
import { mintMagicLinkUrl } from '@/lib/server/auth/magic-link-mint'

/**
 * POST /api/v1/admin/setup
 *
 * One-shot provisioning seed. Used by the cloud control plane right
 * after a tenant pod becomes healthy to populate the workspace name,
 * use case, and tier limits in a single call — so the user lands in
 * the wizard past the steps they already answered on the cloud signup
 * form, instead of re-entering them.
 *
 * Body:
 *   {
 *     workspaceName: string         // required, 1-200 chars
 *     workspaceSlug?: string        // optional override; derived from name if absent
 *     useCase?: 'saas' | 'consumer' | 'marketplace' | 'internal'
 *     tierLimits?: TierLimits       // optional; same shape as /admin/tier-limits POST
 *     admin?: { email, name }       // optional; provision as workspace admin
 *                                    // and return a one-shot magic-link
 *                                    // login URL the orchestrator can
 *                                    // redirect the user to.
 *   }
 *
 * Idempotent: re-running with the same payload is a no-op-ish overwrite
 * (settings row is the singleton). The orchestrator is the trusted writer.
 *
 * Effect on the OSS onboarding wizard: setupState.steps.workspace and
 * setupState.useCase are set. pickOnboardingStep then routes the first
 * sign-in past those two steps directly to /onboarding/boards.
 *
 * When `admin` is supplied, the response includes `loginUrl` — a magic
 * link verify URL that signs the recipient in on click. The cloud
 * orchestrator redirects the user there, so they land authenticated and
 * past the Account step in the wizard.
 */
export const Route = createFileRoute('/api/v1/admin/setup')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = await authenticateAdminToken(request)
        if (auth) return auth

        let payload: unknown
        try {
          payload = await request.json()
        } catch {
          return errJson('invalid_json', 400)
        }
        const parsed = parseBody(payload)
        if ('error' in parsed) return errJson(parsed.error, 400)

        const slug = parsed.workspaceSlug ?? slugify(parsed.workspaceName)

        // Read the (singleton) existing settings row first. If the user
        // has already completed the workspace step (renamed their
        // workspace, set a custom slug, etc.), we MUST NOT overwrite
        // their state on a re-run — the orchestrator may legitimately
        // call /admin/setup again later for a tier-limits push and
        // would clobber whatever the user did in the UI otherwise.
        const existing = await db
          .select({ id: settings.id, setupState: settings.setupState })
          .from(settings)
          .limit(1)

        const existingSetupState = parseSetupState(existing[0]?.setupState ?? null)
        const userHasCustomized = existingSetupState?.steps?.workspace === true
        const tierLimitsJson = parsed.tierLimits ? JSON.stringify(parsed.tierLimits) : undefined

        if (existing[0]) {
          const setClause: Record<string, unknown> = {}
          // Workspace fields: only seed on the FIRST call (when the
          // user hasn't already moved past the workspace step).
          if (!userHasCustomized) {
            setClause.name = parsed.workspaceName
            setClause.slug = slug
            setClause.setupState = JSON.stringify(
              mergeSetupState(existingSetupState, parsed.useCase)
            )
          }
          // Tier limits: always overwrite if provided. Plan changes
          // from Stripe webhooks come through here too.
          if (tierLimitsJson) setClause.tierLimits = tierLimitsJson
          if (Object.keys(setClause).length > 0) {
            await db.update(settings).set(setClause).where(eq(settings.id, existing[0].id))
          }
        } else {
          await db
            .insert(settings)
            .values({
              name: parsed.workspaceName,
              slug,
              createdAt: new Date(),
              setupState: JSON.stringify(mergeSetupState(null, parsed.useCase)),
              tierLimits: tierLimitsJson ?? null,
            })
            .onConflictDoNothing({ target: settings.slug })
        }

        invalidateTierLimitsCache()
        if (tierLimitsJson) {
          // Same rationale as /admin/tier-limits: auth caches features
          // at build time; reset so e.g. SSO toggles take effect now.
          resetAuth()
        }

        // Admin provisioning + magic-link mint runs AFTER settings are
        // written so the verify URL points at a fully-seeded workspace.
        // mintMagicLinkUrl reads BASE_URL from request headers via the
        // Origin we pass in.
        let loginUrl: string | undefined
        if (parsed.admin) {
          try {
            loginUrl = await provisionAdminAndMintLogin(parsed.admin, request)
          } catch (err) {
            return errJson(
              `admin_provision_failed:${err instanceof Error ? err.message : 'unknown'}`,
              500
            )
          }
        }

        return new Response(JSON.stringify({ ok: true, loginUrl }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    },
  },
})

type ParsedBody = {
  workspaceName: string
  workspaceSlug?: string
  useCase?: UseCaseType
  tierLimits?: Record<string, unknown>
  admin?: { email: string; name: string }
}

function parseBody(payload: unknown): ParsedBody | { error: string } {
  if (!payload || typeof payload !== 'object') return { error: 'invalid_body' }
  const o = payload as Record<string, unknown>
  if (
    typeof o.workspaceName !== 'string' ||
    o.workspaceName.length < 1 ||
    o.workspaceName.length > 200
  ) {
    return { error: 'workspace_name_required' }
  }
  if (o.workspaceSlug !== undefined && typeof o.workspaceSlug !== 'string') {
    return { error: 'workspace_slug_invalid' }
  }
  if (o.useCase !== undefined && !USE_CASE_TYPES.includes(o.useCase as UseCaseType)) {
    return { error: 'use_case_invalid' }
  }
  if (o.tierLimits !== undefined && (typeof o.tierLimits !== 'object' || o.tierLimits === null)) {
    return { error: 'tier_limits_invalid' }
  }
  let admin: { email: string; name: string } | undefined
  if (o.admin !== undefined) {
    if (typeof o.admin !== 'object' || o.admin === null) return { error: 'admin_invalid' }
    const a = o.admin as Record<string, unknown>
    if (typeof a.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email)) {
      return { error: 'admin_email_invalid' }
    }
    if (typeof a.name !== 'string' || a.name.trim().length < 1 || a.name.length > 200) {
      return { error: 'admin_name_invalid' }
    }
    admin = { email: a.email.toLowerCase().trim(), name: a.name.trim() }
  }
  return {
    workspaceName: o.workspaceName,
    workspaceSlug: o.workspaceSlug as string | undefined,
    useCase: o.useCase as UseCaseType | undefined,
    tierLimits: o.tierLimits as Record<string, unknown> | undefined,
    admin,
  }
}

/**
 * Idempotently provisions the workspace admin user and returns a magic-link
 * URL that signs them in on click. Called from `/api/v1/admin/setup` when
 * the orchestrator passes `admin: { email, name }`.
 *
 * - User row: created (emailVerified=true) if no row matches the email,
 *   reused otherwise. Identity churn is the orchestrator's problem to
 *   avoid; this endpoint never overwrites a name/email mismatch.
 * - Principal: created with role='admin' if missing, upgraded to admin
 *   if it exists with a lower role. (Better-Auth's user.create.after
 *   hook only fires when sign-up goes through Better-Auth itself, which
 *   we deliberately bypass here, so the principal must be inserted
 *   explicitly.)
 * - Magic link: minted via the standard magicLink plugin → 10-minute TTL,
 *   single-use. Callback lands on `/onboarding` which routes to the first
 *   incomplete wizard step (or `/admin` once onboarding is complete).
 */
async function provisionAdminAndMintLogin(
  input: { email: string; name: string },
  request: Request
): Promise<string> {
  const { email, name } = input

  const existingUser = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
    .limit(1)

  let userId: UserId
  if (existingUser[0]) {
    userId = existingUser[0].id as UserId
  } else {
    userId = generateId('user')
    await db.insert(user).values({
      id: userId,
      name,
      email,
      emailVerified: true,
      isAnonymous: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
  }

  const existingPrincipal = await db.query.principal.findFirst({
    where: eq(principal.userId, userId),
  })
  if (!existingPrincipal) {
    await db.insert(principal).values({
      id: generateId('principal'),
      userId,
      role: 'admin',
      type: 'user',
      displayName: name,
      createdAt: new Date(),
    })
  } else if (existingPrincipal.role !== 'admin') {
    await db.update(principal).set({ role: 'admin' }).where(eq(principal.id, existingPrincipal.id))
  }

  // Origin for the magic link must be the tenant's public URL. BASE_URL
  // is set at provision time by the chart and is the canonical source.
  // Falling back to the request's Host preserves dev local-curl flows.
  const portalUrl = process.env.BASE_URL ?? `https://${request.headers.get('host') ?? 'localhost'}`

  // mintMagicLinkUrl builds a URL pointing at the /verify-magic-link
  // wrapper page (loading-state UX for email clicks). For an
  // orchestrator-driven server redirect we want the *direct* verify
  // endpoint: pure 302 + Set-Cookie, no JS flash. Mint via the helper
  // (so token capture stays uniform) then rewrite the path.
  const wrapperUrl = await mintMagicLinkUrl({
    email,
    callbackPath: '/onboarding',
    errorCallbackPath: '/auth/login',
    portalUrl,
  })
  const wrapper = new URL(wrapperUrl)
  const direct = new URL('/api/auth/magic-link/verify', wrapper.origin)
  direct.search = wrapper.search
  return direct.toString()
}

function parseSetupState(s: string | null): Partial<SetupState> | null {
  if (!s) return null
  try {
    return JSON.parse(s) as SetupState
  } catch {
    return null
  }
}

function mergeSetupState(
  existing: Partial<SetupState> | null,
  useCase: UseCaseType | undefined
): SetupState {
  return {
    version: 1,
    steps: {
      core: true,
      workspace: true,
      boards: existing?.steps?.boards ?? false,
    },
    completedAt: existing?.completedAt,
    source: 'cloud',
    useCase: useCase ?? existing?.useCase,
  }
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50) || 'workspace'
  )
}

function errJson(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
