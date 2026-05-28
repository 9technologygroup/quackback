import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getTableColumns } from 'drizzle-orm'
import { boards } from '../boards'
import { DEFAULT_BOARD_ACCESS } from '../../types'

describe('boards.access column', () => {
  it('exists on the boards table', () => {
    const cols = getTableColumns(boards)
    expect(cols.access).toBeDefined()
  })

  it('is NOT NULL and its default deep-equals DEFAULT_BOARD_ACCESS', () => {
    const cols = getTableColumns(boards)
    const col = cols.access as unknown as { notNull: boolean; default: unknown }
    expect(col.notNull).toBe(true)
    // The Drizzle default is DEFAULT_BOARD_ACCESS by reference; assert by
    // value so any divergence (incl. a stale schema literal) is caught.
    expect(col.default).toEqual(DEFAULT_BOARD_ACCESS)
  })

  it('the 0083 migration SET DEFAULT literal matches DEFAULT_BOARD_ACCESS', () => {
    // Guards the real drift surface: the live DB column default is set by
    // the migration literal, not the TS constant. They must agree.
    const sql = readFileSync(
      join(__dirname, '../../../drizzle/0083_board_moderation_tri_state.sql'),
      'utf8'
    )
    const m = sql.match(/SET DEFAULT '([^']+)'::jsonb/)
    expect(m).not.toBeNull()
    expect(JSON.parse(m![1])).toEqual(DEFAULT_BOARD_ACCESS)
  })
})
