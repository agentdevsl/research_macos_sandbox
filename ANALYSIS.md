# macOS Sandbox Research: Provider Comparison Analysis

## Executive Summary

This project implements and compares four sandbox providers for running Claude Agent SDK and Claude Code CLI on macOS:

| Provider | Isolation | Startup | SSH | Status |
|----------|-----------|---------|-----|--------|
| **OrbStack** | Container | ~500ms | Port mapping | ✅ Ready |
| **Apple Container** | Full VM | <1s | Native --ssh | ✅ Ready (macOS 26+) |
| **BoxLite** | Micro-VM | ~200ms | vsock/SSH | ⚠️ Requires private access |
| **libkrun** | Micro-VM | ~150ms | vsock | ⚠️ Requires native build |

## Provider Details

### 1. OrbStack (Docker-based)

**Location:** `packages/sandbox-orbstack/`

**Technology:** Docker containers via OrbStack or Docker Desktop

**Characteristics:**
- Uses standard Docker API (`dockerode`)
- Bind mounts for host filesystem access
- SSH via port mapping (22 → dynamic host port)
- Container isolation (cgroups, namespaces)
- Widely available, well-documented

**Pros:**
- Easy to set up and use
- Standard Docker tooling
- Good ecosystem compatibility
- Works with existing Docker images

**Cons:**
- Container isolation weaker than VMs
- Requires Docker/OrbStack installation
- Port mapping complexity for SSH

**Usage:**
```typescript
import { OrbStackProvider } from '@sandbox/orbstack';

const provider = new OrbStackProvider();
const sandbox = await provider.create({
  id: 'my-sandbox',
  image: 'sandbox-claude:latest',
  mountPath: '/tmp/sandboxes/my-sandbox/workspace',
  sshPort: 2222,
});
```

---

### 2. Apple Container (macOS 26+ Native)

**Location:** `packages/sandbox-apple-container/`

**Technology:** Native `container` CLI in macOS 26 (Tahoe)

**Characteristics:**
- Full VM isolation per container
- Native SSH support via `--ssh` flag
- virtiofs mounts for host filesystem
- Sub-second startup times
- Built into macOS (no installation needed)

**Pros:**
- Full VM-level isolation
- Native SSH agent forwarding
- No additional software required (macOS 26+)
- Fastest startup among VM-based solutions
- Apple-supported, production-ready

**Cons:**
- Requires macOS 26 (Tahoe) or later
- CLI-only (no Node.js SDK yet)
- Limited to macOS

**Usage:**
```bash
# Direct CLI usage
container run -it --rm \
  --memory 2g \
  --cpus 2 \
  --ssh \
  -v ~/projects:/workspace \
  -w /workspace \
  node:22-slim \
  npx @anthropic-ai/claude-code
```

```typescript
import { AppleContainerProvider } from '@sandbox/apple-container';

const provider = new AppleContainerProvider();
const sandbox = await provider.create({
  id: 'my-sandbox',
  image: 'node:22-slim',
  mountPath: '/tmp/sandboxes/my-sandbox/workspace',
  memoryMib: 2048,
  cpus: 2,
});
```

---

### 3. BoxLite (libkrun wrapper)

**Location:** `packages/sandbox-boxlite/`

**Technology:** BoxLite wraps libkrun for micro-VM execution

**Characteristics:**
- Micro-VM isolation (Virtualization.framework)
- virtiofs for fast filesystem sharing
- vsock for guest-host communication
- Very fast startup (~200ms)
- Purpose-built for AI agent sandboxing

**Pros:**
- Fast startup times
- Strong isolation (VM-based)
- Efficient resource usage
- Designed for AI workloads

**Cons:**
- May require private/early access
- macOS-only (Apple Silicon)
- Less documentation than Docker

**Status:** Provider implemented with conditional loading. Requires `@anthropic-ai/claude-sandbox` or `@boxlite-ai/boxlite` package.

---

### 4. libkrun Native Bindings

**Location:** `packages/sandbox-libkrun/`

**Technology:** Direct napi-rs bindings to libkrun C API

**Characteristics:**
- Native Rust bindings via napi-rs
- Direct control over micro-VM lifecycle
- vsock for guest-host communication
- Lowest overhead of all providers

**Pros:**
- Maximum performance
- Full control over VM configuration
- No wrapper overhead

**Cons:**
- Requires Rust toolchain
- Must build libkrun from source
- Complex setup process
- vsock exec requires guest agent

**Building Native Module:**
```bash
# Requires: Rust, libkrun installed
pnpm --filter @sandbox/libkrun build:native
```

