import type { BoardId, PrincipalId, PostTagId } from '@quackback/ids'

/**
 * CSV import input
 */
export interface ImportInput {
  /** Target board ID for imported posts */
  boardId: BoardId
  /** CSV content encoded as base64 */
  csvContent: string
  /** Total number of rows in the CSV (excluding header) */
  totalRows: number
  /** Member ID of the user who initiated the import */
  initiatedByPrincipalId: PrincipalId
  /**
   * Auto-tag applied to every post the run creates (§I1). Absent for the
   * legacy per-board synchronous path and for dry runs, which never write.
   */
  batchTagId?: PostTagId | null
}

/**
 * Import error details for a single row
 */
export interface ImportRowError {
  /** Row number (1-indexed, excluding header) */
  row: number
  /** Error message describing what went wrong */
  message: string
  /** Optional field name that caused the error */
  field?: string
}

/**
 * CSV import result
 */
export interface ImportResult {
  /** Number of posts successfully imported */
  imported: number
  /** Number of rows skipped due to errors */
  skipped: number
  /** List of errors encountered during import */
  errors: ImportRowError[]
  /** List of tag names that were auto-created */
  createdTags: string[]
}
