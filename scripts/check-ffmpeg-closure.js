#!/usr/bin/env node
// Build-time guard for the exec'd FFmpeg binary's dynamic linking.
//
// libffmpeg.so runs as a standalone executable with LD_LIBRARY_PATH built by
// FFmpegEnvironment.kt: the extracted ffmpeg package libs + the app's
// nativeLibraryDir (jniLibs, including the vendored sonames — see
// docs/CLIPS.md "Vendored shared libs"). A soname missing from that closure
// is invisible to every JS test and to smoke tests on upgraded installs
// (stale no_backup/ libs mask it) — it only crashes on fresh installs, at
// runtime. This script fails the build instead: it walks the NEEDED graph
// from libffmpeg.so inside a built APK and asserts every soname resolves.
//
// Usage: node scripts/check-ffmpeg-closure.js <path-to-apk>

const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

// Bionic + NDK stable ABI libs, always provided by the OS to exec'd processes
const SYSTEM_LIBS = new Set([
  'libc.so', 'libm.so', 'libdl.so', 'liblog.so', 'libz.so', 'libandroid.so',
  'libjnigraphics.so', 'libmediandk.so', 'libnativewindow.so', 'libsync.so',
  'libEGL.so', 'libGLESv1_CM.so', 'libGLESv2.so', 'libGLESv3.so',
  'libOpenSLES.so', 'libaaudio.so', 'libamidi.so', 'libcamera2ndk.so',
  'libvulkan.so', 'libneuralnetworks.so',
])

function fail(message) {
  console.error(`check-ffmpeg-closure: ${message}`)
  process.exit(1)
}

function findReadelf() {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
    || `${os.homedir()}/Library/Android/sdk`
  const ndkRoot = path.join(sdk, 'ndk')
  if (!fs.existsSync(ndkRoot)) fail(`NDK not found under ${ndkRoot} (set ANDROID_HOME)`)
  for (const ndk of fs.readdirSync(ndkRoot).sort().reverse()) {
    const prebuilt = path.join(ndkRoot, ndk, 'toolchains/llvm/prebuilt')
    if (!fs.existsSync(prebuilt)) continue
    for (const host of fs.readdirSync(prebuilt)) {
      const readelf = path.join(prebuilt, host, 'bin/llvm-readelf')
      if (fs.existsSync(readelf)) return readelf
    }
  }
  fail('llvm-readelf not found in any NDK')
}

function unzip(archive, dest, patterns) {
  execFileSync('unzip', ['-o', '-q', archive, ...patterns, '-d', dest], { stdio: ['ignore', 'ignore', 'pipe'] })
}

function neededSonames(readelf, file) {
  const out = execFileSync(readelf, ['-d', file], { encoding: 'utf8' })
  return [...out.matchAll(/NEEDED.*\[(.+)\]/g)].map(m => m[1])
}

// Parse FFmpegEnvironment.kt's SYMLINKED_LIBS (soname -> mangled jniLib name).
// This is the runtime source of truth: a vendored versioned soname resolves on
// device ONLY if it's symlinked here. The closure check must agree with it, or
// a mangled lib present in jniLibs but absent from this map passes the check
// and still crashes at link time (the original bug, reborn).
function parseSymlinkMap() {
  const kt = path.join(__dirname, '..', 'modules', 'ivy', 'android', 'src', 'main',
    'java', 'com', 'salezica', 'ivy', 'FFmpegEnvironment.kt')
  if (!fs.existsSync(kt)) fail(`FFmpegEnvironment.kt not found at ${kt}`)
  const src = fs.readFileSync(kt, 'utf8')
  const block = src.match(/SYMLINKED_LIBS\s*=\s*mapOf\(([\s\S]*?)\)/)
  if (!block) fail('could not find SYMLINKED_LIBS mapOf in FFmpegEnvironment.kt')
  const map = new Map()
  for (const m of block[1].matchAll(/"([^"]+)"\s+to\s+"([^"]+)"/g)) map.set(m[1], m[2])
  if (map.size === 0) fail('SYMLINKED_LIBS parsed as empty — regex drift?')
  return map
}

