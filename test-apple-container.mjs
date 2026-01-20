/**
 * Test Claude CLI and SDK with Apple Container
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

  const info = await provider.getInfo();
  console.log('Apple Container version:', info.version);

  const id = generateSandboxId('apple-test');
  console.log('\nCreating sandbox:', id);

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

  // Check node version
  let result = await sandbox.exec('node', ['--version']);
  console.log('Node:', result.stdout.trim());

  // Install CLI
  console.log('\nInstalling Claude CLI...');
  await sandbox.exec('sh', ['-c', 'cd /workspace && npm init -y']);
  result = await sandbox.exec('sh', ['-c', 'cd /workspace && npm install @anthropic-ai/claude-code']);
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

  // Test CLI version
  result = await sandbox.exec('sh', ['-c', 'cd /workspace && ./node_modules/.bin/claude --version']);
  console.log('CLI version:', result.stdout.trim());

  // Test CLI API call
  console.log('\nTesting CLI API call...');
  const start = performance.now();
  result = await sandbox.exec('sh', ['-c', 'cd /workspace && ./node_modules/.bin/claude -p "Reply with exactly: WORKING" --max-turns 1 --output-format text --model sonnet < /dev/null 2>&1']);
  const duration = performance.now() - start;

  console.log('Exit code:', result.exitCode);
  console.log('Output:', result.stdout.trim());
  console.log('Success:', result.stdout.includes('WORKING'));
  console.log('Duration:', duration.toFixed(0), 'ms');

  // Install and test SDK
  console.log('\n--- Testing Agent SDK ---');
  result = await sandbox.exec('sh', ['-c', 'cd /workspace && npm install @anthropic-ai/claude-agent-sdk']);

  const testScript = `
const { query } = require('@anthropic-ai/claude-agent-sdk');

async function main() {
  console.log('Starting SDK test...');
  const start = Date.now();

  try {
    const q = query({
      prompt: 'Reply with exactly one word: WORKING',
      options: {
        model: 'claude-sonnet-4-20250514',
        maxTurns: 1,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        tools: [],
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

  await sandbox.exec('sh', ['-c', `cat > /workspace/sdk-test.js << 'ENDSCRIPT'
${testScript}
ENDSCRIPT`]);

  console.log('\nRunning SDK test...');
  result = await sandbox.exec('sh', ['-c', 'cd /workspace && node sdk-test.js 2>&1']);
  console.log('SDK Output:');
  console.log(result.stdout);

  await sandbox.stop();
  console.log('\nTest complete.');
}

test().catch(console.error);