---

## Architecture

```
research_macos_sandbox/
├── packages/
│   ├── sandbox-core/           # Core interfaces + orchestrator
│   │   ├── src/types.ts        # ISandbox, ISandboxProvider interfaces
│   │   ├── src/orchestrator.ts # Mount management, provider registry
│   │   ├── src/ssh-client.ts   # SSH connectivity
│   │   └── src/utils.ts        # Stats, formatting utilities
│   │
│   ├── sandbox-orbstack/       # Docker/OrbStack provider
│   │   ├── src/provider.ts     # OrbStackProvider
│   │   └── src/sandbox.ts      # OrbStackSandbox
│   │
│   ├── sandbox-apple-container/ # macOS 26 native containers
│   │   ├── src/provider.ts     # AppleContainerProvider
│   │   └── src/sandbox.ts      # AppleContainerSandbox
│   │
│   ├── sandbox-boxlite/        # BoxLite micro-VM wrapper
│   │   ├── src/provider.ts     # BoxLiteProvider
│   │   └── src/sandbox.ts      # BoxLiteSandbox
│   │
│   └── sandbox-libkrun/        # Native libkrun bindings
│       ├── src/native/lib.rs   # Rust napi-rs bindings
│       ├── src/provider.ts     # LibkrunProvider
│       └── src/sandbox.ts      # LibkrunSandbox
│
├── apps/
│   └── benchmark/              # Benchmark CLI
│       └── src/
│           ├── cli.ts          # Command-line interface
│           ├── runner.ts       # Benchmark orchestration
│           └── scenarios/      # Benchmark scenarios
│
├── fixtures/
│   ├── docker/                 # Docker images
│   │   ├── Dockerfile.claude   # Sandbox image with SSH + Node
│   │   └── build.sh           # Image build script
│   └── agent-test/            # Test agent for validation
│
└── results/                    # Benchmark output
```

## Core Interface

All providers implement the same interface:

```typescript
interface ISandbox {
  readonly id: string;
  readonly sshPort: number;
  readonly mountPath: string;
  readonly provider: string;

  exec(cmd: string, args?: string[]): Promise<ExecResult>;
  sshExec(cmd: string): Promise<ExecResult>;
  getMetrics(): SandboxMetrics;
  stop(): Promise<void>;
  isRunning(): Promise<boolean>;
}

interface SandboxMetrics {
  startupMs: number;
  sshReadyMs: number;
  execLatencyMs: number;
  memoryBytes: number;
}
```

## Benchmark Scenarios

The benchmark suite tests:

1. **Cold startup** - Time from create() to sandbox ready
2. **SSH ready** - Time until SSH connection established
3. **Exec latency** - Round-trip for echo command
4. **SSH exec latency** - SSH command round-trip
5. **Node invocation** - `node --version` execution time
6. **Claude CLI** - `claude --version` execution time
7. **Memory usage** - Per-instance memory footprint
8. **Concurrent N** - Time to create N instances (5, 10)

Run benchmarks:
```bash
pnpm --filter @sandbox/benchmark benchmark -p orbstack,apple-container -i 20
```

## Recommendations

### For Development/Testing
**OrbStack** is the best choice:
- Easy setup with existing Docker knowledge
- Good performance for iterative development
- Wide compatibility

### For Production (macOS 26+)
**Apple Container** is recommended:
- Full VM isolation for security
- Native SSH support (agent forwarding works)
- Apple-supported, production-ready
- Sub-second startup

### For Maximum Performance
**BoxLite/libkrun** when available:
- Micro-VM isolation with minimal overhead
- Best startup times
- Purpose-built for AI agent sandboxing

## Quick Start

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Build Docker image for OrbStack
cd fixtures/docker && ./build.sh

# List available providers
pnpm --filter @sandbox/benchmark dev list-providers

# Run benchmarks
pnpm --filter @sandbox/benchmark benchmark -p orbstack -i 10
```

## Requirements

| Provider | Requirements |
|----------|-------------|
| OrbStack | OrbStack or Docker Desktop |
| Apple Container | macOS 26 (Tahoe) |
| BoxLite | Apple Silicon, private package access |
| libkrun | Rust, libkrun from source, Apple Silicon |

## Future Work

1. **vsock exec** - Implement direct command execution via vsock for libkrun
2. **Guest agent** - Build lightweight init system for micro-VMs
3. **Networking** - Add network isolation options
4. **Snapshots** - Implement VM state snapshots for fast restore
5. **Resource pools** - Pre-warm sandbox instances for instant availability
