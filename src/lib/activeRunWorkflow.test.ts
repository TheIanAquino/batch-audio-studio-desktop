import { describe, expect, it } from 'vitest'
import type { ActiveAudio, Candidate, Job, JobChunk } from '../types'
import {
  deriveActiveRunPlaybackLabel,
  deriveActiveRunStep,
  deriveChunkReviewState,
  deriveRunProgress,
  deriveTimelinePhase,
} from './activeRunWorkflow'

function makeCandidate(id: string, index: number, overrides: Partial<Candidate> = {}): Candidate {
  return {
    candidate_id: id,
    variant_label: `V${index}`,
    status: 'completed',
    audio_url: `/audio/${id}.wav`,
    duration: 1.2,
    duration_ms: 1200,
    ...overrides,
  }
}

function makeChunk(index: number, overrides: Partial<JobChunk> = {}): JobChunk {
  return {
    chunk_id: `chunk-${index}`,
    index,
    text: `Chunk ${index}`,
    selected_candidate_id: null,
    candidates: [],
    status: 'completed',
    current_task: '',
    error_message: null,
    ...overrides,
  }
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    job_id: 'job-1',
    status: 'completed',
    backend: 'modal',
    api_base: 'http://example.com',
    prompt_name: 'Prompt A',
    progress_percent: 100,
    current_task: 'Idle',
    preview_mix_url: null,
    error_message: null,
    chunks: [],
    ...overrides,
  }
}

