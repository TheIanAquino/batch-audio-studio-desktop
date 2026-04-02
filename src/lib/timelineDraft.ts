import type { Job, TimelineClipDraft, TimelineDraft, TimelineRequestPayload } from '../types'

export function buildTimelineDraft(job: Job): TimelineDraft | null {
  const clips: TimelineClipDraft[] = []
  const snapshot: Array<{ chunkId: string; selectedCandidateId: string }> = []

  for (const chunk of [...job.chunks].sort((a, b) => a.index - b.index)) {
    const selectedCandidateId = chunk.selected_candidate_id
    if (!selectedCandidateId) return null
    const candidate = chunk.candidates.find((item) => item.candidate_id === selectedCandidateId)
    const durationMs = Math.round(candidate?.duration_ms ?? (candidate?.duration != null ? candidate.duration * 1000 : 0))
    if (!candidate || durationMs <= 0) return null
    snapshot.push({ chunkId: chunk.chunk_id, selectedCandidateId })
    clips.push({
      chunkId: chunk.chunk_id,
      candidateId: selectedCandidateId,
      chunkIndex: chunk.index,
      chunkLabel: chunk.text,
      candidateLabel: `${candidate.variant_label} ${candidate.candidate_id}`,
      durationMs,
      trimInMs: '0',
      trimOutMs: '0',
    })
  }

  return {
    jobId: job.job_id,
    revision: 0,
    clips,
    snapshot,
    previewRequestId: null,
    exportRequestId: null,
    previewUrl: null,
    exportPath: null,
    inlineError: '',
    exportSuccessPath: null,
  }
}

export function timelineDraftInvalidated(job: Job, draft: TimelineDraft): boolean {
  const snapshot = job.chunks
    .filter((chunk) => chunk.selected_candidate_id)
    .sort((a, b) => a.index - b.index)
    .map((chunk) => ({ chunkId: chunk.chunk_id, selectedCandidateId: chunk.selected_candidate_id! }))

  return JSON.stringify(snapshot) !== JSON.stringify(draft.snapshot)
}

export function reorderTimelineClips(clips: TimelineClipDraft[], fromIndex: number, toIndex: number): TimelineClipDraft[] {
  const next = [...clips]
  const [moved] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, moved)
  return next
}

export function syncTimelineDraftWithJob(job: Job, previousDraft: TimelineDraft | null): TimelineDraft | null {
  const nextDraft = buildTimelineDraft(job)
  if (!nextDraft) return null
  const previousClipsByChunk = new Map((previousDraft?.clips ?? []).map((clip) => [clip.chunkId, clip]))
  nextDraft.clips = nextDraft.clips.map((clip) => {
    const previous = previousClipsByChunk.get(clip.chunkId)
    if (!previous || previous.candidateId !== clip.candidateId) return clip
    return {
      ...clip,
      trimInMs: previous.trimInMs,
      trimOutMs: previous.trimOutMs,
    }
  })
  nextDraft.snapshot = nextDraft.clips.map((clip) => ({
    chunkId: clip.chunkId,
    selectedCandidateId: clip.candidateId,
  }))
  nextDraft.revision = Math.max(0, previousDraft?.revision ?? 0) + 1
  return nextDraft
}

export function validateTimelineDraft(draft: TimelineDraft): string {
  if (!draft.clips.length) return 'Timeline requires at least one clip.'
  for (const clip of draft.clips) {
    if (clip.trimInMs.trim() === '' || clip.trimOutMs.trim() === '') return 'Trim values are required for every clip.'
    const trimIn = Math.round(Number(clip.trimInMs))
    const trimOut = Math.round(Number(clip.trimOutMs))
    if (!Number.isFinite(trimIn) || !Number.isFinite(trimOut)) return 'Trim values must be numeric.'
    if (trimIn < 0 || trimOut < 0) return 'Trim values must be non-negative.'
    if (trimIn + trimOut >= clip.durationMs) return 'Trim range removes the full clip.'
  }
  return ''
}

export function normalizeTrimInput(value: string, durationMs: number): string {
  if (value.trim() === '') return ''
  const rounded = Math.round(Number(value))
  if (!Number.isFinite(rounded)) return value
  return String(Math.max(0, Math.min(durationMs, rounded)))
}

export function timelineTotalDurationMs(draft: TimelineDraft, pauseBetweenClipsMs: number | number[] = 0): number {
  return draft.clips.reduce((sum, clip, index) => {
    const trimIn = Math.max(0, Math.round(Number(clip.trimInMs) || 0))
    const trimOut = Math.max(0, Math.round(Number(clip.trimOutMs) || 0))
    const keptDurationMs = Math.max(0, clip.durationMs - trimIn - trimOut)
    const pauseForGap = Array.isArray(pauseBetweenClipsMs) ? (pauseBetweenClipsMs[index] ?? 0) : pauseBetweenClipsMs
    const gapAfterMs = index < draft.clips.length - 1 ? Math.max(0, pauseForGap) : 0
    return sum + keptDurationMs + gapAfterMs
  }, 0)
}

export function buildTimelinePayload(draft: TimelineDraft, requestId: string, exportPath?: string): TimelineRequestPayload {
  return {
    request_id: requestId,
    ...(exportPath ? { export_path: exportPath } : {}),
    clips: draft.clips.map((clip) => ({
      candidate_id: clip.candidateId,
      chunk_id: clip.chunkId,
      trim_in_ms: Math.max(0, Math.round(Number(clip.trimInMs) || 0)),
      trim_out_ms: Math.max(0, Math.round(Number(clip.trimOutMs) || 0)),
      source_duration_ms: clip.durationMs,
    })),
  }
}
