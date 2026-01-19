import { useState } from 'react'

interface OpenAIKeyProps {
  apiKey: string
  onUpdate: (key: string) => void
  onComplete: () => void
  onBack: () => void
}

export default function OpenAIKey({ apiKey, onUpdate, onComplete, onBack }: OpenAIKeyProps) {
  const [showKey, setShowKey] = useState(false)
  const canContinue = apiKey.trim().startsWith('sk-')

  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-800 mb-2">OpenAI API Key</h2>
      <p className="text-gray-600 mb-6">
        Enter your OpenAI API key to power the AI analysis. This will be used to identify buying intent in comments.
      </p>

      <div className="mb-4">
        <label className="block text-sm font-medium text-gray-700 mb-2">
          API Key
        </label>
        <div className="relative">
          <input
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => onUpdate(e.target.value)}
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none pr-24"
            placeholder="sk-..."
          />
          <button
            type="button"
            onClick={() => setShowKey(!showKey)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-blue-600 hover:text-blue-700 font-medium"
          >
            {showKey ? 'Hide' : 'Show'}
          </button>
        </div>
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
        <p className="text-sm text-blue-800 mb-2">
          <strong>Don't have an OpenAI API key?</strong>
        </p>
        <ol className="text-sm text-blue-800 list-decimal list-inside space-y-1">
          <li>Go to <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer" className="underline">platform.openai.com/api-keys</a></li>
          <li>Sign up or log in</li>
          <li>Click "Create new secret key"</li>
          <li>Copy and paste it here</li>
        </ol>
      </div>

      <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-6">
        <p className="text-sm text-yellow-800">
          <strong>Security:</strong> Your API key is encrypted and stored securely. We never share it with third parties.
        </p>
      </div>

      <div className="flex justify-between">
        <button
          onClick={onBack}
          className="px-8 py-3 border border-gray-300 text-gray-700 rounded-lg font-semibold hover:bg-gray-50 transition"
        >
          Back
        </button>
        <button
          onClick={onComplete}
          disabled={!canContinue}
          className="px-8 py-3 bg-green-600 text-white rounded-lg font-semibold hover:bg-green-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition"
        >
          Complete Setup
        </button>
      </div>
    </div>
  )
}
