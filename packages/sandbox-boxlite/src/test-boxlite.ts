/**
 * BoxLite availability test script
 * Run with: pnpm exec tsx src/test-boxlite.ts
 */

async function testBoxLiteAvailability() {
  console.log('Testing BoxLite availability...\n');

  // Test 1: Try to import the module
  console.log('1. Attempting to import @boxlite-ai/boxlite...');
  try {
    const boxlite = await import('@boxlite-ai/boxlite');
    console.log('   SUCCESS: Module imported');
    console.log('   Exports:', Object.keys(boxlite).join(', '));
    
    // Test 2: Check SimpleBox exists
    console.log('\n2. Checking SimpleBox class...');
    if (boxlite.SimpleBox) {
      console.log('   SUCCESS: SimpleBox class found');
    } else {
      console.log('   FAILED: SimpleBox not found');
      return;
    }

    // Test 3: Try to create a SimpleBox (this will test native bindings)
    console.log('\n3. Creating SimpleBox instance...');
    let box: InstanceType<typeof boxlite.SimpleBox>;
    try {
      box = new boxlite.SimpleBox({
        image: 'alpine:latest',
        memoryMib: 256,
        cpus: 1,
      });
      console.log('   SUCCESS: SimpleBox created (lazy initialization)');
    } catch (err) {
      console.log('   FAILED:', err instanceof Error ? err.message : err);
      return;
    }

    // Test 4: Try executing a command (this triggers actual VM creation)
    console.log('\n4. Executing "echo Hello BoxLite" (triggers VM creation)...');
    try {
      const result = await box.exec('echo', 'Hello', 'BoxLite');
      console.log('   Exit code:', result.exitCode);
      console.log('   Stdout:', result.stdout);
      console.log('   Stderr:', result.stderr);
      
      if (result.exitCode === 0 && result.stdout.includes('Hello BoxLite')) {
        console.log('   SUCCESS: Command executed correctly');
      }

      // Get box ID (now available after first exec)
      console.log('\n5. Getting box ID...');
      console.log('   Box ID:', box.id);

      // Test 5: Run another command
      console.log('\n6. Running "uname -a"...');
      const uname = await box.exec('uname', '-a');
      console.log('   Result:', uname.stdout);

      // Cleanup
      console.log('\n7. Stopping box...');
      await box.stop();
      console.log('   SUCCESS: Box stopped');

      console.log('\n===========================================');
      console.log('=== BoxLite is FULLY WORKING ===');
      console.log('===========================================');

    } catch (err) {
      console.log('   FAILED:', err instanceof Error ? err.message : err);
      
      // Try to cleanup
      try { await box.stop(); } catch (e) { /* ignore */ }

      console.log('\n=== BoxLite native bindings NOT working ===');
      console.log('   Possible reasons:');
      console.log('   - Not running on Apple Silicon (macOS ARM64)');
      console.log('   - KVM not available (Linux)');
      console.log('   - Hypervisor.framework entitlements missing');
      console.log('   - Native bindings failed to load');
      
      // Check platform
      const os = await import('os');
      console.log('\n   Platform info:');
      console.log('   - Platform:', os.platform());
      console.log('   - Architecture:', os.arch());
      console.log('   - CPU:', os.cpus()[0]?.model);
    }

  } catch (err) {
    console.log('   FAILED:', err instanceof Error ? err.message : err);
    console.log('\n=== BoxLite module NOT available ===');
    console.log('   Install with: npm install @boxlite-ai/boxlite');
  }
}

testBoxLiteAvailability();
