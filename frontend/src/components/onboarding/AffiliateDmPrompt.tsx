interface AffiliateDmPromptProps {
  affiliateDmPrompt: string;
  onUpdate: (value: string) => void;
  onNext: () => void;
  onBack: () => void;
}

export default function AffiliateDmPrompt({
  affiliateDmPrompt,
  onUpdate,
  onNext,
  onBack,
}: AffiliateDmPromptProps) {
  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-800 mb-2">Affiliate DM Writing Instructions</h2>
      <p className="text-gray-600 mb-6">
        Tell the AI exactly how to write the personalised affiliate DM for each creator. The AI will
        combine these instructions with the creator's bio, recent captions, and your brand voice to
        craft a unique message.
      </p>

      <div className="mb-4">
        <label className="block text-sm font-medium text-gray-700 mb-2">
          DM Writing Prompt
        </label>
        <textarea
          value={affiliateDmPrompt}
          onChange={(e) => onUpdate(e.target.value)}
          className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none resize-none"
          rows={7}
          placeholder={`Write a warm, personalised affiliate invitation DM. Keep it under 280 characters. Reference something specific from the creator's recent videos or bio to show we've actually watched their content. Mention our affiliate programme and commission rate. End with a soft, no-pressure call-to-action. Do NOT use emojis.`}
        />
        <p className="text-sm text-gray-500 mt-2">
          {affiliateDmPrompt.trim().length} characters
        </p>
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
        <p className="text-sm text-blue-800">
          <strong>Tips:</strong> Mention tone (casual / professional), what to reference from their
          content, your product name, commission offer, and any hard limits like character count.
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
          className="px-8 py-3 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 transition"
        >
          Next →
        </button>
      </div>
    </div>
  )
}
