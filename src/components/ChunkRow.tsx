import { useEffect, useState, type DragEvent } from 'react'
import { ChevronRight, ChevronDown, Cloud, Lock, MoreVertical, Plus, RotateCcw, SlidersHorizontal, Unlock, Zap, Trash2 } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import { CandidateTile } from './CandidateTile'
import { compareVariantLabels } from '../lib/jobMetrics'
import type { ChunkTweakDraft, JobChunk } from '../types'

type ChunkPresentationVariant = 'generating' | 'needs-review' | 'selected' | 'updated-selection'

type Props = {
  chunk: JobChunk
  selectedCandidateId?: string | null
  jobId: string
  jobPromptName: string
  jobBackend: string
  bridgeUrl: string
  expanded: boolean
  locked: boolean
  voiceOptions: string[]
  onToggle: () => void
  onToggleLock: () => void
  onSelectCandidate: (chunkId: string, candidateId: string) => void
  onPlayCandidate: (audioUrl: string, chunkIndex: number, variantLabel: string) => void
  onRegenerate: () => void
  onAddVersions: (count: number) => void
  onDeleteChunk: () => void
  onAddChunkAfter: () => void
  onDeleteCandidate: (candidateId: string) => void
  onUpdateChunkText: (text: string) => void | Promise<void>
  onDragStart?: (event: DragEvent<HTMLDivElement>) => void
  onDragOver?: (event: DragEvent<HTMLDivElement>) => void
  onDrop?: (event: DragEvent<HTMLDivElement>) => void
  draggable?: boolean
  onTweakRegenerate: () => void
  canRegenerate: boolean
  tweakDraft: ChunkTweakDraft | null
  onUpdateTweakDraft: (updater: (draft: ChunkTweakDraft) => ChunkTweakDraft) => void
  onRunTweakedRegeneration: () => void
  onCancelTweak: () => void
  presentationVariant?: ChunkPresentationVariant
  statusCopy?: string
}

