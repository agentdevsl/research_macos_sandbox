# Sandbox Runtime Research: macOS Apple Silicon for AI Agent Workloads

**Date:** 2026-01-20
**Purpose:** Evaluate lightweight sandbox technologies for running AI agent workloads on macOS Apple Silicon (M-series)

---

## 1. Executive Summary

**Top Recommendation: BoxLite** — Purpose-built for AI agent sandboxing with hardware-level micro-VM isolation, existing Node.js SDK, and macOS 12+ compatibility. Uses libkrun (Hypervisor.framework) for true VM isolation per sandbox instance.

**Runner-up: OrbStack** — Best container-based solution with 2-second startup, excellent DX, and full Docker API compatibility via dockerode. Recommended if container-level isolation is acceptable.

**Strong Option: Apple Container** — Native Apple solution with optimal performance on macOS 26+. VM-per-container isolation, native SSH support, sub-second startup. Main gap: Swift-only API (no Node.js SDK).

**Eliminated Technologies:**

- **Firecracker**: No native macOS support (requires Linux KVM)
- **Podman**: Rosetta kernel bugs causing segfaults
- **Nomad**: Orchestrator overhead without solving runtime problem

---

## 2. Priority-Ranked Comparison Matrix

| Priority | Technology | macOS AS | Startup | Memory | Node.js SDK | Mounts | SSH | Isolation | Blockers |
| :------: | :--------- | :------: | :-----: | :----: | :---------: | :----: | :-: | :-------: | :------- |
| **1** | BoxLite | ✅ 12+ | ~2-5s | ~30MB | ✅ Native | ✅ virtiofs | ✅ exec | micro-VM | Private beta |
| **2** | Apple Container | ✅ 26+ | <1s | Light | ❌ Swift only | ✅ OCI | ✅ native | micro-VM | CLI wrapper needed |
| **3** | libkrun (direct) | ✅ 14+ | <1s | ~5MB | ❌ C API | ✅ virtiofs | ✅ vsock | micro-VM | Requires custom wrapper |
| **4** | OrbStack | ✅ 13+ | ~2s | <10MB | ✅ dockerode | ✅ VirtioFS | ✅ built-in | VM (VZ) | Paid commercial |
| **5** | Colima | ✅ 13+ | ~5-10s | 2GB | ✅ dockerode | ✅ VirtioFS | ✅ CLI | VM (VZ/QEMU) | CLI wrapper needed |
| **6** | Lima | ✅ 12+ | ~10-60s | 4GB | ⚠️ CLI wrap | ✅ SSHFS | ✅ built-in | VM | Slow startup |
| **7** | Docker Desktop | ✅ 13+ | ~10-30s | 2-4GB | ✅ dockerode | ✅ VirtioFS | ⚠️ exec | VM (VZ) | Resource heavy |
| ❌ | Firecracker | ❌ | <200ms | ~5MB | N/A | ✅ | ✅ | micro-VM | **No macOS** |
| ❌ | Podman | ⚠️ | ~10-20s | 2GB | ⚠️ | ✅ | ⚠️ | VM | Rosetta bugs |
| ❌ | Nomad | ⚠️ | N/A | N/A | ❌ | ⚠️ | ⚠️ | Varies | Mount issues |

**Legend:** ✅ Full support | ⚠️ Partial/caveats | ❌ Not supported

---

## 3. Detailed Analysis: Top Candidates

### 3.1 BoxLite (Priority 1 - Recommended)

**Overview:** Embedded micro-VM runtime following the "SQLite for sandboxing" philosophy—lightweight library embedded directly in applications without daemons or root.

