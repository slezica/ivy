/**
 * BookDetails
 *
 * Read-only view of a book's metadata extras (summary, narrator, series, ...)
 * with Close/Edit buttons — Edit switches to MetadataEditor, mirroring the
 * clip viewer/editor pair. Opening it triggers lazy extraction for books whose
 * extras predate the current extractor (see extract_book_extras) — the store
 * book updates in place when extraction lands. Null and cleared ('') fields
 * are hidden here but stay editable in the editor.
 */

import { View, Text, Image, StyleSheet } from 'react-native'
import { Color, Space } from '../theme'
import { EXTRACTED_METADATA_VERSION } from '../services/audio/ffmetadata'
import TextButton from './shared/TextButton'
import type { Book } from '../services'


interface BookDetailsProps {
  book: Book
  onClose: () => void
  onEdit: () => void
}

export default function BookDetails({ book, onClose, onEdit }: BookDetailsProps) {
  const extracting =
    book.uri !== null && (book.metadata_version ?? 0) < EXTRACTED_METADATA_VERSION

  const seriesLine = book.series
    ? book.part ? `${book.series} · Part ${book.part}` : book.series
    : null

  const facts: [string, string | null][] = [
    ['Author', book.artist],
    ['Subtitle', book.subtitle],
    ['Narrator', book.narrator],
    ['Series', seriesLine],
    ['Released', book.date],
    ['Language', book.language],
    ['Summary', book.summary],
  ]
  // Hide both never-extracted (null) and edited-and-cleared ('') fields
  const knownFacts = facts.filter(([, value]) => value)

  const empty = !extracting && knownFacts.length === 0

  return (
    <View style={styles.container}>
      {book.artwork && (
        <Image source={{ uri: book.artwork }} style={styles.artwork} resizeMode="cover" />
      )}

      <Text style={styles.title}>{book.title ?? book.name}</Text>

      {knownFacts.map(([label, value]) => (
        <View key={label}>
          <Text style={styles.factLabel}>{label}</Text>
          <Text style={styles.factValue}>{value}</Text>
        </View>
      ))}

      {extracting && <Text style={styles.hint}>Analyzing file…</Text>}
      {empty && <Text style={styles.hint}>No details found in the file</Text>}

      <View style={styles.buttons}>
        <TextButton label="Close" onPress={onClose} style={styles.button} />
        <TextButton label="Edit" onPress={onEdit} variant="primary" style={styles.button} />
      </View>
    </View>
  )
}


const styles = StyleSheet.create({
  container: {
    padding: 24,
    gap: 20,
  },
  artwork: {
    width: 120,
    height: 120,
    borderRadius: Space.BORDER_RADIUS,
    alignSelf: 'center',
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
    color: Color.TEXT,
    textAlign: 'center',
  },
  // Property listing matches ClipViewer's transcription/note sections:
  // uppercase label above a wrapping value, no enclosing box
  factLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: Color.TEXT_2,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  factValue: {
    fontSize: 15,
    color: Color.TEXT_MUTED,
    lineHeight: Space.PARAGRAPH_LINE_HEIGHT,
  },
  hint: {
    fontSize: 14,
    color: Color.TEXT_DISABLED,
    textAlign: 'center',
  },
  buttons: {
    flexDirection: 'row',
    gap: 12,
  },
  button: {
    flex: 1,
  },
})
