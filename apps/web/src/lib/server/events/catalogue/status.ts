/**
 * Status-page event declarations. All are webhook-exposed; none are workflow
 * triggers. The two publish events also drive the status-subscription
 * notification path (its own resolver), so notification is keyed 'status' for
 * them. Status events carry no board, so webhook board filters do not apply.
 */
import { decl } from './helpers'

const S = 'status_page'

export const statusIncidentCreated = decl(
  'status.incident_created',
  'status_incident',
  { webhook: true, notification: 'status' },
  S
)
export const statusIncidentUpdated = decl(
  'status.incident_updated',
  'status_incident',
  { webhook: true },
  S
)
export const statusMaintenanceScheduled = decl(
  'status.maintenance_scheduled',
  'status_incident',
  { webhook: true, notification: 'status' },
  S
)
export const statusMaintenanceStarted = decl(
  'status.maintenance_started',
  'status_incident',
  { webhook: true },
  S
)
export const statusMaintenanceCompleted = decl(
  'status.maintenance_completed',
  'status_incident',
  { webhook: true },
  S
)
export const statusComponentChanged = decl(
  'status.component_changed',
  'status_component',
  { webhook: true },
  S
)
