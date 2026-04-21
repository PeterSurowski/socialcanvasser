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

interface KeepInTouchUser {
  id: number;
  tiktok_username: string;
  profile_url: string;
  incogniton_account_id: number | null;
  snoozed_until: string | null;
}

interface IgnoreListUser {
  id: number;
  tiktok_username: string;
  profile_url: string;
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
  const [keepInTouchUsers, setKeepInTouchUsers] = useState<KeepInTouchUser[]>([])
  const [keepInTouchLoading, setKeepInTouchLoading] = useState(false)
  const [keepInTouchUsername, setKeepInTouchUsername] = useState('')
  const [keepInTouchSaving, setKeepInTouchSaving] = useState(false)
  const [keepInTouchMessage, setKeepInTouchMessage] = useState<string | null>(null)
  const [removingIds, setRemovingIds] = useState<number[]>([])
  const [ignoreListUsers, setIgnoreListUsers] = useState<IgnoreListUser[]>([])
  const [ignoreListLoading, setIgnoreListLoading] = useState(false)
  const [ignoreListUsername, setIgnoreListUsername] = useState('')
  const [ignoreListSaving, setIgnoreListSaving] = useState(false)
  const [ignoreListMessage, setIgnoreListMessage] = useState<string | null>(null)
  const [removingIgnoreIds, setRemovingIgnoreIds] = useState<number[]>([])

  useEffect(() => {
    fetchStats()
  }, [activeTab, startDate, endDate, accounts])

  useEffect(() => {
    fetchKeepInTouchUsers()
    fetchIgnoreListUsers()
  }, [activeTab, accounts])

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

  const fetchKeepInTouchUsers = async () => {
    setKeepInTouchLoading(true)
    const token = localStorage.getItem('token')

    try {
      const accountIdParam = activeTab === 'overall' ? 'overall' : String(activeTab)
      const res = await fetch(`/api/dashboard/affiliate/keep-in-touch?accountId=${accountIdParam}`, {
        headers: { Authorization: `Bearer ${token}` }
      })

      if (res.ok) {
        const data = await res.json()
        setKeepInTouchUsers(data.users || [])
      } else {
        setKeepInTouchUsers([])
      }
    } catch (error) {
      console.error('Error fetching Keep in Touch users:', error)
      setKeepInTouchUsers([])
    } finally {
      setKeepInTouchLoading(false)
    }
  }

  const handleAddKeepInTouch = async () => {
    const username = keepInTouchUsername.trim().replace(/^@/, '')
    if (!username) return

    setKeepInTouchSaving(true)
    setKeepInTouchMessage(null)

    const token = localStorage.getItem('token')
    try {
      const res = await fetch('/api/dashboard/affiliate/keep-in-touch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ username })
      })

      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setKeepInTouchMessage(data?.message || 'Failed to add Keep in Touch user')
        return
      }

