import { Copy, Check } from 'lucide-react'
import { useEffect, useState } from 'react'

type Props = {
  title: string
  promptText: string
}

export function ActivePromptCard({ title, promptText }: Props) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timeout = window.setTimeout(() => setCopied(false), 1400)
    return () => window.clearTimeout(timeout)
  }, [copied])

  async function copyPrompt() {
    if (!promptText.trim()) return
    await navigator.clipboard.writeText(promptText)
    setCopied(true)
  }

  return (
    <div className="soft-card p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="section-label !mb-0">{title}</div>
          <div className="mt-1 text-[11px] text-white/45">{promptText.trim() ? 'Source text for the current active run.' : 'No active run selected yet.'}</div>
        </div>
        <button className="ghost-btn" onClick={copyPrompt} disabled={!promptText.trim()}>
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      <div className="prompt-card__body mt-3">
        {promptText.trim() || 'Run a batch to pin the active prompt here.'}
      </div>
    </div>
  )
}
