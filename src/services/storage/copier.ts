/**
 * File Copier Service
 *
 * Multi-phase file copy via native module. Handles content:// URIs (from document
 * picker, Google Drive, etc.) and file:// URIs uniformly.
 *
 * createOperation(): Allocates an ID — cancellable from this point.
 * beginCopy(): Opens the source, reads a fingerprint.
 * commitCopy()/cancelCopy(): Copies with SHA-256 + progress, or aborts.
 */

import { NativeModules, NativeEventEmitter } from 'react-native'
import { createLogger } from '../../utils'

const log = createLogger('FileCopier')

// =============================================================================
// Public Interface
// =============================================================================

export interface CopyBeginResult {
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
   * Allocate an operation ID. The operation can be cancelled from this point.
   */
  createOperation(): string {
    return NativeFileCopier.createOperation()
  }

  /**
   * Open the source and read the fingerprint.
   * No file is created on disk. Call commitCopy or cancelCopy after this.
   */
  async beginCopy(opId: string, sourceUri: string): Promise<CopyBeginResult> {
    log(`Begin copy ${opId}`)
    const result = await NativeFileCopier.beginCopy(opId, sourceUri)

    return {
      fileSize: result.fileSize,
      fingerprint: base64ToUint8Array(result.fingerprint),
    }
  }

  /**
   * Copy the file to destPath, computing SHA-256 incrementally.
   * Calls onProgress periodically with (bytesWritten, totalBytes).
   */
  async commitCopy(
    opId: string,
    destPath: string,
    onProgress?: ProgressCallback,
  ): Promise<CopyCommitResult> {
    log(`Committing copy ${opId} → ${destPath}`)
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
   * Cancel at any stage: before begin, during begin, between begin/commit, or during commit.
   */
  async cancelCopy(opId: string): Promise<void> {
    log(`Cancelling copy ${opId}`)
    await NativeFileCopier.cancelCopy(opId)
  }
}


// =============================================================================
// Native Module
// =============================================================================

interface NativeFileCopierInterface {
  createOperation(): string

  beginCopy(opId: string, sourceUri: string): Promise<{
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
