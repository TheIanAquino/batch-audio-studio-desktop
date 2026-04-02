import { describe, expect, it } from 'vitest'
import type { Candidate, Job, JobChunk } from '../types'
import { buildActiveRunWorkflowControllerState } from './activeRunWorkflowController'

function makeCandidate(id: string, index: number, overrides: Partial<Candidate> = {}): Candidate {
  return {
    candidate_id: id,
    variant_label: `V${index}`,
    status: 'completed',
    audio_url: `/audio/${id}.wav`,
    duration: 1.5,
    duration_ms: 1500,
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

function makeJob(chunks: JobChunk[], overrides: Partial<Job> = {}): Job {
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
    chunks,
    ...overrides,
  }
}

describe('activeRunWorkflowController', () => {
  it('creates one-time local auto-default selections only for unlocked chunks', () => {
    const first = makeCandidate('cand-1', 1)
    const second = makeCandidate('cand-2', 2)
    const state = buildActiveRunWorkflowControllerState({
      job: makeJob([makeChunk(1, { candidates: [second, first] })]),
      chunkLocks: {},
      confirmedChunkIds: new Set(),
      changedChunkIds: new Set(),
      activeTimelineJobId: null,
      activeAudio: null,
    })

    expect(state.autoSelectedCandidateIds).toEqual({ 'chunk-1': 'cand-1' })
    expect(state.effectiveSelectedCandidateIds).toEqual({ 'chunk-1': 'cand-1' })
    expect(state.chunkPresentationVariants['chunk-1']).toBe('selected')

    const lockedState = buildActiveRunWorkflowControllerState({
      job: makeJob([makeChunk(1, { candidates: [first, second] })]),
      chunkLocks: { 'chunk-1': true },
      confirmedChunkIds: new Set(),
      changedChunkIds: new Set(),
      activeTimelineJobId: null,
      activeAudio: null,
    })

    expect(lockedState.autoSelectedCandidateIds).toEqual({})
  })

  it('preserves manual confirmation and exposes updated-selection presentation variants', () => {
    const first = makeCandidate('cand-1', 1)
    const second = makeCandidate('cand-2', 2)
    const state = buildActiveRunWorkflowControllerState({
      job: makeJob([makeChunk(1, { selected_candidate_id: second.candidate_id, candidates: [first, second] })]),
      chunkLocks: {},
      confirmedChunkIds: new Set(['chunk-1']),
      changedChunkIds: new Set(['chunk-1']),
      activeTimelineJobId: null,
      activeAudio: null,
    })

    expect(state.autoSelectedCandidateIds).toEqual({})
    expect(state.nextConfirmedChunkIds.has('chunk-1')).toBe(true)
    expect(state.chunkPresentationVariants['chunk-1']).toBe('updated-selection')
  })

  it('invalidates stale selected candidates and resets presentation to needs-review', () => {
    const first = makeCandidate('cand-1', 1)
    const state = buildActiveRunWorkflowControllerState({
      job: makeJob([makeChunk(1, { selected_candidate_id: 'missing', candidates: [first] })]),
      chunkLocks: {},
      confirmedChunkIds: new Set(['chunk-1']),
      changedChunkIds: new Set(['chunk-1']),
      activeTimelineJobId: null,
      activeAudio: null,
    })

    expect(state.nextConfirmedChunkIds.has('chunk-1')).toBe(false)
    expect(state.chunkReviewStates['chunk-1']).toBe('attention')
    expect(state.chunkPresentationVariants['chunk-1']).toBe('needs-review')
  })
})
