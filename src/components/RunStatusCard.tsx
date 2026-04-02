import { useEffect, useState } from 'react'
import { Ban, PencilLine, Trash2 } from 'lucide-react'
import { formatJobMeta } from '../lib/jobMetrics'
import type { WorkflowStep } from '../lib/activeRunWorkflow'
import type { Job } from '../types'

type Props = {
  job: Job
  workflowStep: WorkflowStep | null
  workflowSummary: string | null
  workflowGuidance: string | null
  workflowPlaybackLabel: string | null
  workflowBlockedReason: string | null
  onRenameRun: (runLabel: string) => void | Promise<void>
  onCancel: () => void
  onDelete: () => void
}

const WORKFLOW_STEPS: WorkflowStep[] = ['Generate', 'Review', 'Select', 'Edit Timeline', 'Export']

export function RunStatusCard({
  job,
  workflowStep,
  workflowSummary,
  workflowGuidance,
  workflowPlaybackLabel,
  workflowBlockedReason,
  onRenameRun,
  onCancel,
  onDelete,
}: Props) {
  const [isEditingLabel, setIsEditingLabel] = useState(false)
  const [labelDraft, setLabelDraft] = useState(job.run_label || '')
  const canCancel = job.status === 'queued' || job.status === 'running' || job.status === 'canceling'
  const canDelete = job.status === 'completed' || job.status === 'failed' || job.status === 'canceled' || job.status === 'interrupted'
  const meta = formatJobMeta(job)
  const currentLabel = job.run_label || job.current_task

  useEffect(() => {
    setLabelDraft(job.run_label || '')
  }, [job.job_id, job.run_label])

  async function saveLabel() {
    const nextLabel = labelDraft.trim()
    if (!nextLabel) {
      setLabelDraft(job.run_label || '')
      setIsEditingLabel(false)
      return
    }
    if (nextLabel !== (job.run_label || '').trim()) {
      await onRenameRun(nextLabel)
    }
    setIsEditingLabel(false)
  }

  return (
    <div className="job-section">
      <div className="px-3 py-3">
        <div className="active-run-workflow">
          {WORKFLOW_STEPS.map((step) => (
            <div
              key={step}
              className={`active-run-workflow__step ${workflowStep === step ? 'active-run-workflow__step--active' : ''}`}
            >
              {step}
            </div>
          ))}
        </div>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="section-label !mb-0">Active Run</div>
            <div className="active-run-label-row">
              {isEditingLabel ? (
                <input
                  className="active-run-label-input"
                  value={labelDraft}
                  autoFocus
                  onChange={(event) => setLabelDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      void saveLabel()
                      return
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      setIsEditingLabel(false)
                      setLabelDraft(job.run_label || '')
                    }
                  }}
                  onBlur={() => {
                    void saveLabel()
                  }}
                />
              ) : (
                <div className="section-title">{currentLabel}</div>
              )}
              {!isEditingLabel ? (
                <button
                  type="button"
                  className="active-run-label-edit"
                  onClick={() => {
                    setIsEditingLabel(true)
                    setLabelDraft(job.run_label || '')
                  }}
                >
                  <PencilLine className="h-3 w-3" />
                </button>
              ) : null}
            </div>
            <div className="mt-1 text-xs text-white/45">
              {(job.voice_display_name || job.prompt_name) ?? 'Run'} · {job.status} · {meta.chunks} · {meta.progress}
              {meta.total && <> · {meta.total} total</>}
              {!meta.total && meta.eta && <> · ETA {meta.eta}</>}
              {!meta.total && !meta.eta && meta.elapsed && <> · Elapsed {meta.elapsed}</>}
            </div>
            {workflowGuidance ? <div className="active-run-workflow__guidance">{workflowGuidance}</div> : null}
            {workflowSummary ? <div className="active-run-workflow__summary">{workflowSummary}</div> : null}
            {workflowPlaybackLabel ? <div className="active-run-workflow__playback">{workflowPlaybackLabel}</div> : null}
            {!workflowPlaybackLabel && workflowBlockedReason ? <div className="active-run-workflow__blocked">{workflowBlockedReason}</div> : null}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button className="ghost-btn" onClick={onCancel} disabled={!canCancel}>
              <Ban className="h-3 w-3" />
              Cancel
            </button>
            <button className="ghost-btn" onClick={onDelete} disabled={!canDelete}>
              <Trash2 className="h-3 w-3" />
              Delete
            </button>
          </div>
        </div>

        {job.error_message && <div className="mt-3 error-banner">{job.error_message}</div>}
      </div>
    </div>
  )
}
