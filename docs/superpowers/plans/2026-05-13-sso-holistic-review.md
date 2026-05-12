# Quackback SSO — Holistic Review vs SaaS Best Practice

Branch: `feat/sso-enforcement-v0.11` · 36 commits · 0057_audit_log..0059_sso_required_default

## Scope of comparison

Benchmarked against the SSO surfaces shipped by:

- **Identity-first**: Okta, Auth0, Microsoft Entra ID, Google Workspace
- **Modern SaaS**: Linear, Notion, Vercel, Figma, Slack
- **Developer-tools enterprise**: GitHub Enterprise, GitLab, Atlassian

Where industry behaviour varies between platforms, the rating is set against the **modal practice** for B2B SaaS targeting compliance-conscious customers (the audience that asks "do you support SSO enforcement?" in security questionnaires).

Legend:

- ✅ **Match** — implementation is at or near industry standard
- ⚠️ **Partial** — present but with material gaps
- ❌ **Missing** — significant gap vs industry baseline
- 🟡 **Intentional gap** — known omission, documented elsewhere

Priorities: **P0** ship-blocker for enterprise / **P1** notable gap, close in v0.11.x / **P2** v0.12 candidate / **P3** later.

---

## 1. Provider configuration & onboarding

| Capability | Quackback today | Industry baseline | Status | Priority | Notes |
|---|---|---|---|---|---|
| OIDC discovery URL config | ✅ Discovery URL + clientId in `authConfig.ssoOidc`; client secret in `platform_credentials` (encrypted) | All major IdPs support OIDC discovery; secret stored encrypted is standard | ✅ | — | `sso-secret.ts` |
| SAML 2.0 support | ❌ OIDC-only | Linear, Notion, Vercel, GitHub all offer SAML alongside OIDC. Many enterprise IdPs (legacy Okta, ADFS) are SAML-only | ❌ | P2 | Adding SAML doubles surface; consider for v0.12 |
| Multiple SSO connections | ❌ One IdP per workspace | Linear/Notion limit to one; Okta allows N; Auth0 N. Single is acceptable for most SaaS | ⚠️ | P3 | Defer — one IdP covers most workspaces |
| Provider-specific shortcuts (Entra tenant ID, Okta domain, Keycloak realm) | ✅ `idp-shortcuts.ts` infers and pre-fills | Auth0 ships templated providers; Notion has Okta/OneLogin tiles | ✅ | — | `inferIdpKind` |
| Test sign-in (diagnostic) | ✅ Inline modal, replays handshake without persisting | Auth0 has "Try connection", Okta "Test SSO". Most SaaS don't have this — strong differentiator | ✅ | — | `sso-test-callback.ts` |
| SSRF guard on discovery + token + JWKS URLs | ✅ `checkUrlSafety` blocks private/loopback/CGNAT before save | Surprisingly under-implemented; only Auth0/Okta publicly call this out | ✅ | — | Better than baseline |
| Config-file (GitOps) provisioning | ✅ Reconciler from `/etc/quackback/config.yaml` | GitHub Enterprise, Auth0, Vercel all support config-as-code | ✅ | — | OSS-friendly |
| First-sign-in admin promotion | ✅ "Bootstrap admin if no admin exists" transaction with advisory lock | Notion auto-promotes the first user; Linear requires invite. Bootstrap pattern is solid | ✅ | — | `handleSsoCallbackAfter` |

---

## 2. Authentication flow & sign-in UX

