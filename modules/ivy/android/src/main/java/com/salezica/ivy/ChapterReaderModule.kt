package com.salezica.ivy

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableArray
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

                FFmpegEnvironment.ensureReady(reactApplicationContext)

                val nativeLibDir = reactApplicationContext.applicationInfo.nativeLibraryDir
                val ffmpegPath = File(nativeLibDir, "libffmpeg.so").absolutePath
                val ldLibraryPath = FFmpegEnvironment.ldLibraryPath(reactApplicationContext)

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
            val lines = section.lines()
            var i = 0
            while (i < lines.size) {
                val line = lines[i]
                val eq = line.indexOf('=')
                if (eq > 0) {
                    val key = line.substring(0, eq).trim()
                    var value = line.substring(eq + 1)
                    // A trailing unescaped backslash escapes the newline:
                    // the value continues on the next line.
                    while (endsInLoneBackslash(value) && i + 1 < lines.size) {
                        i++
                        value = value.dropLast(1) + "\n" + lines[i]
                    }
                    fields[key] = unescapeValue(value.trim())
                }
                i++
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

    /** True if the string ends in an odd number of backslashes (i.e. a lone, unescaped one). */
    private fun endsInLoneBackslash(value: String): Boolean {
        var count = 0
        var i = value.length - 1
        while (i >= 0 && value[i] == '\\') {
            count++
            i--
        }
        return count % 2 == 1
    }

    /**
     * Unescape ffmetadata backslash sequences (\\, \=, \;, \# — a backslash
     * escapes whatever character follows it). A trailing lone backslash is dropped.
     */
    private fun unescapeValue(raw: String): String {
        val sb = StringBuilder(raw.length)
        var i = 0
        while (i < raw.length) {
            val c = raw[i]
            if (c == '\\' && i + 1 < raw.length) {
                sb.append(raw[i + 1])
                i += 2
            } else if (c == '\\') {
                i++ // trailing lone backslash — drop it
            } else {
                sb.append(c)
                i++
            }
        }
        return sb.toString()
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
