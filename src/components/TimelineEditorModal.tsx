import { useEffect, useMemo, useRef, useState } from 'react'
import { CirclePause, CirclePlay, Clock3, CopyPlus, LoaderCircle, ScissorsLineDashed, Sparkle, Wand2 } from 'lucide-react'
import type { Job, TimelineDraft, TimelineRenderStatus } from '../types'
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
  timelineMsToX as projectTimelineMsToX,
  xToTimelineMs as projectXToTimelineMs,
} from '../lib/timelineEditorMath'

type Props = {
  job: Job
  draft: TimelineDraft
  pauseBetweenClipsMs: number | number[]
  inlineError: string
  totalDurationMs: number
  currentTimeMs: number
  isPlaying: boolean
  canPlayPreview: boolean
  isReadonly: boolean
  renderStatus: TimelineRenderStatus
  onClose: () => void
  onTogglePlayback: () => void
  onPreview: () => void
  onExport: () => void
  onTrimChange: (clipIndex: number, field: 'trimInMs' | 'trimOutMs', value: string) => void
  onSeek: (timeMs: number) => void
  onSwapCandidate: (clipIndex: number, candidateId: string) => void
  onPreviewCandidate: (clipIndex: number, candidateId: string) => void
  onAddChunkAfter: (clipIndex: number) => void | Promise<void>
  onRegenerateChunk: (clipIndex: number) => void | Promise<void>
  onAddVersions: (clipIndex: number, count: number) => void | Promise<void>
  onUpdateChunkText: (clipIndex: number, text: string) => void | Promise<void>
  onReorderClip: (fromIndex: number, toIndex: number) => void | Promise<void>
  onReplaceDraft: (updater: (draft: TimelineDraft) => TimelineDraft) => void
}

type DragState = {
  clipIndex: number
  edge: 'left' | 'right'
  startClientX: number
  startTrimMs: number
} | null

type ScrubState = {
  mode: 'playhead' | 'hand'
  originClientX: number
  originScrollLeft: number
} | null

type PendingSeekState = {
  pointerId: number
  startClientX: number
  startClientY: number
  moved: boolean
  blockSeek: boolean
} | null

type TimelineDraftSnapshot = {
  clips: TimelineDraft['clips']
}

const CLICK_DRAG_THRESHOLD_PX = 5
const WHEEL_ZOOM_SENSITIVITY = 0.0025
const WHEEL_ZOOM_MAX_STEP = 0.18
const WHEEL_ZOOM_NOISE_FLOOR = 0.0005

