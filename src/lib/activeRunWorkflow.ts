import { buildTimelineDraft } from './timelineDraft'
import type { ActiveAudio, Job, JobChunk } from '../types'

export type TimelinePhase = 'unavailable' | 'editable' | 'editing' | 'ready_to_export'
export type WorkflowStep = 'Generate' | 'Review' | 'Select' | 'Edit Timeline' | 'Export'
export type ChunkReviewState = 'generating' | 'auto-selected' | 'confirmed' | 'attention'

export type TimelinePhaseResult = {
  phase: TimelinePhase
  blockedReason: string | null
}

export type ConfirmationContext = {
  confirmedChunkIds: Set<string>
}

export type ChunkReviewStateInput = {
  chunk: JobChunk
  locked: boolean
  autoSelectedCandidateId?: string | null
  confirmationContext: ConfirmationContext
}

export type RunProgressInput = {
  job: Job
  chunkStates: ChunkReviewState[]
  timelinePhase: TimelinePhaseResult
}

export type RunProgressResult = {
  completedCount: number
  reviewCount: number
  attentionCount: number
  summaryLabel: string
  guidanceLabel: string
  blockedTimelineReason: string | null
}

export function deriveTimelinePhase(job: Job, activeTimelineJobId: string | null): TimelinePhaseResult {
  const renderStatus = job.timeline_render_status ?? 'idle'
  if (renderStatus === 'preview_ready' || renderStatus === 'export_ready') {
    return { phase: 'ready_to_export', blockedReason: null }
  }

  const draft = buildTimelineDraft(job)
  if (!draft) {
    return {
      phase: 'unavailable',
      blockedReason: 'This run needs current duration metadata before timeline editing is available.',
    }
  }

  if (activeTimelineJobId === job.job_id) {
    return { phase: 'editing', blockedReason: null }
  }

  return { phase: 'editable', blockedReason: null }
}

export function deriveChunkReviewState({
  chunk,
  locked: _locked,
  autoSelectedCandidateId,
  confirmationContext,
}: ChunkReviewStateInput): ChunkReviewState {
  const selectedCandidate = chunk.selected_candidate_id
    ? chunk.candidates.find((candidate) => candidate.candidate_id === chunk.selected_candidate_id) ?? null
    : null

  if (chunk.status === 'failed' || chunk.status === 'interrupted' || chunk.status === 'canceled') {
    return 'attention'
  }

  if ((chunk.status === 'queued' || chunk.status === 'running' || chunk.status === 'canceling') && chunk.candidates.length === 0) {
    return 'generating'
  }

  if (chunk.selected_candidate_id && !selectedCandidate) {
    return 'attention'
  }

  if (selectedCandidate) {
    return 'confirmed'
  }

  if (autoSelectedCandidateId) {
    return confirmationContext.confirmedChunkIds.has(chunk.chunk_id) ? 'confirmed' : 'auto-selected'
  }

  if (chunk.candidates.length > 0) {
    return 'attention'
  }

  return 'generating'
}

export function deriveActiveRunStep(job: Job, timelinePhase: TimelinePhase, chunkStates: ChunkReviewState[]): WorkflowStep {
  const hasAnyCandidates = job.chunks.some((chunk) => chunk.candidates.length > 0)
  const hasGenerating = chunkStates.includes('generating')
  const hasAttention = chunkStates.includes('attention')
  const hasAutoSelected = chunkStates.includes('auto-selected')
  const hasReviewable = chunkStates.includes('confirmed') || chunkStates.includes('auto-selected')
  const allConfirmed = chunkStates.length > 0 && chunkStates.every((state) => state === 'confirmed')

  if (timelinePhase === 'ready_to_export') return 'Export'
  if (allConfirmed && (timelinePhase === 'editable' || timelinePhase === 'editing')) return 'Edit Timeline'
  if (!hasGenerating && !hasAttention && hasAutoSelected) return 'Select'
  if (hasGenerating || hasAttention) {
    const shouldGenerate =
      (job.status === 'queued' || job.status === 'running' || job.status === 'canceling')
      && !hasAnyCandidates
      && !hasReviewable
    return shouldGenerate ? 'Generate' : 'Review'
  }
  if (job.status === 'queued' || job.status === 'running' || job.status === 'canceling' || !hasAnyCandidates) return 'Generate'
  return 'Review'
}

export function deriveRunProgress({ job, chunkStates, timelinePhase }: RunProgressInput): RunProgressResult {
  const completedCount = chunkStates.filter((state) => state === 'confirmed').length
  const attentionCount = chunkStates.filter((state) => state === 'attention').length
  const reviewCount = chunkStates.length - completedCount

  const summaryLabel =
    reviewCount === 0
      ? 'All chunks selected ✓'
      : reviewCount === 1
        ? '1 chunk still needs review'
        : `${reviewCount} chunks still need review`

  let guidanceLabel = 'Review each chunk and confirm the best version.'
  if (job.status === 'failed') {
    guidanceLabel = 'Some chunks failed. Regenerate those chunks to continue.'
  } else if (job.status === 'interrupted') {
    guidanceLabel = 'Run interrupted. Review completed chunks or regenerate missing ones.'
  } else if (job.status === 'canceled') {
    guidanceLabel = 'Run canceled. Start a new generation to continue.'
  } else if (timelinePhase.phase === 'ready_to_export') {
    guidanceLabel = 'Timeline ready. Export the final cut.'
  } else if (reviewCount === 0) {
    guidanceLabel = 'All chunks selected. Ready to edit timeline.'
  }

  return {
    completedCount,
    reviewCount,
    attentionCount,
    summaryLabel,
    guidanceLabel,
    blockedTimelineReason: timelinePhase.blockedReason,
  }
}

export function deriveActiveRunPlaybackLabel(activeAudio: ActiveAudio | null, activeJobId: string | null): string | null {
  if (!activeAudio || !activeJobId || activeAudio.jobId !== activeJobId) return null
  if (activeAudio.sourceType === 'mix') return 'Now playing: Timeline preview'
  if (activeAudio.sourceType !== 'candidate' || activeAudio.chunkIndex == null || !activeAudio.variantLabel) return null

  return `Now playing: Chunk ${String(activeAudio.chunkIndex).padStart(2, '0')} - ${formatVariantLabel(activeAudio.variantLabel)}`
}

function formatVariantLabel(variantLabel: string): string {
  const match = variantLabel.match(/^([A-Za-z]+)(\d+)$/)
  if (!match) return variantLabel
  return `${match[1] === 'V' ? 'Version' : match[1]} ${match[2]}`
}
