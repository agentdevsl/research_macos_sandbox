# Claude Agent SDK Requirements

Based on Automaker implementation at `vendor/automaker/`.

## Summary: Key Requirements for bypassPermissions Mode

1. **API Key**: Must use standard API key (`sk-ant-api03-...`) from console.anthropic.com
   - OAuth tokens (`sk-ant-oat01-...`) are **NOT supported** for external API calls
2. **Non-Root User**: Must run as non-root user (uid != 0)
   - Error: "--dangerously-skip-permissions cannot be used with root/sudo privileges"
3. **Environment Variables**:
   - `ANTHROPIC_API_KEY` - Required, the API key
   - `HOME` - Required, set to user's home directory
   - `CI=true` - Recommended for non-interactive mode
   - `TERM=dumb` - Recommended for non-interactive mode
4. **SDK Options**:
   - `permissionMode: 'bypassPermissions'`
   - `allowDangerouslySkipPermissions: true`

## Authentication

### API Key Types

| Key Type | Format | SDK Support | Notes |
|----------|--------|-------------|-------|
| **API Key** | `sk-ant-api03-...` | ✅ Supported | Standard key from console.anthropic.com |
| **OAuth Token** | `sk-ant-oat01-...` | ❌ Not Supported | "OAuth authentication is currently not supported" |

**Critical**: Claude Code OAuth tokens are restricted to Claude Code itself and cannot be used for external API calls (changed ~2 weeks ago per GitHub issues).

### Automaker Validation (auth-utils.ts)

```typescript
// Validates API key format
if (!trimmedKey.startsWith('sk-ant-')) {
  return { isValid: false, error: 'Invalid Anthropic API key format. Should start with "sk-ant-"' };
}
if (trimmedKey.length < 20) {
  return { isValid: false, error: 'Anthropic API key too short' };
}
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Standard API key from console.anthropic.com |
| `CLAUDE_CODE_USE_BEDROCK` | Optional | Set to `1` to use AWS Bedrock |
| `CLAUDE_CODE_USE_VERTEX` | Optional | Set to `1` to use Google Vertex AI |
| `CLAUDE_CODE_USE_FOUNDRY` | Optional | Set to `1` to use Azure Foundry |
| `CI` | Recommended | Set to `true` for non-interactive mode |
| `TERM` | Recommended | Set to `dumb` for non-interactive mode |
| `HOME` | Required | User's home directory (for credentials file lookup) |

### Credentials File

Location: `$HOME/.claude/.credentials.json`

```json
{
  "claudeAiOauth": {
    "accessToken": "sk-ant-api03-...",
    "refreshToken": "...",
    "expiresAt": 1234567890,
    "scopes": ["user:inference", "user:profile"]
  }
}
```

**Note**: The SDK CLI may also accept credentials via environment variable directly.

## Permission Modes

| Mode | Description | Use Case |
|------|-------------|----------|
| `default` | No auto-approvals | Interactive applications |
| `acceptEdits` | Auto-approve file operations | Trusted editing tasks |
| `bypassPermissions` | Skip all permission checks | **Requires non-root user** |
| `plan` | No tool execution | Planning/review only |

### bypassPermissions Requirements

```
Error: --dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons
```

**Must run as non-root user (uid != 0)** to use `bypassPermissions` mode.

## SDK Query Structure

### TypeScript

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "Your task description",
  options: {
    model: "claude-sonnet-4-20250514",        // Model to use
    maxTurns: 10,                              // Max agent turns
    cwd: "/workspace",                         // Working directory
    permissionMode: "bypassPermissions",       // Permission mode
    allowDangerouslySkipPermissions: true,     // Required for bypassPermissions
    allowedTools: ["Read", "Edit", "Bash"],    // Enabled tools
  }
})) {
  // Handle messages
  if (message.type === "system") { /* init, status */ }
  if (message.type === "assistant") { /* Claude's response */ }
  if (message.type === "result") { /* Final result */ }
}
```

### Python

```python
import asyncio
from claude_agent_sdk import query, ClaudeAgentOptions

async def main():
    async for message in query(
        prompt="Your task description",
        options=ClaudeAgentOptions(
            model="claude-sonnet-4-20250514",
            max_turns=10,
            cwd="/workspace",
            permission_mode="bypassPermissions",
            allow_dangerously_skip_permissions=True,
            allowed_tools=["Read", "Edit", "Bash"],
        )
    ):
        if hasattr(message, "result"):
            print(message.result)

asyncio.run(main())
```

## Message Types

| Type | Subtype | Description |
|------|---------|-------------|
| `system` | `init` | Session initialization, contains `session_id` |
| `system` | `status` | Status updates |
| `assistant` | - | Claude's response with `message.content[]` blocks |
| `result` | `success` | Final result with `result`, `duration_ms`, `usage` |

