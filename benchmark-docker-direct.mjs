#!/usr/bin/env node
/**
 * Direct Docker benchmark (using docker CLI)
 * Compare against OrbStack provider implementation
 */
import { execSync, spawn } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// Load .env
function loadEnv() {
  try {
    const content = readFileSync('.env', 'utf-8');
    for (const line of content.split('\n')) {
      if (line.startsWith('#') || !line.includes('=')) continue;
      const [key, ...valueParts] = line.split('=');
      const value = valueParts.join('=').trim();
      if (key && value) process.env[key.trim()] = value;
    }
  } catch {}
}

loadEnv();

const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
if (!authToken) {
  console.error('ANTHROPIC_AUTH_TOKEN not set');
  process.exit(1);
}

const credentials = {
  claudeAiOauth: {
    accessToken: authToken,
    refreshToken: '',
    expiresAt: Date.now() + 86400000,
    scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
    subscriptionType: 'max',
  }
};

function dockerExec(containerId, cmd, options = {}) {
  const timeout = options.timeout || 120000;
  try {
    const result = execSync(`docker exec ${containerId} ${cmd}`, {
      encoding: 'utf-8',
      timeout,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
    });
    return { exitCode: 0, stdout: result.trim(), stderr: '' };
  } catch (err) {
    return {
      exitCode: err.status || 1,
      stdout: err.stdout?.toString().trim() || '',
      stderr: err.stderr?.toString().trim() || err.message,
    };
  }
}

