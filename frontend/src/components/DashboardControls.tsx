import React from 'react'

export default function DashboardControls({ 
  onStart, 
  onStop, 
  running 
}: { 
  onStart: () => void; 
  onStop: () => void; 
  running: boolean 
}) {
  return (
    <div className="flex gap-3 items-center">
      <button onClick={onStart} disabled={running} className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50">
        Start
      </button>
      <button onClick={onStop} disabled={!running} className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50">
        Stop
      </button>
    </div>
  )
}