| Capability | Quackback today | Industry baseline | Status | Priority | Notes |
|---|---|---|---|---|---|
| Email-first dispatcher (`/admin/login`) | ✅ `lookupAuthMethodsFn` routes by email/domain | Slack, Notion, Vercel, Linear all do this | ✅ | — | |
| IdP-Initiated SSO (deep-link from IdP dashboard) | ❌ Only SP-initiated | Okta/Auth0 require for "app catalog" listings; GitHub supports | ❌ | P2 | Needed if customers use Okta App Catalog |
| `prompt=select_account` on every sign-in | ✅ Added in `8edd8d7f` | Linear, Auth0 default. Avoids "wrong account already signed in" footgun | ✅ | — | |
| `login_hint` forwarded to IdP | ✅ Via `additionalData.loginHint` | Vercel, Notion. Major reduces account-mismatch confusion | ✅ | — | |
| Email-typo / wrong-IdP detection | ❌ No fuzzy domain match | Notion auto-suggests "Did you mean acme.com?" | ❌ | P3 | Low-leverage |
| "Use a recovery code" link on login page | ✅ `/admin/login` footer points to `/auth/recovery` | GitHub, Linear, Notion all expose | ✅ | — | Added in `d666719a` |
| SSO discovery error messages (timeout, wrong type, http_401) | ✅ Mapped error codes with helpful copy | Most SaaS show "sign-in failed" generic; Auth0 surfaces details | ✅ | — | `admin.login.tsx` |
| Sign-in-as-admin escape on portal route | ✅ Hooks route team-role users to `/admin/login?error=sso_required` | Slack does this; most don't | ✅ | — | |
| Sign-in audit (every successful + failed attempt) | ⚠️ Failures audited (`auth.method.blocked`); successes implicit via session creation | Okta, Auth0 log every attempt. Compliance customers expect both | ⚠️ | P1 | Add `auth.signin.success` event |
| Anomaly detection (impossible travel, new device) | ❌ Not present | Okta, Auth0 ship as paid add-on. Modern SaaS (Linear) skips it | ❌ | P3 | Out of scope; integrate with downstream SIEM |
| Geo/IP allowlists on SSO | ❌ Not present | GitHub Enterprise, Okta. Niche feature | ❌ | P3 | |

---

## 3. Enforcement & policy

| Capability | Quackback today | Industry baseline | Status | Priority | Notes |
|---|---|---|---|---|---|
| Per-domain SSO enforcement | ✅ `sso_verified_domain.enforced` boolean per row | Notion, Linear, Vercel — all per-domain | ✅ | — | |
| Workspace-wide require-SSO | ✅ `authConfig.ssoOidc.required` | Linear, GitHub Enterprise, Vercel Pro | ✅ | — | Added in C.1-C.9 |
| Magic-link escape under Required | ✅ `allowMagicLinkUnderRequired` opt-in | Vercel keeps it on by default; Linear hides it. Opt-in is safer | ✅ | — | |
| Bootstrap-guard before enable (recent SSO sign-in required) | ✅ 7-day window | Okta requires you be signed in as the admin enabling it; we go further | ✅ | — | |
| Recovery-codes prereq before enabling Required | ✅ Hard check | GitHub Enterprise requires the admin enabling enforcement to have 2FA configured; same idea | ✅ | — | |
| Confirmation modal with impact counts | ✅ Team members without SSO + active sessions + magic-link state | Linear shows count of users; nobody else does the session count | ✅ | — | Stronger than baseline |
| Session revocation on enable | ✅ Wipes non-SSO team sessions atomically | Okta, GitHub. Many SaaS miss this | ✅ | — | `revokeNonSsoTeamSessions` |
| Auto-disable magic-link on enable | ✅ Default behaviour | Vercel does this; Linear leaves user to do manually | ✅ | — | |
| Domain ownership verification (DNS TXT) | ✅ Implemented | Notion, Linear, Vercel | ✅ | — | |
| Federated-domain claiming (cross-workspace) | ❌ Not present | Notion enforces; Slack does. Stops a stranger creating an `@acme.com` workspace if Acme already has one verified | ❌ | P2 | Real enterprise concern at scale |
| Role-based policy (e.g. admins must use SSO+2FA but members can use any) | ⚠️ All-or-nothing for team roles | Linear lets you scope by role; Vercel doesn't | ⚠️ | P3 | |
| Time-bound emergency bypass (e.g. "disable SSO for 4 hours") | ❌ Not present | None of the comps offer; usually handled out-of-band | 🟡 | P3 | Recovery codes cover this |

---

## 4. Lockout prevention & break-glass

