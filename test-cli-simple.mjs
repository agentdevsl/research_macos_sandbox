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
const id = generateSandboxId('cli-simple');
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

// Test claude directly with args
console.log('\n--- claude -p (direct call) ---');
const start = performance.now();
let result = await sandbox.exec('claude', ['-p', 'Say exactly: SUCCESS', '--output-format', 'text']);
const duration = performance.now() - start;
console.log('Exit:', result.exitCode);
console.log('Duration:', duration.toFixed(0), 'ms');
console.log('Stdout:', JSON.stringify(result.stdout));
console.log('Stderr:', JSON.stringify(result.stderr));
console.log('Success:', result.stdout.includes('SUCCESS'));

await sandbox.stop();