function formatTimelineMs(valueMs: number): string {
  const total = Math.max(0, Math.round(valueMs))
  const minutes = Math.floor(total / 60000)
  const seconds = Math.floor((total % 60000) / 1000)
  const hundredths = Math.floor((total % 1000) / 10)
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`
}

function formatRulerTime(valueMs: number): string {
  const totalSeconds = Math.max(0, Math.round(valueMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

export function TimelineEditorModal({
  job,
  draft,
  pauseBetweenClipsMs,
  inlineError,
  totalDurationMs,
  currentTimeMs,
  isPlaying,
  canPlayPreview,
  isReadonly,
  renderStatus,
  onClose,
  onTogglePlayback,
  onPreview,
  onExport,
  onTrimChange,
  onSeek,
  onSwapCandidate,
  onPreviewCandidate,
  onAddChunkAfter,
  onRegenerateChunk,
  onAddVersions,
  onUpdateChunkText,
  onReorderClip,
  onReplaceDraft,
}: Props) {
  const [selectedClipIndex, setSelectedClipIndex] = useState(0)
  const [zoom, setZoom] = useState(0)
  const [snap, setSnap] = useState(true)
  const [dragState, setDragState] = useState<DragState>(null)
  const [hoverPreview, setHoverPreview] = useState<{ x: number; timeMs: number } | null>(null)
  const [toolMode, setToolMode] = useState<'v' | 'h'>('v')
  const [spaceHeldMode, setSpaceHeldMode] = useState(false)
  const [scrubState, setScrubState] = useState<ScrubState>(null)
  const [pendingSeek, setPendingSeek] = useState<PendingSeekState>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const stageViewportRef = useRef<HTMLDivElement | null>(null)
  const [viewportWidth, setViewportWidth] = useState(1100)
  const [scrollLeft, setScrollLeft] = useState(0)
  const spacePressedRef = useRef(false)
  const longPressTimerRef = useRef<number | null>(null)
  const longPressConsumedRef = useRef(false)
  const wheelZoomDeltaRef = useRef(0)
  const wheelPointerClientXRef = useRef<number | null>(null)
  const wheelFrameRef = useRef<number | null>(null)
  const dragStartSnapshotRef = useRef<TimelineDraftSnapshot | null>(null)
  const [undoStack, setUndoStack] = useState<TimelineDraftSnapshot[]>([])
  const [redoStack, setRedoStack] = useState<TimelineDraftSnapshot[]>([])
  const [draggedClipIndex, setDraggedClipIndex] = useState<number | null>(null)
  const [dropInsertionIndex, setDropInsertionIndex] = useState<number | null>(null)
  const [selectedTextDraft, setSelectedTextDraft] = useState('')
  const [addVersionCount, setAddVersionCount] = useState(1)

  const busy = renderStatus === 'previewing' || renderStatus === 'exporting'
  const statusLabel = renderStatus === 'previewing' ? 'Rendering preview...' : renderStatus === 'exporting' ? 'Exporting...' : renderStatus === 'failed' ? 'Render failed' : draft.exportSuccessPath ? `Saved to ${draft.exportSuccessPath}` : 'Ready'
  const effectiveHandMode = toolMode === 'h' || spaceHeldMode
  const visibleTimelineWidth = Math.max(1, viewportWidth)
  const minZoom = computeMinZoom({ visibleWidthPx: visibleTimelineWidth, totalDurationMs })
  // minZoom is fit-all: no overflow, no horizontal scroll required.
  const maxZoom = Math.max(minZoom * 12, minZoom + 0.5, 1)
  const pxPerMs = Math.max(minZoom, Math.min(zoom || minZoom, maxZoom))
  const projection = useMemo(
    () => buildTimelineProjection({ clips: draft.clips, pixelsPerMs: pxPerMs, pauseBetweenClipsMs }),
    [draft.clips, pauseBetweenClipsMs, pxPerMs],
  )

  const clipModels = useMemo(() => {
    return projection.clips.map((projected, index) => {
      const widthPx = Math.max(1, projected.widthPx)
      return {
        index,
        clip: projected.clip,
        x: projected.startPx,
        widthPx,
        trimInMs: projected.trimInMs,
        trimOutMs: projected.trimOutMs,
        activeDurationMs: projected.keptDurationMs,
        activeStartPx: 0,
        activeEndPx: widthPx,
      }
    })
  }, [projection.clips])

  const trackWidth = Math.max(1, projection.contentWidthPx)
  const selectedModel = clipModels[selectedClipIndex] ?? clipModels[0] ?? null
  const selectedChunk = selectedModel ? job.chunks.find((chunk) => chunk.chunk_id === selectedModel.clip.chunkId) : null
  const selectedChunkCandidates = selectedChunk?.candidates ?? []
  const dropIndicatorX = useMemo(() => {
    if (dropInsertionIndex == null) return null
    if (!clipModels.length) return 0
    if (dropInsertionIndex <= 0) return 0
    if (dropInsertionIndex >= clipModels.length) {
      const last = clipModels[clipModels.length - 1]
      return last.x + last.widthPx
    }
    return clipModels[dropInsertionIndex]?.x ?? null
  }, [clipModels, dropInsertionIndex])

  useEffect(() => {
    setSelectedTextDraft(selectedChunk?.text ?? '')
  }, [selectedChunk?.chunk_id, selectedChunk?.text])

  function timelineMsToX(timeMs: number): number {
    return projectTimelineMsToX({ timeMs, pixelsPerMs: pxPerMs, totalDurationMs })
  }

  function xToTimelineMs(x: number): number {
    return projectXToTimelineMs({ x, pixelsPerMs: pxPerMs, totalDurationMs })
  }

  const playheadX = useMemo(() => {
    return timelineMsToX(currentTimeMs)
  }, [currentTimeMs, totalDurationMs, clipModels, pxPerMs])

  const rulerTicks = useMemo(() => {
    if (totalDurationMs <= 0) return [{ timeMs: 0, x: 0, major: true, label: formatRulerTime(0) }]
    const visibleStartMs = xToTimelineMs(scrollLeft)
    const visibleEndMs = xToTimelineMs(scrollLeft + viewportWidth)
    const visibleDurationMs = Math.max(1, visibleEndMs - visibleStartMs)
    const targetMajorPx = 112
    const majorCandidates = [100, 250, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000]
    const targetMajorMs = visibleDurationMs / Math.max(1, Math.floor(viewportWidth / targetMajorPx))
    const majorStepMs = majorCandidates.find((candidate) => candidate >= targetMajorMs) ?? majorCandidates[majorCandidates.length - 1]
    const minorStepMs = majorStepMs >= 10000 ? majorStepMs / 5 : majorStepMs >= 2000 ? majorStepMs / 4 : majorStepMs / 2
    const startTickMs = Math.max(0, Math.floor(visibleStartMs / minorStepMs) * minorStepMs - minorStepMs)
    const endTickMs = Math.min(totalDurationMs, Math.ceil(visibleEndMs / minorStepMs) * minorStepMs + minorStepMs)
    const tickTimes = new Set<number>([0, totalDurationMs])
    for (let timeMs = startTickMs; timeMs <= endTickMs; timeMs += minorStepMs) {
      tickTimes.add(Math.max(0, Math.min(totalDurationMs, Math.round(timeMs))))
    }
    const ticks: Array<{ timeMs: number; x: number; major: boolean; label: string | null }> = []
    let lastLabeledX = -Infinity
    for (const timeMs of [...tickTimes].sort((a, b) => a - b)) {
      const major = timeMs === 0 || timeMs === totalDurationMs || timeMs % majorStepMs === 0
      const x = Math.min(trackWidth, Math.round(timelineMsToX(timeMs)))
      const canLabel = major && x - lastLabeledX >= 64
      if (canLabel) lastLabeledX = x
      ticks.push({
        timeMs,
        x,
        major,
        label: canLabel ? formatRulerTime(timeMs) : null,
      })
    }
    return ticks
  }, [clipModels, pxPerMs, scrollLeft, totalDurationMs, trackWidth, viewportWidth])

  function snapMs(value: number): number {
    if (!snap) return Math.round(value)
    return Math.round(value / 20) * 20
  }

  function positionToTimelineMs(clientX: number): number {
    const viewport = stageViewportRef.current
    if (!viewport) return 0
    const rect = viewport.getBoundingClientRect()
    return pointerClientXToTimelineMs({
      pointerClientX: clientX,
      viewportLeftPx: rect.left,
      scrollLeftPx: viewport.scrollLeft,
      pixelsPerMs: pxPerMs,
      totalDurationMs,
    })
  }

  function updateHover(clientX: number) {
    const viewport = stageViewportRef.current
    if (!viewport) return
    const timeMs = positionToTimelineMs(clientX)
    setHoverPreview({ x: timelineMsToX(timeMs), timeMs })
  }

  function updateDropInsertion(clientX: number): number {
    const stage = stageRef.current
    if (!stage) return 0
    const rect = stage.getBoundingClientRect()
    const pointerX = clientX - rect.left
    const insertionIndex = computeClipInsertionIndex({
      pointerX,
      clips: clipModels.map((model) => ({ x: model.x, widthPx: model.widthPx })),
    })
    setDropInsertionIndex(insertionIndex)
    return insertionIndex
  }

  function resolveDropTargetIndex(fromIndex: number, insertionIndex: number): number {
    const bounded = Math.max(0, Math.min(clipModels.length, insertionIndex))
    const adjusted = fromIndex < bounded ? bounded - 1 : bounded
    return Math.max(0, Math.min(clipModels.length - 1, adjusted))
  }

  function handleClipDrop(insertionIndex: number) {
    if (draggedClipIndex == null || isReadonly || !clipModels.length) return
    const targetIndex = resolveDropTargetIndex(draggedClipIndex, insertionIndex)
    if (targetIndex !== draggedClipIndex) {
      void onReorderClip(draggedClipIndex, targetIndex)
      setSelectedClipIndex(targetIndex)
    }
    setDraggedClipIndex(null)
    setDropInsertionIndex(null)
  }

  function resolveVisibleZoomAnchorTimeMs(): number {
    const playheadVisible = playheadX >= scrollLeft && playheadX <= scrollLeft + viewportWidth
    if (playheadVisible) return Math.max(0, Math.min(totalDurationMs, currentTimeMs))
    return xToTimelineMs(scrollLeft + viewportWidth / 2)
  }

  function captureSnapshot(sourceDraft: TimelineDraft): TimelineDraftSnapshot {
    return {
      clips: sourceDraft.clips.map((clip) => ({ ...clip })),
    }
  }

  function snapshotsEqual(left: TimelineDraftSnapshot, right: TimelineDraftSnapshot): boolean {
    return JSON.stringify(left) === JSON.stringify(right)
  }

  function commitHistorySnapshot(snapshot: TimelineDraftSnapshot) {
    setUndoStack((current) => {
      const last = current[current.length - 1]
      if (last && snapshotsEqual(last, snapshot)) return current
      return [...current, snapshot]
    })
    setRedoStack([])
  }

  function restoreSnapshot(snapshot: TimelineDraftSnapshot) {
    onReplaceDraft((currentDraft) => ({
      ...currentDraft,
      clips: snapshot.clips.map((clip) => ({ ...clip })),
      revision: currentDraft.revision + 1,
      previewUrl: null,
      exportSuccessPath: null,
      inlineError: '',
    }))
  }

  function updateZoom(nextZoom: number) {
    const resolvedZoom = Math.max(minZoom, Math.min(nextZoom, maxZoom))
    const anchorTimeMs = resolveVisibleZoomAnchorTimeMs()

    setZoom(resolvedZoom)

    window.requestAnimationFrame(() => {
      const viewport = stageViewportRef.current
      if (!viewport) return
      viewport.scrollLeft = computeAnchoredScrollLeft({
        anchorTimeMs,
        pixelsPerMs: resolvedZoom,
        viewportWidthPx: viewportWidth,
        totalDurationMs,
      })
    })
  }

  function handleFitAll() {
    updateZoom(minZoom)
  }

  function flushWheelZoom() {
    wheelFrameRef.current = null
    const viewport = stageViewportRef.current
    if (!viewport || dragState || scrubState?.mode === 'playhead') {
      wheelZoomDeltaRef.current = 0
      wheelPointerClientXRef.current = null
      return
    }

    const zoomDelta = wheelZoomDeltaRef.current
    wheelZoomDeltaRef.current = 0
    if (Math.abs(zoomDelta) < WHEEL_ZOOM_NOISE_FLOOR) {
      wheelPointerClientXRef.current = null
      return
    }

    const rect = viewport.getBoundingClientRect()
    const pointerClientX = wheelPointerClientXRef.current
    const pointerViewportX = pointerClientX == null ? viewportWidth / 2 : pointerClientX - rect.left
    const anchorTimeMs = resolveZoomAnchorTimeMs({
      pointerClientX,
      viewportLeftPx: rect.left,
      viewportWidthPx: rect.width,
      scrollLeftPx: viewport.scrollLeft,
      pixelsPerMs: pxPerMs,
      totalDurationMs,
      playheadTimeMs: currentTimeMs,
    })
    const nextZoom = Math.max(minZoom, Math.min(pxPerMs - zoomDelta, maxZoom))

    setZoom(nextZoom)

    window.requestAnimationFrame(() => {
      const latestViewport = stageViewportRef.current
      if (!latestViewport) return
      latestViewport.scrollLeft = computePointerAnchoredScrollLeft({
        anchorTimeMs,
        pointerViewportX: Math.max(0, Math.min(rect.width, pointerViewportX)),
        pixelsPerMs: nextZoom,
        viewportWidthPx: latestViewport.clientWidth,
        totalDurationMs,
      })
    })

    wheelPointerClientXRef.current = null
  }

  useEffect(() => {
    const node = stageViewportRef.current
    if (!node) return
    const applySize = () => setViewportWidth(node.clientWidth)
    applySize()
    const observer = new ResizeObserver(() => applySize())
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const node = stageViewportRef.current
    if (!node) return
    const syncScroll = () => setScrollLeft(node.scrollLeft)
    syncScroll()
    node.addEventListener('scroll', syncScroll)
    return () => node.removeEventListener('scroll', syncScroll)
  }, [])

  useEffect(() => {
    const node = stageViewportRef.current
    if (!node) return
    const nextScrollLeft = clampScrollLeft({
      scrollLeft: node.scrollLeft,
      contentWidthPx: trackWidth,
      viewportWidthPx: viewportWidth,
    })
    if (node.scrollLeft !== nextScrollLeft) node.scrollLeft = nextScrollLeft
    if (scrollLeft !== nextScrollLeft) setScrollLeft(nextScrollLeft)
  }, [scrollLeft, trackWidth, viewportWidth])

  useEffect(() => {
    return () => {
      if (wheelFrameRef.current != null) window.cancelAnimationFrame(wheelFrameRef.current)
    }
  }, [])

  useEffect(() => {
    setUndoStack([])
    setRedoStack([])
    dragStartSnapshotRef.current = null
  }, [draft.jobId])

  useEffect(() => {
    setSelectedClipIndex((current) => Math.max(0, Math.min(current, Math.max(0, draft.clips.length - 1))))
  }, [draft.clips.length])

  useEffect(() => {
    if (!dragState || isReadonly) return
    const handleMove = (event: PointerEvent) => {
      const model = clipModels[dragState.clipIndex]
      if (!model) return
      const deltaMs = snapMs((event.clientX - dragState.startClientX) / pxPerMs)
      if (dragState.edge === 'left') {
        const maxTrim = Math.max(0, model.clip.durationMs - model.trimOutMs - 1)
        const next = Math.max(0, Math.min(maxTrim, dragState.startTrimMs + deltaMs))
        onTrimChange(model.index, 'trimInMs', String(next))
      } else {
        const maxTrim = Math.max(0, model.clip.durationMs - model.trimInMs - 1)
        const next = Math.max(0, Math.min(maxTrim, dragState.startTrimMs - deltaMs))
        onTrimChange(model.index, 'trimOutMs', String(next))
      }
    }
    const handleUp = () => {
      setDragState(null)
      const startSnapshot = dragStartSnapshotRef.current
      if (startSnapshot) {
        const nextSnapshot = captureSnapshot(draft)
        if (!snapshotsEqual(startSnapshot, nextSnapshot)) commitHistorySnapshot(startSnapshot)
        dragStartSnapshotRef.current = null
      }
    }
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
    }
  }, [clipModels, dragState, draft, isReadonly, onTrimChange, pxPerMs, snap])

  useEffect(() => {
    if (!scrubState) return
    const handleMove = (event: PointerEvent) => {
      if (scrubState.mode === 'playhead') {
        const host = stageRef.current
        if (!host) return
        onSeek(positionToTimelineMs(event.clientX))
        updateHover(event.clientX)
        return
      }
      const viewport = stageViewportRef.current
      if (!viewport) return
      viewport.scrollLeft = clampScrollLeft({
        scrollLeft: scrubState.originScrollLeft - (event.clientX - scrubState.originClientX),
        contentWidthPx: trackWidth,
        viewportWidthPx: viewportWidth,
      })
    }
    const handleUp = () => setScrubState(null)
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
    }
  }, [onSeek, scrubState, trackWidth, viewportWidth])

  useEffect(() => {
    if (!pendingSeek || dragState || scrubState) return
    const handleMove = (event: PointerEvent) => {
      if (event.pointerId !== pendingSeek.pointerId) return
      if (pendingSeek.moved) return
      if (isDragBeyondThreshold({
        startX: pendingSeek.startClientX,
        startY: pendingSeek.startClientY,
        currentX: event.clientX,
        currentY: event.clientY,
        thresholdPx: CLICK_DRAG_THRESHOLD_PX,
      })) {
        setPendingSeek((current) => (current ? { ...current, moved: true } : current))
      }
    }
    const handleUp = (event: PointerEvent) => {
      if (event.pointerId !== pendingSeek.pointerId) return
      const host = stageRef.current
      if (host && !pendingSeek.blockSeek && !pendingSeek.moved) {
        onSeek(positionToTimelineMs(event.clientX))
      }
      setPendingSeek(null)
    }
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
    }
  }, [dragState, onSeek, pendingSeek, scrubState, trackWidth, viewportWidth])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      if (event.metaKey && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) {
          setRedoStack((currentRedo) => {
            const snapshot = currentRedo[currentRedo.length - 1]
            if (!snapshot) return currentRedo
            const currentSnapshot = captureSnapshot(draft)
            restoreSnapshot(snapshot)
            setUndoStack((currentUndo) => [...currentUndo, currentSnapshot])
            return currentRedo.slice(0, -1)
          })
          return
        }
        setUndoStack((currentUndo) => {
          const snapshot = currentUndo[currentUndo.length - 1]
          if (!snapshot) return currentUndo
          const currentSnapshot = captureSnapshot(draft)
          restoreSnapshot(snapshot)
          setRedoStack((currentRedo) => [...currentRedo, currentSnapshot])
          return currentUndo.slice(0, -1)
        })
        return
      }
      if (event.code === 'KeyH') {
        event.preventDefault()
        setToolMode('h')
        return
      }
      if (event.code === 'KeyV') {
        event.preventDefault()
        setToolMode('v')
        return
      }
      if (event.code !== 'Space') return
      event.preventDefault()
      if (spacePressedRef.current) return
      spacePressedRef.current = true
      longPressConsumedRef.current = false
      longPressTimerRef.current = window.setTimeout(() => {
        longPressConsumedRef.current = true
        setSpaceHeldMode(true)
      }, 180)
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== 'Space') return
      event.preventDefault()
      spacePressedRef.current = false
      if (longPressTimerRef.current != null) {
        window.clearTimeout(longPressTimerRef.current)
        longPressTimerRef.current = null
      }
      const consumed = longPressConsumedRef.current
      setSpaceHeldMode(false)
      longPressConsumedRef.current = false
      if (!consumed) onTogglePlayback()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [draft, onTogglePlayback])

  return (
    <div className="modal-backdrop">
      <div className="modal-panel timeline-modal timeline-editor-v2">
        <div className="timeline-toolbar">
          <div className="timeline-toolbar__left">
            <div className="section-label">Edit Timeline</div>
            <div className="section-title">{job.voice_display_name || job.prompt_name}</div>
          </div>
          <div className="timeline-toolbar__controls">
            <div className="timeline-toolbar__group">
              <button className="ghost-btn" onClick={onTogglePlayback} disabled={!canPlayPreview}>
                {isPlaying ? <CirclePause className="h-4 w-4" /> : <CirclePlay className="h-4 w-4" />}
                {isPlaying ? 'Pause' : 'Play'}
              </button>
              <div className="timeline-toolbar__time"><Clock3 className="h-3.5 w-3.5" />{formatTimelineMs(currentTimeMs)} / {formatTimelineMs(totalDurationMs)}</div>
            </div>
            <div className="timeline-toolbar__group">
              <label className="timeline-toolbar__zoom">
                Zoom
                <input type="range" min={minZoom} max={maxZoom} step={Math.max(0.001, minZoom / 20)} value={pxPerMs} onChange={(event) => updateZoom(Number(event.target.value))} />
              </label>
              <button className="ghost-btn" onClick={handleFitAll}>
                Fit All
              </button>
              <button className={`ghost-btn ${snap ? 'ghost-btn--active' : ''}`} onClick={() => setSnap((current) => !current)}>
                <Sparkle className="h-3.5 w-3.5" />
                Snap
              </button>
              <div className="timeline-tool-indicator">{effectiveHandMode ? 'H' : toolMode.toUpperCase()}</div>
            </div>
            <div className="timeline-toolbar__group">
              <button className="ghost-btn" onClick={onPreview} disabled={Boolean(inlineError) || isReadonly}>Preview</button>
              <button className="btn-primary" onClick={onExport} disabled={Boolean(inlineError) || isReadonly}>Export</button>
              <button className="ghost-btn" onClick={onClose}>Close</button>
            </div>
          </div>
        </div>

        {inlineError && <div className="error-banner mt-3"><span>{inlineError}</span></div>}
        {isReadonly && <div className="mt-3 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-xs text-white/55 inline-flex items-center gap-2"><LoaderCircle className="h-3.5 w-3.5 animate-spin" />Render in progress</div>}

        <div
          className={`timeline-stage mt-4 soft-card ${effectiveHandMode ? 'timeline-stage--hand' : ''}`}
          ref={stageViewportRef}
          onWheel={(event) => {
            const viewport = stageViewportRef.current
            if (!viewport) return
            const intent = classifyWheelIntent({
              deltaX: event.deltaX,
              deltaY: event.deltaY,
              shiftKey: event.shiftKey,
            })

            if (intent === 'pan') {
              event.preventDefault()
              const panDelta = event.shiftKey ? event.deltaY : event.deltaX
              viewport.scrollLeft = clampScrollLeft({
                scrollLeft: viewport.scrollLeft + panDelta,
                contentWidthPx: trackWidth,
                viewportWidthPx: viewport.clientWidth,
              })
              return
            }

            if (dragState || scrubState?.mode === 'playhead') return

            event.preventDefault()
            wheelPointerClientXRef.current = event.clientX
            wheelZoomDeltaRef.current += normalizeWheelZoomDelta({
              deltaY: event.deltaY,
              deltaMode: event.deltaMode,
              sensitivity: WHEEL_ZOOM_SENSITIVITY,
              maxStep: WHEEL_ZOOM_MAX_STEP,
            })
            if (wheelFrameRef.current == null) {
              wheelFrameRef.current = window.requestAnimationFrame(() => flushWheelZoom())
            }
          }}
          onPointerDown={(event) => {
            const host = stageRef.current
            if (!host) return
            if (effectiveHandMode) {
              setScrubState({
                mode: 'hand',
                originClientX: event.clientX,
                originScrollLeft: stageViewportRef.current?.scrollLeft ?? 0,
              })
              return
            }
            const target = event.target as HTMLElement
            const blockSeek = Boolean(target.closest('[data-no-seek="true"]'))
            setPendingSeek({
              pointerId: event.pointerId,
              startClientX: event.clientX,
              startClientY: event.clientY,
              moved: false,
              blockSeek,
            })
          }}
          onPointerMove={(event) => {
            updateHover(event.clientX)
          }}
          onPointerLeave={() => setHoverPreview(null)}
        >
          <div
            className="timeline-stage__inner"
            ref={stageRef}
            style={{ width: `${trackWidth}px` }}
            onDragOver={(event) => {
              if (isReadonly || draggedClipIndex == null) return
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
              updateDropInsertion(event.clientX)
            }}
            onDrop={(event) => {
              if (isReadonly || draggedClipIndex == null) return
              event.preventDefault()
              const insertionIndex = dropInsertionIndex ?? updateDropInsertion(event.clientX)
              handleClipDrop(insertionIndex)
            }}
            onDragLeave={(event) => {
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
              setDropInsertionIndex(null)
            }}
          >
            <div className="timeline-ruler">
              {rulerTicks.map((tick) => (
                <div key={`${tick.timeMs}-${tick.major ? 'major' : 'minor'}`} className={`timeline-ruler__tick ${tick.major ? 'timeline-ruler__tick--major' : 'timeline-ruler__tick--minor'}`} style={{ left: `${tick.x}px` }}>
                  {tick.label ? <span>{tick.label}</span> : null}
                </div>
              ))}
            </div>
            <div className="timeline-stage__grid">
              {rulerTicks.filter((tick) => tick.major).map((tick) => (
                <div key={`grid-${tick.timeMs}`} className="timeline-stage__grid-line" style={{ left: `${tick.x}px` }} />
              ))}
            </div>
            <div className="timeline-sequence">
              <div className="timeline-sequence__inner">
                <div
                  className="timeline-playhead-v2"
                  style={{ left: `${playheadX}px` }}
                  onPointerDown={(event) => {
                    event.stopPropagation()
                    if (toolMode === 'h') setToolMode('v')
                    const host = stageRef.current
                    if (!host) return
                    setPendingSeek(null)
                    setHoverPreview(null)
                    setScrubState({ mode: 'playhead', originClientX: event.clientX, originScrollLeft: 0 })
                    onSeek(positionToTimelineMs(event.clientX))
                  }}
                  data-no-seek="true"
                >
                  <div className="timeline-playhead-v2__hitbox">
                    <div className="timeline-playhead-v2__handle" />
                  </div>
                </div>
                {hoverPreview && (
                  <div className="timeline-playhead-v2 timeline-playhead-v2--ghost" style={{ left: `${hoverPreview.x}px` }}>
                    <div className="timeline-hover-tooltip">{formatTimelineMs(hoverPreview.timeMs)}</div>
                  </div>
                )}
                {draggedClipIndex != null && dropIndicatorX != null ? (
                  <div className="timeline-drop-indicator" style={{ left: `${dropIndicatorX}px` }} />
                ) : null}
                {clipModels.map((model) => {
                  const selected = model.index === selectedClipIndex
                  const clipDensity = model.widthPx < 84 ? 'micro' : model.widthPx < 140 ? 'compact' : model.widthPx < 220 ? 'medium' : 'full'
                  const chunkLabel = String(model.clip.chunkIndex).padStart(2, '0')
                  const candidateShort = model.clip.candidateLabel.split(' ')[0] ?? model.clip.candidateLabel
                  return (
                    <button
                      type="button"
                      key={`${model.clip.chunkId}:${model.clip.candidateId}`}
                      className={`timeline-segment timeline-segment--${clipDensity} ${selected ? 'timeline-segment--selected' : ''}`}
                      style={{ left: `${model.x}px`, width: `${model.widthPx}px` }}
                      draggable={!isReadonly}
                      onDragStart={(event) => {
                        event.stopPropagation()
                        setDraggedClipIndex(model.index)
                        setDropInsertionIndex(model.index)
                      }}
                      onDragOver={(event) => {
                        if (isReadonly) return
                        event.preventDefault()
                        event.dataTransfer.dropEffect = 'move'
                        updateDropInsertion(event.clientX)
                      }}
                      onDragEnd={() => {
                        setDraggedClipIndex(null)
                        setDropInsertionIndex(null)
                      }}
                      onClick={(event) => {
                        event.stopPropagation()
                        setSelectedClipIndex(model.index)
                      }}
                      data-no-seek="true"
                    >
                      <div className="timeline-segment__active-zone" />
                      <div className="timeline-segment__row">
                        <span className="timeline-segment__chunk-badge">{chunkLabel}</span>
                        {clipDensity !== 'micro' ? <div className="timeline-segment__text">{model.clip.chunkLabel}</div> : null}
                        {clipDensity !== 'micro' ? <span className="timeline-segment__candidate">{candidateShort}</span> : null}
                      </div>
                      <div
                        className="timeline-segment__handle timeline-segment__handle--left"
                        style={{ left: '-6px' }}
                        onPointerDown={(event) => {
                          event.stopPropagation()
                          if (isReadonly) return
                          dragStartSnapshotRef.current = captureSnapshot(draft)
                          setDragState({ clipIndex: model.index, edge: 'left', startClientX: event.clientX, startTrimMs: model.trimInMs })
                        }}
                        title={`Trim in ${model.trimInMs}ms`}
                        data-no-seek="true"
                      />
                      <div
                        className="timeline-segment__handle timeline-segment__handle--right"
                        style={{ left: `${Math.max(0, model.widthPx - 6)}px` }}
                        onPointerDown={(event) => {
                          event.stopPropagation()
                          if (isReadonly) return
                          dragStartSnapshotRef.current = captureSnapshot(draft)
                          setDragState({ clipIndex: model.index, edge: 'right', startClientX: event.clientX, startTrimMs: model.trimOutMs })
                        }}
                        title={`Trim out ${model.trimOutMs}ms`}
                        data-no-seek="true"
                      />
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        </div>

        {selectedModel && (
          <div className="timeline-inspector soft-card mt-4">
            <div className="timeline-inspector__head">
              <div>
                <div className="section-label !mb-0">Inspector</div>
                <div className="text-sm text-white/80">Chunk {String(selectedModel.clip.chunkIndex).padStart(2, '0')} · {selectedModel.clip.candidateLabel}</div>
              </div>
              <div className="timeline-inspector__meta">{statusLabel}</div>
            </div>
            <div className="timeline-inspector__grid">
              <label>
                <span>Chunk text</span>
                <textarea
                  className="aurora-textarea h-[72px] !text-[12px]"
                  value={selectedTextDraft}
                  onChange={(event) => setSelectedTextDraft(event.target.value)}
                  data-no-seek="true"
                />
              </label>
              <label>
                <span>Swap candidate</span>
                <select
                  className="aurora-input !py-1.5 !text-[11px]"
                  value={selectedModel.clip.candidateId}
                  onChange={(event) => {
                    commitHistorySnapshot(captureSnapshot(draft))
                    onSwapCandidate(selectedModel.index, event.target.value)
                  }}
                  data-no-seek="true"
                >
                  {(selectedChunk?.candidates ?? []).map((candidate) => (
                    <option key={candidate.candidate_id} value={candidate.candidate_id}>
                      {candidate.variant_label} {candidate.candidate_id}
                    </option>
                  ))}
                </select>
              </label>
              <div className="timeline-inspector__versions">
                <span>Versions</span>
                <div className="timeline-version-list">
                  {selectedChunkCandidates.map((candidate) => {
                    const isActive = candidate.candidate_id === selectedModel.clip.candidateId
                    return (
                      <div key={candidate.candidate_id} className={`timeline-version-chip ${isActive ? 'timeline-version-chip--active' : ''}`}>
                        <div className="timeline-version-chip__label">
                          <strong>{candidate.variant_label}</strong>
                          <span>{candidate.duration != null ? `${candidate.duration.toFixed(1)}s` : candidate.duration_ms ? `${(candidate.duration_ms / 1000).toFixed(1)}s` : ''}</span>
                        </div>
                        <div className="timeline-version-chip__actions">
                          <button className="ghost-btn" type="button" onClick={() => onPreviewCandidate(selectedModel.index, candidate.candidate_id)}>
                            Preview
                          </button>
                          <button className={isActive ? 'ghost-btn ghost-btn--active' : 'ghost-btn'} type="button" onClick={() => onSwapCandidate(selectedModel.index, candidate.candidate_id)} disabled={isActive}>
                            {isActive ? 'Selected' : 'Use'}
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
              <label>
                <span>Number of versions</span>
                <input
                  type="number"
                  min={1}
                  max={12}
                  className="aurora-input !py-1.5 !text-[11px]"
                  value={addVersionCount}
                  onChange={(event) => {
                    const next = Number(event.target.value)
                    setAddVersionCount(Number.isFinite(next) ? Math.max(1, Math.min(12, Math.round(next))) : 1)
                  }}
                  data-no-seek="true"
                />
              </label>
              <label>
                <span>Trim in (ms)</span>
                <input className="aurora-input !py-1.5 !text-[11px]" value={selectedModel.clip.trimInMs} onChange={(event) => onTrimChange(selectedModel.index, 'trimInMs', event.target.value)} />
              </label>
              <label>
                <span>Trim out (ms)</span>
                <input className="aurora-input !py-1.5 !text-[11px]" value={selectedModel.clip.trimOutMs} onChange={(event) => onTrimChange(selectedModel.index, 'trimOutMs', event.target.value)} />
              </label>
              <label>
                <span>Kept duration</span>
                <div className="timeline-metric">{formatTimelineMs(selectedModel.activeDurationMs)}</div>
              </label>
              <div className="timeline-inspector__actions">
                <button className="ghost-btn" onClick={() => onAddChunkAfter(selectedModel.index)}>
                  <CopyPlus className="h-3.5 w-3.5" />
                  Add Chunk After
                </button>
                <button className="ghost-btn" onClick={() => onRegenerateChunk(selectedModel.index)}>
                  <Wand2 className="h-3.5 w-3.5" />
                  Regenerate Chunk
                </button>
                <button className="ghost-btn" onClick={() => onAddVersions(selectedModel.index, addVersionCount)}>
                  <CopyPlus className="h-3.5 w-3.5" />
                  Add Versions
                </button>
                <button
                  className="ghost-btn"
                  onClick={() => onUpdateChunkText(selectedModel.index, selectedTextDraft)}
                  disabled={!selectedTextDraft.trim() || selectedTextDraft.trim() === (selectedChunk?.text ?? '').trim()}
                >
                  <CopyPlus className="h-3.5 w-3.5" />
                  Save Text
                </button>
                <button className="ghost-btn" onClick={() => onTrimChange(selectedModel.index, 'trimInMs', '0')}>
                  <ScissorsLineDashed className="h-3.5 w-3.5" />
                  Reset In
                </button>
                <button className="ghost-btn" onClick={() => onTrimChange(selectedModel.index, 'trimOutMs', '0')}>
                  <ScissorsLineDashed className="h-3.5 w-3.5" />
                  Reset Out
                </button>
                <button className="ghost-btn" onClick={onPreview}>
                  <Wand2 className="h-3.5 w-3.5" />
                  Refresh Preview
                </button>
                <button className="ghost-btn" onClick={onExport}>
                  <CopyPlus className="h-3.5 w-3.5" />
                  Export Now
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
