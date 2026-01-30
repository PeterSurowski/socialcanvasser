import { useState } from 'react'

interface TikTokAccountsProps {
  accounts: string[]
  onUpdate: (accounts: string[]) => void
  onNext: () => void
}

export default function TikTokAccounts({ accounts, onUpdate, onNext }: TikTokAccountsProps) {
  const [showSetupModal, setShowSetupModal] = useState(false)
  const [currentAccountName, setCurrentAccountName] = useState('')
  const [currentAccountId, setCurrentAccountId] = useState<number | null>(null)
  const [setupStep, setSetupStep] = useState<'instructions' | 'verify'>('instructions')
  const [isVerifying, setIsVerifying] = useState(false)

  const handleAddAccount = () => {
    if (accounts.length >= 10) return
    setShowSetupModal(true)
    setSetupStep('instructions')
  }

  const handleStartSetup = async () => {
    if (!currentAccountName) return

    try {
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
        throw new Error('Failed to create account')
      }

      const data = await res.json()
      setCurrentAccountId(data.accountId)
      setSetupStep('verify')
    } catch (error) {
      console.error('Setup error:', error)
      alert('Failed to create account. Please try again.')
    }
  }

  const handleMarkReady = async () => {
    if (!currentAccountId) return

    setIsVerifying(true)
    try {
      const token = localStorage.getItem('token')
      const res = await fetch('/api/onboarding/tiktok/complete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ accountId: currentAccountId })
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.message || 'Failed to verify Chrome')
      }

      // Success!
      onUpdate([...accounts, currentAccountName])
      setShowSetupModal(false)
      setCurrentAccountName('')
      setCurrentAccountId(null)
      setSetupStep('instructions')
    } catch (error: any) {
      console.error('Verification error:', error)
      alert(error.message || 'Failed to verify Chrome. Make sure you launched Chrome using the launch-chrome.bat script.')
    } finally {
      setIsVerifying(false)
    }
  }

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold text-gray-800">TikTok Accounts</h2>
      <p className="text-sm text-gray-600">
        Add TikTok accounts to search for posts. You'll launch Chrome locally (no containers!) and log in normally.
      </p>

      {accounts.map((account, index) => (
        <div key={index} className="flex items-center justify-between p-3 bg-green-50 border border-green-200 rounded-lg">
          <span className="font-medium text-green-800">@{account}</span>
          <button
            onClick={() => onUpdate(accounts.filter((_, i) => i !== index))}
            className="text-red-600 hover:text-red-800"
          >
            Remove
          </button>
        </div>
      ))}

      <button
        onClick={handleAddAccount}
        disabled={accounts.length >= 10}
        className="w-full py-3 px-4 border-2 border-dashed border-gray-300 rounded-lg text-gray-600 hover:border-blue-500 hover:text-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        + Add TikTok Account {accounts.length > 0 && `(${accounts.length}/10)`}
      </button>

      {accounts.length > 0 && (
        <button
          onClick={onNext}
          className="w-full py-3 px-6 bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700 transition-colors"
        >
          Continue
        </button>
      )}

      {/* Setup Modal */}
      {showSetupModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg p-6 max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <h3 className="text-2xl font-bold text-gray-800 mb-4">
              {setupStep === 'instructions' ? 'Setup TikTok Account' : 'Verify Chrome Connection'}
            </h3>

            {setupStep === 'instructions' && (
              <>
                <div className="space-y-4 mb-6">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Account Nickname
                    </label>
                    <input
                      type="text"
                      value={currentAccountName}
                      onChange={(e) => setCurrentAccountName(e.target.value)}
                      placeholder="e.g., MyMainAccount"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                    />
                  </div>

                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                    <h4 className="font-semibold text-blue-900 mb-2">📋 Instructions:</h4>
                    <ol className="list-decimal list-inside space-y-2 text-sm text-blue-800">
                      <li>Click "Start Setup" below</li>
                      <li>Double-click <code className="bg-blue-100 px-2 py-1 rounded">launch-chrome.bat</code> in the socialcanvasser folder</li>
                      <li>Close ANY existing Chrome windows first (the script will remind you)</li>
                      <li>A new Chrome window will open with TikTok</li>
                      <li>Log into your TikTok account normally</li>
                      <li>Come back here and click "I'm Logged In"</li>
                    </ol>
                  </div>

                  <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                    <h4 className="font-semibold text-yellow-900 mb-2">⚠️ Important:</h4>
                    <ul className="list-disc list-inside space-y-1 text-sm text-yellow-800">
                      <li>Keep the Chrome window open while using SocialCanvasser</li>
                      <li>Don't close the terminal window that appears</li>
                      <li>This Chrome is running in "debug mode" so the app can automate it</li>
                      <li>Your real IP and browser profile = much harder for TikTok to detect!</li>
                    </ul>
                  </div>
                </div>

                <div className="flex gap-3">
                  <button
                    onClick={() => {
                      setShowSetupModal(false)
                      setCurrentAccountName('')
                    }}
                    className="flex-1 py-2 px-4 border border-gray-300 rounded-lg hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleStartSetup}
                    disabled={!currentAccountName}
                    className="flex-1 py-2 px-4 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
                  >
                    Start Setup
                  </button>
                </div>
              </>
            )}

            {setupStep === 'verify' && (
              <>
                <div className="space-y-4 mb-6">
                  <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                    <h4 className="font-semibold text-green-900 mb-2">✅ Next Steps:</h4>
                    <ol className="list-decimal list-inside space-y-2 text-sm text-green-800">
                      <li>Run <code className="bg-green-100 px-2 py-1 rounded">launch-chrome.bat</code></li>
                      <li>Close existing Chrome windows when prompted</li>
                      <li>Wait for new Chrome to open with TikTok</li>
                      <li>Log into TikTok</li>
                      <li>Click "I'm Logged In" below</li>
                    </ol>
                  </div>

                  <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 text-sm text-gray-600">
                    <p className="font-mono">launch-chrome.bat</p>
                    <p className="mt-2">Location: <code className="bg-white px-2 py-1 rounded border">C:\Users\peter\Desktop\sandbox\socialcanvasser\launch-chrome.bat</code></p>
                  </div>
                </div>

                <div className="flex gap-3">
                  <button
                    onClick={() => setSetupStep('instructions')}
                    disabled={isVerifying}
                    className="flex-1 py-2 px-4 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
                  >
                    Back
                  </button>
                  <button
                    onClick={handleMarkReady}
                    disabled={isVerifying}
                    className="flex-1 py-2 px-4 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
                  >
                    {isVerifying ? 'Verifying...' : "I'm Logged In ✓"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
