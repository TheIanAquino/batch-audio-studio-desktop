import type { Job } from '../types'

type Props = {
  job: Job
  onClose: () => void
  onConfirm: () => void
}

export function ExportModal({ job, onClose, onConfirm }: Props) {
  const selectedChunks = job.chunks.filter((chunk) => chunk.selected_candidate_id)
  const missingSelections = job.chunks.filter((chunk) => !chunk.selected_candidate_id)
  const blockedByStatus = job.chunks.filter((chunk) => chunk.status === 'generating' || chunk.status === 'error')
  const blocked = missingSelections.length > 0 || blockedByStatus.length > 0
  const durationReady = selectedChunks.every((chunk) => {
    const selected = chunk.candidates.find((candidate) => candidate.candidate_id === chunk.selected_candidate_id)
    return selected?.duration != null
  })
  const totalDuration = durationReady
    ? selectedChunks.reduce((sum, chunk) => {
        const selected = chunk.candidates.find((candidate) => candidate.candidate_id === chunk.selected_candidate_id)
        return sum + (selected?.duration ?? 0)
      }, 0)
    : null

  return (
    <div className="modal-backdrop">
      <div className="modal-panel">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="section-label">Export Final Mix</div>
            <div className="section-title">{job.prompt_name}</div>
            <div className="mt-1 text-xs text-white/45">{job.chunks.length} chunks</div>
          </div>
          <button className="ghost-btn" onClick={onClose}>Close</button>
        </div>

        <div className="mt-4 space-y-2 text-sm text-white/70">
          {totalDuration != null && totalDuration > 0 && <div>Total selected duration: {totalDuration.toFixed(1)}s</div>}
          {missingSelections.length > 0 && <div className="text-red-300">Missing selection on {missingSelections.length} chunk(s).</div>}
          {blockedByStatus.length > 0 && <div className="text-red-300">Some chunks are still generating or errored.</div>}
        </div>

        <div className="mt-4 max-h-[260px] space-y-2 overflow-y-auto pr-1 soft-scroll">
          {job.chunks.map((chunk) => {
            const selected = chunk.candidates.find((candidate) => candidate.candidate_id === chunk.selected_candidate_id)
            return (
              <div key={chunk.chunk_id} className="soft-card px-3 py-2 text-xs text-white/60">
                <div className="flex items-center justify-between gap-3">
                  <span>Chunk {String(chunk.index + 1).padStart(2, '0')}</span>
                  <span className="text-neon/70">{selected?.variant_label ?? 'Unselected'}</span>
                </div>
                <div className="mt-1 line-clamp-2 text-white/40">{chunk.text}</div>
              </div>
            )
          })}
        </div>

        <div className="mt-4 flex items-center justify-end gap-2">
          <button className="ghost-btn" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={onConfirm} disabled={blocked}>Confirm Export</button>
        </div>
      </div>
    </div>
  )
}
