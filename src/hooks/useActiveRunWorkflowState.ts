import { useEffect, useMemo, useState } from 'react'
import { buildActiveRunWorkflowControllerState } from '../lib/activeRunWorkflowController'
import type { ActiveAudio, ChunkLockMap, Job } from '../types'

type Input = {
  activeAudio: ActiveAudio | null
  activeJob: Job | null
  activeTimelineJobId: string | null
  chunkLocks: ChunkLockMap
}

export function useActiveRunWorkflowState({ activeAudio, activeJob, activeTimelineJobId, chunkLocks }: Input) {
  const [confirmedByJob, setConfirmedByJob] = useState<Record<string, string[]>>({})
  const [changedByJob, setChangedByJob] = useState<Record<string, string[]>>({})

  const confirmedChunkIds = useMemo(
    () => new Set(activeJob ? confirmedByJob[activeJob.job_id] ?? [] : []),
    [activeJob, confirmedByJob],
  )
  const changedChunkIds = useMemo(
    () => new Set(activeJob ? changedByJob[activeJob.job_id] ?? [] : []),
    [activeJob, changedByJob],
  )

  const controllerState = useMemo(() => {
    if (!activeJob) return null
    return buildActiveRunWorkflowControllerState({
      job: activeJob,
      chunkLocks,
      confirmedChunkIds,
      changedChunkIds,
      activeTimelineJobId,
      activeAudio,
    })
  }, [activeAudio, activeJob, activeTimelineJobId, changedChunkIds, chunkLocks, confirmedChunkIds])

  useEffect(() => {
    if (!activeJob || !controllerState) return
    const nextConfirmed = [...controllerState.nextConfirmedChunkIds]
    setConfirmedByJob((current) => {
      const previous = current[activeJob.job_id] ?? []
      if (JSON.stringify(previous) === JSON.stringify(nextConfirmed)) return current
      return { ...current, [activeJob.job_id]: nextConfirmed }
    })
    setChangedByJob((current) => {
      const previous = current[activeJob.job_id] ?? []
      const next = previous.filter((chunkId) => controllerState.nextConfirmedChunkIds.has(chunkId))
      if (JSON.stringify(previous) === JSON.stringify(next)) return current
      return { ...current, [activeJob.job_id]: next }
    })
  }, [activeJob, controllerState])

  function markChunkConfirmed(chunkId: string, options?: { changed?: boolean }) {
    if (!activeJob) return
    setConfirmedByJob((current) => {
      const existing = new Set(current[activeJob.job_id] ?? [])
      existing.add(chunkId)
      return { ...current, [activeJob.job_id]: [...existing] }
    })

    if (options?.changed) {
      setChangedByJob((current) => {
        const existing = new Set(current[activeJob.job_id] ?? [])
        existing.add(chunkId)
        return { ...current, [activeJob.job_id]: [...existing] }
      })
    }
  }

  return {
    controllerState,
    markChunkConfirmed,
  }
}
