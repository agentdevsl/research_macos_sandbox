/**
 * Test Agent SDK with Debian-based image (like Automaker uses)
 */
import { execSync } from 'node:child_process';
import { BoxLiteProvider } from './packages/sandbox-boxlite/dist/index.js';
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

  const token = credentials.claudeAiOauth?.accessToken;

  const provider = new BoxLiteProvider();
  const id = generateSandboxId('sdk-debian');

  console.log('Creating sandbox with node:22-slim (Debian)...');
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
      ANTHROPIC_AUTH_TOKEN: token,
      PATH: '/usr/local/bin:/usr/bin:/bin',
      SHELL: '/bin/bash',
      USER: 'root',
      LANG: 'C.UTF-8',
    },
  });

  console.log('Startup:', sandbox.getMetrics().startupMs.toFixed(0), 'ms');

  let result = await sandbox.exec('node', ['--version']);
  console.log('Node:', result.stdout.trim());

  // Install packages locally in /workspace
  console.log('\nInstalling SDK and CLI in /workspace...');
  await sandbox.exec('sh', ['-c', 'cd /workspace && npm init -y']);
  result = await sandbox.exec('sh', ['-c', 'cd /workspace && npm install @anthropic-ai/claude-agent-sdk @anthropic-ai/claude-code']);
  if (result.exitCode !== 0) {
    console.error('Install failed:', result.stderr);
    await sandbox.stop();
    return;
  }
  console.log('Installed packages in /workspace');

  // Write credentials file
  console.log('Writing credentials...');
  await sandbox.exec('mkdir', ['-p', '/root/.claude']);
  const credsJson = JSON.stringify(credentials);
  await sandbox.exec('sh', ['-c', `printf '%s' '${credsJson.replace(/'/g, "'\\''")}' > /root/.claude/.credentials.json`]);

  // Create test script in sandbox
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

  await sandbox.exec('sh', ['-c', `cat > /workspace/test.js << 'ENDSCRIPT'
${testScript}
ENDSCRIPT`]);

  console.log('\nRunning SDK test from /workspace...');
  result = await sandbox.exec('sh', ['-c', 'cd /workspace && node test.js']);
  console.log('\nOutput:');
  console.log(result.stdout);
  if (result.stderr) console.log('Stderr:', result.stderr);

  await sandbox.stop();
}

test().catch(console.error);
