import React, { useEffect, useState } from 'react'

interface Account {
  id: number;
  account_identifier: string;
}

interface AccountStats {
  dms_sent: number;
  comment_replies: number;
}

export default function StatsPanel({ accounts }: { accounts: Account[] }) {
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
  }, [activeTab, startDate, endDate])

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
            comment_replies: result.comment_replies || 0
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
        setStats({
          [activeTab]: {
            dms_sent: data.dms_sent || 0,
            comment_replies: data.comment_replies || 0
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
        <div className="grid grid-cols-2 gap-4 mt-6">
          <div className="bg-blue-50 rounded-lg p-6 border border-blue-200">
            <div className="text-sm font-medium text-blue-600 mb-2">Total # of DMs sent</div>
            <div className="text-3xl font-bold text-blue-900">{currentStats.dms_sent}</div>
          </div>
          <div className="bg-green-50 rounded-lg p-6 border border-green-200">
            <div className="text-sm font-medium text-green-600 mb-2">Total # of comment replies posted</div>
            <div className="text-3xl font-bold text-green-900">{currentStats.comment_replies}</div>
          </div>
        </div>
      )}
    </div>
  )
}
