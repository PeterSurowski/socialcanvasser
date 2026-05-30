import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'

interface SpecialNote {
  id: number
  tiktok_username: string
  note_text: string
  created_at: string
  updated_at: string
}

export default function SpecialNotesUser() {
  const { username = '' } = useParams()
  const navigate = useNavigate()
  const normalizedUsername = useMemo(() => decodeURIComponent(username).replace(/^@/, '').trim().toLowerCase(), [username])

  const [notes, setNotes] = useState<SpecialNote[]>([])
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editingText, setEditingText] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)
  const [deletingIds, setDeletingIds] = useState<number[]>([])

  const fetchNotes = async () => {
    const token = localStorage.getItem('token')
    setLoading(true)
    try {
      const res = await fetch(`/api/dashboard/affiliate/special-notes/${encodeURIComponent(normalizedUsername)}`, {
        headers: { Authorization: `Bearer ${token}` }
      })

      if (!res.ok) {
        setNotes([])
        return
      }

      const data = await res.json()
      setNotes(data.notes || [])
    } catch (error) {
      console.error('Failed to load special notes:', error)
      setNotes([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!normalizedUsername) {
      navigate('/dashboard')
      return
    }
    fetchNotes()
  }, [normalizedUsername])

  const handleEditStart = (note: SpecialNote) => {
    setEditingId(note.id)
    setEditingText(note.note_text)
    setMessage(null)
  }

  const handleEditSave = async () => {
    if (!editingId || !editingText.trim()) return

    setSavingEdit(true)
    const token = localStorage.getItem('token')
    try {
      const res = await fetch(`/api/dashboard/affiliate/special-notes/${editingId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ noteText: editingText.trim() })
      })

      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setMessage(data?.message || 'Failed to update note')
        return
      }

      setEditingId(null)
      setEditingText('')
      setMessage('Note updated')
      await fetchNotes()
    } catch (error) {
      console.error('Failed to update note:', error)
      setMessage('Failed to update note')
    } finally {
      setSavingEdit(false)
    }
  }

  const handleDelete = async (noteId: number) => {
    setDeletingIds((prev) => [...prev, noteId])
    const token = localStorage.getItem('token')
    try {
      await fetch(`/api/dashboard/affiliate/special-notes/${noteId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      })
      await fetchNotes()
      setMessage('Note deleted')
    } catch (error) {
      console.error('Failed to delete note:', error)
      setMessage('Failed to delete note')
    } finally {
      setDeletingIds((prev) => prev.filter((id) => id !== noteId))
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-800">Special Notes</h1>
            <p className="text-gray-600 mt-1">@{normalizedUsername}</p>
          </div>
          <Link
            to="/dashboard"
            className="px-4 py-2 bg-gray-700 text-white rounded-lg hover:bg-gray-800"
          >
            Back to Dashboard
          </Link>
        </div>

        {message && (
          <div className="mb-4 p-3 rounded-lg bg-blue-50 border border-blue-200 text-sm text-blue-800">
            {message}
          </div>
        )}

        {loading ? (
          <div className="bg-white rounded-lg shadow-sm p-6 text-gray-500">Loading notes...</div>
        ) : notes.length === 0 ? (
          <div className="bg-white rounded-lg shadow-sm p-6 text-gray-500">No notes yet for this user.</div>
        ) : (
          <div className="space-y-3">
            {notes.map((note) => (
              <div key={note.id} className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
                {editingId === note.id ? (
                  <div className="space-y-3">
                    <textarea
                      value={editingText}
                      onChange={(e) => setEditingText(e.target.value)}
                      rows={4}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                    />
                    <div className="flex gap-2 justify-end">
                      <button
                        onClick={() => {
                          setEditingId(null)
                          setEditingText('')
                        }}
                        className="px-3 py-1.5 border border-gray-300 rounded-lg hover:bg-gray-50"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={handleEditSave}
                        disabled={savingEdit || !editingText.trim()}
                        className="px-3 py-1.5 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
                      >
                        {savingEdit ? 'Saving...' : 'Save'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <p className="text-gray-800 whitespace-pre-wrap">{note.note_text}</p>
                    <div className="mt-3 flex items-center justify-between text-xs text-gray-500">
                      <span>Added {new Date(note.created_at).toLocaleString()}</span>
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleEditStart(note)}
                          className="px-2 py-1 rounded border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleDelete(note.id)}
                          disabled={deletingIds.includes(note.id)}
                          className="px-2 py-1 rounded border border-red-200 bg-red-50 text-red-700 hover:bg-red-100 disabled:opacity-50"
                        >
                          {deletingIds.includes(note.id) ? 'Deleting...' : 'Delete'}
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
