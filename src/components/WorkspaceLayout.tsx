import type { ReactNode } from 'react'

type Props = {
  header: ReactNode
  left: ReactNode
  center: ReactNode
  right: ReactNode
}

export function WorkspaceLayout({ header, left, center, right }: Props) {
  return (
    <div className="workspace">
      {header}
      <aside className="panel-left soft-scroll">{left}</aside>
      <section className="panel-center soft-scroll">{center}</section>
      <aside className="panel-right soft-scroll">{right}</aside>
    </div>
  )
}
