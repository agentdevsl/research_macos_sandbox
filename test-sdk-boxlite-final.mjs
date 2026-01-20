/**
 * Final SDK test in BoxLite with correct options
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

  const provider = new BoxLiteProvider();

  if (!(await provider.isAvailable())) {
    console.error('BoxLite not available');
    process.exit(1);
  }

  const id = generateSandboxId('sdk-final');
  console.log('Creating BoxLite sandbox:', id);

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
    },
  });

  console.log('Startup:', sandbox.getMetrics().startupMs.toFixed(0), 'ms');

  // Install Node.js
  console.log('\nInstalling Node.js...');
  await sandbox.exec('apk', ['add', '--no-cache', 'nodejs', 'npm']);

  // Install SDK
  console.log('Installing SDK...');
  await sandbox.npmInstall('@anthropic-ai/claude-agent-sdk');
  await sandbox.npmInstall('@anthropic-ai/claude-code', true);

  // Write credentials
  console.log('Writing credentials...');
  await sandbox.exec('mkdir', ['-p', '/root/.claude']);
  const credsJson = JSON.stringify(credentials);
  await sandbox.exec('sh', ['-c', `printf '%s' '${credsJson.replace(/'/g, "'\\''")}' > /root/.claude/.credentials.json`]);

  // Test CLI
  console.log('\n=== CLI Test ===');
  let start = performance.now();
  let result = await sandbox.execWithNpmPath(
    'timeout 60 claude -p "Reply with exactly: CLI_WORKING" --max-turns 1 --output-format text --model sonnet < /dev/null 2>&1'
  );
  console.log('CLI Exit code:', result.exitCode);
  console.log('CLI Output:', result.stdout.trim().slice(0, 100));
  console.log('CLI Success:', result.stdout.includes('CLI_WORKING'));
  console.log('CLI Duration:', (performance.now() - start).toFixed(0), 'ms');

  // Test SDK with default permissions
  const testScript = `
const { query } = require('@anthropic-ai/claude-agent-sdk');

async function main() {
  console.log('Starting SDK test...');
  const start = Date.now();

  try {
    const q = query({
      prompt: 'Reply with exactly one word: SDK_WORKING. Do not use any tools.',
      options: {
        model: 'claude-sonnet-4-20250514',
        maxTurns: 1,
        cwd: '/workspace',
        // Use default permissions - bypassPermissions fails as root
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
    console.log('Success:', response.includes('SDK_WORKING'));
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

  console.log('\n=== SDK Test ===');
  result = await sandbox.execWithNpmPath('cd /workspace && timeout 120 node sdk-test.js 2>&1');
  console.log('SDK Output:');
  console.log(result.stdout);

  await sandbox.stop();
  console.log('\nTest complete!');
}

test().catch(console.error);
