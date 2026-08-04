package com.salezica.ivy

import android.content.Context
import android.system.Os
import android.util.Log
import java.io.File
import java.util.zip.ZipInputStream

/**
 * Prepares and describes the runtime for exec'ing the bundled libffmpeg.so.
 *
 * The ffmpeg binary and its shared-lib bundle are vendored in this module's
 * jniLibs (arm64-v8a only): libffmpeg.so is the exec'd binary, libffmpeg.zip.so
 * is a ~34MB zip of its shared-lib closure (a termux-packages ffmpeg build),
 * extracted to no_backup/ivy-native/ffmpeg on first use and re-extracted when
 * the bundled zip changes (see docs/2026-08-04-vendor-ffmpeg.md).
 *
 * The bundle also needs four sonames it doesn't ship (libexpat.so.1,
 * libcrypto.so.3, libandroid-support.so, libandroid-posix-semaphore.so),
 * vendored alongside it in jniLibs — extracted to nativeLibraryDir at install
 * time. The two versioned sonames can't be packaged under their real names
 * (jniLibs must match lib*.so), so they ship as libexpat_1.so / libcrypto_3.so
 * and are symlinked under their sonames in an app-owned dir.
 */
object FFmpegEnvironment {

    // Anything larger is a real file, not a stored symlink target path
    private const val MAX_SYMLINK_BYTES = 200L

    // soname the dynamic linker looks up → jniLib filename in nativeLibraryDir
    private val SYMLINKED_LIBS = mapOf(
        "libexpat.so.1" to "libexpat_1.so",
        "libcrypto.so.3" to "libcrypto_3.so",
    )

    @Volatile
    private var prepared = false

    @Volatile
    private var ready = false

    /**
     * Idempotent, thread-safe one-time preparation of the FFmpeg runtime:
     * unpack the ~34MB library bundle and pay the first-exec cold-link cost
     * with a throwaway `-version` run, so the first real slice or chapter
     * read is fast. The slicer, chapter reader, and the app-startup warm-up
     * all funnel through here, so the unpack never races or duplicates
     * across callers.
     */
    @Synchronized
    fun ensureReady(context: Context) {
        if (ready) return
        ensureExtracted(context)
        try {
            val ffmpeg = File(context.applicationInfo.nativeLibraryDir, "libffmpeg.so").absolutePath
            val process = ProcessBuilder(ffmpeg, "-version")
                .redirectErrorStream(true)
                .also { it.environment()["LD_LIBRARY_PATH"] = ldLibraryPath(context) }
                .start()
            process.inputStream.readBytes()
            process.waitFor()
        } catch (e: Exception) {
            // Warm-up is best-effort — a real slice/chapter call will surface any error.
            Log.w("FFmpegEnvironment", "Warm-up exec failed (non-fatal): ${e.message}")
        }
        ready = true
    }

    fun ldLibraryPath(context: Context): String {
        val nativeLibDir = context.applicationInfo.nativeLibraryDir
        val linkDir = File(context.noBackupFilesDir, "ivy-native/lib")
        ensureSymlinks(linkDir, nativeLibDir)
        return listOf(
            linkDir.absolutePath,
            File(bundleDir(context), "usr/lib").absolutePath,
            nativeLibDir
        ).joinToString(":")
    }

    private fun bundleDir(context: Context) = File(context.noBackupFilesDir, "ivy-native/ffmpeg")

    /**
     * Extract libffmpeg.zip.so (usr/... tree) into no_backup/ivy-native/ffmpeg.
     * A marker file records the zip's size; a mismatch (app update changed the
     * bundle) wipes and re-extracts. Installs upgraded from <= 1.4.x keep an
     * orphaned legacy extraction dir in no_backup (~35MB); deliberately not
     * cleaned up — naming it in code would leave the trace this vendoring
     * removes (see docs/2026-08-04-vendor-ffmpeg.md).
     */
    private fun ensureExtracted(context: Context) {
        val zip = File(context.applicationInfo.nativeLibraryDir, "libffmpeg.zip.so")
        if (!zip.exists()) {
            throw IllegalStateException("Bundled ffmpeg runtime missing: $zip")
        }
        val dir = bundleDir(context)
        val marker = File(dir, ".bundle-size")
        val stamp = zip.length().toString()
        if (marker.exists() && marker.readText() == stamp) return

        dir.deleteRecursively()
        dir.mkdirs()
        ZipInputStream(zip.inputStream().buffered()).use { stream ->
            while (true) {
                val entry = stream.nextEntry ?: break
                val out = File(dir, entry.name)
                if (!out.canonicalPath.startsWith(dir.canonicalPath + File.separator)) {
                    throw SecurityException("Zip entry escapes extraction dir: ${entry.name}")
                }
                if (entry.isDirectory) {
                    out.mkdirs()
                } else {
                    out.parentFile?.mkdirs()
                    out.outputStream().use { stream.copyTo(it) }
                }
            }
        }
        repairSymlinks(File(dir, "usr"))
        marker.writeText(stamp)
    }

    /**
     * The bundle zip stores the lib alias symlinks (lib*.so, lib*.so.N →
     * lib*.so.N.M.P) as entries java.util.zip extracts as tiny files holding
     * the target name — the dynamic linker then fails with "too small to be
     * an ELF executable". Recreate them as real symlinks: any tiny .so file
     * whose content names an existing sibling is an alias.
     */
    private fun repairSymlinks(root: File) {
        val files = root.walkTopDown().filter {
            it.isFile && it.name.contains(".so") && it.length() in 1..MAX_SYMLINK_BYTES
        }
        for (file in files) {
            val target = file.readText()
            if (!target.matches(Regex("[A-Za-z0-9._+-]+"))) continue
            if (!File(file.parentFile, target).isFile) continue
            file.delete()
            Os.symlink(target, file.absolutePath)
        }
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
