import { BoxLiteProvider } from './packages/sandbox-boxlite/dist/index.js';
import { generateSandboxId } from './packages/sandbox-core/dist/index.js';

async function test() {
  const provider = new BoxLiteProvider();
  if (!(await provider.isAvailable())) {
    console.log('BoxLite not available');
    return;
  }

  const id = generateSandboxId('boxlite-npm');
  console.log('Creating sandbox:', id);

  const sandbox = await provider.create({
    id,
    image: 'alpine:latest',
    mountPath: '/tmp/sandboxes/' + id + '/workspace',
    memoryMib: 2048,
    cpus: 2,
  });

  console.log('Startup time:', sandbox.getMetrics().startupMs.toFixed(2), 'ms');

  // Install Node.js
  console.log('\nInstalling Node.js...');
  let result = await sandbox.exec('apk', ['add', '--no-cache', 'nodejs', 'npm']);
  console.log('Node install:', result.exitCode === 0 ? 'OK' : 'FAILED');

  // Use new npmInstall helper for Agent SDK
  console.log('\n=== Testing npmInstall helper ===');
  console.log('Installing Agent SDK...');
  result = await sandbox.npmInstall('@anthropic-ai/claude-agent-sdk');
  console.log('SDK install:', result.exitCode === 0 ? 'OK' : 'FAILED');
  if (result.exitCode !== 0) {
    console.log('Stderr:', result.stderr.slice(-300));
  }

  // Verify SDK loads
  result = await sandbox.execWithNpmPath(
    'cd /workspace && node -e "const sdk = require(\'@anthropic-ai/claude-agent-sdk\'); console.log(\'Exports:\', Object.keys(sdk).join(\', \'))"'
  );
  console.log('SDK exports:', result.stdout);

  // Install Claude CLI globally
  console.log('\nInstalling Claude CLI globally...');
  result = await sandbox.npmInstall('@anthropic-ai/claude-code', true);
  console.log('CLI install:', result.exitCode === 0 ? 'OK' : 'FAILED');

  // Verify CLI works
  result = await sandbox.execWithNpmPath('claude --version');
  console.log('Claude version:', result.stdout.trim());

  await sandbox.stop();
  console.log('\nTest complete!');
}

test().catch(console.error);
