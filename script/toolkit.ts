#!/usr/bin/env -S npx tsx
// Ivy project toolkit — the single CLI for building, testing, preparing and
// driving/inspecting the app. Replaces the loose scripts that used to live in
// script/ and the non-standard npm scripts. Design + rationale:
// docs/2026-07-30-toolkit-cli.md. Full usage: `script/toolkit.ts help`
// (also embedded in CLAUDE.md so agents see it from session init).
//
// Single file on purpose: whole tool in one read, no import graph. Split only
// when it hurts.

import { execFileSync, spawnSync, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as readline from 'node:readline'

const APP = 'com.salezica.ivy'
const DB_DEVICE_PATH = 'files/SQLite/audioplayer.db' // expo-sqlite default dir, relative to app data
const ROOT = path.resolve(__dirname, '..')
const MIRROR = process.env.IVY_BUILD_DIR || '/home/claude/ivy-build'
const CAPTURES_DIR = path.join(ROOT, 'captures')

const HELP = `Ivy toolkit — project CLI (build, test, prepare, drive, inspect)

Usage: script/toolkit.ts <command> [args] [--device <serial>]

Commands:

  build <variant> [--install] [--arch <abi>]
      Variants: debug | maestro | preview | release | web.
      Env-aware: on the Mac builds in android/; in the container mirrors the
      tree to ${'$'}IVY_BUILD_DIR (default /home/claude/ivy-build) and builds
      there (never Gradle in /workspace). release = assemble + bundle (AAB),
      runs prebuild --clean first and needs ${'$'}KEYSTORE_PASSWORD (prompts on
      a TTY). web = copy web/ to dist/. --install installs the built APK on
      the device. --arch limits native ABIs (e.g. arm64-v8a for emulator).

  clean
      Recover a Gradle-polluted /workspace: sweep native build outputs and
      regenerate android/ via expo prebuild --clean.

  test [--unit] [--e2e]
      No flag = both. --unit = jest. --e2e = full maestro suite; pushes and
      media-scans the fixtures first, verifies delete-original afterwards.

  drive --file <flow.yaml> | --inline '<steps yaml>' | --tap <id|text> | --nav <route>
      Make the running app do something (one mode per call).
        --file    run a maestro flow (fixtures pushed first)
        --inline  run ad-hoc maestro steps, no flow file needed
                  e.g. --inline '- tapOn: "Library"'
        --tap     find element by resource-id/text/content-desc in the view
                  hierarchy and tap it via adb (fast path, no maestro startup)
        --nav     deep-link via ivy:// scheme (e.g. --nav player)

  prepare [--screenshots]
      Play Store preparations; no flag = all. --screenshots recreates
      playstore/shots/ (seed demo data, status-bar demo mode, maestro flow).
      Emulator-only.

  doctor
      Full environment report: tools, devices, project state, the
      local.properties pollution check, all built APKs/AABs found (with
      ffmpeg closure check on each APK). Exits nonzero on failures.

  device connect
      adb connect to the Mac-hosted emulator (host.docker.internal:5555).

  device wipe
      Clear app data (pm clear). Emulator-only.

  device fix-media
      Recover a wedged MediaStore (force-stop provider + full volume rescan).

  device put [--fixtures] [--samples]
      --fixtures  push + media-scan the e2e test audio files
      --samples   push the demo seed bundle; the app wipes its DB and
                  self-seeds on next launch. Emulator-only.

  capture [name]
      Screenshot the device into captures/<name>.png (default: timestamp).

  tree [--raw]
      Dump the view hierarchy (uiautomator). Default output is condensed to
      elements with text/resource-id/content-desc; --raw prints full XML.
      Note: React Native testIDs surface as resource-ids.

  logs [--tag <tag>] [--follow]
      Logcat scoped to the app's pid (app must be running). Default dumps and
      exits; --follow streams. --tag filters (e.g. ReactNativeJS).

  query "<sql>"
      Run SQL against a pulled copy of the app database (read-only; needs the
      debug build variant installed — run-as only works on debuggable builds —
      plus sqlite3 on the host).

  help
      This text.

Global:
  --device <serial>   target device; defaults to the sole attached device,
                      honors ${'$'}ANDROID_SERIAL (same as adb)

Destructive commands (wipe, put --samples, prepare) refuse to run on anything
that is not verifiably an emulator. There is no override flag.`

// ---------------------------------------------------------------------------
// Small infra

class Fail extends Error {}
function fail(msg: string): never { throw new Fail(msg) }

const isContainer = os.platform() === 'linux'

function findAdb(): string {
  if (process.env.ADB) return process.env.ADB
  const which = spawnSync('which', ['adb'], { encoding: 'utf8' })
  if (which.status === 0) return which.stdout.trim()
  const sdk = process.env.ANDROID_HOME || (isContainer ? '/opt/android-sdk' : `${os.homedir()}/Library/Android/sdk`)
  const candidate = path.join(sdk, 'platform-tools', 'adb')
  if (fs.existsSync(candidate)) return candidate
  return fail('adb not found (set ANDROID_HOME or ADB)')
}

// Run a command, inherit stdio, fail on nonzero exit
function run(cmd: string, args: string[], opts: { cwd?: string, env?: NodeJS.ProcessEnv } = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', cwd: opts.cwd ?? ROOT, env: opts.env ?? process.env })
  if (res.error) fail(`${cmd}: ${res.error.message}`)
  if (res.status !== 0) fail(`${cmd} ${args.join(' ')} exited with ${res.status}`)
}

// Run a command, capture stdout, fail on nonzero exit
function capture(cmd: string, args: string[], opts: { allowFail?: boolean } = {}): string {
  const res = spawnSync(cmd, args, { encoding: 'utf8', cwd: ROOT })
  if (res.error) fail(`${cmd}: ${res.error.message}`)
  if (res.status !== 0 && !opts.allowFail) {
    fail(`${cmd} ${args.join(' ')} exited with ${res.status}: ${(res.stderr || '').trim()}`)
  }
  return res.stdout ?? ''
}

const has = (cmd: string) => spawnSync('which', [cmd], { stdio: 'ignore' }).status === 0
const log = (msg: string) => console.log(`[toolkit] ${msg}`)

// ---------------------------------------------------------------------------
// Device resolution + adb helpers

let deviceFlag: string | null = null
let resolvedSerial: string | null = null

function listDevices(): string[] {
  const adb = findAdb()
  const out = capture(adb, ['devices'])
  return out.split('\n').slice(1)
    .map(l => l.trim()).filter(l => l && l.endsWith('device'))
    .map(l => l.split(/\s+/)[0])
}

function serial(): string {
  if (resolvedSerial) return resolvedSerial
  if (deviceFlag) return (resolvedSerial = deviceFlag)
  if (process.env.ANDROID_SERIAL) return (resolvedSerial = process.env.ANDROID_SERIAL)
  const devices = listDevices()
  if (devices.length === 0) fail('no device attached (container: `script/toolkit.ts device connect`)')
  if (devices.length > 1) fail(`multiple devices attached (${devices.join(', ')}) — pass --device <serial>`)
  return (resolvedSerial = devices[0])
}

const adb = (...args: string[]) => run(findAdb(), ['-s', serial(), ...args])
const adbOut = (...args: string[]) => capture(findAdb(), ['-s', serial(), ...args])
const adbShell = (...args: string[]) => adbOut('shell', ...args)

// Destructive commands must never touch a physical device (the developer's
// daily-life phone runs a preview build with real data). All three checks
// must pass; there is deliberately no override flag.
function requireEmulator(action: string) {
  const s = serial()
  const prop = (name: string) => adbShell('getprop', name).trim()
  const qemu = prop('ro.kernel.qemu') === '1' || prop('ro.boot.qemu') === '1'
  const hardware = ['goldfish', 'ranchu'].includes(prop('ro.hardware'))
  const serialOk = /^emulator-\d+$/.test(s) || /^host\.docker\.internal:\d+$/.test(s)
  if (!qemu || !hardware || !serialOk) {
    fail(`${action} refused: ${s} is not verifiably an emulator ` +
      `(qemu=${qemu} hardware=${hardware} serial=${serialOk}). No override exists.`)
  }
}

// MEDIA_SCANNER_SCAN_FILE broadcast is a no-op on API 29+ — use content call
function mediaScan(devicePath: string) {
  adbShell('content', 'call', '--uri', 'content://media/none/media_scanner',
    '--method', 'scan_file', '--arg', devicePath)
}

// ---------------------------------------------------------------------------
// build

const GRADLE_TASKS: Record<string, string[]> = {
  debug: [':app:assembleDebug'],
  maestro: [':app:assembleMaestro'],
  preview: [':app:assemblePreview'],
  release: [':app:assembleRelease', ':app:bundleRelease'],
}

function cmdBuild(args: Args) {
  const variant = args.positionals[0]
  if (!variant) fail('usage: build <debug|maestro|preview|release|web> [--install] [--arch <abi>]')
  if (variant === 'web') return buildWeb()
  if (!(variant in GRADLE_TASKS)) fail(`unknown variant: ${variant}`)

  const gradleArgs = [...GRADLE_TASKS[variant]]
  if (args.flags.arch) gradleArgs.push(`-PreactNativeArchitectures=${args.flags.arch}`)

  const env = { ...process.env }
  if (variant === 'release') {
    env.KEYSTORE_PASSWORD = env.KEYSTORE_PASSWORD || promptSecret('Keystore password: ')
    log('verifying keystore password')
    const check = spawnSync('keytool', ['-list', '-keystore', 'credentials/release.keystore',
      '-alias', 'ivy', '-storepass', env.KEYSTORE_PASSWORD], { cwd: ROOT, stdio: 'ignore' })
    if (check.status !== 0) fail('keystore password check failed')
    log('expo prebuild --clean')
    run('npx', ['expo', 'prebuild', '--clean', '--platform', 'android'], { env })
    fixAndroidPerms(ROOT)
  }

  if (isContainer) containerGradle(gradleArgs, env)
  else run('./gradlew', gradleArgs.map(t => t.replace(':app:', '')), { cwd: path.join(ROOT, 'android'), env })

  if (args.flags.install) {
    if (variant === 'release') fail('--install: install release builds by hand')
    const apk = apkPath(variant)
    if (!fs.existsSync(apk)) fail(`APK not found at ${apk}`)
    log(`installing ${apk}`)
    adb('install', '-r', apk)
  }
}

function apkPath(variant: string): string {
  const base = isContainer ? path.join(MIRROR, 'android') : path.join(ROOT, 'android')
  return path.join(base, 'app/build/outputs/apk', variant, `app-${variant}.apk`)
}

// expo prebuild on the container's bind mount can write files with mode 200
// (write-only) — unreadable for gradle on either machine. Normalize after
// every prebuild.
function fixAndroidPerms(base: string) {
  const android = path.join(base, 'android')
  if (fs.existsSync(android)) run('chmod', ['-R', 'u+rwX,go+rX', android])
}

function buildWeb() {
  const dist = path.join(ROOT, 'dist')
  fs.rmSync(dist, { recursive: true, force: true })
  fs.mkdirSync(dist, { recursive: true })
  fs.cpSync(path.join(ROOT, 'web'), dist, { recursive: true })
  log('web/ -> dist/')
}

// Android build isolation for the container: /workspace is a bind mount of the
// Mac checkout and Gradle artifacts embed absolute paths — building in place
// breaks the next Mac build (see CLAUDE.md > Environment). Mirror the working
// tree (uncommitted + untracked included) to a container-local clone with its
// own node_modules and build there; incremental across invocations.
function containerGradle(gradleArgs: string[], env: NodeJS.ProcessEnv) {
  env.ANDROID_HOME = env.ANDROID_HOME || '/opt/android-sdk'
  fs.mkdirSync(MIRROR, { recursive: true })
  log(`syncing ${ROOT} -> ${MIRROR}`)
  run('rsync', ['-a', '--delete',
    '--exclude', '/.git',
    '--exclude', '/node_modules',
    '--exclude', '/android/build',
    '--exclude', '/android/.gradle',
    '--exclude', '/android/app/build',
    '--exclude', '/android/local.properties',
    '--exclude', '/modules/ivy/android/build',
    '--exclude', '.cxx',
    '--exclude', '/.expo',
    '--exclude', '/worktree*',
    `${ROOT}/`, `${MIRROR}/`])

  // Reinstall the mirror's node_modules only when the lockfile changed
  const lockHash = capture('sha256sum', [path.join(MIRROR, 'package-lock.json')]).split(' ')[0]
  const hashFile = path.join(MIRROR, '.node_modules_lock_hash')
  const prevHash = fs.existsSync(hashFile) ? fs.readFileSync(hashFile, 'utf8').trim() : ''
  if (!fs.existsSync(path.join(MIRROR, 'node_modules')) || prevHash !== lockHash) {
    log('npm ci (lockfile changed or first run)')
    run('npm', ['ci', '--silent', '--no-audit', '--no-fund'], { cwd: MIRROR })
    fs.writeFileSync(hashFile, lockHash)
  }

  const lp = `sdk.dir=${env.ANDROID_HOME}\ncmake.dir=/opt/cmakewrap\n`
  const lpFile = path.join(MIRROR, 'android/local.properties')
  if (!fs.existsSync(lpFile) || fs.readFileSync(lpFile, 'utf8') !== lp) fs.writeFileSync(lpFile, lp)

  fixAndroidPerms(MIRROR)
  fs.chmodSync(path.join(MIRROR, 'android/gradlew'), 0o755)

  log(`gradle ${gradleArgs.join(' ')}`)
  run('./gradlew', ['--no-daemon', '--max-workers=8', ...gradleArgs], { cwd: path.join(MIRROR, 'android'), env })
}

function promptSecret(prompt: string): string {
  if (!process.stdin.isTTY) fail('KEYSTORE_PASSWORD not set and no TTY to prompt')
  const stdin = process.stdin as NodeJS.ReadStream
  process.stdout.write(prompt)
  const fd = fs.openSync('/dev/tty', 'r')
  execFileSync('stty', ['-echo'], { stdio: ['inherit', 'inherit', 'inherit'] })
  try {
    const buf = Buffer.alloc(256)
    const n = fs.readSync(fd, buf, 0, 256, null)
    return buf.toString('utf8', 0, n).trim()
  } finally {
    execFileSync('stty', ['echo'], { stdio: ['inherit', 'inherit', 'inherit'] })
    fs.closeSync(fd)
    process.stdout.write('\n')
    void stdin
  }
}

// ---------------------------------------------------------------------------
// clean

function cmdClean() {
  log('sweeping native build outputs')
  fs.rmSync(path.join(ROOT, 'modules/ivy/android/build'), { recursive: true, force: true })
  run('find', ['node_modules', '-maxdepth', '3', '-type', 'd',
    '(', '-path', '*/android/build', '-o', '-name', '.cxx', ')',
    '-prune', '-exec', 'rm', '-rf', '{}', '+'])
  log('expo prebuild --clean')
  run('npx', ['expo', 'prebuild', '--clean', '--platform', 'android'])
  fixAndroidPerms(ROOT)
}

// ---------------------------------------------------------------------------
// test

const FIXTURES = [
  { src: 'assets/test/test-audio.m4a', dest: '/sdcard/Download/test-audio.m4a' },
  // Every metadata extra filled via Libation-style freeform atoms — for
  // details-view coverage and manual testing. Not imported by the base subflow.
  { src: 'assets/test/test-audio-2.m4a', dest: '/sdcard/Download/test-audio-2.m4a' },
  // Disposable copy for delete-original.yaml: imported with "delete original
  // after import" enabled, asserted gone afterwards. Re-pushed every run so
  // the suite stays idempotent.
  { src: 'assets/test/test-audio.m4a', dest: '/sdcard/Download/delete-me.m4a' },
]
const DELETE_ME = '/sdcard/Download/delete-me.m4a'

function pushFixtures() {
  for (const { src, dest } of FIXTURES) {
    const abs = path.join(ROOT, src)
    if (!fs.existsSync(abs)) fail(`fixture missing: ${src}`)
    log(`pushing + media-scanning ${dest}`)
    adb('push', abs, dest)
    // push preserves the source mtime — touch, or a week-old checkout falls out
    // of the picker's "Recent" search scope and the import flows can't find it
    adbShell('touch', dest)
    mediaScan(dest)
  }
}

function requireMaestro() {
  if (!has('maestro')) fail('maestro not found — install from https://maestro.mobile.dev')
}

function maestroRun(args: string[]) {
  requireMaestro()
  run('maestro', ['--device', serial(), 'test', ...args],
    { env: { ...process.env, ANDROID_SERIAL: serial() } })
}

function checkDeleteMe() {
  const still = spawnSync(findAdb(), ['-s', serial(), 'shell', `[ -f ${DELETE_ME} ]`]).status === 0
  if (still) fail(`delete-original flow ran but ${DELETE_ME} still exists`)
  log(`delete-original verified: ${DELETE_ME} is gone`)
}

function cmdTest(args: Args) {
  const unit = !!args.flags.unit
  const e2e = !!args.flags.e2e
  const both = !unit && !e2e
  if (unit || both) {
    log('jest')
    run('npx', ['jest', '--silent'])
  }
  if (e2e || both) {
    pushFixtures()
    log('maestro suite')
    maestroRun(['maestro/'])
    checkDeleteMe() // whole suite includes delete-original.yaml
  }
}

// ---------------------------------------------------------------------------
// drive

function cmdDrive(args: Args) {
  const modes = ['file', 'inline', 'tap', 'nav'].filter(m => args.flags[m])
  if (modes.length !== 1) {
    fail('usage: drive --file <flow.yaml> | --inline \'<steps yaml>\' | --tap <id|text> | --nav <route> (exactly one)')
  }
  const value = args.flags[modes[0]] as string
  switch (modes[0]) {
    case 'file': {
      if (!fs.existsSync(path.resolve(ROOT, value))) fail(`flow not found: ${value}`)
      pushFixtures()
      maestroRun([value])
      if (value.includes('delete-original')) checkDeleteMe()
      break
    }
    case 'inline': {
      const flow = `appId: ${APP}\n---\n${value}\n`
      const tmp = path.join(os.tmpdir(), `toolkit-inline-${process.pid}.yaml`)
      fs.writeFileSync(tmp, flow)
      try { maestroRun([tmp]) } finally { fs.rmSync(tmp, { force: true }) }
      break
    }
    case 'tap': {
      const node = findUiNode(value)
      if (!node) fail(`no element matching "${value}" in the view hierarchy (try \`tree\`)`)
      const [cx, cy] = nodeCenter(node)
      log(`tapping "${value}" at ${cx},${cy}`)
      adbShell('input', 'tap', String(cx), String(cy))
      break
    }
    case 'nav': {
      const route = value.replace(/^\//, '')
      log(`deep-linking ivy://${route}`)
      adbShell('am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', `ivy://${route}`, APP)
      break
    }
  }
}

// ---------------------------------------------------------------------------
// prepare

function cmdPrepare(args: Args) {
  const all = !args.flags.screenshots
  if (args.flags.screenshots || all) prepareScreenshots()
}

// Pipeline: generate demo audio (cached) → clear app data → push the seed
// bundle → status-bar demo mode → maestro flow (the app seeds itself on
// launch) → collect shots into playstore/shots/.
// Customize playstore/data.json; after editing titles/covers also re-run
// playstore/generate-artwork.py (needs Pillow) and commit the PNGs.
function prepareScreenshots() {
  requireEmulator('prepare --screenshots')
  requireMaestro()

  log('generating demo audio')
  run('node', ['playstore/gen-audio.js'])

  pushSamples()

  // Clean status bar while shooting: fixed 9:00 clock, full battery and
  // signal, no notification icons. Always restored, even if maestro fails.
  const demo = (...args: string[]) =>
    adbShell('am', 'broadcast', '-a', 'com.android.systemui.demo', ...args)
  log('entering status bar demo mode')
  adbShell('settings', 'put', 'global', 'sysui_demo_allowed', '1')
  demo('-e', 'command', 'enter')
  demo('-e', 'command', 'clock', '-e', 'hhmm', '0900')
  demo('-e', 'command', 'battery', '-e', 'level', '100', '-e', 'plugged', 'false')
  demo('-e', 'command', 'network', '-e', 'wifi', 'show', '-e', 'level', '4', '-e', 'fully', 'true', '-e', 'mobile', 'hide')
  demo('-e', 'command', 'notifications', '-e', 'visible', 'false')

  const out = path.join(ROOT, 'playstore/.maestro-out')
  const shots = path.join(ROOT, 'playstore/shots')
  try {
    fs.rmSync(out, { recursive: true, force: true })
    fs.rmSync(shots, { recursive: true, force: true })
    log('running maestro flow')
    maestroRun(['--test-output-dir', out, 'maestro/playstore/screenshots.yaml'])
  } finally {
    demo('-e', 'command', 'exit')
  }

  fs.mkdirSync(shots, { recursive: true })
  run('bash', ['-c', `find ${out} -name '*.png' -path '*takeScreenshot*' -exec cp {} ${shots}/ \\;`])
  fs.rmSync(out, { recursive: true, force: true })
  log(`done: ${fs.readdirSync(shots).length} screenshots in playstore/shots/`)
}

// Push the demo seed bundle; the app wipes its DB and self-seeds on next
// launch (src/actions/seed_demo_data.ts)
function pushSamples() {
  requireEmulator('device put --samples')
  const demoDir = `/sdcard/Android/data/${APP}/files/demo`
  log('clearing app data')
  adbShell('pm', 'clear', APP)
  log('pushing seed bundle')
  adbShell('mkdir', '-p', demoDir)
  adb('push', path.join(ROOT, 'playstore/artwork') + '/.', demoDir + '/')
  adb('push', path.join(ROOT, 'playstore/cache') + '/.', demoDir + '/')
  // seed.json last: its presence triggers seeding, so the rest must already be there
  adb('push', path.join(ROOT, 'playstore/data.json'), `${demoDir}/seed.json`)
}

// ---------------------------------------------------------------------------
// doctor

// Bionic + NDK stable ABI libs, always provided by the OS to exec'd processes
const SYSTEM_LIBS = new Set([
  'libc.so', 'libm.so', 'libdl.so', 'liblog.so', 'libz.so', 'libandroid.so',
  'libjnigraphics.so', 'libmediandk.so', 'libnativewindow.so', 'libsync.so',
  'libEGL.so', 'libGLESv1_CM.so', 'libGLESv2.so', 'libGLESv3.so',
  'libOpenSLES.so', 'libaaudio.so', 'libamidi.so', 'libcamera2ndk.so',
  'libvulkan.so', 'libneuralnetworks.so',
])

let doctorFailed = false
function report(ok: boolean | null, label: string, detail: string) {
  const mark = ok === null ? '·' : ok ? '✓' : '✗'
  if (ok === false) doctorFailed = true
  console.log(`  ${mark} ${label}: ${detail}`)
}

function cmdDoctor() {
  console.log(`Context: ${isContainer ? 'container' : 'mac'}`)

  console.log('Tools:')
  const tool = (name: string, versionArgs: string[] | null = null, hint = '') => {
    if (!has(name)) return report(false, name, `not found${hint ? ` — ${hint}` : ''}`)
    const v = versionArgs ? capture(name, versionArgs, { allowFail: true }).split('\n')[0].trim() : 'present'
    report(true, name, v)
  }
  tool('node', ['--version'])
  tool('adb', ['--version'])
  tool('maestro', ['--version'], 'install from https://maestro.mobile.dev')
  tool('java', null)
  tool('sqlite3', null, 'needed by `query`')
  tool('unzip', null, 'needed by the ffmpeg closure check')
  if (isContainer) tool('rsync', null, 'needed by container builds')
  const androidHome = process.env.ANDROID_HOME || (isContainer ? '/opt/android-sdk' : `${os.homedir()}/Library/Android/sdk`)
  report(fs.existsSync(androidHome), 'ANDROID_HOME', androidHome)

  console.log('Devices:')
  const devices = listDevices()
  if (devices.length === 0) {
    report(false, 'attached', isContainer
      ? 'none — try `script/toolkit.ts device connect`' : 'none')
  } else {
    for (const d of devices) {
      const model = capture(findAdb(), ['-s', d, 'shell', 'getprop', 'ro.product.model'], { allowFail: true }).trim()
      report(true, d, model || 'unknown model')
    }
  }

  console.log('Project:')
  const nm = fs.existsSync(path.join(ROOT, 'node_modules'))
  report(nm, 'node_modules', nm ? 'present' : 'missing (npm install)')
  report(fs.existsSync(path.join(ROOT, 'android')) ? true : null, 'android/',
    fs.existsSync(path.join(ROOT, 'android')) ? 'generated' : 'not generated (expo prebuild)')
  report(fs.existsSync(path.join(ROOT, 'credentials/release.keystore')) ? true : null,
    'release keystore', fs.existsSync(path.join(ROOT, 'credentials/release.keystore')) ? 'present' : 'absent')

  // Pollution check: a Gradle run from the "other machine" leaves its sdk.dir
  // behind and breaks the next build here (CLAUDE.md > Environment)
  const lpFile = path.join(ROOT, 'android/local.properties')
  if (fs.existsSync(lpFile)) {
    const sdkDir = fs.readFileSync(lpFile, 'utf8').match(/^sdk\.dir=(.*)$/m)?.[1]
    const polluted = sdkDir !== undefined && !fs.existsSync(sdkDir)
    report(!polluted, 'local.properties',
      polluted ? `sdk.dir=${sdkDir} does not exist — /workspace is polluted, run \`script/toolkit.ts clean\`` : `sdk.dir ok`)
  } else {
    report(null, 'local.properties', 'absent')
  }

  console.log('Builds:')
  const found = findArtifacts()
  if (found.length === 0) report(null, 'artifacts', 'none found')
  for (const f of found) {
    const stat = fs.statSync(f)
    const mb = (stat.size / 1024 / 1024).toFixed(1)
    console.log(`  · ${f} (${mb} MB, ${stat.mtime.toISOString().slice(0, 16).replace('T', ' ')})`)
    if (f.endsWith('.apk')) checkFfmpegClosure(f)
  }

  if (doctorFailed) fail('doctor found problems')
  log('all good')
}

function findArtifacts(): string[] {
  const roots = [path.join(ROOT, 'android'), path.join(MIRROR, 'android')]
  const found: string[] = []
  for (const r of roots) {
    for (const kind of ['apk', 'bundle']) {
      const dir = path.join(r, 'app/build/outputs', kind)
      if (!fs.existsSync(dir)) continue
      for (const variant of fs.readdirSync(dir)) {
        const vdir = path.join(dir, variant)
        if (!fs.statSync(vdir).isDirectory()) continue
        for (const file of fs.readdirSync(vdir)) {
          if (file.endsWith('.apk') || file.endsWith('.aab')) found.push(path.join(vdir, file))
        }
      }
    }
  }
  return found
}

// --- ffmpeg dependency closure check (absorbed from check-ffmpeg-closure.js;
// see docs/CLIPS.md "Vendored shared libs" for why this exists) ---
//
// libffmpeg.so runs as a standalone executable with LD_LIBRARY_PATH built by
// FFmpegEnvironment.kt. A soname missing from that closure is invisible to JS
// tests and to smoke tests on upgraded installs (stale no_backup/ libs mask
// it) — it only crashes at runtime on fresh installs. This walks the NEEDED
// graph from libffmpeg.so inside a built APK and asserts every soname resolves.

function findReadelf(): string | null {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
    || (isContainer ? '/opt/android-sdk' : `${os.homedir()}/Library/Android/sdk`)
  const ndkRoot = path.join(sdk, 'ndk')
  if (!fs.existsSync(ndkRoot)) return null
  for (const ndk of fs.readdirSync(ndkRoot).sort().reverse()) {
    const prebuilt = path.join(ndkRoot, ndk, 'toolchains/llvm/prebuilt')
    if (!fs.existsSync(prebuilt)) continue
    for (const host of fs.readdirSync(prebuilt)) {
      const readelf = path.join(prebuilt, host, 'bin/llvm-readelf')
      if (fs.existsSync(readelf)) return readelf
    }
  }
  return null
}

// Parse FFmpegEnvironment.kt's SYMLINKED_LIBS (soname -> mangled jniLib name).
// This is the runtime source of truth: a vendored versioned soname resolves on
// device ONLY if it's symlinked there — the check must agree with it.
function parseSymlinkMap(): Map<string, string> {
  const kt = path.join(ROOT, 'modules/ivy/android/src/main/java/com/salezica/ivy/FFmpegEnvironment.kt')
  if (!fs.existsSync(kt)) fail(`FFmpegEnvironment.kt not found at ${kt}`)
  const src = fs.readFileSync(kt, 'utf8')
  const block = src.match(/SYMLINKED_LIBS\s*=\s*mapOf\(([\s\S]*?)\)/)
  if (!block) fail('could not find SYMLINKED_LIBS mapOf in FFmpegEnvironment.kt')
  const map = new Map<string, string>()
  for (const m of block![1].matchAll(/"([^"]+)"\s+to\s+"([^"]+)"/g)) map.set(m[1], m[2])
  if (map.size === 0) fail('SYMLINKED_LIBS parsed as empty — regex drift?')
  return map
}

function neededSonames(readelf: string, file: string): string[] {
  const out = capture(readelf, ['-d', file])
  return [...out.matchAll(/NEEDED.*\[(.+)\]/g)].map(m => m[1])
}

function checkFfmpegClosure(apk: string) {
  const readelf = findReadelf()
  if (!readelf) return report(null, 'ffmpeg closure', 'skipped (NDK llvm-readelf not found)')
  const symlinkMap = parseSymlinkMap()
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-closure-'))
  try {
    capture('unzip', ['-o', '-q', apk, 'lib/*', '-d', workDir], { allowFail: true })
    const libRoot = path.join(workDir, 'lib')
    if (!fs.existsSync(libRoot)) return report(null, 'ffmpeg closure', 'no native libs in APK')
    for (const abi of fs.readdirSync(libRoot)) {
      const result = checkAbiClosure(readelf, workDir, abi, symlinkMap)
      report(result.ok, `ffmpeg closure ${abi}`, result.detail)
    }
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true })
  }
}

