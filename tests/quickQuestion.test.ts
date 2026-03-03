import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clampQuickQuestionFrequencyDays,
  parseQuickQuestionOptionsJson,
  shouldShowQuickQuestion,
  type QuickQuestionInteraction,
} from '../shared/quickQuestion'

test('shouldShowQuickQuestion shows initially and hides within cadence window for same question', () => {
  const lastInteraction: QuickQuestionInteraction = {
    questionId: 'question-a',
    interactedAt: '2026-03-01T00:00:00.000Z',
    action: 'answered',
    optionId: 'street-food-night',
  }

  assert.equal(
    shouldShowQuickQuestion({
      enabled: true,
      questionId: 'question-a',
      frequencyDays: 7,
      lastInteraction,
      nowMs: new Date('2026-03-03T00:00:00.000Z').getTime(),
    }),
    false,
  )

  assert.equal(
    shouldShowQuickQuestion({
      enabled: true,
      questionId: 'question-a',
      frequencyDays: 7,
      lastInteraction,
      nowMs: new Date('2026-03-09T00:00:01.000Z').getTime(),
    }),
    true,
  )
})

test('shouldShowQuickQuestion shows immediately for a new question id', () => {
  const lastInteraction: QuickQuestionInteraction = {
    questionId: 'question-a',
    interactedAt: '2026-03-02T00:00:00.000Z',
    action: 'dismissed',
  }

  assert.equal(
    shouldShowQuickQuestion({
      enabled: true,
      questionId: 'question-b',
      frequencyDays: 7,
      lastInteraction,
      nowMs: new Date('2026-03-03T00:00:00.000Z').getTime(),
    }),
    true,
  )
})

test('parseQuickQuestionOptionsJson accepts both strings and labelled objects', () => {
  assert.deepEqual(
    parseQuickQuestionOptionsJson('["Street food night","Comedy pop-up"]'),
    [
      { id: 'street-food-night', label: 'Street food night' },
      { id: 'comedy-pop-up', label: 'Comedy pop-up' },
    ],
  )

  assert.deepEqual(
    parseQuickQuestionOptionsJson('[{"id":"hot-or-not","label":"Hot or not"},{"label":"What is trending?"}]'),
    [
      { id: 'hot-or-not', label: 'Hot or not' },
      { id: 'what-is-trending', label: 'What is trending?' },
    ],
  )
})

test('clampQuickQuestionFrequencyDays keeps cadence in a safe range', () => {
  assert.equal(clampQuickQuestionFrequencyDays('0'), 7)
  assert.equal(clampQuickQuestionFrequencyDays('3'), 3)
  assert.equal(clampQuickQuestionFrequencyDays('45'), 30)
})
