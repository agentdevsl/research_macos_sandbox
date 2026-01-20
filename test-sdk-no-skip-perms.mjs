/**
 * Test SDK without allowDangerouslySkipPermissions (since we're running as root)
 */
import { execSync } from 'node:child_process';
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

async function test() {
  const credentials = getKeychainCredentials();
  if (!credentials) {
    console.error('No credentials found');
    process.exit(1);
  }

  const provider = new AppleContainerProvider();

  if (!(await provider.isAvailable())) {
    console.error('Apple Container not available');
    process.exit(1);
  }

  const id = generateSandboxId('sdk-noskip');
  console.log('Creating sandbox:', id);

  const sandbox = await provider.create({
    id,
    image: 'node:22-slim',
    mountPath: '/tmp/sandboxes/' + id + '/workspace',
    memoryMib: 2048,
    cpus: 2,
    env: {
      HOME: '/root',
      CI: 'true',
      TERM: 'dumb',
    },
  });

  console.log('Startup:', sandbox.getMetrics().startupMs.toFixed(0), 'ms');

  // Install SDK
  console.log('\nInstalling SDK...');
  await sandbox.exec('sh', ['-c', 'cd /workspace && npm init -y']);
  let result = await sandbox.exec('sh', ['-c', 'cd /workspace && npm install @anthropic-ai/claude-agent-sdk']);
  if (result.exitCode !== 0) {
    console.error('Install failed:', result.stderr);
    await sandbox.stop();
    return;
  }

  // Write credentials
  console.log('Writing credentials...');
  await sandbox.exec('mkdir', ['-p', '/root/.claude']);
  const credsJson = JSON.stringify(credentials);
  await sandbox.exec('sh', ['-c', `printf '%s' '${credsJson.replace(/'/g, "'\\''")}' > /root/.claude/.credentials.json`]);

  // Test SDK with bypassPermissions but WITHOUT allowDangerouslySkipPermissions
  const testScript = `
const { query } = require('@anthropic-ai/claude-agent-sdk');

async function main() {
  console.log('Starting SDK test (bypassPermissions only)...');
  const start = Date.now();

  try {
    const q = query({
      prompt: 'Reply with exactly one word: WORKING',
      options: {
        model: 'claude-sonnet-4-20250514',
        maxTurns: 1,
        cwd: '/workspace',
        permissionMode: 'bypassPermissions',
        // DO NOT use allowDangerouslySkipPermissions when running as root
        stderr: (msg) => console.log('[STDERR]', msg),
      }
    });

    let response = '';
    for await (const msg of q) {
      console.log('Message type:', msg.type);
      if (msg.type === 'assistant' && msg.message && msg.message.content) {
        for (const b of msg.message.content) {
          if (b.type === 'text') response += b.text;
        }
      }
    }

    console.log('Response:', response);
    console.log('Success:', response.includes('WORKING'));
    console.log('Duration:', Date.now() - start, 'ms');
  } catch (e) {
    console.log('Error:', e.message);
  }
}

main();
`;

  await sandbox.exec('sh', ['-c', `cat > /workspace/test.js << 'ENDSCRIPT'
${testScript}
ENDSCRIPT`]);

  console.log('\n=== SDK Test (bypassPermissions only, no skip-perms) ===');
  result = await sandbox.exec('sh', ['-c', 'cd /workspace && timeout 120 node test.js 2>&1']);
  console.log('Exit code:', result.exitCode);
  console.log('Output:');
  console.log(result.stdout);

  await sandbox.stop();
  console.log('\nTest complete.');
}

test().catch(console.error);