      setKeepInTouchUsername('')
      setKeepInTouchMessage(`Added @${data?.username || username} to Keep in Touch`)
      await fetchKeepInTouchUsers()
    } catch (error) {
      console.error('Error adding Keep in Touch user:', error)
      setKeepInTouchMessage('Failed to add Keep in Touch user')
    } finally {
      setKeepInTouchSaving(false)
    }
  }

  const handleRemoveKeepInTouch = async (prospectId: number) => {
    setRemovingIds((prev) => [...prev, prospectId])
    setKeepInTouchMessage(null)

    const token = localStorage.getItem('token')
    try {
      const res = await fetch(`/api/dashboard/affiliate/keep-in-touch/${prospectId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      })

      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setKeepInTouchMessage(data?.message || 'Failed to remove Keep in Touch user')
        return
      }

      await fetchKeepInTouchUsers()
      setKeepInTouchMessage('Removed user from Keep in Touch')
    } catch (error) {
      console.error('Error removing Keep in Touch user:', error)
      setKeepInTouchMessage('Failed to remove Keep in Touch user')
    } finally {
      setRemovingIds((prev) => prev.filter((id) => id !== prospectId))
    }
  }

  const fetchIgnoreListUsers = async () => {
    setIgnoreListLoading(true)
    const token = localStorage.getItem('token')

    try {
      const res = await fetch('/api/dashboard/affiliate/ignore-list', {
        headers: { Authorization: `Bearer ${token}` }
      })

      if (res.ok) {
        const data = await res.json()
        setIgnoreListUsers(data.users || [])
      } else {
        setIgnoreListUsers([])
      }
    } catch (error) {
      console.error('Error fetching Ignore List users:', error)
      setIgnoreListUsers([])
    } finally {
      setIgnoreListLoading(false)
    }
  }

  const handleAddIgnoreList = async () => {
    const username = ignoreListUsername.trim().replace(/^@/, '')
    if (!username) return

    setIgnoreListSaving(true)
    setIgnoreListMessage(null)

    const token = localStorage.getItem('token')
    try {
      const res = await fetch('/api/dashboard/affiliate/ignore-list', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ username })
      })

      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setIgnoreListMessage(data?.message || 'Failed to save Ignore List user')
        return
      }

      setIgnoreListUsername('')
      setIgnoreListMessage(`Saved @${data?.username || username} to Ignore List`)
      await fetchIgnoreListUsers()
    } catch (error) {
      console.error('Error adding Ignore List user:', error)
      setIgnoreListMessage('Failed to save Ignore List user')
    } finally {
      setIgnoreListSaving(false)
    }
  }

  const handleRemoveIgnoreList = async (prospectId: number) => {
    setRemovingIgnoreIds((prev) => [...prev, prospectId])
    setIgnoreListMessage(null)

    const token = localStorage.getItem('token')
    try {
      const res = await fetch(`/api/dashboard/affiliate/ignore-list/${prospectId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      })

      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setIgnoreListMessage(data?.message || 'Failed to remove Ignore List user')
        return
      }

      await fetchIgnoreListUsers()
      setIgnoreListMessage('Removed user from Ignore List')
    } catch (error) {
      console.error('Error removing Ignore List user:', error)
      setIgnoreListMessage('Failed to remove Ignore List user')
    } finally {
      setRemovingIgnoreIds((prev) => prev.filter((id) => id !== prospectId))
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
          {activeTab === 'overall' && (
            <div className="space-y-3">
              <div className="bg-indigo-50 rounded-lg p-4 border border-indigo-200 space-y-3">
                <div className="text-sm font-semibold text-indigo-900">Keep in Touch</div>
                <div className="text-xs text-indigo-700">
                  Add a username to Keep in Touch. These prospects stay in normal engagement but never receive affiliate DMs.
                </div>
                <div className="flex items-center gap-2">
                  <span className="px-3 py-2 rounded-lg bg-white border border-gray-300 text-sm text-gray-700 whitespace-nowrap">
                    https://tiktok.com/@
                  </span>
                  <input
                    type="text"
                    value={keepInTouchUsername}
                    onChange={(e) => setKeepInTouchUsername(e.target.value)}
                    placeholder="username"
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-lg"
                  />
                  <button
                    onClick={handleAddKeepInTouch}
                    disabled={keepInTouchSaving || !keepInTouchUsername.trim()}
                    className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-medium disabled:opacity-50"
                  >
                    {keepInTouchSaving ? 'Adding...' : 'Add'}
                  </button>
                </div>
                {keepInTouchMessage && (
                  <div className="text-xs text-indigo-800">{keepInTouchMessage}</div>
                )}
              </div>

              <div className="bg-red-50 rounded-lg p-4 border border-red-200 space-y-3">
                <div className="text-sm font-semibold text-red-900">Ignore List</div>
                <div className="text-xs text-red-700">
                  Add a TikTok user to completely ignore the person with all Incognition profiles.
                </div>
                <div className="flex items-center gap-2">
                  <span className="px-3 py-2 rounded-lg bg-white border border-gray-300 text-sm text-gray-700 whitespace-nowrap">
                    https://tiktok.com/@
                  </span>
                  <input
                    type="text"
                    value={ignoreListUsername}
                    onChange={(e) => setIgnoreListUsername(e.target.value)}
                    placeholder="username"
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-lg"
                  />
                  <button
                    onClick={handleAddIgnoreList}
                    disabled={ignoreListSaving || !ignoreListUsername.trim()}
                    className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white font-medium disabled:opacity-50"
                  >
                    {ignoreListSaving ? 'Saving...' : 'Save'}
                  </button>
                </div>
                {ignoreListMessage && (
                  <div className="text-xs text-red-800">{ignoreListMessage}</div>
                )}
              </div>
            </div>
          )}

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

          <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
            <div className="text-sm font-semibold text-gray-800 mb-2">
              Keep in Touch users {activeTab === 'overall' ? '(all accounts)' : '(this account)'}
            </div>
            {keepInTouchLoading ? (
              <div className="text-sm text-gray-500">Loading Keep in Touch users...</div>
            ) : keepInTouchUsers.length === 0 ? (
              <div className="text-sm text-gray-500">No users in Keep in Touch for this view.</div>
            ) : (
              <div className="space-y-2">
                {keepInTouchUsers.map((user) => (
                  <div key={user.id} className="flex items-center justify-between bg-white border border-gray-200 rounded-lg px-3 py-2">
                    <div>
                      <div className="text-sm font-medium text-gray-800">@{user.tiktok_username}</div>
                      <div className="text-xs text-gray-500">
                        Snoozed until {user.snoozed_until ? new Date(user.snoozed_until).toLocaleDateString() : 'not set'}
                      </div>
                    </div>
                    <button
                      onClick={() => handleRemoveKeepInTouch(user.id)}
                      disabled={removingIds.includes(user.id)}
                      className="px-3 py-1 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded hover:bg-red-100 disabled:opacity-50"
                    >
                      {removingIds.includes(user.id) ? 'Removing...' : 'Remove'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
            <div className="text-sm font-semibold text-gray-800 mb-2">Ignore List</div>
            {ignoreListLoading ? (
              <div className="text-sm text-gray-500">Loading Ignore List...</div>
            ) : ignoreListUsers.length === 0 ? (
              <div className="text-sm text-gray-500">No users in Ignore List.</div>
            ) : (
              <div className="space-y-2">
                {ignoreListUsers.map((user) => (
                  <div key={user.id} className="flex items-center justify-between bg-white border border-gray-200 rounded-lg px-3 py-2">
                    <div className="text-sm font-medium text-gray-800">@{user.tiktok_username}</div>
                    <button
                      onClick={() => handleRemoveIgnoreList(user.id)}
                      disabled={removingIgnoreIds.includes(user.id)}
                      className="px-3 py-1 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded hover:bg-red-100 disabled:opacity-50"
                    >
                      {removingIgnoreIds.includes(user.id) ? 'Removing...' : 'Remove'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
