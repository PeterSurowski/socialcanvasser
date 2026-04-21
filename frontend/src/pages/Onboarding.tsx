import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import TikTokAccounts from '../components/onboarding/TikTokAccounts'
import Keywords from '../components/onboarding/Keywords'
import AIPrompt from '../components/onboarding/AIPrompt'
import CreatorMessage from '../components/onboarding/CreatorMessage'
import ExampleMessages from '../components/onboarding/ExampleMessages'
import OpenAIKey from '../components/onboarding/OpenAIKey'
import BrandVoice from '../components/onboarding/BrandVoice'
import SnoozeSettings from '../components/onboarding/SnoozeSettings'
import AffiliateInvitationText from '../components/onboarding/AffiliateInvitationText'
import AffiliateDmPrompt from '../components/onboarding/AffiliateDmPrompt'

export default function Onboarding() {
  const [step, setStep] = useState(1)
  const [data, setData] = useState({
    tiktokAccounts: [] as string[],
    keywords: '',
    aiPrompt: '',
    creatorMessage: '',
    exampleDM: '',
    exampleComment: '',
    openaiKey: '',
    brandVoice: '',
    snoozeDays: 3,
    keepInTouchSnoozeDays: 14,
    affiliateDmPrompt: '',
    affiliateInvitationText: '',
  })
  const navigate = useNavigate()

  const totalSteps = 10

  const updateData = (field: string, value: any) => {
    setData(prev => ({ ...prev, [field]: value }))
  }

  const handleNext = () => {
    if (step < totalSteps) {
      setStep(step + 1)
    }
  }

  const handleBack = () => {
    if (step > 1) {
      setStep(step - 1)
    }
  }

  const handleComplete = async () => {
    try {
      const token = localStorage.getItem('token')
      const response = await fetch('/api/onboarding/complete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(data),
      })

      if (!response.ok) {
        throw new Error('Failed to complete onboarding')
      }

      navigate('/dashboard')
    } catch (error) {
      console.error('Onboarding error:', error)
      alert('Failed to complete onboarding. Please try again.')
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white shadow">
        <div className="max-w-4xl mx-auto px-4 py-6">
          <h1 className="text-2xl font-bold text-gray-800">Setup Your Campaign</h1>
          <div className="mt-4">
            <div className="flex items-center justify-between text-sm text-gray-600 mb-2">
              <span>Step {step} of {totalSteps}</span>
              <span>{Math.round((step / totalSteps) * 100)}%</span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-2">
              <div
                className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                style={{ width: `${(step / totalSteps) * 100}%` }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="bg-white rounded-xl shadow-lg p-8">
          {step === 1 && (
            <TikTokAccounts
              accounts={data.tiktokAccounts}
              onUpdate={(accounts) => updateData('tiktokAccounts', accounts)}
              onNext={handleNext}
            />
          )}
          {step === 2 && (
            <Keywords
              keywords={data.keywords}
              onUpdate={(keywords) => updateData('keywords', keywords)}
              onNext={handleNext}
              onBack={handleBack}
            />
          )}
          {step === 3 && (
            <AIPrompt
              prompt={data.aiPrompt}
              onUpdate={(prompt) => updateData('aiPrompt', prompt)}
              onNext={handleNext}
              onBack={handleBack}
            />
          )}
          {step === 4 && (
            <CreatorMessage
              message={data.creatorMessage}
              onUpdate={(message) => updateData('creatorMessage', message)}
              onNext={handleNext}
              onBack={handleBack}
            />
          )}
          {step === 5 && (
            <ExampleMessages
              exampleDM={data.exampleDM}
              exampleComment={data.exampleComment}
              onUpdateDM={(dm) => updateData('exampleDM', dm)}
              onUpdateComment={(comment) => updateData('exampleComment', comment)}
              onNext={handleNext}
              onBack={handleBack}
            />
          )}
          {step === 6 && (
            <OpenAIKey
              apiKey={data.openaiKey}
              onUpdate={(key) => updateData('openaiKey', key)}
              onComplete={handleNext}
              onBack={handleBack}
            />
          )}
          {step === 7 && (
            <BrandVoice
              brandVoice={data.brandVoice}
              onUpdate={(v) => updateData('brandVoice', v)}
              onNext={handleNext}
              onBack={handleBack}
            />
          )}
          {step === 8 && (
            <SnoozeSettings
              snoozeDays={data.snoozeDays}
              keepInTouchSnoozeDays={data.keepInTouchSnoozeDays}
              onUpdate={(v) => updateData('snoozeDays', v)}
              onUpdateKeepInTouch={(v) => updateData('keepInTouchSnoozeDays', v)}
              onNext={handleNext}
              onBack={handleBack}
            />
          )}
          {step === 9 && (
            <AffiliateDmPrompt
              affiliateDmPrompt={data.affiliateDmPrompt}
              onUpdate={(v) => updateData('affiliateDmPrompt', v)}
              onNext={handleNext}
              onBack={handleBack}
            />
          )}
          {step === 10 && (
            <AffiliateInvitationText
              affiliateInvitationText={data.affiliateInvitationText}
              onUpdate={(v) => updateData('affiliateInvitationText', v)}
              onComplete={handleComplete}
              onBack={handleBack}
            />
          )}
        </div>
      </div>
    </div>
  )
}