| Capability | Quackback today | Industry baseline | Status | Priority | Notes |
|---|---|---|---|---|---|
| Recovery codes (per-admin) | ✅ 10 codes, scrypt-hashed, one-time use | GitHub (16 codes), Linear (10), Notion (10) | ✅ | — | |
| Crockford base32 (no 0/O/I/L/U) | ✅ | GitHub uses hex; Linear alphanumeric. Crockford is more typo-resistant | ✅ | — | Subjectively better |
| Show-once modal with acknowledgement | ✅ Mandatory checkbox before dismiss | Most platforms do show-once; the mandatory checkbox is less common | ✅ | — | |
| Copy / Download / Print | ✅ All three | Linear: copy only. GitHub: copy + download. Print is unusual but welcome | ✅ | — | |
| Low-codes warning when <3 left | ✅ Destructive alert in admin UI | GitHub threshold = 3 (matches us); Linear doesn't warn | ✅ | — | |
| Rate-limit on consume endpoint | ✅ 5 attempts per (IP, email) per 5 min, Redis-backed | GitHub, Linear all have it | ✅ | — | |
| Email security alert on use | ✅ `RecoveryCodeUsedEmail` with IP + UA | GitHub, Notion, Linear all send | ✅ | — | |
| Constant-time verify across error branches | ✅ Same scrypt cost for unknown email / wrong code / no codes | Hard to verify externally for comps; GitHub presumably; many SaaS likely leak | ✅ | — | Stronger than typical |
| "I lost my codes" admin reset flow | ❌ Not present (must contact other admin) | GitHub has account recovery via email + ID verification; SaaS usually punts to support | ❌ | P2 | Self-hosters: defer to op SQL access; cloud: support ticket |
| Codes invalidated on password change | ❌ Codes outlive credential rotation | GitHub does invalidate on password change; Linear doesn't | ⚠️ | P2 | Worth considering |
| Code rotation cadence reminder | ❌ No 90-day reminder | None of the comps either; security people would like this | 🟡 | P3 | |

---

## 5. Audit log & compliance

| Capability | Quackback today | Industry baseline | Status | Priority | Notes |
|---|---|---|---|---|---|
| Audit log table | ✅ `audit_log` append-only with three `(col, occurred_at DESC)` indexes | Okta, Auth0, GitHub Enterprise. Modern SaaS (Linear, Vercel) ship this | ✅ | — | |
| Denormalised actor (email, role, IP, UA) | ✅ Survives user deletion | GitHub keeps even after user deletion; Notion redacts on GDPR | ✅ | — | Compliance-friendly |
| Event taxonomy | ⚠️ 9 event types, all SSO/auth-scoped | Okta has 200+ event types; modern SaaS has ~30. We're narrow | ⚠️ | P1 | Add: `auth.signin.success`, `auth.signout`, `session.revoked.individual`, `user.invited/accepted/removed`, `role.changed.by_admin` |
| Admin UI: paginated table | ✅ `/admin/settings/security/audit-log` | Linear: in-app table. GitHub: API + dashboard. Notion: CSV-only | ✅ | — | |
| Filter by event type + time range | ✅ | Linear: by user + event. GitHub: many filters | ⚠️ | P1 | Add actor filter |
| CSV export | ✅ Client-side from filtered window | Notion CSV. GitHub Enterprise JSON | ✅ | — | |
| SIEM streaming (Splunk/Datadog) | ❌ No HTTP webhook for audit events | Okta SCIM events, Auth0 streams, GitHub Enterprise webhook | ❌ | P2 | Genuinely valuable for enterprise |
| Tamper-evident chain (hash-chained rows) | ❌ Just append-only Postgres | Auth0 ships hash chains as paid add-on; not industry standard | 🟡 | P3 | Useful but overkill |
| Retention policy | ❌ Infinite (documented in plan) | GitHub Enterprise: 180 days default. Linear: 90 days free, longer paid. SOC2 needs ≥1 year | ⚠️ | P1 | Add 365-day default + configurable cap |
| GDPR scrub path | ❌ No tool to redact actor PII | Linear, Notion have GDPR right-to-erasure flows | ❌ | P2 | Compliance-required for EU customers |
| Audit log query API | ❌ Only UI today | Okta, Auth0 publish API. Linear has API | ❌ | P2 | Useful for SIEM integration |

---

## 6. Auto-provisioning & user lifecycle

