interface SnoozeSettingsProps {
  snoozeDays: number;
  keepInTouchSnoozeDays: number;
  onUpdate: (value: number) => void;
  onUpdateKeepInTouch: (value: number) => void;
  onNext: () => void;
  onBack: () => void;
}

export default function SnoozeSettings({ snoozeDays, keepInTouchSnoozeDays, onUpdate, onUpdateKeepInTouch, onNext, onBack }: SnoozeSettingsProps) {
  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-800 mb-2">Prospect Snooze Period</h2>
      <p className="text-gray-600 mb-6">
        After the bot comments on a creator&apos;s video, it will wait this many days before
        attempting to send them an affiliate invitation DM. This gives the creator time to see
        your comment and become familiar with your brand.
      </p>

      <div className="mb-6">
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Days to wait before sending DM
        </label>
        <input
          type="number"
          min={1}
          max={30}
          value={snoozeDays}
          onChange={(e) => onUpdate(Math.max(1, Math.min(30, parseInt(e.target.value) || 3)))}
          className="w-40 px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-center text-xl font-semibold"
        />
        <p className="text-sm text-gray-500 mt-2">
          Recommended: 3–7 days
        </p>
      </div>

      <div className="mb-6">
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Keep in Touch snooze days
        </label>
        <input
          type="number"
          min={1}
          max={365}
          value={keepInTouchSnoozeDays}
          onChange={(e) => onUpdateKeepInTouch(Math.max(1, Math.min(365, parseInt(e.target.value) || 14)))}
          className="w-40 px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-center text-xl font-semibold"
        />
        <p className="text-sm text-gray-500 mt-2">
          Recommended: 14–45 days for prospects who said &ldquo;not now&rdquo;
        </p>
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
        <p className="text-sm text-blue-800">
          <strong>How it works:</strong> When a creator is added to your prospect list their
          &ldquo;snooze&rdquo; timer starts. Once it expires, the bot will send them your affiliate
          invitation DM on the next session. The DM is only ever sent once per creator, across all
          your accounts.
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
  );
}
