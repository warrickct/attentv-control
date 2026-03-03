import type { QuickQuestionDefinition } from '../shared/quickQuestion'

interface QuickQuestionPopupProps {
  question: QuickQuestionDefinition
  loading: boolean
  error: string | null
  onAnswer: (optionId: string) => void
  onDismiss: () => void
}

export default function QuickQuestionPopup(props: QuickQuestionPopupProps) {
  const { question, loading, error, onAnswer, onDismiss } = props

  return (
    <aside className="quick-question-popup" aria-live="polite">
      <div className="quick-question-card">
        <button
          type="button"
          className="quick-question-close"
          aria-label="Dismiss quick question"
          onClick={onDismiss}
        >
          x
        </button>

        <div className="quick-question-kicker">{question.title}</div>
        <h2>{question.prompt}</h2>
        <p>{question.subtitle}</p>

        <div className="quick-question-options">
          {question.options.map((option) => (
            <button
              key={option.id}
              type="button"
              className="quick-question-option"
              onClick={() => onAnswer(option.id)}
              disabled={loading}
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className="quick-question-footer">
          <button
            type="button"
            className="quick-question-secondary"
            onClick={onDismiss}
            disabled={loading}
          >
            Maybe later
          </button>
          <span>Shows at most once a week.</span>
        </div>

        {error && <div className="quick-question-error">{error}</div>}
      </div>
    </aside>
  )
}
