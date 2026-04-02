import { useEffect, useMemo, useRef, useState } from 'react'
import { ActivePromptCard } from './components/ActivePromptCard'
import { Controls } from './components/Controls'
import { InspectorPanel } from './components/InspectorPanel'
import { LeftPanel } from './components/LeftPanel'
import { Player } from './components/Player'
import { TimelineEditorModal } from './components/TimelineEditorModal'
import { TimelinePanel } from './components/TimelinePanel'
import { VoiceClone } from './components/VoiceClone'
import { WorkspaceHeader } from './components/WorkspaceHeader'
import { WorkspaceLayout } from './components/WorkspaceLayout'
import { useActiveRunWorkflowState } from './hooks/useActiveRunWorkflowState'
import { buildPauseGapSequence, normalizePauseRange } from './lib/pauseRange'
import { buildTimelineDraft, buildTimelinePayload, normalizeTrimInput, syncTimelineDraftWithJob, timelineDraftInvalidated, timelineTotalDurationMs, validateTimelineDraft } from './lib/timelineDraft'
import {
  type ActiveAudio,
  type ChunkExpansionMap,
  type ChunkLockMap,
  type ChunkTweakDraft,
  type Job,
  type JobChunk,
  type PortableReview,
  type StatePayload,
  type TimelineDraft,
  type VoiceInventory,
  type VoiceRunGroup,
  initialImport,
  initialPortableReview,
} from './types'

type ThemeName = 'neon' | 'sunset' | 'ocean' | 'light-neon' | 'light-sunset' | 'light-ocean'

