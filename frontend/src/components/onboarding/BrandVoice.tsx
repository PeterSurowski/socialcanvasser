interface BrandVoiceProps {
  brandVoice: string;
  onUpdate: (value: string) => void;
  onNext: () => void;
  onBack: () => void;
}

export default function BrandVoice({ brandVoice, onUpdate, onNext, onBack }: BrandVoiceProps) {
  const canContinue = brandVoice.trim().length >= 20;

  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-800 mb-2">Brand Voice</h2>
      <p className="text-gray-600 mb-6">
        Describe your brand personality so the AI can post comments that sound authentic and
        match your tone. This is used by the Affiliate Procurement algorithm to engage creators
        on their videos.
      </p>

      <div className="mb-4">
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Brand Voice Description
        </label>
        <textarea
          value={brandVoice}
          onChange={(e) => onUpdate(e.target.value)}
          className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none resize-none"
          rows={6}
          placeholder="Example: Friendly and upbeat fitness coach. We inspire people to reach their health goals through practical advice. Comments should feel warm, relatable, and encouraging — never salesy. Use emojis sparingly. Ask questions that spark conversation."
        />
        <p className="text-sm text-gray-500 mt-2">
          {brandVoice.trim().length} characters (minimum 20)
        </p>
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
        <p className="text-sm text-blue-800">
          <strong>Tip:</strong> The more specific you are about tone, topics to reference, and what
          to avoid, the better the AI will represent your brand in TikTok comments.
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
  );
}
