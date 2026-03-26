package com.salezica.ivy

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableArray
import com.yausername.ffmpeg.FFmpeg
import java.io.File

class ChapterReaderModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    companion object {
        private const val TAG = "ChapterReader"
    }

    override fun getName(): String {
        return "ChapterReader"
    }

    @ReactMethod
    fun readChapters(filePath: String, promise: Promise) {
        Thread {
            try {
                android.util.Log.d(TAG, "Reading chapters from: $filePath")

                FFmpeg.getInstance().init(reactApplicationContext)

                val nativeLibDir = reactApplicationContext.applicationInfo.nativeLibraryDir
                val ffmpegPath = File(nativeLibDir, "libffmpeg.so").absolutePath

                val packagesDir = File(reactApplicationContext.noBackupFilesDir, "youtubedl-android/packages")
                val ldLibraryPath = listOf(
                    "$packagesDir/python/usr/lib",
                    "$packagesDir/ffmpeg/usr/lib",
                    "$packagesDir/aria2c/usr/lib",
                    nativeLibDir
                ).joinToString(":")

                // Use ffmpeg to extract metadata in ffmetadata format.
                // This outputs INI-style text with [CHAPTER] sections.
                // We use pipe:1 to write to stdout instead of a file.
                val command = listOf(
                    ffmpegPath,
                    "-i", filePath,
                    "-f", "ffmetadata",
                    "-v", "quiet",
                    "pipe:1"
                )

                android.util.Log.d(TAG, "Command: ${command.joinToString(" ")}")

                val process = ProcessBuilder(command)
                    .redirectErrorStream(false)
                    .also { it.environment()["LD_LIBRARY_PATH"] = ldLibraryPath }
                    .start()

                val output = process.inputStream.bufferedReader().readText()
                val stderr = process.errorStream.bufferedReader().readText()
                val exitCode = process.waitFor()

                android.util.Log.d(TAG, "Exit code: $exitCode")
                android.util.Log.d(TAG, "Output (${output.length} chars): ${output.take(500)}")
                if (stderr.isNotEmpty()) {
                    android.util.Log.d(TAG, "Stderr: ${stderr.take(500)}")
                }

                if (exitCode != 0) {
                    android.util.Log.w(TAG, "ffmpeg failed with exit code $exitCode")
                    promise.resolve(Arguments.createArray())
                    return@Thread
                }

                val chapters = parseFFmetadata(output)
                android.util.Log.d(TAG, "Parsed ${chapters.size()} chapters")
                promise.resolve(chapters)

            } catch (e: Exception) {
                android.util.Log.w(TAG, "Chapter extraction failed: ${e.message}", e)
                promise.resolve(Arguments.createArray())
            }
        }.start()
    }

    /**
     * Parse ffmetadata format. Chapter sections look like:
     *
     * [CHAPTER]
     * TIMEBASE=1/1000
     * START=0
     * END=1234567
     * title=Chapter One
     */
    private fun parseFFmetadata(text: String): WritableArray {
        val result = Arguments.createArray()
        val sections = text.split("[CHAPTER]").drop(1) // Split and drop the header before first [CHAPTER]

        for (section in sections) {
            val fields = mutableMapOf<String, String>()
            for (line in section.lines()) {
                val eq = line.indexOf('=')
                if (eq > 0) {
                    val key = line.substring(0, eq).trim()
                    val value = line.substring(eq + 1).trim()
                    fields[key] = value
                }
            }

            val timebase = parseTimebase(fields["TIMEBASE"])
            val start = fields["START"]?.toLongOrNull() ?: continue
            val end = fields["END"]?.toLongOrNull() ?: continue
            val title = fields["title"]

            val startMs = (start.toDouble() * timebase * 1000.0)
            val endMs = (end.toDouble() * timebase * 1000.0)

            val entry = Arguments.createMap()
            entry.putString("title", title)
            entry.putDouble("start_ms", startMs)
            entry.putDouble("end_ms", endMs)

            result.pushMap(entry)
        }

        return result
    }

    /** Parse TIMEBASE=num/den into a multiplier (seconds per unit). Defaults to 1/1000. */
    private fun parseTimebase(value: String?): Double {
        if (value == null) return 0.001 // default 1/1000
        val parts = value.split("/")
        if (parts.size != 2) return 0.001
        val num = parts[0].toLongOrNull() ?: return 0.001
        val den = parts[1].toLongOrNull() ?: return 0.001
        if (den == 0L) return 0.001
        return num.toDouble() / den.toDouble()
    }
}
