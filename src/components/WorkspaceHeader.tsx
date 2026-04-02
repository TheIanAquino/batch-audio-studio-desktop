import { AlertCircle } from 'lucide-react'
import type { Job } from '../types'

type Props = {
  queue: Job[]
  uiError: string
  setUiError: (msg: string) => void
  activeJob: Job | null
  modalPool?: { in_flight: number; queued: number; max: number } | null
}

export function WorkspaceHeader({ queue, uiError, setUiError, activeJob, modalPool }: Props) {
  const totalGenTime = activeJob?.total_generation_time ?? null
  const generating = queue.filter((j) => j.status === 'running' || j.status === 'canceling').length
  const done = queue.filter((j) => j.status === 'completed').length
  const modalActive = Math.max(0, modalPool?.in_flight ?? 0)
  const modalQueued = Math.max(0, modalPool?.queued ?? 0)
  const modalMax = Math.max(1, modalPool?.max ?? 10)

  return (
    <header className="workspace-header">
      <div className="text-[10px] uppercase tracking-[0.22em] text-white/30">Batch Audio Studio</div>

      <div className="flex items-center gap-4">
        {activeJob && (
          <span className="text-[10px] text-white/45">
            {activeJob.prompt_name} · {activeJob.status} · {Math.round(activeJob.progress_percent)}%
          </span>
        )}
        {generating > 0 && (
          <span className="status-badge status-badge--generating">
            {generating} generating
          </span>
        )}
        {(modalActive > 0 || modalQueued > 0) && (
          <span className="status-badge status-badge--modal-pool">
            Modal pool {modalActive}/{modalMax}
            {modalQueued > 0 ? ` · queued ${modalQueued}` : ''}
          </span>
        )}
        {done > 0 && (
          <span className="text-[10px] text-white/40">
            {done} done
          </span>
        )}
        {totalGenTime != null && totalGenTime > 0 && (
          <span className="text-[10px] tabular-nums text-white/45">
            Total: {totalGenTime.toFixed(1)}s
          </span>
        )}
      </div>

      {uiError && (
        <div className="error-banner absolute left-1/2 top-12 z-20 w-auto max-w-[600px] -translate-x-1/2">
          <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0 text-red-400" />
          <span className="line-clamp-2">{uiError}</span>
          <button className="ghost-btn shrink-0" onClick={() => setUiError('')}>✕</button>
        </div>
      )}
    </header>
  )
}
