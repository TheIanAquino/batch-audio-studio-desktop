const { app, BrowserWindow, dialog, ipcMain, screen } = require('electron')
const crypto = require('crypto')
const fs = require('fs')
const http = require('http')
const net = require('net')
const path = require('path')
const { spawn } = require('child_process')

const BRIDGE_HOST = '127.0.0.1'
const DEFAULT_BRIDGE_PORT = Number(process.env.BATCH_AUDIO_BRIDGE_PORT || '42111')
const BRIDGE_HEALTH_TIMEOUT_MS = 15000
const MAX_BRIDGE_RESTARTS = 3

let bridgePort = DEFAULT_BRIDGE_PORT
let bridgeAuthToken = ''
let bridgeProcess = null
let bridgeReady = false
let bridgeStatus = 'starting'
let bridgeRestartCount = 0
let isQuitting = false
let bridgeRestartTimer = null
let mainWindow = null
let suppressBridgeRestart = false

function bridgeConfigRoot() {
  const configured = String(process.env.BATCH_AUDIO_CONFIG_DIR || '').trim()
  return configured || path.join(app.getPath('home'), '.batch-audio-studio')
}

function bridgeLogPath() {
  return path.join(bridgeConfigRoot(), 'bridge.log')
}

function appendBridgeLog(message) {
  fs.mkdirSync(bridgeConfigRoot(), { recursive: true })
  fs.appendFile(bridgeLogPath(), `[${new Date().toISOString()}] ${message}\n`, () => {})
}

function resolveBridgeScript() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'bridge', 'batch_audio_bridge.py')
  }
  return path.join(__dirname, '..', 'bridge', 'batch_audio_bridge.py')
}

function resolvePythonExecutable() {
  if (app.isPackaged) {
    const bundledPython = path.join(process.resourcesPath, 'bridge-runtime', 'bin', 'python3')
    if (!fs.existsSync(bundledPython)) {
      throw new Error(`Bundled bridge runtime is missing: ${bundledPython}`)
    }
    return bundledPython
  }

  const localRuntimePython = path.join(__dirname, '..', '.tmp', 'bridge-runtime', 'bin', 'python3')
  if (fs.existsSync(localRuntimePython)) {
    return localRuntimePython
  }

  const userBridgePython = path.join(app.getPath('home'), '.batch-audio-studio', 'bridge-venv', 'bin', 'python3')
  return fs.existsSync(userBridgePython) ? userBridgePython : 'python3'
}

function findAvailablePort(preferredPort) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.unref()
    probe.once('error', (error) => {
      if (error.code !== 'EADDRINUSE') {
        reject(error)
        return
      }
      const fallback = net.createServer()
      fallback.unref()
      fallback.once('error', reject)
      fallback.listen(0, BRIDGE_HOST, () => {
        const address = fallback.address()
        const port = typeof address === 'object' && address ? address.port : preferredPort
        fallback.close((closeError) => {
          if (closeError) {
            reject(closeError)
            return
          }
          resolve(port)
        })
      })
    })
    probe.listen(preferredPort, BRIDGE_HOST, () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : preferredPort
      probe.close((closeError) => {
        if (closeError) {
          reject(closeError)
          return
        }
        resolve(port)
      })
    })
  })
}

function waitForBridgeHealth(timeoutMs = BRIDGE_HEALTH_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get({ host: BRIDGE_HOST, port: bridgePort, path: '/api/health', timeout: 1500 }, (res) => {
        res.resume()
        if (res.statusCode === 200) {
          bridgeReady = true
          bridgeStatus = 'ready'
          bridgeRestartCount = 0
          appendBridgeLog(`Bridge health check passed on port ${bridgePort}.`)
          resolve(true)
          return
        }
        if (Date.now() >= deadline) {
          reject(new Error(`Bridge health check failed with status ${res.statusCode}`))
          return
        }
        setTimeout(attempt, 400)
      })
      req.on('error', () => {
        if (Date.now() >= deadline) {
          reject(new Error('Bridge health check timed out.'))
          return
        }
        setTimeout(attempt, 400)
      })
      req.on('timeout', () => {
        req.destroy(new Error('Bridge health check timeout'))
      })
    }
    attempt()
  })
}

function createWindow() {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const { x, y, width, height } = display.workArea
  const win = new BrowserWindow({
    x,
    y,
    width,
    height,
    minWidth: 1280,
    minHeight: 820,
    backgroundColor: '#0b0f0a',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.setBounds({ x, y, width, height })
  mainWindow = win
  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null
    }
  })

  if (!app.isPackaged) {
    win.loadURL('http://127.0.0.1:5173')
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }
}

