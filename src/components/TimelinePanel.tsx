import { useState, type DragEvent } from 'react'
import { Lock } from 'lucide-react'
import { ChunkRow } from './ChunkRow'
import { RunBrowser } from './RunBrowser'
import { RunStatusCard } from './RunStatusCard'
import type { WorkflowStep, ChunkReviewState } from '../lib/activeRunWorkflow'
import type { ChunkPresentationVariant } from '../lib/activeRunWorkflowController'
import type { ChunkLockMap, ChunkTweakDraft, Job, JobChunk, VoiceInventory, VoiceRunGroup } from '../types'

type Props = {
  groups: VoiceRunGroup[]
  voices: VoiceInventory[]
  expandedVoiceIds: Record<string, boolean>
  activeJob: Job | null
  activeJobId: string | null
  workflowStep: WorkflowStep | null
  workflowSummary: string | null
  workflowGuidance: string | null
  workflowBlockedReason: string | null
  workflowPlaybackLabel: string | null
  showTimelineCta: boolean
  canOpenTimeline: boolean
  effectiveSelectedCandidateIds: Record<string, string>
  chunkReviewStates: Record<string, ChunkReviewState>
  chunkPresentationVariants: Record<string, ChunkPresentationVariant>
  bridgeUrl: string
  chunkLocks: ChunkLockMap
  expandedChunkIds: Set<string>
  tweakDraft: ChunkTweakDraft | null
  onToggleVoice: (voiceId: string) => void
  onSwitchJob: (jobId: string) => void
  onToggleChunk: (chunk: JobChunk) => void
  onToggleLock: (chunkId: string) => void
  onSelectCandidate: (jobId: string, chunkId: string, candidateId: string) => void
  onPlayCandidate: (job: Job, chunk: JobChunk, audioUrl: string, variantLabel: string, generationTime?: number) => void
  onRegenerate: (job: Job, chunk: JobChunk, variantCount?: number) => void
  onDeleteChunk: (job: Job, chunk: JobChunk) => void
  onAddChunkAfter: (job: Job, chunk: JobChunk) => void
  onDeleteCandidate: (job: Job, chunk: JobChunk, candidateId: string) => void
  onRenameRun: (job: Job, runLabel: string) => void | Promise<void>
  onReorderChunk: (job: Job, chunkId: string, toIndex: number) => void | Promise<void>
  onUpdateChunkText: (job: Job, chunk: JobChunk, text: string) => void | Promise<void>
  onOpenTweak: (job: Job, chunk: JobChunk) => void
  onUpdateTweakDraft: (updater: (draft: ChunkTweakDraft) => ChunkTweakDraft) => void
  onRunTweakedRegeneration: (job: Job, chunk: JobChunk) => void
  onCancelTweak: () => void
  onOpenExport: () => void
  onCancelRun: (job: Job) => void
  onDeleteRun: (job: Job) => void
}