### Result Message Structure

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "duration_ms": 3500,
  "duration_api_ms": 2800,
  "num_turns": 1,
  "result": "Task completed successfully",
  "session_id": "uuid",
  "total_cost_usd": 0.015,
  "usage": {
    "input_tokens": 1000,
    "output_tokens": 500,
    "cache_read_input_tokens": 200
  }
}
```

## Automaker Docker Setup

### Dockerfile User Creation

```dockerfile
# Build arguments for user ID matching (allows matching host user for mounted volumes)
ARG UID=1001
ARG GID=1001

# Create non-root user with home directory
RUN groupadd -o -g ${GID} automaker && \
    useradd -o -u ${UID} -g automaker -m -d /home/automaker -s /bin/bash automaker && \
    mkdir -p /home/automaker/.local/bin && \
    mkdir -p /home/automaker/.cursor && \
    chown -R automaker:automaker /home/automaker && \
    chmod 700 /home/automaker/.cursor

# Install Claude CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Environment variables
ENV HOME=/home/automaker
ENV PATH="/home/automaker/.local/bin:${PATH}"
```

### docker-entrypoint.sh

```bash
#!/bin/sh
set -e

# Ensure Claude CLI config directory exists with correct permissions
if [ ! -d "/home/automaker/.claude" ]; then
    mkdir -p /home/automaker/.claude
fi

# If CLAUDE_OAUTH_CREDENTIALS is set, write it to the credentials file
# This allows passing OAuth tokens from host (especially macOS where they're in Keychain)
if [ -n "$CLAUDE_OAUTH_CREDENTIALS" ]; then
    echo "$CLAUDE_OAUTH_CREDENTIALS" > /home/automaker/.claude/.credentials.json
    chmod 600 /home/automaker/.claude/.credentials.json
fi

# Fix permissions on Claude CLI config directory
chown -R automaker:automaker /home/automaker/.claude
chmod 700 /home/automaker/.claude

# Ensure npm cache directory exists
if [ ! -d "/home/automaker/.npm" ]; then
    mkdir -p /home/automaker/.npm
fi
chown -R automaker:automaker /home/automaker/.npm

# Switch to automaker user and execute the command
exec gosu automaker "$@"
```

### Automaker SDK Provider (claude-provider.ts)

```typescript
// Explicit allowlist of environment variables to pass to the SDK
const ALLOWED_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'PATH',
  'HOME',
  'SHELL',
  'TERM',
  'USER',
  'LANG',
  'LC_ALL',
];

// SDK options for autonomous operation
const sdkOptions: Options = {
  model,
  systemPrompt,
  maxTurns,
  cwd,
  env: buildEnv(),  // Only allowed env vars
  allowedTools,
  permissionMode: 'bypassPermissions',
  allowDangerouslySkipPermissions: true,
  abortController,
};
```

## Container/Sandbox Setup for Non-Root

### User Creation (Alpine Linux)

```bash
# Create group and user
addgroup -g 1000 sandbox
adduser -D -u 1000 -G sandbox -h /home/sandbox -s /bin/sh sandbox

# Set up directories
mkdir -p /home/sandbox/.claude
mkdir -p /home/sandbox/.npm
chown -R 1000:1000 /home/sandbox
chmod 700 /home/sandbox/.claude

# Set workspace ownership
chown -R 1000:1000 /workspace
```

### User Creation (Debian/Ubuntu)

```bash
# Create group and user
groupadd -g 1000 sandbox
useradd -u 1000 -g 1000 -m -d /home/sandbox -s /bin/sh sandbox

# Set up directories
mkdir -p /home/sandbox/.claude
chown 1000:1000 /home/sandbox/.claude
chmod 700 /home/sandbox/.claude

# Set workspace ownership
chown 1000:1000 /workspace
```

### Running Commands as User

```bash
# Using su
su -s /bin/sh sandbox -c 'export HOME=/home/sandbox && cd /workspace && node test.js'

# Using gosu (Docker best practice)
gosu sandbox sh -c 'cd /workspace && node test.js'
```

## Available Tools

| Tool | Description |
|------|-------------|
| `Read` | Read files |
| `Write` | Create new files |
| `Edit` | Edit existing files |
| `Bash` | Run terminal commands |
| `Glob` | Find files by pattern |
| `Grep` | Search file contents |
| `WebSearch` | Search the web |
| `WebFetch` | Fetch web pages |
| `Task` | Spawn subagents |
| `AskUserQuestion` | Ask user questions |

## Error Messages

| Error | Cause | Solution |
|-------|-------|----------|
| "OAuth authentication is currently not supported" | Using OAuth token | Use standard API key from console.anthropic.com |
| "Invalid API key · Please run /login" | Missing or invalid credentials | Set `ANTHROPIC_API_KEY` env var |
| "--dangerously-skip-permissions cannot be used with root" | Running as root with bypassPermissions | Run as non-root user (uid=1000) |
| "Claude Code process exited with code 1" | SDK CLI error | Check `is_error` in result message |

## Sources

- [Agent SDK Overview](https://platform.claude.com/docs/en/agent-sdk/overview)
- [Configure Permissions](https://platform.claude.com/docs/en/agent-sdk/permissions)
- [OAuth Token Changes](https://github.com/clawdbot/clawdbot/issues/559)
