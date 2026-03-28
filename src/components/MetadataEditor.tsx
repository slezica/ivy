/**
 * MetadataEditor
 *
 * Dialog for editing a book's title and artist fields.
 * Shows artwork (read-only) for context.
 */

import { useState } from 'react'
import { View, Text, TextInput, TouchableOpacity, Image, StyleSheet } from 'react-native'
import { Color } from '../theme'
import type { Book } from '../services'


interface MetadataEditorProps {
  book: Book
  onSave: (updates: { title: string | null; artist: string | null }) => void
  onCancel: () => void
}

export default function MetadataEditor({ book, onSave, onCancel }: MetadataEditorProps) {
  const [title, setTitle] = useState(book.title ?? '')
  const [artist, setArtist] = useState(book.artist ?? '')

  const handleSave = () => {
    onSave({
      title: title.trim() || null,
      artist: artist.trim() || null,
    })
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
        <TextInput
          style={styles.input}
          value={title}
          onChangeText={setTitle}
          placeholder="Title"
          placeholderTextColor={Color.TEXT_DISABLED}
          autoFocus
        />
        <TextInput
          style={styles.input}
          value={artist}
          onChangeText={setArtist}
          placeholder="Artist"
          placeholderTextColor={Color.TEXT_DISABLED}
        />
      </View>

      {/* Buttons */}
      <View style={styles.buttons}>
        <TouchableOpacity style={styles.button} onPress={onCancel}>
          <Text style={styles.buttonTextCancel}>Cancel</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.button, styles.buttonSave]} onPress={handleSave}>
          <Text style={styles.buttonTextSave}>Save</Text>
        </TouchableOpacity>
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
    borderRadius: 8,
  },
  artworkPlaceholder: {
    width: 120,
    height: 120,
    borderRadius: 8,
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
  input: {
    backgroundColor: Color.BACKGROUND_2,
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    color: Color.TEXT,
    borderWidth: 1,
    borderColor: Color.BORDER,
  },
  buttons: {
    flexDirection: 'row',
    gap: 12,
    width: '100%',
  },
  button: {
    flex: 1,
    padding: 14,
    borderRadius: 8,
    alignItems: 'center',
    backgroundColor: Color.BACKGROUND_3,
  },
  buttonSave: {
    backgroundColor: Color.PRIMARY,
  },
  buttonTextCancel: {
    fontSize: 16,
    fontWeight: '600',
    color: Color.TEXT,
  },
  buttonTextSave: {
    fontSize: 16,
    fontWeight: '600',
    color: Color.BACKGROUND,
  },
})
