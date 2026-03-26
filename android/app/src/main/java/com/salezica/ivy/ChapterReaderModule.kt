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

    override fun getName(): String {
        return "ChapterReader"
    }

    @ReactMethod
    fun readChapters(filePath: String, promise: Promise) {
        Thread {
            try {
                FFmpeg.getInstance().init(reactApplicationContext)

                val nativeLibDir = reactApplicationContext.applicationInfo.nativeLibraryDir
                val ffprobePath = File(nativeLibDir, "libffmpeg.so").absolutePath

                val packagesDir = File(reactApplicationContext.noBackupFilesDir, "youtubedl-android/packages")
                val ldLibraryPath = listOf(
                    "$packagesDir/python/usr/lib",
                    "$packagesDir/ffmpeg/usr/lib",
                    "$packagesDir/aria2c/usr/lib",
                    nativeLibDir
                ).joinToString(":")

                val command = listOf(
                    ffprobePath,
                    "-v", "quiet",
                    "-print_format", "json",
                    "-show_chapters",
                    filePath
                )

                val process = ProcessBuilder(command)
                    .redirectErrorStream(false)
                    .also { it.environment()["LD_LIBRARY_PATH"] = ldLibraryPath }
                    .start()

                val output = process.inputStream.bufferedReader().readText()
                val exitCode = process.waitFor()

                if (exitCode != 0) {
                    promise.resolve(Arguments.createArray())
                    return@Thread
                }

                val chapters = parseChapters(output)
                promise.resolve(chapters)

            } catch (e: Exception) {
                android.util.Log.w("ChapterReader", "Chapter extraction failed: ${e.message}")
                promise.resolve(Arguments.createArray())
            }
        }.start()
    }

    private fun parseChapters(json: String): WritableArray {
        val result = Arguments.createArray()

        try {
            val root = org.json.JSONObject(json)
            val chapters = root.optJSONArray("chapters") ?: return result

            for (i in 0 until chapters.length()) {
                val chapter = chapters.getJSONObject(i)
                val tags = chapter.optJSONObject("tags")
                val title = tags?.optString("title", null)

                // ffprobe reports times in seconds as strings
                val startTime = chapter.optString("start_time", "0").toDoubleOrNull() ?: 0.0
                val endTime = chapter.optString("end_time", "0").toDoubleOrNull() ?: 0.0

                val entry = Arguments.createMap()
                entry.putString("title", title)
                entry.putDouble("start_ms", startTime * 1000.0)
                entry.putDouble("end_ms", endTime * 1000.0)

                result.pushMap(entry)
            }
        } catch (e: Exception) {
            android.util.Log.w("ChapterReader", "Failed to parse ffprobe output: ${e.message}")
        }

        return result
    }
}
