import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

const SSH_KEY_PATH = process.env.SSH_KEY_PATH || '/home/ec2-user/.ssh/id_ed25519';
const SSH_USER = process.env.SSH_USER || 'ubuntu';
const SSH_OPTS = ['-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=5', '-i', SSH_KEY_PATH];

/**
 * Run a command locally or on a remote host via SSH.
 * Uses execFile (no shell) to prevent injection.
 */
async function run(command, args, host) {
  if (!host || host === 'localhost' || host === '127.0.0.1') {
    const { stdout, stderr } = await execFile(command, args, { timeout: 60000 });
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  }
  // Remote: SSH to host and run command with sudo
  const sshArgs = [...SSH_OPTS, `${SSH_USER}@${host}`, 'sudo', command, ...args];
  const { stdout, stderr } = await execFile('ssh', sshArgs, { timeout: 60000 });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

/**
 * Start a container with podman run.
 * @param {Object} opts
 * @param {string} opts.name - container name
 * @param {string} opts.image - container image
 * @param {number} opts.memoryLimit - memory in bytes
 * @param {number} opts.cpuLimit - cpu quota (e.g. 0.5)
 * @param {number} opts.port - host port to map
 * @param {string} [opts.host] - target host
 * @returns {Promise<{containerId: string}>}
 */
export async function startContainer({ name, image, memoryLimit, cpuLimit, port, host, volumeMount }) {
  const args = [
    'run', '-d',
    '--name', name,
    '--restart=on-failure:5',
    '--runtime', 'runc',
    '--security-opt', 'apparmor=unconfined',
    '--memory', String(memoryLimit || 268435456),
    '--cpus', String(cpuLimit || 0.5),
  ];
  if (port) {
    args.push('-p', `${port}:8888`);
  }
  if (volumeMount) {
    // :U asks Podman to map/chown volume ownership for the container user
    args.push('-v', `${volumeMount}:U`);
  }
  args.push(image || 'localhost/mrmd-runtime:latest');

  const { stdout } = await run('podman', args, host);
  return { containerId: stdout };
}

/**
 * CRIU checkpoint a container.
 * @param {string} name - container name
 * @param {string} exportPath - path to export checkpoint archive
 * @param {boolean} leaveRunning - keep container running after checkpoint
 * @param {string} [host] - target host
 */
export async function checkpointContainer(name, exportPath, leaveRunning, host) {
  const args = ['container', 'checkpoint', '--export', exportPath];
  if (leaveRunning) args.push('--leave-running');
  args.push(name);
  const start = Date.now();
  await run('podman', args, host);
  // Make checkpoint readable for SCP transfer (podman creates as root 600)
  await run('chmod', ['644', exportPath], host);
  return { durationMs: Date.now() - start };
}

/**
 * CRIU restore a container from checkpoint.
 * @param {string} importPath - path to checkpoint archive
 * @param {string} name - new container name
 * @param {string} [host] - target host
 * @param {Object} [opts] - additional options
 * @param {number} [opts.port] - host port to publish (maps to container's original port)
 * @param {string} [opts.memory] - memory limit (e.g. '512m')
 */
export async function restoreContainer(importPath, name, host, opts = {}) {
  const args = ['container', 'restore', '--import', importPath, '--name', name];
  if (opts.port) args.push('-p', `${opts.port}:8888`);
  const start = Date.now();
  const { stdout } = await run('podman', args, host);
  return { containerId: stdout, durationMs: Date.now() - start };
}

/**
 * Force-remove a container.
 */
export async function removeContainer(name, host) {
  try {
    await run('podman', ['rm', '-f', name], host);
  } catch (err) {
    // Ignore errors if container already gone
    if (!err.stderr?.includes('no such container')) throw err;
  }
}

/**
 * Get container memory/cpu stats.
 */
export async function getContainerStats(name, host) {
  const { stdout } = await run('podman', [
    'stats', '--no-stream', '--format', 'json', name,
  ], host);
  const stats = JSON.parse(stdout);
  const entry = Array.isArray(stats) ? stats[0] : stats;
  return {
    memoryUsed: parseMemory(entry.mem_usage || entry.MemUsage || '0'),
    memoryLimit: parseMemory(entry.mem_limit || entry.MemLimit || '0'),
    cpuPercent: parseFloat(entry.cpu_percent || entry.CPU || '0'),
  };
}

/**
 * Parse podman memory string like "12.5MiB / 256MiB" → bytes
 */
function parseMemory(str) {
  const s = str.split('/')[0].trim();
  const match = s.match(/([\d.]+)\s*(GiB|MiB|KiB|B)/i);
  if (!match) return 0;
  const val = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === 'gib') return Math.round(val * 1073741824);
  if (unit === 'mib') return Math.round(val * 1048576);
  if (unit === 'kib') return Math.round(val * 1024);
  return Math.round(val);
}

/**
 * SCP a file to a remote host.
 */
export async function scpTo(localPath, remoteHost, remotePath) {
  const start = Date.now();
  await execFile('scp', [
    ...SSH_OPTS, localPath, `${SSH_USER}@${remoteHost}:${remotePath}`,
  ], { timeout: 120000 });
  return { durationMs: Date.now() - start };
}
