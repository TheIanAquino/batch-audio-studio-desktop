import type { Job } from '../types'

export function formatJobMeta(job: Job) {
  const progress = `${Math.round(job.progress_percent)}%`
  const chunks = `${job.chunks.length} chunks`
  const elapsedSeconds = job.total_generation_time ?? elapsedSince(job.created_at)
  const elapsed = elapsedSeconds != null ? formatDuration(elapsedSeconds) : null
  const eta = estimateEta(job, elapsedSeconds)

  return {
    progress,
    chunks,
    elapsed,
    eta,
    total: job.total_generation_time != null ? formatDuration(job.total_generation_time) : null,
  }
}

export function elapsedSince(iso: string | undefined) {
  if (!iso) return null
  const created = Date.parse(iso)
  if (Number.isNaN(created)) return null
  return Math.max(0, (Date.now() - created) / 1000)
}

export function estimateEta(job: Job, elapsedSeconds: number | null) {
  if (job.status !== 'running' && job.status !== 'canceling') return null
  if (elapsedSeconds == null || elapsedSeconds <= 0) return null
  if (!job.progress_percent || job.progress_percent <= 0 || job.progress_percent >= 100) return null
  const ratio = job.progress_percent / 100
  const remaining = (elapsedSeconds / ratio) - elapsedSeconds
  return remaining > 0 ? formatDuration(remaining) : null
}

export function formatDuration(seconds: number) {
  const total = Math.max(0, Math.round(seconds))
  const minutes = Math.floor(total / 60)
  const remainder = total % 60
  if (minutes <= 0) return `${remainder}s`
  return `${minutes}m ${String(remainder).padStart(2, '0')}s`
}

export function compareVariantLabels(a: string, b: string) {
  const parsedA = parseVariantLabel(a)
  const parsedB = parseVariantLabel(b)
  if (parsedA.prefix !== parsedB.prefix) return parsedA.prefix.localeCompare(parsedB.prefix)
  if (parsedA.index !== parsedB.index) return parsedA.index - parsedB.index
  return a.localeCompare(b)
}

function parseVariantLabel(label: string) {
  const match = label.match(/^([A-Za-z]+)(\d+)$/)
  if (!match) return { prefix: label, index: Number.MAX_SAFE_INTEGER }
  return { prefix: match[1], index: Number(match[2]) }
}
