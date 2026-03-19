package com.salezica.ivy

import android.net.Uri
import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.FileOutputStream
import java.io.InputStream
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap

private const val CHUNK_SIZE = 256 * 1024          // 256 KB
private const val FINGERPRINT_BYTES = 4096          // First 4 KB
private const val PROGRESS_INTERVAL_MS = 100L       // Throttle progress events
private const val PROGRESS_EVENT = "FileCopierProgress"

/**
 * Holds the state of a copy operation between beginCopy and commitCopy/cancelCopy.
 */
private class CopyOperation(
    val inputStream: InputStream,
    val fileSize: Long,
    val fingerprint: ByteArray,
) {
    @Volatile var cancelled = false
}

class FileCopierModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    private val operations = ConcurrentHashMap<String, CopyOperation>()
    private var nextOpId = 0L

    override fun getName(): String = "FileCopier"

    /**
     * Phase 1: Open the source, read the fingerprint, return immediately.
     * No output file is created yet.
     *
     * Returns: { opId, fileSize, fingerprint (base64) }
     */
    @ReactMethod
    fun beginCopy(sourceUri: String, promise: Promise) {
        Thread {
            try {
                val uri = Uri.parse(sourceUri)
                val context = reactApplicationContext

                val inputStream = context.contentResolver.openInputStream(uri)
                    ?: return@Thread promise.reject("OPEN_FAILED", "Could not open source URI: $sourceUri")

                val fileSize = queryFileSize(uri) ?: -1L

                // Read the first 4 KB for fingerprinting
                val fingerprint = ByteArray(FINGERPRINT_BYTES)
                var bytesRead = 0

                while (bytesRead < FINGERPRINT_BYTES) {
                    val read = inputStream.read(fingerprint, bytesRead, FINGERPRINT_BYTES - bytesRead)
                    if (read == -1) break
                    bytesRead += read
                }

                val actualFingerprint = if (bytesRead < FINGERPRINT_BYTES) {
                    fingerprint.copyOf(bytesRead)
                } else {
                    fingerprint
                }

                val opId = synchronized(this) { (nextOpId++).toString() }
                operations[opId] = CopyOperation(inputStream, fileSize, actualFingerprint)

                val result = Arguments.createMap().apply {
                    putString("opId", opId)
                    putDouble("fileSize", fileSize.toDouble())
                    putString("fingerprint", Base64.encodeToString(actualFingerprint, Base64.NO_WRAP))
                }

                promise.resolve(result)

            } catch (e: Exception) {
                promise.reject("BEGIN_FAILED", "beginCopy failed: ${e.message}", e)
            }
        }.start()
    }

    /**
     * Phase 2: Copy the remainder of the file to destPath, computing SHA-256 incrementally.
     * Emits "FileCopierProgress" events with { opId, bytesWritten, totalBytes }.
     *
     * Returns: { hash (hex), bytesWritten }
     */
    @ReactMethod
    fun commitCopy(opId: String, destPath: String, promise: Promise) {
        Thread {
            val op = operations[opId]

            if (op == null) {
                promise.reject("UNKNOWN_OP", "No operation found with ID: $opId")
                return@Thread
            }

            try {
                val digest = MessageDigest.getInstance("SHA-256")

                // The fingerprint bytes were already read — feed them into the hash
                digest.update(op.fingerprint)

                val outputStream = FileOutputStream(destPath)
                var bytesWritten = 0L
                var lastProgressTime = System.currentTimeMillis()

                // Write the buffered fingerprint bytes first
                outputStream.write(op.fingerprint)
                bytesWritten += op.fingerprint.size

                // Copy the rest chunk by chunk
                val buffer = ByteArray(CHUNK_SIZE)

                while (true) {
                    if (op.cancelled) {
                        outputStream.close()
                        op.inputStream.close()
                        java.io.File(destPath).delete()
                        operations.remove(opId)
                        promise.reject("CANCELLED", "Copy was cancelled")
                        return@Thread
                    }

                    val read = op.inputStream.read(buffer)
                    if (read == -1) break

                    digest.update(buffer, 0, read)
                    outputStream.write(buffer, 0, read)
                    bytesWritten += read

                    // Throttled progress events
                    val now = System.currentTimeMillis()
                    if (now - lastProgressTime >= PROGRESS_INTERVAL_MS) {
                        lastProgressTime = now
                        emitProgress(opId, bytesWritten, op.fileSize)
                    }
                }

                outputStream.close()
                op.inputStream.close()
                operations.remove(opId)

                val hashBytes = digest.digest()
                val hashHex = hashBytes.joinToString("") { "%02x".format(it) }

                val result = Arguments.createMap().apply {
                    putString("hash", hashHex)
                    putDouble("bytesWritten", bytesWritten.toDouble())
                }

                promise.resolve(result)

            } catch (e: Exception) {
                try { op.inputStream.close() } catch (_: Exception) {}
                java.io.File(destPath).delete()
                operations.remove(opId)

                // If the stream was closed by cancelCopy, report as cancellation
                if (op.cancelled) {
                    promise.reject("CANCELLED", "Copy was cancelled")
                } else {
                    promise.reject("COPY_FAILED", "commitCopy failed: ${e.message}", e)
                }
            }
        }.start()
    }

    /**
     * Cancel a pending or in-progress operation.
     * If between begin and commit: closes the stream immediately.
     * If commit is running: sets the cancelled flag, the copy loop will stop and clean up.
     */
    @ReactMethod
    fun cancelCopy(opId: String, promise: Promise) {
        val op = operations[opId]

        if (op == null) {
            // Already completed or unknown — nothing to do
            promise.resolve(null)
            return
        }

        // Set the flag — if commitCopy is running, it will see this and abort.
        // If commitCopy hasn't been called yet, we also close the stream and remove it.
        op.cancelled = true

        // Try to close the stream immediately for the pre-commit case.
        // If commitCopy is running, it will handle closing after seeing the flag.
        if (operations.remove(opId) != null) {
            try { op.inputStream.close() } catch (_: Exception) {}
        }

        promise.resolve(null)
    }

    private fun emitProgress(opId: String, bytesWritten: Long, totalBytes: Long) {
        val params = Arguments.createMap().apply {
            putString("opId", opId)
            putDouble("bytesWritten", bytesWritten.toDouble())
            putDouble("totalBytes", totalBytes.toDouble())
        }

        reactApplicationContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(PROGRESS_EVENT, params)
    }

    private fun queryFileSize(uri: Uri): Long? {
        return try {
            reactApplicationContext.contentResolver.query(
                uri, arrayOf(android.provider.OpenableColumns.SIZE), null, null, null
            )?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val sizeIndex = cursor.getColumnIndex(android.provider.OpenableColumns.SIZE)
                    if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) cursor.getLong(sizeIndex) else null
                } else null
            }
        } catch (_: Exception) { null }
    }
}
