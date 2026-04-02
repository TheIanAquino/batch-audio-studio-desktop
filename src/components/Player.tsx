import { CirclePlay, Pause } from 'lucide-react'
import type { ActiveAudio } from '../types'

type Props = {
  audioRef: React.RefObject<HTMLAudioElement>
  activeAudio: ActiveAudio | null
}

export function Player({ audioRef, activeAudio }: Props) {
  const contextLabel = activeAudio
    ? activeAudio.isMix
      ? 'Full Mix'
      : activeAudio.chunkIndex != null
        ? `Chunk ${String(activeAudio.chunkIndex + 1).padStart(2, '0')} → ${activeAudio.variantLabel ?? '?'}`
        : activeAudio.label
    : 'No audio selected'

  return (
    <div className="player-container">
      <div className="section-label">Preview</div>

      <div className="mt-1.5 flex items-center gap-3">
        <button
          className="player-play-btn"
          onClick={() => activeAudio && audioRef.current?.play()}
          disabled={!activeAudio}
        >
          <CirclePlay className="h-5 w-5" />
        </button>

        <button
          className="icon-btn"
          onClick={() => audioRef.current?.pause()}
          disabled={!activeAudio}
        >
          <Pause className="h-3.5 w-3.5" />
        </button>

        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-white">{contextLabel}</div>
          <div className="mt-0.5 text-[10px] text-white/40">
            {(activeAudio?.backend === 'local' ? '⚡ Local MLX' : activeAudio?.backend === 'modal' ? '☁ Modal GPU' : 'No backend')}
            {activeAudio?.chunkIndex != null && activeAudio.variantLabel && (
              <> · {activeAudio.variantLabel}</>
            )}
            {activeAudio?.generationTime != null && <> · {activeAudio.generationTime.toFixed(1)}s</>}
          </div>
        </div>
      </div>
    </div>
  )
}
