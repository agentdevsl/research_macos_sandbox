/**
 * Test SDK using credentials file (like after claude login)
 * No env vars - let the CLI find ~/.claude/.credentials.json
 */
import { execSync } from 'node:child_process';
import { BoxLiteProvider } from './packages/sandbox-boxlite/dist/index.js';
import { generateSandboxId } from './packages/sandbox-core/dist/index.js';

// Get full credentials from macOS Keychain (same format as claude login creates)
function getCredentials() {
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

async function main() {
  console.log('=== SDK Test with Credentials File ===\n');

  const credentials = getCredentials();
  if (!credentials) {
    console.error('No credentials found in Keychain');
    console.error('Run "claude login" first to authenticate');
    return;
  }

  console.log('Credentials keys:', Object.keys(credentials));
  if (credentials.claudeAiOauth) {
    console.log('OAuth token:', credentials.claudeAiOauth.accessToken?.slice(0, 25) + '...');
    console.log('Subscription:', credentials.claudeAiOauth.subscriptionType);
  }

  const provider = new BoxLiteProvider();
  const id = generateSandboxId('credsfile');
  console.log('\nCreating sandbox:', id);

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

  // Install SDK
  await sandbox.exec('sh', ['-c', 'cd /workspace && npm init -y']);
  result = await sandbox.exec('sh', ['-c', 'cd /workspace && npm install @anthropic-ai/claude-agent-sdk']);
  console.log('SDK installed:', result.exitCode === 0 ? 'yes' : 'no');

  // Write FULL credentials file (exactly as claude login would)
  console.log('\nWriting credentials file to', userHome + '/.claude/.credentials.json');
  const credsJson = JSON.stringify(credentials);

  await sandbox.exec('sh', ['-c', `mkdir -p ${userHome}/.claude`]);

  // Use heredoc to avoid shell escaping issues with JSON
  const writeCmd = `cat > ${userHome}/.claude/.credentials.json << 'CREDS_EOF'
${credsJson}
CREDS_EOF`;
  await sandbox.exec('sh', ['-c', writeCmd]);
  await sandbox.exec('sh', ['-c', `chmod 600 ${userHome}/.claude/.credentials.json`]);

  // Verify credentials file
  result = await sandbox.exec('sh', ['-c', `cat ${userHome}/.claude/.credentials.json | head -c 100`]);
  console.log('Credentials file preview:', result.stdout + '...');

  // Create test script - NO auth env vars, let CLI use credentials file
  const testScript = `
const { query } = require('@anthropic-ai/claude-agent-sdk');

async function test() {
  console.log('UID:', process.getuid());
  console.log('HOME:', process.env.HOME);
  console.log('ANTHROPIC_API_KEY:', process.env.ANTHROPIC_API_KEY ? 'set' : 'unset');
  console.log('ANTHROPIC_AUTH_TOKEN:', process.env.ANTHROPIC_AUTH_TOKEN ? 'set' : 'unset');

  // Check if credentials file exists
  const fs = require('fs');
  const credsPath = process.env.HOME + '/.claude/.credentials.json';
  console.log('Credentials file exists:', fs.existsSync(credsPath));
  if (fs.existsSync(credsPath)) {
    const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
    console.log('Credentials keys:', Object.keys(creds));
  }

  const start = Date.now();
  try {
    const sdkOptions = {
      model: 'claude-sonnet-4-20250514',
      maxTurns: 1,
      cwd: '/workspace',
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    };

    console.log('\\nStarting SDK query with bypassPermissions...');

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
        console.log('Result:', JSON.stringify(msg).slice(0, 500));
      }
    }

    console.log('\\nFinal Response:', response);
    console.log('Success:', response.includes('SUCCESS'));
    console.log('Duration:', Date.now() - start, 'ms');
    process.exit(response.includes('SUCCESS') ? 0 : 1);
  } catch (e) {
    console.log('Error:', e.message);
    console.log('Stack:', e.stack?.slice(0, 300));
    process.exit(1);
  }
}

test();
`;

  await sandbox.exec('sh', ['-c', `cat > /workspace/test.js << 'ENDSCRIPT'
${testScript}
ENDSCRIPT`]);

  console.log('\n=== Running SDK test (no auth env vars) ===');
  // Only set HOME - no ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN
  result = await sandbox.exec('sh', ['-c', `cd /workspace && HOME=${userHome} timeout 120 node test.js 2>&1`]);
  console.log('Exit code:', result.exitCode);
  console.log('Output:');
  console.log(result.stdout);
  if (result.stderr) console.log('Stderr:', result.stderr);

  const success = result.exitCode === 0 && result.stdout.includes('SUCCESS');
  console.log(`\nResult: ${success ? '✅ SUCCESS' : '❌ FAILED'}`);

  await sandbox.stop();
}

main().catch(console.error);
