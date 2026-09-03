import { execFileSync } from 'node:child_process'
import * as path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')

// Debug artifacts (adb dumps, bugreports, stray logs/archives) must never be
// tracked: they publish device identifiers on push and bloat history forever.
// Added after v1.6.3 shipped a 38MB dumpstate zip + adb dumps (commit b2ba7e4).
describe('repository hygiene', () => {
  it('tracks no debug dumps, bugreports, or root-level logs/archives', () => {
    const files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
      .trim().split('\n')

    const offenders = files.filter(f =>
      /^(adb_|dumpstate-|bugreport)/.test(f) ||
      (!f.includes('/') && /\.(zip|log|txt)$/.test(f))
    )

    expect(offenders).toEqual([])
  })
})
