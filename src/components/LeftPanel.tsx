import { Cloud, Download, Mic2, RefreshCcw, Settings2, Trash2, Zap } from 'lucide-react'
import { useState } from 'react'
import type { VoiceInventory } from '../types'

type VoiceSource = 'all' | 'local' | 'modal' | 'portable'
type ThemeName = 'neon' | 'sunset' | 'ocean' | 'light-neon' | 'light-sunset' | 'light-ocean'

type Props = {
  selectedVoice: string
  onSelectVoice: (value: string) => void
  voices: VoiceInventory[]
  voiceSource: VoiceSource
  onVoiceSourceChange: (value: VoiceSource) => void
  backend: 'modal' | 'local'
  onBackendChange: (value: 'modal' | 'local') => void
  chunkMode: string
  onChunkModeChange: (value: string) => void
  onRefreshVoices: () => void
  onMakePortable: (voice: VoiceInventory) => void
  onDeleteVoice: (voice: VoiceInventory) => void
  isBusy: boolean
  activeApiBase: string
  theme: ThemeName
  onThemeChange: (value: ThemeName) => void
}

export function LeftPanel({
  selectedVoice,
  onSelectVoice,
  voices,
  voiceSource,
  onVoiceSourceChange,
  backend,
  onBackendChange,
  chunkMode,
  onChunkModeChange,
  onRefreshVoices,
  onMakePortable,
  onDeleteVoice,
  isBusy,
  activeApiBase,
  theme,
  onThemeChange,
}: Props) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const voiceCategory = (voice: VoiceInventory): VoiceSource => {
    if (voice.available_local && voice.available_modal) return 'portable'
    if (voice.available_local) return 'local'
    if (voice.available_modal) return 'modal'
    return voice.portable ? 'portable' : 'modal'
  }

  const groupedVoices = {
    portable: voices.filter((voice) => voiceCategory(voice) === 'portable'),
    local: voices.filter((voice) => voiceCategory(voice) === 'local'),
    modal: voices.filter((voice) => voiceCategory(voice) === 'modal'),
  }

  return (
    <>
      <div>
        <div className="text-xl font-semibold tracking-[-0.03em] text-white">Batch Audio Studio</div>
        <div className="mt-1 text-xs text-white/40">Creative workspace for grouped runs and chunk-level voice iteration.</div>
      </div>

      <div className="panel-left__offset" />

      <div className="space-y-3">
        <div className="soft-card p-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="section-label !mb-0">Voice Library</div>
              <div className="text-xs text-white/45">{activeApiBase || 'Backend URL unavailable'}</div>
            </div>
            <button className="ghost-btn" onClick={onRefreshVoices} disabled={isBusy}>
              <RefreshCcw className="h-3 w-3" />
              Refresh
            </button>
          </div>

          <div className="mt-2">
            <select
              className="aurora-input !rounded-lg !py-2 !text-xs"
              value={voiceSource}
              onChange={(event) => onVoiceSourceChange(event.target.value as VoiceSource)}
            >
              <option value="all">All Sources</option>
              <option value="local">Local</option>
              <option value="modal">Modal</option>
              <option value="portable">Portable</option>
            </select>
          </div>

          <div className="mt-3 space-y-3">
            {(voiceSource === 'all' || voiceSource === 'portable') && (
              <VoiceGroup
                title="Portable"
                voices={groupedVoices.portable}
                selectedVoice={selectedVoice}
                onSelectVoice={onSelectVoice}
                onMakePortable={onMakePortable}
                onDeleteVoice={onDeleteVoice}
                isBusy={isBusy}
              />
            )}
            {(voiceSource === 'all' || voiceSource === 'local') && (
              <VoiceGroup
                title="Local"
                voices={groupedVoices.local}
                selectedVoice={selectedVoice}
                onSelectVoice={onSelectVoice}
                onMakePortable={onMakePortable}
                onDeleteVoice={onDeleteVoice}
                isBusy={isBusy}
              />
            )}
            {(voiceSource === 'all' || voiceSource === 'modal') && (
              <VoiceGroup
                title="Modal"
                voices={groupedVoices.modal}
                selectedVoice={selectedVoice}
                onSelectVoice={onSelectVoice}
                onMakePortable={onMakePortable}
                onDeleteVoice={onDeleteVoice}
                isBusy={isBusy}
              />
            )}
          </div>
        </div>

        <div className="soft-card p-3">
          <div className="section-label">Routing</div>
          <div className="segment-group">
            <button className={`segment-pill ${backend === 'modal' ? 'segment-pill--active' : ''}`} onClick={() => onBackendChange('modal')}>
              Modal
            </button>
            <button className={`segment-pill ${backend === 'local' ? 'segment-pill--active' : ''}`} onClick={() => onBackendChange('local')}>
              Local
            </button>
          </div>

          <div className="mt-3 section-label">Chunking</div>
          <div className="segment-group">
            <button className={`segment-pill ${chunkMode === 'sentence' ? 'segment-pill--active' : ''}`} onClick={() => onChunkModeChange('sentence')}>
              1 sentence
            </button>
            <button className={`segment-pill ${chunkMode === 'pair' ? 'segment-pill--active' : ''}`} onClick={() => onChunkModeChange('pair')}>
              2 sentences
            </button>
          </div>
        </div>

        <div className="composer-backend-pill">
          {backend === 'local' ? <Zap className="h-3 w-3 text-neon" /> : <Cloud className="h-3 w-3 text-mint" />}
          <span>{backend === 'local' ? 'Local MLX' : 'Modal GPU'}</span>
          <span className={`backend-dot ${activeApiBase ? 'backend-dot--online' : 'backend-dot--offline'}`} />
        </div>

        <div className="settings-dock">
          <button
            type="button"
            className={`settings-dock__trigger ${settingsOpen ? 'settings-dock__trigger--active' : ''}`}
            onClick={() => setSettingsOpen((current) => !current)}
          >
            <Settings2 className="h-3.5 w-3.5" />
            Settings
          </button>
          {settingsOpen ? (
            <div className="settings-dock__panel">
              <div className="settings-dock__label">Theme</div>
              <div className="settings-dock__themes">
                <button
                  type="button"
                  className={`settings-theme-pill ${theme === 'neon' ? 'settings-theme-pill--active' : ''}`}
                  onClick={() => onThemeChange('neon')}
                >
                  Neon
                </button>
                <button
                  type="button"
                  className={`settings-theme-pill ${theme === 'sunset' ? 'settings-theme-pill--active' : ''}`}
                  onClick={() => onThemeChange('sunset')}
                >
                  Sunset
                </button>
                <button
                  type="button"
                  className={`settings-theme-pill ${theme === 'ocean' ? 'settings-theme-pill--active' : ''}`}
                  onClick={() => onThemeChange('ocean')}
                >
                  Ocean
                </button>
                <button
                  type="button"
                  className={`settings-theme-pill ${theme === 'light-neon' ? 'settings-theme-pill--active' : ''}`}
                  onClick={() => onThemeChange('light-neon')}
                >
                  Neon Light
                </button>
                <button
                  type="button"
                  className={`settings-theme-pill ${theme === 'light-sunset' ? 'settings-theme-pill--active' : ''}`}
                  onClick={() => onThemeChange('light-sunset')}
                >
                  Sunset Light
                </button>
                <button
                  type="button"
                  className={`settings-theme-pill ${theme === 'light-ocean' ? 'settings-theme-pill--active' : ''}`}
                  onClick={() => onThemeChange('light-ocean')}
                >
                  Ocean Light
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </>
  )
}

function VoiceGroup({
  title,
  voices,
  selectedVoice,
  onSelectVoice,
  onMakePortable,
  onDeleteVoice,
  isBusy,
}: {
  title: string
  voices: VoiceInventory[]
  selectedVoice: string
  onSelectVoice: (value: string) => void
  onMakePortable: (voice: VoiceInventory) => void
  onDeleteVoice: (voice: VoiceInventory) => void
  isBusy: boolean
}) {
  if (!voices.length) return null

  return (
    <div>
      <div className="voice-group-label">{title}</div>
      <div className="mt-2 space-y-2">
        {voices.map((voice) => (
          <button key={`${title}-${voice.name}`} className={`voice-pill ${selectedVoice === voice.name ? 'voice-pill--active' : ''}`} onClick={() => onSelectVoice(voice.name)}>
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-white">{voice.name}</div>
              <div className="mt-1 flex gap-1.5 text-[10px] uppercase tracking-[0.18em] text-white/40">
                <span>{resolveVoiceAvailabilityLabel(voice)}</span>
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              {voice.available_local && !voice.portable && (
                <button
                  type="button"
                  className="voice-action-icon"
                  title={`Make ${voice.name} portable`}
                  onClick={(event) => {
                    event.stopPropagation()
                    onMakePortable(voice)
                  }}
                >
                  <Download className="h-3.5 w-3.5" />
                </button>
              )}
              {isDeletableVoice(voice) && (
                <button
                  type="button"
                  className="voice-action-icon voice-action-icon--danger"
                  title={`Delete ${voice.name}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    onDeleteVoice(voice)
                  }}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              )}
              <Mic2 className="h-4 w-4 shrink-0 text-neon/80" />
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

function isDeletableVoice(voice: VoiceInventory) {
  const localCustom = Boolean(voice.local_prompt_id && !voice.local_prompt_id.startsWith('builtin:'))
  const modalCustom = Boolean(voice.modal_prompt_id && !voice.modal_prompt_id.startsWith('builtin:'))
  return localCustom || modalCustom || Boolean(voice.portable)
}

function resolveVoiceAvailabilityLabel(voice: VoiceInventory) {
  if (voice.available_local && voice.available_modal) return 'Portable'
  if (voice.available_local) return 'Local'
  if (voice.available_modal) return 'Modal'
  if (voice.portable) return 'Portable'
  return 'Modal'
}
