import {
  parseArgs, parseHierarchy, nodeCenter, protoAttr,
  parseSemver, versionCode, validateNextVersion,
  hasVersionSection, insertVersionSection, renderChecklist,
} from '../ivy'

describe('parseArgs', () => {
  it('separates positionals from boolean flags', () => {
    expect(parseArgs(['maestro', '--install'])).toEqual({
      positionals: ['maestro'],
      flags: { install: true },
    })
  })

  it('consumes values for valued flags', () => {
    expect(parseArgs(['--device', 'emulator-5554', '--tap', 'Walden'])).toEqual({
      positionals: [],
      flags: { device: 'emulator-5554', tap: 'Walden' },
    })
  })
})

describe('parseHierarchy', () => {
  const xml = `<?xml version='1.0'?><hierarchy rotation="0">` +
    `<node index="0" text="" resource-id="root" class="android.widget.FrameLayout" content-desc="" bounds="[0,0][1080,2400]">` +
    `<node index="0" text="Walden" resource-id="" class="android.widget.TextView" content-desc="" bounds="[210,1300][1028,1404]"/>` +
    `</node></hierarchy>`

  it('parses nodes with depth and attributes', () => {
    const nodes = parseHierarchy(xml)
    expect(nodes).toHaveLength(2)
    expect(nodes[0].depth).toBe(0)
    expect(nodes[0].attrs['resource-id']).toBe('root')
    expect(nodes[1].depth).toBe(1)
    expect(nodes[1].attrs.text).toBe('Walden')
  })

  it('computes element centers from bounds', () => {
    const nodes = parseHierarchy(xml)
    expect(nodeCenter(nodes[1])).toEqual([619, 1352])
  })
})

describe('protoAttr', () => {
  // XmlAttribute wire format: 12 <len> name 1a <len> value
  const attr = (name: string, value: string) => Buffer.concat([
    Buffer.from([0x12, name.length]), Buffer.from(name),
    Buffer.from([0x1a, value.length]), Buffer.from(value),
  ])

  it('extracts the value following the attribute name', () => {
    const buf = Buffer.concat([attr('versionCode', '10401'), attr('versionName', '1.4.1')])
    expect(protoAttr(buf, 'versionName')).toBe('1.4.1')
    expect(protoAttr(buf, 'versionCode')).toBe('10401')
  })

  it('returns null for missing attribute or non-string value', () => {
    expect(protoAttr(attr('other', 'x'), 'versionName')).toBeNull()
    const intValue = Buffer.concat([Buffer.from([0x12, 4]), Buffer.from('name'), Buffer.from([0x28, 0x05])])
    expect(protoAttr(intValue, 'name')).toBeNull()
  })
})

describe('parseSemver + versionCode', () => {
  it('parses X.Y.Z and derives the Play versionCode', () => {
    expect(parseSemver('1.6.1')).toEqual({ major: 1, minor: 6, patch: 1 })
    expect(versionCode({ major: 1, minor: 6, patch: 1 })).toBe(10601)
    expect(versionCode({ major: 2, minor: 0, patch: 0 })).toBe(20000)
  })

  it('rejects malformed versions', () => {
    for (const v of ['1.6', '1.6.1.2', 'v1.6.1', '1.6.x', '']) {
      expect(parseSemver(v)).toBeNull()
    }
  })
})

describe('validateNextVersion', () => {
  it('accepts a strictly newer version', () => {
    expect(validateNextVersion('1.7.0', '1.6.1')).toBeNull()
    expect(validateNextVersion('2.0.0', '1.99.99')).toBeNull()
  })

  it('rejects equal or older versions', () => {
    expect(validateNextVersion('1.6.1', '1.6.1')).toMatch(/not above/)
    expect(validateNextVersion('1.6.0', '1.6.1')).toMatch(/not above/)
  })

  it('rejects malformed input', () => {
    expect(validateNextVersion('1.7', '1.6.1')).toMatch(/invalid version/)
    expect(validateNextVersion('1.7.0', 'garbage')).toMatch(/not X\.Y\.Z/)
  })

  it('rejects minor/patch >= 100 (versionCode ordering)', () => {
    expect(validateNextVersion('1.100.0', '1.6.1')).toMatch(/< 100/)
    expect(validateNextVersion('1.7.100', '1.6.1')).toMatch(/< 100/)
  })
})

describe('VERSIONS.md sections', () => {
  const md = [
    '# Version History',
    '',
    'Release log: one section per shipped version, newest first.',
    '',
    '## 1.6.1 (versionCode 10601) — 2026-08-09',
    '',
    'Fixes:',
    '',
    '- Something',
    '',
    '## 1.6.0 (versionCode 10600) — 2026-08-05',
    '',
    '- Older',
    '',
  ].join('\n')

  it('detects existing sections only', () => {
    expect(hasVersionSection(md, '1.6.1')).toBe(true)
    expect(hasVersionSection(md, '1.6.0')).toBe(true)
    expect(hasVersionSection(md, '1.7.0')).toBe(false)
    // "1.6.1" must not match "1.6.10"
    expect(hasVersionSection(md.replace('1.6.1 ', '1.6.10 '), '1.6.1')).toBe(false)
  })

  it('inserts the new section above the previous newest', () => {
    const out = insertVersionSection(md, '1.7.0', 10700, '2026-08-11', 'Features:\n\n- New thing')
    const first = out.indexOf('## 1.7.0 (versionCode 10700) — 2026-08-11')
    expect(first).toBeGreaterThan(0)
    expect(first).toBeLessThan(out.indexOf('## 1.6.1'))
    expect(out).toContain('- New thing')
    // header prose stays above the new section
    expect(out.indexOf('Release log')).toBeLessThan(first)
    // idempotence guard: detection sees what insertion wrote
    expect(hasVersionSection(out, '1.7.0')).toBe(true)
  })

  it('appends when the log has no sections yet', () => {
    const out = insertVersionSection('# Version History\n', '1.0.0', 10000, '2026-08-11', '- First')
    expect(out).toContain('## 1.0.0 (versionCode 10000) — 2026-08-11')
  })
})

