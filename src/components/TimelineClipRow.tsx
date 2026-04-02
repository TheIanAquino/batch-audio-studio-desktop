import type { DragEvent } from 'react'
import { GripVertical } from 'lucide-react'
import type { TimelineClipDraft } from '../types'
import { generateWaveform } from '../types'

type Props = {
  clip: TimelineClipDraft
  index: number
  locked: boolean
  onDragStart: () => void
  onDragOver: (event: DragEvent<HTMLDivElement>) => void
  onDrop: () => void
  onTrimChange: (field: 'trimInMs' | 'trimOutMs', value: string) => void
}

export function TimelineClipRow({ clip, index, locked, onDragStart, onDragOver, onDrop, onTrimChange }: Props) {
  const keptDurationMs = Math.max(0, clip.durationMs - (Math.round(Number(clip.trimInMs) || 0) + Math.round(Number(clip.trimOutMs) || 0)))
  const waveform = generateWaveform(`${clip.candidateId}:${clip.durationMs}`, 32)

  return (
    <div
      className={`timeline-clip-row ${locked ? 'timeline-clip-row--locked' : ''}`}
      draggable={!locked}
      onDragStart={locked ? undefined : onDragStart}
      onDragOver={locked ? undefined : onDragOver}
      onDrop={locked ? undefined : onDrop}
    >
      <div className="timeline-clip-row__meta">
        <div className="timeline-clip-row__handle"><GripVertical className="h-4 w-4" /></div>
        <div>
          <div className="text-xs font-medium text-white">Clip {String(index + 1).padStart(2, '0')}</div>
          <div className="text-[11px] text-white/45 line-clamp-1">{clip.chunkLabel}</div>
        </div>
        <div className="ml-auto text-[10px] text-neon/70">{clip.candidateLabel}</div>
      </div>

      <div className="timeline-strip" aria-hidden="true">
        {waveform.map((value, barIndex) => (
          <span key={`${clip.candidateId}-${barIndex}`} style={{ height: `${Math.round(value * 32)}px` }} />
        ))}
      </div>

      <div className="timeline-clip-row__controls">
        <label>
          <span>Original</span>
          <strong>{(clip.durationMs / 1000).toFixed(2)}s</strong>
        </label>
        <label>
          <span>Trim In</span>
          <input className="aurora-input !py-1.5 !text-[11px]" value={clip.trimInMs} disabled={locked} onChange={(event) => onTrimChange('trimInMs', event.target.value)} />
        </label>
        <label>
          <span>Trim Out</span>
          <input className="aurora-input !py-1.5 !text-[11px]" value={clip.trimOutMs} disabled={locked} onChange={(event) => onTrimChange('trimOutMs', event.target.value)} />
        </label>
        <label>
          <span>Kept</span>
          <strong>{(keptDurationMs / 1000).toFixed(2)}s</strong>
        </label>
      </div>
    </div>
  )
}
