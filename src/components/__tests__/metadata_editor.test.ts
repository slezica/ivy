import { editedField } from '../MetadataEditor'

describe('editedField', () => {
  it('keeps null when an empty input was never set (untouched)', () => {
    expect(editedField('', null)).toBeNull()
    expect(editedField('  ', null)).toBeNull()
  })

  it('marks a cleared prior value as edited-and-cleared', () => {
    expect(editedField('', 'A Voice')).toBe('')
    expect(editedField('  ', 'A Voice')).toBe('')
  })

  it('keeps a previously cleared field cleared', () => {
    expect(editedField('', '')).toBe('')
  })

  it('saves trimmed input when present', () => {
    expect(editedField(' A Voice ', null)).toBe('A Voice')
    expect(editedField('New', 'Old')).toBe('New')
  })
})
