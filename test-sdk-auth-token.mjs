/**
 * Test SDK with ANTHROPIC_AUTH_TOKEN (like Automaker does)
 */
import { readFileSync } from 'node:fs';
import { BoxLiteProvider } from './packages/sandbox-boxlite/dist/index.js';
import { generateSandboxId } from './packages/sandbox-core/dist/index.js';

// Load .env file
function loadEnv() {
  try {
    const content = readFileSync('.env', 'utf-8');
    for (const line of content.split('\n')) {
      if (line.startsWith('#') || !line.includes('=')) continue;
      const [key, ...valueParts] = line.split('=');
      const value = valueParts.join('=').trim();
      if (key && value) {
        process.env[key.trim()] = value;
      }
    }
  } catch (err) {
    console.error('Failed to load .env:', err.message);
  }
}

loadEnv();

// Unset ANTHROPIC_API_KEY, use ANTHROPIC_AUTH_TOKEN instead
delete process.env.ANTHROPIC_API_KEY;

const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
if (!authToken) {
  console.error('ANTHROPIC_AUTH_TOKEN not set in .env');
  process.exit(1);
}

console.log('=== SDK Test with ANTHROPIC_AUTH_TOKEN ===\n');
console.log('ANTHROPIC_API_KEY:', process.env.ANTHROPIC_API_KEY ?? '(unset)');
console.log('ANTHROPIC_AUTH_TOKEN:', authToken.slice(0, 25) + '...');

async function main() {
  const provider = new BoxLiteProvider();
  const id = generateSandboxId('authtoken');
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

  // Initialize npm and install SDK
  await sandbox.exec('sh', ['-c', 'cd /workspace && npm init -y']);
  result = await sandbox.exec('sh', ['-c', 'cd /workspace && npm install @anthropic-ai/claude-agent-sdk']);
  console.log('SDK installed:', result.exitCode === 0 ? 'yes' : 'no');

  // Create test script
  const testScript = `
const { query } = require('@anthropic-ai/claude-agent-sdk');

async function test() {
  console.log('UID:', process.getuid());
  console.log('HOME:', process.env.HOME);
  console.log('ANTHROPIC_API_KEY:', process.env.ANTHROPIC_API_KEY ? 'set' : 'unset');
  console.log('ANTHROPIC_AUTH_TOKEN:', process.env.ANTHROPIC_AUTH_TOKEN ? 'set' : 'unset');

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
        console.log('Result:', JSON.stringify(msg).slice(0, 400));
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
  // Pass ANTHROPIC_AUTH_TOKEN (not ANTHROPIC_API_KEY)
  result = await sandbox.exec('sh', ['-c', `cd /workspace && HOME=${userHome} ANTHROPIC_AUTH_TOKEN="${authToken}" timeout 90 node test.js 2>&1`]);
  console.log('Exit code:', result.exitCode);
  console.log('Output:');
  console.log(result.stdout);
  if (result.stderr) console.log('Stderr:', result.stderr);

  const success = result.exitCode === 0 && result.stdout.includes('SUCCESS');
  console.log(`\nResult: ${success ? '✅ SUCCESS' : '❌ FAILED'}`);

  await sandbox.stop();
}

main().catch(console.error);
