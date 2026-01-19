import { AppleContainerProvider } from './provider.js';
import { SandboxOrchestrator, generateSandboxId } from '@sandbox/core';

async function main() {
  console.log('Apple Container Provider Test\n');

  const provider = new AppleContainerProvider();
  const orchestrator = new SandboxOrchestrator();
  orchestrator.registerProvider(provider);

  // Check availability
  console.log('Checking provider availability...');
  const available = await provider.isAvailable();
  console.log(`  Available: ${available}`);

  if (!available) {
    console.error('\nApple Container is not available.');
    console.log('\nRequirements:');
    console.log('  - macOS 26 (Tahoe) or later');
    console.log('  - The `container` CLI must be installed');
    console.log('\nApple Container provides:');
    console.log('  - Full VM isolation per container');
    console.log('  - Native SSH support (--ssh flag)');
    console.log('  - virtiofs mounts');
    console.log('  - Sub-second startup times');
    process.exit(1);
  }

  // Get provider info
  const info = await provider.getInfo();
  console.log(`  Version: ${info.version}`);
  console.log(`  Isolation: ${info.isolationType}`);
  console.log(`  Features: ${info.features.join(', ')}\n`);

  // Create sandbox
  const sandboxId = generateSandboxId('apple');
  console.log(`Creating sandbox: ${sandboxId}`);

  try {
    const sandbox = await orchestrator.createSandbox('apple-container', {
      id: sandboxId,
      image: 'node:22-slim',
      memoryMib: 512,
      cpus: 2,
    });

    console.log(`  SSH Port: ${sandbox.sshPort}`);
    console.log(`  Mount Path: ${sandbox.mountPath}`);
    console.log(`  Provider: ${sandbox.provider}\n`);

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
    await sandbox.exec('sh', ['-c', 'echo "apple container test" > /workspace/test.txt']);
    const catResult = await sandbox.exec('cat', ['/workspace/test.txt']);
    console.log(`  Content: ${catResult.stdout}\n`);

    // Get metrics
    const metrics = sandbox.getMetrics();
    console.log('Metrics:');
    console.log(`  Startup: ${metrics.startupMs.toFixed(2)}ms`);
    console.log(`  SSH Ready: ${metrics.sshReadyMs.toFixed(2)}ms`);
    console.log(`  Exec Latency: ${metrics.execLatencyMs.toFixed(2)}ms\n`);

    console.log('All tests passed!');

    // Cleanup
    console.log('Cleaning up...');
    await sandbox.stop();
    await orchestrator.cleanupMount(sandboxId);
    console.log('Done.');
  } catch (err) {
    console.error('Test failed:', err);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
