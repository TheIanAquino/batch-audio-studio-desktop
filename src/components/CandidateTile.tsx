import { useState } from 'react'
import { MoreVertical, Play, Trash2 } from 'lucide-react'
import type { Candidate } from '../types'
import { generateWaveform } from '../types'

type ChunkPresentationVariant = 'generating' | 'needs-review' | 'selected' | 'updated-selection'

type Props = {
  candidate: Candidate
  selected: boolean
  hasSelection: boolean
  parentPromptName?: string
  disabled?: boolean
  canDelete?: boolean
  onSelect: () => void
  onPlay: (e: React.MouseEvent) => void
  onDelete?: (e: React.MouseEvent) => void
  presentationVariant?: ChunkPresentationVariant
  selectionCopy?: string
}

export function CandidateTile({
  candidate,
  selected,
  hasSelection,
  parentPromptName,
  disabled = false,
  canDelete = false,
  onSelect,
  onPlay,
  onDelete,
  presentationVariant,
  selectionCopy,
}: Props) {
  const [moreOpen, setMoreOpen] = useState(false)
  const bars = generateWaveform(candidate.candidate_id)
  const dimmed = hasSelection && !selected
  const provenanceLabel = candidate.source_prompt_name && candidate.source_prompt_name !== parentPromptName ? candidate.source_prompt_name : null
  const tileVariant = presentationVariant ?? (selected ? 'selected' : dimmed ? 'needs-review' : 'selected')
  const tileStatus = selectionCopy ?? resolveSelectionCopy(tileVariant, selected)

  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      className={`candidate-tile candidate-tile--${tileVariant} ${selected ? 'candidate-tile--selected' : ''} ${dimmed ? 'candidate-tile--dimmed' : ''} ${disabled ? 'candidate-tile--locked' : ''}`}
      onClick={disabled ? undefined : onSelect}
      onKeyDown={(event) => {
        if (disabled) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect()
        }
      }}
      title={disabled ? 'Unlock this chunk to change the selection' : 'Click to select'}
    >
      <div className="candidate-tile__header">
        <span className={`candidate-tile__variant ${selected ? 'candidate-tile__variant--selected' : ''}`}>
          {candidate.variant_label}
        </span>
        <div className="candidate-tile__utility">
          {candidate.duration != null && (
            <span className="candidate-tile__duration">{candidate.duration.toFixed(1)}s</span>
          )}
          <button type="button" className="candidate-tile__play" onClick={onPlay} title="Preview version">
            <Play className="h-3 w-3" />
          </button>
          {canDelete && onDelete && (
            <div className="candidate-tile__more">
              <button
                type="button"
                className={`candidate-tile__more-trigger ${moreOpen ? 'candidate-tile__more-trigger--active' : ''}`}
                onClick={(e) => {
                  e.stopPropagation()
                  setMoreOpen((current) => !current)
                }}
                aria-expanded={moreOpen}
                aria-haspopup="menu"
                title="More candidate actions"
              >
                <MoreVertical className="h-3.5 w-3.5" />
              </button>
              {moreOpen && (
                <div className="candidate-tile__menu" role="menu" aria-label={`Candidate ${candidate.variant_label} actions`}>
                  <button
                    type="button"
                    className="candidate-tile__menu-item candidate-tile__menu-item--danger"
                    onClick={(e) => {
                      e.stopPropagation()
                      setMoreOpen(false)
                      onDelete(e)
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Delete version
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="candidate-tile__status-row">
        <span className={`candidate-tile__status candidate-tile__status--${tileVariant}`}>
          {tileStatus}
        </span>
        {provenanceLabel && (
          <span className="candidate-provenance candidate-tile__provenance">
            {provenanceLabel}
          </span>
        )}
      </div>

      <div className="mini-waveform mt-1.5">
        {bars.map((h, i) => (
          <div
            key={i}
            className="mini-waveform__bar"
            style={{ height: `${h * 100}%` }}
          />
        ))}
      </div>

      {candidate.status === 'generating' && (
        <div className="skeleton mt-1" style={{ height: 3, borderRadius: 2 }} />
      )}
    </div>
  )
}

function resolveSelectionCopy(variant: ChunkPresentationVariant, selected: boolean) {
  if (variant === 'updated-selection') return 'Updated selection'
  if (variant === 'needs-review') return 'Needs review'
  if (variant === 'generating') return 'Generating'
  if (selected || variant === 'selected') return 'Selected'
  return 'Needs review'
}