describe('renderChecklist', () => {
  it('lists the manual follow-ups with concrete values', () => {
    const out = renderChecklist('1.7.0', 10700)
    expect(out).toContain('git push origin master v1.7.0')
    expect(out).toContain('upload dist/ivy-release-1.7.0.aab (versionCode 10700)')
    expect(out).toContain('upload dist/ivy-release-1.7.0.apk (tag v1.7.0)')
  })
})

describe('R8 artifact helpers', () => {
  const { parseDexMarker, mappingId, mappingRenameRatio, mappingKeptByName, usageRemovals } = require('../ivy')

  it('parses R8 and D8 compiler markers out of DEX bytes', () => {
    const r8 = Buffer.concat([Buffer.from('junk\0'),
      Buffer.from('~~R8{"backend":"dex","pg-map-id":"4a423e7","r8-mode":"full","version":"8.11.18"}'), Buffer.from('\0more')])
    expect(parseDexMarker(r8)).toEqual({ tool: 'R8', mode: 'full', mapId: '4a423e7' })
    const d8 = Buffer.from('~~D8{"backend":"dex","compilation-mode":"release","version":"8.11.18"}')
    expect(parseDexMarker(d8)).toEqual({ tool: 'D8', mode: null, mapId: null })
    expect(parseDexMarker(Buffer.from('no marker here'))).toBeNull()
  })

  const mapping = [
    '# compiler: R8',
    '# pg_map_id: 4a423e7',
    'com.salezica.ivy.BuildInfoModule -> com.salezica.ivy.BuildInfoModule:',
    '    java.lang.String getName() -> getName',
    'com.salezica.ivy.FFmpegEnvironment -> s9.e:',
    'com.salezica.ivy.IvyPackage -> s9.k:',
    '',
  ].join('\n')

  it('reads the mapping id and rename ratio', () => {
    expect(mappingId(mapping)).toBe('4a423e7')
    expect(mappingId('# compiler: R8\n')).toBeNull()
    expect(mappingRenameRatio(mapping)).toEqual({ classes: 3, renamed: 2 })
  })

  it('tells kept-by-name classes from renamed ones', () => {
    expect(mappingKeptByName(mapping, [
      'com.salezica.ivy.BuildInfoModule', 'com.salezica.ivy.FFmpegEnvironment', 'com.salezica.ivy.Missing',
    ])).toEqual(['com.salezica.ivy.BuildInfoModule'])
  })

  it('lists usage.txt removals under the watched prefixes only', () => {
    const usage = [
      'com.doublesymmetry.kotlinaudio.models.BufferConfig',
      'com.rnwhisper.WhisperContext:',
      '    void onProgress(int)',
      '    void onNewSegments(int,int)',
      'com.rnwhisper.Unused',
      'expo.modules.BuildConfig',
      '',
    ].join('\n')
    expect(usageRemovals(usage, ['com.rnwhisper.'])).toEqual([
      'com.rnwhisper.WhisperContext#void onProgress(int)',
      'com.rnwhisper.WhisperContext#void onNewSegments(int,int)',
      'com.rnwhisper.Unused',
    ])
    expect(usageRemovals(usage, ['com.salezica.'])).toEqual([])
  })
})

describe('r8LogHits', () => {
  const { r8LogHits } = require('../ivy')
  const app = 'com.salezica.ivy'
  const log = [
    '09-05 07:00:00.000  1000  1000 I ActivityManager: Start proc 4242:com.salezica.ivy/u0a240 for activity',
    '09-05 07:00:01.000  4242  4242 W System.err: java.lang.ClassNotFoundException: Didn\'t find class "a.b.C" 0x7f3a',
    '09-05 07:00:01.500  4242  4242 W System.err: java.lang.ClassNotFoundException: Didn\'t find class "a.b.C" 0x7f3b',
    '09-05 07:00:02.000  4242  4242 I ReactNativeJS: all fine',
    '09-05 07:00:03.000  9999  9999 E OtherApp: java.lang.NoSuchMethodError: elsewhere',
    '09-05 07:00:04.000  9999  9999 F DEBUG   : >>> com.salezica.ivy <<< Fatal signal 6',
  ].join('\n')

  it('scopes to app pids (plus lines naming the app) and collapses volatile bits', () => {
    const { appLines, hits } = r8LogHits(log, app)
    expect(appLines).toBe(5) // incl. the ActivityManager line naming the app
    expect([...hits.entries()]).toEqual([
      ['System.err: java.lang.ClassNotFoundException: Didn\'t find class "a.b.C" #', 2],
      ['DEBUG   : >>> com.salezica.ivy <<< Fatal signal 6', 1],
    ])
  })
})
