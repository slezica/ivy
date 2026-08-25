#!/usr/bin/env -S npx tsx
// Ivy project toolkit — the single CLI for building, testing, preparing and
// driving/inspecting the app. Replaces the loose scripts that used to live in
// script/ and the non-standard npm scripts. Design + rationale:
// docs/2026-07-30-toolkit-cli.md. Full usage: `bin/ivy.ts help`
// (also embedded in CLAUDE.md so agents see it from session init).
//
// Single file on purpose: whole tool in one read, no import graph. Split only
// when it hurts.

import { execFileSync, spawnSync, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import * as readline from 'node:readline'

const APP = 'com.salezica.ivy'
const DB_DEVICE_PATH = 'files/SQLite/audioplayer.db' // expo-sqlite default dir, relative to app data
const ROOT = path.resolve(__dirname, '..')
const MIRROR = process.env.IVY_BUILD_DIR || '/home/claude/ivy-build'
const CAPTURES_DIR = path.join(ROOT, 'captures')

const HELP = `Ivy toolkit — project CLI (build, test, prepare, drive, inspect)

Usage: bin/ivy.ts <command> [args] [--device <serial>]

Commands:

  build <variant> [--install] [--arch <abi>]
      Variants: debug | maestro | preview | release.
      Env-aware: on the Mac builds in android/; in the container mirrors the
      tree to ${'$'}IVY_BUILD_DIR (default /home/claude/ivy-build) and builds
      there (never Gradle in /workspace). release = assemble + bundle (AAB),
      runs prebuild --clean first and needs ${'$'}KEYSTORE_PASSWORD (prompts on
      a TTY). preview/release artifacts are checked after building (version
      stamp, ffmpeg closure, yt-dlp scan); release is also copied to
      dist/ivy-<version>.{aab,apk}. --install installs the built APK on the
      device. --arch limits native ABIs (e.g. arm64-v8a for emulator).

  clean
      Recover a Gradle-polluted /workspace: sweep native build outputs and
      regenerate android/ via expo prebuild --clean.

  dev [--clear]
      Start the Metro dev server (Fast Refresh) for the installed debug
      build. Mac-only (the emulator cannot reach a container-local Metro);
      never builds native — install first with \`build debug --install\`.
      --clear resets the Metro cache. Ctrl-C to stop.

  test [name] [--unit | --e2e] [--server-only [--port <n>]]
      No flag = both suites. --unit = jest. --e2e = maestro suite; pushes and
      media-scans the fixtures first, verifies delete-original afterwards.
      [name] runs a single case (jest pattern or maestro flow name) and needs
      exactly one of --unit/--e2e. E2e runs auto-start the bridge server —
      a localhost HTTP interface flows use for device control (network
      toggles) via maestro/scripts/bridge.js; BRIDGE_URL is injected into
      every run and network state is restored afterwards (emulator only).
      --server-only starts just the bridge (foreground, Ctrl-C to stop) for
      hand-run maestro sessions.

  drive --file <flow.yaml> | --inline '<steps yaml>' | --tap <id|text> | --nav <route>
      Make the running app do something (one mode per call).
        --file    run a maestro flow (fixtures pushed first)
        --inline  run ad-hoc maestro steps, no flow file needed
                  e.g. --inline '- tapOn: "Library"'
        --tap     find element by resource-id/text/content-desc in the view
                  hierarchy and tap it via adb (fast path, no maestro startup)
        --nav     deep-link via ivy:// scheme (e.g. --nav player)

  generate [--audio] [--artwork] [--feature] [--screenshots] [--icon]
      Generate store/web assets from samples/ into dist/ (one or more flags).
        --audio        silent demo MP3s from samples/data.json (cached)
        --artwork      demo covers from samples/data.json (python3 + Pillow)
        --feature      render samples/feature.html -> dist/feature.png (chromium)
        --screenshots  Play Store screenshots (seed demo data, status-bar demo
                       mode, maestro flow) -> dist/screenshots/; also refreshes
                       web/assets/ and the README composite. Emulator-only.
        --icon         dist/icon-512.png from the app icon (ImageMagick)

  prepare --version <X.Y.Z> --changes <markdown> [--screenshots]
      The release pipeline, start to finish. Interactive (keystore password
      prompted up front, held in memory only) — run it on the Mac from a
      terminal. Steps: preflight -> password -> maestro build + full test
      suite -> [screenshots ->] version bump + VERSIONS.md -> commit ->
      release build -> artifact checks -> dist/ delivery -> tag. Nothing is
      pushed or uploaded; it ends with a checklist of the manual Play
      Console / GitHub steps.

  doctor
      Full environment report: tools, devices, project state, the
      local.properties pollution check, all built APKs/AABs found (with
      version name/code, ffmpeg closure check on each APK, and a yt-dlp
      trace scan on every artifact). Exits nonzero on failures.

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

Destructive commands (wipe, put --samples, generate --screenshots) refuse to
run on anything that is not verifiably an emulator. There is no override flag.`

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
  if (devices.length === 0) fail('no device attached (container: `bin/ivy.ts device connect`)')
  if (devices.length > 1) fail(`multiple devices attached (${devices.join(', ')}) — pass --device <serial>`)
  return (resolvedSerial = devices[0])
}

