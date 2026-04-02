type TrimLikeClip = {
  durationMs: number
  trimInMs: string
  trimOutMs: string
}

export type TimelineProjectionClip<TClip extends TrimLikeClip> = {
  clip: TClip
  trimInMs: number
  trimOutMs: number
  keptDurationMs: number
  gapAfterMs: number
  startMs: number
  endMs: number
  startPx: number
  endPx: number
  widthPx: number
  gapAfterPx: number
}

export type TimelineProjection<TClip extends TrimLikeClip> = {
  clips: TimelineProjectionClip<TClip>[]
  totalDurationMs: number
  contentWidthPx: number
}

export function normalizeTrimMs(value: string): number {
  return Math.max(0, Math.round(Number(value) || 0))
}

export function getKeptDurationMs(clip: TrimLikeClip): number {
  return Math.max(0, clip.durationMs - normalizeTrimMs(clip.trimInMs) - normalizeTrimMs(clip.trimOutMs))
}

export function buildTimelineProjection<TClip extends TrimLikeClip>({
  clips,
  pixelsPerMs,
  pauseBetweenClipsMs = 0,
}: {
  clips: TClip[]
  pixelsPerMs: number
  pauseBetweenClipsMs?: number | number[]
}): TimelineProjection<TClip> {
  let cursorMs = 0

  const projected = clips.map((clip, index) => {
    const trimInMs = normalizeTrimMs(clip.trimInMs)
    const trimOutMs = normalizeTrimMs(clip.trimOutMs)
    const keptDurationMs = Math.max(0, clip.durationMs - trimInMs - trimOutMs)
    const startMs = cursorMs
    const endMs = startMs + keptDurationMs
    const pauseForGap = Array.isArray(pauseBetweenClipsMs) ? (pauseBetweenClipsMs[index] ?? 0) : pauseBetweenClipsMs
    const gapAfterMs = index < clips.length - 1 ? Math.max(0, pauseForGap) : 0
    const startPx = startMs * pixelsPerMs
    const endPx = endMs * pixelsPerMs

    cursorMs = endMs + gapAfterMs

    return {
      clip,
      trimInMs,
      trimOutMs,
      keptDurationMs,
      gapAfterMs,
      startMs,
      endMs,
      startPx,
      endPx,
      widthPx: endPx - startPx,
      gapAfterPx: gapAfterMs * pixelsPerMs,
    }
  })

  return {
    clips: projected,
    totalDurationMs: cursorMs,
    contentWidthPx: cursorMs * pixelsPerMs,
  }
}

export function computeMinZoom({
  visibleWidthPx,
  totalDurationMs,
}: {
  visibleWidthPx: number
  totalDurationMs: number
}): number {
  if (totalDurationMs <= 0) return 1
  return Math.max(0, visibleWidthPx / totalDurationMs)
}

export function clampScrollLeft({
  scrollLeft,
  contentWidthPx,
  viewportWidthPx,
}: {
  scrollLeft: number
  contentWidthPx: number
  viewportWidthPx: number
}): number {
  const maxScrollLeft = Math.max(0, contentWidthPx - viewportWidthPx)
  return Math.max(0, Math.min(scrollLeft, maxScrollLeft))
}

export function clampTimeMs(timeMs: number, totalDurationMs: number): number {
  return Math.max(0, Math.min(timeMs, totalDurationMs))
}

export function timelineMsToX({
  timeMs,
  pixelsPerMs,
  totalDurationMs,
}: {
  timeMs: number
  pixelsPerMs: number
  totalDurationMs: number
}): number {
  return clampTimeMs(timeMs, totalDurationMs) * pixelsPerMs
}

export function xToTimelineMs({
  x,
  pixelsPerMs,
  totalDurationMs,
}: {
  x: number
  pixelsPerMs: number
  totalDurationMs: number
}): number {
  if (pixelsPerMs <= 0) return 0
  const contentWidthPx = totalDurationMs * pixelsPerMs
  const clampedX = Math.max(0, Math.min(x, contentWidthPx))
  return Math.round(clampedX / pixelsPerMs)
}

export function pointerClientXToTimelineMs({
  pointerClientX,
  viewportLeftPx,
  scrollLeftPx,
  pixelsPerMs,
  totalDurationMs,
}: {
  pointerClientX: number
  viewportLeftPx: number
  scrollLeftPx: number
  pixelsPerMs: number
  totalDurationMs: number
}): number {
  const pointerViewportX = pointerClientX - viewportLeftPx
  return xToTimelineMs({
    x: scrollLeftPx + pointerViewportX,
    pixelsPerMs,
    totalDurationMs,
  })
}

