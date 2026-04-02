/* ─── Shared types for Batch Audio Studio ─── */

declare global {
  interface Window {
    batchAudioDesktop: {
      bridgeUrl: () => Promise<string>
      bridgeAuthToken: () => Promise<string>
      bridgeStatus: () => Promise<{ ready: boolean; status: string; logPath: string }>
      chooseAudioFile: () => Promise<string | null>
      chooseExportPath: () => Promise<string | null>
    }
  }
}

export type VoiceInventory = {
  name: string
  available_local: boolean
  available_modal: boolean
  portable: boolean
  sources: string[]
  local_prompt_id?: string | null
  local_ref_text?: string | null
  local_audio_path?: string | null
  modal_prompt_id?: string | null
  registry_entry: { audio_path: string; ref_text: string; x_vector_only_mode: boolean } | null
}

export type Candidate = {
  candidate_id: string
  variant_label: string
  status: string
  audio_url: string
  duration?: number
  duration_ms?: number | null
  generation_time?: number
  source_prompt_name?: string | null
  source_backend?: string | null
  source_api_base?: string | null
  created_at?: string | null
}

export type TimelineRenderStatus = 'idle' | 'previewing' | 'exporting' | 'preview_ready' | 'export_ready' | 'failed'

export type TimelineRenderError = {
  code: string
  message: string
  clip_index?: number
}

export type JobChunk = {
  chunk_id: string
  index: number
  text: string
  selected_candidate_id: string | null
  candidates: Candidate[]
  generation_time?: number
  status?: string
  current_task?: string
  error_message?: string | null
}

export type Job = {
  job_id: string
  run_id?: string
  voice_id?: string
  voice_display_name?: string
  run_label?: string
  created_at?: string
  updated_at?: string
  status: string
  backend: string
  api_base: string
  prompt_name: string
  progress_percent: number
  current_task: string
  preview_mix_url: string | null
  error_message: string | null
  source_text?: string
  chunks: JobChunk[]
  total_generation_time?: number
  total_work_units?: number
  completed_work_units?: number
  timeline_render_status?: TimelineRenderStatus
  timeline_render_error?: string | null
  timeline_render_errors?: TimelineRenderError[]
  timeline_request_id?: string | null
  timeline_preview_mix_url?: string | null
  timeline_export_path?: string | null
  run_defaults?: {
    api_base?: string
    backend?: 'modal' | 'local' | string
    variant_count?: number
    chunk_mode?: string
    max_chars?: number
    speed?: number
    pause_ms?: number
    pause_min_ms?: number
    pause_max_ms?: number
    language?: string
  }
}

export type TimelineClipDraft = {
  chunkId: string
  candidateId: string
  chunkIndex: number
  chunkLabel: string
  candidateLabel: string
  durationMs: number
  trimInMs: string
  trimOutMs: string
}

export type TimelineDraft = {
  jobId: string
  revision: number
  clips: TimelineClipDraft[]
  snapshot: Array<{ chunkId: string; selectedCandidateId: string }>
  previewRequestId?: string | null
  exportRequestId?: string | null
  previewUrl?: string | null
  exportPath?: string | null
  inlineError?: string
  exportSuccessPath?: string | null
}

export type TimelineRequestPayload = {
  request_id: string
  export_path?: string
  clips: Array<{
    candidate_id: string
    chunk_id: string
    trim_in_ms: number
    trim_out_ms: number
    source_duration_ms: number
  }>
}

export type StatePayload = {
  local_api_base: string
  modal_api_base: string
  local_available: boolean
  modal_available: boolean
  modal_pool?: {
    in_flight: number
    queued: number
    max: number
  }
  voices: VoiceInventory[]
  jobs: Job[]
}

export type ActiveAudio = {
  url: string
  label: string
  candidateId?: string
  chunkIndex?: number
  variantLabel?: string
  jobId?: string
  isMix?: boolean
  backend?: string
  generationTime?: number
  sourceType?: 'candidate' | 'mix'
  autoBound?: boolean
}

export type ChunkExpansionMode = 'manual-open' | 'manual-closed' | 'auto'

export type ChunkExpansionMap = Record<string, ChunkExpansionMode>

export type ChunkLockMap = Record<string, boolean>

export type ChunkTweakDraft = {
  jobId: string
  chunkId: string
  promptName: string
  textOverride: string
  speed: number
  pauseMs: number
  variantCount: number
  language: string
  backend: 'modal' | 'local'
  dirty?: boolean
}

export type VoiceRunGroup = {
  voiceId: string
  voiceDisplayName: string
  jobs: Job[]
}

export type ImportForm = {
  name: string
  audio_path: string
  ref_text: string
  x_vector_only_mode: boolean
}

export type PortableReview = {
  open: boolean
  name: string
  ref_text: string
  audio_path: string
}

export const initialImport: ImportForm = {
  name: '',
  audio_path: '',
  ref_text: '',
  x_vector_only_mode: false,
}

export const initialPortableReview: PortableReview = {
  open: false,
  name: '',
  ref_text: '',
  audio_path: '',
}

/** Deterministic waveform from string hash */
export function generateWaveform(id: string, count = 20): number[] {
  let h = 0
  for (let i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0
  return Array.from({ length: count }, (_, i) => Math.abs(Math.sin(h * (i + 1) * 0.17)) * 0.6 + 0.4)
}