describe('activeRunWorkflow', () => {
  it('derives canonical timeline phases with blocked reasons and ready-to-export precedence', () => {
    const validCandidate = makeCandidate('cand-1', 1)
    const jobWithoutDurations = makeJob({
      chunks: [makeChunk(1, { selected_candidate_id: 'cand-1', candidates: [makeCandidate('cand-1', 1, { duration_ms: null, duration: undefined })] })],
    })
    expect(deriveTimelinePhase(jobWithoutDurations, null)).toEqual({
      phase: 'unavailable',
      blockedReason: expect.stringContaining('duration'),
    })

    const editableJob = makeJob({
      chunks: [makeChunk(1, { selected_candidate_id: validCandidate.candidate_id, candidates: [validCandidate] })],
    })
    expect(deriveTimelinePhase(editableJob, null)).toEqual({
      phase: 'editable',
      blockedReason: null,
    })

    expect(deriveTimelinePhase(editableJob, editableJob.job_id)).toEqual({
      phase: 'editing',
      blockedReason: null,
    })

    const previewReadyJob = makeJob({
      timeline_render_status: 'preview_ready',
      chunks: [makeChunk(1, { selected_candidate_id: validCandidate.candidate_id, candidates: [validCandidate] })],
    })
    expect(deriveTimelinePhase(previewReadyJob, previewReadyJob.job_id)).toEqual({
      phase: 'ready_to_export',
      blockedReason: null,
    })
  })

  it('derives chunk review states from backend selections, local auto-selects, and manual confirmation', () => {
    const confirmationContext = { confirmedChunkIds: new Set(['chunk-6']) }
    const candidateA = makeCandidate('cand-a', 1)
    const candidateB = makeCandidate('cand-b', 2)

    expect(
      deriveChunkReviewState({
        chunk: makeChunk(1, { status: 'running', candidates: [] }),
        locked: false,
        confirmationContext,
      }),
    ).toBe('generating')

    expect(
      deriveChunkReviewState({
        chunk: makeChunk(2, { status: 'interrupted', candidates: [] }),
        locked: false,
        confirmationContext,
      }),
    ).toBe('attention')

    expect(
      deriveChunkReviewState({
        chunk: makeChunk(3, { selected_candidate_id: 'missing', candidates: [candidateA] }),
        locked: false,
        confirmationContext,
      }),
    ).toBe('attention')

    expect(
      deriveChunkReviewState({
        chunk: makeChunk(4, { selected_candidate_id: candidateA.candidate_id, candidates: [candidateA] }),
        locked: false,
        confirmationContext,
      }),
    ).toBe('confirmed')

    expect(
      deriveChunkReviewState({
        chunk: makeChunk(5, { candidates: [candidateA, candidateB] }),
        locked: false,
        autoSelectedCandidateId: candidateA.candidate_id,
        confirmationContext,
      }),
    ).toBe('auto-selected')

    expect(
      deriveChunkReviewState({
        chunk: makeChunk(6, { candidates: [candidateA, candidateB] }),
        locked: false,
        autoSelectedCandidateId: candidateB.candidate_id,
        confirmationContext,
      }),
    ).toBe('confirmed')
  })

  it('derives active workflow steps with correct precedence', () => {
    const generateJob = makeJob({ status: 'running', chunks: [makeChunk(1, { status: 'queued', candidates: [] })] })
    expect(deriveActiveRunStep(generateJob, 'editable', ['generating'])).toBe('Generate')

    const reviewJob = makeJob({ status: 'running', chunks: [makeChunk(1), makeChunk(2)] })
    expect(deriveActiveRunStep(reviewJob, 'editing', ['confirmed', 'attention'])).toBe('Review')

    const selectJob = makeJob({ status: 'completed', chunks: [makeChunk(1), makeChunk(2)] })
    expect(deriveActiveRunStep(selectJob, 'editable', ['confirmed', 'auto-selected'])).toBe('Select')

    const editJob = makeJob({ status: 'completed', chunks: [makeChunk(1)] })
    expect(deriveActiveRunStep(editJob, 'editing', ['confirmed'])).toBe('Edit Timeline')

    const exportJob = makeJob({ status: 'completed', chunks: [makeChunk(1)] })
    expect(deriveActiveRunStep(exportJob, 'ready_to_export', ['confirmed'])).toBe('Export')
  })

  it('derives progress labels, blocked guidance, and completion counts', () => {
    const blockedJob = makeJob({ status: 'completed', chunks: [makeChunk(1), makeChunk(2), makeChunk(3)] })
    expect(
      deriveRunProgress({
        job: blockedJob,
        chunkStates: ['confirmed', 'auto-selected', 'attention'],
        timelinePhase: { phase: 'unavailable', blockedReason: 'This run needs current duration metadata before timeline editing is available.' },
      }),
    ).toEqual({
      completedCount: 1,
      reviewCount: 2,
      attentionCount: 1,
      summaryLabel: '2 chunks still need review',
      guidanceLabel: 'Review each chunk and confirm the best version.',
      blockedTimelineReason: 'This run needs current duration metadata before timeline editing is available.',
    })

    const failedJob = makeJob({ status: 'failed', chunks: [makeChunk(1)] })
    expect(
      deriveRunProgress({
        job: failedJob,
        chunkStates: ['attention'],
        timelinePhase: { phase: 'unavailable', blockedReason: 'blocked' },
      }).guidanceLabel,
    ).toBe('Some chunks failed. Regenerate those chunks to continue.')

    const interruptedJob = makeJob({ status: 'interrupted', chunks: [makeChunk(1)] })
    expect(
      deriveRunProgress({
        job: interruptedJob,
        chunkStates: ['attention'],
        timelinePhase: { phase: 'unavailable', blockedReason: 'blocked' },
      }).guidanceLabel,
    ).toBe('Run interrupted. Review completed chunks or regenerate missing ones.')

    const canceledJob = makeJob({ status: 'canceled', chunks: [makeChunk(1)] })
    expect(
      deriveRunProgress({
        job: canceledJob,
        chunkStates: ['attention'],
        timelinePhase: { phase: 'unavailable', blockedReason: 'blocked' },
      }).guidanceLabel,
    ).toBe('Run canceled. Start a new generation to continue.')
  })

  it('derives playback labels for candidate, timeline, idle, and other-job audio', () => {
    const candidateAudio: ActiveAudio = {
      url: '/audio/cand.wav',
      label: 'Candidate',
      chunkIndex: 2,
      variantLabel: 'V8',
      jobId: 'job-1',
      sourceType: 'candidate',
    }
    expect(deriveActiveRunPlaybackLabel(candidateAudio, 'job-1')).toBe('Now playing: Chunk 02 - Version 8')

    const mixAudio: ActiveAudio = {
      url: '/audio/mix.wav',
      label: 'Timeline Preview',
      jobId: 'job-1',
      sourceType: 'mix',
    }
    expect(deriveActiveRunPlaybackLabel(mixAudio, 'job-1')).toBe('Now playing: Timeline preview')

    expect(deriveActiveRunPlaybackLabel(null, 'job-1')).toBeNull()
    expect(deriveActiveRunPlaybackLabel({ ...candidateAudio, jobId: 'job-2' }, 'job-1')).toBeNull()
  })
})
