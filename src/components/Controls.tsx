import { useEffect, useState } from 'react'
import type { ChunkTweakDraft } from '../types'

type Props = {
  speed: number
  setSpeed: (v: number) => void
  pauseMinMs: number
  setPauseMinMs: (v: number) => void
  pauseMaxMs: number
  setPauseMaxMs: (v: number) => void
  variantCount: number
  setVariantCount: (v: number) => void
  language: string
  setLanguage: (v: string) => void
  backend: 'modal' | 'local'
  setBackend: (v: 'modal' | 'local') => void
  tweakDraft: ChunkTweakDraft | null
  setTweakDraft: ((updater: (draft: ChunkTweakDraft) => ChunkTweakDraft) => void) | null
  onClearTweak: () => void
}

export function Controls({
  speed,
  setSpeed,
  pauseMinMs,
  setPauseMinMs,
  pauseMaxMs,
  setPauseMaxMs,
  variantCount,
  setVariantCount,
  language,
  setLanguage,
  backend,
  setBackend,
  tweakDraft,
  setTweakDraft,
  onClearTweak,
}: Props) {
  const modeLabel = tweakDraft ? `Chunk Tweak · ${tweakDraft.chunkId}` : 'Generation Controls'
  const currentSpeed = tweakDraft?.speed ?? speed
  const currentVariants = tweakDraft?.variantCount ?? variantCount
  const currentLanguage = tweakDraft?.language ?? language
  const currentBackend = tweakDraft?.backend ?? backend

  const updateOrGlobal = <K extends keyof ChunkTweakDraft>(key: K, value: ChunkTweakDraft[K], fallback: () => void) => {
    if (tweakDraft && setTweakDraft) {
      setTweakDraft((draft) => ({ ...draft, [key]: value }))
      return
    }
    fallback()
  }

  return (
    <div>
      <div className="section-label">{modeLabel}</div>
      {tweakDraft && (
        <div className="mb-2 flex items-center justify-between gap-2 text-[10px] text-white/45">
          <span>Temporary overrides stay on this chunk until cleared.</span>
          <button className="ghost-btn" onClick={onClearTweak}>Clear</button>
        </div>
      )}
      <div className="mt-1 space-y-0.5">
        <SliderRow label="Speed" value={currentSpeed.toFixed(2)} sliderValue={Math.round(currentSpeed * 100)} min={50} max={125} onChange={(v) => updateOrGlobal('speed', Math.max(0.5, v / 100), () => setSpeed(Math.max(0.5, v / 100)))} />
        <PauseRangeRow
          pauseMinMs={pauseMinMs}
          pauseMaxMs={pauseMaxMs}
          onChangeMin={(value) => {
            const next = Math.max(0, Math.min(value, pauseMaxMs))
            setPauseMinMs(next)
          }}
          onChangeMax={(value) => {
            const next = Math.max(0, Math.max(value, pauseMinMs))
            setPauseMaxMs(next)
          }}
        />
        <SliderRow label="Number of versions" value={String(currentVariants)} sliderValue={currentVariants} min={1} max={12} onChange={(v) => updateOrGlobal('variantCount', v, () => setVariantCount(v))} />
        <div className="control-row">
          <span className="control-label">Backend</span>
          <div className="segment-group flex-1">
            <button className={`segment-pill ${currentBackend === 'modal' ? 'segment-pill--active' : ''}`} onClick={() => updateOrGlobal('backend', 'modal', () => setBackend('modal'))}>Modal</button>
            <button className={`segment-pill ${currentBackend === 'local' ? 'segment-pill--active' : ''}`} onClick={() => updateOrGlobal('backend', 'local', () => setBackend('local'))}>Local</button>
          </div>
        </div>
        <div className="control-row">
          <span className="control-label">Language</span>
          <input
            className="aurora-input flex-1 !py-1 !px-2 !text-[11px] !rounded-lg"
            value={currentLanguage}
            onChange={(e) => updateOrGlobal('language', e.target.value, () => setLanguage(e.target.value))}
          />
        </div>
      </div>
    </div>
  )
}

function PauseRangeRow({
  pauseMinMs,
  pauseMaxMs,
  onChangeMin,
  onChangeMax,
}: {
  pauseMinMs: number
  pauseMaxMs: number
  onChangeMin: (value: number) => void
  onChangeMax: (value: number) => void
}) {
  const clampMs = (value: number) => Math.max(0, Math.min(2000, Math.round(value)))
  const [minInput, setMinInput] = useState(String(pauseMinMs))
  const [maxInput, setMaxInput] = useState(String(pauseMaxMs))

  useEffect(() => {
    setMinInput(String(pauseMinMs))
  }, [pauseMinMs])

  useEffect(() => {
    setMaxInput(String(pauseMaxMs))
  }, [pauseMaxMs])

  const commitMin = () => {
    const parsed = clampMs(Number(minInput))
    onChangeMin(Number.isFinite(parsed) ? parsed : pauseMinMs)
    setMinInput(String(Number.isFinite(parsed) ? Math.min(parsed, pauseMaxMs) : pauseMinMs))
  }

  const commitMax = () => {
    const parsed = clampMs(Number(maxInput))
    onChangeMax(Number.isFinite(parsed) ? parsed : pauseMaxMs)
    setMaxInput(String(Number.isFinite(parsed) ? Math.max(parsed, pauseMinMs) : pauseMaxMs))
  }

  return (
    <div className="pause-range-control">
      <div className="pause-range-control__head">
        <span className="control-label">Pause range</span>
        <span className="pause-range-control__value">{`${pauseMinMs}-${pauseMaxMs}ms`}</span>
      </div>

      <div className="pause-range-control__inputs">
        <label className="pause-range-control__field">
          <span>Min</span>
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            className="pause-range-control__number"
            value={minInput}
            onChange={(event) => setMinInput(event.target.value.replace(/[^\d]/g, ''))}
            onBlur={commitMin}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                commitMin()
              }
            }}
          />
        </label>
        <label className="pause-range-control__field">
          <span>Max</span>
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            className="pause-range-control__number"
            value={maxInput}
            onChange={(event) => setMaxInput(event.target.value.replace(/[^\d]/g, ''))}
            onBlur={commitMax}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                commitMax()
              }
            }}
          />
        </label>
      </div>

      <div className="pause-range-control__sliders">
        <input type="range" className="control-slider" min={0} max={2000} value={pauseMinMs} onChange={(event) => onChangeMin(Number(event.target.value))} />
        <input type="range" className="control-slider" min={0} max={2000} value={pauseMaxMs} onChange={(event) => onChangeMax(Number(event.target.value))} />
      </div>
    </div>
  )
}

function SliderRow({ label, value, sliderValue, min, max, onChange }: {
  label: string
  value: string
  sliderValue: number
  min: number
  max: number
  onChange: (v: number) => void
}) {
  return (
    <div className="control-row">
      <span className="control-label">{label}</span>
      <input
        type="range"
        className="control-slider"
        min={min}
        max={max}
        value={sliderValue}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="control-value">{value}</span>
    </div>
  )
}
