#!/usr/bin/env node
/**
 * Interactive script to login to Claude in a sandbox
 * Run this first, then the SDK will use the stored credentials
 */
import { BoxLiteProvider } from './packages/sandbox-boxlite/dist/index.js';
import { generateSandboxId } from './packages/sandbox-core/dist/index.js';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

async function main() {
  console.log('=== Sandbox Claude Login ===\n');

  const provider = new BoxLiteProvider();
  const id = generateSandboxId('login');
  console.log('Creating sandbox:', id);

  const userHome = '/home/sandbox';
  const mountPath = '/tmp/sandboxes/' + id + '/workspace';

  const sandbox = await provider.create({
    id,
    image: 'alpine:latest',
    mountPath,
    memoryMib: 2048,
    cpus: 2,
    env: {
      CI: 'true',
      TERM: 'xterm-256color', // Better terminal support for login
    },
    user: { name: 'sandbox', uid: 1000, gid: 1000 },
  });

  console.log('Startup:', sandbox.getMetrics().startupMs.toFixed(0), 'ms');

  // Install Node.js and Claude CLI as root
  console.log('\nInstalling Node.js and Claude CLI...');
  await sandbox.execAsRoot('apk', ['add', '--no-cache', 'nodejs', 'npm', 'bash']);

  // Install Claude CLI globally
  await sandbox.execAsRoot('npm', ['install', '-g', '@anthropic-ai/claude-code']);

  // Verify installation
  let result = await sandbox.exec('claude', ['--version']);
  console.log('Claude CLI version:', result.stdout || result.stderr);

  // Check user
  result = await sandbox.exec('id');
  console.log('User:', result.stdout);

  console.log('\n=== Running claude login ===');
  console.log('This will open a browser URL for authentication.');
  console.log('Follow the prompts to login with your subscription.\n');

  // Run claude login interactively
  result = await sandbox.exec('sh', ['-c', `HOME=${userHome} claude login 2>&1`]);
  console.log(result.stdout);
  if (result.stderr) console.log(result.stderr);

  if (result.exitCode === 0) {
    console.log('\n✅ Login successful!');

    // Check credentials file
    result = await sandbox.exec('sh', ['-c', `ls -la ${userHome}/.claude/`]);
    console.log('\nCredentials directory:');
    console.log(result.stdout);

    // Copy credentials to host for future use
    result = await sandbox.exec('sh', ['-c', `cat ${userHome}/.claude/.credentials.json`]);
    if (result.stdout) {
      console.log('\nCredentials saved. You can now run the SDK tests.');
      // Save to a known location
      const fs = await import('node:fs/promises');
      await fs.mkdir('.claude-sandbox', { recursive: true });
      await fs.writeFile('.claude-sandbox/credentials.json', result.stdout);
      console.log('Credentials copied to .claude-sandbox/credentials.json');
    }
  } else {
    console.log('\n❌ Login failed');
  }

  await sandbox.stop();
}

main().catch(console.error);
