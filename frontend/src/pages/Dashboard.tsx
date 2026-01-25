import React, { useEffect, useState } from 'react'
import DashboardControls from '../components/DashboardControls'
import SidebarFeed from '../components/SidebarFeed'

export default function Dashboard() {
  const [running, setRunning] = useState(false)

  const start = async () => {
    const token = localStorage.getItem('token')
    await fetch('/api/dashboard/start', { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
    setRunning(true)
  }
  const stop = async () => {
    const token = localStorage.getItem('token')
    await fetch('/api/dashboard/stop', { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
    setRunning(false)
  }

  useEffect(() => {
    // Optionally fetch initial automation state
  }, [])

  return (
    <div className="min-h-screen bg-gray-50 flex">
      <div className="flex-1 max-w-6xl mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-3xl font-bold text-gray-800">Dashboard</h1>
            <p className="text-gray-600 mt-2">Campaign statistics will be displayed here</p>
          </div>
          <DashboardControls onStart={start} onStop={stop} running={running} />
        </div>

        <div className="bg-white rounded-lg p-6">Main dashboard content (charts, stats)</div>
      </div>
      <SidebarFeed />
    </div>
  )
}
