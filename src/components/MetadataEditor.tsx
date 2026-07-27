/**
 * MetadataEditor
 *
 * Dialog for editing a book's metadata: title, artist and the extracted
 * extras (narrator, series, summary, ...). Shows artwork (read-only) for
 * context. All fields are shown, empty ones blank — unlike BookDetails,
 * which hides them.
 */

import { useState } from 'react'
import { View, Text, TextInput, Image, StyleSheet } from 'react-native'
import { Color, Space } from '../theme'
import TextButton from './shared/TextButton'
import type { Book, BookEditableFields } from '../services'


/**
 * Value an input saves back to a field. An empty input stays null when the
 * field was never set — extraction may still fill it — but becomes '' when
 * clearing a prior value: the "edited and cleared" marker extraction
 * respects (see fillMissingExtras).
 */
export function editedField(input: string, prior: string | null): string | null {
  const value = input.trim()
  if (value === '' && prior === null) return null
  return value
}

interface MetadataEditorProps {
  book: Book
  onSave: (updates: Partial<BookEditableFields>) => void
  onCancel: () => void
}

const FIELDS: [keyof BookEditableFields, string, { multiline?: boolean }?][] = [
  ['title', 'Title', undefined],
  ['artist', 'Author', undefined],
  ['subtitle', 'Subtitle', undefined],
  ['narrator', 'Narrator', undefined],
  ['series', 'Series', undefined],
  ['part', 'Part', undefined],
  ['date', 'Released', undefined],
  ['language', 'Language', undefined],
  ['summary', 'Summary', { multiline: true }],
]

export default function MetadataEditor({ book, onSave, onCancel }: MetadataEditorProps) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(FIELDS.map(([field]) => [field, book[field] ?? '']))
  )

  const handleSave = () => {
    const updates = Object.fromEntries(
      FIELDS.map(([field]) => [
        field,
        // title/artist keep ''→null (display falls back to book.name);
        // extras distinguish cleared ('') from never-set (null)
        field === 'title' || field === 'artist'
          ? values[field].trim() || null
          : editedField(values[field], book[field]),
      ])
    )
    onSave(updates)
  }

  return (
    <View style={styles.container}>
      {/* Artwork (read-only) */}
      {book.artwork ? (
        <Image source={{ uri: book.artwork }} style={styles.artwork} resizeMode="cover" />
      ) : (
        <View style={styles.artworkPlaceholder}>
          <Text style={styles.artworkPlaceholderIcon}>🎵</Text>
        </View>
      )}

      {/* Fields */}
      <View style={styles.fields}>
        {FIELDS.map(([field, label, options]) => (
          <View key={field}>
            <Text style={styles.fieldLabel}>{label}</Text>
            <TextInput
              style={[styles.input, options?.multiline && styles.inputMultiline]}
              value={values[field]}
              onChangeText={(text) => setValues((v) => ({ ...v, [field]: text }))}
              multiline={options?.multiline}
            />
          </View>
        ))}
      </View>

      {/* Buttons */}
      <View style={styles.buttons}>
        <TextButton label="Cancel" onPress={onCancel} style={styles.button} />
        <TextButton label="Save" onPress={handleSave} variant="primary" style={styles.button} />
      </View>
    </View>
  )
}


const styles = StyleSheet.create({
  container: {
    padding: 24,
    alignItems: 'center',
    gap: 20,
  },
  artwork: {
    width: 120,
    height: 120,
    borderRadius: Space.BORDER_RADIUS,
  },
  artworkPlaceholder: {
    width: 120,
    height: 120,
    borderRadius: Space.BORDER_RADIUS,
    backgroundColor: Color.BACKGROUND_3,
    justifyContent: 'center',
    alignItems: 'center',
  },
  artworkPlaceholderIcon: {
    fontSize: 40,
  },
  fields: {
    width: '100%',
    gap: 12,
  },
  // Same label treatment as the read-only view (BookDetails)
  fieldLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: Color.TEXT_2,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  input: {
    backgroundColor: Color.BACKGROUND_2,
    borderRadius: Space.BORDER_RADIUS,
    padding: 12,
    fontSize: 16,
    color: Color.TEXT,
    borderWidth: 1,
    borderColor: Color.BORDER,
  },
  inputMultiline: {
    minHeight: 100,
    textAlignVertical: 'top',
  },
  buttons: {
    flexDirection: 'row',
    gap: 12,
    width: '100%',
  },
  button: {
    flex: 1,
  },
})
