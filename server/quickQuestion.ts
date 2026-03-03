import crypto from 'node:crypto'
import type { Express, Request, Response } from 'express'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { PutCommand } from '@aws-sdk/lib-dynamodb'
import {
  clampQuickQuestionFrequencyDays,
  parseBoolean,
  resolveQuickQuestionDefinitionFromEnv,
  type QuickQuestionConfigResponse,
} from '../shared/quickQuestion'
import type { SessionUser } from './session'

interface RegisterQuickQuestionRoutesOptions {
  app: Express
  docClient: DynamoDBDocumentClient
}

function getQuickQuestionConfig(): QuickQuestionConfigResponse {
  const enabled = parseBoolean(process.env.QUICK_QUESTION_ENABLED, false)
  const frequencyDays = clampQuickQuestionFrequencyDays(process.env.QUICK_QUESTION_FREQUENCY_DAYS)

  if (!enabled) {
    return {
      enabled: false,
      frequencyDays,
      question: null,
    }
  }

  return {
    enabled: true,
    frequencyDays,
    question: resolveQuickQuestionDefinitionFromEnv(process.env),
  }
}

function getResponseTableName(): string | null {
  const tableName = process.env.QUICK_QUESTION_RESPONSES_TABLE?.trim()
  return tableName ? tableName : null
}

function buildCadenceBucket(now: Date, frequencyDays: number): string {
  return `${Math.floor(now.getTime() / (frequencyDays * 24 * 60 * 60 * 1000))}`
}

function sendError(response: Response, error: unknown, fallbackMessage: string): void {
  const message = error instanceof Error ? error.message : fallbackMessage
  console.error(fallbackMessage, error)
  response.status(500).json({ error: message })
}

function isNonCriticalPersistenceError(error: any): boolean {
  return Boolean(
    error?.name === 'ResourceNotFoundException'
    || error?.name === 'ThrottlingException'
    || error?.name === 'ProvisionedThroughputExceededException'
    || error?.name === 'TimeoutError'
    || error?.code === 'ENOTFOUND'
    || error?.code === 'ECONNRESET'
    || error?.code === 'ETIMEDOUT'
    || error?.__type === 'com.amazonaws.dynamodb.v20120810#ResourceNotFoundException',
  )
}

export function registerQuickQuestionRoutes(options: RegisterQuickQuestionRoutesOptions): void {
  const { app, docClient } = options

  app.get('/api/quick-question', async (_request, response) => {
    try {
      response.json(getQuickQuestionConfig())
    } catch (error) {
      sendError(response, error, 'Failed to load quick question.')
    }
  })

  app.post('/api/quick-question/respond', async (request: Request, response: Response) => {
    try {
      const config = getQuickQuestionConfig()
      if (!config.enabled || !config.question) {
        return response.status(404).json({ error: 'Quick question is not enabled.' })
      }

      const questionId = typeof request.body?.questionId === 'string' ? request.body.questionId : ''
      const optionId = typeof request.body?.optionId === 'string' ? request.body.optionId : ''
      if (questionId !== config.question.id) {
        return response.status(400).json({ error: 'Quick question is out of date. Refresh and try again.' })
      }

      const selectedOption = config.question.options.find((option) => option.id === optionId)
      if (!selectedOption) {
        return response.status(400).json({ error: 'Invalid quick question option.' })
      }

      const session = response.locals.session as SessionUser | undefined
      if (!session?.username) {
        return response.status(401).json({ error: 'Authentication required.' })
      }

      const tableName = getResponseTableName()
      const now = new Date()
      const cadenceBucket = buildCadenceBucket(now, config.frequencyDays)
      const responseId = `${config.question.id}#${session.username}#${cadenceBucket}`

      if (!tableName) {
        return response.status(202).json({
          ok: true,
          saved: false,
          warning: 'QUICK_QUESTION_RESPONSES_TABLE is not configured.',
        })
      }

      await docClient.send(new PutCommand({
        TableName: tableName,
        Item: {
          response_id: responseId,
          question_id: config.question.id,
          question_title: config.question.title,
          prompt: config.question.prompt,
          option_id: selectedOption.id,
          option_label: selectedOption.label,
          username: session.username,
          cadence_bucket: cadenceBucket,
          responded_at: now.toISOString(),
          user_agent: request.headers['user-agent'] || null,
          request_id: crypto.randomUUID(),
        },
        ConditionExpression: 'attribute_not_exists(response_id)',
      }))

      return response.json({
        ok: true,
        saved: true,
      })
    } catch (error: any) {
      if (error?.name === 'ConditionalCheckFailedException') {
        return response.json({
          ok: true,
          saved: true,
          duplicate: true,
        })
      }

      if (isNonCriticalPersistenceError(error)) {
        console.error('Quick question response persistence is unavailable.', error)
        return response.status(202).json({
          ok: true,
          saved: false,
          warning: 'Quick question response was accepted, but persistence is temporarily unavailable.',
        })
      }

      sendError(response, error, 'Failed to record quick question response.')
    }
  })
}
