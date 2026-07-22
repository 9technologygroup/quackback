/**
 * Inbound webhook handler interface.
 *
 * Each integration that supports inbound status sync implements this interface.
 * The central orchestrator calls verifySignature, then parseStatusChange,
 * then looks up the post and updates its status.
 */

/**
 * Result of parsing an inbound webhook payload.
 */
export interface InboundWebhookResult {
  /** The external issue ID that changed status */
  externalId: string
  /** The new status name from the external platform */
  externalStatus: string
  /** Event type for logging (e.g. 'issue.updated', 'taskStatusUpdated') */
  eventType: string
}

/**
 * Intent to create a Quackback post from a newly created external item
 * (e.g. a GitHub issue that was opened). Returned by an integration's optional
 * `parseCreatePost` handler; the orchestrator turns it into a post + link.
 */
export interface InboundCreatePostIntent {
  /** The external issue ID (e.g. GitHub issue number as a string). */
  externalId: string
  /** Post title (external item title). */
  title: string
  /** Post body / content (external item body, markdown). */
  body: string
  /** URL of the external item, stored on the link for traceability. */
  externalUrl?: string
  /** The external reporter, mapped to a Quackback principal when present. */
  reporter?: {
    githubId: number | string | null
    login: string
    name?: string | null
  }
  /**
   * Event type — MUST match the `integration_event_mappings.eventType` toggle
   * key that governs this behavior (e.g. 'issues.opened'), so the orchestrator
   * only acts when an admin has enabled it.
   */
  eventType: string
}

/**
 * Handler interface for inbound webhooks from external platforms.
 */
export interface InboundWebhookHandler {
  /**
   * Verify the webhook signature/authenticity.
   * Returns `true` if valid, or a `Response` for handshake challenges or auth failures.
   */
  verifySignature(request: Request, body: string, secret: string): Promise<true | Response>

  /**
   * Parse the webhook body and extract a status change, if any.
   * Returns null for events we don't care about (acknowledged but ignored).
   */
  parseStatusChange(
    body: string,
    config: Record<string, unknown>,
    secrets: Record<string, unknown>
  ): Promise<InboundWebhookResult | null>

  /**
   * Optional: parse the webhook body and extract an intent to create a new post
   * (e.g. a GitHub issue that was opened). Only implemented by integrations that
   * support inbound item creation. Returns null when the event is not a
   * create-worthy one. Gated by a per-integration event-mapping toggle.
   */
  parseCreatePost?(
    body: string,
    config: Record<string, unknown>,
    secrets: Record<string, unknown>
  ): Promise<InboundCreatePostIntent | null>
}
