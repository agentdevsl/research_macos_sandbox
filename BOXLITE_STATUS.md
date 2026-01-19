# BoxLite Integration Status

## Summary

**BoxLite is FULLY WORKING** on this system (macOS ARM64).

## Package Information

| Package | Version | Status |
|---------|---------|--------|
| `@boxlite-ai/boxlite` | 0.1.6 | Installed and working |
| `@boxlite-ai/boxlite-darwin-arm64` | 0.1.6 | Native bindings loaded |
| `@anthropic-ai/claude-sandbox` | N/A | Not found (not public) |

## Test Results

```
Testing BoxLite availability...

1. Module import: SUCCESS
2. SimpleBox class: FOUND
3. SimpleBox creation: SUCCESS (lazy initialization)
4. Command execution: SUCCESS
   - echo "Hello BoxLite" -> exit 0
   - uname -a -> Linux boxlite 6.12.62 aarch64
5. Box cleanup: SUCCESS

=== BoxLite is FULLY WORKING ===
```

## Architecture

BoxLite uses:
- **macOS**: Hypervisor.framework (Apple Silicon only)
- **Linux**: KVM (/dev/kvm required)

The SDK provides several box types:
- `SimpleBox` - Basic command execution
- `CodeBox` - Python code sandbox  
- `BrowserBox` - Browser automation
- `ComputerBox` - Desktop automation (14 functions)
- `InteractiveBox` - PTY terminal sessions

## API Notes

1. **Lazy Initialization**: The VM is only created on first `exec()` call
2. **ID Access**: `box.id` throws before first exec; use async `getId()` or access after exec
3. **OCI Images**: Uses standard Docker/OCI images (auto-pulled on first use)
4. **Startup Time**: < 100ms typical

## Integration Updates Made

1. Updated `packages/sandbox-boxlite/package.json`:
   - Added `@boxlite-ai/boxlite: ^0.1.6` as optional dependency

2. Updated `packages/sandbox-boxlite/src/provider.ts`:
   - Changed from hypothetical `createBox()` API to actual `SimpleBox` class
   - Added proper module detection for `@boxlite-ai/boxlite`

3. Updated `packages/sandbox-boxlite/src/types.ts`:
   - Added complete type definitions matching SDK v0.1.6
   - Documented lazy initialization behavior

4. Updated `packages/sandbox-boxlite/src/sandbox.ts`:
   - Handles lazy ID initialization
   - Uses `exec(cmd, ...args)` API correctly

## Requirements

### macOS
- Apple Silicon (M1/M2/M3/M4)
- macOS 12+ (Monterey or later)
- Hypervisor.framework (built-in)

### Linux  
- x86_64 or ARM64
- KVM enabled (`/dev/kvm` accessible)
- User in `kvm` group: `sudo usermod -aG kvm $USER`

### NOT Supported
- macOS Intel (no Hypervisor.framework support)
- Windows (use WSL2 with Linux requirements)

## Usage Example

```typescript
import { BoxLiteProvider } from '@sandbox/boxlite';

const provider = new BoxLiteProvider();

// Check availability
const available = await provider.isAvailable();
console.log('BoxLite available:', available);

// Create sandbox
const sandbox = await provider.create({
  id: 'my-sandbox',
  image: 'alpine:latest',
  memoryMib: 512,
  cpus: 1,
  mountPath: '/tmp/workspace',
});

// Execute commands
const result = await sandbox.exec('echo', ['Hello', 'World']);
console.log(result.stdout); // Hello World

// Cleanup
await sandbox.stop();
```

## Blockers Resolved

1. ✅ Package identification - Found `@boxlite-ai/boxlite` on npm
2. ✅ Native bindings - darwin-arm64 bindings work
3. ✅ API mismatch - Updated provider to use actual `SimpleBox` API
4. ✅ Lazy initialization - Handled properly in sandbox wrapper

## Remaining Considerations

1. **Image pulling**: First run with a new image takes longer (OCI pull)
2. **Entitlements**: Some environments may need Hypervisor.framework entitlements
3. **CI/CD**: GitHub Actions macOS runners are Intel (not supported)
   - Use self-hosted ARM64 runners or Linux with KVM

---

*Last updated: 2026-01-20*
*BoxLite version: 0.1.6*

---

## Additional Discovery: Anthropic Sandbox Runtime (ASRT)

During investigation, we also found `@anthropic-ai/sandbox-runtime` (v0.0.28), a separate sandboxing tool from Anthropic:

| Aspect | BoxLite | ASRT |
|--------|---------|------|
| Type | Micro-VM (hardware isolation) | Process sandbox (OS-level) |
| macOS | Hypervisor.framework | sandbox-exec |
| Linux | KVM | bubblewrap |
| Overhead | ~50-100MB per box | Minimal |
| Startup | < 100ms | < 10ms |
| Use case | Full isolation, OCI images | Lightweight restrictions |

**ASRT** is better for:
- Quick process sandboxing
- MCP server restrictions
- Low-overhead filesystem/network policies

**BoxLite** is better for:
- Full VM isolation
- Running untrusted code
- OCI container compatibility
- Desktop/browser automation

Both can be used in the sandbox research project for different isolation levels.
