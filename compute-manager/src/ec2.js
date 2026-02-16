import {
  EC2Client,
  RunInstancesCommand,
  TerminateInstancesCommand,
  DescribeInstancesCommand,
  waitUntilInstanceRunning,
} from '@aws-sdk/client-ec2';

const client = new EC2Client({ region: process.env.AWS_REGION || 'ca-central-1' });

const RUNTIME_AMI_ID = process.env.RUNTIME_AMI_ID;
const SECURITY_GROUP_ID = process.env.SECURITY_GROUP_ID;
const SUBNET_ID = process.env.SUBNET_ID;
const KEY_NAME = process.env.KEY_NAME;
const SSH_KEY_PATH = process.env.SSH_KEY_PATH || '/home/ubuntu/.ssh/markco-runtime';
const SSH_USER = process.env.SSH_USER || 'ubuntu';

/**
 * Provision an EC2 instance for running containers.
 * @param {string} instanceType - e.g. 't3.small', 't3.medium'
 * @param {string} [amiId] - override AMI
 * @returns {Promise<{instanceId: string, privateIp: string}>}
 */
export async function provisionInstance(instanceType, amiId) {
  const result = await client.send(new RunInstancesCommand({
    ImageId: amiId || RUNTIME_AMI_ID,
    InstanceType: instanceType,
    MinCount: 1,
    MaxCount: 1,
    KeyName: KEY_NAME,
    SecurityGroupIds: SECURITY_GROUP_ID ? [SECURITY_GROUP_ID] : undefined,
    SubnetId: SUBNET_ID || undefined,
    TagSpecifications: [{
      ResourceType: 'instance',
      Tags: [
        { Key: 'Name', Value: `markco-runtime-${instanceType}` },
        { Key: 'Service', Value: 'markco-compute' },
        { Key: 'ManagedBy', Value: 'compute-manager' },
      ],
    }],
  }));

  const instance = result.Instances[0];
  const instanceId = instance.InstanceId;

  // Wait for running state (up to 120s)
  await waitUntilInstanceRunning(
    { client, maxWaitTime: 120 },
    { InstanceIds: [instanceId] },
  );

  // Re-describe to get private IP
  const desc = await client.send(new DescribeInstancesCommand({
    InstanceIds: [instanceId],
  }));
  const privateIp = desc.Reservations[0].Instances[0].PrivateIpAddress;

  console.log(`[ec2] Provisioned ${instanceType} ${instanceId} at ${privateIp}, waiting for SSH...`);

  // Wait for SSH to be ready (instance running doesn't mean sshd is up)
  await waitForSSH(privateIp);

  console.log(`[ec2] SSH ready on ${privateIp}`);
  return { instanceId, privateIp };
}

/**
 * Wait for SSH to become available on a host.
 */
async function waitForSSH(host, timeoutMs = 120000) {
  const { execFile: execFileCb } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFile = promisify(execFileCb);
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      await execFile('ssh', [
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'ConnectTimeout=3',
        '-o', 'BatchMode=yes',
        '-i', SSH_KEY_PATH,
        `${SSH_USER}@${host}`,
        'echo', 'ready',
      ], { timeout: 10000 });
      return;
    } catch {
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  throw new Error(`SSH not ready on ${host} after ${timeoutMs}ms`);
}

/**
 * Terminate an EC2 instance.
 */
export async function terminateInstance(instanceId) {
  await client.send(new TerminateInstancesCommand({
    InstanceIds: [instanceId],
  }));
  console.log(`[ec2] Terminated ${instanceId}`);
}

/**
 * Get instance state.
 * @returns {Promise<{state: string, privateIp: string|null}>}
 */
export async function getInstanceStatus(instanceId) {
  const desc = await client.send(new DescribeInstancesCommand({
    InstanceIds: [instanceId],
  }));
  const inst = desc.Reservations?.[0]?.Instances?.[0];
  if (!inst) return { state: 'not-found', privateIp: null };
  return {
    state: inst.State.Name,
    privateIp: inst.PrivateIpAddress || null,
  };
}
