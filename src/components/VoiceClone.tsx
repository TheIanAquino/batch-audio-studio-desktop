import { Upload } from 'lucide-react'
import type { ImportForm } from '../types'

type Props = {
  importForm: ImportForm
  setImportForm: React.Dispatch<React.SetStateAction<ImportForm>>
  chooseAudio: () => void
  transcribeVoice: () => void
  importExistingVoice: () => void
  openPortableReview: () => void
  isBusy: boolean
}

export function VoiceClone({ importForm, setImportForm, chooseAudio, transcribeVoice, importExistingVoice, openPortableReview, isBusy }: Props) {
  return (
    <div>
      <div className="section-label">Voice Clone</div>

      <button className="upload-zone mt-1 w-full" onClick={chooseAudio}>
        <Upload className="h-4 w-4 shrink-0 text-neon/70" />
        <div>
          <div className="text-xs font-medium text-white/80">Import reference audio</div>
          <div className="text-[10px] text-white/40">Clone into portable library</div>
        </div>
      </button>

      <div className="mt-2 grid grid-cols-2 gap-1.5">
        <label className="block">
          <div className="mb-1 text-[10px] text-white/40">Name</div>
          <input
            className="aurora-input !py-1 !px-2 !text-[11px] !rounded-lg"
            value={importForm.name}
            onChange={(e) => setImportForm((c) => ({ ...c, name: e.target.value }))}
          />
        </label>
        <label className="block">
          <div className="mb-1 text-[10px] text-white/40">Audio path</div>
          <input
            className="aurora-input !py-1 !px-2 !text-[11px] !rounded-lg"
            value={importForm.audio_path}
            onChange={(e) => setImportForm((c) => ({ ...c, audio_path: e.target.value }))}
          />
        </label>
      </div>

      <div className="mt-1.5">
        <div className="mb-1 text-[10px] text-white/40">Transcript</div>
        <textarea
          className="aurora-textarea !py-1.5 !px-2.5 !text-[11px] !rounded-lg"
          rows={2}
          placeholder="Reference transcript…"
          value={importForm.ref_text}
          onChange={(e) => setImportForm((c) => ({ ...c, ref_text: e.target.value }))}
        />
      </div>

      <div className="mt-1.5 flex flex-wrap gap-1.5">
        <button className="ghost-btn" onClick={transcribeVoice} disabled={isBusy || !importForm.audio_path}>
          Transcribe
        </button>
        <button className="ghost-btn" onClick={importExistingVoice} disabled={isBusy || !importForm.name || !importForm.audio_path}>
          Import
        </button>
        <button className="soft-button--accent soft-button" onClick={openPortableReview} disabled={isBusy || !importForm.name || !importForm.audio_path}>
          Save Clone
        </button>
      </div>
    </div>
  )
}
