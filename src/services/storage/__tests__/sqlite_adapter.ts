/**
 * Real-SQLite test adapter
 *
 * Implements the subset of the expo-sqlite API that DatabaseService uses on
 * top of Node's built-in sqlite (in-memory), so tests run the actual DDL and
 * queries against real SQL constraints instead of mocks.
 */

import type * as SQLite from 'expo-sqlite'
import { DatabaseSync, SQLInputValue } from 'node:sqlite'

type SQLiteParams = SQLInputValue[]

interface SQLiteRunResult {
  lastInsertRowId: number
  changes: number
}

/**
 * Create an in-memory SQLite database exposing the expo-sqlite methods that
 * DatabaseService uses. Pass it to `new DatabaseService(createTestDatabase())`
 * to run the real service (migrations included) in tests.
 */
export function createTestDatabase(): SQLite.SQLiteDatabase {
  const db = new DatabaseSync(':memory:')

  const run = (source: string, params: SQLiteParams = []): SQLiteRunResult => {
    const result = db.prepare(source).run(...params)
    return { lastInsertRowId: Number(result.lastInsertRowid), changes: Number(result.changes) }
  }

  const getFirst = <T>(source: string, params: SQLiteParams = []): T | null =>
    (db.prepare(source).get(...params) as T | undefined) ?? null

  const getAll = <T>(source: string, params: SQLiteParams = []): T[] =>
    db.prepare(source).all(...params) as T[]

  const adapter = {
    execSync: (source: string): void => { db.exec(source) },
    execAsync: async (source: string): Promise<void> => { db.exec(source) },
    runSync: run,
    runAsync: async (source: string, params?: SQLiteParams): Promise<SQLiteRunResult> => run(source, params),
    getFirstSync: getFirst,
    getFirstAsync: async <T>(source: string, params?: SQLiteParams): Promise<T | null> => getFirst<T>(source, params),
    getAllSync: getAll,
    getAllAsync: async <T>(source: string, params?: SQLiteParams): Promise<T[]> => getAll<T>(source, params),
    closeSync: (): void => { db.close() },
  }

  return adapter as unknown as SQLite.SQLiteDatabase
}
