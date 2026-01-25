import { exec } from 'child_process'
import util from 'util'
const execAsync = util.promisify(exec)

const IMAGE = process.env.TIKTOK_BROWSER_IMAGE || 'jlesage/chrome:latest'
const HOST_BASE_PORT = parseInt(process.env.TIKTOK_HOST_PORT_BASE || '7000', 10)
const HOST_BASE_DEBUG = parseInt(process.env.TIKTOK_HOST_DEBUG_BASE || '9222', 10)

export async function startContainerForAccount(accountId: number, nickname: string) {
  const hostPort = HOST_BASE_PORT + accountId
  const debugPort = HOST_BASE_DEBUG + accountId
  const name = `sc_acc_${accountId}`

  // Run container with noVNC on 6901 and remote-debugging on 9222 mapped to host
  // try pulling the image first to provide clearer errors if it's unavailable
  try {
    await execAsync(`docker pull ${IMAGE}`)
  } catch (pullErr: any) {
    // continue — pull may fail due to auth but the subsequent run will show the same error; include stderr
    const msg = pullErr && pullErr.stderr ? pullErr.stderr.toString() : String(pullErr)
    throw new Error(`Failed to pull Docker image ${IMAGE}: ${msg}`)
  }

  const cmd = `docker run -d -p ${hostPort}:6901 -p ${debugPort}:9222 --name ${name} ${IMAGE}`
  try {
    const { stdout } = await execAsync(cmd)
    const containerId = stdout.trim()
    return { containerId, hostPort, debugPort }
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
