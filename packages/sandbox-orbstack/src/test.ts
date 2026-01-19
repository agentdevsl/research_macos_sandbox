import { OrbStackProvider } from './provider.js';
import { SandboxOrchestrator, generateSandboxId } from '@sandbox/core';

async function main() {
  console.log('OrbStack Provider Test\n');

  const provider = new OrbStackProvider();
  const orchestrator = new SandboxOrchestrator();
  orchestrator.registerProvider(provider);

  // Check availability
  console.log('Checking provider availability...');
  const available = await provider.isAvailable();
  console.log(`  Available: ${available}`);

  if (!available) {
    console.error('OrbStack/Docker not available. Please start OrbStack or Docker.');
    process.exit(1);
  }

  // Get provider info
  const info = await provider.getInfo();
  console.log(`  Version: ${info.version}`);
  console.log(`  Features: ${info.features.join(', ')}\n`);

  // Check for image
  const hasImage = await provider.hasImage();
  if (!hasImage) {
    console.log('Sandbox image not found. Build it with:');
    console.log('  cd fixtures/docker && ./build.sh\n');
    process.exit(1);
  }

  // Create sandbox
  const sandboxId = generateSandboxId();
  console.log(`Creating sandbox: ${sandboxId}`);

  const sandbox = await orchestrator.createSandbox('orbstack', {
    id: sandboxId,
    image: 'sandbox-claude:latest',
  });

  console.log(`  SSH Port: ${sandbox.sshPort}`);
  console.log(`  Mount Path: ${sandbox.mountPath}\n`);

  try {
    // Test direct exec
    console.log('Testing direct exec (node --version)...');
    const nodeResult = await sandbox.exec('node', ['--version']);
    console.log(`  Exit code: ${nodeResult.exitCode}`);
    console.log(`  Output: ${nodeResult.stdout}`);
    console.log(`  Duration: ${nodeResult.durationMs.toFixed(2)}ms\n`);

    // Test SSH exec
    console.log('Testing SSH exec (echo $HOSTNAME)...');
    const sshResult = await sandbox.sshExec('echo $HOSTNAME');
    console.log(`  Exit code: ${sshResult.exitCode}`);
    console.log(`  Output: ${sshResult.stdout}`);
    console.log(`  Duration: ${sshResult.durationMs.toFixed(2)}ms\n`);

    // Test mount
    console.log('Testing mount (write file)...');
    await sandbox.sshExec('echo "test content" > /workspace/test.txt');
    const catResult = await sandbox.sshExec('cat /workspace/test.txt');
    console.log(`  Content: ${catResult.stdout}\n`);

    // Test Claude CLI
    console.log('Testing Claude CLI...');
    const claudeResult = await sandbox.sshExec('claude --version');
    console.log(`  Exit code: ${claudeResult.exitCode}`);
    console.log(`  Output: ${claudeResult.stdout}\n`);

    // Get metrics
    const metrics = sandbox.getMetrics();
    console.log('Metrics:');
    console.log(`  Startup: ${metrics.startupMs.toFixed(2)}ms`);
    console.log(`  SSH Ready: ${metrics.sshReadyMs.toFixed(2)}ms`);
    console.log(`  Exec Latency: ${metrics.execLatencyMs.toFixed(2)}ms\n`);

    console.log('All tests passed!');
  } finally {
    // Cleanup
    console.log('Cleaning up...');
    await sandbox.stop();
    await orchestrator.cleanupMount(sandboxId);
    console.log('Done.');
  }
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
