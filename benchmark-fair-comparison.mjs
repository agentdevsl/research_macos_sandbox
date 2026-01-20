#!/usr/bin/env node
/**
 * Fair Comparison Benchmark
 * Uses the same Docker Sandbox image (docker/sandbox-templates:claude-code)
 * for Docker Direct, OrbStack, and Docker Sandbox
 *
 * Apple Container uses node:22-slim with Claude CLI installed
 */
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
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

const settings = { permissions: { defaultMode: 'bypassPermissions' } };

// Common image for Docker-based providers
const CLAUDE_IMAGE = 'docker/sandbox-templates:claude-code';
const APPLE_IMAGE = 'node:22-slim';

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

function dockerExec(containerId, cmd, options = {}) {
  return runCommand(`docker exec ${containerId} sh -c "${cmd.replace(/"/g, '\\"')}"`, options);
}

async function testProvider(name, setupFn, execFn, cleanupFn) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`Testing: ${name}`);
  console.log('═'.repeat(60));

  const result = {
    provider: name,
    success: false,
    e2eMs: null,
    startupMs: null,
    promptMs: null,
    error: null,
  };

  const e2eStart = performance.now();

  try {
    // Setup
    const setupStart = performance.now();
    const ctx = await setupFn();
    result.startupMs = performance.now() - setupStart;
    console.log(`Startup: ${result.startupMs.toFixed(0)}ms`);

    // Run prompt
    const promptStart = performance.now();
    const promptResult = await execFn(ctx);
    result.promptMs = performance.now() - promptStart;

    result.e2eMs = performance.now() - e2eStart;
    result.success = promptResult.success;

    console.log(`Prompt: ${result.promptMs.toFixed(0)}ms`);
    console.log(`E2E: ${result.e2eMs.toFixed(0)}ms`);
    console.log(`Result: ${result.success ? '✅ SUCCESS' : '❌ FAILED'}`);

    if (!result.success) {
      console.log(`Output: ${promptResult.output?.slice(-200)}`);
    }

    // Cleanup
    await cleanupFn(ctx);

  } catch (err) {
    result.error = err.message;
    console.log(`Error: ${err.message}`);
  }

  return result;
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║     Fair Comparison Benchmark (Same Image)                 ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  console.log(`\nImage: ${CLAUDE_IMAGE}`);
  console.log(`Token: ${authToken.slice(0, 25)}...`);

  const testId = randomUUID().slice(0, 8);
  const results = [];

  // 1. Docker Direct with claude-code image
  results.push(await testProvider(
    'Docker Direct (claude-code image)',
    async () => {
      const containerId = `fair-docker-${testId}`;
      const workspace = `/tmp/fair-docker-${testId}`;
      mkdirSync(workspace, { recursive: true });

      runCommand(`docker run -d --name ${containerId} -v ${workspace}:/workspace -e CI=true ${CLAUDE_IMAGE} tail -f /dev/null`);

      // Write credentials and settings via workspace
      writeFileSync(`${workspace}/.credentials.json`, JSON.stringify(credentials));
      writeFileSync(`${workspace}/.settings.json`, JSON.stringify(settings));
      dockerExec(containerId, 'mkdir -p /home/agent/.claude');
      dockerExec(containerId, 'cp /workspace/.credentials.json /home/agent/.claude/.credentials.json');
      dockerExec(containerId, 'chmod 600 /home/agent/.claude/.credentials.json');
      dockerExec(containerId, 'rm -f /home/agent/.claude/settings.json');
      dockerExec(containerId, 'cp /workspace/.settings.json /home/agent/.claude/settings.json');

      return { containerId, workspace };
    },
    async (ctx) => {
      const result = dockerExec(
        ctx.containerId,
        `cd /workspace && HOME=/home/agent claude -p "Reply with exactly: SUCCESS" --output-format text 2>&1`,
        { timeout: 120000 }
      );
      return { success: result.stdout.includes('SUCCESS'), output: result.stdout };
    },
    async (ctx) => {
      runCommand(`docker rm -f ${ctx.containerId}`, { timeout: 10000 });
    }
  ));

  // 2. OrbStack with claude-code image
  results.push(await testProvider(
    'OrbStack (claude-code image)',
    async () => {
      const containerId = `fair-orbstack-${testId}`;
      const workspace = `/tmp/fair-orbstack-${testId}`;
      mkdirSync(workspace, { recursive: true });

      // OrbStack uses docker CLI with same image
      runCommand(`docker run -d --name ${containerId} -v ${workspace}:/workspace -e CI=true ${CLAUDE_IMAGE} tail -f /dev/null`);

      // Write credentials and settings via workspace
      writeFileSync(`${workspace}/.credentials.json`, JSON.stringify(credentials));
      writeFileSync(`${workspace}/.settings.json`, JSON.stringify(settings));
      dockerExec(containerId, 'mkdir -p /home/agent/.claude');
      dockerExec(containerId, 'cp /workspace/.credentials.json /home/agent/.claude/.credentials.json');
      dockerExec(containerId, 'chmod 600 /home/agent/.claude/.credentials.json');
      dockerExec(containerId, 'rm -f /home/agent/.claude/settings.json');
      dockerExec(containerId, 'cp /workspace/.settings.json /home/agent/.claude/settings.json');

      return { containerId, workspace };
    },
    async (ctx) => {
      const result = dockerExec(
        ctx.containerId,
        `cd /workspace && HOME=/home/agent claude -p "Reply with exactly: SUCCESS" --output-format text 2>&1`,
        { timeout: 120000 }
      );
      return { success: result.stdout.includes('SUCCESS'), output: result.stdout };
    },
    async (ctx) => {
      runCommand(`docker rm -f ${ctx.containerId}`, { timeout: 10000 });
    }
  ));

  // 3. Docker Sandbox
  results.push(await testProvider(
    'Docker Sandbox',
    async () => {
      const sandboxName = `fair-sandbox-${testId}`;
      const workspace = `/tmp/fair-sandbox-${testId}`;
      mkdirSync(workspace, { recursive: true });

      runCommand(`docker sandbox run -d --name ${sandboxName} -w ${workspace} claude`, { timeout: 120000 });
      const containerId = runCommand(`docker ps --filter "name=${sandboxName}" --format "{{.ID}}"`, { timeout: 5000 }).stdout.trim();

      // Write credentials and settings via workspace
      writeFileSync(`${workspace}/.credentials.json`, JSON.stringify(credentials));
      writeFileSync(`${workspace}/.settings.json`, JSON.stringify(settings));
      dockerExec(containerId, 'mkdir -p /home/agent/.claude');
      dockerExec(containerId, 'cp /workspace/.credentials.json /home/agent/.claude/.credentials.json 2>/dev/null || cp ' + workspace + '/.credentials.json /home/agent/.claude/.credentials.json');
      dockerExec(containerId, 'chmod 600 /home/agent/.claude/.credentials.json');
      dockerExec(containerId, 'rm -f /home/agent/.claude/settings.json');
      dockerExec(containerId, 'cp /workspace/.settings.json /home/agent/.claude/settings.json 2>/dev/null || cp ' + workspace + '/.settings.json /home/agent/.claude/settings.json');

      return { sandboxName, containerId, workspace };
    },
    async (ctx) => {
      const result = dockerExec(
        ctx.containerId,
        `cd ${ctx.workspace} && HOME=/home/agent claude -p "Reply with exactly: SUCCESS" --output-format text 2>&1`,
        { timeout: 120000 }
      );
      return { success: result.stdout.includes('SUCCESS'), output: result.stdout };
    },
    async (ctx) => {
      runCommand(`docker stop ${ctx.sandboxName}`, { timeout: 10000 });
      runCommand(`docker rm ${ctx.sandboxName}`, { timeout: 10000 });
    }
  ));

  // Summary
  console.log('\n' + '═'.repeat(60));
  console.log('SUMMARY - Fair Comparison (Same Image)');
  console.log('═'.repeat(60));
  console.log(`\nImage: ${CLAUDE_IMAGE}\n`);

  console.log('| Provider | Startup | Prompt | E2E | Result |');
  console.log('|----------|---------|--------|-----|--------|');
  for (const r of results) {
    const startup = r.startupMs ? `${r.startupMs.toFixed(0)}ms` : 'N/A';
    const prompt = r.promptMs ? `${r.promptMs.toFixed(0)}ms` : 'N/A';
    const e2e = r.e2eMs ? `${r.e2eMs.toFixed(0)}ms` : 'N/A';
    const result = r.success ? '✅' : '❌';
    console.log(`| ${r.provider.padEnd(35)} | ${startup.padEnd(7)} | ${prompt.padEnd(6)} | ${e2e.padEnd(6)} | ${result} |`);
  }

  // Save results
  const resultsFile = `results/benchmark-fair-comparison-${Date.now()}.json`;
  mkdirSync('results', { recursive: true });
  writeFileSync(resultsFile, JSON.stringify({ timestamp: new Date().toISOString(), image: CLAUDE_IMAGE, results }, null, 2));
  console.log(`\nResults saved to: ${resultsFile}`);
}

main().catch(console.error);
