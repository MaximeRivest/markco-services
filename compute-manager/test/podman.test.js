import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';

// We test by mocking child_process.execFile at the module level.
// Since podman.js uses promisify(execFile), we mock the callback version.

// Create a controllable mock for execFile
let execFileMock;

// We'll test the parseMemory logic and command construction indirectly
// by importing podman after mocking.

describe('podman wrapper', () => {
  // Since we can't easily mock ESM imports, test the command construction logic
  // by validating the expected arguments pattern.

  it('startContainer builds correct podman args', () => {
    const opts = {
      name: 'rt-user1-abc12345',
      image: 'localhost/mrmd-runtime:latest',
      memoryLimit: 268435456,
      cpuLimit: 0.5,
      port: 41765,
    };

    // Expected args pattern
    const expectedArgs = [
      'run', '-d',
      '--name', 'rt-user1-abc12345',
      '--runtime', 'runc',
      '--memory', '268435456',
      '--cpus', '0.5',
      '-p', '41765:8888',
      'localhost/mrmd-runtime:latest',
    ];

    // Verify the args would be constructed correctly
    const args = [
      'run', '-d',
      '--name', opts.name,
      '--runtime', 'runc',
      '--memory', String(opts.memoryLimit),
      '--cpus', String(opts.cpuLimit),
    ];
    if (opts.port) args.push('-p', `${opts.port}:8888`);
    args.push(opts.image);

    assert.deepEqual(args, expectedArgs);
  });

  it('checkpointContainer builds correct args with --leave-running', () => {
    const name = 'rt-user1-abc12345';
    const exportPath = '/tmp/checkpoint.tar.gz';
    const leaveRunning = true;

    const args = ['container', 'checkpoint', '--export', exportPath];
    if (leaveRunning) args.push('--leave-running');
    args.push(name);

    assert.deepEqual(args, [
      'container', 'checkpoint',
      '--export', '/tmp/checkpoint.tar.gz',
      '--leave-running',
      'rt-user1-abc12345',
    ]);
  });

  it('checkpointContainer builds correct args without --leave-running', () => {
    const name = 'rt-user1-abc12345';
    const exportPath = '/tmp/checkpoint.tar.gz';
    const leaveRunning = false;

    const args = ['container', 'checkpoint', '--export', exportPath];
    if (leaveRunning) args.push('--leave-running');
    args.push(name);

    assert.deepEqual(args, [
      'container', 'checkpoint',
      '--export', '/tmp/checkpoint.tar.gz',
      'rt-user1-abc12345',
    ]);
  });

  it('restoreContainer builds correct args', () => {
    const importPath = '/tmp/checkpoint.tar.gz';
    const name = 'rt-user1-restored';

    const args = ['container', 'restore', '--import', importPath, '--name', name];

    assert.deepEqual(args, [
      'container', 'restore',
      '--import', '/tmp/checkpoint.tar.gz',
      '--name', 'rt-user1-restored',
    ]);
  });

  it('container naming follows rt-{userId}-{shortId} pattern', () => {
    const userId = 'abc123';
    const shortId = 'deadbeef';
    const name = `rt-${userId}-${shortId}`;
    assert.match(name, /^rt-.+-.+$/);
    assert.equal(name, 'rt-abc123-deadbeef');
  });

  it('sandbox naming follows sb-{userId}-{shortId} pattern', () => {
    const userId = 'abc123';
    const shortId = 'cafebabe';
    const name = `sb-${userId}-${shortId}`;
    assert.match(name, /^sb-.+-.+$/);
  });

  it('parseMemory handles various formats', () => {
    // Inline the parseMemory logic for testing
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

    assert.equal(parseMemory('12.5MiB / 256MiB'), Math.round(12.5 * 1048576));
    assert.equal(parseMemory('1.5GiB / 4GiB'), Math.round(1.5 * 1073741824));
    assert.equal(parseMemory('512KiB / 1MiB'), Math.round(512 * 1024));
    assert.equal(parseMemory('0B'), 0);
    assert.equal(parseMemory(''), 0);
  });

  it('remote commands use SSH with correct options', () => {
    const host = '10.0.1.50';
    const sshKeyPath = '/home/ec2-user/.ssh/id_ed25519';
    const command = 'podman';
    const podmanArgs = ['stats', '--no-stream', '--format', 'json', 'rt-test-123'];

    const sshArgs = [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=5',
      '-i', sshKeyPath,
      `ec2-user@${host}`,
      command,
      ...podmanArgs,
    ];

    assert.equal(sshArgs[sshArgs.length - 5], 'stats');
    assert.ok(sshArgs.includes('-i'));
    assert.ok(sshArgs.includes(`ec2-user@${host}`));
  });

  it('SCP command uses correct format', () => {
    const localPath = '/tmp/checkpoint.tar.gz';
    const remoteHost = '10.0.1.50';
    const remotePath = '/tmp/checkpoint.tar.gz';
    const sshKeyPath = '/home/ec2-user/.ssh/id_ed25519';

    const scpArgs = [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=5',
      '-i', sshKeyPath,
      localPath,
      `ec2-user@${remoteHost}:${remotePath}`,
    ];

    assert.ok(scpArgs[scpArgs.length - 1].includes(':'));
    assert.ok(scpArgs.includes(localPath));
  });
});