async function runTest(name, testFn) {
  console.log(`\n--- ${name} ---`);
  const start = performance.now();
  try {
    const result = await testFn();
    const duration = performance.now() - start;
    console.log(`Duration: ${duration.toFixed(0)}ms`);
    return { success: true, duration, ...result };
  } catch (err) {
    const duration = performance.now() - start;
    console.log(`Error: ${err.message}`);
    return { success: false, duration, error: err.message };
  }
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║     Direct Docker Benchmark (docker CLI)                   ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  const dockerVersion = execSync('docker --version', { encoding: 'utf-8' }).trim();
  console.log(`\nDocker: ${dockerVersion}`);
  console.log(`Token: ${authToken.slice(0, 25)}...`);

  const results = {
    timestamp: new Date().toISOString(),
    docker: dockerVersion,
    tests: {},
  };

  const containerId = `benchmark-docker-${randomUUID().slice(0, 8)}`;
  const mountPath = `/tmp/sandboxes/${containerId}/workspace`;
  mkdirSync(mountPath, { recursive: true });

  const userHome = '/home/sandbox';
  const credsJson = JSON.stringify(credentials);

  try {
    // Test 1: Container startup
    results.tests.startup = await runTest('Container Startup', async () => {
      const start = performance.now();
      execSync(`docker run -d --name ${containerId} \
        -v ${mountPath}:/workspace \
        -e CI=true -e TERM=dumb \
        alpine:latest tail -f /dev/null`, { stdio: 'pipe' });
      const startupMs = performance.now() - start;
      console.log(`Startup: ${startupMs.toFixed(0)}ms`);
      return { startupMs };
    });

    // Test 2: User setup
    results.tests.userSetup = await runTest('User Setup', async () => {
      // Create non-root user
      dockerExec(containerId, `sh -c "addgroup -g 1000 sandbox && adduser -D -u 1000 -G sandbox -h ${userHome} sandbox"`);
      dockerExec(containerId, `sh -c "mkdir -p ${userHome}/.claude && chown -R 1000:1000 ${userHome}"`);
      dockerExec(containerId, `chown -R 1000:1000 /workspace`);

      const result = dockerExec(containerId, `su -s /bin/sh sandbox -c id`);
      console.log(`User: ${result.stdout}`);
      return { user: result.stdout };
    });

    // Test 3: Install Node.js
    results.tests.nodeInstall = await runTest('Install Node.js', async () => {
      dockerExec(containerId, 'apk add --no-cache nodejs npm', { timeout: 120000 });
      const result = dockerExec(containerId, 'node --version');
      console.log(`Node: ${result.stdout}`);
      return { nodeVersion: result.stdout };
    });

    // Test 4: Install SDK
    results.tests.sdkInstall = await runTest('Install SDK', async () => {
      dockerExec(containerId, `su -s /bin/sh sandbox -c "cd /workspace && npm init -y"`, { timeout: 60000 });
      dockerExec(containerId, `su -s /bin/sh sandbox -c "cd /workspace && npm install @anthropic-ai/claude-agent-sdk"`, { timeout: 120000 });
      return { installed: true };
    });

    // Test 5: Write credentials
    results.tests.credentials = await runTest('Write Credentials', async () => {
      // Write credentials file to host mount, then copy
      writeFileSync(`${mountPath}/.credentials.json`, credsJson);
      dockerExec(containerId, `cp /workspace/.credentials.json ${userHome}/.claude/.credentials.json`);
      dockerExec(containerId, `chmod 600 ${userHome}/.claude/.credentials.json`);
      dockerExec(containerId, `chown 1000:1000 ${userHome}/.claude/.credentials.json`);

      const result = dockerExec(containerId, `cat ${userHome}/.claude/.credentials.json | wc -c`);
      console.log(`Credentials: ${result.stdout} bytes`);
      return { bytes: parseInt(result.stdout) };
    });

    // Test 6: SDK Test
    results.tests.sdk = await runTest('Agent SDK Test', async () => {
      const sdkScript = `
const { query } = require('@anthropic-ai/claude-agent-sdk');
async function test() {
  const q = query({
    prompt: 'Reply with exactly: SUCCESS',
    options: {
      model: 'claude-sonnet-4-20250514',
      maxTurns: 1,
      cwd: '/workspace',
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    }
  });
  let response = '';
  for await (const msg of q) {
    if (msg.type === 'assistant' && msg.message?.content) {
      for (const b of msg.message.content) {
        if (b.type === 'text') response += b.text;
      }
    }
  }
  console.log('Response:', response);
  process.exit(response.includes('SUCCESS') ? 0 : 1);
}
test().catch(e => { console.error(e.message); process.exit(1); });
`;
      // Write script to workspace on host
      writeFileSync(`${mountPath}/sdk-test.js`, sdkScript);

      const start = performance.now();
      const result = dockerExec(containerId,
        `su -s /bin/sh sandbox -c "cd /workspace && HOME=${userHome} node sdk-test.js"`,
        { timeout: 120000 }
      );
      const execMs = performance.now() - start;

      const success = result.exitCode === 0 && result.stdout.includes('SUCCESS');
      console.log(`Result: ${success ? '✅ SUCCESS' : '❌ FAILED'}`);
      console.log(`Output: ${result.stdout.slice(0, 200)}`);
      return { success, execMs, output: result.stdout };
    });

    // Test 7: CLI Test
    results.tests.cli = await runTest('Claude Code CLI Test', async () => {
      dockerExec(containerId, 'npm install -g @anthropic-ai/claude-code', { timeout: 120000 });

      const versionResult = dockerExec(containerId,
        `su -s /bin/sh sandbox -c "HOME=${userHome} claude --version"`
      );
      console.log(`CLI Version: ${versionResult.stdout}`);

      const start = performance.now();
      const result = dockerExec(containerId,
        `su -s /bin/sh sandbox -c "cd /workspace && HOME=${userHome} claude -p 'Say exactly: SUCCESS' --output-format text"`,
        { timeout: 120000 }
      );
      const execMs = performance.now() - start;

      const success = result.exitCode === 0 && result.stdout.includes('SUCCESS');
      console.log(`Result: ${success ? '✅ SUCCESS' : '❌ FAILED'}`);
      console.log(`Output: ${result.stdout.slice(0, 200)}`);
      return { success, execMs, version: versionResult.stdout, output: result.stdout };
    });

    // Test 8: 5 Concurrent Instances
    results.tests.concurrent = await runTest('5 Concurrent Instances', async () => {
      const containers = [];
      const startTimes = [];

      // Create 5 containers
      console.log('Creating 5 containers...');
      for (let i = 0; i < 5; i++) {
        const id = `benchmark-concurrent-${i}-${randomUUID().slice(0, 8)}`;
        const mount = `/tmp/sandboxes/${id}/workspace`;
        mkdirSync(mount, { recursive: true });

        const start = performance.now();
        execSync(`docker run -d --name ${id} -v ${mount}:/workspace -e CI=true alpine:latest tail -f /dev/null`, { stdio: 'pipe' });
        startTimes.push(performance.now() - start);
        containers.push({ id, mount });
      }

      const avgStartup = startTimes.reduce((a, b) => a + b, 0) / 5;
      console.log(`Avg startup: ${avgStartup.toFixed(0)}ms`);

      // Setup all containers
      console.log('Setting up all containers...');
      for (const c of containers) {
        dockerExec(c.id, `sh -c "addgroup -g 1000 sandbox && adduser -D -u 1000 -G sandbox -h ${userHome} sandbox"`);
        dockerExec(c.id, `sh -c "mkdir -p ${userHome}/.claude && chown -R 1000:1000 ${userHome}"`);
        dockerExec(c.id, 'apk add --no-cache nodejs npm', { timeout: 120000 });
        dockerExec(c.id, `su -s /bin/sh sandbox -c "cd /workspace && npm init -y && npm install @anthropic-ai/claude-agent-sdk"`, { timeout: 120000 });
        // Write credentials via host mount
        writeFileSync(`${c.mount}/.credentials.json`, credsJson);
        dockerExec(c.id, `cp /workspace/.credentials.json ${userHome}/.claude/.credentials.json`);
        dockerExec(c.id, `chmod 600 ${userHome}/.claude/.credentials.json`);
        dockerExec(c.id, `chown 1000:1000 ${userHome}/.claude/.credentials.json`);

        // Write test script
        const sdkScript = `
const { query } = require('@anthropic-ai/claude-agent-sdk');
async function test() {
  const q = query({
    prompt: 'Reply with exactly: SUCCESS',
    options: { model: 'claude-sonnet-4-20250514', maxTurns: 1, cwd: '/workspace', permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true }
  });
  let response = '';
  for await (const msg of q) {
    if (msg.type === 'assistant' && msg.message?.content) {
      for (const b of msg.message.content) { if (b.type === 'text') response += b.text; }
    }
  }
  console.log('Response:', response);
  process.exit(response.includes('SUCCESS') ? 0 : 1);
}
test().catch(() => process.exit(1));
`;
        writeFileSync(`${c.mount}/sdk-test.js`, sdkScript);
      }

      // Run SDK on all concurrently
      console.log('Running SDK on all 5 concurrently...');
      const runStart = performance.now();
      const runPromises = containers.map(c =>
        new Promise(resolve => {
          const result = dockerExec(c.id,
            `su -s /bin/sh sandbox -c "cd /workspace && HOME=${userHome} node sdk-test.js"`,
            { timeout: 120000 }
          );
          resolve(result);
        })
      );

      const runResults = await Promise.all(runPromises);
      const totalMs = performance.now() - runStart;

      const successes = runResults.filter(r => r.exitCode === 0 && r.stdout.includes('SUCCESS')).length;
      console.log(`Result: ${successes}/5 succeeded`);

      // Get memory stats
      const memoryMb = [];
      for (const c of containers) {
        try {
          const stats = execSync(`docker stats ${c.id} --no-stream --format "{{.MemUsage}}"`, { encoding: 'utf-8' });
          const match = stats.match(/(\d+(?:\.\d+)?)\s*MiB/i);
          if (match) memoryMb.push(parseFloat(match[1]));
        } catch {}
      }

      if (memoryMb.length > 0) {
        const avgMem = memoryMb.reduce((a, b) => a + b, 0) / memoryMb.length;
        console.log(`Avg memory: ${avgMem.toFixed(1)}MB`);
      }

      // Cleanup
      for (const c of containers) {
        try { execSync(`docker rm -f ${c.id}`, { stdio: 'pipe' }); } catch {}
      }

      return {
        success: successes === 5,
        successes,
        totalMs,
        avgStartupMs: avgStartup,
        avgMemoryMb: memoryMb.length > 0 ? memoryMb.reduce((a, b) => a + b, 0) / memoryMb.length : null
      };
    });

  } finally {
    // Cleanup main container
    try { execSync(`docker rm -f ${containerId}`, { stdio: 'pipe' }); } catch {}
  }

  // Summary
  console.log('\n' + '═'.repeat(60));
  console.log('SUMMARY - Direct Docker');
  console.log('═'.repeat(60));

  console.log(`\nStartup: ${results.tests.startup?.startupMs?.toFixed(0) || 'N/A'}ms`);
  console.log(`SDK: ${results.tests.sdk?.success ? '✅' : '❌'} (${results.tests.sdk?.execMs?.toFixed(0) || 'N/A'}ms)`);
  console.log(`CLI: ${results.tests.cli?.success ? '✅' : '❌'} (${results.tests.cli?.execMs?.toFixed(0) || 'N/A'}ms)`);
  console.log(`5 Concurrent: ${results.tests.concurrent?.success ? '✅' : '❌'} (${results.tests.concurrent?.totalMs?.toFixed(0) || 'N/A'}ms)`);

  // Save results
  const resultsFile = `results/benchmark-docker-direct-${Date.now()}.json`;
  mkdirSync('results', { recursive: true });
  writeFileSync(resultsFile, JSON.stringify(results, null, 2));
  console.log(`\nResults saved to: ${resultsFile}`);
}

main().catch(console.error);
