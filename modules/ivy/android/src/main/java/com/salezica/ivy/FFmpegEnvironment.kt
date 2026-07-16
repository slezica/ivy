package com.salezica.ivy

import android.content.Context
import android.system.Os
import java.io.File

/**
 * Builds the LD_LIBRARY_PATH for exec'ing the bundled libffmpeg.so.
 *
 * The ffmpeg package's shared libs need four sonames it doesn't ship
 * (libexpat.so.1, libcrypto.so.3, libandroid-support.so,
 * libandroid-posix-semaphore.so). Upstream youtubedl-android gets them from
 * the yt-dlp python package, which we removed (docs/2026-06-30-remove-ytdlp.md),
 * so we vendor them in this module's jniLibs — extracted to nativeLibraryDir
 * at install time. The two versioned sonames can't be packaged under their
 * real names (jniLibs must match lib*.so), so they ship as libexpat_1.so /
 * libcrypto_3.so and are symlinked under their sonames in an app-owned dir.
 */
object FFmpegEnvironment {

    // soname the dynamic linker looks up → jniLib filename in nativeLibraryDir
    private val SYMLINKED_LIBS = mapOf(
        "libexpat.so.1" to "libexpat_1.so",
        "libcrypto.so.3" to "libcrypto_3.so",
    )

    @Volatile
    private var prepared = false

    fun ldLibraryPath(context: Context): String {
        val nativeLibDir = context.applicationInfo.nativeLibraryDir
        val linkDir = File(context.noBackupFilesDir, "ivy-native/lib")
        ensureSymlinks(linkDir, nativeLibDir)
        val packagesDir = File(context.noBackupFilesDir, "youtubedl-android/packages")
        return listOf(
            linkDir.absolutePath,
            "$packagesDir/ffmpeg/usr/lib",
            nativeLibDir
        ).joinToString(":")
    }

    @Synchronized
    private fun ensureSymlinks(linkDir: File, nativeLibDir: String) {
        if (prepared) return
        linkDir.mkdirs()
        for ((soname, jniLibName) in SYMLINKED_LIBS) {
            val target = File(nativeLibDir, jniLibName)
            if (!target.exists()) {
                throw IllegalStateException("Vendored lib missing: $target")
            }
            // nativeLibraryDir changes on every app update — always relink
            val link = File(linkDir, soname)
            link.delete()
            Os.symlink(target.absolutePath, link.absolutePath)
        }
        prepared = true
    }
}
