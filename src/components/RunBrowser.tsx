import { useState } from 'react'
import { ChevronDown, ChevronRight, PencilLine, Trash2 } from 'lucide-react'
import { formatJobMeta } from '../lib/jobMetrics'
import type { VoiceRunGroup } from '../types'

type Props = {
  groups: VoiceRunGroup[]
  activeJobId: string | null
  expandedVoiceIds: Record<string, boolean>
  onToggleVoice: (voiceId: string) => void
  onSelectRun: (jobId: string) => void
  onRenameRun: (jobId: string, runLabel: string) => void | Promise<void>
  onDeleteRun: (jobId: string) => void | Promise<void>
}

export function RunBrowser({ groups, activeJobId, expandedVoiceIds, onToggleVoice, onSelectRun, onRenameRun, onDeleteRun }: Props) {
  const [editingRunId, setEditingRunId] = useState<string | null>(null)
  const [runLabelDraft, setRunLabelDraft] = useState('')

  function beginRename(jobId: string, currentLabel: string) {
    setEditingRunId(jobId)
    setRunLabelDraft(currentLabel)
  }

  async function saveRename(jobId: string, currentLabel: string) {
    const nextLabel = runLabelDraft.trim()
    if (!nextLabel) {
      setRunLabelDraft(currentLabel)
      setEditingRunId(null)
      return
    }
    if (nextLabel !== currentLabel.trim()) {
      await onRenameRun(jobId, nextLabel)
    }
    setEditingRunId(null)
  }

  if (!groups.length) return <div className="empty-state">No runs yet. Run a batch to populate the workspace.</div>

  return (
    <div className="soft-card p-3">
      <div className="section-label">Voice Runs</div>
      <div className="mt-2 space-y-2">
        {groups.map((group) => {
          const expanded = expandedVoiceIds[group.voiceId] ?? true
          return (
            <div key={group.voiceId} className="run-browser-group">
              <button className="run-browser-group__header" onClick={() => onToggleVoice(group.voiceId)}>
                {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                <span className="flex-1 truncate">{group.voiceDisplayName}</span>
                <span className="text-[10px] text-white/35">{group.jobs.length}</span>
              </button>
              {expanded && (
                <div className="mt-2 space-y-1.5">
                  {group.jobs.map((job) => (
                    <div
                      key={job.job_id}
                      className={`run-browser-run ${activeJobId === job.job_id ? 'run-browser-run--active' : ''}`}
                      onClick={() => onSelectRun(job.job_id)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(event) => {
                        const target = event.target as HTMLElement
                        if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          onSelectRun(job.job_id)
                        }
                      }}
                    >
                      {(() => {
                        const meta = formatJobMeta(job)
                        const currentLabel = job.run_label || job.source_text || job.current_task
                        const isEditing = editingRunId === job.job_id
                        return (
                          <>
                            <div className="run-browser-run__row">
                              {isEditing ? (
                                <input
                                  className="run-browser-run__input"
                                  autoFocus
                                  value={runLabelDraft}
                                  onChange={(event) => setRunLabelDraft(event.target.value)}
                                  onClick={(event) => event.stopPropagation()}
                                  onKeyDown={(event) => {
                                    if (event.key === 'Enter') {
                                      event.preventDefault()
                                      void saveRename(job.job_id, currentLabel)
                                      return
                                    }
                                    if (event.key === 'Escape') {
                                      event.preventDefault()
                                      setEditingRunId(null)
                                      setRunLabelDraft(currentLabel)
                                    }
                                  }}
                                  onBlur={() => {
                                    void saveRename(job.job_id, currentLabel)
                                  }}
                                />
                              ) : (
                                <div className="truncate text-[11px] font-medium text-white">{currentLabel}</div>
                              )}
                              {!isEditing ? (
                                <div className="run-browser-run__actions">
                                  <button
                                    type="button"
                                    className="run-browser-run__rename"
                                    onClick={(event) => {
                                      event.stopPropagation()
                                      beginRename(job.job_id, currentLabel)
                                    }}
                                  >
                                    <PencilLine className="h-3 w-3" />
                                  </button>
                                  <button
                                    type="button"
                                    className="run-browser-run__delete"
                                    onClick={(event) => {
                                      event.stopPropagation()
                                      void onDeleteRun(job.job_id)
                                    }}
                                  >
                                    <Trash2 className="h-3 w-3" />
                                  </button>
                                </div>
                              ) : null}
                            </div>
                            <div className="mt-1 text-[10px] text-white/40">
                              {job.status} · {meta.chunks} · {meta.progress}
                            </div>
                            <div className="mt-1 text-[10px] text-white/28">
                              {meta.total ? `Total ${meta.total}` : meta.eta ? `Elapsed ${meta.elapsed} · ETA ${meta.eta}` : meta.elapsed ? `Elapsed ${meta.elapsed}` : 'Just started'}
                            </div>
                          </>
                        )
                      })()}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