export function computeAnchoredScrollLeft({
  anchorTimeMs,
  pixelsPerMs,
  viewportWidthPx,
  totalDurationMs,
}: {
  anchorTimeMs: number
  pixelsPerMs: number
  viewportWidthPx: number
  totalDurationMs: number
}): number {
  const anchorX = timelineMsToX({
    timeMs: anchorTimeMs,
    pixelsPerMs,
    totalDurationMs,
  })

  return clampScrollLeft({
    scrollLeft: anchorX - viewportWidthPx / 2,
    contentWidthPx: totalDurationMs * pixelsPerMs,
    viewportWidthPx,
  })
}

export function normalizeWheelZoomDelta({
  deltaY,
  deltaMode,
  sensitivity,
  maxStep,
}: {
  deltaY: number
  deltaMode: number
  sensitivity: number
  maxStep: number
}): number {
  const modeScale = deltaMode === 1 ? 16 : deltaMode === 2 ? 120 : 1
  const raw = deltaY * modeScale * sensitivity
  return Math.max(-maxStep, Math.min(raw, maxStep))
}

export function classifyWheelIntent({
  deltaX,
  deltaY,
  shiftKey,
}: {
  deltaX: number
  deltaY: number
  shiftKey: boolean
}): 'zoom' | 'pan' {
  if (shiftKey) return 'pan'
  return Math.abs(deltaX) > Math.abs(deltaY) ? 'pan' : 'zoom'
}

export function resolveZoomAnchorTimeMs({
  pointerClientX,
  viewportLeftPx,
  viewportWidthPx,
  scrollLeftPx,
  pixelsPerMs,
  totalDurationMs,
  playheadTimeMs,
}: {
  pointerClientX: number | null
  viewportLeftPx: number
  viewportWidthPx: number
  scrollLeftPx: number
  pixelsPerMs: number
  totalDurationMs: number
  playheadTimeMs: number | null
}): number {
  const pointerViewportX = pointerClientX == null ? NaN : pointerClientX - viewportLeftPx
  const pointerInBounds = Number.isFinite(pointerViewportX) && pointerViewportX >= 0 && pointerViewportX <= viewportWidthPx

  if (pointerInBounds && pixelsPerMs > 0) {
    return clampTimeMs((scrollLeftPx + pointerViewportX) / pixelsPerMs, totalDurationMs)
  }

  if (playheadTimeMs != null && Number.isFinite(playheadTimeMs)) {
    return clampTimeMs(playheadTimeMs, totalDurationMs)
  }

  if (pixelsPerMs <= 0) return 0
  return clampTimeMs((scrollLeftPx + viewportWidthPx / 2) / pixelsPerMs, totalDurationMs)
}

export function computePointerAnchoredScrollLeft({
  anchorTimeMs,
  pointerViewportX,
  pixelsPerMs,
  viewportWidthPx,
  totalDurationMs,
}: {
  anchorTimeMs: number
  pointerViewportX: number
  pixelsPerMs: number
  viewportWidthPx: number
  totalDurationMs: number
}): number {
  const anchorX = timelineMsToX({
    timeMs: anchorTimeMs,
    pixelsPerMs,
    totalDurationMs,
  })

  return clampScrollLeft({
    scrollLeft: anchorX - pointerViewportX,
    contentWidthPx: totalDurationMs * pixelsPerMs,
    viewportWidthPx,
  })
}

export function isDragBeyondThreshold({
  startX,
  startY,
  currentX,
  currentY,
  thresholdPx,
}: {
  startX: number
  startY: number
  currentX: number
  currentY: number
  thresholdPx: number
}): boolean {
  return Math.hypot(currentX - startX, currentY - startY) > thresholdPx
}

export function computeClipInsertionIndex({
  pointerX,
  clips,
}: {
  pointerX: number
  clips: Array<{ x: number; widthPx: number }>
}): number {
  if (!clips.length) return 0
  for (let index = 0; index < clips.length; index += 1) {
    const clip = clips[index]
    const midpoint = clip.x + clip.widthPx / 2
    if (pointerX < midpoint) return index
  }
  return clips.length
}