| Capability | Quackback today | Industry baseline | Status | Priority | Notes |
|---|---|---|---|---|---|
| JIT provisioning on first SSO sign-in | ✅ Default role `member` | Okta JIT, Notion auto-provision, Vercel | ✅ | — | |
| Configurable default role | ✅ `autoProvisionRole` ('admin'/'member'/'user') | Linear, Vercel | ✅ | — | |
| Auto-create disabled (invite-only) | ✅ `autoCreateUsers=false` short-circuits | GitHub Enterprise default; Linear option | ✅ | — | |
| IdP-attribute → role mapping | ✅ Dotted + URL-shaped claim paths, first-match-wins, case-insensitive | Okta has group rules; Auth0 has Rules/Actions; GitHub Enterprise groups | ✅ | — | Solid coverage |
| Sync-on-every-sign-in (re-resolve role on each callback) | ✅ Opt-in, audits `user.role.changed` | Okta, Auth0. Major differentiator vs Linear (JIT-only) | ✅ | — | |
| Group-based provisioning (multiple groups → role priority) | ✅ First-match-wins rules | Same | ✅ | — | |
| SCIM 2.0 (cross-workspace provisioning) | ❌ Not present | Okta/Auth0/Microsoft Entra integrations require SCIM. Linear/Notion ship it for Enterprise tier | ❌ | P2 | Big gap for true enterprise but valid v0.12 |
| De-provisioning (IdP delete → app delete) | ⚠️ Only via SCIM (missing) or manual | Linear: requires SCIM. GitHub: SCIM or manual | ⚠️ | P2 | Tied to SCIM |
| Stale-user detection (no sign-in for N days) | ❌ Not present | Okta reports inactive users; Linear deactivates after 90 days | ❌ | P3 | Nice-to-have |
| Reactivation flow for previously-deprovisioned users | ❌ | Linear, Notion auto-reactivate on next SSO sign-in if not hard-deleted | ⚠️ | P3 | |
| Account-link existing local user to SSO | ✅ Via Better-Auth's `accountLinking.trustedProviders` | Standard | ✅ | — | |

---

## 7. Session security

| Capability | Quackback today | Industry baseline | Status | Priority | Notes |
|---|---|---|---|---|---|
| Session row in DB with token + expiry | ✅ Better-Auth managed | Standard | ✅ | — | |
| `lastSsoSignInAt` tracking | ✅ Stamped on every successful SSO callback | Okta, Auth0 track. Used by bootstrap guard | ✅ | — | |
| Cookie security (HttpOnly, Secure, SameSite) | ✅ Better-Auth defaults | Standard | ✅ | — | |
| Session revocation on policy enable | ✅ `revokeNonSsoTeamSessions` | GitHub Enterprise on SAML enable; most SaaS don't | ✅ | — | Stronger than baseline |
| Force-logout-all from admin UI | ❌ Admin can't force a specific user's sessions to end | Linear, Notion, Vercel admin panels all have | ❌ | P1 | Should be straightforward — wire into existing session table |
| Concurrent-session cap | ❌ Unlimited | Okta has policy. Most SaaS unlimited | 🟡 | P3 | |
| Session inactivity timeout | ⚠️ Better-Auth's default | Okta configurable per policy; most SaaS fixed | 🟡 | P3 | |
| IP-pinning / device fingerprinting | ❌ Not present | Okta paid feature; Linear/Vercel skip | 🟡 | P3 | |
| 2FA enforcement under SSO | ⚠️ `twoFactor.required` exists but not gated on SSO sign-in path | Vercel: 2FA in addition to SSO is optional; GitHub: IdP handles it; Linear: enforces if 2FA required | ⚠️ | P2 | SSO IdPs typically do their own MFA; double-prompting is friction. Document the expected boundary |
| MFA enrollment grace period | ✅ "Require 2FA" surfaces a setup-required redirect | Standard | ✅ | — | |

---

## 8. Multi-IdP, SCIM, and federation

| Capability | Quackback today | Industry baseline | Status | Priority | Notes |
|---|---|---|---|---|---|
| Multiple OIDC providers per workspace | ❌ One IdP | Okta/Auth0: N. SaaS like Linear: 1 | ⚠️ | P3 | |
| SCIM 2.0 endpoint | ❌ Not present | Linear/Notion/Vercel ship for Enterprise tier; cited in security questionnaires | ❌ | P2 | Adding ~6 weeks of work |
| SCIM with custom attributes | ❌ | Standard if SCIM is shipped | ❌ | P2 | Tied to above |
| Domain-claim verification (anti-squatting) | ✅ DNS TXT verification | Notion enforces; Slack does | ✅ | — | |
| Cross-workspace federation (e.g. Acme Engineering + Acme Sales share Acme IdP) | ❌ Not present | Notion ships; complex feature | 🟡 | P3 | Not really applicable to single-tenant OSS |

