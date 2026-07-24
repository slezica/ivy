/**
 * BookDetails
 *
 * Read-only dialog showing a book's metadata extras (summary, narrator,
 * series, ...). Opening it triggers lazy extraction for books whose extras
 * predate the current extractor (see extract_book_extras) — the store book
 * updates in place when extraction lands.
 */

import { View, Text, Image, StyleSheet } from 'react-native'
import { Color, Space } from '../theme'
import { EXTRACTED_METADATA_VERSION } from '../services/audio/ffmetadata'
import type { Book } from '../services'


interface BookDetailsProps {
  book: Book
}

export default function BookDetails({ book }: BookDetailsProps) {
  const extracting =
    book.uri !== null && (book.metadata_version ?? 0) < EXTRACTED_METADATA_VERSION

  const seriesLine = book.series
    ? book.part ? `${book.series} · Part ${book.part}` : book.series
    : null

  const facts: [string, string | null][] = [
    ['Narrator', book.narrator],
    ['Series', seriesLine],
    ['Released', book.date],
    ['Language', book.language],
  ]
  const knownFacts = facts.filter(([, value]) => value !== null)

  const empty = !extracting && knownFacts.length === 0 && !book.summary && !book.subtitle

  return (
    <View style={styles.container}>
      {book.artwork && (
        <Image source={{ uri: book.artwork }} style={styles.artwork} resizeMode="cover" />
      )}

      <View style={styles.heading}>
        <Text style={styles.title}>{book.title ?? book.name}</Text>
        {book.subtitle && <Text style={styles.subtitle}>{book.subtitle}</Text>}
        {book.artist && <Text style={styles.artist}>{book.artist}</Text>}
      </View>

      {knownFacts.length > 0 && (
        <View style={styles.facts}>
          {knownFacts.map(([label, value]) => (
            <View key={label} style={styles.factRow}>
              <Text style={styles.factLabel}>{label}</Text>
              <Text style={styles.factValue}>{value}</Text>
            </View>
          ))}
        </View>
      )}

      {book.summary && <Text style={styles.summary}>{book.summary}</Text>}

      {extracting && <Text style={styles.hint}>Analyzing file…</Text>}
      {empty && <Text style={styles.hint}>No details found in the file</Text>}
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
  heading: {
    alignItems: 'center',
    gap: 4,
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
    color: Color.TEXT,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 14,
    color: Color.TEXT_2,
    textAlign: 'center',
  },
  artist: {
    fontSize: 14,
    color: Color.TEXT_3,
    textAlign: 'center',
  },
  facts: {
    backgroundColor: Color.BACKGROUND_2,
    borderRadius: Space.BORDER_RADIUS,
    padding: 12,
    gap: 8,
  },
  factRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  factLabel: {
    fontSize: 14,
    color: Color.TEXT_3,
  },
  factValue: {
    fontSize: 14,
    color: Color.TEXT,
    flexShrink: 1,
    textAlign: 'right',
  },
  summary: {
    fontSize: 14,
    lineHeight: 21,
    color: Color.TEXT_MUTED,
  },
  hint: {
    fontSize: 14,
    color: Color.TEXT_DISABLED,
    textAlign: 'center',
  },
})
