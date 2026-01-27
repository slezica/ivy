package com.salezica.ivy

import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Promise
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer

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
        try {
            // Diagnostic logging
            val inputFile = File(inputPath)
            android.util.Log.d("AudioSlicer", "Input file exists: ${inputFile.exists()}")
            android.util.Log.d("AudioSlicer", "Input file size: ${inputFile.length()} bytes")
            android.util.Log.d("AudioSlicer", "Input file canRead: ${inputFile.canRead()}")

            if (inputFile.exists() && inputFile.length() > 0) {
                // Log first 16 bytes to check file format
                val header = inputFile.inputStream().use { it.readNBytes(16) }
                val headerHex = header.joinToString(" ") { "%02X".format(it) }
                android.util.Log.d("AudioSlicer", "Input file header (hex): $headerHex")
            }

            val extractor = MediaExtractor()
            android.util.Log.d("AudioSlicer", "Setting data source: $inputPath")
            extractor.setDataSource(inputPath)

            // Find the audio track
            var audioTrackIndex = -1
            var audioFormat: MediaFormat? = null

            for (i in 0 until extractor.trackCount) {
                val format = extractor.getTrackFormat(i)
                val mime = format.getString(MediaFormat.KEY_MIME)
                if (mime?.startsWith("audio/") == true) {
                    audioTrackIndex = i
                    audioFormat = format
                    break
                }
            }

            if (audioTrackIndex == -1 || audioFormat == null) {
                promise.reject("ERROR", "No audio track found in file")
                extractor.release()
                return
            }

            val mime = audioFormat.getString(MediaFormat.KEY_MIME) ?: ""
            val duration = if (audioFormat.containsKey(MediaFormat.KEY_DURATION)) {
                audioFormat.getLong(MediaFormat.KEY_DURATION)
            } else -1L
            android.util.Log.d("AudioSlicer", "Audio format: mime=$mime, duration=${duration}us (${duration/1000}ms)")

            // For MP3 files, use simple byte copying approach
            if (mime.contains("mp3") || mime.contains("mpeg")) {
                sliceMP3(extractor, audioTrackIndex, startTimeMs, endTimeMs, outputPath, promise)
                return
            }

            // For other formats (AAC, etc.), use MediaMuxer with correct extension
            // MediaMuxer outputs MPEG-4 container, so we need .m4a extension
            val correctedPath = outputPath.replace(Regex("\\.[^.]+$"), ".m4a")
            android.util.Log.d("AudioSlicer", "Using muxer, corrected path: $correctedPath")
            sliceWithMuxer(extractor, audioTrackIndex, audioFormat, startTimeMs, endTimeMs, correctedPath, promise)

        } catch (e: Exception) {
            android.util.Log.e("AudioSlicer", "Slice failed", e)
            android.util.Log.e("AudioSlicer", "Exception type: ${e.javaClass.name}")
            android.util.Log.e("AudioSlicer", "Exception message: ${e.message}")
            e.cause?.let {
                android.util.Log.e("AudioSlicer", "Cause: ${it.javaClass.name}: ${it.message}")
            }
            promise.reject("ERROR", "Slice failed: ${e.message}", e)
        }
    }

    private fun sliceMP3(
        extractor: MediaExtractor,
        trackIndex: Int,
        startTimeMs: Double,
        endTimeMs: Double,
        outputPath: String,
        promise: Promise
    ) {
        try {
            extractor.selectTrack(trackIndex)

            val startTimeUs = (startTimeMs * 1000).toLong()
            val endTimeUs = (endTimeMs * 1000).toLong()
            extractor.seekTo(startTimeUs, MediaExtractor.SEEK_TO_CLOSEST_SYNC)

            // Create output file
            val outputFile = File(outputPath)
            outputFile.parentFile?.mkdirs()

            FileOutputStream(outputFile).use { outputStream ->
                val buffer = ByteBuffer.allocate(256 * 1024) // 256KB buffer
                var bytesWritten = 0

                while (true) {
                    val sampleTime = extractor.sampleTime

                    // sampleTime == -1 means no more samples (small negative values are valid encoder delay)
                    if (sampleTime == -1L || sampleTime > endTimeUs) {
                        break
                    }

                    buffer.clear()
                    val sampleSize = extractor.readSampleData(buffer, 0)

                    if (sampleSize < 0) {
                        break
                    }

                    // Write to output file
                    val byteArray = ByteArray(sampleSize)
                    buffer.get(byteArray)
                    outputStream.write(byteArray)
                    bytesWritten += sampleSize

                    extractor.advance()
                }

                if (bytesWritten == 0) {
                    promise.reject("ERROR", "No data written - check time range")
                    extractor.release()
                    outputFile.delete()
                    return
                }
            }

            extractor.release()
            promise.resolve(outputPath)

        } catch (e: Exception) {
            extractor.release()
            promise.reject("ERROR", "MP3 slice failed: ${e.message}", e)
        }
    }

    private fun sliceWithMuxer(
        extractor: MediaExtractor,
        trackIndex: Int,
        audioFormat: MediaFormat,
        startTimeMs: Double,
        endTimeMs: Double,
        outputPath: String,
        promise: Promise
    ) {
        try {
            extractor.selectTrack(trackIndex)

            val startTimeUs = (startTimeMs * 1000).toLong()
            val endTimeUs = (endTimeMs * 1000).toLong()

            android.util.Log.d("AudioSlicer", "sliceWithMuxer: startTimeUs=$startTimeUs, endTimeUs=$endTimeUs")

            // Check first sample time before seeking
            val firstSampleTime = extractor.sampleTime
            android.util.Log.d("AudioSlicer", "First sample time before seek: $firstSampleTime us")

            extractor.seekTo(startTimeUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC)

            val afterSeekTime = extractor.sampleTime
            android.util.Log.d("AudioSlicer", "Sample time after seek to $startTimeUs: $afterSeekTime us")

            // Create output file
            val outputFile = File(outputPath)
            outputFile.parentFile?.mkdirs()

            // Create muxer (AAC works with MPEG_4)
            val muxer = MediaMuxer(outputPath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
            val muxerTrackIndex = muxer.addTrack(audioFormat)
            muxer.start()

            // Buffer for reading samples
            val bufferInfo = android.media.MediaCodec.BufferInfo()
            val buffer = ByteBuffer.allocate(1024 * 1024) // 1MB buffer

            var samplesWritten = 0

            var loopCount = 0
            while (true) {
                val sampleTime = extractor.sampleTime

                if (loopCount < 3) {
                    android.util.Log.d("AudioSlicer", "Loop $loopCount: sampleTime=$sampleTime us, endTimeUs=$endTimeUs")
                }
                loopCount++

                // Note: sampleTime == -1 means no more samples
                // Small negative values (e.g., -27709us) are valid AAC encoder delay, not end-of-stream
                if (sampleTime == -1L || sampleTime > endTimeUs) {
                    android.util.Log.d("AudioSlicer", "Breaking loop: sampleTime=$sampleTime, endTimeUs=$endTimeUs, reason=${if (sampleTime == -1L) "end of stream" else "exceeded end"}")
                    break
                }

                buffer.clear()
                val sampleSize = extractor.readSampleData(buffer, 0)

                if (sampleSize < 0) {
                    break
                }

                bufferInfo.presentationTimeUs = sampleTime - startTimeUs
                bufferInfo.size = sampleSize
                bufferInfo.flags = extractor.sampleFlags
                bufferInfo.offset = 0

                muxer.writeSampleData(muxerTrackIndex, buffer, bufferInfo)
                samplesWritten++

                extractor.advance()
            }

            muxer.stop()
            muxer.release()
            extractor.release()

            android.util.Log.d("AudioSlicer", "Muxer finished: samplesWritten=$samplesWritten, loopCount=$loopCount")

            if (samplesWritten == 0) {
                promise.reject("ERROR", "No samples written - check time range")
                outputFile.delete()
                return
            }

            promise.resolve(outputPath)

        } catch (e: Exception) {
            extractor.release()
            promise.reject("ERROR", "Muxer slice failed: ${e.message}", e)
        }
    }
}