function checkAbi(readelf, workDir, abi, symlinkMap) {
  const apkLibDir = path.join(workDir, 'lib', abi)
  const ffmpegBin = path.join(apkLibDir, 'libffmpeg.so')
  const packageZip = path.join(apkLibDir, 'libffmpeg.zip.so')
  if (!fs.existsSync(ffmpegBin)) fail(`${abi}: libffmpeg.so not in APK`)
  if (!fs.existsSync(packageZip)) fail(`${abi}: libffmpeg.zip.so not in APK`)

  const pkgDir = path.join(workDir, 'pkg', abi)
  fs.mkdirSync(pkgDir, { recursive: true })
  unzip(packageZip, pkgDir, ['usr/lib/*'])
  const pkgLibDir = path.join(pkgDir, 'usr/lib')

  // A soname resolves if a real file with that exact name exists in the package
  // libs or the APK's jniLibs (system libs come from the OS). Versioned sonames
  // can't be jniLib filenames, so vendored ones ship mangled (libfoo.so.N →
  // libfoo_N.so) and FFmpegEnvironment.kt symlinks them at runtime. A mangled
  // jniLib only resolves on device if its soname is in that runtime map — so a
  // mangled file present but NOT mapped is reported as `unmapped`, not resolved.
  const unmapped = new Map() // soname -> mangled file that exists but isn't symlinked at runtime
  const locate = (soname) => {
    for (const dir of [pkgLibDir, apkLibDir]) {
      if (fs.existsSync(path.join(dir, soname))) return path.join(dir, soname)
    }
    // Not present under its real name; a vendored mangled jniLib may cover it,
    // but only if the runtime symlink map actually creates that link.
    if (soname.includes('.so.')) {
      const mangled = soname.replace(/\.so\./, '_') + '.so'
      if (fs.existsSync(path.join(apkLibDir, mangled))) {
        if (symlinkMap.get(soname) === mangled) return path.join(apkLibDir, mangled)
        unmapped.set(soname, mangled) // exists in jniLibs but no runtime symlink → link fails
      }
    }
    return null
  }

  const queue = neededSonames(readelf, ffmpegBin)
  const seen = new Set()
  const missing = new Map() // soname -> needed by
  while (queue.length > 0) {
    const soname = queue.pop()
    if (seen.has(soname) || SYSTEM_LIBS.has(soname)) continue
    seen.add(soname)
    const file = locate(soname)
    if (!file) {
      missing.set(soname, missing.get(soname) ?? 'libffmpeg.so')
      continue
    }
    for (const dep of neededSonames(readelf, fs.realpathSync(file))) {
      if (!seen.has(dep) && !SYSTEM_LIBS.has(dep) && !locate(dep)) missing.set(dep, soname)
      queue.push(dep)
    }
  }

  // Runtime map entries must reference jniLibs that actually exist, or the
  // symlink target is dangling on device.
  for (const [soname, mangled] of symlinkMap) {
    if (!fs.existsSync(path.join(apkLibDir, mangled))) {
      unmapped.set(soname, `${mangled} (symlink target missing from jniLibs)`)
    }
  }

  if (missing.size > 0 || unmapped.size > 0) {
    for (const [soname, neededBy] of missing) {
      console.error(`  ${abi}: ${soname} (needed by ${neededBy}) does not resolve`)
    }
    for (const [soname, mangled] of unmapped) {
      console.error(`  ${abi}: ${soname} present as ${mangled} but not in FFmpegEnvironment.SYMLINKED_LIBS — won't link at runtime`)
    }
    return false
  }
  console.log(`  ${abi}: ${seen.size} sonames in closure, all resolve`)
  return true
}

const apk = process.argv[2]
if (!apk || !fs.existsSync(apk)) fail(`usage: check-ffmpeg-closure.js <path-to-apk> (got: ${apk})`)

const readelf = findReadelf()
const symlinkMap = parseSymlinkMap()
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-closure-'))
try {
  unzip(apk, workDir, ['lib/*'])
  const abis = fs.readdirSync(path.join(workDir, 'lib'))
  console.log(`Checking FFmpeg dependency closure in ${path.basename(apk)} (${abis.join(', ')})`)
  const ok = abis.map(abi => checkAbi(readelf, workDir, abi, symlinkMap)).every(Boolean)
  if (!ok) fail('unresolved sonames — the ffmpeg binary will fail to link on device (fresh installs)')
} finally {
  fs.rmSync(workDir, { recursive: true, force: true })
}
