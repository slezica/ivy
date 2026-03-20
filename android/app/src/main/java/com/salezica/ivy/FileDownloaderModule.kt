package com.salezica.ivy

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.yausername.youtubedl_android.YoutubeDL
import com.yausername.youtubedl_android.YoutubeDL.UpdateChannel
import com.yausername.youtubedl_android.YoutubeDLRequest
import com.yausername.ffmpeg.FFmpeg
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicBoolean

private const val PROGRESS_EVENT = "FileDownloaderProgress"

class FileDownloaderModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    private var processId = 0L

    // Init yt-dlp lazily, blocking until ready
    private val initLatch = CountDownLatch(1)
    private val initStarted = AtomicBoolean(false)

    override fun getName(): String = "FileDownloader"

    // Required for NativeEventEmitter
    @ReactMethod
    fun addListener(eventName: String) {}

    @ReactMethod
    fun removeListeners(count: Int) {}

    private fun ensureInitialized() {
        if (initStarted.compareAndSet(false, true)) {
            try {
                YoutubeDL.getInstance().init(reactApplicationContext)
                FFmpeg.getInstance().init(reactApplicationContext)
            } catch (e: Exception) {
                android.util.Log.e("FileDownloader", "Failed to initialize yt-dlp", e)
            } finally {
                initLatch.countDown()
            }
        } else {
            initLatch.await()
        }
    }

    /**
     * Download audio from URL using yt-dlp.
     *
     * - Extracts audio as m4a (no transcode for YouTube sources)
     * - Emits progress events with { opId, percent }
     * - Resolves with { filePath } on success
     * - Rejects with CANCELLED if cancelled via cancelDownload()
     */
    @ReactMethod
    fun download(opId: String, url: String, outputDir: String, promise: Promise) {
        val currentProcessId = synchronized(this) { "ivy-dl-${processId++}" }

        Thread {
            try {
                ensureInitialized()
                val request = YoutubeDLRequest(url).apply {
                    addOption("-o", "$outputDir/%(title).200B.%(ext)s")
                    addOption("-x")
                    addOption("--audio-format", "m4a")
                    addOption("--embed-thumbnail")
                    addOption("--no-mtime")
                    addOption("--no-update")
                }

                val response = YoutubeDL.getInstance().execute(
                    request,
                    currentProcessId,
                ) { progress, _, _ ->
                    emitProgress(opId, progress)
                }

                // Find the output file — yt-dlp prints it in stdout
                val filePath = parseOutputPath(response.out, outputDir)

                if (filePath != null) {
                    val result = Arguments.createMap().apply {
                        putString("filePath", filePath)
                    }
                    promise.resolve(result)
                } else {
                    promise.reject("NO_OUTPUT", "Download completed but output file not found.\nstdout: ${response.out}\nstderr: ${response.err}")
                }
            } catch (e: Exception) {
                if (e.message?.contains("destroy", ignoreCase = true) == true) {
                    promise.reject("CANCELLED", "Download was cancelled")
                } else {
                    promise.reject("DOWNLOAD_FAILED", "Download failed: ${e.message}", e)
                }
            }
        }.start()
    }

    @ReactMethod
    fun cancelDownload(promise: Promise) {
        try {
            // Destroy all processes we may have started
            val id = synchronized(this) { "ivy-dl-${processId - 1}" }
            YoutubeDL.getInstance().destroyProcessById(id)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.resolve(null) // Best-effort
        }
    }

    @ReactMethod
    fun update(promise: Promise) {
        Thread {
            try {
                ensureInitialized()
                val status = YoutubeDL.getInstance().updateYoutubeDL(
                    reactApplicationContext,
                    UpdateChannel.STABLE,
                )

                promise.resolve(status?.name ?: "DONE")
            } catch (e: Exception) {
                promise.reject("UPDATE_FAILED", "yt-dlp update failed: ${e.message}", e)
            }
        }.start()
    }

    @ReactMethod
    fun version(promise: Promise) {
        Thread {
            try {
                ensureInitialized()
                val versionInfo = YoutubeDL.getInstance().version(reactApplicationContext)
                promise.resolve(versionInfo ?: "unknown")
            } catch (e: Exception) {
                promise.resolve("unknown")
            }
        }.start()
    }

    private fun emitProgress(opId: String, percent: Float) {
        val params = Arguments.createMap().apply {
            putString("opId", opId)
            putDouble("percent", percent.toDouble())
        }

        reactApplicationContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(PROGRESS_EVENT, params)
    }

    /**
     * Parse yt-dlp stdout for the output file path.
     * yt-dlp prints lines like:
     *   [ExtractAudio] Destination: /path/to/file.m4a
     *   [download] /path/to/file.m4a has already been downloaded
     */
    private fun parseOutputPath(stdout: String, outputDir: String): String? {
        // Look for [ExtractAudio] Destination: lines first (audio extraction)
        val extractPattern = Regex("""\[ExtractAudio\] Destination:\s*(.+)""")
        extractPattern.find(stdout)?.let { return it.groupValues[1].trim() }

        // Look for Destination: lines (generic)
        val destPattern = Regex("""\[download\] Destination:\s*(.+)""")

        // Fall back: find any file in outputDir matching common patterns
        val mergePattern = Regex("""\[Merger\] Merging formats into "(.+)"""")
        mergePattern.find(stdout)?.let { return it.groupValues[1].trim() }

        // Check for already downloaded
        val alreadyPattern = Regex("""\[download\]\s*(.+)\s+has already been downloaded""")
        alreadyPattern.find(stdout)?.let { return it.groupValues[1].trim() }

        destPattern.find(stdout)?.let { return it.groupValues[1].trim() }

        // Last resort: scan outputDir for newest file
        val dir = java.io.File(outputDir)
        return dir.listFiles()
            ?.filter { it.isFile && it.extension in listOf("m4a", "mp3", "opus", "webm", "mp4") }
            ?.maxByOrNull { it.lastModified() }
            ?.absolutePath
    }
}
