/**
 * Debug credentials path in sandbox
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

async function main() {
  console.log('=== Credentials Debug ===\n');

  const credentials = getKeychainCredentials();
  if (!credentials) {
    console.error('No credentials found');
    return;
  }
  console.log('Credentials keys:', Object.keys(credentials));

  const provider = new BoxLiteProvider();
  const id = generateSandboxId('credsdbg');
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

  // Install Node.js
  await sandbox.execAsRoot('apk', ['add', '--no-cache', 'nodejs', 'npm']);

  // Check user
  let result = await sandbox.exec('id');
  console.log('User:', result.stdout);

  // Install SDK
  result = await sandbox.exec('sh', ['-c', 'cd /workspace && npm init -y && npm install @anthropic-ai/claude-agent-sdk']);
  console.log('SDK installed:', result.exitCode === 0 ? 'yes' : 'no');

  // Write credentials
  const credsJson = JSON.stringify(credentials);
  const userHome = '/home/sandbox';
  await sandbox.exec('sh', ['-c', `mkdir -p ${userHome}/.claude && printf '%s' '${credsJson.replace(/'/g, "'\\''")}' > ${userHome}/.claude/.credentials.json && chmod 600 ${userHome}/.claude/.credentials.json`]);

  // Check what we wrote
  result = await sandbox.exec('cat', [`${userHome}/.claude/.credentials.json`]);
  console.log('\nCredentials file content:');
  console.log(result.stdout);

  // Check the SDK's cli.js for credential paths
  result = await sandbox.exec('sh', ['-c', 'cat /workspace/node_modules/@anthropic-ai/claude-agent-sdk/cli.js 2>/dev/null | head -200 | grep -i "credential\\|auth\\|\\.claude\\|api.key" -i']);
  console.log('\nSDK cli.js credential references:');
  console.log(result.stdout || '(none found)');

  // Try running claude directly to see what paths it checks
  result = await sandbox.exec('sh', ['-c', `cd /workspace && HOME=${userHome} node node_modules/@anthropic-ai/claude-agent-sdk/cli.js --help 2>&1 | head -50`]);
  console.log('\nCLI help:');
  console.log(result.stdout);

  // Try with ANTHROPIC_API_KEY env var instead
  console.log('\n=== Try with ANTHROPIC_API_KEY env var ===');
  const testScript = `
const { query } = require('@anthropic-ai/claude-agent-sdk');
async function main() {
  console.log('HOME:', process.env.HOME);
  console.log('ANTHROPIC_API_KEY set:', !!process.env.ANTHROPIC_API_KEY);
  console.log('Trying query...');
  try {
    const q = query({
      prompt: 'Reply with exactly: SUCCESS',
      options: {
        model: 'claude-sonnet-4-20250514',
        maxTurns: 1,
        cwd: '/workspace',
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      }
    });
    for await (const msg of q) {
      console.log('Message:', msg.type, msg.type === 'result' ? JSON.stringify(msg).slice(0, 300) : '');
    }
  } catch (e) {
    console.log('Error:', e.message);
  }
}
main();
`;
  await sandbox.exec('sh', ['-c', `cat > /workspace/test.js << 'EOF'
${testScript}
EOF`]);

  // Get oauthAccessToken from credentials if available
  const apiKey = credentials.claudeAiOauth?.accessToken || credentials.oauthAccessToken || credentials.apiKey;
  if (apiKey) {
    console.log('Using OAuth access token...');
    result = await sandbox.exec('sh', ['-c', `cd /workspace && HOME=${userHome} ANTHROPIC_API_KEY="${apiKey}" timeout 60 node test.js 2>&1`]);
    console.log('Result:', result.stdout);
    if (result.stderr) console.log('Stderr:', result.stderr);
  } else {
    console.log('No API key found in credentials');
  }

  await sandbox.stop();
}

main().catch(console.error);
