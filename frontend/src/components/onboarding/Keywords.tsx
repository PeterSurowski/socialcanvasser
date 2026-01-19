interface KeywordsProps {
  keywords: string
  onUpdate: (keywords: string) => void
  onNext: () => void
  onBack: () => void
}

export default function Keywords({ keywords, onUpdate, onNext, onBack }: KeywordsProps) {
  const keywordArray = keywords ? keywords.split(',').filter(k => k.trim()) : []
  const canContinue = keywordArray.length >= 1

  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-800 mb-2">Product Keywords</h2>
      <p className="text-gray-600 mb-6">
        Enter keywords or phrases related to your product (at least 10 recommended). The bot will search for posts containing these terms.
      </p>

      <div className="mb-4">
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Keywords (comma-separated, no spaces)
        </label>
        <textarea
          value={keywords}
          onChange={(e) => onUpdate(e.target.value)}
          className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none resize-none"
          rows={6}
          placeholder="weight loss,fitness coach,gym membership,personal trainer,workout plan"
        />
        <p className="text-sm text-gray-500 mt-2">
          {keywordArray.length} keyword{keywordArray.length !== 1 ? 's' : ''} entered
          {keywordArray.length < 10 && ` (${10 - keywordArray.length} more recommended)`}
        </p>
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
        <p className="text-sm text-blue-800">
          <strong>Tip:</strong> Use specific phrases that potential customers might mention in comments, such as "need to lose weight", "looking for a trainer", "want to get fit"
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
