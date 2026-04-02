import { compareVariantLabels } from './jobMetrics'
import {
  deriveActiveRunPlaybackLabel,
  deriveActiveRunStep,
  deriveChunkReviewState,
  deriveRunProgress,
  deriveTimelinePhase,
  type ChunkReviewState,
} from './activeRunWorkflow'
import type { ActiveAudio, ChunkLockMap, Job } from '../types'

export type ChunkPresentationVariant = 'generating' | 'needs-review' | 'selected' | 'updated-selection'

export type ActiveRunWorkflowControllerState = {
  autoSelectedCandidateIds: Record<string, string>
  effectiveSelectedCandidateIds: Record<string, string>
  nextConfirmedChunkIds: Set<string>
  chunkReviewStates: Record<string, ChunkReviewState>
  chunkPresentationVariants: Record<string, ChunkPresentationVariant>
  timelinePhase: ReturnType<typeof deriveTimelinePhase>
  activeStep: ReturnType<typeof deriveActiveRunStep>
  runProgress: ReturnType<typeof deriveRunProgress>
  playbackLabel: string | null
}

type Input = {
  job: Job
  chunkLocks: ChunkLockMap
  confirmedChunkIds: Set<string>
  changedChunkIds: Set<string>
  activeTimelineJobId: string | null
  activeAudio: ActiveAudio | null
}

export function buildActiveRunWorkflowControllerState({
  job,
  chunkLocks,
  confirmedChunkIds,
  changedChunkIds,
  activeTimelineJobId,
  activeAudio,
}: Input): ActiveRunWorkflowControllerState {
  const autoSelectedCandidateIds: Record<string, string> = {}
  const effectiveSelectedCandidateIds: Record<string, string> = {}
  const nextConfirmedChunkIds = new Set<string>()

  for (const chunk of job.chunks) {
    const hasStaleSelectedCandidate = Boolean(
      chunk.selected_candidate_id
      && !chunk.candidates.find((candidate) => candidate.candidate_id === chunk.selected_candidate_id),
    )
    const validSelectedCandidate = chunk.selected_candidate_id
      ? chunk.candidates.find((candidate) => candidate.candidate_id === chunk.selected_candidate_id) ?? null
      : null

    if (validSelectedCandidate) {
      effectiveSelectedCandidateIds[chunk.chunk_id] = validSelectedCandidate.candidate_id
      nextConfirmedChunkIds.add(chunk.chunk_id)
      continue
    }

    const sortedCandidates = [...chunk.candidates].sort((left, right) => compareVariantLabels(left.variant_label, right.variant_label))
    const fallbackCandidate = sortedCandidates[0] ?? null
    if (!chunkLocks[chunk.chunk_id] && fallbackCandidate) {
      autoSelectedCandidateIds[chunk.chunk_id] = fallbackCandidate.candidate_id
      effectiveSelectedCandidateIds[chunk.chunk_id] = fallbackCandidate.candidate_id
      if (!hasStaleSelectedCandidate && confirmedChunkIds.has(chunk.chunk_id)) nextConfirmedChunkIds.add(chunk.chunk_id)
    }
  }

  const chunkReviewStates = Object.fromEntries(
    job.chunks.map((chunk) => [
      chunk.chunk_id,
      deriveChunkReviewState({
        chunk,
        locked: Boolean(chunkLocks[chunk.chunk_id]),
        autoSelectedCandidateId: autoSelectedCandidateIds[chunk.chunk_id] ?? null,
        confirmationContext: { confirmedChunkIds: nextConfirmedChunkIds },
      }),
    ]),
  ) as Record<string, ChunkReviewState>

  const chunkPresentationVariants = Object.fromEntries(
    job.chunks.map((chunk) => {
      const reviewState = chunkReviewStates[chunk.chunk_id]
      const variant: ChunkPresentationVariant =
        reviewState === 'generating'
          ? 'generating'
          : reviewState === 'attention'
            ? 'needs-review'
            : changedChunkIds.has(chunk.chunk_id)
              ? 'updated-selection'
              : 'selected'
      return [chunk.chunk_id, variant]
    }),
  ) as Record<string, ChunkPresentationVariant>

  const timelinePhase = deriveTimelinePhase(job, activeTimelineJobId)
  const activeStep = deriveActiveRunStep(job, timelinePhase.phase, Object.values(chunkReviewStates))
  const runProgress = deriveRunProgress({ job, chunkStates: Object.values(chunkReviewStates), timelinePhase })
  const playbackLabel = deriveActiveRunPlaybackLabel(activeAudio, job.job_id)

  return {
    autoSelectedCandidateIds,
    effectiveSelectedCandidateIds,
    nextConfirmedChunkIds,
    chunkReviewStates,
    chunkPresentationVariants,
    timelinePhase,
    activeStep,
    runProgress,
    playbackLabel,
  }
}
