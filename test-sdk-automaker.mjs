/**
 * Test Agent SDK with Automaker-style options
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
    console.error('Failed to extract credentials from Keychain:', err.message);
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
  console.log('OAuth token:', token.slice(0, 25) + '...');

  const provider = new BoxLiteProvider();
  const id = generateSandboxId('sdk-automaker');

  const sandbox = await provider.create({
    id,
    image: 'alpine:latest',
    mountPath: '/tmp/sandboxes/' + id + '/workspace',
    memoryMib: 2048,
    cpus: 2,
    env: {
      HOME: '/root',
      CI: 'true',
      TERM: 'dumb',
      ANTHROPIC_AUTH_TOKEN: token,
    },
  });

  console.log('Sandbox created:', id);
  console.log('Startup:', sandbox.getMetrics().startupMs.toFixed(0), 'ms');

  // Install dependencies
  console.log('\nInstalling Node.js...');
  await sandbox.exec('apk', ['add', '--no-cache', 'nodejs', 'npm']);

  console.log('Installing SDK...');
  await sandbox.npmInstall('@anthropic-ai/claude-agent-sdk');

  console.log('Installing CLI...');
  await sandbox.npmInstall('@anthropic-ai/claude-code', true);

  // Write credentials file
  console.log('Writing credentials...');
  await sandbox.exec('mkdir', ['-p', '/root/.claude']);
  const credsJson = JSON.stringify(credentials);
  await sandbox.exec('sh', ['-c', `printf '%s' '${credsJson.replace(/'/g, "'\\''")}' > /root/.claude/.credentials.json`]);

  // Create test script
  const testScript = `
const { query } = require('@anthropic-ai/claude-agent-sdk');

async function test() {
  const start = Date.now();
  try {
    // Automaker-style options
    const sdkOptions = {
      model: 'claude-sonnet-4-20250514',
      maxTurns: 1,
      cwd: '/workspace',
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      tools: [],
    };

    console.log('Starting SDK query...');

    const q = query({
      prompt: 'Reply with exactly one word: WORKING',
      options: sdkOptions
    });

    let response = '';
    for await (const msg of q) {
      console.log('Message:', msg.type);
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

test();
`;

  // Write test script
  await sandbox.exec('sh', ['-c', `cat > /workspace/test.js << 'ENDSCRIPT'
${testScript}
ENDSCRIPT`]);

  console.log('\nRunning SDK test...');
  const result = await sandbox.execWithNpmPath('cd /workspace && node test.js 2>&1');
  console.log('Output:');
  console.log(result.stdout);

  await sandbox.stop();
}

test().catch(console.error);
