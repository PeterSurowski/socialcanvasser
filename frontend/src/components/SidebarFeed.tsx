import React, { useEffect, useState } from 'react'

interface FeedEvent {
  id: number;
  text: string;
  url?: string;
  type?: string;
}

export default function SidebarFeed() {
  const [events, setEvents] = useState<FeedEvent[]>([])

  useEffect(() => {
    const token = localStorage.getItem('token')
    const url = `/api/dashboard/events?token=${encodeURIComponent(token || '')}`
    const es = new EventSource(url)
    let id = 0
    es.onmessage = (e) => {
      try {
        const payload = JSON.parse(e.data)
        id += 1
        setEvents(prev => [{ id, text: payload.text, url: payload.url, type: payload.type }, ...prev].slice(0, 200))
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
      <h3 className="font-semibold mb-4 text-lg">Live Feed</h3>
      <div className="space-y-4">
        {events.filter(ev => ev.text && ev.text.trim()).map(ev => {
          // Post header - larger, bold
          if (ev.type === 'post-header') {
            return (
              <div key={ev.id} className="border-t pt-4 mt-4 first:border-t-0 first:pt-0 first:mt-0">
                <a 
                  href={ev.url} 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="text-blue-600 hover:text-blue-800 hover:underline font-semibold text-base"
                >
                  {ev.text ? (ev.text.startsWith('@') ? ev.text : `@${ev.text}`) : '@'}
                </a>
              </div>
            );
          }
          
          // Comment - indented, smaller
          if (ev.type === 'comment') {
            const lines = ev.text.split('\n');
            const commentText = lines[0]; // "Comment text"
            const username = lines[1]; // @username
            const timeAgo = lines[2]; // X days ago
            
            return (
              <div key={ev.id} className="ml-4 pl-3 border-l-2 border-gray-200 py-2">
                <p className="text-sm text-gray-700 mb-1 italic">{commentText}</p>
                <a 
                  href={ev.url} 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="text-blue-500 hover:text-blue-700 text-xs"
                >
                  {username}
                </a>
                <p className="text-xs text-gray-500 mt-0.5">{timeAgo}</p>
              </div>
            );
          }
          
          // Regular event
          return (
            <div key={ev.id} className={`p-2 rounded text-sm ${
              ev.type === 'success' ? 'bg-green-50 border border-green-200 text-green-800' :
              ev.type === 'error' ? 'bg-red-50 border border-red-200 text-red-800' :
              ev.type === 'status' ? 'bg-blue-50 border border-blue-200 text-blue-800' :
              'bg-gray-50 text-gray-700'
            }`}>
              {ev.url ? (
                <a 
                  href={ev.url} 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="hover:underline"
                >
                  {ev.text}
                </a>
              ) : (
                ev.text
              )}
            </div>
          );
        })}
        {events.length === 0 && <div className="text-sm text-gray-500">No events yet</div>}
      </div>
    </div>
  )
}
