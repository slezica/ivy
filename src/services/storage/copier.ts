/**
 * File Copier Service
 *
 * Two-phase file copy via native module. Handles content:// URIs (from document
 * picker, Google Drive, etc.) and file:// URIs uniformly.
 *
 * Phase 1 (beginCopy): Opens the source, reads a fingerprint, returns immediately.
 * Phase 2 (commitCopy/cancelCopy): Copies the file with SHA-256 hashing and progress,
 *         or aborts without writing anything to disk.
 */

import { NativeModules, NativeEventEmitter } from 'react-native'

// =============================================================================
// Public Interface
// =============================================================================

export interface CopyBeginResult {
  opId: string
  fileSize: number        // -1 if unknown
  fingerprint: Uint8Array
}

export interface CopyCommitResult {
  hash: string            // SHA-256 hex
  bytesWritten: number
}

export type ProgressCallback = (bytesWritten: number, totalBytes: number) => void

// =============================================================================
// Service
// =============================================================================

export class FileCopierService {
  /**
   * Phase 1: Open the source and read the fingerprint.
   * No file is created on disk. Call commitCopy or cancelCopy after this.
   */
  async beginCopy(sourceUri: string): Promise<CopyBeginResult> {
    const result = await NativeFileCopier.beginCopy(sourceUri)

    return {
      opId: result.opId,
      fileSize: result.fileSize,
      fingerprint: base64ToUint8Array(result.fingerprint),
    }
  }

  /**
   * Phase 2a: Copy the file to destPath, computing SHA-256 incrementally.
   * Calls onProgress periodically with (bytesWritten, totalBytes).
   */
  async commitCopy(
    opId: string,
    destPath: string,
    onProgress?: ProgressCallback,
  ): Promise<CopyCommitResult> {
    // Subscribe to progress events for this operation
    let subscription: { remove: () => void } | null = null

    if (onProgress) {
      const emitter = new NativeEventEmitter(NativeModules.FileCopier)

      subscription = emitter.addListener('FileCopierProgress', (event) => {
        if (event.opId === opId) {
          onProgress(event.bytesWritten, event.totalBytes)
        }
      })
    }

    try {
      const result = await NativeFileCopier.commitCopy(opId, destPath)

      return {
        hash: result.hash,
        bytesWritten: result.bytesWritten,
      }
    } finally {
      subscription?.remove()
    }
  }

  /**
   * Phase 2b: Cancel a pending or in-progress copy.
   * If the copy hasn't started, the source stream is closed.
   * If the copy is running, it stops and the partial output is deleted.
   */
  async cancelCopy(opId: string): Promise<void> {
    await NativeFileCopier.cancelCopy(opId)
  }
}


// =============================================================================
// Native Module
// =============================================================================

interface NativeFileCopierInterface {
  beginCopy(sourceUri: string): Promise<{
    opId: string
    fileSize: number
    fingerprint: string   // base64
  }>

  commitCopy(opId: string, destPath: string): Promise<{
    hash: string
    bytesWritten: number
  }>

  cancelCopy(opId: string): Promise<void>
}

const { FileCopier: NativeFileCopier } = NativeModules as {
  FileCopier: NativeFileCopierInterface
}


// =============================================================================
// Helpers
// =============================================================================

function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64)
  const bytes = new Uint8Array(binaryString.length)
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i)
  }
  return bytes
}