export function TimelinePanel({
  groups,
  voices,
  expandedVoiceIds,
  activeJob,
  activeJobId,
  workflowStep,
  workflowSummary,
  workflowGuidance,
  workflowBlockedReason,
  workflowPlaybackLabel,
  showTimelineCta,
  canOpenTimeline,
  effectiveSelectedCandidateIds,
  chunkReviewStates,
  chunkPresentationVariants,
  bridgeUrl,
  chunkLocks,
  expandedChunkIds,
  tweakDraft,
  onToggleVoice,
  onSwitchJob,
  onToggleChunk,
  onToggleLock,
  onSelectCandidate,
  onPlayCandidate,
  onRegenerate,
  onDeleteChunk,
  onAddChunkAfter,
  onDeleteCandidate,
  onRenameRun,
  onReorderChunk,
  onUpdateChunkText,
  onOpenTweak,
  onUpdateTweakDraft,
  onRunTweakedRegeneration,
  onCancelTweak,
  onOpenExport,
  onCancelRun,
  onDeleteRun,
}: Props) {
  const [draggedChunkId, setDraggedChunkId] = useState<string | null>(null)
  const voiceOptions = voices.map((voice) => voice.name)

  function handleChunkDragStart(chunkId: string, event: DragEvent<HTMLDivElement>) {
    setDraggedChunkId(chunkId)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', chunkId)
  }

  function handleChunkDrop(job: Job, targetIndex: number, event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    const draggedId = draggedChunkId || event.dataTransfer.getData('text/plain')
    setDraggedChunkId(null)
    if (!draggedId) return
    const sourceChunk = job.chunks.find((chunk) => chunk.chunk_id === draggedId)
    if (!sourceChunk || sourceChunk.index - 1 === targetIndex) return
    void onReorderChunk(job, draggedId, targetIndex)
  }

  return (
    <div className="space-y-3">
      <RunBrowser
        groups={groups}
        activeJobId={activeJobId}
        expandedVoiceIds={expandedVoiceIds}
        onToggleVoice={onToggleVoice}
        onSelectRun={onSwitchJob}
        onDeleteRun={(jobId) => {
          const run = groups.flatMap((group) => group.jobs).find((job) => job.job_id === jobId)
          if (!run) return
          void onDeleteRun(run)
        }}
        onRenameRun={(jobId, runLabel) => {
          const run = groups.flatMap((group) => group.jobs).find((job) => job.job_id === jobId)
          if (!run) return
          void onRenameRun(run, runLabel)
        }}
      />

      {!activeJob && <div className="empty-state">No runs yet. Run a batch to populate the timeline.</div>}

      {activeJob && (
        <>
          <RunStatusCard
            job={activeJob}
            workflowStep={workflowStep}
            workflowSummary={workflowSummary}
            workflowGuidance={workflowGuidance}
            workflowPlaybackLabel={workflowPlaybackLabel}
            workflowBlockedReason={null}
            onRenameRun={(runLabel) => void onRenameRun(activeJob, runLabel)}
            onCancel={() => onCancelRun(activeJob)}
            onDelete={() => onDeleteRun(activeJob)}
          />

          {showTimelineCta && (
            <div className="active-run-cta soft-card">
              <div>
                <div className="section-label !mb-1">Next Step</div>
                <div className="text-sm text-white/80">
                  {canOpenTimeline ? 'Ready to finalize -> Edit Timeline' : 'All chunks selected, but timeline editing is currently blocked.'}
                </div>
                {!canOpenTimeline && workflowBlockedReason ? (
                  <div className="mt-1 text-xs text-white/45">{workflowBlockedReason}</div>
                ) : null}
              </div>
              <button className="btn-primary" onClick={onOpenExport} disabled={!canOpenTimeline}>
                Edit Timeline
              </button>
            </div>
          )}

          <div className="space-y-2">
            {activeJob.chunks.map((chunk) => (
              <ChunkRow
                key={chunk.chunk_id}
                chunk={chunk}
                selectedCandidateId={effectiveSelectedCandidateIds[chunk.chunk_id] ?? chunk.selected_candidate_id}
                presentationVariant={chunkPresentationVariants[chunk.chunk_id]}
                statusCopy={resolveChunkStatusCopy(chunkReviewStates[chunk.chunk_id], chunkPresentationVariants[chunk.chunk_id])}
                jobId={activeJob.job_id}
                jobPromptName={activeJob.prompt_name}
                jobBackend={activeJob.backend}
                bridgeUrl={bridgeUrl}
                expanded={expandedChunkIds.has(chunk.chunk_id)}
                locked={Boolean(chunkLocks[chunk.chunk_id])}
                voiceOptions={voiceOptions}
                canRegenerate
                tweakDraft={tweakDraft?.chunkId === chunk.chunk_id ? tweakDraft : null}
                onToggle={() => onToggleChunk(chunk)}
                onToggleLock={() => onToggleLock(chunk.chunk_id)}
                onSelectCandidate={(chunkId, candidateId) => onSelectCandidate(activeJob.job_id, chunkId, candidateId)}
                onPlayCandidate={(audioUrl, _chunkIndex, variantLabel) => onPlayCandidate(activeJob, chunk, audioUrl, variantLabel, chunk.generation_time)}
                onRegenerate={() => onRegenerate(activeJob, chunk)}
                onAddVersions={(count) => onRegenerate(activeJob, chunk, count)}
                onDeleteChunk={() => onDeleteChunk(activeJob, chunk)}
                onAddChunkAfter={() => onAddChunkAfter(activeJob, chunk)}
                onDeleteCandidate={(candidateId) => onDeleteCandidate(activeJob, chunk, candidateId)}
                onUpdateChunkText={(text) => onUpdateChunkText(activeJob, chunk, text)}
                draggable
                onDragStart={(event) => handleChunkDragStart(chunk.chunk_id, event)}
                onDragOver={(event) => {
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                }}
                onDrop={(event) => handleChunkDrop(activeJob, chunk.index - 1, event)}
                onTweakRegenerate={() => onOpenTweak(activeJob, chunk)}
                onUpdateTweakDraft={onUpdateTweakDraft}
                onRunTweakedRegeneration={() => onRunTweakedRegeneration(activeJob, chunk)}
                onCancelTweak={onCancelTweak}
              />
            ))}
          </div>

          {Object.values(chunkLocks).some(Boolean) && (
            <div className="flex items-center gap-2 px-1 text-[11px] text-white/35">
              <Lock className="h-3 w-3" />
              Locked chunks keep their current selection until unlocked.
            </div>
          )}
        </>
      )}
    </div>
  )
}

function resolveChunkStatusCopy(reviewState: ChunkReviewState | undefined, presentationVariant: ChunkPresentationVariant | undefined) {
  if (reviewState === 'generating') return 'Generating'
  if (reviewState === 'attention') return 'Needs review'
  if (presentationVariant === 'updated-selection') return 'Updated selection'
  if (reviewState === 'confirmed' || reviewState === 'auto-selected') return 'Selected'
  return 'Needs review'
}
