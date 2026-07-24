package com.salezica.ivy

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Promise
import java.io.File

/**
 * Dumps a file's metadata in ffmetadata format (raw INI-style text) by
 * exec'ing the bundled libffmpeg.so. Parsing happens in JS
 * (services/audio/ffmetadata.ts), keeping this module pure exec plumbing.
 *
 * Resolves null on any failure — never rejects.
 */
class FFmetadataReaderModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    companion object {
        private const val TAG = "FFmetadataReader"
    }

    override fun getName(): String {
        return "FFmetadataReader"
    }

    @ReactMethod
    fun read(filePath: String, promise: Promise) {
        Thread {
            try {
                android.util.Log.d(TAG, "Reading ffmetadata from: $filePath")

                FFmpegEnvironment.ensureReady(reactApplicationContext)

                val nativeLibDir = reactApplicationContext.applicationInfo.nativeLibraryDir
                val ffmpegPath = File(nativeLibDir, "libffmpeg.so").absolutePath
                val ldLibraryPath = FFmpegEnvironment.ldLibraryPath(reactApplicationContext)

                // ffmetadata is INI-style text: global key=value tags, then
                // [CHAPTER] sections. pipe:1 writes it to stdout.
                val command = listOf(
                    ffmpegPath,
                    "-i", filePath,
                    "-f", "ffmetadata",
                    "-v", "quiet",
                    "pipe:1"
                )

                val process = ProcessBuilder(command)
                    .redirectErrorStream(false)
                    .also { it.environment()["LD_LIBRARY_PATH"] = ldLibraryPath }
                    .start()

                val output = process.inputStream.bufferedReader().readText()
                val stderr = process.errorStream.bufferedReader().readText()
                val exitCode = process.waitFor()

                android.util.Log.d(TAG, "Exit code: $exitCode, output ${output.length} chars")
                if (stderr.isNotEmpty()) {
                    android.util.Log.d(TAG, "Stderr: ${stderr.take(500)}")
                }

                if (exitCode != 0) {
                    android.util.Log.w(TAG, "ffmpeg failed with exit code $exitCode")
                    promise.resolve(null)
                    return@Thread
                }

                promise.resolve(output)

            } catch (e: Exception) {
                android.util.Log.w(TAG, "ffmetadata read failed: ${e.message}", e)
                promise.resolve(null)
            }
        }.start()
    }
}