function checkAbiClosure(readelf: string, workDir: string, abi: string, symlinkMap: Map<string, string>):
    { ok: boolean, detail: string } {
  const apkLibDir = path.join(workDir, 'lib', abi)
  const ffmpegBin = path.join(apkLibDir, 'libffmpeg.so')
  const packageZip = path.join(apkLibDir, 'libffmpeg.zip.so')
  if (!fs.existsSync(ffmpegBin)) return { ok: false, detail: 'libffmpeg.so not in APK' }
  if (!fs.existsSync(packageZip)) return { ok: false, detail: 'libffmpeg.zip.so not in APK' }

  const pkgDir = path.join(workDir, 'pkg', abi)
  fs.mkdirSync(pkgDir, { recursive: true })
  capture('unzip', ['-o', '-q', packageZip, 'usr/lib/*', '-d', pkgDir], { allowFail: true })
  const pkgLibDir = path.join(pkgDir, 'usr/lib')

  // A soname resolves if a real file with that exact name exists in the package
  // libs or the APK's jniLibs (system libs come from the OS). Versioned sonames
  // can't be jniLib filenames, so vendored ones ship mangled (libfoo.so.N →
  // libfoo_N.so) and FFmpegEnvironment.kt symlinks them at runtime. A mangled
  // jniLib only resolves on device if its soname is in that runtime map.
  const unmapped = new Map<string, string>()
  const locate = (soname: string): string | null => {
    for (const dir of [pkgLibDir, apkLibDir]) {
      if (fs.existsSync(path.join(dir, soname))) return path.join(dir, soname)
    }
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
  const seen = new Set<string>()
  const missing = new Map<string, string>()
  while (queue.length > 0) {
    const soname = queue.pop()!
    if (seen.has(soname) || SYSTEM_LIBS.has(soname)) continue
    seen.add(soname)
    const file = locate(soname)
    if (!file) { missing.set(soname, missing.get(soname) ?? 'libffmpeg.so'); continue }
    for (const dep of neededSonames(readelf, fs.realpathSync(file))) {
      if (!seen.has(dep) && !SYSTEM_LIBS.has(dep) && !locate(dep)) missing.set(dep, soname)
      queue.push(dep)
    }
  }

  // Runtime map entries must reference jniLibs that actually exist, or the
  // symlink target is dangling on device
  for (const [soname, mangled] of symlinkMap) {
    if (!fs.existsSync(path.join(apkLibDir, mangled))) {
      unmapped.set(soname, `${mangled} (symlink target missing from jniLibs)`)
    }
  }

  if (missing.size > 0 || unmapped.size > 0) {
    const parts = [
      ...[...missing].map(([s, by]) => `${s} (needed by ${by}) unresolved`),
      ...[...unmapped].map(([s, m]) => `${s} present as ${m} but not in SYMLINKED_LIBS`),
    ]
    return { ok: false, detail: parts.join('; ') }
  }
  return { ok: true, detail: `${seen.size} sonames in closure, all resolve` }
}

// ---------------------------------------------------------------------------
// device

function cmdDevice(args: Args) {
  const sub = args.positionals[0]
  switch (sub) {
    case 'connect': {
      const target = 'host.docker.internal:5555'
      log(`adb connect ${target}`)
      run(findAdb(), ['connect', target])
      break
    }
    case 'wipe': {
      requireEmulator('device wipe')
      log(`pm clear ${APP}`)
      adbShell('pm', 'clear', APP)
      break
    }
    case 'fix-media': {
      // MediaStore can wedge after push+rescan: restart the provider, then
      // rescan the whole external volume
      log('restarting MediaStore provider + rescanning external_primary')
      adbShell('am', 'force-stop', 'com.android.providers.media.module')
      adbShell('content', 'call', '--uri', 'content://media/none/media_scanner',
        '--method', 'scan_volume', '--arg', 'external_primary')
      break
    }
    case 'put': {
      if (!args.flags.fixtures && !args.flags.samples) fail('usage: device put [--fixtures] [--samples]')
      if (args.flags.fixtures) pushFixtures()
      if (args.flags.samples) {
        pushSamples()
        log('samples pushed — the app seeds itself on next launch')
      }
      break
    }
    default:
      fail('usage: device <connect | wipe | fix-media | put>')
  }
}

// ---------------------------------------------------------------------------
// capture / tree / logs / query

function cmdCapture(args: Args) {
  const name = args.positionals[0] ?? `shot-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
  fs.mkdirSync(CAPTURES_DIR, { recursive: true })
  const file = path.join(CAPTURES_DIR, `${name}.png`)
  const res = spawnSync(findAdb(), ['-s', serial(), 'exec-out', 'screencap', '-p'], { maxBuffer: 64 * 1024 * 1024 })
  if (res.status !== 0) fail('screencap failed')
  fs.writeFileSync(file, res.stdout)
  console.log(file)
}

interface UiNode { depth: number, attrs: Record<string, string> }

function dumpHierarchy(): string {
  adbShell('uiautomator', 'dump', '/sdcard/window_dump.xml')
  return adbShell('cat', '/sdcard/window_dump.xml')
}

function parseHierarchy(xml: string): UiNode[] {
  const nodes: UiNode[] = []
  let depth = 0
  for (const m of xml.matchAll(/<node\b([^>]*?)(\/?)>|<\/node>/g)) {
    if (m[0] === '</node>') { depth--; continue }
    const attrs: Record<string, string> = {}
    for (const a of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]] = a[2]
    nodes.push({ depth, attrs })
    if (m[2] !== '/') depth++
  }
  return nodes
}

function cmdTree(args: Args) {
  const xml = dumpHierarchy()
  if (args.flags.raw) return console.log(xml)
  for (const node of parseHierarchy(xml)) {
    const { text, 'resource-id': id, 'content-desc': desc, bounds, class: cls } = node.attrs
    if (!text && !id && !desc) continue
    const parts = [cls?.split('.').pop() ?? 'View']
    if (text) parts.push(`"${text}"`)
    if (id) parts.push(`id=${id}`)
    if (desc) parts.push(`desc="${desc}"`)
    parts.push(bounds ?? '')
    console.log('  '.repeat(node.depth) + parts.join(' '))
  }
}

function findUiNode(query: string): UiNode | null {
  const nodes = parseHierarchy(dumpHierarchy())
  const fields = ['resource-id', 'text', 'content-desc']
  // Exact match on any field wins; substring match is the fallback
  for (const exact of [true, false]) {
    for (const node of nodes) {
      for (const f of fields) {
        const v = node.attrs[f] ?? ''
        if (exact ? v === query : v.toLowerCase().includes(query.toLowerCase())) {
          if (v !== '') return node
        }
      }
    }
  }
  return null
}

function nodeCenter(node: UiNode): [number, number] {
  const m = (node.attrs.bounds ?? '').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/)
  if (!m) fail('element has no bounds')
  const [x1, y1, x2, y2] = m!.slice(1).map(Number)
  return [Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2)]
}

function cmdLogs(args: Args) {
  const pid = adbShell('pidof', '-s', APP).trim()
  if (!pid) fail(`${APP} is not running`)
  const logcatArgs = ['-s', serial(), 'logcat', '--pid', pid]
  if (!args.flags.follow) logcatArgs.push('-d')
  if (args.flags.tag) logcatArgs.push('-s', `${args.flags.tag}:V`)
  if (args.flags.follow) {
    const child = spawn(findAdb(), logcatArgs, { stdio: 'inherit' })
    child.on('exit', code => process.exit(code ?? 0))
  } else {
    run(findAdb(), logcatArgs)
  }
}

function cmdQuery(args: Args) {
  const sql = args.positionals[0]
  if (!sql) fail('usage: query "<sql>"')
  if (!has('sqlite3')) fail('sqlite3 not found on the host')
  // run-as works on debuggable builds only (debug/maestro variants)
  const local = path.join(os.tmpdir(), `toolkit-db-${process.pid}.db`)
  const res = spawnSync(findAdb(), ['-s', serial(), 'exec-out', 'run-as', APP, 'cat', DB_DEVICE_PATH],
    { maxBuffer: 512 * 1024 * 1024 })
  // adb exec-out can exit 0 with the remote error on stdout — trust only the
  // SQLite magic bytes
  if (res.status !== 0 || !res.stdout.subarray(0, 15).equals(Buffer.from('SQLite format 3'))) {
    fail('could not pull the database — is the debug build variant installed and initialized? ' +
      `(${(res.stdout.toString() + res.stderr.toString()).trim().split('\n')[0]})`)
  }
  fs.writeFileSync(local, res.stdout)
  try {
    run('sqlite3', ['-header', '-column', local, sql])
  } finally {
    fs.rmSync(local, { force: true })
  }
}

// ---------------------------------------------------------------------------
// Router

interface Args { positionals: string[], flags: Record<string, string | boolean> }

// Tiny parser: `--flag` is boolean unless listed in valued (then takes the
// next token); everything else is positional.
const VALUED_FLAGS = new Set(['device', 'arch', 'file', 'inline', 'tap', 'nav', 'tag'])

function parseArgs(argv: string[]): Args {
  const args: Args = { positionals: [], flags: {} }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const name = a.slice(2)
      if (VALUED_FLAGS.has(name)) {
        const v = argv[++i]
        if (v === undefined) fail(`--${name} requires a value`)
        args.flags[name] = v
      } else {
        args.flags[name] = true
      }
    } else {
      args.positionals.push(a)
    }
  }
  return args
}

const COMMANDS: Record<string, (args: Args) => void> = {
  build: cmdBuild,
  clean: cmdClean,
  test: cmdTest,
  drive: cmdDrive,
  prepare: cmdPrepare,
  doctor: cmdDoctor,
  device: cmdDevice,
  capture: cmdCapture,
  tree: cmdTree,
  logs: cmdLogs,
  query: cmdQuery,
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(HELP)
    return
  }
  const handler = COMMANDS[cmd]
  if (!handler) fail(`unknown command: ${cmd} (see \`script/toolkit.ts help\`)`)
  const args = parseArgs(rest)
  if (args.flags.device) deviceFlag = String(args.flags.device)
  handler(args)
}

if (path.basename(process.argv[1] ?? '').startsWith('toolkit')) {
  try {
    main()
  } catch (e) {
    if (e instanceof Fail) {
      console.error(`toolkit: ${e.message}`)
      process.exit(1)
    }
    throw e
  }
}

export { parseArgs, parseHierarchy, findArtifacts, nodeCenter }
export type { Args, UiNode }
