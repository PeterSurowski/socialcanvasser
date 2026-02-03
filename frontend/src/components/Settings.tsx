import React, { useEffect, useState } from 'react'

interface SettingsData {
  keywords: string;
  ai_prompt: string;
  example_dm: string;
  example_comment: string;
  openai_api_key: string;
  actions_per_session: number;
}

export default function Settings() {
  const [settings, setSettings] = useState<SettingsData>({
    keywords: '',
    ai_prompt: '',
    example_dm: '',
    example_comment: '',
    openai_api_key: '',
    actions_per_session: 20
  })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [showApiKey, setShowApiKey] = useState(false)

  useEffect(() => {
    fetchSettings()
  }, [])

  const fetchSettings = async () => {
    try {
      const token = localStorage.getItem('token')
      const res = await fetch('/api/settings', {
        headers: { Authorization: `Bearer ${token}` }
      })
      
      if (res.ok) {
        const data = await res.json()
        setSettings({
          keywords: data.config.keywords || '',
          ai_prompt: data.config.ai_prompt || '',
          example_dm: data.config.example_dm || '',
          example_comment: data.config.example_comment || '',
          openai_api_key: data.config.openai_api_key || '',
          actions_per_session: data.config.actions_per_session || 20
        })
      }
    } catch (error) {
      console.error('Failed to fetch settings:', error)
      setMessage({ type: 'error', text: 'Failed to load settings' })
    } finally {
      setLoading(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setMessage(null)

    try {
      const token = localStorage.getItem('token')
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          keywords: settings.keywords,
          aiPrompt: settings.ai_prompt,
          exampleDM: settings.example_dm,
          exampleComment: settings.example_comment,
          openaiApiKey: settings.openai_api_key,
          actionsPerSession: settings.actions_per_session
        })
      })

      if (res.ok) {
        setMessage({ type: 'success', text: 'Settings saved successfully!' })
        setTimeout(() => setMessage(null), 3000)
      } else {
        setMessage({ type: 'error', text: 'Failed to save settings' })
      }
    } catch (error) {
      console.error('Failed to save settings:', error)
      setMessage({ type: 'error', text: 'Failed to save settings' })
    } finally {
      setSaving(false)
    }
  }

  const handleChange = (field: keyof SettingsData, value: string | number) => {
    setSettings(prev => ({ ...prev, [field]: value }))
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    )
  }

  return (
    <div className="bg-white rounded-lg shadow-sm">
      <div className="px-6 py-4 border-b border-gray-200">
        <h2 className="text-xl font-semibold text-gray-800">Campaign Settings</h2>
        <p className="text-sm text-gray-600 mt-1">Update your AI prompts, keywords, and API configuration</p>
      </div>

      <form onSubmit={handleSubmit} className="p-6 space-y-6">
        {/* Keywords */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Keywords
            <span className="text-gray-500 font-normal ml-2">(comma-separated)</span>
          </label>
          <input
            type="text"
            value={settings.keywords}
            onChange={(e) => handleChange('keywords', e.target.value)}
            placeholder="weight loss, fitness, gym"
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            required
          />
        </div>

        {/* AI Prompt */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            AI Prompt
            <span className="text-gray-500 font-normal ml-2">(instructions for analyzing buying intent)</span>
          </label>
          <textarea
            value={settings.ai_prompt}
            onChange={(e) => handleChange('ai_prompt', e.target.value)}
            placeholder="Analyze these comments for buying intent..."
            rows={6}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            required
          />
        </div>

        {/* Example DM */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Example DM Template
            <span className="text-gray-500 font-normal ml-2">(AI will customize this for each user)</span>
          </label>
          <textarea
            value={settings.example_dm}
            onChange={(e) => handleChange('example_dm', e.target.value)}
            placeholder="Hey! I saw your comment about..."
            rows={4}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            required
          />
        </div>

        {/* Example Comment Reply */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Example Comment Reply Template
            <span className="text-gray-500 font-normal ml-2">(fallback when DMs are blocked)</span>
          </label>
          <textarea
            value={settings.example_comment}
            onChange={(e) => handleChange('example_comment', e.target.value)}
            placeholder="Great question! Here's what helped me..."
            rows={4}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            required
          />
        </div>

        {/* Actions Per Session */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Send how many messages before changing accounts?
          </label>
          <input
            type="number"
            min="1"
            max="100"
            value={settings.actions_per_session}
            onChange={(e) => handleChange('actions_per_session', parseInt(e.target.value) || 20)}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            required
          />
          <p className="text-xs text-gray-500 mt-1">
            After sending this many messages, the system will automatically switch to your next TikTok account
          </p>
        </div>

        {/* OpenAI API Key */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            OpenAI API Key
          </label>
          <div className="relative">
            <input
              type={showApiKey ? 'text' : 'password'}
              value={settings.openai_api_key}
              onChange={(e) => handleChange('openai_api_key', e.target.value)}
              placeholder="sk-..."
              className="w-full px-4 py-2 pr-24 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              required
            />
            <button
              type="button"
              onClick={() => setShowApiKey(!showApiKey)}
              className="absolute right-2 top-1/2 -translate-y-1/2 px-3 py-1 text-xs text-gray-600 hover:text-gray-800"
            >
              {showApiKey ? 'Hide' : 'Show'}
            </button>
          </div>
          <p className="text-xs text-gray-500 mt-1">
            Get your API key from <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">OpenAI Dashboard</a>
          </p>
        </div>

        {/* Success/Error Message */}
        {message && (
          <div className={`p-4 rounded-lg ${message.type === 'success' ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'}`}>
            {message.text}
          </div>
        )}

        {/* Submit Button */}
        <div className="flex justify-end pt-4 border-t border-gray-200">
          <button
            type="submit"
            disabled={saving}
            className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {saving ? (
              <>
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                Saving...
              </>
            ) : (
              'Save Settings'
            )}
          </button>
        </div>
      </form>
    </div>
  )
}
