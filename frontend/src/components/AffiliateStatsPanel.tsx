import { useEffect, useState } from 'react'

interface Account {
  id: number;
  account_identifier: string;
  is_paused?: boolean;
}

interface AffiliateAccountStats {
  prospects_in_pipeline: number;
  videos_liked: number;
  comments_left: number;
  users_followed: number;
  prospects_followed_us: number;
  comments_liked: number;
  replies_to_comments: number;
  is_paused?: boolean;
}

export default function AffiliateStatsPanel({
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
  const [endDate, setEndDate] = useState(() => new Date().toISOString().split('T')[0])
  const [stats, setStats] = useState<Record<number | string, AffiliateAccountStats>>({})
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    fetchStats()
  }, [activeTab, startDate, endDate, accounts])

  const fetchStats = async () => {
    setLoading(true)
    const token = localStorage.getItem('token')

    try {
      if (activeTab === 'overall') {
        const promises = accounts.map(account =>
          fetch(`/api/dashboard/affiliate-account-stats/${account.id}?startDate=${startDate}&endDate=${endDate}`, {
            headers: { Authorization: `Bearer ${token}` }
          }).then(res => res.json())
        )

        const results = await Promise.all(promises)
        const perAccount: Record<number | string, AffiliateAccountStats> = {}

        results.forEach((result, index) => {
          const account = accounts[index]
          perAccount[account.id] = {
            prospects_in_pipeline: result.prospects_in_pipeline || 0,
            videos_liked: result.videos_liked || 0,
            comments_left: result.comments_left || 0,
            users_followed: result.users_followed || 0,
            prospects_followed_us: result.prospects_followed_us || 0,
            comments_liked: result.comments_liked || 0,
            replies_to_comments: result.replies_to_comments || 0,
            is_paused: account.is_paused || false
          }
        })

        perAccount.overall = {
          prospects_in_pipeline: Object.values(perAccount).reduce((sum, s) => sum + s.prospects_in_pipeline, 0),
          videos_liked: Object.values(perAccount).reduce((sum, s) => sum + s.videos_liked, 0),
          comments_left: Object.values(perAccount).reduce((sum, s) => sum + s.comments_left, 0),
          users_followed: Object.values(perAccount).reduce((sum, s) => sum + s.users_followed, 0),
          prospects_followed_us: Object.values(perAccount).reduce((sum, s) => sum + s.prospects_followed_us, 0),
          comments_liked: Object.values(perAccount).reduce((sum, s) => sum + s.comments_liked, 0),
          replies_to_comments: Object.values(perAccount).reduce((sum, s) => sum + s.replies_to_comments, 0)
        }

        setStats(perAccount)
      } else {
        const res = await fetch(`/api/dashboard/affiliate-account-stats/${activeTab}?startDate=${startDate}&endDate=${endDate}`, {
          headers: { Authorization: `Bearer ${token}` }
        })

        const data = await res.json()
        const account = accounts.find(a => a.id === activeTab)

        setStats({
          [activeTab]: {
            prospects_in_pipeline: data.prospects_in_pipeline || 0,
            videos_liked: data.videos_liked || 0,
            comments_left: data.comments_left || 0,
            users_followed: data.users_followed || 0,
            prospects_followed_us: data.prospects_followed_us || 0,
            comments_liked: data.comments_liked || 0,
            replies_to_comments: data.replies_to_comments || 0,
            is_paused: account?.is_paused || false
          }
        })
      }
    } catch (error) {
      console.error('Error fetching affiliate stats:', error)
    } finally {
      setLoading(false)
    }
  }

  const currentStats: AffiliateAccountStats = activeTab === 'overall'
    ? stats.overall || {
        prospects_in_pipeline: 0,
        videos_liked: 0,
        comments_left: 0,
        users_followed: 0,
        prospects_followed_us: 0,
        comments_liked: 0,
        replies_to_comments: 0
      }
    : stats[activeTab as number] || {
        prospects_in_pipeline: 0,
        videos_liked: 0,
        comments_left: 0,
        users_followed: 0,
        prospects_followed_us: 0,
        comments_liked: 0,
        replies_to_comments: 0,
        is_paused: false
      }

  const handleTogglePause = async () => {
    if (activeTab === 'overall') return

    const token = localStorage.getItem('token')
    try {
      const res = await fetch(`/api/dashboard/accounts/${activeTab}/toggle-pause`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      })

      if (res.ok) {
        const data = await res.json()
        setStats((prev) => {
          const current = prev[activeTab] || {
            prospects_in_pipeline: 0,
            videos_liked: 0,
            comments_left: 0,
            users_followed: 0,
            prospects_followed_us: 0,
            comments_liked: 0,
            replies_to_comments: 0
          }

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
      console.error('Error toggling account pause:', error)
    }
  }

  const statRows = [
    { label: 'Prospects in the pipeline', value: currentStats.prospects_in_pipeline },
    { label: 'Videos liked', value: currentStats.videos_liked },
    { label: 'Comments left', value: currentStats.comments_left },
    { label: 'Users followed', value: currentStats.users_followed },
    { label: 'Prospects who followed us', value: currentStats.prospects_followed_us },
    { label: 'Comments liked', value: currentStats.comments_liked },
    { label: 'Replies to comments', value: currentStats.replies_to_comments }
  ]

  return (
    <div className="space-y-4">
      <div className="border-b border-gray-200">
        <nav className="-mb-px flex gap-2 overflow-x-auto">
          <button
            onClick={() => setActiveTab('overall')}
            className={`py-2 px-4 whitespace-nowrap border-b-2 font-medium text-sm ${
              activeTab === 'overall'
                ? 'border-purple-600 text-purple-600'
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
                  ? 'border-purple-600 text-purple-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              {account.account_identifier}
            </button>
          ))}
        </nav>
      </div>

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

      {loading ? (
        <div className="text-center py-8 text-gray-500">Loading affiliate stats...</div>
      ) : (
        <div className="space-y-3">
          {statRows.map((stat) => (
            <div key={stat.label} className="bg-purple-50 rounded-lg p-4 border border-purple-200 flex items-center justify-between">
              <div className="text-sm font-medium text-purple-700">{stat.label}</div>
              <div className="text-2xl font-bold text-purple-900">{stat.value}</div>
            </div>
          ))}

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
