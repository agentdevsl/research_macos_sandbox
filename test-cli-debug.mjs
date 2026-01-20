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
const id = generateSandboxId('cli-debug');
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

// Test with --help first (should be instant)
console.log('\n--- claude --help ---');
let result = await sandbox.exec('sh', ['-c', `HOME=${userHome} timeout 10 claude --help 2>&1 | head -20`]);
console.log('Exit:', result.exitCode);
console.log(result.stdout.slice(0, 500));

// Test with --version
console.log('\n--- claude --version ---');
result = await sandbox.exec('sh', ['-c', `HOME=${userHome} timeout 10 claude --version 2>&1`]);
console.log('Exit:', result.exitCode);
console.log(result.stdout);

// Test with a prompt but shorter timeout
console.log('\n--- claude -p (30s timeout) ---');
result = await sandbox.exec('sh', ['-c', `HOME=${userHome} timeout 30 claude -p "Say exactly: SUCCESS" --output-format text 2>&1`]);
console.log('Exit:', result.exitCode);
console.log('Output:', result.stdout.slice(0, 500));

await sandbox.stop();
