import { useState } from 'react'

interface TikTokAccountsProps {
  accounts: string[]
  onUpdate: (accounts: string[]) => void
  onNext: () => void
}

export default function TikTokAccounts({ accounts, onUpdate, onNext }: TikTokAccountsProps) {
  const [showLoginModal, setShowLoginModal] = useState(false)
  const [currentAccountName, setCurrentAccountName] = useState('')
  const [connectionMethod, setConnectionMethod] = useState<'browser' | 'manual' | 'cookies'>('cookies')
  const [manualUsername, setManualUsername] = useState('')
  const [manualPassword, setManualPassword] = useState('')
  const [cookiesJson, setCookiesJson] = useState('')
  const [awaitingVerification, setAwaitingVerification] = useState(false)
  const [pendingAccountId, setPendingAccountId] = useState<number | null>(null)

  const handleAddAccount = () => {
    if (accounts.length >= 10) return
    setShowLoginModal(true)
  }

  const handleLoginComplete = async () => {
    if (!currentAccountName) return

      try {
      if (connectionMethod === 'cookies') {
        // Cookie import flow: create account then import cookies
        const token = localStorage.getItem('token')
        
        // Parse cookies JSON
        let parsedCookies;
        try {
          parsedCookies = JSON.parse(cookiesJson);
          if (!Array.isArray(parsedCookies)) {
            throw new Error('Cookies must be a JSON array');
          }
        } catch (e) {
          alert('Invalid JSON format. Please paste a valid JSON array of cookies.');
          return;
        }
        
        // Create account first
        const createRes = await fetch('/api/onboarding/tiktok/connect', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({ nickname: currentAccountName })
        });
        
        if (!createRes.ok) {
          throw new Error('Failed to create account');
        }
        
        const createData = await createRes.json();
        const accountId = createData.accountId;
        
        // Import cookies
        const importRes = await fetch('/api/onboarding/tiktok/import-cookies', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({ accountId, cookies: parsedCookies })
        });
        
        if (!importRes.ok) {
          throw new Error('Failed to import cookies');
        }
        
        onUpdate([...accounts, currentAccountName]);
        setShowLoginModal(false);
        setCurrentAccountName('');
        setCookiesJson('');
        
      } else if (connectionMethod === 'browser') {
        // Open a same-origin waiting page synchronously to avoid popup blockers.
        // The waiting page (`/onboarding-popup.html`) polls the backend for the container URL.
        const popupToken = Math.random().toString(36).slice(2)
        const popup = window.open(`/onboarding-popup.html?token=${popupToken}`, '_blank', 'noopener,width=1000,height=800')

        // Request backend to start a headful browser session; user will complete login in that server-launched window
        const token = localStorage.getItem('token')
        const res = await fetch('/api/onboarding/tiktok/connect', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({ nickname: currentAccountName })
        })
        if (!res.ok) {
          // close popup if backend failed to start
          try { popup && popup.close() } catch (_) {}
          throw new Error('Failed to initiate connect')
        }
        const data = await res.json()
        if (data && data.accountId) {
          // Server launched a browser for manual login; wait for user to finish in that window
          setAwaitingVerification(true)
          setPendingAccountId(data.accountId)
          try {
            // store the accountId under the popup token so the waiting page can pick it up
            localStorage.setItem('sc_popup_token_' + popupToken, String(data.accountId))
          } catch (e) {}

          // If backend provided a direct URL, try navigating the popup immediately.
          if (data.url && popup) {
            try { (popup as any).location.href = data.url } catch (_) { /* popup will poll */ }
          }
        } else {
          try { popup && popup.close() } catch (_) {}
        }
      } else {
        // Manual credentials path: send to backend for secure storage (backend must handle encryption)
        const token = localStorage.getItem('token')
        const res = await fetch('/api/onboarding/tiktok/manual', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({ nickname: currentAccountName, username: manualUsername, password: manualPassword })
        })
        if (!res.ok) throw new Error('Failed to save credentials')
        // consider verifying server response for success
        onUpdate([...accounts, currentAccountName])
        setShowLoginModal(false)
      }
    } catch (err) {
      console.error('Connect error', err)
      alert('Failed to start connect flow. Please try again.')
    }
  }

  const handleRemoveAccount = (index: number) => {
    onUpdate(accounts.filter((_, i) => i !== index))
  }

  const canContinue = accounts.length >= 1

  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-800 mb-2">Add TikTok Accounts</h2>
      <p className="text-gray-600 mb-6">
        Add at least 3 TikTok accounts for best results. The bot will rotate between accounts to avoid detection.
      </p>

      <div className="space-y-4 mb-6">
        {accounts.map((account, index) => (
          <div
            key={index}
            className="flex items-center justify-between p-4 bg-green-50 border border-green-200 rounded-lg"
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-green-500 rounded-full flex items-center justify-center text-white font-semibold">
                {index + 1}
              </div>
              <span className="font-medium text-gray-800">{account}</span>
            </div>
            <button
              onClick={() => handleRemoveAccount(index)}
              className="text-red-600 hover:text-red-700 font-medium"
            >
              Remove
            </button>
          </div>
        ))}
      </div>

      <button
        onClick={handleAddAccount}
        disabled={accounts.length >= 10}
        className="w-full py-3 border-2 border-dashed border-gray-300 rounded-lg text-gray-600 hover:border-blue-500 hover:text-blue-600 font-medium transition disabled:opacity-50 disabled:cursor-not-allowed"
      >
        + Add Another Account
      </button>

      <div className="mt-8 flex justify-end">
        <button
          onClick={onNext}
          disabled={!canContinue}
          className="px-8 py-3 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition"
        >
          Continue to Next Step
        </button>
      </div>

      {/* Login Modal */}
      {showLoginModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
            <div className="bg-white rounded-xl p-6 max-w-md w-full mx-4">
              <h3 className="text-xl font-bold text-gray-800 mb-4">Add TikTok Account</h3>
              <p className="text-gray-600 mb-4">
                Choose how you'd like to connect this TikTok account. For Puppeteer automation later, the
                browser flow will capture a session cookie we can reuse. Manual credential storage is also supported
                if you prefer to provide username/password (backend must store securely).
              </p>

              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">Account Nickname</label>
                <input
                  type="text"
                  value={currentAccountName}
                  onChange={(e) => setCurrentAccountName(e.target.value)}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                  placeholder="e.g., Account 1, Main Account"
                />
              </div>

              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">Connection Method</label>
                <div className="flex flex-col gap-2">
                  <label className="flex items-center gap-2">
                    <input type="radio" checked={connectionMethod === 'cookies'} onChange={() => setConnectionMethod('cookies')} />
                    <span className="text-sm">Import cookies (recommended)</span>
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="radio" checked={connectionMethod === 'browser'} onChange={() => setConnectionMethod('browser')} />
                    <span className="text-sm">Browser login (Docker)</span>
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="radio" checked={connectionMethod === 'manual'} onChange={() => setConnectionMethod('manual')} />
                    <span className="text-sm">Manual credentials</span>
                  </label>
                </div>
              </div>

              {connectionMethod === 'cookies' && (
                <div className="space-y-3 mb-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      TikTok Cookies (JSON format)
                    </label>
                    <textarea
                      value={cookiesJson}
                      onChange={(e) => setCookiesJson(e.target.value)}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg font-mono text-sm h-32"
                      placeholder='Paste cookies here as JSON array...'
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      1. Log into TikTok in your desktop Chrome<br/>
                      2. Open DevTools (F12) → Application → Cookies → tiktok.com<br/>
                      3. Copy all cookies and paste as JSON array here
                    </p>
                  </div>
                </div>
              )}

              {connectionMethod === 'manual' && (
                <div className="space-y-3 mb-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">TikTok Username or Email</label>
                    <input type="text" value={manualUsername} onChange={(e) => setManualUsername(e.target.value)} className="w-full px-4 py-2 border border-gray-300 rounded-lg" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Password</label>
                    <input type="password" value={manualPassword} onChange={(e) => setManualPassword(e.target.value)} className="w-full px-4 py-2 border border-gray-300 rounded-lg" />
                  </div>
                </div>
              )}

              <div className="flex gap-3">
                <button
                  onClick={() => { setShowLoginModal(false); setAwaitingVerification(false); }}
                  className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>
                {!awaitingVerification ? (
                  <button
                    onClick={handleLoginComplete}
                    disabled={!currentAccountName || (connectionMethod === 'manual' && (!manualUsername || !manualPassword)) || (connectionMethod === 'cookies' && !cookiesJson)}
                    className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-300"
                  >
                    {connectionMethod === 'cookies' ? 'Import Cookies' : connectionMethod === 'browser' ? 'Open TikTok Login' : 'Save Credentials'}
                  </button>
                ) : (
                  <button
                    onClick={async () => {
                      try {
                        const token = localStorage.getItem('token')
                        const payload: any = {}
                        if (pendingAccountId) payload.accountId = pendingAccountId
                        else payload.nickname = currentAccountName

                        const res = await fetch('/api/onboarding/tiktok/complete', {
                          method: 'POST',
                          headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${token}`,
                          },
                          body: JSON.stringify(payload),
                        })

                        if (!res.ok) {
                          let bodyText = 'Failed to verify connect'
                          try {
                            const body = await res.json()
                            bodyText = body && (body.error || body.message) ? (body.error || body.message) : JSON.stringify(body)
                          } catch (_) {
                            bodyText = await res.text().catch(() => 'Failed to verify connect')
                          }
                          throw new Error(bodyText)
                        }

                        const data = await res.json()
                        if (!data || !data.accountId) throw new Error('Verify did not return accountId')

                        onUpdate([...accounts, currentAccountName])
                        setShowLoginModal(false)
                        setAwaitingVerification(false)
                        setCurrentAccountName('')
                        setPendingAccountId(null)
                      } catch (err) {
                        console.error(err)
                        alert('Could not verify login yet. Make sure you completed the login in the opened window.')
                      }
                    }}
                    className="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700"
                  >
                    I've completed login
                  </button>
                )}
              </div>

              <p className="text-xs text-gray-500 mt-4">
                Note: For browser login we'll capture session cookies (securely) so the automation worker can reuse them. Manual credentials are stored encrypted on the server.
              </p>
            </div>
        </div>
      )}
    </div>
  )
}
