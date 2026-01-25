import React, { useEffect, useState } from 'react'

export default function SidebarFeed() {
  const [events, setEvents] = useState<Array<{ id: number; text: string }>>([])

  useEffect(() => {
    const token = localStorage.getItem('token')
    const url = `/api/dashboard/events?token=${encodeURIComponent(token || '')}`
    const es = new EventSource(url)
    let id = 0
    es.onmessage = (e) => {
      try {
        const payload = JSON.parse(e.data)
        id += 1
        setEvents(prev => [{ id, text: payload.text }, ...prev].slice(0, 200))
      } catch (err) { }
    }
    es.onerror = (err) => {
      console.error('SSE error', err)
      es.close()
    }
    return () => es.close()
  }, [])

  return (
    <div className="w-80 bg-white border-l p-4 overflow-y-auto">
      <h3 className="font-semibold mb-2">Live Feed</h3>
      <div className="space-y-3">
        {events.map(ev => (
          <div key={ev.id} className="p-2 bg-gray-50 rounded">
            <div className="text-sm text-gray-800">{ev.text}</div>
          </div>
        ))}
        {events.length === 0 && <div className="text-sm text-gray-500">No events yet</div>}
      </div>
    </div>
  )
}
