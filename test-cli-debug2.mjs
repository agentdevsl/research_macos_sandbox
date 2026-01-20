import { BoxLiteProvider } from './packages/sandbox-boxlite/dist/index.js';
import { generateSandboxId } from './packages/sandbox-core/dist/index.js';
import { readFileSync, mkdirSync } from 'node:fs';

// Load .env
const envContent = readFileSync('.env', 'utf-8');
for (const line of envContent.split('\n')) {
  if (line.startsWith('#') || !line.includes('=')) continue;
  const [key, ...valueParts] = line.split('=');
  const value = valueParts.join('=').trim();
  if (key && value) process.env[key.trim()] = value;
}

const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
const credentials = {
  claudeAiOauth: {
    accessToken: authToken,
    refreshToken: '',
    expiresAt: Date.now() + 86400000,
    scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
    subscriptionType: 'max',
  }
};

const provider = new BoxLiteProvider();
const id = generateSandboxId('cli-debug2');
const mountPath = `/tmp/sandboxes/${id}/workspace`;
mkdirSync(mountPath, { recursive: true });

const sandbox = await provider.create({
  id,
  image: 'alpine:latest',
  mountPath,
  memoryMib: 2048,
  cpus: 2,
  env: { CI: 'true', TERM: 'dumb' },
  user: { name: 'sandbox', uid: 1000, gid: 1000 },
});

console.log('Startup:', sandbox.getMetrics().startupMs.toFixed(0), 'ms');

await sandbox.execAsRoot('apk', ['add', '--no-cache', 'nodejs', 'npm']);
await sandbox.execAsRoot('npm', ['install', '-g', '@anthropic-ai/claude-code']);

const userHome = '/home/sandbox';
const credsJson = JSON.stringify(credentials);
await sandbox.exec('sh', ['-c', `mkdir -p ${userHome}/.claude`]);
await sandbox.exec('sh', ['-c', `cat > ${userHome}/.claude/.credentials.json << 'CREDS_EOF'\n${credsJson}\nCREDS_EOF`]);

// Test basic echo
console.log('\n--- echo test ---');
let result = await sandbox.exec('echo', ['hello world']);
console.log('Exit:', result.exitCode, 'Stdout:', JSON.stringify(result.stdout));

// Test node version
console.log('\n--- node --version ---');
result = await sandbox.exec('node', ['--version']);
console.log('Exit:', result.exitCode, 'Stdout:', JSON.stringify(result.stdout));

// Test claude --version with different approach
console.log('\n--- claude --version (direct) ---');
result = await sandbox.exec('claude', ['--version']);
console.log('Exit:', result.exitCode, 'Stdout:', JSON.stringify(result.stdout), 'Stderr:', JSON.stringify(result.stderr));

// Test claude --version redirecting to file
console.log('\n--- claude --version > file ---');
result = await sandbox.exec('sh', ['-c', `HOME=${userHome} claude --version > /tmp/ver.txt 2>&1; cat /tmp/ver.txt`]);
console.log('Exit:', result.exitCode, 'Stdout:', JSON.stringify(result.stdout));

// Test with stdbuf to disable buffering
console.log('\n--- stdbuf claude -p ---');
result = await sandbox.exec('sh', ['-c', `HOME=${userHome} timeout 30 stdbuf -oL claude -p "Say: SUCCESS" --output-format text 2>&1 || echo "timeout or error"`]);
console.log('Exit:', result.exitCode, 'Stdout:', JSON.stringify(result.stdout.slice(0, 300)));

await sandbox.stop();