| Attribute | Value |
| :-------- | :---- |
| GitHub | [boxlite-ai/boxlite](https://github.com/boxlite-ai/boxlite) |
| npm | `@boxlite-ai/boxlite` v0.1.6 |
| License | Apache-2.0 |
| Language | Rust (81%), Node.js bindings via napi-rs |
| Version | v0.5.3 |
| macOS | 12+ (Apple Silicon only) |

**Architecture:**

```text
Host Application
  └── BoxliteRuntime (Rust)
        ├── LiteBox instances (lazy initialized)
        └── ShimController
              └── boxlite-shim subprocess
                    └── libkrun VMM (Hypervisor.framework)
                          └── Micro-VM (Box)
                                └── Linux Kernel
                                      └── OCI Container
```

**Key Technical Details:**

- **Hypervisor:** libkrun (Rust VMM using Apple Hypervisor.framework)
- **Isolation:** True micro-VM per box (own kernel, not just namespaces)
- **Communication:** gRPC over vsock (port 2695)
- **Networking:** gvproxy (gVisor stack) or libslirp
- **GPU:** virtio-gpu passthrough (80% native LLM performance)

**Node.js SDK - Box Types:**

| Class | Purpose | Key Methods |
| :---- | :------ | :---------- |
| `SimpleBox` | Container execution | `exec()`, `stop()`, `info()` |
| `CodeBox` | Python sandbox | `run()`, `installPackage()` |
| `BrowserBox` | Browser automation | `start()`, `endpoint()` (CDP URL) |
| `ComputerBox` | Desktop automation | mouse, keyboard, screenshot (14 methods) |
| `InteractiveBox` | PTY sessions | Terminal emulation |

**Configuration Options:**

```typescript
interface BoxOptions {
  image: string;                      // OCI image e.g. 'node:20-alpine'
  memoryMib?: number;                 // RAM limit in MB
  cpus?: number;                      // CPU cores
  name?: string;                      // Identifier
  autoRemove?: boolean;               // Cleanup on stop (default: true)
  workingDir?: string;                // Working directory
  env?: Record<string, string>;       // Environment variables
  volumes?: VolumeMount[];            // Host-to-guest mounts
  ports?: PortMapping[];              // Port forwarding
}
```

**Usage Example:**

```typescript
import { SimpleBox } from '@boxlite-ai/boxlite';

async function runAgentSandbox(agentId: string, workspacePath: string) {
  const box = new SimpleBox({
    image: 'node:20-alpine',
    memoryMib: 512,
    cpus: 2,
    workingDir: '/workspace',
    volumes: [
      { hostPath: workspacePath, guestPath: '/workspace', readOnly: false }
    ],
    ports: [
      { hostPort: 0, guestPort: 22 }
    ]
  });

  try {
    const result = await box.exec('node', '/workspace/agent.js');
    console.log('Output:', result.stdout);
    console.log('Exit code:', result.exitCode);
  } finally {
    await box.stop();
  }
}
```

**Fork Feasibility:**

- **Complexity:** Medium
- **Effort:** 2-4 weeks for custom features
- **Pros:** Clean architecture, Apache-2.0, active development
- **Cons:** Requires Rust expertise, libkrun dependency

---

### 3.2 libkrun Direct (Priority 2 - Maximum Control)

**Overview:** Low-level Rust VMM library that BoxLite uses internally. Building directly on libkrun gives maximum control and minimal overhead, but requires more development effort.

| Attribute | Value |
| :-------- | :---- |
| GitHub | [containers/libkrun](https://github.com/containers/libkrun) |
| License | Apache-2.0 |
| Language | Rust (C API exposed) |
| Version | v1.0.0+ (stable API) |
| macOS | 14+ (Apple Silicon, Hypervisor.framework) |

**Architecture:**

```text
Your Application
  └── Node.js Native Addon (napi-rs)
        └── libkrun C API
              └── Apple Hypervisor.framework
                    └── Micro-VM
                          └── Linux Kernel
                                └── Your workload
```

**Key Features:**

- **Minimal Footprint:** Designed for smallest possible RAM, CPU, and boot time
- **Virtio Devices:** console, block, fs, gpu, net, vsock, balloon, rng, snd
- **Networking Options:**
  - TSI (Transparent Socket Impersonation) via vsock—no virtual interface needed
  - virtio-net with passt/gvproxy for conventional networking
- **GPU Passthrough:** virtio-gpu for 80% native LLM performance
- **Stable API:** v1.0.0 guarantees SemVer stability

**C API (from `include/libkrun.h`):**

```c
// Configuration
int32_t krun_set_root(uint32_t ctx_id, const char *root_path);
int32_t krun_set_vm_config(uint32_t ctx_id, uint8_t num_vcpus, uint32_t ram_mib);
int32_t krun_set_exec(uint32_t ctx_id, const char *exec_path, char *const argv[], char *const envp[]);

// Filesystem
int32_t krun_add_virtiofs(uint32_t ctx_id, const char *tag, const char *path);

// Networking
int32_t krun_add_net_unixstream(uint32_t ctx_id, const char *path);
int32_t krun_add_net_unixdgram(uint32_t ctx_id, const char *path);

// Execution
int32_t krun_start_enter(uint32_t ctx_id);  // Note: never returns!
```

**macOS EFI Variant:**

For running distribution kernels (not custom minimal kernels):

```text
libkrun-efi bundles OVMF/EDK2 firmware, enabling:
- Standard Linux distribution kernels
- Full virtio-gpu with Vulkan support
- Extended virtio-fs implementation
```

**Build Requirements (macOS):**

- Rust toolchain
- macOS 14 or newer
- Homebrew: `lld`, `xz`

**Node.js Integration Path:**

1. Create Rust wrapper using napi-rs
2. Expose async VM lifecycle (create, start, exec, stop)
3. Handle `krun_start_enter` process takeover via subprocess (like BoxLite does)
4. Implement gRPC over vsock for command execution

**Fork/Build Feasibility:**

- **Complexity:** High (but well-documented)
- **Effort:** 4-8 weeks for production-ready Node.js SDK
- **Pros:** Maximum control, minimal overhead, stable C API, Apache-2.0
- **Cons:** Significant development investment, must handle all VM lifecycle

**When to Choose libkrun Direct vs BoxLite:**

| Scenario | Choose |
| :------- | :----- |
| Need working solution now | BoxLite |
| Need maximum performance/control | libkrun direct |
| Want to avoid upstream dependency | libkrun direct |
| Limited Rust expertise | BoxLite |
| Custom guest init system | libkrun direct |

---

### 3.3 OrbStack (Priority 3 - Container Alternative)

**Overview:** Commercial macOS application providing Docker containers and Linux VMs with proprietary optimizations on Virtualization.framework.

| Attribute | Value |
| :-------- | :---- |
| Website | [orbstack.dev](https://orbstack.dev/) |
| License | Proprietary (paid for commercial) |
| macOS | 13+ (Apple Silicon) |

**Benchmarks ([source](https://orbstack.dev/docs/benchmarks)):**

- Startup: ~2 seconds
- Background CPU: <0.1%
- Disk footprint: <10MB base
- File I/O: 75-95% native speed via enhanced VirtioFS

**Programmatic Control:**

- Full Docker API via `/var/run/docker.sock`
- npm: `dockerode`
- Terraform: `robertdebock/orbstack`
- CLI: `orb`, `orbctl`

**Usage Example:**

```typescript
import Docker from 'dockerode';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

async function createSandbox(instanceId: string, mountPath: string) {
  const container = await docker.createContainer({
    Image: 'node:20-alpine',
    name: `agent-${instanceId}`,
    HostConfig: {
      Binds: [`${mountPath}:/workspace:rw`],
      Memory: 512 * 1024 * 1024,
    },
  });

  await container.start();
  return container;
}
```

**Verdict:** Best option if container isolation is sufficient. Faster startup than BoxLite but no hardware VM isolation per instance.

---

### 3.4 Colima (Priority 4 - Open Source Alternative)

**Overview:** Open-source container runtime built on Lima with Docker/containerd support.

| Attribute | Value |
| :-------- | :---- |
| GitHub | [abiosoft/colima](https://github.com/abiosoft/colima) |
| License | MIT |
| macOS | 13+ (Apple Silicon) |

**Optimal Configuration:**

```bash
colima start \
  --arch aarch64 \
  --vm-type vz \
  --vz-rosetta \
  --cpu 4 \
  --memory 4 \
  --disk 60 \
  --mount /tmp/workspaces:/workspaces:w \
  --mount-type virtiofs
```

**Programmatic Control:** Docker API via dockerode (same as OrbStack).

**Verdict:** Best free alternative to OrbStack. Requires CLI wrapper for VM lifecycle.

---

### 3.5 Apple Container (Strong Option - Native)

**Overview:** Apple's native containerization announced at WWDC 2025. Each container runs in its own lightweight VM.

| Attribute | Value |
| :-------- | :---- |
| CLI | [github.com/apple/container](https://github.com/apple/container) |
| Framework | [github.com/apple/containerization](https://github.com/apple/containerization) |
| License | Apache-2.0 |
| Language | Swift (100%) |
| Version | v0.7.1 |
| macOS | 26+ (Tahoe) - current |

**Architecture:**

- VM-per-container (same isolation as BoxLite)
- Sub-second startup claimed
- vminitd init system (Swift, gRPC over vsock)
- Requires Linux kernel 6.14.9+ with VIRTIO compiled in

**Limitation:** No Node.js SDK—Swift only. Requires CLI wrapper or native bindings for Node.js integration.

**Swift API Example:**

```swift
import Containerization

let container = try await Container(image: "node:20-alpine")
container.addVolume(hostPath: "/tmp/workspace", guestPath: "/workspace")
try await container.start()
let result = try await container.exec(["node", "--version"])
try await container.stop()
```

**Verdict:** Strong option now that macOS 26 is current. Main gap is lack of Node.js SDK—requires CLI wrapper or building native bindings.

---

### 3.6 Apple Container Deep Dive (Code Analysis)

**Source:** Analysis of [apple/container](https://github.com/apple/container) v0.7.1

#### Architecture Overview

```text
Docker approach:
  macOS → Single Linux VM → Multiple containers (shared kernel)

Apple Container approach:
  macOS → Lightweight VM #1 → Container #1 (isolated kernel)
        → Lightweight VM #2 → Container #2 (isolated kernel)
        → Lightweight VM #N → Container #N (isolated kernel)
```

Each container gets:
- **Isolated kernel** (not just namespaces)
- **Private filesystem**
- **Dedicated network namespace**
- **Full VM-level security boundary**

#### Project Structure

```text
container-submodule/
├── Sources/
│   ├── CLI/                          # Main CLI commands
│   │   ├── Commands/
│   │   │   ├── ContainerRun.swift    # `container run` command
│   │   │   ├── ContainerCreate.swift # `container create` command
│   │   │   ├── ImagePull.swift       # `container pull` command
│   │   │   └── ...
│   │   └── Client/
│   │       └── ClientContainer.swift # API client for containers
│   ├── Helpers/
│   │   ├── APIServer/                # XPC daemon managing containers
│   │   ├── RuntimeLinux/             # Per-container Linux runtime
│   │   ├── Images/                   # OCI image management
│   │   └── NetworkVmnet/             # Virtual networking
│   └── Common/
│       └── Configuration.swift       # ContainerConfiguration struct
├── Packages/
│   └── ContainerPlugin/              # Swift Package Plugin
└── docs/
    └── technical-overview.md         # Architecture docs
```

#### Key Components

| Component | Purpose |
|-----------|---------|
| `container` CLI | User-facing command line interface |
| `container-apiserver` | XPC daemon managing container lifecycle |
| `container-runtime-linux` | Per-container VM runtime helper |
| `container-core-images` | OCI image content store |
| `container-network-vmnet` | Virtual network management |

#### SSH Agent Forwarding (Native Support)

Apple Container has **built-in SSH agent forwarding** via the `--ssh` flag:

```bash
# Run with SSH agent socket forwarded into container
container run --ssh ubuntu:latest

# Inside container:
# - SSH_AUTH_SOCK is automatically set
# - Host SSH keys available for git, scp, etc.
```

**Implementation details:**
- SSH agent socket path is passed through container configuration
- Environment variable `SSH_AUTH_SOCK` set in guest
- Virtio-vsock used for socket communication

#### Resource Configuration

| Resource | Default | Flag | Notes |
|----------|---------|------|-------|
| CPU | 4 cores | `--cpus N` | Per-VM allocation |
| Memory | 1 GiB | `--memory Ng` | **On-demand** - not reserved |
| Storage | Dynamic | - | Grows as needed |
| Builder VM | 2 CPU, 2 GiB | Configurable | For image builds |

**Memory behavior:**
- Declaring `--memory 16g` does NOT consume 16GB immediately
- Application only uses actual required memory
- Partial memory ballooning on macOS (freed pages may not return immediately)

#### Running Claude Code

**Minimal footprint setup:**

```bash
# Minimal container with SSH support for Claude Code
container run -it \
  --memory 2g \
  --cpus 2 \
  --ssh \
  --volume /path/to/project:/workspace \
  -w /workspace \
  node:22-slim \
  npx @anthropic-ai/claude-code

# Or with explicit resource limits
container run -it \
  --memory 4g \
  --cpus 4 \
  --ssh \
  --rm \
  -v ~/projects:/projects \
  -w /projects \
  node:22-slim \
  claude
```

**Custom Claude Code image:**

```dockerfile
FROM node:22-slim

RUN apt-get update && apt-get install -y \
    git \
    openssh-client \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

WORKDIR /workspace
CMD ["claude"]
```

```bash
# Build and run
container build -t claude-code:latest .

container run -it --ssh --rm \
  -v ~/projects:/workspace \
  claude-code:latest
```

#### Full Configuration Reference

```bash
# Resource limits
--cpus 4              # CPU cores
--memory 4g           # RAM limit (on-demand allocation)

# SSH/Git support
--ssh                 # Forward SSH agent socket (CRITICAL for git)

# Filesystem
--volume /host:/container    # Mount host directories
--mount source=X,target=Y    # Alternative mount syntax
-w /working/dir              # Working directory
--read-only                  # Read-only root filesystem

# Network
-p 8080:8080                 # Port publishing
-p 127.0.0.1:8080:8000       # Bind to specific host IP
--network default            # Network attachment
--network foo,mac=XX:XX:...  # Custom MAC address

# Process
-e VAR=value          # Environment variables
--user root           # User to run as

# Interactive
-it                   # TTY + stdin (interactive mode)
-d                    # Detached mode (background)
--rm                  # Auto-remove on exit

# Architecture
--arch arm64          # Native ARM (default on Apple Silicon)
--arch amd64          # x86-64 via Rosetta translation
```

#### Performance Characteristics

**Startup:**
- Comparable to Docker despite per-VM approach
- Direct Virtualization.framework (no QEMU)
- Native macOS scheduling

**Monitoring:**

```bash
# Real-time stats
container stats

# JSON output for scripting
container stats --format json --no-stream

# Boot logs (startup timing analysis)
container logs --boot <container-id>
```

#### System Configuration

```bash
# View all properties
container system property list

# Configure defaults
container system property set build.rosetta false
container system property set network.subnet 192.168.100.1/24
container system property set network.subnetv6 fd00:abcd::/64
container system property set dns.domain example.local
container system property set image.init custom:latest
```

#### Comparison: Apple Container vs Docker Desktop

| Aspect | Apple Container | Docker Desktop |
|--------|-----------------|----------------|
| VM per container | Yes (isolated) | No (shared VM) |
| Security isolation | Full VM-level | Process-level |
| Memory overhead | Per-VM but on-demand | Shared kernel |
| SSH agent | Native `--ssh` flag | Socket mount required |
| macOS version | 26+ (current) | 12+ |
| Architecture | ARM64 native | ARM64 native |
| OCI compatible | Yes | Yes |
| Startup time | Fast | Fast |
| Node.js SDK | ❌ Swift only | ✅ dockerode |

#### Limitations

1. **Apple silicon only** - No Intel Mac support
2. **Memory ballooning partial** - May need container restart to reclaim memory
3. **Localhost access** - Use gateway IP (192.168.64.1) instead of localhost
4. **No Node.js SDK** - Swift/Objective-C only (requires CLI wrapper or native bindings)

#### File Structure

```text
~/.container/
├── containers/
│   └── {container-id}/
│       ├── config.json     # ContainerConfiguration
│       ├── rootfs/         # Image filesystem
│       └── vm/             # VM state
├── apiserver/
│   └── apiserver.plist
└── images/
    └── content store (OCI images)
```

#### Integration Path for Claude Code

For programmatic Node.js integration, options:

1. **CLI wrapper** - Shell out to `container` CLI (simplest)
2. **XPC bridge** - Build native Swift ↔ Node.js bridge via XPC
3. **Swift SDK** - Use `Containerization` Swift package directly

**CLI wrapper example:**

```typescript
import { spawn } from 'child_process';

async function runInContainer(
  image: string,
  command: string[],
  options: {
    memory?: string;
    cpus?: number;
    ssh?: boolean;
    volumes?: Array<{ host: string; guest: string }>;
    workdir?: string;
  }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const args = ['run', '--rm'];

  if (options.memory) args.push('--memory', options.memory);
  if (options.cpus) args.push('--cpus', String(options.cpus));
  if (options.ssh) args.push('--ssh');
  if (options.workdir) args.push('-w', options.workdir);

  for (const vol of options.volumes ?? []) {
    args.push('--volume', `${vol.host}:${vol.guest}`);
  }

  args.push(image, ...command);

  return new Promise((resolve, reject) => {
    const proc = spawn('container', args);
    let stdout = '', stderr = '';

    proc.stdout.on('data', (d) => stdout += d);
    proc.stderr.on('data', (d) => stderr += d);
    proc.on('close', (exitCode) => {
      resolve({ stdout, stderr, exitCode: exitCode ?? 0 });
    });
    proc.on('error', reject);
  });
}

// Usage for Claude Code
await runInContainer('node:22-slim', ['npx', '@anthropic-ai/claude-code'], {
  memory: '4g',
  cpus: 4,
  ssh: true,
  volumes: [{ host: '/Users/me/project', guest: '/workspace' }],
  workdir: '/workspace',
});
```

---

### 3.7 Single VM + tmux Isolation (Lightweight Alternative)

**Overview:** Instead of multiple VMs/containers, run a single VM with tmux sessions for process-level isolation. Significantly lower overhead with acceptable isolation for many use cases.

#### Architecture

```text
Multiple VMs/Containers approach:
  macOS → VM #1 → Agent #1
        → VM #2 → Agent #2
        → VM #N → Agent #N
  (100MB+ per instance, 2-5s startup)

Single VM + tmux approach:
  macOS → Single VM → tmux-server
                        ├── Socket #1 → Session #1 → Agent #1
                        ├── Socket #2 → Session #2 → Agent #2
                        └── Socket #N → Session #N → Agent #N
  (~5MB per session, <100ms startup)
```

#### Comparison

| Aspect | Multiple VMs | Single VM + tmux |
|--------|-------------|------------------|
| Isolation level | Full VM (kernel) | Process-level |
| Memory per instance | 100MB+ | ~5MB |
| Startup time | 2-5 seconds | <100ms |
| Filesystem isolation | Complete | Shared (use separate dirs) |
| Network isolation | Per-VM | Shared (same IP) |
| Resource limits | Native | Via systemd scopes |
| SSH agent | Per-VM setup | Single forward, all sessions |
| Complexity | Higher | Lower |

#### When to Use tmux vs VMs

| Scenario | Recommendation |
|----------|----------------|
| Trusted agents, same user | ✅ tmux |
| Untrusted/adversarial agents | ❌ Use VMs |
| Cost-sensitive (many instances) | ✅ tmux |
| Strong security boundary needed | ❌ Use VMs |
| Fast startup critical | ✅ tmux |
| Network isolation required | ❌ Use VMs |

#### Implementation

**Per-agent socket for complete environment isolation:**

```bash
# Create agent session with dedicated socket
AGENT_ID="agent-1"
AGENT_SOCKET="/run/tmux/claude-${AGENT_ID}.sock"

tmux -S "$AGENT_SOCKET" new-session -d -s "$AGENT_ID" \
  -c "/workspace/$AGENT_ID" \
  -e "AGENT_ID=$AGENT_ID" \
  -e "CLAUDE_HOME=$HOME/.claude/$AGENT_ID"
```

**Resource limits via systemd scopes (Linux):**

```bash
# Run with memory and CPU limits
systemd-run --scope -u claude-agent-1 \
  -p MemoryMax=2G \
  -p CPUQuota=200% \
  tmux -S /run/tmux/agent-1.sock new-session -d -s agent-1 \
    -c /workspace/agent-1 \
    'npm start 2>&1 | tee /var/log/agent-1.log'
```

**SSH agent forwarding (single setup for all sessions):**

```bash
# SSH into VM with agent forwarding
ssh -A user@vm

# Inside VM, all tmux sessions inherit SSH_AUTH_SOCK
tmux new-session -d -s agent-1 -c /workspace/agent-1
tmux send-keys -t agent-1 'git clone git@github.com:user/repo.git' Enter
```

**Output capture:**

```bash
# Capture last 100 lines from pane
tmux -S /run/tmux/agent-1.sock capture-pane -t agent-1 -p -S -100

# Or redirect at session creation
tmux new-session -d -s agent-1 \
  'npm start 2>&1 | tee /var/log/agent-1.log'
```

**Session cleanup:**

```bash
# Graceful stop (Ctrl-C)
tmux -S /run/tmux/agent-1.sock send-keys -t agent-1 C-c
sleep 2

# Kill session and process tree
tmux -S /run/tmux/agent-1.sock kill-session -t agent-1
```

#### Node.js Orchestrator

```typescript
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface AgentConfig {
  id: string;
  workdir: string;
  memoryLimit?: string;  // e.g., "2G"
  cpuQuota?: string;     // e.g., "200%"
}

class TmuxAgentOrchestrator {
  private socketDir = '/run/tmux';
  private logsDir = '/var/log/claude-agents';

  private socketPath(agentId: string): string {
    return `${this.socketDir}/claude-${agentId}.sock`;
  }

  async createAgent(config: AgentConfig): Promise<void> {
    const { id, workdir, memoryLimit = '2G', cpuQuota = '200%' } = config;
    const socket = this.socketPath(id);

    // With systemd resource limits (Linux)
    const cmd = `
      systemd-run --scope -u claude-agent-${id} \
        -p MemoryMax=${memoryLimit} \
        -p CPUQuota=${cpuQuota} \
        tmux -S ${socket} new-session -d -s ${id} \
          -c ${workdir} \
          -e AGENT_ID=${id} \
          'claude 2>&1 | tee ${this.logsDir}/${id}.log'
    `;

    await execAsync(cmd);
  }

  async sendCommand(agentId: string, command: string): Promise<void> {
    const socket = this.socketPath(agentId);
    await execAsync(
      `tmux -S ${socket} send-keys -t ${agentId} ${JSON.stringify(command)} Enter`
    );
  }

  async captureOutput(agentId: string, lines = 100): Promise<string> {
    const socket = this.socketPath(agentId);
    const { stdout } = await execAsync(
      `tmux -S ${socket} capture-pane -t ${agentId} -p -S -${lines}`
    );
    return stdout;
  }

  async stopAgent(agentId: string): Promise<void> {
    const socket = this.socketPath(agentId);

    // Graceful shutdown
    await execAsync(`tmux -S ${socket} send-keys -t ${agentId} C-c`).catch(() => {});
    await new Promise(r => setTimeout(r, 2000));

    // Force kill
    await execAsync(`tmux -S ${socket} kill-session -t ${agentId}`).catch(() => {});
  }

  async listAgents(): Promise<string[]> {
    const { stdout } = await execAsync(`ls ${this.socketDir}/claude-*.sock 2>/dev/null || true`);
    return stdout.trim().split('\n')
      .filter(Boolean)
      .map(s => s.replace(`${this.socketDir}/claude-`, '').replace('.sock', ''));
  }
}

// Usage
const orchestrator = new TmuxAgentOrchestrator();

await orchestrator.createAgent({
  id: 'agent-1',
  workdir: '/workspace/project-a',
  memoryLimit: '4G',
});

await orchestrator.sendCommand('agent-1', 'npm install');
const output = await orchestrator.captureOutput('agent-1');
console.log(output);

await orchestrator.stopAgent('agent-1');
```

#### Running Claude Code with tmux

**Setup single VM (Apple Container):**

```bash
# Start VM with SSH support
container run -it --ssh --memory 8g --cpus 4 \
  -v ~/projects:/workspace \
  --name claude-vm \
  ubuntu:latest

# Inside VM, install dependencies
apt-get update && apt-get install -y tmux nodejs npm git
npm install -g @anthropic-ai/claude-code
```

**Run multiple Claude Code instances:**

```bash
# Agent 1 - Project A
tmux -S /run/tmux/agent-1.sock new-session -d -s agent-1 \
  -c /workspace/project-a \
  -e AGENT_ID=agent-1 \
  'claude'

# Agent 2 - Project B
tmux -S /run/tmux/agent-2.sock new-session -d -s agent-2 \
  -c /workspace/project-b \
  -e AGENT_ID=agent-2 \
  'claude'

# Attach to agent 1
tmux -S /run/tmux/agent-1.sock attach -t agent-1
```

#### Limitations

1. **No filesystem isolation** - Agents can access each other's files (use permissions/directories)
2. **Shared network** - Same IP, can't have port conflicts
3. **Process-level only** - Malicious agent could affect others
4. **Linux-specific** - systemd scopes for resource limits
5. **Manual cleanup** - Must handle zombie processes

#### Verdict

**Use tmux isolation when:**
- Running trusted Claude Code instances
- Need many lightweight agents (10+)
- Fast startup is critical (<100ms)
- Single VM is acceptable
- SSH agent sharing is beneficial

**Use VMs/containers when:**
- Running untrusted code
- Need network isolation
- Strong security boundaries required
- Compliance requirements mandate isolation

---

## 4. Eliminated Technologies

### Firecracker

- **Blocker:** No macOS support—requires Linux KVM
- **Source:** [GitHub Issue #2845](https://github.com/firecracker-microvm/firecracker/issues/2845)

### Podman

- **Blocker:** Rosetta broken with kernel 6.13+, causing segfaults
- **Source:** [DevClass](https://devclass.com/2025/06/11/apples-containerization-will-matter-to-developers-but-podman-devs-complain-of-unfixed-issues/)

### HashiCorp Nomad

- **Blocker:** VirtioFS mount permission errors, limited drivers on macOS
- **Source:** [HashiCorp Support](https://support.hashicorp.com/hc/en-us/articles/41463725654291)

### Virtualization.framework Direct

- **Blocker:** Swift/Objective-C only, no Node.js bindings
- **Better Alternative:** Use BoxLite or OrbStack which wrap this

---

## 5. Recommendation Summary

### Immediate Action (2026 Q1-Q2)

**Option A: Fork BoxLite** (Fastest path)

1. Fork [boxlite-ai/boxlite](https://github.com/boxlite-ai/boxlite)
2. Customize for Claude Agent SDK:
   - SSH key injection
   - Enhanced networking isolation
   - Custom mount management
3. Timeline: 4-6 weeks to production

**Option B: Build on libkrun** (Maximum control)

1. Build Node.js bindings on [containers/libkrun](https://github.com/containers/libkrun)
2. Implement custom guest init and exec protocol
3. Timeline: 6-10 weeks to production
4. Benefit: No upstream dependency, full control

**Fallback: OrbStack + dockerode**

- If VM isolation proves unnecessary
- Faster integration (days, not weeks)
- Trade-off: Container isolation vs VM isolation

### Consider Now: Apple Container

**Apple Container is viable today:**

- macOS 26 is current
- Native SSH support (`--ssh` flag)
- Sub-second startup, minimal footprint
- Full VM isolation per container

**Integration options:**
1. CLI wrapper (simplest - shell out to `container` command)
2. Build napi-rs bindings to Swift/XPC APIs
3. Use alongside BoxLite for comparison

---

## 6. Quick Start Commands

### BoxLite

```bash
npm install @boxlite-ai/boxlite
```

### OrbStack

```bash
brew install orbstack
npm install dockerode
```

### Colima

```bash
brew install colima docker
colima start --vm-type vz --vz-rosetta --cpu 4 --memory 4
npm install dockerode
```

---

## 7. Sources

### BoxLite

- [GitHub Repository](https://github.com/boxlite-ai/boxlite)

### libkrun

- [GitHub Repository](https://github.com/containers/libkrun)
- [GPU Acceleration Blog](https://sinrega.org/2024-03-06-enabling-containers-gpu-macos/)
- [krunkit (macOS VM manager)](https://github.com/containers/krunkit)

### OrbStack

- [Documentation](https://orbstack.dev/docs)
- [Benchmarks](https://orbstack.dev/docs/benchmarks)

### Colima

- [GitHub Repository](https://github.com/abiosoft/colima)

### Apple Container

- [container CLI](https://github.com/apple/container)
- [containerization Swift Package](https://github.com/apple/containerization)
- [WWDC 2025 Session](https://developer.apple.com/videos/play/wwdc2025/346/)

### Lima

- [GitHub Repository](https://github.com/lima-vm/lima)
- [Lima v2.0 Announcement](https://www.cncf.io/blog/2025/12/11/lima-v2-0-new-features-for-secure-ai-workflows/)

### Docker Desktop

- [Performance Optimizations](https://www.docker.com/blog/what-are-the-latest-docker-desktop-enterprise-grade-performance-optimizations/)

### Dockerode

- [npm Package](https://www.npmjs.com/package/dockerode)
- [GitHub](https://github.com/apocas/dockerode)
