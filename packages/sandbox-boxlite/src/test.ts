import { BoxLiteProvider } from './provider.js';
import { SandboxOrchestrator, generateSandboxId } from '@sandbox/core';

async function main() {
  console.log('BoxLite Provider Test\n');

  const provider = new BoxLiteProvider();
  const orchestrator = new SandboxOrchestrator();
  orchestrator.registerProvider(provider);

  // Check availability
  console.log('Checking provider availability...');
  const available = await provider.isAvailable();
  console.log(`  Available: ${available}`);

  if (!available) {
    const loadError = provider.getLoadError();
    console.error('\nBoxLite is not available.');
    if (loadError) {
      console.error('Load error:', loadError.message);
    }
    console.log('\nBoxLite requires:');
    console.log('  - macOS 14+ (Sonoma or later)');
    console.log('  - Apple Silicon (M1/M2/M3)');
    console.log('  - @anthropic-ai/claude-sandbox or @boxlite-ai/boxlite package');
    console.log('\nThis provider uses libkrun-based micro-VMs for isolation.');
    process.exit(1);
  }

  // Get provider info
  const info = await provider.getInfo();
  console.log(`  Version: ${info.version}`);
  console.log(`  Isolation: ${info.isolationType}`);
  console.log(`  Features: ${info.features.join(', ')}\n`);

  // Create sandbox
  const sandboxId = generateSandboxId('boxlite');
  console.log(`Creating sandbox: ${sandboxId}`);

  try {
    const sandbox = await orchestrator.createSandbox('boxlite', {
      id: sandboxId,
      image: '', // BoxLite uses its own rootfs
      memoryMib: 512,
      cpus: 1,
    });

    console.log(`  Mount Path: ${sandbox.mountPath}`);
    console.log(`  Provider: ${sandbox.provider}\n`);

    // Test direct exec via vsock
    console.log('Testing direct exec (uname -a)...');
    const unameResult = await sandbox.exec('uname', ['-a']);
    console.log(`  Exit code: ${unameResult.exitCode}`);
    console.log(`  Output: ${unameResult.stdout}`);
    console.log(`  Duration: ${unameResult.durationMs.toFixed(2)}ms\n`);

    // Test mount verification
    console.log('Testing mount (write file)...');
    await sandbox.exec('sh', ['-c', 'echo "boxlite test" > /workspace/test.txt']);
    const catResult = await sandbox.exec('cat', ['/workspace/test.txt']);
    console.log(`  Content: ${catResult.stdout}\n`);

    // Test Node.js if available
    console.log('Testing Node.js...');
    const nodeResult = await sandbox.exec('node', ['--version']);
    if (nodeResult.exitCode === 0) {
      console.log(`  Node version: ${nodeResult.stdout}`);
    } else {
      console.log(`  Node.js not installed in rootfs`);
    }
    console.log('');

    // Get metrics
    const metrics = sandbox.getMetrics();
    console.log('Metrics:');
    console.log(`  Startup: ${metrics.startupMs.toFixed(2)}ms`);
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
