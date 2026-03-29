interface CreatorMessageProps {
  message: string
  onUpdate: (message: string) => void
  onNext: () => void
  onBack: () => void
}

export default function CreatorMessage({ message, onUpdate, onNext, onBack }: CreatorMessageProps) {
  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-800 mb-2">Creator DM Message</h2>
      <p className="text-gray-600 mb-6">
        Configure the message sent to video creators before scraping comments on their videos.
      </p>

      <div className="mb-4">
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Creator Message (Optional)
        </label>
        <textarea
          value={message}
          onChange={(e) => onUpdate(e.target.value)}
          className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none resize-none"
          rows={6}
          placeholder="Hey there, you're getting a lot of views on a video you recently posted about peptides. I think you'd be a good fit for the OnlineSupplements.NET's affiliate program..."
        />
        <p className="text-sm text-gray-500 mt-2">
          {message.length} characters
        </p>
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
        <p className="text-sm text-blue-800 mb-2">
          <strong>What is this?</strong> Before analyzing comments on a video, the system can optionally send a DM to the video creator. This is useful for:
        </p>
        <ul className="list-disc list-inside text-sm text-blue-800 space-y-1 ml-2">
          <li>Inviting creators to affiliate programs</li>
          <li>Introducing your brand or product</li>
          <li>Building relationships with popular creators</li>
        </ul>
        <p className="text-sm text-blue-800 mt-3">
          <strong>Note:</strong> Leave blank to skip sending messages to creators and only message commenters.
        </p>
      </div>

      <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-6">
        <p className="text-sm text-yellow-800">
          <strong>Important:</strong> Keep the message on a single line. Don't use Enter/Return keys, as that will send the message prematurely in TikTok's messenger. Use spaces instead of line breaks.
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
          Continue
        </button>
      </div>
    </div>
  )
}
