import type { ReactNode } from 'react'

type Props = {
  voiceClone: ReactNode
  currentPrompt: ReactNode
  controls: ReactNode
  player: ReactNode
}

export function InspectorPanel({ voiceClone, currentPrompt, controls, player }: Props) {
  return (
    <div className="inspector-stack">
      {voiceClone}
      {currentPrompt}
      {controls}
      <div className="inspector-stack__spacer" />
      {player}
    </div>
  )
}
