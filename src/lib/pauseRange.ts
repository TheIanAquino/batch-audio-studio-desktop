type ClipWithLabel = {
  chunkLabel: string
}

export function normalizePauseRange(pauseMinMs: number, pauseMaxMs: number): { min: number; max: number } {
  const min = Math.max(0, Math.round(Number(pauseMinMs) || 0))
  const max = Math.max(0, Math.round(Number(pauseMaxMs) || 0))
  return min <= max ? { min, max } : { min: max, max: min }
}

function stableHashU32(value: string): number {
  const bytes = new TextEncoder().encode(value)
  let hash = 2166136261 >>> 0
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i]
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash >>> 0
}

export function deterministicPauseForGap(previousText: string, gapIndex: number, pauseMinMs: number, pauseMaxMs: number): number {
  const { min, max } = normalizePauseRange(pauseMinMs, pauseMaxMs)
  if (min === max) return min
  const seed = stableHashU32(`${gapIndex}:${previousText.trim()}`)
  const span = (max - min) + 1
  return min + (seed % span)
}

export function buildPauseGapSequence<TClip extends ClipWithLabel>(clips: TClip[], pauseMinMs: number, pauseMaxMs: number): number[] {
  if (clips.length <= 1) return []
  const pauses: number[] = []
  for (let gapIndex = 0; gapIndex < clips.length - 1; gapIndex += 1) {
    pauses.push(deterministicPauseForGap(clips[gapIndex].chunkLabel || '', gapIndex, pauseMinMs, pauseMaxMs))
  }
  return pauses
}
