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
 * Holds the state of a copy operation across its lifecycle:
 * createOperation → beginCopy → commitCopy/cancelCopy
 */
private class CopyOperation {
    @Volatile var cancelled = false

    // Populated by beginCopy
    var inputStream: InputStream? = null
    var fileSize: Long = -1L
    var fingerprint: ByteArray = ByteArray(0)
}

class FileCopierModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    private val operations = ConcurrentHashMap<String, CopyOperation>()
    private var nextOpId = 0L

    override fun getName(): String = "FileCopier"

    /**
     * Allocate an operation ID. The operation can be cancelled from this point forward.
     * Returns the opId as a string.
     */
    @ReactMethod(isBlockingSynchronousMethod = true)
    fun createOperation(): String {
        val opId = synchronized(this) { (nextOpId++).toString() }
        operations[opId] = CopyOperation()
        return opId
    }

    /**
     * Open the source and read the fingerprint. No output file is created.
     * If the operation was cancelled before this completes, rejects with CANCELLED.
     *
     * Returns: { fileSize, fingerprint (base64) }
     */
    @ReactMethod
    fun beginCopy(opId: String, sourceUri: String, promise: Promise) {
        Thread {
            val op = operations[opId]
            if (op == null) {
                promise.reject("UNKNOWN_OP", "No operation found with ID: $opId")
                return@Thread
            }

            try {
                // Check if already cancelled before doing any work
                if (op.cancelled) {
                    operations.remove(opId)
                    promise.reject("CANCELLED", "Copy was cancelled")
                    return@Thread
                }

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

                // Check again after the potentially slow stream open/read
                if (op.cancelled) {
                    inputStream.close()
                    operations.remove(opId)
                    promise.reject("CANCELLED", "Copy was cancelled")
                    return@Thread
                }

                // Populate the operation
                op.inputStream = inputStream
                op.fileSize = fileSize
                op.fingerprint = actualFingerprint

                val result = Arguments.createMap().apply {
                    putDouble("fileSize", fileSize.toDouble())
                    putString("fingerprint", Base64.encodeToString(actualFingerprint, Base64.NO_WRAP))
                }

                promise.resolve(result)

            } catch (e: Exception) {
                operations.remove(opId)
                if (op.cancelled) {
                    promise.reject("CANCELLED", "Copy was cancelled")
                } else {
                    promise.reject("BEGIN_FAILED", "beginCopy failed: ${e.message}", e)
                }
            }
        }.start()
    }

    /**
     * Copy the file to destPath, computing SHA-256 incrementally.
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

            val inputStream = op.inputStream
            if (inputStream == null) {
                promise.reject("NOT_READY", "beginCopy has not completed for operation: $opId")
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
                        inputStream.close()
                        java.io.File(destPath).delete()
                        operations.remove(opId)
                        promise.reject("CANCELLED", "Copy was cancelled")
                        return@Thread
                    }

                    val read = inputStream.read(buffer)
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
                inputStream.close()
                operations.remove(opId)

                val hashBytes = digest.digest()
                val hashHex = hashBytes.joinToString("") { "%02x".format(it) }

                val result = Arguments.createMap().apply {
                    putString("hash", hashHex)
                    putDouble("bytesWritten", bytesWritten.toDouble())
                }

                promise.resolve(result)

            } catch (e: Exception) {
                try { inputStream.close() } catch (_: Exception) {}
                java.io.File(destPath).delete()
                operations.remove(opId)

                if (op.cancelled) {
                    promise.reject("CANCELLED", "Copy was cancelled")
                } else {
                    promise.reject("COPY_FAILED", "commitCopy failed: ${e.message}", e)
                }
            }
        }.start()
    }

    /**
     * Cancel an operation at any stage of its lifecycle.
     * - Before beginCopy: marks cancelled, beginCopy will bail out.
     * - During beginCopy: marks cancelled, beginCopy checks after stream open.
     * - Between begin and commit: closes the stream.
     * - During commitCopy: sets flag, copy loop stops and cleans up.
     */
    @ReactMethod
    fun cancelCopy(opId: String, promise: Promise) {
        val op = operations[opId]

        if (op == null) {
            promise.resolve(null)
            return
        }

        op.cancelled = true

        // For the pre-commit case: close stream and remove if we can.
        // During commitCopy, the copy loop handles cleanup after seeing the flag.
        val stream = op.inputStream
        if (stream != null && operations.remove(opId) != null) {
            try { stream.close() } catch (_: Exception) {}
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