---

## 9. Reporting & monitoring

| Capability | Quackback today | Industry baseline | Status | Priority | Notes |
|---|---|---|---|---|---|
| Sign-in success/failure metrics in admin UI | ❌ Audit log only, no aggregations | Linear: simple dashboard. Okta: extensive reports | ❌ | P2 | Could be a "Stats" tile on Security page |
| User-level last-sign-in display | ⚠️ `lastSsoSignInAt` stored but not surfaced in admin team list | Standard in admin UIs (Linear, GitHub, Vercel) | ⚠️ | P1 | One-line UI add |
| Compliance reports (SOC2 export bundles) | ❌ Not present | Vercel has a Compliance page; Linear has SOC2 reports area | ❌ | P3 | Bigger effort |
| Webhook on policy change | ❌ | Auth0 has Rules → webhook | ❌ | P3 | |
| Alert when SSO breaks (callback errors rising) | ❌ | Okta dashboards. Most SaaS don't have | 🟡 | P3 | |
| Alert when many recovery codes used in short window (account-compromise indicator) | ❌ | Notion/Linear: would arguably trigger via SIEM | ❌ | P2 | Worth a soft alert at 3 codes used in 24h |

---

## 10. UX & error handling polish

| Capability | Quackback today | Industry baseline | Status | Priority | Notes |
|---|---|---|---|---|---|
| Clear error messages per failure type | ✅ Mapped error codes (`sso_required`, `verified_domain_requires_sso`, `oauth_method_not_allowed`, `signup_disabled`, etc.) | Linear, Notion, Vercel | ✅ | — | |
| Pre-flight IdP test | ✅ Test sign-in button | Auth0, Okta. Differentiator vs Linear/Notion | ✅ | — | |
| Two-state vs tri-state enforcement | ✅ "Per verified domain" / "Required for all" (collapsed from tri-state) | Vercel: two-state. Linear: similar | ✅ | — | |
| Per-row Require SSO toggle in domain table | ✅ | Linear has per-domain. Notion doesn't | ✅ | — | |
| Toast feedback after every action | ⚠️ `<Toaster />` now mounted (was missing — pre-existing app-wide bug) | Standard | ✅ | — | Fixed in `814fae51` |
| Inline validation on discovery URL | ✅ SSRF check + zod URL parse | Auth0 does live discovery test; most SaaS just zod | ✅ | — | |
| Sign-out from admin nav | ✅ Pre-existing | Standard | ✅ | — | |
| Onboarding wizard for first SSO setup | ⚠️ Empty-state has provider picker but no step-by-step wizard | Auth0 has multi-step; most SaaS skip | ⚠️ | P3 | Empty state is good enough |
| Help link to per-IdP setup docs (Entra, Okta, Auth0, Keycloak) | ⚠️ Per-IdP icon strip but no inline docs link | Auth0/Vercel link to docs. Major UX improvement | ⚠️ | P2 | One-line link per IdP |
| Self-hosted SMTP fallback warning | ✅ Bootstrap guard requires email configured | Linear/Notion are cloud-only; this is a self-host concern | ✅ | — | |

---

## 11. Implementation depth (code-quality dimensions)

| Aspect | Quackback today | Baseline | Status |
|---|---|---|---|
| Tests for predicate logic (`isHardBound`) | ✅ 12 unit tests across both branches + OR semantics | Most SaaS don't publish tests, but TDD here is solid | ✅ |
| Tests for server fns (consume, generate, list, set-required) | ✅ ~50 tests covering happy + failure paths | Above baseline | ✅ |
| Constant-time recovery verify | ✅ Always one scrypt regardless of branch | Subtle, often-missed | ✅ |
| Rate-limit fail-open on Redis outage | ✅ Documented choice | Auth0 fails-closed; Linear fails-open. Either is defensible | ✅ |
| Audit emission on both success and failure paths | ✅ Consistent across `withAuditEvent` and direct callers | Many platforms only audit successes | ✅ |
| Defense-in-depth at multiple layers (lookup + hooks.before + hooks.after) | ✅ Three layers all enforce `isHardBound` | Stronger than baseline (most SaaS rely on one) | ✅ |
| Documentation in code (why-comments, file headers) | ✅ Per-fn comments explain *why*, not *what* | Above industry-typical | ✅ |
| Type-safe audit-event taxonomy | ✅ Closed union, compile-time checked | Most platforms use string event names; we're stricter | ✅ |

