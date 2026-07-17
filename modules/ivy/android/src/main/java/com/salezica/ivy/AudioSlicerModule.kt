package com.salezica.ivy

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Promise
import java.io.File

class AudioSlicerModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String {
        return "AudioSlicer"
    }

    /**
     * Warm the FFmpeg runtime (unpack + cold-link) off the UI thread, so the
     * first real slice or chapter read doesn't pay that one-time cost. Called
     * fire-and-forget at app startup; safe to race with real slices — they
     * funnel through the same idempotent FFmpegEnvironment.ensureReady().
     */
    @ReactMethod
    fun warmUp(promise: Promise) {
        Thread {
            try {
                FFmpegEnvironment.ensureReady(reactApplicationContext)
            } catch (e: Exception) {
                android.util.Log.w("AudioSlicer", "warmUp failed (non-fatal): ${e.message}")
            }
            promise.resolve(null)
        }.start()
    }

    @ReactMethod
    fun sliceAudio(
        inputPath: String,
        startTimeMs: Double,
        endTimeMs: Double,
        outputPath: String,
        promise: Promise
    ) {
        Thread {
            try {
                val inputFile = File(inputPath)
                if (!inputFile.exists() || !inputFile.canRead()) {
                    promise.reject("ERROR", "Input file not found or not readable: $inputPath")
                    return@Thread
                }

                val outputFile = File("$outputPath.m4a")
                outputFile.parentFile?.mkdirs()

                // Unpack + warm FFmpeg (idempotent; shared with chapter reader + startup warm-up)
                FFmpegEnvironment.ensureReady(reactApplicationContext)

                val nativeLibDir = reactApplicationContext.applicationInfo.nativeLibraryDir
                val ffmpegPath = File(nativeLibDir, "libffmpeg.so").absolutePath
                val ldLibraryPath = FFmpegEnvironment.ldLibraryPath(reactApplicationContext)

                val startSec = startTimeMs / 1000.0
                val durationSec = (endTimeMs - startTimeMs) / 1000.0

                val command = listOf(
                    ffmpegPath,
                    "-y",
                    "-ss", startSec.toString(),
                    "-i", inputPath,
                    "-t", durationSec.toString(),
                    "-map", "0:a:0",
                    "-c:a", "aac",
                    outputFile.absolutePath
                )

                android.util.Log.d("AudioSlicer", "Running: ${command.joinToString(" ")}")

                val process = ProcessBuilder(command)
                    .redirectErrorStream(true)
                    .also { it.environment()["LD_LIBRARY_PATH"] = ldLibraryPath }
                    .start()

                val output = process.inputStream.bufferedReader().readText()
                val exitCode = process.waitFor()

                if (exitCode != 0) {
                    android.util.Log.e("AudioSlicer", "FFmpeg failed (exit $exitCode): $output")
                    outputFile.delete()
                    promise.reject("ERROR", "FFmpeg slice failed (exit $exitCode): $output")
                    return@Thread
                }

                if (!outputFile.exists() || outputFile.length() == 0L) {
                    android.util.Log.e("AudioSlicer", "FFmpeg produced no output")
                    outputFile.delete()
                    promise.reject("ERROR", "FFmpeg produced no output file")
                    return@Thread
                }

                android.util.Log.d("AudioSlicer", "Slice complete: ${outputFile.absolutePath} (${outputFile.length()} bytes)")
                promise.resolve(outputFile.absolutePath)

            } catch (e: Exception) {
                android.util.Log.e("AudioSlicer", "Slice failed", e)
                promise.reject("ERROR", "Slice failed: ${e.message}", e)
            }
        }.start()
    }
}
