import { exec } from 'child_process'
import util from 'util'
const execAsync = util.promisify(exec)

// Prefer a browser image that exposes an HTTP/web UI for manual login by default.
// IMAGE comes from the environment (`.env`). If a specific UI port isn't
// provided via `TIKTOK_BROWSER_IMAGE_UI_PORT`, try to pick a sensible default
// based on the image name (headful-chrome uses nginx on 9223; browserless uses 3000).
const IMAGE = process.env.TIKTOK_BROWSER_IMAGE || 'browserless/chrome:latest'
const HOST_BASE_PORT = parseInt(process.env.TIKTOK_HOST_PORT_BASE || '7000', 10)
const HOST_BASE_DEBUG = parseInt(process.env.TIKTOK_HOST_DEBUG_BASE || '9222', 10)
let IMAGE_UI_PORT = process.env.TIKTOK_BROWSER_IMAGE_UI_PORT ? parseInt(process.env.TIKTOK_BROWSER_IMAGE_UI_PORT, 10) : undefined
if (!IMAGE_UI_PORT) {
  if (IMAGE.includes('headful-chrome')) {
    IMAGE_UI_PORT = 9223 // nginx proxy to DevTools / UI inside the headful image
  } else if (IMAGE.includes('jlesage') || IMAGE.includes('selenium') ) {
    IMAGE_UI_PORT = 6901 // common noVNC port
  } else {
    IMAGE_UI_PORT = 3000 // browserless default UI port
  }
}

export async function startContainerForAccount(accountId: number, nickname: string) {
  const hostPort = HOST_BASE_PORT + accountId
  const debugPort = HOST_BASE_DEBUG + accountId
  const name = `sc_acc_${accountId}`
  const volumeName = `sc_acc_${accountId}_data`

  // Run container with noVNC on 6901 and remote-debugging on 9222 mapped to host
  // try pulling the image first to provide clearer errors if it's unavailable
  try {
    await execAsync(`docker pull ${IMAGE}`)
  } catch (pullErr: any) {
    // If pull fails (common for local images), check whether the image exists locally
    try {
      await execAsync(`docker image inspect ${IMAGE}`)
      // image exists locally — continue without pulling
    } catch (inspectErr: any) {
      const msg = pullErr && pullErr.stderr ? pullErr.stderr.toString() : String(pullErr)
      throw new Error(`Failed to pull Docker image ${IMAGE}: ${msg}`)
    }
  }

  // Ensure a persistent Docker volume exists for this account so the browser
  // user profile (userDataDir) is preserved between restarts. The volume is
  // mounted into the container at `/data` — adjust if your image expects a
  // different path for user data.
  try {
    await execAsync(`docker volume create ${volumeName}`)
  } catch (e) {
    // ignore volume create errors (may already exist)
  }

  const cmd = `docker run -d -p ${hostPort}:${IMAGE_UI_PORT} -p ${debugPort}:9222 --name ${name} -v ${volumeName}:/data ${IMAGE}`
  try {
    const { stdout } = await execAsync(cmd)
    const containerId = stdout.trim()
    return { containerId, hostPort, debugPort, volumeName }
  } catch (runErr: any) {
    const msg = runErr && runErr.stderr ? runErr.stderr.toString() : String(runErr)
    throw new Error(`Failed to run Docker container (${cmd}): ${msg}`)
  }
}

export async function stopContainer(accountId: number) {
  const name = `sc_acc_${accountId}`
  try {
    await execAsync(`docker stop ${name}`)
  } catch (e) { }
  try {
    await execAsync(`docker rm ${name}`)
  } catch (e) { }
  return true
}
