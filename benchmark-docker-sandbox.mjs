#!/usr/bin/env node
/**
 * Docker Sandbox benchmark (docker sandbox run claude)
 * Tests the official Docker AI sandbox feature
 * https://docs.docker.com/ai/sandboxes/claude-code/
 */
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// Load .env for OAuth token
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
  console.error('ANTHROPIC_AUTH_TOKEN not set in .env');
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

function runCommand(cmd, options = {}) {
  const timeout = options.timeout || 120000;
  try {
    const result = execSync(cmd, {
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

function getContainerId(sandboxName) {
  const result = runCommand(`docker ps --filter "name=${sandboxName}" --format "{{.ID}}"`, { timeout: 5000 });
  return result.stdout.trim();
}

function dockerExec(containerId, cmd, options = {}) {
  return runCommand(`docker exec ${containerId} sh -c "${cmd.replace(/"/g, '\\"')}"`, options);
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║     Docker Sandbox Benchmark (docker sandbox run claude)   ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  const results = {
    timestamp: new Date().toISOString(),
    tests: {},
  };

  // Check if docker sandbox is available
  console.log('\n--- Checking Docker Sandbox availability ---');
  const helpResult = runCommand('docker sandbox --help 2>&1', { timeout: 10000 });
  if (!helpResult.stdout.includes('sandbox')) {
    console.log('Docker sandbox not available. Requires Docker Desktop with AI features.');
    process.exit(1);
  }
  console.log('Docker sandbox: available');

  const dockerVersion = runCommand('docker --version').stdout;
  console.log(`Docker: ${dockerVersion}`);
  console.log(`Token: ${authToken.slice(0, 25)}...`);

  const testId = randomUUID().slice(0, 8);
  const sandboxes = [];

  // Track end-to-end time from sandbox creation to first successful response
  const e2eStart = performance.now();

  try {
    // Test 1: Sandbox startup
    results.tests.startup = await runTest('Sandbox Startup', async () => {
      const sandboxName = `benchmark-${testId}`;
      const workspace = `/tmp/sandbox-bench-${testId}`;
      mkdirSync(workspace, { recursive: true });

      const start = performance.now();
      const createResult = runCommand(
        `docker sandbox run -d --name ${sandboxName} -w ${workspace} claude`,
        { timeout: 120000 }
      );
      const startupMs = performance.now() - start;

      if (createResult.exitCode !== 0) {
        throw new Error(`Failed to create sandbox: ${createResult.stderr}`);
      }

      sandboxes.push(sandboxName);
      const containerId = getContainerId(sandboxName);
      console.log(`Sandbox: ${sandboxName}`);
      console.log(`Container: ${containerId}`);
      console.log(`Startup: ${startupMs.toFixed(0)}ms`);

      // Write credentials
      const credsJson = JSON.stringify(credentials);
      dockerExec(containerId, 'mkdir -p /home/agent/.claude');
      // Write via workspace mount
      writeFileSync(`${workspace}/.credentials.json`, credsJson);
      dockerExec(containerId, `cp ${workspace}/.credentials.json /home/agent/.claude/.credentials.json`);
      dockerExec(containerId, 'chmod 600 /home/agent/.claude/.credentials.json');

      // Write settings.json with bypassPermissions mode
      const settingsJson = JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } });
      // Remove symlink and write actual file
      dockerExec(containerId, 'rm -f /home/agent/.claude/settings.json');
      writeFileSync(`${workspace}/.settings.json`, settingsJson);
      dockerExec(containerId, `cp ${workspace}/.settings.json /home/agent/.claude/settings.json`);

      // Verify
      const verifyResult = dockerExec(containerId, 'cat /home/agent/.claude/.credentials.json | wc -c');
      console.log(`Credentials: ${verifyResult.stdout} bytes`);
      console.log(`Settings: bypassPermissions enabled`);

      return { startupMs, containerId, sandboxName, workspace };
    });

    const { containerId, workspace } = results.tests.startup;

    // Test 2: Claude version
    results.tests.version = await runTest('Claude Version', async () => {
      const result = dockerExec(containerId, 'claude --version', { timeout: 30000 });
      console.log(`Version: ${result.stdout}`);
      return { version: result.stdout, success: result.exitCode === 0 };
    });

    // Test 3: Simple prompt
    results.tests.prompt = await runTest('Simple Prompt', async () => {
      const start = performance.now();
      const result = dockerExec(
        containerId,
        `cd ${workspace} && HOME=/home/agent claude -p "Reply with exactly: SUCCESS" --output-format text 2>&1`,
        { timeout: 120000 }
      );
      const execMs = performance.now() - start;

      const success = result.stdout.includes('SUCCESS');
      console.log(`Exit: ${result.exitCode}`);
      console.log(`Output: ${result.stdout.slice(-200)}`);
      console.log(`Result: ${success ? '✅ SUCCESS' : '❌ FAILED'}`);

      // Capture end-to-end time on first successful prompt
      if (success) {
        results.e2eMs = performance.now() - e2eStart;
        console.log(`E2E (start to first response): ${results.e2eMs.toFixed(0)}ms`);
      }

      return { execMs, success, output: result.stdout };
    });

    // Test 4: File creation
    results.tests.fileCreate = await runTest('File Creation', async () => {
      const start = performance.now();
      const result = dockerExec(
        containerId,
        `cd ${workspace} && HOME=/home/agent claude -p "Create a file called test-file.txt with content SUCCESS" --output-format text 2>&1`,
        { timeout: 120000 }
      );
      const execMs = performance.now() - start;

      // Check file on host
      let fileContent = '';
      try {
        fileContent = readFileSync(`${workspace}/test-file.txt`, 'utf-8');
      } catch {}

      const success = fileContent.includes('SUCCESS');
      console.log(`File content: ${fileContent.slice(0, 100)}`);
      console.log(`Result: ${success ? '✅ SUCCESS' : '❌ FAILED'}`);

      return { execMs, success, fileContent };
    });

    // Test 5: Code execution
    results.tests.codeExec = await runTest('Code Execution', async () => {
      const start = performance.now();
      const result = dockerExec(
        containerId,
        `cd ${workspace} && HOME=/home/agent claude -p "Write a Node.js script test.js that prints SUCCESS, then run it" --output-format text 2>&1`,
        { timeout: 180000 }
      );
      const execMs = performance.now() - start;

      // Check output OR file content for SUCCESS
      let scriptOutput = '';
      try {
        scriptOutput = readFileSync(`${workspace}/test.js`, 'utf-8');
      } catch {}
      const success = result.stdout.includes('SUCCESS') || scriptOutput.includes('SUCCESS');
      console.log(`Output: ${result.stdout.slice(-300)}`);
      console.log(`Result: ${success ? '✅ SUCCESS' : '❌ FAILED'}`);

      return { execMs, success, output: result.stdout };
    });

    // Test 6: 5 Concurrent sandboxes
    results.tests.concurrent = await runTest('5 Concurrent Sandboxes', async () => {
      const concurrentSandboxes = [];
      const startTimes = [];

      // Create 5 sandboxes
      console.log('Creating 5 sandboxes...');
      for (let i = 0; i < 5; i++) {
        const name = `benchmark-concurrent-${testId}-${i}`;
        const ws = `/tmp/sandbox-concurrent-${testId}-${i}`;
        mkdirSync(ws, { recursive: true });

        const start = performance.now();
        runCommand(`docker sandbox run -d --name ${name} -w ${ws} claude`, { timeout: 120000 });
        startTimes.push(performance.now() - start);

        sandboxes.push(name);
        const cid = getContainerId(name);
        concurrentSandboxes.push({ name, ws, cid });
      }

      const avgStartup = startTimes.reduce((a, b) => a + b, 0) / 5;
      console.log(`Avg startup: ${avgStartup.toFixed(0)}ms`);

      // Setup credentials and settings on all
      console.log('Setting up credentials and settings...');
      const settingsJson = JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } });
      for (const sb of concurrentSandboxes) {
        writeFileSync(`${sb.ws}/.credentials.json`, JSON.stringify(credentials));
        writeFileSync(`${sb.ws}/.settings.json`, settingsJson);
        dockerExec(sb.cid, 'mkdir -p /home/agent/.claude');
        dockerExec(sb.cid, `cp ${sb.ws}/.credentials.json /home/agent/.claude/.credentials.json`);
        dockerExec(sb.cid, 'chmod 600 /home/agent/.claude/.credentials.json');
        dockerExec(sb.cid, 'rm -f /home/agent/.claude/settings.json');
        dockerExec(sb.cid, `cp ${sb.ws}/.settings.json /home/agent/.claude/settings.json`);
      }

      // Run prompts concurrently
      console.log('Running 5 prompts concurrently...');
      const runStart = performance.now();
      const runPromises = concurrentSandboxes.map((sb, i) =>
        new Promise(resolve => {
          const result = dockerExec(
            sb.cid,
            `cd ${sb.ws} && HOME=/home/agent claude -p "Say: SUCCESS ${i}" --output-format text 2>&1`,
            { timeout: 120000 }
          );
          resolve(result);
        })
      );

      const runResults = await Promise.all(runPromises);
      const totalMs = performance.now() - runStart;

      const successes = runResults.filter(r => r.stdout.includes('SUCCESS')).length;
      console.log(`Result: ${successes}/5 succeeded`);

      return {
        success: successes === 5,
        successes,
        totalMs,
        avgStartupMs: avgStartup,
      };
    });

  } finally {
    // Cleanup - use docker stop/rm (docker sandbox stop/rm doesn't exist)
    console.log('\n--- Cleanup ---');
    for (const name of sandboxes) {
      try {
        runCommand(`docker stop ${name}`, { timeout: 10000 });
        runCommand(`docker rm ${name}`, { timeout: 10000 });
      } catch {}
    }
    console.log(`Cleaned up ${sandboxes.length} sandboxes`);
  }

  // Summary
  console.log('\n' + '═'.repeat(60));
  console.log('SUMMARY - Docker Sandbox');
  console.log('═'.repeat(60));

  const startupMs = results.tests.startup?.startupMs?.toFixed(0) || 'N/A';
  const version = results.tests.version?.version || 'N/A';
  const promptSuccess = results.tests.prompt?.success ? '✅' : '❌';
  const promptMs = results.tests.prompt?.execMs?.toFixed(0) || 'N/A';
  const fileSuccess = results.tests.fileCreate?.success ? '✅' : '❌';
  const codeSuccess = results.tests.codeExec?.success ? '✅' : '❌';
  const concurrentSuccess = results.tests.concurrent?.success ? '✅' : '❌';
  const concurrentMs = results.tests.concurrent?.totalMs?.toFixed(0) || 'N/A';

  const e2eMs = results.e2eMs?.toFixed(0) || 'N/A';

  console.log(`\nClaude Version: ${version}`);
  console.log(`Startup: ${startupMs}ms`);
  console.log(`E2E (start → first response): ${e2eMs}ms`);
  console.log(`Simple Prompt: ${promptSuccess} (${promptMs}ms)`);
  console.log(`File Creation: ${fileSuccess}`);
  console.log(`Code Execution: ${codeSuccess}`);
  console.log(`5 Concurrent: ${concurrentSuccess} (${concurrentMs}ms)`);

  // Save results
  const resultsFile = `results/benchmark-docker-sandbox-${Date.now()}.json`;
  mkdirSync('results', { recursive: true });
  writeFileSync(resultsFile, JSON.stringify(results, null, 2));
  console.log(`\nResults saved to: ${resultsFile}`);
}

main().catch(console.error);
