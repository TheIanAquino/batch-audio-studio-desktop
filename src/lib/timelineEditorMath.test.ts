import { describe, expect, it } from 'vitest'
import {
  buildTimelineProjection,
  classifyWheelIntent,
  clampScrollLeft,
  computeClipInsertionIndex,
  computeAnchoredScrollLeft,
  computePointerAnchoredScrollLeft,
  computeMinZoom,
  isDragBeyondThreshold,
  normalizeWheelZoomDelta,
  pointerClientXToTimelineMs,
  resolveZoomAnchorTimeMs,
  timelineMsToX,
  xToTimelineMs,
} from './timelineEditorMath'

describe('timelineEditorMath', () => {
  it('computes total duration from kept durations only', () => {
    const result = buildTimelineProjection({
      clips: [
        { durationMs: 1000, trimInMs: '100', trimOutMs: '200' },
        { durationMs: 800, trimInMs: '0', trimOutMs: '300' },
      ],
      pixelsPerMs: 0.5,
    })

    expect(result.totalDurationMs).toBe(1200)
    expect(result.clips.map((clip) => [clip.startMs, clip.endMs])).toEqual([
      [0, 700],
      [700, 1200],
    ])
  })

  it('computes fit-all zoom from visible width and total duration', () => {
    expect(computeMinZoom({ visibleWidthPx: 600, totalDurationMs: 2000 })).toBeCloseTo(0.3)
  })

  it('maps the full timeline exactly from 0 to total duration', () => {
    expect(timelineMsToX({ timeMs: 0, pixelsPerMs: 0.5, totalDurationMs: 1200 })).toBe(0)
    expect(timelineMsToX({ timeMs: 1200, pixelsPerMs: 0.5, totalDurationMs: 1200 })).toBe(600)
    expect(xToTimelineMs({ x: 600, pixelsPerMs: 0.5, totalDurationMs: 1200 })).toBe(1200)
  })

  it('does not allow scrolling past the real end of the timeline', () => {
    expect(clampScrollLeft({ scrollLeft: 700, contentWidthPx: 600, viewportWidthPx: 400 })).toBe(200)
  })

  it('preserves the anchor time when zoom changes', () => {
    expect(
      computeAnchoredScrollLeft({
        anchorTimeMs: 1000,
        pixelsPerMs: 0.8,
        viewportWidthPx: 400,
        totalDurationMs: 2000,
      }),
    ).toBe(600)
  })

  it('normalizes large mouse-wheel and small trackpad deltas into controlled zoom steps', () => {
    expect(normalizeWheelZoomDelta({ deltaY: 120, deltaMode: 0, sensitivity: 0.002, maxStep: 0.18 })).toBeCloseTo(0.18)
    expect(normalizeWheelZoomDelta({ deltaY: 2.5, deltaMode: 0, sensitivity: 0.002, maxStep: 0.18 })).toBeCloseTo(0.005)
  })

  it('routes horizontal gestures to pan and vertical gestures to zoom', () => {
    expect(classifyWheelIntent({ deltaX: 18, deltaY: 4, shiftKey: false })).toBe('pan')
    expect(classifyWheelIntent({ deltaX: 0, deltaY: 16, shiftKey: false })).toBe('zoom')
    expect(classifyWheelIntent({ deltaX: 0, deltaY: 16, shiftKey: true })).toBe('pan')
  })

  it('falls back from pointer to playhead to viewport center when pointer context is invalid', () => {
    expect(
      resolveZoomAnchorTimeMs({
        pointerClientX: null,
        viewportLeftPx: 100,
        viewportWidthPx: 400,
        scrollLeftPx: 300,
        pixelsPerMs: 0.5,
        totalDurationMs: 2000,
        playheadTimeMs: 900,
      }),
    ).toBe(900)

    expect(
      resolveZoomAnchorTimeMs({
        pointerClientX: null,
        viewportLeftPx: 100,
        viewportWidthPx: 400,
        scrollLeftPx: 300,
        pixelsPerMs: 0.5,
        totalDurationMs: 2000,
        playheadTimeMs: null,
      }),
    ).toBe(1000)
  })

  it('computes pointer time from clientX relative to the viewport', () => {
    expect(
      resolveZoomAnchorTimeMs({
        pointerClientX: 260,
        viewportLeftPx: 100,
        viewportWidthPx: 400,
        scrollLeftPx: 300,
        pixelsPerMs: 0.5,
        totalDurationMs: 2000,
        playheadTimeMs: 900,
      }),
    ).toBe(920)
  })

  it('distinguishes clicks from drags with a small movement threshold', () => {
    expect(isDragBeyondThreshold({ startX: 10, startY: 10, currentX: 12, currentY: 12, thresholdPx: 5 })).toBe(false)
    expect(isDragBeyondThreshold({ startX: 10, startY: 10, currentX: 18, currentY: 12, thresholdPx: 5 })).toBe(true)
  })

  it('keeps the same time under the pointer after zooming', () => {
    expect(
      computePointerAnchoredScrollLeft({
        anchorTimeMs: 920,
        pointerViewportX: 160,
        pixelsPerMs: 0.8,
        viewportWidthPx: 400,
        totalDurationMs: 2000,
      }),
    ).toBeCloseTo(576)
  })

  it('includes inter-clip pauses in total duration', () => {
    const result = buildTimelineProjection({
      clips: [
        { durationMs: 1000, trimInMs: '0', trimOutMs: '0' },
        { durationMs: 500, trimInMs: '0', trimOutMs: '0' },
      ],
      pixelsPerMs: 1,
      pauseBetweenClipsMs: 420,
    })

    expect(result.totalDurationMs).toBe(1920)
  })

  it('offsets later clips by prior pause duration', () => {
    const result = buildTimelineProjection({
      clips: [
        { durationMs: 1000, trimInMs: '100', trimOutMs: '100' },
        { durationMs: 800, trimInMs: '0', trimOutMs: '300' },
      ],
      pixelsPerMs: 1,
      pauseBetweenClipsMs: 420,
    })

    expect(result.clips.map((clip) => [clip.startMs, clip.endMs])).toEqual([
      [0, 800],
      [1220, 1720],
    ])
  })

  it('treats pause space as real time in x/time conversion', () => {
    expect(xToTimelineMs({ x: 1000, pixelsPerMs: 1, totalDurationMs: 1920 })).toBe(1000)
  })

  it('maps clientX to timeline time without double-counting scroll offset', () => {
    expect(
      pointerClientXToTimelineMs({
        pointerClientX: 260,
        viewportLeftPx: 100,
        scrollLeftPx: 600,
        pixelsPerMs: 1,
        totalDurationMs: 2000,
      }),
    ).toBe(760)
  })

  it('computes insertion index for timeline drag/drop from pointer position', () => {
    const clips = [
      { x: 0, widthPx: 100 },
      { x: 140, widthPx: 100 },
      { x: 280, widthPx: 100 },
    ]

    expect(computeClipInsertionIndex({ pointerX: -8, clips })).toBe(0)
    expect(computeClipInsertionIndex({ pointerX: 30, clips })).toBe(0)
    expect(computeClipInsertionIndex({ pointerX: 95, clips })).toBe(1)
    expect(computeClipInsertionIndex({ pointerX: 210, clips })).toBe(2)
    expect(computeClipInsertionIndex({ pointerX: 410, clips })).toBe(3)
  })
})
