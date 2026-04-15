interface AffiliateInvitationTextProps {
  affiliateInvitationText: string;
  onUpdate: (value: string) => void;
  onComplete: () => void;
  onBack: () => void;
}

export default function AffiliateInvitationText({
  affiliateInvitationText,
  onUpdate,
  onComplete,
  onBack,
}: AffiliateInvitationTextProps) {
  const canComplete = affiliateInvitationText.trim().length >= 20;

  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-800 mb-2">Affiliate Invitation DM</h2>
      <p className="text-gray-600 mb-6">
        Write the DM message that will be sent to creators after the snooze period expires.
        This should invite them to become an affiliate or partner. It will be sent once per
        creator, across all your accounts.
      </p>

      <div className="mb-4">
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Invitation Message
        </label>
        <textarea
          value={affiliateInvitationText}
          onChange={(e) => onUpdate(e.target.value)}
          className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none resize-none"
          rows={6}
          placeholder="Hey! I loved your content — your audience is super engaged. We run an affiliate program for [your product] and think you'd be a perfect fit. Affiliates earn [%] per sale and get [perk]. Interested in learning more? No pressure at all!"
        />
        <p className="text-sm text-gray-500 mt-2">
          {affiliateInvitationText.trim().length} characters (minimum 20)
        </p>
      </div>

      <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-6">
        <p className="text-sm text-green-800">
          <strong>Almost done!</strong> You can always update this message later from Settings.
          Leave it blank to skip DM invitations and only have the bot comment on videos.
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
          disabled={!canComplete}
          className="px-8 py-3 bg-green-600 text-white rounded-lg font-semibold hover:bg-green-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition"
        >
          Complete Setup 🎉
        </button>
      </div>
    </div>
  );
}
