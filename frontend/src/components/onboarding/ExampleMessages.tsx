interface ExampleMessagesProps {
  exampleDM: string
  exampleComment: string
  onUpdateDM: (dm: string) => void
  onUpdateComment: (comment: string) => void
  onNext: () => void
  onBack: () => void
}

export default function ExampleMessages({
  exampleDM,
  exampleComment,
  onUpdateDM,
  onUpdateComment,
  onNext,
  onBack
}: ExampleMessagesProps) {
  const canContinue = exampleDM.trim().length > 10 && exampleComment.trim().length > 10

  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-800 mb-2">Example Messages</h2>
      <p className="text-gray-600 mb-6">
        Provide examples of how you want to reach out to potential customers. The AI will generate similar messages.
      </p>

      <div className="space-y-6 mb-6">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Example Direct Message
          </label>
          <textarea
            value={exampleDM}
            onChange={(e) => onUpdateDM(e.target.value)}
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none resize-none"
            rows={4}
            placeholder="Hey! I saw your comment about wanting to get fit. I'm a certified personal trainer and I'd love to help you reach your goals. Check out my profile for free workout tips and training programs! 💪"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Example Comment Reply
          </label>
          <textarea
            value={exampleComment}
            onChange={(e) => onUpdateComment(e.target.value)}
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none resize-none"
            rows={4}
            placeholder="I can help with that! I'm a personal trainer and I specialize in weight loss programs. Check out my profile for more info! 🏋️"
          />
        </div>
      </div>

      <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-6">
        <p className="text-sm text-green-800">
          <strong>Tip:</strong> Keep messages friendly and helpful. The AI will vary the wording while maintaining your tone and style.
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