export default function App() {
  const [bridgeUrl, setBridgeUrl] = useState('')
  const [bridgeAuthToken, setBridgeAuthToken] = useState<string | null>(null)
  const [bridgeStatus, setBridgeStatus] = useState<{ ready: boolean; status: string; logPath: string } | null>(null)
  const [payload, setPayload] = useState<StatePayload | null>(null)
  const [backend, setBackend] = useState<'modal' | 'local'>('modal')
  const [selectedVoice, setSelectedVoice] = useState('')
  const [script, setScript] = useState('Hey, stop scrolling real quick. About 60% of people in the US do not have life insurance.')
  const [variantCount, setVariantCount] = useState(3)
  const [speed, setSpeed] = useState(1.0)
  const [pauseMinMs, setPauseMinMs] = useState(250)
  const [pauseMaxMs, setPauseMaxMs] = useState(420)
  const [chunkMode, setChunkMode] = useState('sentence')
  const [language, setLanguage] = useState('Auto')
  const [importForm, setImportForm] = useState(initialImport)
  const [portableReview, setPortableReview] = useState<PortableReview>(initialPortableReview)
  const [portableReviewMediaUrl, setPortableReviewMediaUrl] = useState<string | null>(null)
  const [activeAudio, setActiveAudio] = useState<ActiveAudio | null>(null)
  const [isBusy, setIsBusy] = useState(false)
  const [uiError, setUiError] = useState('')
  const [voiceSource, setVoiceSource] = useState<'all' | 'local' | 'modal' | 'portable'>('all')
  const [activeJobId, setActiveJobId] = useState<string | null>(null)
  const [focusChunkId, setFocusChunkId] = useState<string | null>(null)
  const [chunkLocks, setChunkLocks] = useState<ChunkLockMap>({})
  const [chunkExpansion, setChunkExpansion] = useState<ChunkExpansionMap>({})
  const [chunkTweakDraft, setChunkTweakDraft] = useState<ChunkTweakDraft | null>(null)
  const [timelineJobId, setTimelineJobId] = useState<string | null>(null)
  const [timelineDrafts, setTimelineDrafts] = useState<Record<string, TimelineDraft>>({})
  const [expandedVoiceIds, setExpandedVoiceIds] = useState<Record<string, boolean>>({})
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [audioCurrentTimeMs, setAudioCurrentTimeMs] = useState(0)
  const [theme, setTheme] = useState<ThemeName>(() => {
    if (typeof window === 'undefined') return 'neon'
    const saved = window.localStorage.getItem('batch-audio-theme')
    return saved === 'sunset' || saved === 'ocean' || saved === 'neon' || saved === 'light-neon' || saved === 'light-sunset' || saved === 'light-ocean' ? saved : 'neon'
  })

  useEffect(() => {
    Promise.all([
      window.batchAudioDesktop.bridgeUrl(),
      window.batchAudioDesktop.bridgeAuthToken(),
      window.batchAudioDesktop.bridgeStatus(),
    ]).then(([url, token, status]) => {
      setBridgeUrl(url)
      setBridgeAuthToken(token)
      setBridgeStatus(status)
    })
  }, [])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    window.localStorage.setItem('batch-audio-theme', theme)
  }, [theme])

  useEffect(() => {
    if (!bridgeUrl || bridgeAuthToken == null) return
    let cancelled = false
    let timeoutId: number | null = null
    let controller: AbortController | null = null

    const load = async () => {
      controller = new AbortController()
      try {
        const response = await request('/api/state', { signal: controller.signal })
        const data = await response.json()
        if (cancelled) return
        setPayload(data)
        setBridgeStatus(await window.batchAudioDesktop.bridgeStatus())
      } catch (error) {
        if (cancelled || controller?.signal.aborted) return
        const status = await window.batchAudioDesktop.bridgeStatus()
        setBridgeStatus(status)
        setUiError(`Bridge unavailable. ${error instanceof Error ? error.message : 'Unknown error'}. Log: ${status.logPath}`)
      } finally {
        controller = null
      }
    }

    const run = async () => {
      while (!cancelled) {
        await load()
        if (cancelled) return
        await new Promise<void>((resolve) => {
          timeoutId = window.setTimeout(() => {
            timeoutId = null
            resolve()
          }, 1200)
        })
      }
    }

    void run()
    return () => {
      cancelled = true
      controller?.abort()
      if (timeoutId != null) window.clearTimeout(timeoutId)
    }
  }, [bridgeAuthToken, bridgeUrl])

  const queue = payload?.jobs ?? []
  const availableVoices = useMemo(() => payload?.voices ?? [], [payload])
  const activeApiBase = backend === 'modal' ? payload?.modal_api_base ?? '' : payload?.local_api_base ?? ''
  const activeJob = queue.find((job) => job.job_id === activeJobId) ?? queue[0] ?? null
  const timelineJob = queue.find((job) => job.job_id === timelineJobId) ?? null
  const timelineDraft = timelineJobId ? timelineDrafts[timelineJobId] ?? null : null

  const groups = useMemo<VoiceRunGroup[]>(() => {
    const map = new Map<string, VoiceRunGroup>()
    for (const job of queue) {
      const voiceId = job.voice_id || job.prompt_name
      const existing = map.get(voiceId)
      const nextJob = { ...job, run_label: job.run_label || job.source_text?.split('\n').find(Boolean)?.trim() || job.current_task }
      if (existing) {
        existing.jobs.push(nextJob)
      } else {
        map.set(voiceId, {
          voiceId,
          voiceDisplayName: job.voice_display_name || job.prompt_name,
          jobs: [nextJob],
        })
      }
    }
    return Array.from(map.values())
      .map((group) => ({
        ...group,
        jobs: [...group.jobs].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')),
      }))
      .sort((a, b) => (b.jobs[0]?.created_at || '').localeCompare(a.jobs[0]?.created_at || ''))
  }, [queue])

  const timelinePauseRange = normalizePauseRange(
    Number(timelineJob?.run_defaults?.pause_min_ms ?? timelineJob?.run_defaults?.pause_ms ?? 250),
    Number(timelineJob?.run_defaults?.pause_max_ms ?? timelineJob?.run_defaults?.pause_ms ?? 420),
  )
  const timelinePauseGapsMs = timelineDraft ? buildPauseGapSequence(timelineDraft.clips, timelinePauseRange.min, timelinePauseRange.max) : []
  const timelineInlineError = timelineDraft ? timelineDraft.inlineError || validateTimelineDraft(timelineDraft) : ''
  const timelineTotalMs = timelineDraft ? timelineTotalDurationMs(timelineDraft, timelinePauseGapsMs) : 0
  const timelineReadonly = Boolean(timelineJob && ['previewing', 'exporting'].includes(timelineJob.timeline_render_status ?? 'idle'))
  const workflow = useActiveRunWorkflowState({
    activeAudio,
    activeJob,
    activeTimelineJobId: timelineJobId,
    chunkLocks,
  })
  const controllerState = workflow.controllerState
  const workflowStep = controllerState?.activeStep ?? null
  const workflowSummary = controllerState?.runProgress.summaryLabel ?? null
  const workflowGuidance = controllerState?.runProgress.guidanceLabel ?? null
  const workflowBlockedReason = controllerState?.runProgress.blockedTimelineReason ?? null
  const workflowPlaybackLabel = controllerState?.playbackLabel ?? null
  const allChunksConfirmed = Boolean(activeJob && controllerState && activeJob.chunks.length > 0 && Object.values(controllerState.chunkReviewStates).every((state) => state === 'confirmed'))
  const canOpenTimeline = Boolean(allChunksConfirmed && controllerState?.timelinePhase.phase !== 'unavailable')

  useEffect(() => {
    if (!payload) return
    if (!selectedVoice && payload.voices[0]?.name) setSelectedVoice(payload.voices[0].name)
  }, [payload, selectedVoice])

  useEffect(() => {
    if (!payload) return
    if (backend === 'modal' && !payload.modal_api_base && payload.local_api_base) {
      setBackend('local')
    }
  }, [backend, payload])

  useEffect(() => {
    if (!queue.length) {
      setActiveJobId(null)
      return
    }
    if (!activeJobId || !queue.some((job) => job.job_id === activeJobId)) {
      setActiveJobId(queue[0].job_id)
    }
  }, [queue, activeJobId])

  useEffect(() => {
    if (!activeJob) {
      setFocusChunkId(null)
      return
    }
    if (focusChunkId && activeJob.chunks.some((chunk) => chunk.chunk_id === focusChunkId)) return
    const selectedChunk = activeJob.chunks.find((chunk) => controllerState?.effectiveSelectedCandidateIds[chunk.chunk_id] || chunk.selected_candidate_id)
    setFocusChunkId(selectedChunk?.chunk_id ?? activeJob.chunks[0]?.chunk_id ?? null)
  }, [activeJob, controllerState?.effectiveSelectedCandidateIds, focusChunkId])

  useEffect(() => {
    setExpandedVoiceIds((current) => {
      const next = { ...current }
      for (const group of groups) {
        if (!(group.voiceId in next)) next[group.voiceId] = true
      }
      return next
    })
  }, [groups])

  useEffect(() => {
    if (activeAudio?.jobId && activeJobId && activeAudio.jobId !== activeJobId) {
      audioRef.current?.pause()
      setActiveAudio(null)
    }
  }, [activeAudio, activeJobId])

  useEffect(() => {
    if (!activeJob || !bridgeUrl) return
    const previewCandidate = pickPreviewCandidate(activeJob, focusChunkId, controllerState?.effectiveSelectedCandidateIds ?? {})
    if (!previewCandidate) return
    const nextAudio: ActiveAudio = {
      url: `${bridgeUrl}${previewCandidate.candidate.audio_url}`,
      label: `${activeJob.voice_display_name || activeJob.prompt_name || 'Candidate'} ${previewCandidate.candidate.variant_label}`,
      candidateId: previewCandidate.candidate.candidate_id,
      chunkIndex: previewCandidate.chunk.index,
      variantLabel: previewCandidate.candidate.variant_label,
      jobId: activeJob.job_id,
      backend: activeJob.backend,
      generationTime: previewCandidate.chunk.generation_time,
      sourceType: 'candidate',
      autoBound: true,
    }
    setActiveAudio((current) => {
      if (!current) return nextAudio
      if (current.sourceType === 'mix' && current.jobId === activeJob.job_id) return current
      if (current.jobId !== activeJob.job_id) return nextAudio
      if (current.sourceType !== 'candidate') return nextAudio
      if (current.candidateId === nextAudio.candidateId) return current
      if (current.autoBound) return nextAudio
      return current
    })
  }, [activeJob, bridgeUrl, controllerState?.effectiveSelectedCandidateIds, focusChunkId])

  useEffect(() => {
    const node = audioRef.current
    if (!node) return
    const sync = () => setAudioCurrentTimeMs(Math.round(node.currentTime * 1000))
    const ended = () => setAudioCurrentTimeMs(Math.round(node.duration * 1000) || 0)
    node.addEventListener('timeupdate', sync)
    node.addEventListener('ended', ended)
    return () => {
      node.removeEventListener('timeupdate', sync)
      node.removeEventListener('ended', ended)
    }
  }, [activeAudio])

  const expandedChunkIds = useMemo(() => {
    const expanded = new Set<string>()
    if (!activeJob) return expanded
    activeJob.chunks.forEach((chunk) => {
      const mode = chunkExpansion[chunk.chunk_id]
      if (mode === 'manual-open') {
        expanded.add(chunk.chunk_id)
        return
      }
      if (mode === 'manual-closed') return
      if (chunk.chunk_id === focusChunkId || chunkTweakDraft?.chunkId === chunk.chunk_id) expanded.add(chunk.chunk_id)
    })
    return expanded
  }, [activeJob, chunkExpansion, focusChunkId, chunkTweakDraft])

  useEffect(() => {
    setTimelineDrafts((current) => {
      let next = current
      for (const [jobId, draft] of Object.entries(current)) {
        const job = queue.find((entry) => entry.job_id === jobId)
        if (!job || timelineDraftInvalidated(job, draft)) {
          if (timelineJobId === jobId) {
            setTimelineJobId(null)
            clearTimelinePlayback()
            setUiError('Timeline reset because the source selection changed.')
          }
          if (next === current) next = { ...current }
          delete next[jobId]
        }
      }
      return next
    })
  }, [queue, timelineJobId])

  useEffect(() => {
    if (timelineJobId && activeJobId && timelineJobId !== activeJobId) {
      setTimelineJobId(null)
      clearTimelinePlayback()
    }
  }, [activeJobId, timelineJobId])

  useEffect(() => {
    if (!timelineJob || !timelineDraft) return
    const renderStatus = timelineJob.timeline_render_status ?? 'idle'
    if (renderStatus === 'failed') {
      const matchingCurrentFailure = (timelineDraft.previewRequestId && timelineJob.timeline_request_id === timelineDraft.previewRequestId) || (timelineDraft.exportRequestId && timelineJob.timeline_request_id === timelineDraft.exportRequestId)
      if (matchingCurrentFailure) {
        setTimelineDrafts((current) => ({
          ...current,
          [timelineJob.job_id]: {
            ...current[timelineJob.job_id],
            inlineError: timelineJob.timeline_render_error || timelineJob.timeline_render_errors?.[0]?.message || 'Timeline render failed.',
            previewRequestId: null,
            exportRequestId: null,
          },
        }))
      } else if (timelineJob.timeline_render_error) {
        setUiError(timelineJob.timeline_render_error)
      }
      return
    }
    if (renderStatus === 'preview_ready' && timelineDraft.previewRequestId && timelineJob.timeline_request_id === timelineDraft.previewRequestId && timelineJob.timeline_preview_mix_url) {
      const url = `${bridgeUrl}${timelineJob.timeline_preview_mix_url}`
      const startMs = Math.max(0, Math.min(audioCurrentTimeMs, timelineTotalMs))
      setTimelineDrafts((current) => ({
        ...current,
        [timelineJob.job_id]: {
          ...current[timelineJob.job_id],
          previewUrl: url,
          inlineError: '',
          previewRequestId: null,
        },
      }))
      setActiveAudio({ url, label: `${timelineJob.voice_display_name || timelineJob.prompt_name} Timeline Preview`, jobId: timelineJob.job_id, isMix: true, backend: timelineJob.backend, sourceType: 'mix', autoBound: false })
      setAudioCurrentTimeMs(startMs)
      window.setTimeout(() => {
        if (!audioRef.current) return
        audioRef.current.currentTime = startMs / 1000
        audioRef.current.play().catch(() => undefined)
      }, 0)
      return
    }
    if (renderStatus === 'export_ready' && timelineDraft.exportRequestId && timelineJob.timeline_request_id === timelineDraft.exportRequestId && timelineJob.timeline_export_path) {
      setTimelineDrafts((current) => ({
        ...current,
        [timelineJob.job_id]: {
          ...current[timelineJob.job_id],
          exportPath: timelineJob.timeline_export_path,
          exportSuccessPath: timelineJob.timeline_export_path,
          inlineError: '',
          exportRequestId: null,
        },
      }))
    }
  }, [audioCurrentTimeMs, bridgeUrl, timelineDraft, timelineJob, timelineTotalMs])

  async function request(path: string, init?: RequestInit) {
    const headers = new Headers(init?.headers)
    if (bridgeAuthToken) headers.set('x-batch-audio-token', bridgeAuthToken)
    const response = await fetch(`${bridgeUrl}${path}`, { ...init, headers })
    if (!response.ok) {
      const detail = await response.text()
      throw new Error(detail || `Request failed (${response.status})`)
    }
    return response
  }

  useEffect(() => {
    if (!portableReview.open || !portableReview.audio_path || !bridgeUrl || bridgeAuthToken == null) {
      setPortableReviewMediaUrl(null)
      return
    }
    let cancelled = false
    void request('/api/media/register-local-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio_path: portableReview.audio_path }),
    })
      .then((response) => response.json())
      .then((data) => {
        if (cancelled) return
        setPortableReviewMediaUrl(data.media_url ? `${bridgeUrl}${data.media_url}` : null)
      })
      .catch(async (error) => {
        if (cancelled) return
        setPortableReviewMediaUrl(null)
        const status = await window.batchAudioDesktop.bridgeStatus()
        setBridgeStatus(status)
        setUiError(`Portable preview failed. ${error instanceof Error ? error.message : 'Unknown error'}. Log: ${status.logPath}`)
      })
    return () => {
      cancelled = true
    }
  }, [bridgeAuthToken, bridgeUrl, portableReview.audio_path, portableReview.open])

  function mergeJobIntoPayload(updatedJob: Job) {
    setPayload((current) => {
      if (!current) return current
      const existingJobs = current.jobs ?? []
      const nextJobs = existingJobs.some((job) => job.job_id === updatedJob.job_id)
        ? existingJobs.map((job) => (job.job_id === updatedJob.job_id ? updatedJob : job))
        : [updatedJob, ...existingJobs]
      return { ...current, jobs: nextJobs }
    })
  }

  function syncTimelineDraftForJob(updatedJob: Job) {
    setTimelineDrafts((current) => {
      const existingDraft = current[updatedJob.job_id] ?? null
      if (!existingDraft) return current
      const nextDraft = syncTimelineDraftWithJob(updatedJob, existingDraft)
      if (!nextDraft) {
        const next = { ...current }
        delete next[updatedJob.job_id]
        return next
      }
      return { ...current, [updatedJob.job_id]: nextDraft }
    })
  }

  function clearTimelinePlayback() {
    audioRef.current?.pause()
    setAudioCurrentTimeMs(0)
    setActiveAudio((current) => (current?.sourceType === 'mix' ? null : current))
  }

  function openTimelineEditor(job: Job) {
    const draft = timelineDrafts[job.job_id] ?? buildTimelineDraft(job)
    if (!draft) {
      setUiError('This run needs current duration metadata before timeline editing is available. Rerun or regenerate with current metadata support.')
      return
    }
    setTimelineDrafts((current) => ({ ...current, [job.job_id]: current[job.job_id] ?? draft }))
    setTimelineJobId(job.job_id)
  }

  function closeTimelineEditor() {
    if (timelineJobId) {
      setTimelineDrafts((current) => ({
        ...current,
        [timelineJobId]: current[timelineJobId]
          ? { ...current[timelineJobId], previewRequestId: null, exportRequestId: null, previewUrl: null }
          : current[timelineJobId],
      }))
    }
    setTimelineJobId(null)
    clearTimelinePlayback()
  }

  async function createJob() {
    if (!bridgeUrl || !selectedVoice || !activeApiBase) {
      setUiError('Bridge is not ready or no voice/backend is selected yet.')
      return
    }
    setIsBusy(true)
    try {
      const response = await request('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: script,
          prompt_name: selectedVoice,
          api_base: activeApiBase,
          backend,
          variant_count: variantCount,
          chunk_mode: chunkMode,
          speed,
          pause_min_ms: pauseMinMs,
          pause_max_ms: pauseMaxMs,
          language,
        }),
      })
      const created: Job = await response.json()
      mergeJobIntoPayload(created)
      setActiveJobId(created.job_id)
      setUiError('')
    } catch (error) {
      const status = await window.batchAudioDesktop.bridgeStatus()
      setBridgeStatus(status)
      setUiError(`Generate failed. ${error instanceof Error ? error.message : 'Unknown error'}. Log: ${status.logPath}`)
    } finally {
      setIsBusy(false)
    }
  }

  async function appendToCurrentRun() {
    if (!bridgeUrl || !activeJob) {
      setUiError('Select an active run before appending more script.')
      return
    }
    if (!selectedVoice) {
      setUiError('Select a voice before appending to the current run.')
      return
    }
    if (!script.trim()) {
      setUiError('Write some script text before appending to the current run.')
      return
    }
    setIsBusy(true)
    try {
      const response = await request(`/api/jobs/${activeJob.job_id}/append`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: script,
          prompt_name: selectedVoice,
          api_base: activeJob.api_base,
          backend: activeJob.backend,
          variant_count: variantCount,
          chunk_mode: chunkMode,
          speed,
          pause_min_ms: pauseMinMs,
          pause_max_ms: pauseMaxMs,
          language,
        }),
      })
      const updated = await response.json() as Job & { first_appended_chunk_id?: string | null }
      mergeJobIntoPayload(updated)
      syncTimelineDraftForJob(updated)
      setActiveJobId(updated.job_id)
      if (updated.first_appended_chunk_id) {
        setFocusChunkId(updated.first_appended_chunk_id)
        setChunkExpansion((current) => ({ ...current, [updated.first_appended_chunk_id!]: 'manual-open' }))
      }
      setUiError('')
    } catch (error) {
      const status = await window.batchAudioDesktop.bridgeStatus()
      setBridgeStatus(status)
      setUiError(`Append failed. ${error instanceof Error ? error.message : 'Unknown error'}. Log: ${status.logPath}`)
    } finally {
      setIsBusy(false)
    }
  }

  async function refreshVoices() {
    if (!bridgeUrl) return
    setIsBusy(true)
    try {
      const response = await request('/api/voices/refresh', { method: 'POST' })
      const data = await response.json()
      setPayload((current) => ({ ...(current ?? data), ...data, jobs: current?.jobs ?? [] }))
      setUiError('')
      setBridgeStatus(await window.batchAudioDesktop.bridgeStatus())
    } catch (error) {
      const status = await window.batchAudioDesktop.bridgeStatus()
      setBridgeStatus(status)
      setUiError(`Voice refresh failed. ${error instanceof Error ? error.message : 'Unknown error'}. Log: ${status.logPath}`)
    } finally {
      setIsBusy(false)
    }
  }

  async function importExistingVoice() {
    if (!bridgeUrl || !importForm.name || !importForm.audio_path) return
    setIsBusy(true)
    try {
      await request('/api/voices/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(importForm) })
      setImportForm(initialImport)
      setUiError('')
    } catch (error) {
      const status = await window.batchAudioDesktop.bridgeStatus()
      setBridgeStatus(status)
      setUiError(`Voice import failed. ${error instanceof Error ? error.message : 'Unknown error'}. Log: ${status.logPath}`)
    } finally {
      setIsBusy(false)
    }
  }

  function openPortableReview() {
    if (!importForm.name || !importForm.audio_path) return
    setPortableReview({ open: true, name: importForm.name, ref_text: importForm.ref_text, audio_path: importForm.audio_path })
  }

  function closePortableReview() {
    setPortableReview(initialPortableReview)
    setPortableReviewMediaUrl(null)
  }

  async function confirmPortableSave() {
    if (!bridgeUrl || !portableReview.name || !portableReview.audio_path || !activeApiBase) return
    setIsBusy(true)
    try {
      await request('/api/voices/save-clone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...importForm,
          audio_path: portableReview.audio_path,
          name: portableReview.name,
          ref_text: portableReview.ref_text,
          api_base: activeApiBase,
        }),
      })
      setImportForm(initialImport)
      closePortableReview()
      setUiError('')
    } catch (error) {
      const status = await window.batchAudioDesktop.bridgeStatus()
      setBridgeStatus(status)
      setUiError(`Portable save failed. ${error instanceof Error ? error.message : 'Unknown error'}. Log: ${status.logPath}`)
    } finally {
      setIsBusy(false)
    }
  }

  async function transcribeVoice() {
    if (!bridgeUrl || !importForm.audio_path || !activeApiBase) return
    setIsBusy(true)
    try {
      const response = await request('/api/voices/transcribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ audio_path: importForm.audio_path, api_base: activeApiBase }) })
      const data = await response.json()
      setImportForm((current) => ({ ...current, ref_text: data.transcript ?? '' }))
      setUiError('')
    } catch (error) {
      const status = await window.batchAudioDesktop.bridgeStatus()
      setBridgeStatus(status)
      setUiError(`Transcription failed. ${error instanceof Error ? error.message : 'Unknown error'}. Log: ${status.logPath}`)
    } finally {
      setIsBusy(false)
    }
  }

  async function chooseAudio() {
    const file = await window.batchAudioDesktop.chooseAudioFile()
    if (file) setImportForm((current) => ({ ...current, audio_path: file }))
  }

  async function makeVoicePortable(voice: VoiceInventory) {
    const file = voice.local_audio_path || (await window.batchAudioDesktop.chooseAudioFile())
    if (!file) return
    setIsBusy(true)
    let transcript = voice.local_ref_text ?? voice.registry_entry?.ref_text ?? ''
    try {
      const transcriptionApiBase = payload?.local_available ? payload.local_api_base : activeApiBase || payload?.modal_api_base || ''
      if (!transcript && bridgeUrl && transcriptionApiBase) {
        const response = await request('/api/voices/transcribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ audio_path: file, api_base: transcriptionApiBase }) })
        const data = await response.json()
        transcript = data.transcript ?? transcript
      }
      setUiError('')
    } catch (error) {
      const status = await window.batchAudioDesktop.bridgeStatus()
      setBridgeStatus(status)
      setUiError(`Portable preparation failed. ${error instanceof Error ? error.message : 'Unknown error'}. Log: ${status.logPath}`)
      return
    } finally {
      setIsBusy(false)
    }
    setImportForm({ name: voice.name, audio_path: file, ref_text: transcript, x_vector_only_mode: voice.registry_entry?.x_vector_only_mode ?? false })
    setPortableReview({ open: true, name: voice.name, ref_text: transcript, audio_path: file })
  }

  async function deleteVoice(voice: VoiceInventory) {
    const confirmed = window.confirm(`Delete saved voice "${voice.name}"?`)
    if (!confirmed) return
    setIsBusy(true)
    try {
      const response = await request(`/api/voices/${encodeURIComponent(voice.name)}`, { method: 'DELETE' })
      const data = await response.json()
      setPayload((current) => ({ ...(current ?? data), ...(data as Partial<StatePayload>), jobs: current?.jobs ?? [] }))
      setSelectedVoice((current) => (current === voice.name ? (data.voices?.[0]?.name ?? '') : current))
      setUiError('')
      setBridgeStatus(await window.batchAudioDesktop.bridgeStatus())
    } catch (error) {
      const status = await window.batchAudioDesktop.bridgeStatus()
      setBridgeStatus(status)
      setUiError(`Voice delete failed. ${error instanceof Error ? error.message : 'Unknown error'}. Log: ${status.logPath}`)
    } finally {
      setIsBusy(false)
    }
  }

  async function previewMix(jobId: string) {
    if (!bridgeUrl) return
    try {
      const response = await request(
        `/api/jobs/${jobId}/preview-mix`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pause_min_ms: pauseMinMs, pause_max_ms: pauseMaxMs }) },
      )
      const data = await response.json()
      if (data.preview_mix_url) {
        const job = queue.find((entry) => entry.job_id === jobId)
        setActiveAudio({ url: `${bridgeUrl}${data.preview_mix_url}`, label: job?.voice_display_name || job?.prompt_name || 'Preview Mix', jobId, isMix: true, backend: job?.backend, sourceType: 'mix', autoBound: false })
        window.setTimeout(() => audioRef.current?.play().catch(() => undefined), 0)
      }
    } catch (error) {
      const status = await window.batchAudioDesktop.bridgeStatus()
      setBridgeStatus(status)
      setUiError(`Preview failed. ${error instanceof Error ? error.message : 'Unknown error'}. Log: ${status.logPath}`)
    }
  }

  async function exportMix(jobId: string) {
    const destinationPath = await window.batchAudioDesktop.chooseExportPath()
    if (!destinationPath || !bridgeUrl) return
    try {
      await request(
        `/api/jobs/${jobId}/export`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ destination_path: destinationPath, pause_min_ms: pauseMinMs, pause_max_ms: pauseMaxMs }) },
      )
      setUiError('')
    } catch (error) {
      const status = await window.batchAudioDesktop.bridgeStatus()
      setBridgeStatus(status)
      setUiError(`Export failed. ${error instanceof Error ? error.message : 'Unknown error'}. Log: ${status.logPath}`)
    }
  }

  function updateTimelineDraft(jobId: string, updater: (draft: TimelineDraft) => TimelineDraft) {
    setTimelineDrafts((current) => {
      const draft = current[jobId]
      if (!draft) return current
      return { ...current, [jobId]: updater(draft) }
    })
  }

  function updateTimelineTrim(clipIndex: number, field: 'trimInMs' | 'trimOutMs', value: string) {
    if (!timelineJobId) return
    clearTimelinePlayback()
    updateTimelineDraft(timelineJobId, (draft) => {
      const clips = draft.clips.map((clip, index) => (index === clipIndex ? { ...clip, [field]: normalizeTrimInput(value, clip.durationMs) } : clip))
      return { ...draft, clips, revision: draft.revision + 1, previewUrl: null, exportSuccessPath: null, inlineError: '' }
    })
  }

  async function requestTimelinePreview() {
    if (!timelineJob || !timelineDraft) return
    const validationError = validateTimelineDraft(timelineDraft)
    if (validationError) {
      updateTimelineDraft(timelineJob.job_id, (draft) => ({ ...draft, inlineError: validationError }))
      return
    }
    clearTimelinePlayback()
    const requestId = crypto.randomUUID()
    updateTimelineDraft(timelineJob.job_id, (draft) => ({ ...draft, previewRequestId: requestId, inlineError: '', previewUrl: null, exportSuccessPath: null }))
    try {
      await request(`/api/jobs/${timelineJob.job_id}/timeline/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildTimelinePayload(timelineDraft, requestId)),
      })
    } catch (error) {
      updateTimelineDraft(timelineJob.job_id, (draft) => ({ ...draft, previewRequestId: null, inlineError: error instanceof Error ? error.message : 'Preview failed.' }))
    }
  }

  async function requestTimelineExport() {
    if (!timelineJob || !timelineDraft) return
    const validationError = validateTimelineDraft(timelineDraft)
    if (validationError) {
      updateTimelineDraft(timelineJob.job_id, (draft) => ({ ...draft, inlineError: validationError }))
      return
    }
    const exportPath = await window.batchAudioDesktop.chooseExportPath()
    if (!exportPath) return
    const requestId = crypto.randomUUID()
    updateTimelineDraft(timelineJob.job_id, (draft) => ({ ...draft, exportRequestId: requestId, exportSuccessPath: null, inlineError: '' }))
    try {
      await request(`/api/jobs/${timelineJob.job_id}/timeline/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildTimelinePayload(timelineDraft, requestId, exportPath)),
      })
    } catch (error) {
      updateTimelineDraft(timelineJob.job_id, (draft) => ({ ...draft, exportRequestId: null, inlineError: error instanceof Error ? error.message : 'Export failed.' }))
    }
  }

  function toggleTimelinePlayback() {
    if (!timelineDraft?.previewUrl) {
      requestTimelinePreview()
      return
    }
    const startMs = Math.max(0, Math.min(audioCurrentTimeMs, timelineTotalMs))
    if (activeAudio?.url !== timelineDraft.previewUrl) {
      setActiveAudio({ url: timelineDraft.previewUrl, label: `${timelineJob?.voice_display_name || timelineJob?.prompt_name || 'Timeline'} Timeline Preview`, jobId: timelineJob?.job_id, isMix: true, backend: timelineJob?.backend, sourceType: 'mix', autoBound: false })
      setAudioCurrentTimeMs(startMs)
      window.setTimeout(() => {
        if (!audioRef.current) return
        audioRef.current.currentTime = startMs / 1000
        audioRef.current.play().catch(() => undefined)
      }, 0)
      return
    }
    if (audioRef.current?.paused) {
      audioRef.current.currentTime = startMs / 1000
      audioRef.current.play().catch(() => undefined)
    } else {
      audioRef.current?.pause()
    }
  }

  async function renameRun(job: Job, runLabel: string) {
    const nextLabel = runLabel.trim()
    if (!nextLabel) {
      setUiError('Run label cannot be empty.')
      return
    }
    try {
      const response = await request(`/api/jobs/${job.job_id}/label`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ run_label: nextLabel }),
      })
      const updatedJob: Job = await response.json()
      mergeJobIntoPayload(updatedJob)
      syncTimelineDraftForJob(updatedJob)
      setUiError('')
    } catch (error) {
      const status = await window.batchAudioDesktop.bridgeStatus()
      setBridgeStatus(status)
      setUiError(`Rename failed. ${error instanceof Error ? error.message : 'Unknown error'}. Log: ${status.logPath}`)
    }
  }

  async function cancelRun(job: Job) {
    if (chunkTweakDraft?.jobId === job.job_id && chunkTweakDraft.dirty) {
      const shouldContinue = window.confirm('Discard the current chunk tweak draft and cancel this run?')
      if (!shouldContinue) return
      setChunkTweakDraft(null)
    }
    try {
      await request(`/api/jobs/${job.job_id}/cancel`, { method: 'POST' })
    } catch (error) {
      const status = await window.batchAudioDesktop.bridgeStatus()
      setBridgeStatus(status)
      setUiError(`Cancel failed. ${error instanceof Error ? error.message : 'Unknown error'}. Log: ${status.logPath}`)
    }
  }

  async function deleteRun(job: Job) {
    const confirmed = window.confirm(`Delete run "${job.run_label || job.current_task}"?`)
    if (!confirmed) return
    try {
      await request(`/api/jobs/${job.job_id}`, { method: 'DELETE' })
      setActiveJobId((current) => (current === job.job_id ? null : current))
    } catch (error) {
      const status = await window.batchAudioDesktop.bridgeStatus()
      setBridgeStatus(status)
      setUiError(`Delete failed. ${error instanceof Error ? error.message : 'Unknown error'}. Log: ${status.logPath}`)
    }
  }

  async function selectCandidate(jobId: string, chunkId: string, candidateId: string) {
    if (!bridgeUrl || chunkLocks[chunkId]) return
    const job = queue.find((entry) => entry.job_id === jobId)
    const chunk = job?.chunks.find((entry) => entry.chunk_id === chunkId)
    const candidate = chunk?.candidates.find((entry) => entry.candidate_id === candidateId)
    const persistedSelectionId = chunk?.selected_candidate_id ?? null
    const effectiveSelectionId = controllerState?.effectiveSelectedCandidateIds[chunkId] ?? persistedSelectionId
    const isChangedSelection = Boolean(
      (persistedSelectionId && persistedSelectionId !== candidateId)
      || (!persistedSelectionId && effectiveSelectionId && effectiveSelectionId !== candidateId),
    )
    try {
      const response = await request(`/api/jobs/${jobId}/select`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chunk_id: chunkId, candidate_id: candidateId }) })
      const updatedJob: Job = await response.json()
      mergeJobIntoPayload(updatedJob)
      syncTimelineDraftForJob(updatedJob)
      workflow.markChunkConfirmed(chunkId, { changed: isChangedSelection })
      setFocusChunkId(chunkId)
      setUiError('')
      if (candidate) {
        const isActiveTimelinePreview = activeAudio?.jobId === jobId && activeAudio?.sourceType === 'mix' && !audioRef.current?.paused
        if (!isActiveTimelinePreview) {
          setActiveAudio({ url: `${bridgeUrl}${candidate.audio_url}`, label: `${job?.voice_display_name || job?.prompt_name || 'Candidate'} ${candidate.variant_label}`, candidateId: candidate.candidate_id, chunkIndex: chunk?.index, variantLabel: candidate.variant_label, jobId, backend: job?.backend, generationTime: chunk?.generation_time, sourceType: 'candidate', autoBound: false })
          window.setTimeout(() => audioRef.current?.play().catch(() => undefined), 0)
        }
      }
    } catch (error) {
      const status = await window.batchAudioDesktop.bridgeStatus()
      setBridgeStatus(status)
      setUiError(`Selection failed. ${error instanceof Error ? error.message : 'Unknown error'}. Log: ${status.logPath}`)
    }
  }

  function handlePlayCandidate(job: Job, chunk: JobChunk, audioUrl: string, variantLabel: string, generationTime?: number) {
    setActiveAudio({ url: `${bridgeUrl}${audioUrl}`, label: `${job.voice_display_name || job.prompt_name} ${variantLabel}`, chunkIndex: chunk.index, variantLabel, jobId: job.job_id, backend: job.backend, generationTime, sourceType: 'candidate', autoBound: false })
    window.setTimeout(() => audioRef.current?.play().catch(() => undefined), 0)
  }

  function toggleChunkLock(chunkId: string) {
    const nextLocked = !chunkLocks[chunkId]
    setChunkLocks((current) => ({ ...current, [chunkId]: nextLocked }))
    if (nextLocked && controllerState?.effectiveSelectedCandidateIds[chunkId]) {
      workflow.markChunkConfirmed(chunkId, { changed: false })
    }
  }

  function toggleChunk(chunk: JobChunk) {
    const isExpanded = expandedChunkIds.has(chunk.chunk_id)
    if (!isExpanded) {
      setFocusChunkId(chunk.chunk_id)
    }
    setChunkExpansion((current) => ({ ...current, [chunk.chunk_id]: isExpanded ? 'manual-closed' : 'manual-open' }))
  }

  function openTweak(job: Job, chunk: JobChunk) {
    setFocusChunkId(chunk.chunk_id)
    if (chunkTweakDraft && chunkTweakDraft.chunkId !== chunk.chunk_id && chunkTweakDraft.dirty) {
      const shouldReplace = window.confirm('Discard the current chunk tweak draft and switch to another chunk?')
      if (!shouldReplace) return
    }
    setChunkTweakDraft({
      jobId: job.job_id,
      chunkId: chunk.chunk_id,
      promptName: job.prompt_name,
      textOverride: chunk.text,
      speed: Number(job.run_defaults?.speed ?? speed),
      pauseMs: Number(job.run_defaults?.pause_max_ms ?? job.run_defaults?.pause_ms ?? pauseMaxMs),
      variantCount: Number(job.run_defaults?.variant_count ?? variantCount),
      language: String(job.run_defaults?.language ?? language),
      backend: (job.run_defaults?.backend as 'modal' | 'local') ?? (job.backend as 'modal' | 'local') ?? backend,
      dirty: false,
    })
    setChunkExpansion((current) => ({ ...current, [chunk.chunk_id]: 'manual-open' }))
  }

  async function regenerateChunk(job: Job, chunk: JobChunk, regenCount?: number) {
    try {
      await request(`/api/jobs/${job.job_id}/chunks/${chunk.chunk_id}/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          request_id: crypto.randomUUID(),
          ...(regenCount && regenCount > 0 ? { variant_count: regenCount } : {}),
        }),
      })
      setFocusChunkId(chunk.chunk_id)
    } catch (error) {
      const status = await window.batchAudioDesktop.bridgeStatus()
      setBridgeStatus(status)
      setUiError(`Regenerate failed. ${error instanceof Error ? error.message : 'Unknown error'}. Log: ${status.logPath}`)
    }
  }

  async function deleteChunk(job: Job, chunk: JobChunk) {
    const confirmed = window.confirm(`Delete chunk ${String(chunk.index).padStart(2, '0')}?`)
    if (!confirmed) return
    try {
      const response = await request(`/api/jobs/${job.job_id}/chunks/${chunk.chunk_id}`, { method: 'DELETE' })
      const updatedJob: Job = await response.json()
      mergeJobIntoPayload(updatedJob)
      syncTimelineDraftForJob(updatedJob)
      if (focusChunkId === chunk.chunk_id) setFocusChunkId(null)
    } catch (error) {
      const status = await window.batchAudioDesktop.bridgeStatus()
      setBridgeStatus(status)
      setUiError(`Delete chunk failed. ${error instanceof Error ? error.message : 'Unknown error'}. Log: ${status.logPath}`)
    }
  }

  async function addChunkAfter(job: Job, chunk: JobChunk) {
    const text = window.prompt(`Add chunk after ${String(chunk.index).padStart(2, '0')}.`, '')
    if (!text || !text.trim()) return
    const countRaw = window.prompt('How many versions to generate for this chunk?', String(Math.max(1, Number(job.run_defaults?.variant_count ?? 1))))
    const parsedCount = Math.max(1, Math.min(12, Math.round(Number(countRaw || '1')) || 1))
    try {
      const response = await request(`/api/jobs/${job.job_id}/chunks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: text.trim(),
          after_chunk_id: chunk.chunk_id,
          generate_versions: true,
          variant_count: parsedCount,
        }),
      })
      const updatedJob: Job = await response.json()
      mergeJobIntoPayload(updatedJob)
      syncTimelineDraftForJob(updatedJob)
      const inserted = updatedJob.chunks.find((entry) => entry.text === text.trim() && entry.index === chunk.index + 1)
      if (inserted) {
        setFocusChunkId(inserted.chunk_id)
        setChunkExpansion((current) => ({ ...current, [inserted.chunk_id]: 'manual-open' }))
      }
      setUiError('')
    } catch (error) {
      const status = await window.batchAudioDesktop.bridgeStatus()
      setBridgeStatus(status)
      setUiError(`Add chunk failed. ${error instanceof Error ? error.message : 'Unknown error'}. Log: ${status.logPath}`)
    }
  }

  async function deleteCandidateVersion(job: Job, chunk: JobChunk, candidateId: string) {
    const target = chunk.candidates.find((entry) => entry.candidate_id === candidateId)
    if (!target) return
    const confirmed = window.confirm(`Delete version ${target.variant_label}?`)
    if (!confirmed) return
    try {
      const response = await request(`/api/jobs/${job.job_id}/chunks/${chunk.chunk_id}/candidates/${candidateId}`, { method: 'DELETE' })
      const updatedJob: Job = await response.json()
      mergeJobIntoPayload(updatedJob)
      syncTimelineDraftForJob(updatedJob)
      if (activeAudio?.candidateId === candidateId) {
        audioRef.current?.pause()
        setActiveAudio(null)
      }
      setUiError('')
    } catch (error) {
      const status = await window.batchAudioDesktop.bridgeStatus()
      setBridgeStatus(status)
      setUiError(`Delete version failed. ${error instanceof Error ? error.message : 'Unknown error'}. Log: ${status.logPath}`)
    }
  }

  async function reorderChunk(job: Job, chunkId: string, toIndex: number) {
    try {
      const response = await request(`/api/jobs/${job.job_id}/chunks/reorder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chunk_id: chunkId, to_index: toIndex }),
      })
      const updatedJob: Job = await response.json()
      mergeJobIntoPayload(updatedJob)
      syncTimelineDraftForJob(updatedJob)
      setUiError('')
    } catch (error) {
      const status = await window.batchAudioDesktop.bridgeStatus()
      setBridgeStatus(status)
      setUiError(`Reorder failed. ${error instanceof Error ? error.message : 'Unknown error'}. Log: ${status.logPath}`)
    }
  }

  async function updateChunkText(job: Job, chunk: JobChunk, text: string) {
    const nextText = text.trim()
    if (!nextText || nextText === chunk.text.trim()) return
    try {
      const response = await request(`/api/jobs/${job.job_id}/chunks/${chunk.chunk_id}/text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: nextText }),
      })
      const updatedJob: Job = await response.json()
      mergeJobIntoPayload(updatedJob)
      syncTimelineDraftForJob(updatedJob)
      setFocusChunkId(chunk.chunk_id)
      setUiError('')
    } catch (error) {
      const status = await window.batchAudioDesktop.bridgeStatus()
      setBridgeStatus(status)
      setUiError(`Update text failed. ${error instanceof Error ? error.message : 'Unknown error'}. Log: ${status.logPath}`)
    }
  }

  async function runTweakedRegeneration(job: Job, chunk: JobChunk) {
    if (!chunkTweakDraft || chunkTweakDraft.chunkId !== chunk.chunk_id) return
    if (!chunkTweakDraft.textOverride.trim()) {
      setUiError('Chunk text is required for tweak regeneration.')
      return
    }
    if (!chunkTweakDraft.promptName.trim()) {
      setUiError('Prompt is required for routed chunk regeneration.')
      return
    }
    if (chunkTweakDraft.variantCount < 1 || chunkTweakDraft.variantCount > 12) {
      setUiError('Regeneration count must be between 1 and 12.')
      return
    }
    try {
      await request(`/api/jobs/${job.job_id}/chunks/${chunk.chunk_id}/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          request_id: crypto.randomUUID(),
          text_override: chunkTweakDraft.textOverride.trim(),
          prompt_name: chunkTweakDraft.promptName,
          variant_count: chunkTweakDraft.variantCount,
          backend: chunkTweakDraft.backend,
          api_base: chunkTweakDraft.backend === 'modal' ? payload?.modal_api_base : payload?.local_api_base,
          speed: chunkTweakDraft.speed,
          pause_ms: chunkTweakDraft.pauseMs,
          language: chunkTweakDraft.language,
        }),
      })
      setChunkTweakDraft(null)
      setFocusChunkId(chunk.chunk_id)
      setUiError('')
    } catch (error) {
      const status = await window.batchAudioDesktop.bridgeStatus()
      setBridgeStatus(status)
      setUiError(`Tweak regenerate failed. ${error instanceof Error ? error.message : 'Unknown error'}. Log: ${status.logPath}`)
    }
  }

  return (
    <>
      <WorkspaceLayout
        header={<WorkspaceHeader queue={queue} uiError={uiError} setUiError={setUiError} activeJob={activeJob} modalPool={payload?.modal_pool ?? null} />}
        left={<LeftPanel selectedVoice={selectedVoice} onSelectVoice={setSelectedVoice} voices={availableVoices} voiceSource={voiceSource} onVoiceSourceChange={setVoiceSource} backend={backend} onBackendChange={setBackend} chunkMode={chunkMode} onChunkModeChange={setChunkMode} onRefreshVoices={refreshVoices} onMakePortable={makeVoicePortable} onDeleteVoice={deleteVoice} isBusy={isBusy} activeApiBase={activeApiBase} theme={theme} onThemeChange={setTheme} />}
        center={
          <div className="center-stage">
            <div className="center-stage__body soft-scroll">
              <TimelinePanel
                groups={groups}
                voices={availableVoices}
                expandedVoiceIds={expandedVoiceIds}
                activeJob={activeJob}
                activeJobId={activeJobId}
                workflowStep={workflowStep}
                workflowSummary={workflowSummary}
                workflowGuidance={workflowGuidance}
                workflowBlockedReason={workflowBlockedReason}
                workflowPlaybackLabel={workflowPlaybackLabel}
                showTimelineCta={allChunksConfirmed}
                canOpenTimeline={canOpenTimeline}
                effectiveSelectedCandidateIds={controllerState?.effectiveSelectedCandidateIds ?? {}}
                chunkReviewStates={controllerState?.chunkReviewStates ?? {}}
                chunkPresentationVariants={controllerState?.chunkPresentationVariants ?? {}}
                bridgeUrl={bridgeUrl}
                chunkLocks={chunkLocks}
                expandedChunkIds={expandedChunkIds}
                tweakDraft={chunkTweakDraft}
                onToggleVoice={(voiceId) => setExpandedVoiceIds((current) => ({ ...current, [voiceId]: !current[voiceId] }))}
                onSwitchJob={(jobId) => {
                  if (chunkTweakDraft?.dirty && chunkTweakDraft.jobId !== jobId) {
                    const shouldContinue = window.confirm('Discard the current chunk tweak draft and switch runs?')
                    if (!shouldContinue) return
                    setChunkTweakDraft(null)
                  }
                  setActiveJobId(jobId)
                }}
                onToggleChunk={toggleChunk}
                onToggleLock={toggleChunkLock}
                onSelectCandidate={selectCandidate}
                onPlayCandidate={handlePlayCandidate}
                onRegenerate={regenerateChunk}
                onDeleteChunk={deleteChunk}
                onAddChunkAfter={addChunkAfter}
                onDeleteCandidate={deleteCandidateVersion}
                onRenameRun={renameRun}
                onReorderChunk={reorderChunk}
                onUpdateChunkText={updateChunkText}
                onOpenTweak={openTweak}
                onUpdateTweakDraft={(updater) => setChunkTweakDraft((current) => (current ? updater(current) : current))}
                onRunTweakedRegeneration={runTweakedRegeneration}
                onCancelTweak={() => setChunkTweakDraft(null)}
                onOpenExport={() => activeJob && openTimelineEditor(activeJob)}
                onCancelRun={cancelRun}
                onDeleteRun={deleteRun}
              />
            </div>
            <div className="composer-dock">
              <div className="composer-dock__meta">
                <div>
                  <div className="section-label !mb-0">Composer</div>
                  <div className="text-xs text-white/45">{selectedVoice ? `${selectedVoice} · ${backend === 'local' ? 'Local MLX' : 'Modal GPU'}` : 'Select a voice to generate'}</div>
                </div>
                <div className="flex items-center gap-2">
                  <button className="ghost-btn" onClick={appendToCurrentRun} disabled={isBusy || !activeJob}>
                    Add To Current Run
                  </button>
                  <button className="btn-primary" onClick={createJob} disabled={isBusy || !selectedVoice || !activeApiBase}>
                    Run Batch
                  </button>
                </div>
              </div>
              <textarea
                className="composer-dock__textarea"
                value={script}
                onChange={(event) => setScript(event.target.value)}
                placeholder="Write the next script here..."
              />
            </div>
          </div>
        }
        right={<InspectorPanel voiceClone={<VoiceClone importForm={importForm} setImportForm={setImportForm} chooseAudio={chooseAudio} transcribeVoice={transcribeVoice} importExistingVoice={importExistingVoice} openPortableReview={openPortableReview} isBusy={isBusy} />} currentPrompt={<ActivePromptCard title={activeJob ? 'Active Prompt' : 'Draft Prompt'} promptText={activeJob?.source_text || script} />} controls={<Controls speed={speed} setSpeed={setSpeed} pauseMinMs={pauseMinMs} setPauseMinMs={setPauseMinMs} pauseMaxMs={pauseMaxMs} setPauseMaxMs={setPauseMaxMs} variantCount={variantCount} setVariantCount={setVariantCount} language={language} setLanguage={setLanguage} backend={backend} setBackend={setBackend} tweakDraft={chunkTweakDraft} setTweakDraft={(updater) => setChunkTweakDraft((current) => (current ? updater(current) : current))} onClearTweak={() => setChunkTweakDraft(null)} />} player={<Player audioRef={audioRef} activeAudio={activeAudio} />} />}
      />

      <audio ref={audioRef} src={activeAudio?.url ?? undefined} controls className="hidden" />

      {portableReview.open && (
        <div className="modal-backdrop">
          <div className="modal-panel">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="section-label">Portable Review</div>
                <div className="section-title">Review Before Sending To Modal</div>
              </div>
              <button className="ghost-btn" onClick={closePortableReview}>Close</button>
            </div>
            <div className="mt-4 space-y-3">
              <label className="block"><div className="mb-1.5 text-[11px] uppercase tracking-[0.22em] text-white/48">Voice name</div><input className="aurora-input" value={portableReview.name} onChange={(event) => setPortableReview((current) => ({ ...current, name: event.target.value }))} /></label>
              <label className="block"><div className="mb-1.5 text-[11px] uppercase tracking-[0.22em] text-white/48">Transcript</div><textarea className="aurora-textarea h-[168px]" value={portableReview.ref_text} onChange={(event) => setPortableReview((current) => ({ ...current, ref_text: event.target.value }))} /></label>
              <div className="soft-card p-3 text-xs text-white/52"><div>Audio file: {portableReview.audio_path}</div>{portableReviewMediaUrl && <audio controls src={portableReviewMediaUrl} className="mt-3 w-full" />}</div>
            </div>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button className="ghost-btn" onClick={closePortableReview}>Cancel</button>
              <button className="btn-primary" onClick={confirmPortableSave} disabled={isBusy || !portableReview.name || !portableReview.ref_text.trim()}>Confirm Save</button>
            </div>
          </div>
        </div>
      )}

      {timelineJob && timelineDraft && (
        <TimelineEditorModal
          job={timelineJob}
          draft={timelineDraft}
          pauseBetweenClipsMs={timelinePauseGapsMs}
          inlineError={timelineInlineError}
          totalDurationMs={timelineTotalMs}
          currentTimeMs={audioCurrentTimeMs}
          isPlaying={Boolean(activeAudio?.url === timelineDraft.previewUrl && !audioRef.current?.paused)}
          canPlayPreview={Boolean(timelineDraft.previewUrl)}
          isReadonly={timelineReadonly}
          renderStatus={timelineJob.timeline_render_status ?? 'idle'}
          onClose={closeTimelineEditor}
          onTogglePlayback={toggleTimelinePlayback}
          onPreview={requestTimelinePreview}
          onExport={requestTimelineExport}
          onTrimChange={updateTimelineTrim}
          onSeek={(ms) => {
            const boundedMs = Math.max(0, Math.min(timelineTotalMs, Math.round(ms)))
            setAudioCurrentTimeMs(boundedMs)
            if (timelineDraft?.previewUrl && activeAudio?.url === timelineDraft.previewUrl && audioRef.current) {
              audioRef.current.currentTime = boundedMs / 1000
            }
          }}
          onSwapCandidate={(clipIndex, candidateId) => {
            if (!timelineJobId || !timelineJob) return
            const chunkId = timelineDraft?.clips[clipIndex]?.chunkId
            if (!chunkId) return
            void selectCandidate(timelineJob.job_id, chunkId, candidateId)
          }}
          onPreviewCandidate={(clipIndex, candidateId) => {
            if (!timelineJob || !timelineDraft) return
            const chunkId = timelineDraft.clips[clipIndex]?.chunkId
            const chunk = timelineJob.chunks.find((entry) => entry.chunk_id === chunkId)
            const candidate = chunk?.candidates.find((entry) => entry.candidate_id === candidateId)
            if (!chunk || !candidate) return
            handlePlayCandidate(timelineJob, chunk, candidate.audio_url, candidate.variant_label, chunk.generation_time)
          }}
          onAddChunkAfter={async (clipIndex) => {
            if (!timelineJob) return
            const chunkId = timelineDraft?.clips[clipIndex]?.chunkId
            const chunk = timelineJob.chunks.find((entry) => entry.chunk_id === chunkId)
            if (!chunk) return
            await addChunkAfter(timelineJob, chunk)
          }}
          onRegenerateChunk={async (clipIndex) => {
            if (!timelineJob || !timelineDraft) return
            const chunkId = timelineDraft.clips[clipIndex]?.chunkId
            const chunk = timelineJob.chunks.find((entry) => entry.chunk_id === chunkId)
            if (!chunk) return
            await regenerateChunk(timelineJob, chunk)
          }}
          onAddVersions={async (clipIndex, count) => {
            if (!timelineJob || !timelineDraft) return
            const chunkId = timelineDraft.clips[clipIndex]?.chunkId
            const chunk = timelineJob.chunks.find((entry) => entry.chunk_id === chunkId)
            if (!chunk) return
            await regenerateChunk(timelineJob, chunk, count)
          }}
          onUpdateChunkText={async (clipIndex, text) => {
            if (!timelineJob || !timelineDraft) return
            const chunkId = timelineDraft.clips[clipIndex]?.chunkId
            const chunk = timelineJob.chunks.find((entry) => entry.chunk_id === chunkId)
            if (!chunk) return
            await updateChunkText(timelineJob, chunk, text)
          }}
          onReorderClip={async (fromIndex, toIndex) => {
            if (!timelineJob || !timelineDraft) return
            const clip = timelineDraft.clips[fromIndex]
            if (!clip) return
            await reorderChunk(timelineJob, clip.chunkId, toIndex)
          }}
          onReplaceDraft={(updater) => {
            if (!timelineJobId) return
            clearTimelinePlayback()
            updateTimelineDraft(timelineJobId, updater)
          }}
        />
      )}
    </>
  )
}

function pickPreviewCandidate(job: Job, focusChunkId: string | null, effectiveSelectedCandidateIds: Record<string, string>) {
  const focusedChunk = focusChunkId ? job.chunks.find((chunk) => chunk.chunk_id === focusChunkId) : null
  if (focusedChunk?.candidates.length) {
    const selectedCandidateId = effectiveSelectedCandidateIds[focusedChunk.chunk_id]
    const selectedCandidate = selectedCandidateId
      ? focusedChunk.candidates.find((candidate) => candidate.candidate_id === selectedCandidateId) ?? null
      : null
    if (selectedCandidate) {
      return { chunk: focusedChunk, candidate: selectedCandidate }
    }
    const focusedCandidate = [...focusedChunk.candidates].sort(compareCandidatesByCreatedAt)[focusedChunk.candidates.length - 1]
    return { chunk: focusedChunk, candidate: focusedCandidate }
  }

  for (const chunk of job.chunks) {
    const selectedCandidateId = effectiveSelectedCandidateIds[chunk.chunk_id]
    if (!selectedCandidateId) continue
    const selectedCandidate = chunk.candidates.find((candidate) => candidate.candidate_id === selectedCandidateId)
    if (selectedCandidate) return { chunk, candidate: selectedCandidate }
  }

  let best: { chunk: JobChunk; candidate: JobChunk['candidates'][number] } | null = null
  for (const chunk of job.chunks) {
    for (const candidate of chunk.candidates) {
      if (!best || compareCandidatesByCreatedAt(best.candidate, candidate) < 0) {
        best = { chunk, candidate }
      }
    }
  }
  return best
}

function compareCandidatesByCreatedAt(a: JobChunk['candidates'][number], b: JobChunk['candidates'][number]) {
  const aCreated = a.created_at || ''
  const bCreated = b.created_at || ''
  return aCreated.localeCompare(bCreated)
}