const adb = (...args: string[]) => run(findAdb(), ['-s', serial(), ...args])
const adbOut = (...args: string[]) => capture(findAdb(), ['-s', serial(), ...args])
const adbShell = (...args: string[]) => adbOut('shell', ...args)

// Destructive commands must never touch a physical device (the developer's
// daily-life phone runs a preview build with real data). All three checks
// must pass; there is deliberately no override flag.
function isEmulator(): boolean {
  const s = serial()
  const prop = (name: string) => adbShell('getprop', name).trim()
  const qemu = prop('ro.kernel.qemu') === '1' || prop('ro.boot.qemu') === '1'
  const hardware = ['goldfish', 'ranchu'].includes(prop('ro.hardware'))
  const serialOk = /^emulator-\d+$/.test(s) || /^host\.docker\.internal:\d+$/.test(s)
  return qemu && hardware && serialOk
}

function requireEmulator(action: string) {
  if (!isEmulator()) {
    fail(`${action} refused: ${serial()} is not verifiably an emulator. No override exists.`)
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
  if (!variant) fail('usage: build <debug|maestro|preview|release> [--install] [--arch <abi>]')
  if (!(variant in GRADLE_TASKS)) fail(`unknown variant: ${variant}`)

  const gradleArgs = [...GRADLE_TASKS[variant]]
  if (args.flags.arch) gradleArgs.push(`-PreactNativeArchitectures=${args.flags.arch}`)

  const env = { ...process.env }
  if (variant === 'release') {
    env.KEYSTORE_PASSWORD = env.KEYSTORE_PASSWORD || promptSecret('Keystore password: ')
    verifyKeystorePassword(env.KEYSTORE_PASSWORD)
    log('expo prebuild --clean')
    run('npx', ['expo', 'prebuild', '--clean', '--platform', 'android'], { env })
    fixAndroidPerms(ROOT)
  }

  runGradle(gradleArgs, env)

  // Shippable variants get their artifacts checked on the spot; release is
  // additionally delivered to dist/. Tagging is NOT done here — that's
  // `prepare`, which gates it on tests.
  if (variant === 'preview' || variant === 'release') checkBuiltArtifact(apkPath(variant))
  if (variant === 'release') {
    checkBuiltArtifact(aabPath())
    deliverRelease()
  }

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

function aabPath(): string {
  const base = isContainer ? path.join(MIRROR, 'android') : path.join(ROOT, 'android')
  return path.join(base, 'app/build/outputs/bundle/release/app-release.aab')
}

// --- versioning (mirrors plugins/withIvyVersionName.js) ---

interface Semver { major: number, minor: number, patch: number }

export function parseSemver(version: string): Semver | null {
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)$/)
  return m ? { major: +m[1], minor: +m[2], patch: +m[3] } : null
}

// Play requires versionCode to strictly increase; monotonic while minor/patch < 100
export function versionCode(v: Semver): number {
  return v.major * 10000 + v.minor * 100 + v.patch
}

function pkgVersion(): string {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
}

// Post-build gate for shippable variants — the doctor checks that matter for
// the artifact just built, and nothing else (full doctor also reports stale
// artifacts from earlier builds, which must not fail a fresh one).
function checkBuiltArtifact(file: string) {
  if (!fs.existsSync(file)) fail(`built artifact not found at ${file}`)
  console.log(`Artifact checks for ${path.basename(file)}:`)
  const sv = parseSemver(pkgVersion())
  const want = sv ? `${pkgVersion()} (${versionCode(sv)})` : pkgVersion()
  const got = artifactVersion(file) ?? 'unreadable'
  report(got === want, 'version stamp', got === want ? got : `${got} — expected ${want}`)
  if (file.endsWith('.apk')) checkFfmpegClosure(file)
  checkYtdlpTraces(file)
  if (doctorFailed) fail(`artifact checks failed for ${file} (${failedChecks.join(', ')})`)
}

// Copy the checked release artifacts to dist/ under their versioned names
// (in the container this moves them out of the build mirror onto the mount)
function deliverRelease(): { aab: string, apk: string } {
  const version = pkgVersion()
  fs.mkdirSync(DIST, { recursive: true })
  const aab = path.join(DIST, `ivy-${version}.aab`)
  const apk = path.join(DIST, `ivy-${version}.apk`)
  fs.copyFileSync(aabPath(), aab)
  fs.copyFileSync(apkPath('release'), apk)
  log(`delivered ${path.relative(ROOT, aab)}`)
  log(`delivered ${path.relative(ROOT, apk)}`)
  return { aab, apk }
}

function runGradle(gradleArgs: string[], env: NodeJS.ProcessEnv) {
  if (isContainer) containerGradle(gradleArgs, env)
  else {
    ensureGradlewExec(ROOT)
    run('./gradlew', gradleArgs.map(t => t.replace(':app:', '')), { cwd: path.join(ROOT, 'android'), env })
  }
}

function verifyKeystorePassword(password: string) {
  log('verifying keystore password')
  const check = spawnSync('keytool', ['-list', '-keystore', 'secrets/release.keystore',
    '-alias', 'ivy', '-storepass', password], { cwd: ROOT, stdio: 'ignore' })
  if (check.status !== 0) fail('keystore password check failed')
}

