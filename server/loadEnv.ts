import fs from 'node:fs'
import path from 'node:path'
import dotenv from 'dotenv'

let loaded = false

export function loadLocalEnv(rootDir: string = process.cwd()): void {
  if (loaded) {
    return
  }

  const candidates = [
    '.env.local',
    '.env',
  ]

  for (const filename of candidates) {
    const filePath = path.join(rootDir, filename)
    if (fs.existsSync(filePath)) {
      dotenv.config({ path: filePath, override: false })
    }
  }

  loaded = true
}
