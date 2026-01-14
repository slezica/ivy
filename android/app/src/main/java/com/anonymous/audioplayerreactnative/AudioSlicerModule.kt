package com.anonymous.audioplayerreactnative

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
            val extractor = MediaExtractor()
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

            // For MP3 files, use simple byte copying approach
            if (mime.contains("mp3") || mime.contains("mpeg")) {
                sliceMP3(extractor, audioTrackIndex, startTimeMs, endTimeMs, outputPath, promise)
                return
            }

            // For other formats (AAC, etc.), use MediaMuxer
            sliceWithMuxer(extractor, audioTrackIndex, audioFormat, startTimeMs, endTimeMs, outputPath, promise)

        } catch (e: Exception) {
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

                    if (sampleTime < 0 || sampleTime > endTimeUs) {
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
            extractor.seekTo(startTimeUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC)

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

            while (true) {
                val sampleTime = extractor.sampleTime

                if (sampleTime > endTimeUs || sampleTime < 0) {
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
