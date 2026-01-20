/**
 * Test SDK with non-root user - following Automaker pattern
 */
import { execSync } from 'node:child_process';
import { BoxLiteProvider } from './packages/sandbox-boxlite/dist/index.js';
import { generateSandboxId } from './packages/sandbox-core/dist/index.js';

// Get OAuth token - from env or keychain
function getOAuthToken() {
  // Check env first
  if (process.env.OAUTH_TOKEN) {
    return process.env.OAUTH_TOKEN;
  }

  // Try keychain
  try {
    const username = execSync('whoami', { encoding: 'utf-8' }).trim();
    const creds = execSync(
      `security find-generic-password -s "Claude Code-credentials" -a "${username}" -w`,
      { encoding: 'utf-8' }
    ).trim();
    return JSON.parse(creds).claudeAiOauth?.accessToken;
  } catch (err) {
    return null;
  }
}

async function main() {
  console.log('=== SDK Test: Non-Root with Automaker Pattern ===\n');

  const token = getOAuthToken();
  if (!token) {
    console.error('No OAuth token found. Set OAUTH_TOKEN env var.');
    return;
  }
  console.log('OAuth token:', token.slice(0, 25) + '...');

  // Create credentials object for file
  const credentials = {
    claudeAiOauth: {
      accessToken: token,
    }
  };

  const provider = new BoxLiteProvider();
  const id = generateSandboxId('nonroot2');
  console.log('Creating sandbox:', id);

  const userHome = '/home/sandbox';

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
    user: { name: 'sandbox', uid: 1000, gid: 1000 },
  });

  console.log('Startup:', sandbox.getMetrics().startupMs.toFixed(0), 'ms');

  // Install Node.js as root
  await sandbox.execAsRoot('apk', ['add', '--no-cache', 'nodejs', 'npm']);

  // Verify user
  let result = await sandbox.exec('id');
  console.log('User:', result.stdout);

  // Initialize npm and install SDK
  await sandbox.exec('sh', ['-c', 'cd /workspace && npm init -y']);
  result = await sandbox.exec('sh', ['-c', 'cd /workspace && npm install @anthropic-ai/claude-agent-sdk']);
  console.log('SDK installed:', result.exitCode === 0 ? 'yes' : 'no');

  // Write credentials to user's .claude directory (as the sandbox user)
  console.log('Writing credentials to', userHome);
  const credsJson = JSON.stringify(credentials);
  await sandbox.exec('sh', ['-c', `mkdir -p ${userHome}/.claude`]);
  await sandbox.exec('sh', ['-c', `printf '%s' '${credsJson.replace(/'/g, "'\\''")}' > ${userHome}/.claude/.credentials.json`]);
  await sandbox.exec('sh', ['-c', `chmod 600 ${userHome}/.claude/.credentials.json`]);

  // Verify credentials file
  result = await sandbox.exec('cat', [`${userHome}/.claude/.credentials.json`]);
  console.log('Credentials written:', result.stdout.length > 0 ? `${result.stdout.length} bytes` : 'EMPTY!');

  // Create test script
  const testScript = `
const { query } = require('@anthropic-ai/claude-agent-sdk');

async function test() {
  console.log('UID:', process.getuid());
  console.log('HOME:', process.env.HOME);
  console.log('ANTHROPIC_AUTH_TOKEN set:', !!process.env.ANTHROPIC_AUTH_TOKEN);
  console.log('Credentials file exists:', require('fs').existsSync(process.env.HOME + '/.claude/.credentials.json'));

  const start = Date.now();
  try {
    const sdkOptions = {
      model: 'claude-sonnet-4-20250514',
      maxTurns: 1,
      cwd: '/workspace',
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    };

    console.log('Starting SDK query with bypassPermissions...');

    const q = query({
      prompt: 'Reply with exactly one word: SUCCESS',
      options: sdkOptions
    });

    let response = '';
    for await (const msg of q) {
      console.log('Message:', msg.type);
      if (msg.type === 'assistant' && msg.message && msg.message.content) {
        for (const b of msg.message.content) {
          if (b.type === 'text') {
            console.log('Text:', b.text);
            response += b.text;
          }
        }
      }
      if (msg.type === 'result') {
        console.log('Result:', JSON.stringify(msg).slice(0, 300));
      }
    }

    console.log('Response:', response);
    console.log('Success:', response.includes('SUCCESS'));
    console.log('Duration:', Date.now() - start, 'ms');
    process.exit(response.includes('SUCCESS') ? 0 : 1);
  } catch (e) {
    console.log('Error:', e.message);
    process.exit(1);
  }
}

test();
`;

  await sandbox.exec('sh', ['-c', `cat > /workspace/test.js << 'ENDSCRIPT'
${testScript}
ENDSCRIPT`]);

  console.log('\n=== Running SDK test ===');
  // Use ANTHROPIC_AUTH_TOKEN like Automaker does
  result = await sandbox.exec('sh', ['-c', `cd /workspace && HOME=${userHome} ANTHROPIC_AUTH_TOKEN="${token}" timeout 90 node test.js 2>&1`]);
  console.log('Exit code:', result.exitCode);
  console.log('Output:');
  console.log(result.stdout);
  if (result.stderr) console.log('Stderr:', result.stderr);

  const success = result.exitCode === 0 && result.stdout.includes('SUCCESS');
  console.log(`\nResult: ${success ? '✅ SUCCESS' : '❌ FAILED'}`);

  await sandbox.stop();
}

main().catch(console.error);
