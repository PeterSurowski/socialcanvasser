interface AIPromptProps {
  prompt: string
  onUpdate: (prompt: string) => void
  onNext: () => void
  onBack: () => void
}

export default function AIPrompt({ prompt, onUpdate, onNext, onBack }: AIPromptProps) {
  const canContinue = prompt.trim().length > 20

  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-800 mb-2">AI Prompt Configuration</h2>
      <p className="text-gray-600 mb-6">
        Train the AI to identify potential customers. Describe what buying intent looks like for your product.
      </p>

      <div className="mb-4">
        <label className="block text-sm font-medium text-gray-700 mb-2">
          AI Analysis Prompt
        </label>
        <textarea
          value={prompt}
          onChange={(e) => onUpdate(e.target.value)}
          className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none resize-none"
          rows={8}
          placeholder="Example: You are analyzing TikTok comments to identify people who want to buy fitness coaching services. Look for comments expressing desire to lose weight, get in shape, find a personal trainer, or asking about workout programs. Return 'YES' if the commenter shows buying intent, 'NO' if they don't."
        />
        <p className="text-sm text-gray-500 mt-2">
          {prompt.length} characters
        </p>
      </div>

      <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-6">
        <p className="text-sm text-yellow-800">
          <strong>Important:</strong> Be specific about what constitutes buying intent. The AI will use this prompt to filter every comment it analyzes.
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
          onClick={onNext}
          disabled={!canContinue}
          className="px-8 py-3 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition"
        >
          Continue
        </button>
      </div>
    </div>
  )
}
