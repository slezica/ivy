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
    expect(out).toContain('upload dist/ivy-1.7.0.aab (versionCode 10700)')
    expect(out).toContain('upload dist/ivy-1.7.0.apk (tag v1.7.0)')
  })
})
