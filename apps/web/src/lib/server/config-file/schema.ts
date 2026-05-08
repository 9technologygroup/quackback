import { z } from 'zod'

/**
 * Declarative Quackback config file schema.
 *
 * Loaded from `/etc/quackback/config.yaml`. Anything declared here is
 * reconciled into the `settings` row AND blocked from in-app UI
 * mutation; anything absent stays freely user-editable.
 *
 * Only fields with a legitimate platform-control story are in scope.
 * Workflow data (boards, posts, integrations, API keys, sessions) is
 * intentionally NOT representable here — keeps the lock surface small
 * and prevents the file from growing into a kitchen-sink schema.
 */

const useCaseSchema = z.enum(['saas', 'consumer', 'marketplace', 'internal'])

const workspaceSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    slug: z
      .string()
      .min(1)
      .max(50)
      .regex(/^[a-z0-9-]+$/)
      .optional(),
    useCase: useCaseSchema.optional(),
  })
  .strict()

// Mirrors the TierLimits shape from
// apps/web/src/lib/server/domains/settings/tier-limits.types.ts.
// `null` in any numeric field = unlimited; partial objects allowed
// (the reconciler merges into the existing tierLimits row, so the
// file only needs to declare the fields it wants to lock).
const tierLimitNumberSchema = z.number().int().nonnegative().nullable()
const tierFeatureFlagsSchema = z
  .object({
    customDomain: z.boolean().optional(),
    customOidcProvider: z.boolean().optional(),
    ipAllowlist: z.boolean().optional(),
    webhooks: z.boolean().optional(),
    mcpServer: z.boolean().optional(),
    analyticsExports: z.boolean().optional(),
    customColors: z.boolean().optional(),
    customCss: z.boolean().optional(),
    integrations: z.boolean().optional(),
  })
  .strict()
  .optional()
const tierLimitsSchema = z
  .object({
    maxBoards: tierLimitNumberSchema.optional(),
    maxPosts: tierLimitNumberSchema.optional(),
    maxTeamSeats: tierLimitNumberSchema.optional(),
    aiTokensPerMonth: tierLimitNumberSchema.optional(),
    apiRequestsPerMonth: tierLimitNumberSchema.optional(),
    apiRequestsPerMinute: tierLimitNumberSchema.optional(),
    features: tierFeatureFlagsSchema,
  })
  .strict()

// `features` is per-key managed: each entry locks one feature flag
// while leaving others UI-toggleable. Accepts any boolean key — the
// FeatureFlags shape has its own zod schema that the reconciler
// validates against; here the shape just needs to be string→boolean.
const featuresSchema = z.record(z.string(), z.boolean())

// Workspace runtime state. The reconciler writes whatever the file
// declares; absent → `settings.state` keeps its DB default of 'active'.
const stateSchema = z.enum(['active', 'suspended', 'deleting'])

// Auth surface: OAuth provider toggles + openSignup + optional OIDC SSO.
// Provider secrets are never declared here — OAuth credentials live in
// the platform_credentials table, and the SSO client secret rides on
// the SSO_OIDC_CLIENT_SECRET env var.
const oauthProvidersSchema = z
  .object({
    google: z.boolean().optional(),
    github: z.boolean().optional(),
  })
  .strict()

// OIDC SSO provider config. The file declares the non-secret config —
// discoveryUrl + clientId + UX flags — while the client *secret* keeps
// riding on SSO_OIDC_CLIENT_SECRET. When enabled + isDefault, the admin
// login UI promotes "Sign in with {providerName}" as the prominent CTA
// and demotes password / magic-link / other-OAuth to a "More sign-in
// options" disclosure.
const ssoOidcSchema = z
  .object({
    enabled: z.boolean(),
    providerName: z.string().min(1).max(100).default('SSO'),
    discoveryUrl: z.string().url(),
    clientId: z.string().min(1),
    /** Show as the prominent default CTA on the admin login page.
     *  When true + enabled, password sign-in is hidden behind a
     *  "more options" disclosure (still available; just demoted). */
    isDefault: z.boolean().default(true),
    /** Auto-create user records on first SSO sign-in. */
    autoCreateUsers: z.boolean().default(true),
  })
  .strict()

const authSchema = z
  .object({
    oauth: oauthProvidersSchema.optional(),
    openSignup: z.boolean().optional(),
    ssoOidc: ssoOidcSchema.optional(),
  })
  .strict()

export const quackbackConfigSchema = z
  .object({
    apiVersion: z.literal('quackback.io/v1'),
    kind: z.literal('QuackbackConfig'),
    metadata: z.object({ source: z.string().optional() }).strict().optional(),
    spec: z
      .object({
        workspace: workspaceSchema.optional(),
        tierLimits: tierLimitsSchema.optional(),
        features: featuresSchema.optional(),
        state: stateSchema.optional(),
        auth: authSchema.optional(),
      })
      .strict(),
  })
  .strict()

export type QuackbackConfig = z.infer<typeof quackbackConfigSchema>
export type QuackbackConfigSpec = QuackbackConfig['spec']

export function parseQuackbackConfig(input: unknown): z.ZodSafeParseResult<QuackbackConfig> {
  return quackbackConfigSchema.safeParse(input)
}
