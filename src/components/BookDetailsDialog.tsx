/**
 * BookDetailsDialog
 *
 * The book details viewer/editor pair behind a single dialog slot (clips
 * pattern): viewer's Edit swaps in the editor, Cancel/backdrop returns to
 * the viewer, Save persists and closes. Opening triggers lazy extras
 * extraction. Used by the library and player screens.
 */

import { useState, useEffect } from 'react'
import { useStore } from '../store'
import Dialog from './shared/Dialog'
import BookDetails from './BookDetails'
import MetadataEditor from './MetadataEditor'


interface BookDetailsDialogProps {
  bookId: string | null  // null = closed
  onClose: () => void
}

export default function BookDetailsDialog({ bookId, onClose }: BookDetailsDialogProps) {
  const { books, updateBook, extractBookExtras } = useStore()
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    if (bookId) {
      setEditing(false)
      // Lazy backfill: no-op unless the file exists and extras are outdated
      extractBookExtras(bookId).catch(console.error)
    }
  }, [bookId, extractBookExtras])

  const book = bookId ? books[bookId] : null
  if (!bookId || !book) return null

  if (editing) {
    return (
      <Dialog visible onClose={() => setEditing(false)}>
        <MetadataEditor
          book={book}
          onCancel={() => setEditing(false)}
          onSave={async (updates) => {
            await updateBook(bookId, updates)
            onClose()
          }}
        />
      </Dialog>
    )
  }

  return (
    <Dialog visible onClose={onClose}>
      <BookDetails book={book} onClose={onClose} onEdit={() => setEditing(true)} />
    </Dialog>
  )
}
