import { parseArgs, parseHierarchy, nodeCenter } from '../toolkit'

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
