import React, { useEffect, useState } from 'react'

interface Account {
  id: number;
  account_identifier: string;
  is_paused?: boolean;
}

interface AccountStats {
  dms_sent: number;
  comment_replies: number;
  is_paused?: boolean;
}

export default function StatsPanel({
  accounts,
  onRefreshAccounts
}: {
  accounts: Account[];
  onRefreshAccounts?: () => void;
}) {
  const [activeTab, setActiveTab] = useState<'overall' | number>('overall')
  const [startDate, setStartDate] = useState(() => {
    const date = new Date()
    date.setDate(date.getDate() - 30)
    return date.toISOString().split('T')[0]
  })
  const [endDate, setEndDate] = useState(() => {
    return new Date().toISOString().split('T')[0]
  })
  const [stats, setStats] = useState<Record<number | string, AccountStats>>({})
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    fetchStats()
  }, [activeTab, startDate, endDate, accounts])

  const fetchStats = async () => {
    setLoading(true)
    const token = localStorage.getItem('token')

    try {
      if (activeTab === 'overall') {
        // Fetch overall stats for all accounts
        const promises = accounts.map(account =>
          fetch(`/api/dashboard/account-stats/${account.id}?startDate=${startDate}&endDate=${endDate}`, {
            headers: { Authorization: `Bearer ${token}` }
          }).then(res => res.json())
        )

        const results = await Promise.all(promises)
        const newStats: Record<number, AccountStats> = {}
        
        results.forEach((result, index) => {
          newStats[accounts[index].id] = {
            dms_sent: result.dms_sent || 0,
            comment_replies: result.comment_replies || 0,
            is_paused: accounts[index].is_paused || false
          }
        })

        // Calculate totals
        const totalDms = Object.values(newStats).reduce((sum, s) => sum + s.dms_sent, 0)
        const totalComments = Object.values(newStats).reduce((sum, s) => sum + s.comment_replies, 0)
        
        newStats['overall'] = {
          dms_sent: totalDms,
          comment_replies: totalComments
        }

        setStats(newStats)
      } else {
        // Fetch stats for specific account
        const res = await fetch(`/api/dashboard/account-stats/${activeTab}?startDate=${startDate}&endDate=${endDate}`, {
          headers: { Authorization: `Bearer ${token}` }
        })
        const data = await res.json()
        const account = accounts.find(a => a.id === activeTab)
        setStats({
          [activeTab]: {
            dms_sent: data.dms_sent || 0,
            comment_replies: data.comment_replies || 0,
            is_paused: account?.is_paused || false
          }
        })
      }
    } catch (error) {
      console.error('Error fetching stats:', error)
    } finally {
      setLoading(false)
    }
  }

  const currentStats = activeTab === 'overall' 
    ? stats['overall'] || { dms_sent: 0, comment_replies: 0 }
    : stats[activeTab as number] || { dms_sent: 0, comment_replies: 0 }

  const handleTogglePause = async () => {
    if (activeTab === 'overall') return; // Can't pause/unpause "overall"

    const token = localStorage.getItem('token')
    try {
      const res = await fetch(`/api/dashboard/accounts/${activeTab}/toggle-pause`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      })
      
      if (res.ok) {
        const data = await res.json()
        setStats((prev) => {
          const current = prev[activeTab] || { dms_sent: 0, comment_replies: 0 }
          return {
            ...prev,
            [activeTab]: {
              ...current,
              is_paused: Boolean(data?.is_paused)
            }
          }
        })
        onRefreshAccounts?.()
      }
    } catch (error) {
      console.error('Error toggling pause:', error)
    }
  }

  return (
    <div className="space-y-4">
      {/* Tab Navigation */}
      <div className="border-b border-gray-200">
        <nav className="-mb-px flex gap-2 overflow-x-auto">
          <button
            onClick={() => setActiveTab('overall')}
            className={`py-2 px-4 whitespace-nowrap border-b-2 font-medium text-sm ${
              activeTab === 'overall'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            Overall
          </button>
          {accounts.map(account => (
            <button
              key={account.id}
              onClick={() => setActiveTab(account.id)}
              className={`py-2 px-4 whitespace-nowrap border-b-2 font-medium text-sm ${
                activeTab === account.id
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              {account.account_identifier}
            </button>
          ))}
        </nav>
      </div>

      {/* Date Range Selector */}
      <div className="flex gap-4 items-end">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">From</label>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">To</label>
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg"
          />
        </div>
      </div>

      {/* Stats Display */}
      {loading ? (
        <div className="text-center py-8 text-gray-500">Loading stats...</div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-blue-50 rounded-lg p-6 border border-blue-200">
              <div className="text-sm font-medium text-blue-600 mb-2">Total # of DMs sent</div>
              <div className="text-3xl font-bold text-blue-900">{currentStats.dms_sent}</div>
            </div>
            <div className="bg-green-50 rounded-lg p-6 border border-green-200">
              <div className="text-sm font-medium text-green-600 mb-2">Total # of comment replies posted</div>
              <div className="text-3xl font-bold text-green-900">{currentStats.comment_replies}</div>
            </div>
          </div>

          {/* Account Pause Status (only show for individual account tabs) */}
          {activeTab !== 'overall' && (
            <div className="flex items-center justify-between bg-gray-50 rounded-lg p-4 border border-gray-200">
              <div className="text-sm font-medium text-gray-700">
                {currentStats.is_paused ? '⏸️ Account paused' : '▶️ Account in use'}
              </div>
              <button
                onClick={handleTogglePause}
                className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                  currentStats.is_paused
                    ? 'bg-green-600 hover:bg-green-700 text-white'
                    : 'bg-yellow-600 hover:bg-yellow-700 text-white'
                }`}
              >
                {currentStats.is_paused ? 'Unpause' : 'Pause'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