function scheduleBridgeRestart() {
  if (isQuitting || bridgeRestartTimer || bridgeRestartCount >= MAX_BRIDGE_RESTARTS) {
    if (!isQuitting && bridgeRestartCount >= MAX_BRIDGE_RESTARTS) {
      bridgeStatus = 'error'
      appendBridgeLog('Bridge restart limit reached.')
      dialog.showErrorBox('Batch Audio Studio', `The local bridge stopped unexpectedly and could not be restarted.\n\nSee ${bridgeLogPath()} for details.`)
    }
    return
  }
  bridgeRestartCount += 1
  bridgeRestartTimer = setTimeout(() => {
    bridgeRestartTimer = null
    startBridge().catch((error) => {
      bridgeStatus = 'error'
      appendBridgeLog(`Bridge restart ${bridgeRestartCount} failed: ${error.message}`)
      scheduleBridgeRestart()
    })
  }, 1500)
}

async function startBridge() {
  if (bridgeProcess) {
    return
  }

  const script = resolveBridgeScript()
  if (!fs.existsSync(script)) {
    throw new Error(`Bridge script is missing: ${script}`)
  }

  const pythonExecutable = resolvePythonExecutable()
  bridgeReady = false
  bridgeStatus = 'starting'
  appendBridgeLog(`Starting bridge with ${pythonExecutable} ${script} --port ${bridgePort}`)

  bridgeProcess = spawn(pythonExecutable, [script, '--port', String(bridgePort)], {
    cwd: path.dirname(script),
    env: {
      ...process.env,
      BATCH_AUDIO_BRIDGE_HOST: BRIDGE_HOST,
      BATCH_AUDIO_BRIDGE_PORT: String(bridgePort),
      BATCH_AUDIO_BRIDGE_TOKEN: bridgeAuthToken,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  bridgeProcess.stdout.on('data', (chunk) => appendBridgeLog(`[bridge] ${chunk.toString().trimEnd()}`))
  bridgeProcess.stderr.on('data', (chunk) => appendBridgeLog(`[bridge:stderr] ${chunk.toString().trimEnd()}`))
  bridgeProcess.on('error', (error) => {
    bridgeReady = false
    bridgeStatus = 'error'
    appendBridgeLog(`Bridge process error: ${error.message}`)
  })
  bridgeProcess.on('exit', (code, signal) => {
    appendBridgeLog(`Bridge exited with code=${code} signal=${signal}`)
    bridgeProcess = null
    bridgeReady = false
    if (!isQuitting && !suppressBridgeRestart) {
      bridgeStatus = 'error'
      scheduleBridgeRestart()
    }
    suppressBridgeRestart = false
  })

  try {
    await waitForBridgeHealth()
  } catch (error) {
    bridgeStatus = 'error'
    appendBridgeLog(`Bridge failed health check: ${error.message}`)
    if (bridgeProcess) {
      suppressBridgeRestart = true
      bridgeProcess.kill()
      bridgeProcess = null
    }
    throw error
  }
}

async function bootstrapApp() {
  bridgePort = await findAvailablePort(DEFAULT_BRIDGE_PORT)
  bridgeAuthToken = crypto.randomBytes(24).toString('hex')
  appendBridgeLog(`Reserved bridge port ${bridgePort}.`)
  await startBridge()
  createWindow()
}

app.whenReady().then(async () => {
  try {
    await bootstrapApp()
  } catch (error) {
    appendBridgeLog(`Startup failed: ${error.message}`)
    dialog.showErrorBox('Batch Audio Studio', `Bridge startup failed.\n\n${error.message}\n\nSee ${bridgeLogPath()} for details.`)
    app.quit()
    return
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  isQuitting = true
  if (bridgeRestartTimer) {
    clearTimeout(bridgeRestartTimer)
    bridgeRestartTimer = null
  }
  if (bridgeProcess) {
    suppressBridgeRestart = true
    bridgeProcess.kill()
    bridgeProcess = null
  }
})

ipcMain.handle('bridge:get-url', () => `http://${BRIDGE_HOST}:${bridgePort}`)
ipcMain.handle('bridge:get-auth-token', () => bridgeAuthToken)
ipcMain.handle('bridge:get-status', () => ({ ready: bridgeReady, status: bridgeStatus, logPath: bridgeLogPath() }))

ipcMain.handle('dialog:open-audio', async () => {
  const result = await dialog.showOpenDialog(mainWindow ?? undefined, {
    properties: ['openFile'],
    filters: [{ name: 'Audio', extensions: ['wav', 'mp3', 'm4a', 'aac', 'flac'] }],
  })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('dialog:save-wav', async () => {
  const result = await dialog.showSaveDialog(mainWindow ?? undefined, {
    defaultPath: 'final_mix.wav',
    filters: [{ name: 'WAV audio', extensions: ['wav'] }],
  })
  return result.canceled ? null : result.filePath
})
