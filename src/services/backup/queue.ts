/**
 * Sync Queue Service
 *
 * Queues local changes for sync when online. Handles retry logic and
 * deduplication of operations on the same entity.
 */

import { DatabaseService, SyncEntityType, SyncOperation, SyncQueueItem } from '../storage'
import { createLogger } from '../../utils'

const log = createLogger('SyncQueue')

const MAX_ATTEMPTS = 3

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QueueStats {
  pending: number
  failed: number  // items that exceeded max attempts
}

export interface ProcessResult {
  processed: number
  failed: number
  errors: string[]
}

// Handler called to process a single queued item
export type QueueItemHandler = (item: SyncQueueItem) => Promise<void>

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class SyncQueueService {
  private db: DatabaseService

  constructor(db: DatabaseService) {
    this.db = db
  }

  /**
   * Queue a change for later sync.
   * If an item for the same entity already exists, it's replaced.
   */
  async queueChange(entityType: SyncEntityType, entityId: string, operation: SyncOperation): Promise<void> {
    await this.db.queueChange(entityType, entityId, operation)
  }

  /**
   * Get all pending items (under max attempts).
   */
  async getPendingItems(): Promise<SyncQueueItem[]> {
    return this.db.getPendingQueueItems(MAX_ATTEMPTS)
  }

  /**
   * Get all items in the queue, including failed ones.
   */
  async getAllItems(): Promise<SyncQueueItem[]> {
    return this.db.getAllQueueItems()
  }

  /**
   * Get queue statistics.
   */
  async getStats(): Promise<QueueStats> {
    const all = await this.db.getAllQueueItems()
    const failed = all.filter(item => item.attempts >= MAX_ATTEMPTS)
    return {
      pending: all.length - failed.length,
      failed: failed.length,
    }
  }

  /**
   * Process all pending items using the provided handler.
   * Items that fail are marked with incremented attempts.
   */
  async processQueue(handler: QueueItemHandler): Promise<ProcessResult> {
    const result: ProcessResult = {
      processed: 0,
      failed: 0,
      errors: [],
    }

    const items = await this.getPendingItems()

    for (const item of items) {
      try {
        await handler(item)
        await this.db.removeFromQueue(item.entity_type, item.entity_id)
        result.processed++
        log(`Processed: ${item.entity_type}:${item.entity_id}`)
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        await this.db.updateQueueItemAttempt(item.entity_type, item.entity_id, errorMessage)
        result.failed++
        result.errors.push(`${item.entity_type}:${item.entity_id}: ${errorMessage}`)
        log(`Failed: ${item.entity_type}:${item.entity_id}:`, error)
      }
    }

    return result
  }

  /**
   * Remove an item from the queue (after successful sync).
   */
  async removeFromQueue(entityType: SyncEntityType, entityId: string): Promise<void> {
    await this.db.removeFromQueue(entityType, entityId)
  }

  /**
   * Clear all items from the queue.
   */
  async clearQueue(): Promise<void> {
    await this.db.clearQueue()
  }

  /**
   * Get the count of pending items.
   */
  async getCount(): Promise<number> {
    return this.db.getQueueCount()
  }

  /**
   * Check if an entity has a pending change.
   */
  async hasPendingChange(entityType: SyncEntityType, entityId: string): Promise<boolean> {
    return (await this.db.getQueueItem(entityType, entityId)) !== null
  }

  /**
   * Retry failed items by resetting their attempt count.
   */
  async retryFailed(): Promise<void> {
    const all = await this.db.getAllQueueItems()
    const failed = all.filter(item => item.attempts >= MAX_ATTEMPTS)

    for (const item of failed) {
      await this.db.queueChange(item.entity_type, item.entity_id, item.operation)
    }

    log(`Reset ${failed.length} failed items for retry`)
  }
}

