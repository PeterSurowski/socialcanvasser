import { useState } from 'react'

interface TikTokAccountsProps {
  accounts: string[]
  onUpdate: (accounts: string[]) => void
  onNext: () => void
}

export default function TikTokAccounts({ accounts, onUpdate, onNext }: TikTokAccountsProps) {
  const [showLoginModal, setShowLoginModal] = useState(false)
  const [currentAccountName, setCurrentAccountName] = useState('')

  const handleAddAccount = () => {
    setShowLoginModal(true)
  }

  const handleLoginComplete = () => {
    if (currentAccountName) {
      onUpdate([...accounts, currentAccountName])
      setCurrentAccountName('')
      setShowLoginModal(false)
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
        className="w-full py-3 border-2 border-dashed border-gray-300 rounded-lg text-gray-600 hover:border-blue-500 hover:text-blue-600 font-medium transition"
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
              A new window will open where you can log into your TikTok account. Once logged in, we'll save your session.
            </p>

            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Account Nickname (for identification)
              </label>
              <input
                type="text"
                value={currentAccountName}
                onChange={(e) => setCurrentAccountName(e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                placeholder="e.g., Account 1, Main Account"
              />
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setShowLoginModal(false)}
                className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleLoginComplete}
                disabled={!currentAccountName}
                className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-300"
              >
                Open TikTok Login
              </button>
            </div>

            <p className="text-xs text-gray-500 mt-4">
              Note: Your credentials are never stored. Only session cookies are saved securely.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
