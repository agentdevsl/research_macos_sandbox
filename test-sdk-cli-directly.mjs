/**
 * Test SDK's bundled CLI directly vs standalone claude-code CLI
 */
import { execSync } from 'node:child_process';
import { AppleContainerProvider } from './packages/sandbox-apple-container/dist/index.js';
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

  const provider = new AppleContainerProvider();

  if (!(await provider.isAvailable())) {
    console.error('Apple Container not available');
    process.exit(1);
  }

  const id = generateSandboxId('cli-test');
  console.log('Creating sandbox:', id);

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
    },
  });

  console.log('Startup:', sandbox.getMetrics().startupMs.toFixed(0), 'ms');

  // Install SDK only (no separate claude-code package)
  console.log('\nInstalling SDK (includes bundled CLI)...');
  await sandbox.exec('sh', ['-c', 'cd /workspace && npm init -y']);
  let result = await sandbox.exec('sh', ['-c', 'cd /workspace && npm install @anthropic-ai/claude-agent-sdk']);
  if (result.exitCode !== 0) {
    console.error('Install failed:', result.stderr);
    await sandbox.stop();
    return;
  }

  // Write credentials
  console.log('Writing credentials...');
  await sandbox.exec('mkdir', ['-p', '/root/.claude']);
  const credsJson = JSON.stringify(credentials);
  await sandbox.exec('sh', ['-c', `printf '%s' '${credsJson.replace(/'/g, "'\\''")}' > /root/.claude/.credentials.json`]);

  console.log('\n=== Package structure ===');
  result = await sandbox.exec('sh', ['-c', 'ls -la /workspace/node_modules/@anthropic-ai/claude-agent-sdk/']);
  console.log(result.stdout);

  console.log('\n=== SDK CLI version check ===');
  result = await sandbox.exec('sh', ['-c', 'cd /workspace && node ./node_modules/@anthropic-ai/claude-agent-sdk/cli.js --version 2>&1']);
  console.log('Exit code:', result.exitCode);
  console.log('Output:', result.stdout);

  console.log('\n=== SDK CLI API call (like SDK does) ===');
  // Run same args as SDK: --output-format stream-json --verbose --input-format stream-json
  const args = [
    '--output-format', 'stream-json',
    '--verbose',
    '--input-format', 'stream-json',
    '--max-turns', '1',
    '--model', 'claude-sonnet-4-20250514',
    '--permission-mode', 'bypassPermissions',
    '--allow-dangerously-skip-permissions',
    '--tools', '',
  ].join(' ');

  result = await sandbox.exec('sh', ['-c', `cd /workspace && echo '{"type":"user_message","content":"Reply with: WORKING"}' | timeout 60 node ./node_modules/@anthropic-ai/claude-agent-sdk/cli.js ${args} 2>&1`]);
  console.log('Exit code:', result.exitCode);
  console.log('Output (first 500 chars):', result.stdout.slice(0, 500));

  console.log('\n=== Direct SDK CLI call with simple args ===');
  result = await sandbox.exec('sh', ['-c', `cd /workspace && timeout 60 node ./node_modules/@anthropic-ai/claude-agent-sdk/cli.js -p "Reply: WORKING" --max-turns 1 --output-format text --model sonnet < /dev/null 2>&1`]);
  console.log('Exit code:', result.exitCode);
  console.log('Output:', result.stdout);

  await sandbox.stop();
  console.log('\nTest complete.');
}

test().catch(console.error);