export function ChunkRow({
  chunk,
  selectedCandidateId,
  jobId,
  jobPromptName,
  jobBackend,
  bridgeUrl,
  expanded,
  locked,
  voiceOptions,
  onToggle,
  onToggleLock,
  onSelectCandidate,
  onPlayCandidate,
  onRegenerate,
  onAddVersions,
  onDeleteChunk,
  onAddChunkAfter,
  onDeleteCandidate,
  onUpdateChunkText,
  onDragStart,
  onDragOver,
  onDrop,
  draggable = false,
  onTweakRegenerate,
  canRegenerate,
  tweakDraft,
  onUpdateTweakDraft,
  onRunTweakedRegeneration,
  onCancelTweak,
  presentationVariant,
  statusCopy,
}: Props) {
  const [addVersionCount, setAddVersionCount] = useState(1)
  const [moreOpen, setMoreOpen] = useState(false)
  const [textDraft, setTextDraft] = useState(chunk.text)
  useEffect(() => {
    setTextDraft(chunk.text)
  }, [chunk.text, chunk.chunk_id])

  const selectedCandidate = chunk.candidates.find((candidate) => candidate.candidate_id === (selectedCandidateId ?? chunk.selected_candidate_id)) ?? null
  const hasSelection = selectedCandidate != null
  const chunkStatus = chunk.status ?? (chunk.candidates.length > 0 ? 'completed' : 'queued')
  const isGenerating = chunkStatus === 'running' || chunkStatus === 'canceling'
  const isTweaking = tweakDraft?.chunkId === chunk.chunk_id
  const sortedCandidates = [...chunk.candidates].sort((left, right) => compareVariantLabels(left.variant_label, right.variant_label))
  const computedVariant = resolvePresentationVariant(chunkStatus, hasSelection, locked, chunk.candidates.length > 0)
  const chunkVariant = presentationVariant ?? computedVariant
  const chunkLabel = statusCopy ?? resolveStatusCopy(chunkVariant, chunkStatus)

  const [isDragging, setIsDragging] = useState(false)

  return (
    <div
      className={`chunk-row chunk-row--${chunkVariant} ${hasSelection ? 'chunk-row--has-selection' : ''} ${expanded ? 'chunk-row--expanded' : ''} ${isDragging ? 'chunk-row--dragging' : ''}`}
      draggable={draggable}
      onDragStart={(event) => {
        setIsDragging(true)
        onDragStart?.(event)
      }}
      onDragEnd={() => setIsDragging(false)}
      onDragOver={onDragOver}
      onDrop={(event) => {
        setIsDragging(false)
        onDrop?.(event)
      }}
    >
      <button className="chunk-row__header" onClick={() => { setMoreOpen(false); onToggle() }} type="button">
        {expanded ? (
          <ChevronDown className="chunk-row__chevron" />
        ) : (
          <ChevronRight className="chunk-row__chevron" />
        )}

        <span className="chunk-row__index">
          {String(chunk.index).padStart(2, '0')}
        </span>

        <span className="chunk-row__title">
          {chunk.text}
        </span>

        <span className={`chunk-row__status chunk-row__status--${chunkVariant}`}>
          {chunkLabel}
        </span>

        {!expanded && hasSelection && selectedCandidate && (
          <span className="chunk-row__selection-chip">
            <span>{selectedCandidate.variant_label}</span>
            <span className="chunk-row__selection-chip-separator">·</span>
            <span>{chunk.candidates.length}v</span>
          </span>
        )}

        <span className="chunk-row__meta">
          {locked && (
            <span className="chunk-row__lock-state">
              <Lock className="h-2.5 w-2.5" />
              Locked
            </span>
          )}

          {chunk.generation_time != null && (
            <span className="chunk-row__duration">
              {chunk.generation_time.toFixed(1)}s
            </span>
          )}

          {expanded ? (
            jobBackend === 'local' ? (
              <Zap className="chunk-row__backend chunk-row__backend--local" />
            ) : (
              <Cloud className="chunk-row__backend chunk-row__backend--modal" />
            )
          ) : null}
        </span>
      </button>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
            className="overflow-hidden"
          >
            <div className="chunk-row__candidates soft-scroll">
              {isGenerating && chunk.candidates.length === 0 ? (
                <>
                  <div className="skeleton skeleton-tile" />
                  <div className="skeleton skeleton-tile" />
                  <div className="skeleton skeleton-tile" />
                </>
              ) : (
                sortedCandidates.map((candidate) => (
                  <CandidateTile
                    key={candidate.candidate_id}
                    candidate={candidate}
                    selected={selectedCandidate?.candidate_id === candidate.candidate_id}
                    hasSelection={hasSelection}
                    parentPromptName={jobPromptName}
                    disabled={locked}
                    onSelect={() => onSelectCandidate(chunk.chunk_id, candidate.candidate_id)}
                    onPlay={(e) => {
                      e.stopPropagation()
                      onPlayCandidate(candidate.audio_url, chunk.index, candidate.variant_label)
                    }}
                    canDelete={!locked}
                    onDelete={(e) => {
                      e.stopPropagation()
                      onDeleteCandidate(candidate.candidate_id)
                    }}
                    presentationVariant={selectedCandidate?.candidate_id === candidate.candidate_id ? chunkVariant : 'needs-review'}
                    selectionCopy={selectedCandidate?.candidate_id === candidate.candidate_id ? chunkLabel : undefined}
                  />
                ))
              )}
            </div>

            <div className="chunk-row__actions">
              <button
                type="button"
                className="ghost-btn"
                onClick={(event) => {
                  event.stopPropagation()
                  onRegenerate()
                }}
                disabled={!canRegenerate}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Regenerate
              </button>
              <button
                type="button"
                className="ghost-btn"
                onClick={(event) => {
                  event.stopPropagation()
                  onAddVersions(Math.max(1, addVersionCount))
                }}
                disabled={!canRegenerate}
              >
                <Plus className="h-3.5 w-3.5" />
                + Versions
              </button>
              <button
                type="button"
                className={`chunk-row__more-trigger ${moreOpen ? 'chunk-row__more-trigger--active' : ''}`}
                onClick={(e) => {
                  e.stopPropagation()
                  setMoreOpen((current) => !current)
                }}
                aria-expanded={moreOpen}
                aria-haspopup="menu"
              >
                <MoreVertical className="h-3.5 w-3.5" />
                More
              </button>

              {chunk.generation_time != null && (
                <span className="chunk-row__generated-time">
                  Generated in {chunk.generation_time.toFixed(1)}s
                </span>
              )}
            </div>

            <div className="chunk-row__text-editor">
              <label className="block">
                <div className="mb-1 text-[10px] text-white/40">Chunk text</div>
                <textarea
                  className="aurora-textarea h-[78px] !text-[12px]"
                  value={textDraft}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => setTextDraft(event.target.value)}
                />
              </label>
              <div className="chunk-row__text-editor-actions">
                <button className="ghost-btn" type="button" onClick={() => setTextDraft(chunk.text)}>
                  Reset
                </button>
                <button
                  className="btn-primary"
                  type="button"
                  onClick={() => onUpdateChunkText(textDraft)}
                  disabled={!textDraft.trim() || textDraft.trim() === chunk.text.trim()}
                >
                  Save Text
                </button>
              </div>
            </div>

            {moreOpen && (
              <div className="chunk-row__menu" role="menu" aria-label={`Chunk ${String(chunk.index).padStart(2, '0')} actions`}>
                <button
                  type="button"
                  className="chunk-row__menu-item"
                  onClick={(e) => {
                    e.stopPropagation()
                    setMoreOpen(false)
                    onToggleLock()
                  }}
                >
                  {locked ? <Unlock className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
                  {locked ? 'Unlock selection' : 'Lock selection'}
                </button>

                <button
                  type="button"
                  className="chunk-row__menu-item"
                  onClick={(e) => {
                    e.stopPropagation()
                    setMoreOpen(false)
                    onRegenerate()
                  }}
                  disabled={!canRegenerate}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Regenerate chunk
                </button>

                <div className="chunk-row__menu-group">
                  <div className="chunk-row__menu-group-label">Number of versions</div>
                  <div className="chunk-row__menu-inline">
                    <input
                      type="number"
                      min={1}
                      max={12}
                      className="chunk-row__menu-input"
                      value={addVersionCount}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(event) => {
                        const next = Number(event.target.value)
                        setAddVersionCount(Number.isFinite(next) ? Math.max(1, Math.min(12, Math.round(next))) : 1)
                      }}
                    />
                    <button
                      type="button"
                      className="chunk-row__menu-inline-action"
                      onClick={(e) => {
                        e.stopPropagation()
                        setMoreOpen(false)
                        onAddVersions(addVersionCount)
                      }}
                      disabled={!canRegenerate}
                    >
                      + Versions
                    </button>
                  </div>
                </div>

                <button
                  type="button"
                  className="chunk-row__menu-item"
                  onClick={(e) => {
                    e.stopPropagation()
                    setMoreOpen(false)
                    onTweakRegenerate()
                  }}
                  disabled={!canRegenerate}
                >
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                  Tweak / route
                </button>

                <button
                  type="button"
                  className="chunk-row__menu-item"
                  onClick={(e) => {
                    e.stopPropagation()
                    setMoreOpen(false)
                    onAddChunkAfter()
                  }}
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add chunk after
                </button>

                <button
                  type="button"
                  className="chunk-row__menu-item chunk-row__menu-item--danger"
                  onClick={(e) => {
                    e.stopPropagation()
                    setMoreOpen(false)
                    onDeleteChunk()
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete chunk
                </button>
              </div>
            )}

            {isTweaking && tweakDraft && (
              <div className="chunk-tweak-panel mt-3">
                <div className="section-label !mb-2">Tweak + Regen</div>
                <label className="block">
                  <div className="mb-1 text-[10px] text-white/40">Prompt</div>
                  <select
                    className="aurora-input !py-1.5 !text-[11px]"
                    value={tweakDraft.promptName}
                    onChange={(event) => onUpdateTweakDraft((draft) => ({ ...draft, promptName: event.target.value, dirty: true }))}
                  >
                    {voiceOptions.map((voiceName) => (
                      <option key={voiceName} value={voiceName}>
                        {voiceName}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <div className="mb-1 text-[10px] text-white/40">Chunk text</div>
                  <textarea
                    className="aurora-textarea h-[84px] !text-[12px]"
                    value={tweakDraft.textOverride}
                    onChange={(event) => onUpdateTweakDraft((draft) => ({ ...draft, textOverride: event.target.value, dirty: true }))}
                  />
                </label>
                <div className="mt-2 grid grid-cols-3 gap-2">
                  <label className="block">
                    <div className="mb-1 text-[10px] text-white/40">Regens</div>
                    <input
                      type="number"
                      min={1}
                      max={12}
                      className="aurora-input !py-1.5 !text-[11px]"
                      value={tweakDraft.variantCount}
                      onChange={(event) => onUpdateTweakDraft((draft) => ({ ...draft, variantCount: Number(event.target.value) || 1, dirty: true }))}
                    />
                  </label>
                  <label className="block">
                    <div className="mb-1 text-[10px] text-white/40">Speed</div>
                    <input
                      type="number"
                      step="0.01"
                      className="aurora-input !py-1.5 !text-[11px]"
                      value={tweakDraft.speed}
                      onChange={(event) => onUpdateTweakDraft((draft) => ({ ...draft, speed: Number(event.target.value) || draft.speed, dirty: true }))}
                    />
                  </label>
                  <label className="block">
                    <div className="mb-1 text-[10px] text-white/40">Pause ms</div>
                    <input
                      type="number"
                      className="aurora-input !py-1.5 !text-[11px]"
                      value={tweakDraft.pauseMs}
                      onChange={(event) => onUpdateTweakDraft((draft) => ({ ...draft, pauseMs: Number(event.target.value) || draft.pauseMs, dirty: true }))}
                    />
                  </label>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <div className="segment-group">
                    <button className={`segment-pill ${tweakDraft.backend === 'modal' ? 'segment-pill--active' : ''}`} onClick={() => onUpdateTweakDraft((draft) => ({ ...draft, backend: 'modal', dirty: true }))}>Modal</button>
                    <button className={`segment-pill ${tweakDraft.backend === 'local' ? 'segment-pill--active' : ''}`} onClick={() => onUpdateTweakDraft((draft) => ({ ...draft, backend: 'local', dirty: true }))}>Local</button>
                  </div>
                  <input
                    className="aurora-input !py-1.5 !text-[11px]"
                    value={tweakDraft.language}
                    onChange={(event) => onUpdateTweakDraft((draft) => ({ ...draft, language: event.target.value, dirty: true }))}
                    placeholder="Language"
                  />
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <button className="btn-primary" onClick={onRunTweakedRegeneration}>Run Regen</button>
                  <button className="ghost-btn" onClick={onCancelTweak}>Cancel Tweak</button>
                </div>
              </div>
            )}

            {chunk.error_message && <div className="mt-2 error-banner">{chunk.error_message}</div>}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function resolvePresentationVariant(
  chunkStatus: string,
  hasSelection: boolean,
  locked: boolean,
  hasCandidates: boolean,
): ChunkPresentationVariant {
  if (chunkStatus === 'running' || chunkStatus === 'canceling') return 'generating'
  if (chunkStatus === 'failed' || chunkStatus === 'interrupted' || chunkStatus === 'canceled') return 'needs-review'
  if (locked && hasSelection) return 'selected'
  if (hasSelection) return 'selected'
  if (hasCandidates) return 'needs-review'
  return 'generating'
}

function resolveStatusCopy(variant: ChunkPresentationVariant, chunkStatus: string) {
  if (variant === 'generating') return 'Generating'
  if (variant === 'needs-review') return 'Needs review'
  if (variant === 'selected') return 'Selected'
  if (variant === 'updated-selection') return 'Updated selection'
  if (chunkStatus === 'failed') return 'Needs review'
  if (chunkStatus === 'interrupted') return 'Needs review'
  if (chunkStatus === 'canceling') return 'Generating'
  return 'Selected'
}
