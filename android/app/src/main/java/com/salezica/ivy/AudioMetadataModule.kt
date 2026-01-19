package com.salezica.ivy

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.util.Base64
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.bridge.Arguments
import java.io.ByteArrayOutputStream

class AudioMetadataModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String {
        return "AudioMetadataModule"
    }

    @ReactMethod
    fun extractMetadata(filePath: String, promise: Promise) {
        try {
            val retriever = MediaMetadataRetriever()
            retriever.setDataSource(filePath)

            val result: WritableMap = Arguments.createMap()

            // Extract title
            val title = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_TITLE)
            result.putString("title", title)

            // Extract artist (prefer artist, fallback to album artist)
            val artist = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ARTIST)
                ?: retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ALBUMARTIST)
            result.putString("artist", artist)

            // Extract duration (in milliseconds)
            // Try metadata first, fall back to MediaExtractor for m4b and other formats
            val durationStr = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
            var duration = durationStr?.toLongOrNull() ?: 0L

            if (duration == 0L) {
                duration = extractDurationWithMediaExtractor(filePath)
            }
            result.putDouble("duration", duration.toDouble())

            // Extract artwork (embedded album art)
            val artworkBytes = retriever.embeddedPicture
            if (artworkBytes != null) {
                // Decode to bitmap to verify it's valid
                val bitmap = BitmapFactory.decodeByteArray(artworkBytes, 0, artworkBytes.size)
                if (bitmap != null) {
                    // Re-encode to JPEG with compression to reduce size
                    val outputStream = ByteArrayOutputStream()
                    bitmap.compress(Bitmap.CompressFormat.JPEG, 80, outputStream)
                    val compressedBytes = outputStream.toByteArray()

                    // Encode to base64
                    val base64 = Base64.encodeToString(compressedBytes, Base64.NO_WRAP)
                    result.putString("artwork", "data:image/jpeg;base64,$base64")

                    bitmap.recycle()
                } else {
                    result.putString("artwork", null)
                }
            } else {
                result.putString("artwork", null)
            }

            retriever.release()
            promise.resolve(result)
        } catch (e: Exception) {
            promise.reject("METADATA_EXTRACTION_ERROR", "Failed to extract metadata: ${e.message}", e)
        }
    }

    private fun extractDurationWithMediaExtractor(filePath: String): Long {
        val extractor = MediaExtractor()
        try {
            extractor.setDataSource(filePath)

            for (i in 0 until extractor.trackCount) {
                val format = extractor.getTrackFormat(i)
                val mime = format.getString(MediaFormat.KEY_MIME) ?: continue

                if (mime.startsWith("audio/")) {
                    val durationUs = format.getLong(MediaFormat.KEY_DURATION)
                    return durationUs / 1000  // Convert microseconds to milliseconds
                }
            }
            return 0L
        } catch (e: Exception) {
            return 0L
        } finally {
            extractor.release()
        }
    }
}