---

## Summary

### Where Quackback is competitive or better than industry

- **Recovery codes**: full feature set incl. rate-limit, alert email, low-codes warning, constant-time consume. On par with GitHub / Linear / Notion.
- **Audit log**: append-only with denormalised actor, three-index query plan, admin UI with filters + CSV. On par with Linear, broader than Notion.
- **Test sign-in diagnostic**: rare feature — most SaaS make you actually click through SSO to find a misconfiguration.
- **SSRF-hardened discovery + token + JWKS** save calls: surprisingly under-implemented in industry.
- **Three-layer enforcement** (lookup → hooks.before → hooks.after): defense-in-depth.
- **IdP attribute-mapping with sync mode**: most SaaS (Linear, Notion) are JIT-only. We can demote on next sign-in.
- **`prompt=select_account` + `login_hint`**: matches Linear/Vercel; avoids the "wrong account silently signed in" footgun.

### Most important gaps to close

| Priority | Gap | Effort | Why now |
|---|---|---|---|
| **P1** | `auth.signin.success` audit event (currently only failures logged explicitly) | S | SOC2 customers will ask in questionnaires |
| **P1** | Audit-log retention policy (currently infinite — SOC2 wants ≥1yr; default 365-day cap + admin override) | S | DB growth ceiling for self-hosters; compliance |
| **P1** | Actor / IP search filter on the audit-log UI | XS | Useful for incident response |
| **P1** | Force-logout-all from admin team list | S | Standard admin action; we have the session table |
| **P1** | Last-sign-in column in admin team list | XS | We already store `lastSsoSignInAt`; one UI add |
| **P2** | SCIM 2.0 endpoint | XL | Required for enterprise / Okta App Catalog listing |
| **P2** | SAML 2.0 alongside OIDC | L | ~30% of enterprise IdPs default to SAML |
| **P2** | SIEM streaming (audit log webhook / API) | M | Splunk/Datadog ingest is a checkbox item |
| **P2** | Federated-domain claiming (one workspace per verified domain across the platform) | M | Cloud-tier concern |
| **P2** | GDPR scrub path for audit-log actor PII | M | EU customers need this |
| **P2** | "I lost my recovery codes" admin reset | S | UX gap; today recovery is silent |
| **P2** | Spike-alert when >3 recovery codes used in 24h | S | Compromise indicator |
| **P3** | IdP-initiated SSO (deep-link from Okta dashboard) | M | Required only if listing in App Catalog |
| **P3** | Multi-IdP per workspace | L | Rarely needed |
| **P3** | Role-scoped enforcement (admins must SSO, members optional) | M | Edge case |

### Recommended v0.11.x patch series

A small follow-up release could close most of the **P1** items in ~1-2 days:

1. Add `auth.signin.success` event type + emit from a post-session hook
2. Add audit-log retention policy: schema field on `settings`, default 365 days, hourly prune job in BullMQ
3. Extend `listAuditEventsFn` with `actorEmail` filter + add the filter input to the admin UI
4. Add "Force sign-out" button in `/admin/settings/team` per-user actions (deletes all session rows for that user, emits `session.revoked.bulk` with `reason: 'admin_forced'`)
5. Add a "Last sign-in" column to the team table (read `lastSsoSignInAt`, or extend to read the most recent `session.created_at` for non-SSO users)

### Recommended v0.12 themes

- **Enterprise tier**: SCIM 2.0, SAML 2.0, audit-log webhook stream
- **Compliance**: GDPR scrub, retention enforcement, signed audit-log export
- **Operations**: spike alerts, last-sign-in surfacing, force-logout

---

## TL;DR

For a v0.11 SSO implementation, this is a **strong baseline** — substantially better than the typical "OIDC button + per-domain enforce" most SaaS ship at first launch. The recovery-codes, audit-log, attribute-mapping, and enforcement coverage are at-or-above industry parity for B2B SaaS targeting compliance-aware customers.

The gap to true enterprise (Okta App Catalog listing, SCIM, SAML, SIEM streaming) is real but is itself a 6-12 week project of its own (v0.12 territory). The **P1 items above are the highest-leverage closures** for the current branch and could ship as a `.1` patch alongside merge to main.
