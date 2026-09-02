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

    companion object {
        // Cap for stored artwork: covers are decorative thumbnails in the UI, and
        // oversized base64 data URIs (DB + store + bridge) can OOM the Java heap
        const val MAX_ARTWORK_DIMENSION = 512
    }

    override fun getName(): String {
        return "AudioMetadataModule"
    }

    @ReactMethod
    fun extractMetadata(filePath: String, promise: Promise) {
        val retriever = MediaMetadataRetriever()
        try {
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

            // Extract artwork (embedded album art), capped at MAX_ARTWORK_DIMENSION
            val artworkBytes = retriever.embeddedPicture
            result.putString("artwork", artworkBytes?.let { encodeArtwork(it) })

            promise.resolve(result)
        } catch (e: Exception) {
            promise.reject("METADATA_EXTRACTION_ERROR", "Failed to extract metadata: ${e.message}", e)
        } finally {
            retriever.release()
        }
    }

    /**
     * Re-encode an oversized stored artwork data URI down to MAX_ARTWORK_DIMENSION.
     * Resolves the downscaled data URI, or null if the input can't be decoded.
     */
    @ReactMethod
    fun downscaleArtwork(dataUri: String, promise: Promise) {
        try {
            val base64 = dataUri.substringAfter(",", "")
            val bytes = Base64.decode(base64, Base64.DEFAULT)
            promise.resolve(encodeArtwork(bytes))
        } catch (e: Exception) {
            promise.reject("ARTWORK_DOWNSCALE_ERROR", "Failed to downscale artwork: ${e.message}", e)
        }
    }

    /**
     * Decode image bytes, downscale to at most MAX_ARTWORK_DIMENSION on the long
     * side, and re-encode as a JPEG data URI. Returns null on undecodable input.
     */
    private fun encodeArtwork(imageBytes: ByteArray): String? {
        // Bounds-only decode to compute a power-of-two sample size, so huge
        // covers never materialize at full resolution
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(imageBytes, 0, imageBytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null

        val options = BitmapFactory.Options().apply {
            inSampleSize = 1
            while (maxOf(bounds.outWidth, bounds.outHeight) / (inSampleSize * 2) >= MAX_ARTWORK_DIMENSION) {
                inSampleSize *= 2
            }
        }
        val decoded = BitmapFactory.decodeByteArray(imageBytes, 0, imageBytes.size, options) ?: return null

        // Sampling lands within [MAX, 2*MAX) — scale down to the exact cap
        val bitmap = if (maxOf(decoded.width, decoded.height) > MAX_ARTWORK_DIMENSION) {
            val scale = MAX_ARTWORK_DIMENSION.toFloat() / maxOf(decoded.width, decoded.height)
            val scaled = Bitmap.createScaledBitmap(
                decoded,
                maxOf(1, (decoded.width * scale).toInt()),
                maxOf(1, (decoded.height * scale).toInt()),
                true
            )
            decoded.recycle()
            scaled
        } else {
            decoded
        }

        val outputStream = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.JPEG, 80, outputStream)
        bitmap.recycle()

        val base64 = Base64.encodeToString(outputStream.toByteArray(), Base64.NO_WRAP)
        return "data:image/jpeg;base64,$base64"
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
