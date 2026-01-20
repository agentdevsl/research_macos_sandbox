/**
 * Test SDK with .credentials.json file (like Automaker does)
 */
import { readFileSync } from 'node:fs';
import { BoxLiteProvider } from './packages/sandbox-boxlite/dist/index.js';
import { generateSandboxId } from './packages/sandbox-core/dist/index.js';

// Load .env
function loadEnv() {
  try {
    const content = readFileSync('.env', 'utf-8');
    for (const line of content.split('\n')) {
      if (line.startsWith('#') || !line.includes('=')) continue;
      const [key, ...valueParts] = line.split('=');
      const value = valueParts.join('=').trim();
      if (key && value) process.env[key.trim()] = value;
    }
  } catch {}
}

loadEnv();

const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
if (!authToken) {
  console.error('ANTHROPIC_AUTH_TOKEN not set in .env');
  process.exit(1);
}

async function main() {
  console.log('=== SDK Test with .credentials.json ===\n');
  console.log('Token:', authToken.slice(0, 25) + '...');

  // Create credentials object in Claude Code format
  const credentials = {
    claudeAiOauth: {
      accessToken: authToken,
      refreshToken: '',
      expiresAt: Date.now() + 86400000, // 24h from now
      scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
      subscriptionType: 'max',
    }
  };

  console.log('Credentials format: claudeAiOauth');

  const provider = new BoxLiteProvider();
  const id = generateSandboxId('credsfile');
  const userHome = '/home/sandbox';

  const sandbox = await provider.create({
    id,
    image: 'alpine:latest',
    mountPath: '/tmp/sandboxes/' + id + '/workspace',
    memoryMib: 2048,
    cpus: 2,
    env: { CI: 'true', TERM: 'dumb' },
    user: { name: 'sandbox', uid: 1000, gid: 1000 },
  });

  console.log('Sandbox created, startup:', sandbox.getMetrics().startupMs.toFixed(0), 'ms');

  // Install Node.js
  await sandbox.execAsRoot('apk', ['add', '--no-cache', 'nodejs', 'npm']);

  // Verify user
  let result = await sandbox.exec('id');
  console.log('User:', result.stdout);

  // Install SDK
  await sandbox.exec('sh', ['-c', 'cd /workspace && npm init -y']);
  await sandbox.exec('sh', ['-c', 'cd /workspace && npm install @anthropic-ai/claude-agent-sdk']);

  // Write credentials file using heredoc (most reliable for JSON)
  const credsJson = JSON.stringify(credentials);

  await sandbox.exec('sh', ['-c', `mkdir -p ${userHome}/.claude`]);

  // Use heredoc to avoid shell escaping issues with JSON
  const writeCmd = `cat > ${userHome}/.claude/.credentials.json << 'CREDS_EOF'
${credsJson}
CREDS_EOF`;
  const writeResult = await sandbox.exec('sh', ['-c', writeCmd]);
  console.log('Write result:', writeResult.exitCode, writeResult.stderr || '(no error)');

  await sandbox.exec('sh', ['-c', `chmod 600 ${userHome}/.claude/.credentials.json`]);

  // Verify file
  result = await sandbox.exec('cat', [`${userHome}/.claude/.credentials.json`]);
  console.log('Credentials file written:', result.stdout.length, 'bytes');

  // Test script - NO env vars, just HOME pointing to .claude directory
  const testScript = `
const { query } = require('@anthropic-ai/claude-agent-sdk');
const fs = require('fs');

async function test() {
  console.log('UID:', process.getuid());
  console.log('HOME:', process.env.HOME);

  // Check credentials file
  const credsPath = process.env.HOME + '/.claude/.credentials.json';
  if (fs.existsSync(credsPath)) {
    const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
    console.log('Credentials file found with keys:', Object.keys(creds));
    if (creds.claudeAiOauth) {
      console.log('OAuth token:', creds.claudeAiOauth.accessToken.slice(0, 20) + '...');
    }
  } else {
    console.log('Credentials file NOT FOUND');
  }

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
    console.log('Success:', response.includes('SUCCESS'));
    process.exit(response.includes('SUCCESS') ? 0 : 1);
  } catch (e) {
    console.log('Error:', e.message);
    process.exit(1);
  }
}
test();
`;

  await sandbox.exec('sh', ['-c', `cat > /workspace/test.js << 'EOF'
${testScript}
EOF`]);

  console.log('\n=== Running SDK (credentials via file only) ===');
  // Only HOME - no ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN
  result = await sandbox.exec('sh', ['-c', `cd /workspace && HOME=${userHome} timeout 120 node test.js 2>&1`]);
  console.log('Exit:', result.exitCode);
  console.log(result.stdout);

  const success = result.exitCode === 0 && result.stdout.includes('SUCCESS');
  console.log(`\nResult: ${success ? '✅ SUCCESS' : '❌ FAILED'}`);

  await sandbox.stop();
}

main().catch(console.error);
