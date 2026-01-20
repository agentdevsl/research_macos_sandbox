# Claude Agent SDK Authentication Workaround

## Problem

The Claude Agent SDK requires authentication, but OAuth tokens (`sk-ant-oat01-...`) are blocked when passed via environment variables:

```
Error: OAuth authentication is currently not supported
```

This affects users with Claude subscriptions (Pro/Max) who want to use the SDK without a separate API key.

## Solution

Write the OAuth credentials to `~/.claude/.credentials.json` instead of using environment variables. The SDK reads this file automatically (same as `claude login` would create).

### Credentials File Format

```json
{
  "claudeAiOauth": {
    "accessToken": "sk-ant-oat01-...",
    "refreshToken": "",
    "expiresAt": 1737417600000,
    "scopes": ["user:inference", "user:profile", "user:sessions:claude_code"],
    "subscriptionType": "max"
  }
}
```

### Writing the File in a Sandbox

Use a heredoc to reliably write JSON (avoids shell escaping issues):

```javascript
const credentials = {
  claudeAiOauth: {
    accessToken: process.env.ANTHROPIC_AUTH_TOKEN,
    refreshToken: '',
    expiresAt: Date.now() + 86400000, // 24h
    scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
    subscriptionType: 'max',
  }
};

const credsJson = JSON.stringify(credentials);
const userHome = '/home/sandbox';

// Create directory
await sandbox.exec('sh', ['-c', `mkdir -p ${userHome}/.claude`]);

// Write credentials using heredoc (most reliable method)
const writeCmd = `cat > ${userHome}/.claude/.credentials.json << 'CREDS_EOF'
${credsJson}
CREDS_EOF`;
await sandbox.exec('sh', ['-c', writeCmd]);

// Set permissions
await sandbox.exec('sh', ['-c', `chmod 600 ${userHome}/.claude/.credentials.json`]);
```

### Running the SDK

The SDK must run as a **non-root user** when using `bypassPermissions` mode:

```javascript
const q = query({
  prompt: 'Your task here',
  options: {
    model: 'claude-sonnet-4-20250514',
    maxTurns: 10,
    cwd: '/workspace',
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
  }
});
```

Ensure `HOME` environment variable points to the directory containing `.claude/`:

```bash
HOME=/home/sandbox node test.js
```

## Why This Works

1. The SDK checks for credentials in this order:
   - Environment variables (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`)
   - Credentials file (`~/.claude/.credentials.json`)

2. OAuth tokens are blocked at the API level when passed as env vars, but work when read from the credentials file (the same path `claude login` uses).

3. The credentials file format matches what Claude Code creates after `claude login`.

## Requirements

| Requirement | Value |
|-------------|-------|
| User | Non-root (uid ≠ 0) |
| HOME | Set to user's home directory |
| Credentials | Written to `$HOME/.claude/.credentials.json` |
| Permissions | File: 600, Directory: 700 |

## Common Issues

### "OAuth authentication is currently not supported"
- **Cause**: Using `ANTHROPIC_AUTH_TOKEN` env var
- **Fix**: Write to credentials file instead

### "--dangerously-skip-permissions cannot be used with root"
- **Cause**: Running as root (uid=0)
- **Fix**: Create non-root user and run SDK as that user

### Credentials file empty (0 bytes)
- **Cause**: Shell escaping issues with JSON
- **Fix**: Use heredoc with quoted delimiter (`<< 'EOF'`)

### User not found after setup
- **Cause**: UID/GID conflicts with existing users in image
- **Fix**: Use `-o` flag with useradd/groupadd to allow non-unique IDs

## Tested Providers

| Provider | Image | User Setup | Status |
|----------|-------|------------|--------|
| BoxLite | alpine:latest | `adduser -D` | ✅ Works |
| OrbStack | alpine:latest | `adduser -D` | ✅ Works |
| Apple Container | node:22-slim | `useradd -o` | ✅ Works |

## Example Test Script

See `test-sdk-with-credsfile.mjs` for a complete working example.
