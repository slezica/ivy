package com.yausername.youtubedl_android

/**
 * Shim for the youtubedl-android `:library` exception class.
 *
 * We depend only on the `:ffmpeg` artifact (for clip slicing and chapter extraction),
 * not the yt-dlp `:library` engine. However, `:ffmpeg`'s `FFmpeg.init()` can throw
 * `com.yausername.youtubedl_android.YoutubeDLException`, a class that lives in `:library`
 * and is declared `compileOnly` there — so it is absent from the published `:ffmpeg` POM.
 *
 * Without this class on the runtime classpath, `FFmpeg.init()`'s error path would raise a
 * `NoClassDefFoundError`. This mirrors the upstream class exactly (same package, name, and
 * constructors) so the compiled `:ffmpeg` AAR resolves it. Do not remove while `:ffmpeg`
 * is a dependency and `:library` is not.
 */
class YoutubeDLException : Exception {
    constructor(message: String?) : super(message)
    constructor(message: String?, e: Throwable?) : super(message, e)
    constructor(e: Throwable?) : super(e)
}