// expo prebuild on the container's bind mount can write files with mode 200
// (write-only) — unreadable for gradle on either machine. Normalize after
// every prebuild.
function fixAndroidPerms(base: string) {
  const android = path.join(base, 'android')
  if (fs.existsSync(android)) run('chmod', ['-R', 'u+rwX,go+rX', android])
}

// prebuild writes gradlew without the exec bit
function ensureGradlewExec(base: string) {
  const gradlew = path.join(base, 'android/gradlew')
  if (fs.existsSync(gradlew)) fs.chmodSync(gradlew, 0o755)
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
  ensureGradlewExec(MIRROR)

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

function maestroRun(args: string[], bridgeUrl?: string) {
  requireMaestro()
  const env = bridgeUrl ? ['-e', `BRIDGE_URL=${bridgeUrl}`] : []
  run('maestro', ['--device', serial(), 'test', ...env, ...args],
    { env: { ...process.env, ANDROID_SERIAL: serial() } })
}

// ---------------------------------------------------------------------------
// Bridge server — device control for maestro flows
//
// Flows can't run adb (maestro's JS sandbox only has http.*), so the toolkit
// serves a small HTTP vocabulary of device operations and injects BRIDGE_URL
// into every maestro run. Flows call it mid-flow via scripts/bridge.js:
//   - runScript: { file: scripts/bridge.js, env: { CMD: "net/wifi/off" } }
// Endpoints are semantic and curated — adb knowledge stays here, never in
// yaml. Silent in normal operation; errors travel back in the HTTP response
// (500 + message), which bridge.js turns into a flow failure.

const BRIDGE_DEFAULT_PORT = 7799

// Semantic endpoint vocabulary. Network toggles are emulator-only: flipping
// radios on a physical device (the developer's phone) is never acceptable.
const BRIDGE_ENDPOINTS: Record<string, () => void> = {
  'net/wifi/on': () => { requireEmulator('bridge net control'); adbShell('svc', 'wifi', 'enable') },
  'net/wifi/off': () => { requireEmulator('bridge net control'); adbShell('svc', 'wifi', 'disable') },
  'net/data/on': () => { requireEmulator('bridge net control'); adbShell('svc', 'data', 'enable') },
  'net/data/off': () => { requireEmulator('bridge net control'); adbShell('svc', 'data', 'disable') },
}

function startBridgeServer(port: number): http.Server {
  const server = http.createServer((req, res) => {
    const cmd = (req.url ?? '').replace(/^\/+/, '').replace(/\/+$/, '')

    if (cmd === 'health') {
      res.writeHead(200).end('ok')
      return
    }

    const handler = BRIDGE_ENDPOINTS[cmd]
    if (!handler) {
      res.writeHead(404).end(`unknown bridge command: ${cmd}`)
      return
    }

    try {
      handler()
      res.writeHead(200).end('ok')
    } catch (e) {
      res.writeHead(500).end(e instanceof Error ? e.message : String(e))
    }
  })

  server.listen(port, '127.0.0.1')
  return server
}

// Spawn the bridge as a child process (this process blocks on spawnSync while
// maestro runs, so an in-process server could never answer), wait until it is
// healthy, run `fn`, then tear it down and restore network state.
function withBridge(fn: (url: string) => void) {
  const port = Number(process.env.IVY_BRIDGE_PORT || BRIDGE_DEFAULT_PORT)
  const url = `http://127.0.0.1:${port}`
  const logPath = path.join(os.tmpdir(), 'ivy-bridge.log')
  const logFd = fs.openSync(logPath, 'a')

  const child = spawn('npx', ['tsx', path.join(ROOT, 'bin/ivy.ts'),
    'test', '--server-only', '--port', String(port), '--device', serial()],
    { cwd: ROOT, stdio: ['ignore', logFd, logFd] })

  const healthy = () => spawnSync(process.execPath, ['-e',
    `fetch(process.argv[1]).then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))`,
    `${url}/health`]).status === 0

  try {
    const deadline = Date.now() + 10_000
    while (!healthy()) {
      if (Date.now() > deadline) fail(`bridge server did not come up on ${url} (log: ${logPath})`)
      spawnSync('sleep', ['0.2'])
    }

    fn(url)
  } finally {
    child.kill()
    fs.closeSync(logFd)

    // Flows may leave radios off; restore the default state (emulator only)
    if (isEmulator()) {
      try {
        adbShell('svc', 'wifi', 'enable')
        adbShell('svc', 'data', 'enable')
      } catch { /* device gone — nothing to restore */ }
    }
  }
}

function checkDeleteMe() {
  const still = spawnSync(findAdb(), ['-s', serial(), 'shell', `[ -f ${DELETE_ME} ]`]).status === 0
  if (still) fail(`delete-original flow ran but ${DELETE_ME} still exists`)
  log(`delete-original verified: ${DELETE_ME} is gone`)
}

function resolveFlow(name: string): string {
  const file = name.endsWith('.yaml') ? name : `${name}.yaml`
  const candidates = [file, path.join('maestro', file)]
  for (const c of candidates) {
    if (fs.existsSync(path.resolve(ROOT, c))) return c
  }
  fail(`flow not found: ${name} (tried ${candidates.join(', ')})`)
}

function cmdTest(args: Args) {
  const unit = !!args.flags.unit
  const e2e = !!args.flags.e2e
  const name = args.positionals[0]

  // Foreground bridge for hand-run maestro sessions
  if (args.flags['server-only']) {
    const port = Number(args.flags.port || process.env.IVY_BRIDGE_PORT || BRIDGE_DEFAULT_PORT)
    serial() // resolve the device now so endpoint calls target the right one
    startBridgeServer(port)
    log(`bridge server on http://127.0.0.1:${port}`)
    log(`run flows with: maestro test -e BRIDGE_URL=http://127.0.0.1:${port} <flow.yaml>`)
    return // server keeps the process alive; Ctrl-C to stop
  }

  if (name && unit === e2e) fail('test <name> needs exactly one of --unit or --e2e')

  const both = !unit && !e2e
  if (e2e || both) requireMaestro() // fail fast, before jest runs
  if (unit || both) {
    log('jest')
    run('npx', ['jest', '--silent', ...(name ? [name] : [])])
  }
  if (e2e || both) {
    pushFixtures()
    if (name) {
      const flow = resolveFlow(name)
      log(`maestro flow: ${flow}`)
      withBridge(url => maestroRun([flow], url))
      if (flow.includes('delete-original')) checkDeleteMe()
    } else {
      log('maestro suite')
      withBridge(url => maestroRun(['maestro/'], url))
      checkDeleteMe() // whole suite includes delete-original.yaml
    }
  }
}

// ---------------------------------------------------------------------------
// dev

function cmdDev(args: Args) {
  // Metro dev server with Fast Refresh, serving the installed debug build
  // (expo-dev-client). Foreground; Ctrl-C to stop. Needs a debug build on the
  // device (`bin/ivy.ts build debug --install`) — this never builds native.
  if (isContainer) {
    fail('dev server must run on the Mac — the emulator cannot reach a container-local Metro')
  }
  run('npx', ['expo', 'start', ...(args.flags.clear ? ['--clear'] : [])])
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
      withBridge(url => maestroRun([value], url))
      if (value.includes('delete-original')) checkDeleteMe()
      break
    }
    case 'inline': {
      const flow = `appId: ${APP}\n---\n${value}\n`
      const tmp = path.join(os.tmpdir(), `toolkit-inline-${process.pid}.yaml`)
      fs.writeFileSync(tmp, flow)
      try {
        withBridge(url => maestroRun([tmp], url))
      } finally {
        fs.rmSync(tmp, { force: true })
      }
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
// generate — store/web assets. Sources live in samples/ (committed), outputs
// in dist/ (gitignored).

const SAMPLES = path.join(ROOT, 'samples')
const DIST = path.join(ROOT, 'dist')

const GENERATORS: Record<string, () => void> = {
  audio: generateAudio,
  artwork: generateArtwork,
  feature: generateFeature,
  screenshots: generateScreenshots,
  icon: generateIcon,
}

function cmdGenerate(args: Args) {
  const kinds = Object.keys(GENERATORS).filter(k => args.flags[k])
  if (kinds.length === 0) {
    fail(`usage: generate ${Object.keys(GENERATORS).map(k => `[--${k}]`).join(' ')} (one or more)`)
  }
  for (const kind of kinds) GENERATORS[kind]()
}

function readSamplesData(): any {
  const file = path.join(SAMPLES, 'data.json')
  if (!fs.existsSync(file)) fail('samples/data.json not found')
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function findImageMagick(): string {
  if (has('magick')) return 'magick'
  if (has('convert')) return 'convert'
  return fail('ImageMagick not found (magick/convert) — brew/apt install imagemagick')
}

// --- audio: silent MP3s for the demo library (absorbed from gen-audio.js) ---
//
// Valid audio of arbitrary duration built by repeating a single pre-encoded
// silent frame (MPEG-2.5 Layer III, 8kHz mono, 8kbps, 576 samples = 72ms per
// 72-byte frame) — no ffmpeg needed, ~1KB per second. The hero book (books[0]
// in data.json) auto-loads into the player, whose position display syncs with
// the real file, so its audio is generated at the book's full stated duration.
// Other books never load, so they share a short file; clips share one
// clip-length file. Existing files with the expected size are kept.

const SILENT_FRAME = Buffer.from(
  '/+MYxMQAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVV',
  'base64'
)
const FRAME_MS = 72
const SHORT_MS = 60_000 // non-hero books: never loaded into the player
const CLIP_MS = 45_000  // shared clip audio: longest clip in data.json

function generateAudio() {
  const data = readSamplesData()
  const audioDir = path.join(DIST, 'audio')
  fs.mkdirSync(audioDir, { recursive: true })

  const write = (name: string, durationMs: number) => {
    const out = path.join(audioDir, name)
    const frames = Math.ceil(durationMs / FRAME_MS)
    const size = frames * SILENT_FRAME.length
    if (fs.existsSync(out) && fs.statSync(out).size === size) {
      log(`audio: kept ${name} (${(size / 1e6).toFixed(1)}MB)`)
      return
    }
    fs.writeFileSync(out, Buffer.concat(Array(frames).fill(SILENT_FRAME)))
    log(`audio: wrote ${name} (${(size / 1e6).toFixed(1)}MB)`)
  }

  const [hero, ...rest] = data.books
  if (hero.audio) write(hero.audio, hero.duration)
  for (const file of new Set<string>(rest.map((b: any) => b.audio).filter(Boolean))) write(file, SHORT_MS)
  for (const file of new Set<string>(data.clips.map((c: any) => c.audio))) write(file, CLIP_MS)
}

// --- artwork: demo book covers from data.json palettes ---

function generateArtwork() {
  if (!has('python3')) fail('python3 not found — needed for artwork generation')
  if (spawnSync('python3', ['-c', 'import PIL'], { stdio: 'ignore' }).status !== 0) {
    fail('Pillow not found — pip install pillow / apt install python3-pil')
  }
  log('generating demo artwork (samples/generate-artwork.py)')
  fs.mkdirSync(path.join(DIST, 'artwork'), { recursive: true })
  run('python3', ['samples/generate-artwork.py'])
}

// --- feature: Play Store feature graphic rendered from samples/feature.html ---

function findChromium(): string | null {
  for (const cmd of ['chromium', 'chromium-browser', 'google-chrome']) if (has(cmd)) return cmd
  for (const app of ['/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']) {
    if (fs.existsSync(app)) return app
  }
  return null
}

function generateFeature() {
  const chromium = findChromium()
  if (!chromium) fail('chromium/chrome not found — needed to render samples/feature.html')
  fs.mkdirSync(DIST, { recursive: true })
  log('rendering samples/feature.html → dist/feature.png (1024×500)')
  run(chromium, ['--headless', '--window-size=1024,500', '--force-device-scale-factor=1',
    '--no-sandbox', '--disable-gpu', `--screenshot=${path.join(DIST, 'feature.png')}`,
    path.join(SAMPLES, 'feature.html')])
}

// --- icon: Play Store listing icon (512×512, no alpha) from the app icon ---

function generateIcon() {
  const magick = findImageMagick()
  fs.mkdirSync(DIST, { recursive: true })
  log('generating dist/icon-512.png from assets/images/icon.png')
  // Flattened over the icon's own dark background color (Play rejects alpha)
  run(magick, ['assets/images/icon.png', '-resize', '512x512',
    '-background', '#2a2a2a', '-alpha', 'remove', '-alpha', 'off',
    path.join(DIST, 'icon-512.png')])
}

// --- screenshots: Play Store screenshots + web/README refresh ---

// Screens shared with the website; the README composite is stitched from them
const WEB_SCREENS = ['01-library.png', '02-player.png', '03-clips.png', '05-history.png']
const README_COMPOSITE_ORDER = ['02-player', '01-library', '03-clips', '05-history']

// Pipeline: ensure demo audio/artwork → clear app data → push the seed
// bundle → status-bar demo mode → maestro flow (the app seeds itself on
// launch) → collect shots into dist/screenshots/ → refresh web/assets/ copies
// and restitch the README composite (docs/screenshots.png).
// Customize samples/data.json, then re-run.
function generateScreenshots() {
  requireEmulator('generate --screenshots')
  requireMaestro()
  findImageMagick() // fail before shooting, not after

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

  const out = path.join(ROOT, 'dist/.maestro-out')
  const shots = path.join(ROOT, 'dist/screenshots')
  try {
    fs.rmSync(out, { recursive: true, force: true })
    fs.rmSync(shots, { recursive: true, force: true })
    log('running maestro flow')
    maestroRun(['--test-output-dir', out, 'maestro/playstore/screenshots.yaml'])
  } finally {
    demo('-e', 'command', 'exit')
  }

  fs.mkdirSync(shots, { recursive: true })
  // Flow succeeded, so every PNG in the output dir is a takeScreenshot product
  // (failure screenshots only exist on failed flows, which never reach here)
  run('bash', ['-c', `find ${out} -name '*.png' -exec cp {} ${shots}/ \\;`])
  if (fs.readdirSync(shots).length === 0) {
    fail(`no screenshots found under ${out} (dir kept for inspection) — ` +
      'maestro output layout change? Toolkit is tested against maestro >= 2.8')
  }
  fs.rmSync(out, { recursive: true, force: true })
  log(`collected ${fs.readdirSync(shots).length} screenshots in dist/screenshots/`)

  refreshWebScreens(shots)
}

// Copy the website's screenshots from the fresh set and restitch the README
// composite. Touches committed files (web/assets/, docs/screenshots.png) —
// callers are responsible for committing the refresh.
function refreshWebScreens(shots: string) {
  log('refreshing web/assets/ screenshots')
  for (const name of WEB_SCREENS) {
    const src = path.join(shots, name)
    if (!fs.existsSync(src)) fail(`expected screenshot missing: ${name} (flow drift?)`)
    fs.copyFileSync(src, path.join(ROOT, 'web/assets', name))
  }
  log('restitching README composite (docs/screenshots.png)')
  run(findImageMagick(), [
    ...README_COMPOSITE_ORDER.map(n => `web/assets/${n}.png`),
    '-resize', 'x1200', '-background', 'none', '-splice', '12x0', '+append', '-chop', '12x0',
    'docs/screenshots.png',
  ])
}

// Push the demo seed bundle; the app wipes its DB and self-seeds on next
// launch (src/actions/seed_demo_data.ts)
function pushSamples() {
  requireEmulator('device put --samples')
  generateAudio() // cached, dependency-free
  const artworkDir = path.join(DIST, 'artwork')
  if (!fs.existsSync(artworkDir) || fs.readdirSync(artworkDir).length === 0) {
    generateArtwork() // needs Pillow; fails with an install hint
  }
  const demoDir = `/sdcard/Android/data/${APP}/files/demo`
  log('clearing app data')
  adbShell('pm', 'clear', APP)
  log('pushing seed bundle')
  adbShell('mkdir', '-p', demoDir)
  adb('push', path.join(ROOT, 'dist/artwork') + '/.', demoDir + '/')
  adb('push', path.join(ROOT, 'dist/audio') + '/.', demoDir + '/')
  // seed.json last: its presence triggers seeding, so the rest must already be there
  adb('push', path.join(ROOT, 'samples/data.json'), `${demoDir}/seed.json`)
}

// ---------------------------------------------------------------------------
// prepare — the release pipeline, start to finish. Interactive (keystore
// password) and long: run it on the Mac from a terminal and walk away after
// the password prompt. Design: docs/2026-08-11-release-command.md.

const PREPARE_USAGE = 'usage: prepare --version <X.Y.Z> --changes <markdown> [--screenshots]'

// --- pure helpers (unit-tested) ---

// Error message, or null when `next` is a valid successor of `current`
export function validateNextVersion(next: string, current: string): string | null {
  const n = parseSemver(next)
  if (!n) return `invalid version "${next}" (expected X.Y.Z)`
  if (n.minor >= 100 || n.patch >= 100) {
    return `minor and patch must stay < 100 or versionCode ordering breaks (got ${next})`
  }
  const c = parseSemver(current)
  if (!c) return `current package.json version "${current}" is not X.Y.Z`
  if (versionCode(n) <= versionCode(c)) return `version ${next} is not above the current ${current}`
  return null
}

export function hasVersionSection(md: string, version: string): boolean {
  return new RegExp(`^## ${version.replace(/\./g, '\\.')}\\b`, 'm').test(md)
}

// Insert the new version's section above the previous newest one (the log is
// newest-first: a prose header, then `## x.y.z ...` sections)
export function insertVersionSection(
  md: string, version: string, code: number, date: string, changes: string,
): string {
  const section = `## ${version} (versionCode ${code}) — ${date}\n\n${changes.trim()}\n`
  const first = md.search(/^## /m)
  if (first < 0) return `${md.trimEnd()}\n\n${section}`
  return `${md.slice(0, first)}${section}\n${md.slice(first)}`
}

export function renderChecklist(version: string, code: number): string {
  return [
    `Release v${version} is built, checked, committed and tagged. Nothing was`,
    'pushed or uploaded — the remaining steps are manual:',
    '',
    `  1. Push:         git push origin master v${version}`,
    `  2. Play Console: upload dist/ivy-${version}.aab (versionCode ${code})`,
    `  3. GitHub:       upload dist/ivy-${version}.apk (tag v${version})`,
  ].join('\n')
}

// --- pipeline ---

const git = (...args: string[]) => capture('git', args).trim()

// Everything that could interrupt the pipeline midway, checked before any
// side effect. Failing here leaves the repo untouched.
function preflight(version: string, screenshots: boolean) {
  if (!process.stdin.isTTY) fail('prepare is interactive (keystore password prompt) — run it from a terminal')

  console.log('Tools:')
  const tool = (name: string, hint = '') =>
    report(has(name), name, has(name) ? 'present' : `not found${hint ? ` — ${hint}` : ''}`)
  tool('java')
  tool('keytool')
  tool('adb')
  tool('maestro', 'install from https://maestro.mobile.dev')
  tool('unzip')
  report(!!findAapt2(), 'aapt2', findAapt2() ?? 'not found in SDK build-tools')
  report(!!findReadelf(), 'llvm-readelf', findReadelf() ?? 'not found in any NDK')
  if (screenshots) {
    const magick = has('magick') || has('convert')
    report(magick, 'imagemagick', magick ? 'present' : 'not found — brew/apt install imagemagick')
    const pillow = spawnSync('python3', ['-c', 'import PIL'], { stdio: 'ignore' }).status === 0
    report(pillow, 'python3 + Pillow', pillow ? 'present' : 'not found — pip install pillow')
  }

  console.log('Environment:')
  report(fs.existsSync(sdkHome()), 'android sdk', sdkHome())
  report(fs.existsSync(path.join(ROOT, 'node_modules')), 'node_modules',
    fs.existsSync(path.join(ROOT, 'node_modules')) ? 'present' : 'missing (npm install)')
  report(fs.existsSync(path.join(ROOT, 'secrets/release.keystore')), 'release keystore',
    fs.existsSync(path.join(ROOT, 'secrets/release.keystore')) ? 'present' : 'missing')
  report(fs.existsSync(path.join(SAMPLES, 'data.json')), 'samples/data.json',
    fs.existsSync(path.join(SAMPLES, 'data.json')) ? 'present' : 'missing')
  try {
    requireEmulator('prepare')
    report(true, 'emulator', serial())
  } catch (e) {
    report(false, 'emulator', e instanceof Fail ? e.message : String(e))
  }
  const lpFile = path.join(ROOT, 'android/local.properties')
  if (fs.existsSync(lpFile)) {
    const sdkDir = fs.readFileSync(lpFile, 'utf8').match(/^sdk\.dir=(.*)$/m)?.[1]
    const polluted = sdkDir !== undefined && !fs.existsSync(sdkDir)
    report(!polluted, 'local.properties', polluted ? `sdk.dir=${sdkDir} does not exist — run \`bin/ivy.ts clean\`` : 'sdk.dir ok')
  }

  console.log('Git and version:')
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
  report(branch === 'master', 'branch', branch)
  const dirty = git('status', '--porcelain', '-uno')
  report(dirty === '', 'working tree', dirty === '' ? 'clean' : `dirty:\n${dirty.replace(/^/gm, '      ')}`)
  const current = pkgVersion()
  const versionError = validateNextVersion(version, current)
  report(versionError === null, 'version', versionError ?? `${current} → ${version} (versionCode ${versionCode(parseSemver(version)!)})`)
  const versionsMd = fs.readFileSync(path.join(ROOT, 'docs/VERSIONS.md'), 'utf8')
  report(!hasVersionSection(versionsMd, version), 'VERSIONS.md',
    hasVersionSection(versionsMd, version) ? `already has a section for ${version}` : `no section for ${version} yet`)
  const tag = git('tag', '-l', `v${version}`)
  report(tag === '', `tag v${version}`, tag === '' ? 'available' : 'already exists')

  if (doctorFailed) {
    fail(`preflight: ${failedChecks.length} check(s) failed (${failedChecks.join(', ')}) — nothing was changed`)
  }
}

function cmdPrepare(args: Args) {
  const version = args.flags.version
  const changes = args.flags.changes
  if (typeof version !== 'string' || typeof changes !== 'string' || changes.trim() === '') fail(PREPARE_USAGE)
  const screenshots = !!args.flags.screenshots

  let stepNo = 0
  const totalSteps = screenshots ? 10 : 9
  const step = (title: string) => console.log(`\n━━━ prepare v${version} · step ${++stepNo}/${totalSteps} — ${title}\n`)

  step('preflight: tools, environment, git state')
  preflight(version, screenshots)

  step('keystore password (from your password manager; held in memory only)')
  const password = promptSecret('Keystore password: ')
  verifyKeystorePassword(password)
  log('password verified — the rest runs unattended, walk away')

  step('build maestro variant (test affordances) + install on emulator')
  runGradle(GRADLE_TASKS.maestro, { ...process.env })
  adb('install', '-r', apkPath('maestro'))

  step('unit tests (jest)')
  run('npx', ['jest', '--silent'])

  step('e2e tests (full maestro suite)')
  pushFixtures()
  maestroRun(['maestro/'])
  checkDeleteMe()

  if (screenshots) {
    step('screenshots: Play Store set + web/README refresh')
    generateScreenshots()
    git('add', 'web/assets', 'docs/screenshots.png')
    if (git('status', '--porcelain', '-uno') !== '') {
      git('commit', '-m', 'web: refresh screenshots')
      log('committed: web: refresh screenshots')
    } else {
      log('screenshots unchanged — nothing to commit')
    }
  }

  step(`bump version to ${version} + log changes in VERSIONS.md`)
  run('npm', ['version', '--no-git-tag-version', version])
  log(`package.json + package-lock.json set to ${version}`)
  const versionsFile = path.join(ROOT, 'docs/VERSIONS.md')
  const code = versionCode(parseSemver(version)!)
  const date = new Date().toISOString().slice(0, 10)
  fs.writeFileSync(versionsFile,
    insertVersionSection(fs.readFileSync(versionsFile, 'utf8'), version, code, date, changes))
  log(`VERSIONS.md: added section ${version} (versionCode ${code})`)

  step('commit release')
  git('add', 'package.json', 'package-lock.json', 'docs/VERSIONS.md')
  git('commit', '-m', `release: v${version}`)
  log(`committed: release: v${version}`)

  step('release build (prebuild --clean + assemble + bundle)')
  const env = { ...process.env, KEYSTORE_PASSWORD: password }
  log('expo prebuild --clean')
  run('npx', ['expo', 'prebuild', '--clean', '--platform', 'android'], { env })
  fixAndroidPerms(ROOT)
  runGradle(GRADLE_TASKS.release, env)

  step('artifact checks + delivery to dist/')
  checkBuiltArtifact(apkPath('release'))
  checkBuiltArtifact(aabPath())
  deliverRelease()

  git('tag', `v${version}`)
  log(`tagged v${version}`)

  console.log(`\n${renderChecklist(version, code)}`)
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
const failedChecks: string[] = []
function report(ok: boolean | null, label: string, detail: string) {
  const mark = ok === null ? '·' : ok ? '✓' : '✗'
  if (ok === false) {
    doctorFailed = true
    failedChecks.push(label)
  }
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
      ? 'none — try `bin/ivy.ts device connect`' : 'none')
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
  report(fs.existsSync(path.join(ROOT, 'secrets/release.keystore')) ? true : null,
    'release keystore', fs.existsSync(path.join(ROOT, 'secrets/release.keystore')) ? 'present' : 'absent')

  // Pollution check: a Gradle run from the "other machine" leaves its sdk.dir
  // behind and breaks the next build here (CLAUDE.md > Environment)
  const lpFile = path.join(ROOT, 'android/local.properties')
  if (fs.existsSync(lpFile)) {
    const sdkDir = fs.readFileSync(lpFile, 'utf8').match(/^sdk\.dir=(.*)$/m)?.[1]
    const polluted = sdkDir !== undefined && !fs.existsSync(sdkDir)
    report(!polluted, 'local.properties',
      polluted ? `sdk.dir=${sdkDir} does not exist — /workspace is polluted, run \`bin/ivy.ts clean\`` : `sdk.dir ok`)
  } else {
    report(null, 'local.properties', 'absent')
  }

  console.log('Builds:')
  const found = findArtifacts()
  if (found.length === 0) report(null, 'artifacts', 'none found')
  for (const f of found) {
    const stat = fs.statSync(f)
    const mb = (stat.size / 1024 / 1024).toFixed(1)
    const version = artifactVersion(f) ?? 'version unknown'
    console.log(`  · ${f} (${version}, ${mb} MB, ${stat.mtime.toISOString().slice(0, 16).replace('T', ' ')})`)
    if (f.endsWith('.apk')) checkFfmpegClosure(f)
    checkYtdlpTraces(f)
  }

  if (doctorFailed) fail(`doctor: ${failedChecks.length} check(s) failed (${failedChecks.join(', ')})`)
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

function sdkHome(): string {
  return process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
    || (isContainer ? '/opt/android-sdk' : `${os.homedir()}/Library/Android/sdk`)
}

// --- artifact version (doctor) ---

// versionName/versionCode of a built artifact. APKs via aapt2 badging; AABs
// have a proto-XML manifest (no aapt2/bundletool support here), scanned
// byte-wise instead — see protoAttr.
export function artifactVersion(file: string): string | null {
  try {
    if (file.endsWith('.apk')) {
      const aapt2 = findAapt2()
      if (!aapt2) return null
      const out = capture(aapt2, ['dump', 'badging', file], { allowFail: true })
      const m = out.match(/versionCode='(\d+)' versionName='([^']*)'/)
      return m ? `${m[2]} (${m[1]})` : null
    }
    const manifest = execFileSync('unzip', ['-p', file, 'base/manifest/AndroidManifest.xml'])
    const name = protoAttr(manifest, 'versionName')
    const code = protoAttr(manifest, 'versionCode')
    return name && code ? `${name} (${code})` : null
  } catch {
    return null
  }
}

function findAapt2(): string | null {
  const bt = path.join(sdkHome(), 'build-tools')
  if (!fs.existsSync(bt)) return null
  for (const v of fs.readdirSync(bt).sort().reverse()) {
    const aapt2 = path.join(bt, v, 'aapt2')
    if (fs.existsSync(aapt2)) return aapt2
  }
  return null
}

// Extract an attribute value from an aapt2 proto-XML manifest. XmlAttribute
// serializes as `12 <len> <name> 1a <len> <value>` (field 2 = name, field 3 =
// value, both length-prefixed strings). Good for values < 128 bytes, which
// covers version attributes.
export function protoAttr(buf: Buffer, name: string): string | null {
  const needle = Buffer.concat([Buffer.from([0x12, name.length]), Buffer.from(name)])
  const i = buf.indexOf(needle)
  if (i < 0) return null
  const p = i + needle.length
  const len = buf[p + 1]
  if (buf[p] !== 0x1a || len === undefined || len > 127) return null
  return buf.subarray(p + 2, p + 2 + len).toString('utf8')
}

// --- yt-dlp trace scan ---
// The ffmpeg runtime is vendored precisely so shipped artifacts carry no
// yt-dlp lineage (Play flags YouTube downloaders — see
// docs/2026-08-04-vendor-ffmpeg.md). Extract the artifact and byte-scan every
// entry (DEX included) plus entry names for the known fingerprints.

const YTDLP_PATTERNS = ['yausername', 'youtubedl', 'yt-dlp', 'ytdlp', 'junkfood02']

function checkYtdlpTraces(artifact: string) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdlp-scan-'))
  try {
    capture('unzip', ['-o', '-q', artifact, '-d', workDir], { allowFail: true })
    const hits = new Set<string>()
    const walk = (dir: string) => {
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name)
        if (fs.statSync(p).isDirectory()) {
          walk(p)
          continue
        }
        const rel = path.relative(workDir, p)
        const data = fs.readFileSync(p)
        for (const pattern of YTDLP_PATTERNS) {
          if (rel.toLowerCase().includes(pattern)) hits.add(`"${pattern}" in name: ${rel}`)
          if (data.includes(pattern)) hits.add(`"${pattern}" in ${rel}`)
        }
      }
    }
    walk(workDir)
    const detail = hits.size === 0 ? 'none found' : [...hits].slice(0, 4).join(', ')
    report(hits.size === 0, 'yt-dlp traces', detail)
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true })
  }
}

function findReadelf(): string | null {
  const ndkRoot = path.join(sdkHome(), 'ndk')
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
const VALUED_FLAGS = new Set(['device', 'arch', 'file', 'inline', 'tap', 'nav', 'tag', 'version', 'changes', 'port'])

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
  dev: cmdDev,
  test: cmdTest,
  drive: cmdDrive,
  generate: cmdGenerate,
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
  if (!handler) fail(`unknown command: ${cmd} (see \`bin/ivy.ts help\`)`)
  const args = parseArgs(rest)
  if (args.flags.device) deviceFlag = String(args.flags.device)
  handler(args)
}

if (path.basename(process.argv[1] ?? '').startsWith('ivy')) {
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
