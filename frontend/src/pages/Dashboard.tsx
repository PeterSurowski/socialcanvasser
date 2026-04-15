import React, { useEffect, useState } from 'react'
import DashboardControls from '../components/DashboardControls'
import SidebarFeed from '../components/SidebarFeed'
import Settings from '../components/Settings'
import StatsPanel from '../components/StatsPanel'

interface Account {
  id: number;
  account_identifier: string;
  is_active: boolean;
  session_data: string;
  is_paused?: boolean;
}

export default function Dashboard() {
  const [running, setRunning] = useState(false)
  const [affiliateRunning, setAffiliateRunning] = useState(false)
  const [accounts, setAccounts] = useState<Account[]>([])
  const [needsSetup, setNeedsSetup] = useState<Account[]>([])
  const [showSetupModal, setShowSetupModal] = useState(false)
  const [activeTab, setActiveTab] = useState<'overview' | 'settings' | 'affiliate'>('overview')

  const fetchAccounts = async () => {
    const token = localStorage.getItem('token')
    const res = await fetch('/api/dashboard/stats', {
      headers: { Authorization: `Bearer ${token}` }
    })
    if (res.ok) {
      const data = await res.json()
      setAccounts(data.accounts || [])
      setRunning(Boolean(data.automation?.is_running))
      
      // Check which accounts need setup (old accounts without ready flag)
      const needsSetupList = (data.accounts || []).filter((acc: Account) => {
        try {
          const sessionData = JSON.parse(acc.session_data || '{}')
          return !sessionData.ready && acc.is_active
        } catch {
          return acc.is_active
        }
      })
      setNeedsSetup(needsSetupList)
    }
  }

  const handleReconnect = async (accountId: number) => {
    const token = localStorage.getItem('token')
    await fetch('/api/onboarding/tiktok/complete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ accountId })
    })
    setShowSetupModal(false)
    fetchAccounts()
  }

  const start = async () => {
    const token = localStorage.getItem('token')
    const res = await fetch('/api/dashboard/start', { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
    if (res.ok) {
      setRunning(true)
    }
  }
  
  const stop = async () => {
    const token = localStorage.getItem('token')
    const res = await fetch('/api/dashboard/stop', { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
    if (res.ok) {
      setRunning(false)
    }
  }

  const startAffiliate = async () => {
    const token = localStorage.getItem('token')
    const res = await fetch('/api/dashboard/affiliate/start', { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
    if (res.ok) {
      setAffiliateRunning(true)
    }
  }

  const stopAffiliate = async () => {
    const token = localStorage.getItem('token')
    const res = await fetch('/api/dashboard/affiliate/stop', { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
    if (res.ok) {
      setAffiliateRunning(false)
    }
  }

  useEffect(() => {
    fetchAccounts()
  }, [])

  return (
    <div className="min-h-screen bg-gray-50 flex">
      <div className="flex-1 max-w-6xl mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-3xl font-bold text-gray-800">Dashboard</h1>
            <p className="text-gray-600 mt-2">Manage your campaigns and settings</p>
          </div>
          {activeTab === 'overview' && (
            <DashboardControls onStart={start} onStop={stop} running={running} />
          )}
          {activeTab === 'affiliate' && (
            <div className="flex items-center gap-3">
              <span className={`px-3 py-1 rounded-full text-sm font-medium ${affiliateRunning ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'}`}>
                {affiliateRunning ? '🟢 Running' : '⚫ Stopped'}
              </span>
              {!affiliateRunning ? (
                <button
                  onClick={startAffiliate}
                  className="px-5 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 font-semibold"
                >
                  Start Affiliate
                </button>
              ) : (
                <button
                  onClick={stopAffiliate}
                  className="px-5 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 font-semibold"
                >
                  Stop Affiliate
                </button>
              )}
            </div>
          )}
        </div>

        {/* Tab Navigation */}
        <div className="mb-6 border-b border-gray-200">
          <nav className="-mb-px flex gap-8">
            <button
              onClick={() => setActiveTab('overview')}
              className={`py-2 px-1 border-b-2 font-medium text-sm ${
                activeTab === 'overview'
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Overview
            </button>
            <button
              onClick={() => setActiveTab('affiliate')}
              className={`py-2 px-1 border-b-2 font-medium text-sm ${
                activeTab === 'affiliate'
                  ? 'border-purple-600 text-purple-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Affiliate Procurement
            </button>
            <button
              onClick={() => setActiveTab('settings')}
              className={`py-2 px-1 border-b-2 font-medium text-sm ${
                activeTab === 'settings'
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Settings
            </button>
          </nav>
        </div>

        {/* Tab Content */}
        {activeTab === 'overview' && (
          <>
            {/* Setup Warning Banner */}
            {needsSetup.length > 0 && (
              <div className="bg-yellow-50 border-l-4 border-yellow-400 p-4 mb-6">
                <div className="flex items-start">
                  <div className="flex-shrink-0">
                    <svg className="h-5 w-5 text-yellow-400" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                    </svg>
                  </div>
                  <div className="ml-3 flex-1">
                    <h3 className="text-sm font-medium text-yellow-800">Action Required: Reconnect TikTok Accounts</h3>
                    <div className="mt-2 text-sm text-yellow-700">
                      <p>These accounts need to be reconnected:</p>
                      <ul className="mt-1 list-disc list-inside">
                        {needsSetup.map(a => (
                          <li key={a.id}>@{a.account_identifier} (ID: {a.id})</li>
                        ))}
                      </ul>
                      <p className="mt-2 text-xs">This is a one-time setup after the app update.</p>
                    </div>
                    <button
                      onClick={() => setShowSetupModal(true)}
                      className="mt-3 text-sm font-medium text-yellow-800 hover:text-yellow-900 underline"
                    >
                      Fix Now →
                    </button>
                  </div>
                </div>
              </div>
            )}

            <div className="bg-white rounded-lg p-6">
              <StatsPanel accounts={accounts} onRefreshAccounts={fetchAccounts} />
            </div>
          </>
        )}

        {/* Affiliate Procurement Tab */}
        {activeTab === 'affiliate' && (
          <div className="bg-white rounded-lg shadow-sm p-8 max-w-2xl">
            <div className="flex items-center gap-3 mb-4">
              <span className="text-3xl">🤝</span>
              <div>
                <h2 className="text-xl font-bold text-gray-800">Affiliate Procurement</h2>
                <p className="text-sm text-gray-500">
                  Automatically comment on creator videos and send affiliate invitation DMs
                </p>
              </div>
            </div>

            <div className="bg-purple-50 border border-purple-200 rounded-lg p-4 mb-6 text-sm text-purple-800">
              <strong>How it works:</strong>
              <ol className="list-decimal list-inside mt-2 space-y-1">
                <li>Searches TikTok for your keywords</li>
                <li>Navigates to each video, likes it, and reads the comments</li>
                <li>Posts a brand-voice-aligned AI comment</li>
                <li>Adds the creator as a prospect on that account</li>
                <li>After the snooze period expires, sends your affiliate invitation DM</li>
              </ol>
            </div>

            <div className={`flex items-center gap-3 p-4 rounded-lg mb-6 ${affiliateRunning ? 'bg-green-50 border border-green-200' : 'bg-gray-50 border border-gray-200'}`}>
              <div className={`w-3 h-3 rounded-full ${affiliateRunning ? 'bg-green-500 animate-pulse' : 'bg-gray-400'}`} />
              <span className="font-medium text-gray-700">
                {affiliateRunning ? 'Affiliate Procurement is running…' : 'Affiliate Procurement is stopped'}
              </span>
            </div>

            <div className="flex gap-4">
              <button
                onClick={startAffiliate}
                disabled={affiliateRunning}
                className="px-6 py-3 bg-purple-600 text-white rounded-lg font-semibold hover:bg-purple-700 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                ▶ Start
              </button>
              <button
                onClick={stopAffiliate}
                disabled={!affiliateRunning}
                className="px-6 py-3 bg-red-600 text-white rounded-lg font-semibold hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                ■ Stop
              </button>
            </div>

            <p className="text-xs text-gray-400 mt-4">
              Configure brand voice, snooze days, and the invitation message under the{' '}
              <button onClick={() => setActiveTab('settings')} className="text-blue-500 underline">
                Settings
              </button>{' '}
              tab.
            </p>
          </div>
        )}

        {/* Settings Tab */}
        {activeTab === 'settings' && (
          <Settings />
        )}
      </div>
      <SidebarFeed />

      {/* Reconnect Modal */}
      {showSetupModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg p-6 max-w-2xl w-full">
            <h3 className="text-2xl font-bold text-gray-800 mb-4">Reconnect TikTok Accounts</h3>
            
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
              <h4 className="font-semibold text-blue-900 mb-2">📋 Quick Setup:</h4>
              <ol className="list-decimal list-inside space-y-2 text-sm text-blue-800">
                <li>Double-click <code className="bg-blue-100 px-2 py-1 rounded">launch-chrome.bat</code> (close existing Chrome first)</li>
                <li>Wait for Chrome to open with TikTok</li>
                <li>Make sure you're logged into TikTok</li>
                <li>Click "Reconnect" below for each account</li>
              </ol>
            </div>

            <div className="space-y-3 mb-6">
              {needsSetup.map((account) => (
                <div key={account.id} className="flex items-center justify-between p-3 border rounded-lg">
                  <div>
                    <span className="font-medium">@{account.account_identifier}</span>
                    <span className="text-sm text-gray-500 ml-2">(Account ID: {account.id})</span>
                  </div>
                  <button
                    onClick={() => handleReconnect(account.id)}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                  >
                    Reconnect
                  </button>
                </div>
              ))}
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setShowSetupModal(false)}
                className="flex-1 py-2 px-4 border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
