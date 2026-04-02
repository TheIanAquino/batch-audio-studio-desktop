import { mkdirSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const root = path.resolve(__dirname, '..')
const runtimeRoot = path.join(root, '.tmp', 'bridge-runtime')
const requirementsFile = path.join(root, 'bridge', 'requirements.txt')
const pythonExecutable = process.env.BATCH_AUDIO_BUILD_PYTHON || 'python3'

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

rmSync(runtimeRoot, { recursive: true, force: true })
mkdirSync(path.dirname(runtimeRoot), { recursive: true })

run(pythonExecutable, ['-m', 'venv', runtimeRoot])

const runtimePython = path.join(runtimeRoot, 'bin', 'python3')
run(runtimePython, ['-m', 'pip', 'install', '-U', 'pip'])
run(runtimePython, ['-m', 'pip', 'install', '-r', requirementsFile])
