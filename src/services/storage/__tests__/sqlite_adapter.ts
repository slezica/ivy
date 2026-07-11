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
  // Foreign keys are declared in the DDL but expo-sqlite never enables
  // PRAGMA foreign_keys, so the on-device database does not enforce them
  // (clips can arrive before their book, re-keys are order-independent).
  // node:sqlite enforces them by default — disable to mirror the device.
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false })

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
    // Real expo-sqlite runs the transaction on a dedicated connection; here
    // node:sqlite is synchronous and single-connection, so passing the adapter
    // itself as `txn` gives equivalent isolation.
    withExclusiveTransactionAsync: async (task: (txn: SQLite.SQLiteDatabase) => Promise<void>): Promise<void> => {
      db.exec('BEGIN EXCLUSIVE')
      try {
        await task(adapter as unknown as SQLite.SQLiteDatabase)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
    closeSync: (): void => { db.close() },
  } as unknown as SQLite.SQLiteDatabase

  return adapter
}
