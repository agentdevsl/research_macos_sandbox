/**
 * Debug test for non-root user SDK
 */
import { execSync } from 'node:child_process';
import { BoxLiteProvider } from './packages/sandbox-boxlite/dist/index.js';
import { AppleContainerProvider } from './packages/sandbox-apple-container/dist/index.js';
import { generateSandboxId } from './packages/sandbox-core/dist/index.js';

// Extract credentials from macOS Keychain
function getKeychainCredentials() {
  try {
    const username = execSync('whoami', { encoding: 'utf-8' }).trim();
    const creds = execSync(
      `security find-generic-password -s "Claude Code-credentials" -a "${username}" -w`,
      { encoding: 'utf-8' }
    ).trim();
    return JSON.parse(creds);
  } catch (err) {
    return null;
  }
}

async function testBoxLite() {
  console.log('=== BoxLite Debug Test ===\n');

  const credentials = getKeychainCredentials();
  if (!credentials) {
    console.error('No credentials found');
    return;
  }

  const provider = new BoxLiteProvider();

  if (!(await provider.isAvailable())) {
    console.log('BoxLite not available');
    return;
  }

  const id = generateSandboxId('debug');
  console.log('Creating sandbox:', id);

  const sandbox = await provider.create({
    id,
    image: 'alpine:latest',
    mountPath: '/tmp/sandboxes/' + id + '/workspace',
    memoryMib: 2048,
    cpus: 2,
    env: {
      CI: 'true',
      TERM: 'dumb',
    },
    user: {
      name: 'sandbox',
      uid: 1000,
      gid: 1000,
    },
  });

  console.log('Startup:', sandbox.getMetrics().startupMs.toFixed(0), 'ms');

  // Install Node.js as root
  console.log('\n[1] Installing Node.js (as root)...');
  let result = await sandbox.execAsRoot('apk', ['add', '--no-cache', 'nodejs', 'npm']);
  console.log('Exit:', result.exitCode);

  // Check user
  console.log('\n[2] Check user...');
  result = await sandbox.exec('id');
  console.log('Exec result:', result);
  console.log('User:', result.stdout);

  // Check if we can run as root
  console.log('\n[3] Run as root to verify...');
  result = await sandbox.execAsRoot('id');
  console.log('Root user:', result.stdout);

  // Check workspace ownership
  console.log('\n[4] Check workspace...');
  result = await sandbox.exec('ls', ['-la', '/workspace']);
  console.log(result.stdout);

  // Initialize npm
  console.log('\n[5] Initialize npm...');
  result = await sandbox.exec('sh', ['-c', 'cd /workspace && npm init -y']);
  console.log('Exit:', result.exitCode);
  console.log('Output:', result.stdout);
  if (result.stderr) console.log('Stderr:', result.stderr);

  // Install SDK
  console.log('\n[6] Install SDK...');
  result = await sandbox.exec('sh', ['-c', 'cd /workspace && npm install @anthropic-ai/claude-agent-sdk']);
  console.log('Exit:', result.exitCode);
  console.log('Output (last 500):', result.stdout.slice(-500));
  if (result.stderr) console.log('Stderr:', result.stderr);

  // Check if module is installed
  console.log('\n[7] Check node_modules...');
  result = await sandbox.exec('ls', ['-la', '/workspace/node_modules/@anthropic-ai/']);
  console.log(result.stdout);

  // Test require
  console.log('\n[8] Test require...');
  result = await sandbox.exec('sh', ['-c', `cd /workspace && node -e "console.log(require('@anthropic-ai/claude-agent-sdk'))"`]);
  console.log('Exit:', result.exitCode);
  console.log('Output:', result.stdout.slice(0, 500));
  if (result.stderr) console.log('Stderr:', result.stderr.slice(0, 500));

  await sandbox.stop();
  console.log('\nDone.');
}

testBoxLite().catch(console.error);
