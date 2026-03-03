export type SqlMirrorHealth = 'healthy' | 'warning' | 'critical' | 'unknown'

export interface SqlMirrorSourceStatus {
  key: 'model-detections' | 'ad-plays'
  label: string
  mirrorTable: string
  partitionLabel: string
  partitionCount: number
  workerLastSyncAt: string | null
  workerLagSeconds: number | null
  latestMirroredAt: string | null
  dataLagSeconds: number | null
  status: SqlMirrorHealth
  note: string
}

export interface SqlMirrorStatusResponse {
  generatedAt: string
  workerEnabled: boolean
  pollIntervalSeconds: number
  sources: SqlMirrorSourceStatus[]
}
