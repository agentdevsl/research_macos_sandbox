/**
 * Test SDK with OrbStack provider (Docker container)
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { OrbStackProvider } from './packages/sandbox-orbstack/dist/index.js';
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
  console.log('=== SDK Test with OrbStack ===\n');
  console.log('Token:', authToken.slice(0, 25) + '...');

  // Check if OrbStack/Docker is available
  const provider = new OrbStackProvider();
  const available = await provider.isAvailable();
  if (!available) {
    console.error('OrbStack/Docker not available');
    process.exit(1);
  }

  const info = await provider.getInfo();
  console.log('Provider:', info.name, info.version);

  // Create credentials in Claude Code format
  const credentials = {
    claudeAiOauth: {
      accessToken: authToken,
      refreshToken: '',
      expiresAt: Date.now() + 86400000,
      scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
      subscriptionType: 'max',
    }
  };

  const id = generateSandboxId('orbstack');
  console.log('\nCreating sandbox:', id);

  const mountPath = `/tmp/sandboxes/${id}/workspace`;
  mkdirSync(mountPath, { recursive: true });

  const userHome = '/home/sandbox';

  const sandbox = await provider.create({
    id,
    image: 'alpine:latest',
    mountPath,
    memoryMib: 2048,
    cpus: 2,
    env: { CI: 'true', TERM: 'dumb' },
    user: { name: 'sandbox', uid: 1000, gid: 1000 },
  });

  console.log('Startup:', sandbox.getMetrics().startupMs.toFixed(0), 'ms');

  // Install Node.js as root
  console.log('\nInstalling Node.js...');
  await sandbox.execAsRoot('apk', ['add', '--no-cache', 'nodejs', 'npm']);

  // Verify user
  let result = await sandbox.exec('id');
  console.log('User:', result.stdout);

  // Install SDK
  await sandbox.exec('sh', ['-c', 'cd /workspace && npm init -y 2>/dev/null']);
  await sandbox.exec('sh', ['-c', 'cd /workspace && npm install @anthropic-ai/claude-agent-sdk 2>/dev/null']);
  console.log('SDK installed');

  // Write credentials file using heredoc
  const credsJson = JSON.stringify(credentials);
  await sandbox.exec('sh', ['-c', `mkdir -p ${userHome}/.claude`]);
  const writeCmd = `cat > ${userHome}/.claude/.credentials.json << 'CREDS_EOF'
${credsJson}
CREDS_EOF`;
  await sandbox.exec('sh', ['-c', writeCmd]);
  await sandbox.exec('sh', ['-c', `chmod 600 ${userHome}/.claude/.credentials.json`]);

  result = await sandbox.exec('cat', [`${userHome}/.claude/.credentials.json`]);
  console.log('Credentials file written:', result.stdout.length, 'bytes');

  // Test script
  const testScript = `
const { query } = require('@anthropic-ai/claude-agent-sdk');
const fs = require('fs');

async function test() {
  console.log('UID:', process.getuid());
  console.log('HOME:', process.env.HOME);

  const credsPath = process.env.HOME + '/.claude/.credentials.json';
  if (fs.existsSync(credsPath)) {
    const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
    console.log('Credentials file found with keys:', Object.keys(creds));
  } else {
    console.log('Credentials file NOT FOUND');
    process.exit(1);
  }

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

  console.log('\n=== Running SDK (OrbStack) ===');
  result = await sandbox.exec('sh', ['-c', `cd /workspace && HOME=${userHome} timeout 120 node test.js 2>&1`]);
  console.log('Exit:', result.exitCode);
  console.log(result.stdout);

  const success = result.exitCode === 0 && result.stdout.includes('SUCCESS');
  console.log(`\nResult: ${success ? '✅ SUCCESS' : '❌ FAILED'}`);

  await sandbox.stop();
}

main().catch(console.error);
