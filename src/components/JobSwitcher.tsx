import type { Job } from '../types'

type Props = {
  jobs: Job[]
  activeJobId: string | null
  onChange: (jobId: string) => void
}

export function JobSwitcher({ jobs, activeJobId, onChange }: Props) {
  if (!jobs.length) return null

  return (
    <label className="block">
      <div className="section-label">Active Job</div>
      <select
        className="aurora-input !rounded-lg !py-2 !text-xs"
        value={activeJobId ?? jobs[0].job_id}
        onChange={(event) => onChange(event.target.value)}
      >
        {jobs.map((job) => (
          <option key={job.job_id} value={job.job_id}>
            {job.prompt_name} · {job.status} · {Math.round(job.progress_percent)}%
          </option>
        ))}
      </select>
    </label>
  )
}
