/**
 * Debug Apple Container exec
 */
import { mkdirSync } from 'node:fs';
import { AppleContainerProvider } from './packages/sandbox-apple-container/dist/index.js';
import { generateSandboxId } from './packages/sandbox-core/dist/index.js';

async function main() {
  console.log('=== Apple Container Debug ===\n');

  const provider = new AppleContainerProvider();
  const available = await provider.isAvailable();
  if (!available) {
    console.error('Apple Container CLI not available');
    process.exit(1);
  }

  const id = generateSandboxId('debug');
  const mountPath = `/tmp/sandboxes/${id}/workspace`;
  mkdirSync(mountPath, { recursive: true });

  console.log('Creating sandbox:', id);
  const sandbox = await provider.create({
    id,
    image: 'node:22-slim',
    mountPath,
    memoryMib: 512,
    cpus: 1,
    env: { CI: 'true' },
    user: { name: 'sandbox', uid: 1000, gid: 1000 },
  });

  console.log('Startup:', sandbox.getMetrics().startupMs.toFixed(0), 'ms');

  // Test 1: Basic exec as root
  console.log('\n--- Test 1: execAsRoot ---');
  let result = await sandbox.execAsRoot('id');
  console.log('Exit:', result.exitCode);
  console.log('Stdout:', JSON.stringify(result.stdout));
  console.log('Stderr:', JSON.stringify(result.stderr));

  // Test 2: Basic exec as user
  console.log('\n--- Test 2: exec (as user) ---');
  result = await sandbox.exec('id');
  console.log('Exit:', result.exitCode);
  console.log('Stdout:', JSON.stringify(result.stdout));
  console.log('Stderr:', JSON.stringify(result.stderr));

  // Test 3: Echo test
  console.log('\n--- Test 3: echo test ---');
  result = await sandbox.exec('echo', ['hello world']);
  console.log('Exit:', result.exitCode);
  console.log('Stdout:', JSON.stringify(result.stdout));

  // Test 4: Shell command
  console.log('\n--- Test 4: sh -c ---');
  result = await sandbox.exec('sh', ['-c', 'echo $HOME && id']);
  console.log('Exit:', result.exitCode);
  console.log('Stdout:', JSON.stringify(result.stdout));

  // Test 5: Write file via echo
  console.log('\n--- Test 5: echo to file ---');
  result = await sandbox.exec('sh', ['-c', 'echo "test content" > /tmp/test.txt && cat /tmp/test.txt']);
  console.log('Exit:', result.exitCode);
  console.log('Stdout:', JSON.stringify(result.stdout));

  // Test 6: mkdir and write
  console.log('\n--- Test 6: mkdir and write ---');
  await sandbox.exec('sh', ['-c', 'mkdir -p /home/sandbox/.claude']);
  result = await sandbox.exec('sh', ['-c', 'echo "test" > /home/sandbox/.claude/test.txt && cat /home/sandbox/.claude/test.txt']);
  console.log('Exit:', result.exitCode);
  console.log('Stdout:', JSON.stringify(result.stdout));

  // Test 7: Heredoc
  console.log('\n--- Test 7: heredoc ---');
  const heredocCmd = `cat > /tmp/heredoc.txt << 'EOF'
line1
line2
EOF`;
  result = await sandbox.exec('sh', ['-c', heredocCmd]);
  console.log('Write Exit:', result.exitCode);
  result = await sandbox.exec('cat', ['/tmp/heredoc.txt']);
  console.log('Read Exit:', result.exitCode);
  console.log('Content:', JSON.stringify(result.stdout));

  await sandbox.stop();
  console.log('\nDone');
}

main().catch(console.error);
