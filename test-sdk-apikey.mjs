/**
 * Test SDK with ANTHROPIC_API_KEY env var
 */
import { execSync } from 'node:child_process';
import { BoxLiteProvider } from './packages/sandbox-boxlite/dist/index.js';
import { generateSandboxId } from './packages/sandbox-core/dist/index.js';

// Extract OAuth access token from macOS Keychain
function getOAuthToken() {
  try {
    const username = execSync('whoami', { encoding: 'utf-8' }).trim();
    const creds = execSync(
      `security find-generic-password -s "Claude Code-credentials" -a "${username}" -w`,
      { encoding: 'utf-8' }
    ).trim();
    const data = JSON.parse(creds);
    return data.claudeAiOauth?.accessToken;
  } catch (err) {
    return null;
  }
}

async function main() {
  console.log('=== SDK Test with ANTHROPIC_API_KEY ===\n');

  const apiKey = getOAuthToken();
  if (!apiKey) {
    console.error('No OAuth token found');
    return;
  }
  console.log('Got OAuth token:', apiKey.slice(0, 20) + '...');

  const provider = new BoxLiteProvider();
  const id = generateSandboxId('apikey');
  console.log('Creating sandbox:', id);

  const sandbox = await provider.create({
    id,
    image: 'alpine:latest',
    mountPath: '/tmp/sandboxes/' + id + '/workspace',
    memoryMib: 2048,
    cpus: 2,
    env: { CI: 'true', TERM: 'dumb' },
    user: { name: 'sandbox', uid: 1000, gid: 1000 },
  });

  console.log('Startup:', sandbox.getMetrics().startupMs.toFixed(0), 'ms');

  // Install Node.js
  await sandbox.execAsRoot('apk', ['add', '--no-cache', 'nodejs', 'npm']);

  // Check user
  let result = await sandbox.exec('id');
  console.log('User:', result.stdout);

  // Install SDK
  await sandbox.exec('sh', ['-c', 'cd /workspace && npm init -y']);
  result = await sandbox.exec('sh', ['-c', 'cd /workspace && npm install @anthropic-ai/claude-agent-sdk']);
  console.log('SDK installed:', result.exitCode === 0 ? 'yes' : 'no');

  // Create test script with API key passed via env
  const testScript = `
const { query } = require('@anthropic-ai/claude-agent-sdk');
async function main() {
  console.log('UID:', process.getuid());
  console.log('HOME:', process.env.HOME);
  console.log('API_KEY set:', !!process.env.ANTHROPIC_API_KEY);
  console.log('Starting query with bypassPermissions...');
  const start = Date.now();
  try {
    const q = query({
      prompt: 'Reply with exactly one word: SUCCESS',
      options: {
        model: 'claude-sonnet-4-20250514',
        maxTurns: 1,
        cwd: '/workspace',
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      }
    });
    let response = '';
    for await (const msg of q) {
      console.log('MSG:', msg.type);
      if (msg.type === 'assistant' && msg.message?.content) {
        for (const b of msg.message.content) {
          if (b.type === 'text') {
            console.log('TEXT:', b.text);
            response += b.text;
          }
        }
      }
      if (msg.type === 'result') {
        console.log('RESULT:', JSON.stringify(msg).slice(0, 400));
      }
    }
    console.log('Response:', response);
    console.log('Duration:', Date.now() - start, 'ms');
    console.log('Success:', response.includes('SUCCESS'));
    process.exit(response.includes('SUCCESS') ? 0 : 1);
  } catch (e) {
    console.log('Error:', e.message);
    process.exit(1);
  }
}
main();
`;

  await sandbox.exec('sh', ['-c', `cat > /workspace/test.js << 'ENDSCRIPT'
${testScript}
ENDSCRIPT`]);

  console.log('\n=== Running SDK with ANTHROPIC_API_KEY ===');
  // Pass API key via environment variable
  result = await sandbox.exec('sh', ['-c', `cd /workspace && HOME=/home/sandbox ANTHROPIC_API_KEY="${apiKey}" timeout 90 node test.js 2>&1`]);
  console.log('Exit code:', result.exitCode);
  console.log('Output:');
  console.log(result.stdout);
  if (result.stderr) console.log('Stderr:', result.stderr);

  const success = result.exitCode === 0 && result.stdout.includes('SUCCESS');
  console.log(`\nResult: ${success ? '✅ SUCCESS' : '❌ FAILED'}`);

  await sandbox.stop();
}

main().catch(console.error);
