/**
 * Sync Queue Service
 *
 * Queues local changes for sync when online. Handles retry logic and
 * deduplication of operations on the same entity.
 */

import { DatabaseService, SyncEntityType, SyncOperation, SyncQueueItem } from '../storage'

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
  queueChange(entityType: SyncEntityType, entityId: string, operation: SyncOperation): void {
    this.db.queueChange(entityType, entityId, operation)
  }

  /**
   * Get all pending items (under max attempts).
   */
  getPendingItems(): SyncQueueItem[] {
    return this.db.getPendingQueueItems(MAX_ATTEMPTS)
  }

  /**
   * Get all items in the queue, including failed ones.
   */
  getAllItems(): SyncQueueItem[] {
    return this.db.getAllQueueItems()
  }

  /**
   * Get queue statistics.
   */
  getStats(): QueueStats {
    const all = this.db.getAllQueueItems()
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

    const items = this.getPendingItems()

    for (const item of items) {
      try {
        await handler(item)
        this.db.removeFromQueue(item.entity_type, item.entity_id)
        result.processed++
        console.log(`Processed queue item: ${item.entity_type}:${item.entity_id}`)
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        this.db.updateQueueItemAttempt(item.entity_type, item.entity_id, errorMessage)
        result.failed++
        result.errors.push(`${item.entity_type}:${item.entity_id}: ${errorMessage}`)
        console.warn(`Failed to process queue item ${item.entity_type}:${item.entity_id}:`, error)
      }
    }

    return result
  }

  /**
   * Remove an item from the queue (after successful sync).
   */
  removeFromQueue(entityType: SyncEntityType, entityId: string): void {
    this.db.removeFromQueue(entityType, entityId)
  }

  /**
   * Clear all items from the queue.
   */
  clearQueue(): void {
    this.db.clearQueue()
  }

  /**
   * Get the count of pending items.
   */
  getCount(): number {
    return this.db.getQueueCount()
  }

  /**
   * Check if an entity has a pending change.
   */
  hasPendingChange(entityType: SyncEntityType, entityId: string): boolean {
    return this.db.getQueueItem(entityType, entityId) !== null
  }

  /**
   * Retry failed items by resetting their attempt count.
   */
  retryFailed(): void {
    const all = this.db.getAllQueueItems()
    const failed = all.filter(item => item.attempts >= MAX_ATTEMPTS)

    for (const item of failed) {
      // Re-queue resets the attempts to 0
      this.db.queueChange(item.entity_type, item.entity_id, item.operation)
    }

    console.log(`Reset ${failed.length} failed items for retry`)
  }
}

