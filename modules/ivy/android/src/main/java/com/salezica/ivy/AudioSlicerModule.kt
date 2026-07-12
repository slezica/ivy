package com.salezica.ivy

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Promise
import com.yausername.ffmpeg.FFmpeg
import java.io.File

class AudioSlicerModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String {
        return "AudioSlicer"
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

                // Ensure FFmpeg libs are extracted (idempotent)
                FFmpeg.getInstance().init(reactApplicationContext)

                val nativeLibDir = reactApplicationContext.applicationInfo.nativeLibraryDir
                val ffmpegPath = File(nativeLibDir, "libffmpeg.so").absolutePath

                // Shared libs are spread across extracted package dirs (mirrors YoutubeDL.kt)
                val packagesDir = File(reactApplicationContext.noBackupFilesDir, "youtubedl-android/packages")
                val ldLibraryPath = listOf(
                    "$packagesDir/python/usr/lib",
                    "$packagesDir/ffmpeg/usr/lib",
                    "$packagesDir/aria2c/usr/lib",
                    nativeLibDir
                ).joinToString(":")

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
