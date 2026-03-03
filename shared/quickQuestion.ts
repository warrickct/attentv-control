export interface QuickQuestionOption {
  id: string
  label: string
}

export interface QuickQuestionDefinition {
  id: string
  title: string
  prompt: string
  subtitle: string
  options: QuickQuestionOption[]
}

export interface QuickQuestionConfigResponse {
  enabled: boolean
  frequencyDays: number
  question: QuickQuestionDefinition | null
}

export interface QuickQuestionInteraction {
  questionId: string
  interactedAt: string
  action: 'answered' | 'dismissed'
  optionId?: string
}

export const DEFAULT_QUICK_QUESTION_FREQUENCY_DAYS = 7

export const DEFAULT_QUICK_QUESTION: QuickQuestionDefinition = {
  id: 'event-vibe-check-2026-03',
  title: 'Quick Question',
  prompt: 'What event would you actually stop for this month?',
  subtitle: 'One tap. Helps us spot what feels hot with the audience right now.',
  options: [
    { id: 'street-food-night', label: 'Street food night' },
    { id: 'live-acoustic-set', label: 'Live acoustic set' },
    { id: 'comedy-pop-up', label: 'Comedy pop-up' },
    { id: 'late-night-market', label: 'Late-night market' },
  ],
}

export function parseBoolean(value: unknown, defaultValue: boolean = false): boolean {
  if (typeof value !== 'string') {
    return defaultValue
  }

  return value === 'true' || value === '1'
}

export function clampQuickQuestionFrequencyDays(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_QUICK_QUESTION_FREQUENCY_DAYS
  }

  return Math.min(30, Math.max(1, parsed))
}

export function parseQuickQuestionOptionsJson(value: string | undefined | null): QuickQuestionOption[] {
  if (!value) {
    return DEFAULT_QUICK_QUESTION.options
  }

  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) {
      return DEFAULT_QUICK_QUESTION.options
    }

    const normalized = parsed
      .map((item, index) => {
        if (typeof item === 'string' && item.trim() !== '') {
          return {
            id: slugifyQuickQuestionOption(item, index),
            label: item.trim(),
          }
        }

        if (
          item &&
          typeof item === 'object' &&
          typeof (item as { label?: unknown }).label === 'string' &&
          (item as { label: string }).label.trim() !== ''
        ) {
          const label = (item as { label: string }).label.trim()
          const idSource = typeof (item as { id?: unknown }).id === 'string' ? (item as { id: string }).id : label

          return {
            id: slugifyQuickQuestionOption(idSource, index),
            label,
          }
        }

        return null
      })
      .filter((item): item is QuickQuestionOption => item !== null)

    return normalized.length >= 2 ? normalized.slice(0, 6) : DEFAULT_QUICK_QUESTION.options
  } catch {
    return DEFAULT_QUICK_QUESTION.options
  }
}

export function resolveQuickQuestionDefinitionFromEnv(env: Record<string, string | undefined>): QuickQuestionDefinition {
  return {
    id: env.QUICK_QUESTION_ID?.trim() || DEFAULT_QUICK_QUESTION.id,
    title: env.QUICK_QUESTION_TITLE?.trim() || DEFAULT_QUICK_QUESTION.title,
    prompt: env.QUICK_QUESTION_PROMPT?.trim() || DEFAULT_QUICK_QUESTION.prompt,
    subtitle: env.QUICK_QUESTION_SUBTITLE?.trim() || DEFAULT_QUICK_QUESTION.subtitle,
    options: parseQuickQuestionOptionsJson(env.QUICK_QUESTION_OPTIONS_JSON),
  }
}

export function buildQuickQuestionStorageKey(username: string): string {
  return `quick-question:interaction:${username}`
}

export function shouldShowQuickQuestion(params: {
  enabled: boolean
  questionId: string
  frequencyDays: number
  lastInteraction: QuickQuestionInteraction | null
  nowMs: number
}): boolean {
  if (!params.enabled) {
    return false
  }

  if (!params.lastInteraction) {
    return true
  }

  if (params.lastInteraction.questionId !== params.questionId) {
    return true
  }

  const interactedAtMs = new Date(params.lastInteraction.interactedAt).getTime()
  if (!Number.isFinite(interactedAtMs)) {
    return true
  }

  return params.nowMs - interactedAtMs >= params.frequencyDays * 24 * 60 * 60 * 1000
}

function slugifyQuickQuestionOption(value: string, index: number): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return slug || `option-${index + 1}`
}
