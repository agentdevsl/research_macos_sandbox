/**
 * Diagnostic test to understand SDK CLI spawning behavior
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

  const id = generateSandboxId('sdk-diag');
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

  // Check node version
  let result = await sandbox.exec('node', ['--version']);
  console.log('Node:', result.stdout.trim());

  // Install CLI
  console.log('\nInstalling Claude CLI...');
  await sandbox.exec('sh', ['-c', 'cd /workspace && npm init -y']);
  result = await sandbox.exec('sh', ['-c', 'cd /workspace && npm install @anthropic-ai/claude-code @anthropic-ai/claude-agent-sdk']);
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

  // Diagnostic: Check Claude CLI location and PATH
  console.log('\n=== Diagnostic Info ===');

  result = await sandbox.exec('sh', ['-c', 'which claude || echo "claude not in PATH"']);
  console.log('which claude:', result.stdout.trim());

  result = await sandbox.exec('sh', ['-c', 'ls -la /workspace/node_modules/.bin/claude']);
  console.log('local claude:', result.stdout.trim());

  result = await sandbox.exec('sh', ['-c', 'echo $PATH']);
  console.log('PATH:', result.stdout.trim());

  // Test CLI directly with explicit path
  console.log('\n=== Direct CLI Test ===');
  result = await sandbox.exec('sh', ['-c', 'cd /workspace && ./node_modules/.bin/claude --version']);
  console.log('CLI version:', result.stdout.trim());

  // Test CLI API call
  console.log('\n=== CLI API Call Test ===');
  const start = performance.now();
  result = await sandbox.exec('sh', ['-c', 'cd /workspace && ./node_modules/.bin/claude -p "Reply with: WORKING" --max-turns 1 --output-format text --model sonnet < /dev/null 2>&1']);
  console.log('CLI output:', result.stdout.trim().slice(0, 100));
  console.log('CLI success:', result.exitCode === 0 && result.stdout.includes('WORKING'));
  console.log('CLI duration:', (performance.now() - start).toFixed(0), 'ms');

  // Diagnostic SDK test with more info
  const testScript = `
const { query } = require('@anthropic-ai/claude-agent-sdk');
const { spawn } = require('child_process');

async function main() {
  console.log('=== SDK Diagnostic ===');
  console.log('CWD:', process.cwd());
  console.log('HOME:', process.env.HOME);
  console.log('PATH:', process.env.PATH);
  console.log('CI:', process.env.CI);
  console.log('TERM:', process.env.TERM);

  // Check if claude is accessible
  const { execSync } = require('child_process');
  try {
    const version = execSync('./node_modules/.bin/claude --version', { encoding: 'utf-8' });
    console.log('Claude version (from cwd):', version.trim());
  } catch (e) {
    console.log('Error checking claude version:', e.message);
  }

  console.log('\\n=== Starting SDK query ===');
  const start = Date.now();

  try {
    const q = query({
      prompt: 'Reply with exactly one word: WORKING',
      options: {
        model: 'claude-sonnet-4-20250514',
        maxTurns: 1,
        cwd: '/workspace',
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        tools: [],
      }
    });

    let response = '';
    for await (const msg of q) {
      console.log('Message:', JSON.stringify(msg).slice(0, 200));
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
    console.log('Stack:', e.stack);
  }
}

main();
`;

  await sandbox.exec('sh', ['-c', `cat > /workspace/sdk-diagnostic.js << 'ENDSCRIPT'
${testScript}
ENDSCRIPT`]);

  console.log('\n=== SDK Test ===');
  result = await sandbox.exec('sh', ['-c', 'cd /workspace && node sdk-diagnostic.js 2>&1'], { timeout: 60000 });
  console.log(result.stdout);
  if (result.stderr) console.log('Stderr:', result.stderr);

  await sandbox.stop();
  console.log('\nTest complete.');
}

test().catch(console.error);
