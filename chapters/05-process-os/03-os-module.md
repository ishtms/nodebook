---
title: "The os Module"
date: "2026-02-22"
excerpt: "The os module for system introspection -- CPU info, memory, network interfaces, and platform detection."
category: "Process & OS"
tags: ["nodejs", "os-module", "cpu", "memory", "network-interfaces", "platform"]
author: "Ishtmeet Singh @ishtms"
chapter: "process-os"
subchapter: "os-module"
published: true
toc: true
---

`require('node:os')` gives you the machine. The process object (covered in the first subchapter) tells you about your running program - pid, memory usage, environment. The os module tells you about the hardware and operating system underneath it. CPU cores, total RAM, network interfaces, platform identifiers, kernel version. System-level introspection.

```js
const os = require('node:os');
```

One import, and you have access to everything the kernel exposes about the host. Most of these functions are thin wrappers around libuv calls, which are themselves thin wrappers around platform-specific syscalls. The data is live - every call reads fresh values from the kernel. There's no caching layer. Call `os.freemem()` twice a second apart and you'll get two different numbers if anything allocated or freed memory in between.

The os module contains about two dozen functions and a handful of constants. Some are one-liners you'll call once during startup. Others - CPU info, memory stats, load average - show up in monitoring dashboards, health check endpoints, and capacity planning scripts. I'll go through all of them, starting with the ones that carry the most depth.

## CPU Information

`os.cpus()` returns an array of objects, one per logical CPU core.

```js
const cpus = os.cpus();
console.log(cpus.length);
console.log(cpus[0]);
```

The output looks something like this:

```js
{
  model: 'Apple M1 Pro',
  speed: 2400,
  times: { user: 483200, nice: 0, sys: 198300, idle: 2918400, irq: 0 }
}
```

The `model` string comes straight from the kernel. `speed` is in MHz - megahertz, the base clock frequency. And `times` is where it gets interesting - five fields, all in milliseconds, representing how much time that core has spent in each state since boot.

`user` is time spent running user-space code. Your application, Node.js itself, anything that isn't kernel code. `sys` is kernel-space time - syscalls, scheduling, context switches, interrupt handlers, device drivers. `idle` is exactly what it sounds like: the core sat there doing nothing, waiting for work. `nice` tracks time spent on low-priority processes - ones that have been "niced" to yield CPU time to others. On Windows, `nice` is always 0. `irq` measures time spent handling hardware interrupts: disk controllers signaling I/O completion, network cards announcing incoming packets, timer interrupts from the programmable interval timer.

The word "logical" matters here. On a machine with 8 physical cores and hyperthreading enabled, `os.cpus()` returns 16 entries. Each physical core runs two hardware threads simultaneously, sharing the core's execution units. The kernel exposes each hardware thread as a separate logical CPU. If you're trying to determine actual physical core count, `os.cpus().length` overcounts on hyperthreaded machines. Apple Silicon is different - M-series chips have performance cores and efficiency cores, all reported individually, but there's no hyperthreading. An M1 Pro with 8 performance cores and 2 efficiency cores returns 10 entries.

The `speed` field has its own quirks. On Intel chips with Turbo Boost or AMD with Precision Boost, the reported frequency is the base clock, not the boost clock. Your CPU might be running at 4.8 GHz under load while `os.cpus()` reports 2400 MHz. On Apple Silicon, the reported speed is the performance core frequency. Efficiency cores run slower, but every entry in the array shows the same speed value regardless of core type. The field is an approximation at best.

### Calculating CPU Usage

A single snapshot of `os.cpus()` tells you totals since boot. That's useless for "what is the CPU doing right now." You need two snapshots, then compute the delta.

```js
function cpuAverage() {
  const cpus = os.cpus();
  let idle = 0, total = 0;
  for (const { times: t } of cpus) {
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle: idle / cpus.length, total: total / cpus.length };
}
```

Take two readings a second apart, subtract the first from the second, and you get the delta:

```js
const start = cpuAverage();
setTimeout(() => {
  const end = cpuAverage();
  const idleDiff = end.idle - start.idle;
  const totalDiff = end.total - start.total;
  console.log(`CPU usage: ${(100 - (idleDiff / totalDiff) * 100).toFixed(1)}%`);
}, 1000);
```

The math: total time minus idle time equals busy time. Divide busy by total, multiply by 100. The wider your sampling interval, the smoother the reading. A 1-second interval is fine for monitoring dashboards. For real-time alerting, 5-second intervals smooth out spikes that would trigger false alarms.

You can also compute per-core usage instead of averaging across all cores. That's more revealing - a single-threaded workload might pin one core at 100% while the others sit idle, and an average would show only 6% utilization on a 16-core machine. Per-core deltas catch that.

```js
function perCoreDelta(prev, curr) {
  return curr.map((cpu, i) => {
    const p = prev[i].times, c = cpu.times;
    const idle = c.idle - p.idle;
    const total = (c.user + c.sys + c.idle + c.nice + c.irq) -
                  (p.user + p.sys + p.idle + p.nice + p.irq);
    return ((1 - idle / total) * 100).toFixed(1);
  });
}
```

This gives you an array of per-core percentages. Useful for detecting thread pinning issues or understanding how well your workload distributes across cores.

## os.availableParallelism()

Added in Node 19.4 and backported to 18.14. This function returns how many threads the runtime can actually use for parallel work.

```js
os.availableParallelism(); // 4 (inside a container limited to 4 cores)
os.cpus().length;          // 64 (the host machine has 64 cores)
```

On bare metal, these two numbers are usually identical. Inside containers, they diverge dramatically. `os.cpus().length` always reports the host machine's total logical CPUs, even inside a container with a cgroup CPU limit. `os.availableParallelism()` respects cgroup constraints and CPU quota settings.

If you're sizing thread pools or worker counts, `os.availableParallelism()` is the right number. Using `os.cpus().length` inside a container allocated 2 CPUs would give you 64 threads competing for 2 cores - thrashing instead of parallelism. This matters for libuv's thread pool (covered in Chapter 1) too. The default `UV_THREADPOOL_SIZE` of 4 works well for 4+ cores, but if your container only has 1 CPU, even 4 threads create unnecessary context switching.

Under the hood, this calls libuv's `uv_available_parallelism()`, which reads `/sys/fs/cgroup/cpu.max` (cgroups v2) or `/sys/fs/cgroup/cpu/cpu.cfs_quota_us` (cgroups v1) on Linux, falls back to `sched_getaffinity()`, and finally `sysconf(_SC_NPROCESSORS_ONLN)`. On macOS it uses `sysconf(_SC_NPROCESSORS_ONLN)`. On Windows, `GetActiveProcessorCount(ALL_PROCESSOR_GROUPS)`.

The cgroup path is worth understanding. In cgroups v2, `/sys/fs/cgroup/cpu.max` contains two numbers separated by a space: `quota period`. A container with a 2-CPU limit might have `200000 100000`, meaning 200,000 microseconds of CPU time per 100,000 microseconds of wall time - two cores' worth. libuv divides quota by period and rounds up to get the parallelism count. If the quota is `max` (unlimited), it falls through to the affinity or online CPU count.

## System-Level vs Process-Level Memory

`os.totalmem()` returns total system RAM in bytes. `os.freemem()` returns how much is available.

```js
const total = os.totalmem();
const free = os.freemem();
const usedPct = ((1 - free / total) * 100).toFixed(1);
console.log(`${usedPct}% memory used`);
```

These are system-wide numbers. `process.memoryUsage()` (covered in the first subchapter) reports your Node process's own RSS, heap, and external memory. Completely different scope. `os.freemem()` tells you about the entire machine; `process.memoryUsage().rss` tells you about your process alone.

The meaning of "free" varies across operating systems, and the differences are worth knowing.

On Linux, `os.freemem()` reads `MemAvailable` from `/proc/meminfo`. This is the kernel's estimate of how much memory can be made available for starting new applications, accounting for page cache and reclaimable slab memory that the kernel can reclaim under pressure. It's a better number than `MemFree`, which only counts genuinely unused pages - pages that have never been allocated or have been explicitly freed. A Linux machine might show 200 MB `MemFree` but 8 GB `MemAvailable` because the kernel is using the rest for disk cache that it'll release when an application needs RAM.

Why does this matter? Because if you're building a health check that alerts when "free memory drops below 500 MB," you need to know which "free" you're measuring. `MemFree` on a busy Linux server is almost always tiny. That's normal - the kernel fills unused RAM with disk cache because empty RAM is wasted RAM. `MemAvailable` is the honest number for capacity monitoring.

On macOS, the underlying call queries the Mach VM subsystem. macOS categorizes memory into four buckets: wired (kernel data, pinned in RAM permanently), active (recently accessed), inactive (cached but reclaimable), and free (never allocated). libuv adds inactive and free together, because inactive pages are available for new allocations - the kernel just hasn't reclaimed them yet. On Windows, `GlobalMemoryStatusEx` reports `ullAvailPhys`, which already accounts for reclaimable cache.

`os.totalmem()` is more predictable. It's the physically installed RAM as seen by the OS. On a 16 GB machine, you get something close to 16 GB - firmware and hardware reservations eat a few hundred megabytes, so you might see 16,384 MB minus 300-500 MB.

### Memory in Containers

There's an asymmetry in the os module's container awareness. `os.availableParallelism()` respects cgroup CPU limits. But `os.totalmem()` and `os.freemem()` report the host machine's numbers even inside a container with a 512 MB memory limit. Your container might be allowed 512 MB, but `os.totalmem()` returns 64 GB because that's what the host has.

Node.js does have internal awareness of the cgroup memory limit - the `-max-old-space-size` flag's automatic adjustment uses it. But the `os` module doesn't expose it. If you need the container's actual memory ceiling, you read `/sys/fs/cgroup/memory.max` (cgroups v2) or `/sys/fs/cgroup/memory/memory.limit_in_bytes` (cgroups v1) directly.

```js
const fs = require('node:fs');
function getContainerMemLimit() {
  try {
    const raw = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
    return raw === 'max' ? os.totalmem() : parseInt(raw, 10);
  } catch { return os.totalmem(); }
}
```

This tries cgroups v2 first, falls back to total system memory outside a container or on non-Linux platforms. `process.constrainedMemory()` (added in Node 19.6) is the official API for this - it returns the cgroup memory limit if available, or `undefined` if unconstrained. In production monitoring, comparing `process.memoryUsage().rss` against `process.constrainedMemory()` gives you actual memory pressure relative to the container limit, which is far more useful than comparing against `os.totalmem()` when your container has 512 MB inside a 64 GB host.

## Load Average

```js
os.loadavg(); // [1.34, 2.01, 1.87]
```

Three numbers: the 1-minute, 5-minute, and 15-minute exponentially-weighted moving averages. On Windows, this always returns `[0, 0, 0]` because Windows has no equivalent kernel metric.

Load average measures demand on the system's computing resources. It counts the average number of processes in two states: running on a CPU (actually executing instructions) and waiting in the run queue (runnable but waiting for a free core). Linux also includes processes in uninterruptible sleep - typically disk I/O waits where the process is blocked on a syscall that can't be interrupted. This is a Linux-specific quirk. Other Unix systems (FreeBSD, macOS) only count runnable processes in load average.

The Linux inclusion of I/O-waiting processes means load average on Linux is a measure of total system demand, including I/O pressure. A machine doing heavy disk I/O might show high load average with low CPU usage. On macOS, the same workload would show lower load average because the I/O-blocked processes aren't counted.

How to interpret the numbers: compare the load average to your CPU count. On a 4-core machine, a load average of 4.0 means every core is fully occupied with zero queue depth. A load average of 8.0 means on average, 4 processes are running and 4 more are waiting for a core. Below 4.0, the machine has spare capacity.

```js
const load1m = os.loadavg()[0];
const cpuCount = os.availableParallelism();
const ratio = load1m / cpuCount;
```

A `ratio` above 1.0 means the run queue is backed up. Above 0.7 is where you'd start watching more carefully in my experience. Below 0.3 and the machine is mostly idle. These are rough guidelines - the "right" threshold depends on the workload. I/O-heavy workloads tolerate higher load averages because much of the "load" is processes sleeping on disk, not actively consuming CPU cycles.

The 15-minute average smooths out short spikes. If the 1-minute average is 12.0 but the 15-minute is 2.0, you're looking at a transient burst. If all three are climbing steadily, the load increase is sustained. If the 1-minute is dropping while the 15-minute is high, the spike has passed and the average is decaying back down. The exponential weighting means recent seconds contribute more than older seconds within each window.

The kernel updates load average every 5 seconds on Linux. Between updates, the value is stale. That 1-minute average isn't actually recalculated every second - it's a decaying exponential with a time constant of 1 minute, sampled every 5 seconds. Precisely: `load(t) = load(t-1) * exp(-5/60) + n * (1 - exp(-5/60))`, where `n` is the current number of runnable+uninterruptible processes. The 5-minute and 15-minute averages use the same formula with different time constants.

On macOS, the kernel calculates load average similarly but uses the Mach scheduler's run queue depth. The sampling interval and decay constants differ slightly from Linux, so comparing load averages between a Linux server and a macOS development machine isn't strictly apples to apples (different kernel accounting, different processes included). Use load average for trends on the same machine, not for cross-platform comparisons.

## Network Interfaces

`os.networkInterfaces()` returns an object keyed by interface name. Each value is an array of address objects - an array because a single interface often has both IPv4 and IPv6 addresses, and sometimes multiple of each.

```js
const interfaces = os.networkInterfaces();
console.log(Object.keys(interfaces));
// ['lo0', 'en0', 'en1', 'utun0', 'awdl0', 'bridge0']
```

The interface names are OS-specific. `en0` is typically the primary network interface on macOS (Wi-Fi or Ethernet). On Linux, you might see `eth0`, `ens3`, `wlp2s0`, or `enp0s25` depending on the kernel's naming scheme. `lo0` or `lo` is the loopback interface. `utun` interfaces on macOS are VPN tunnels. `docker0` appears on hosts running Docker. `veth` prefixed interfaces are virtual ethernet pairs connecting containers to bridges.

Each address object in those arrays has these fields:

```js
{
  address: '192.168.1.42',
  netmask: '255.255.255.0',
  family: 'IPv4',
  mac: 'a4:83:e7:2b:1f:c0',
  internal: false,
  cidr: '192.168.1.42/24'
}
```

`internal` is `true` for loopback interfaces (127.0.0.1, ::1). `family` is either `'IPv4'` or `'IPv6'`. The `cidr` string combines the address and subnet prefix length. `mac` is the hardware MAC address as a colon-separated hex string. `scopeid` appears on IPv6 link-local addresses - it's a numeric identifier indicating which interface the address is scoped to, since link-local addresses (fe80::) are interface-specific.

A common task: finding the machine's external IPv4 address.

```js
function getExternalIPv4() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
}
```

This grabs the first non-internal IPv4 address it finds. On machines with multiple network interfaces, the order isn't guaranteed - you might get a Docker bridge IP instead of your LAN IP. For more control, filter by interface name, or prefer addresses in a specific subnet range. Servers with bonded interfaces, VPN tunnels, or Docker bridge networks will have multiple non-internal addresses, and which one comes first depends on the kernel's enumeration order.

`os.networkInterfaces()` returns only interfaces that have been assigned an address. An ethernet port that's physically connected but hasn't gotten a DHCP lease won't show up. Interfaces that are administratively down also don't appear. And the data is a snapshot - if a DHCP lease renews with a different IP after you called the function, your cached result is stale.

The MAC address (`mac`) deserves a note. It's reported as `'00:00:00:00:00:00'` for loopback interfaces. Some virtual interfaces (tun/tap, VPN tunnels) also report all zeros. On bare metal, the MAC address is burned into the network card's firmware. In virtual machines and containers, the hypervisor or container runtime assigns a virtual MAC. Docker generates MAC addresses from a pool based on the container ID. If you're using MAC addresses for hardware fingerprinting or license enforcement, virtual and containerized environments will defeat you.

IPv6 entries are common in the output even if you're not actively using IPv6. Most modern operating systems auto-configure link-local IPv6 addresses (fe80:: prefix) on every active interface. These are derived from the MAC address using the EUI-64 algorithm (or a random token on privacy-enabled systems). You'll typically see at least two entries per physical interface: one IPv4 and one IPv6 link-local.

## Platform and Architecture

Several functions return strings identifying the system. They overlap in what they describe, but each pulls from a different source.

`os.platform()` returns the same value as `process.platform`: `'linux'`, `'darwin'`, `'win32'`, `'freebsd'`, `'openbsd'`, `'sunos'`, `'aix'`. This is the platform Node was compiled for, baked in at build time as a compile-time constant.

`os.type()` calls `uname()` on Unix systems and returns the system name. On Linux it returns `'Linux'`. On macOS, `'Darwin'`. On Windows, `'Windows_NT'`. The difference from `os.platform()`: `os.type()` is a runtime syscall result, while `os.platform()` is a compile-time constant. In practice, they agree. But `os.type()` returns the conventional uname output (`'Darwin'`, capital D) while `os.platform()` returns Node's normalized identifier (`'darwin'`, lowercase).

`os.arch()` returns the CPU architecture: `'x64'`, `'arm64'`, `'ia32'`, `'arm'`, `'s390x'`, `'ppc64'`, `'mips'`, `'riscv64'`. Same value as `process.arch`. Also a compile-time constant - it's the architecture Node was built to target.

`os.machine()` was added in Node 18.9. It calls `uname()` and returns the machine hardware name - the raw kernel value with no normalization. On Apple Silicon Macs, `os.arch()` returns `'arm64'` and `os.machine()` returns `'arm64'` too. On an x86_64 Linux box, `os.arch()` returns `'x64'` but `os.machine()` returns `'x86_64'`. The naming conventions differ: Node normalizes architecture names into its own vocabulary, but `os.machine()` gives you whatever the kernel reports verbatim.

```js
console.log(os.platform()); // 'darwin'
console.log(os.type());     // 'Darwin'
console.log(os.arch());     // 'arm64'
console.log(os.machine());  // 'arm64'
```

`os.release()` returns the kernel version string. On Linux, something like `'5.15.0-76-generic'`. On macOS, `'23.1.0'` (the Darwin kernel version, which doesn't correspond to the macOS marketing version like "Sonoma 14.1"). On Windows, `'10.0.22621'`.

`os.version()` (added in Node 13) returns the full OS version string. On macOS: `'Darwin Kernel Version 23.1.0: Mon Oct  9 21:27:27 PDT 2023; root:xnu-10002.41.9~6/RELEASE_ARM64_T6000'`. On Linux: `'#86-Ubuntu SMP Mon Oct 2 14:52:20 UTC 2023'`. More detail than `os.release()`, more noise too. The Linux version string includes the build number and compiler flags but doesn't include the distribution name - you won't find "Ubuntu" or "Debian" in `os.version()`. That information lives in `/etc/os-release`, which you'd read with `fs.readFileSync()` if you need it.

One gotcha with Windows version detection: `os.release()` returns `'10.0.22621'` for both Windows 10 and Windows 11. Microsoft changed the marketing name but kept the internal version number at 10.0.x. Windows 11 is identified by build numbers 22000 and above, but there's no clean way to detect "Windows 11" from `os.release()` alone. `os.version()` on Windows returns `'Windows 10 Pro'` or `'Windows 11 Home'` - that's the marketing version string that libuv extracts from the Windows Registry, which is more useful for display purposes.

When do you actually use these? Platform detection for conditional code paths. Loading platform-specific native binaries. Logging system info at startup for debugging production issues. Generating user-agent strings. Building CLI tools that behave differently on Windows vs Unix.

```js
const binPath = `./vendor/${os.platform()}-${os.arch()}/tool`;
```

This pattern - combining `os.platform()` and `os.arch()` into a path segment - is how tools like `esbuild` and `swc` distribute pre-built binaries. Each platform-architecture combination gets its own directory or npm optional dependency. `esbuild-darwin-arm64`, `esbuild-linux-x64`, and so on.

## System Paths and Identity

`os.hostname()` returns the system hostname. On most Unix systems, this matches what the `hostname` command prints. On cloud instances, it's often the instance ID or a generated name like `ip-10-0-1-43.ec2.internal`. In Kubernetes pods, it defaults to the pod name.

```js
os.hostname(); // 'macbook-pro.local'
```

The underlying implementation calls `uv_os_gethostname()`, which wraps `gethostname()` on Unix and `GetComputerNameExW()` on Windows. The hostname can change while the process is running (rare, but possible via `hostname` command or DHCP), and `os.hostname()` returns the current value each time you call it.

`os.homedir()` returns the current user's home directory. On Unix, it reads the `HOME` environment variable first, falling back to the password database entry via `getpwuid_r()`. On Windows, it reads `USERPROFILE`, falling back to `HOMEDRIVE` + `HOMEPATH`. The environment variable takes precedence, which means a modified `HOME` changes what `os.homedir()` returns.

`os.tmpdir()` returns the default directory for temporary files. On Unix, it checks `TMPDIR`, `TMP`, `TEMP` environment variables in that order, defaulting to `/tmp`. On Windows, it checks `TEMP`, `TMP`, then defaults to `%SystemRoot%\temp` or `%windir%\temp`.

```js
os.homedir(); // '/Users/ishtmeet'
os.tmpdir();  // '/tmp'
```

Both functions are sensitive to environment variable overrides. If someone sets `TMPDIR=/scratch` before starting your process, `os.tmpdir()` returns `/scratch`. Code that hardcodes `/tmp` breaks in these environments - some CI systems and container runtimes use non-standard temp paths. Always use `os.tmpdir()` for portable temp file creation.

One thing I've seen trip people up: `os.tmpdir()` on macOS returns something like `/var/folders/xx/xxxxxxxx/T/` rather than `/tmp`. That's because macOS sets `TMPDIR` to a per-user temp directory. The `/tmp` directory exists on macOS, but `os.tmpdir()` won't point there.

## User Information

```js
const info = os.userInfo();
```

Returns an object with `uid`, `gid`, `username`, `homedir`, and `shell`. On Unix, this calls `getpwuid_r()` with the effective UID of the process - the password database lookup function that's thread-safe (the `_r` suffix means reentrant).

```js
{
  uid: 501,
  gid: 20,
  username: 'ishtmeet',
  homedir: '/Users/ishtmeet',
  shell: '/bin/zsh'
}
```

There's a subtle difference: the `homedir` from `os.userInfo()` comes from the password database (`/etc/passwd` or directory services). The `homedir` from `os.homedir()` comes from the `HOME` environment variable first. If someone runs `HOME=/custom node app.js`, `os.homedir()` returns `/custom` while `os.userInfo().homedir` still returns the system-configured home directory. For most applications, `os.homedir()` is the right choice because it respects the user's runtime configuration.

On Windows, `uid` and `gid` are both `-1` because Windows doesn't use Unix-style numeric IDs - it uses SIDs (Security Identifiers) instead. `username` comes from the `GetUserNameW` Win32 API. `shell` is `null` on Windows.

The `encoding` option controls the encoding of string fields. By default it's `'utf8'`. Pass `{ encoding: 'buffer' }` to get Buffer instances instead of strings, which matters if the username or home path contains bytes that aren't valid UTF-8. Rare on modern systems, but possible in environments with legacy locale settings or non-UTF-8 filesystem encodings.

## Line Endings and Endianness

`os.EOL` is `'\n'` on Unix and `'\r\n'` on Windows. A constant, not a function.

```js
const lines = ['first line', 'second line', 'third line'];
const output = lines.join(os.EOL);
```

For files you expect to be read on the same platform, `os.EOL` keeps things consistent with the platform convention. For files that cross platforms - JSON, YAML, config files committed to git - you probably want explicit `'\n'` instead. Git's `core.autocrlf` setting handles line ending conversion, and most editors and parsers handle `'\n'` on all platforms. Where `os.EOL` really matters is console output and log files that system tools might parse.

`os.endianness()` returns `'LE'` or `'BE'`. On x86, x64, and ARM in standard mode, it's `'LE'` (little-endian). Big-endian systems are rare in 2024 - some IBM POWER configurations, certain MIPS variants, and a few embedded architectures. You'd use this when implementing binary protocols or file formats where byte order matters, though in practice you'll use `Buffer.readInt32BE()` / `Buffer.readInt32LE()` and choose the byte order explicitly based on the protocol spec rather than the host endianness.

## System Uptime

```js
os.uptime(); // 847293
```

Returns system uptime in seconds - how long the host machine has been running since its last boot. This is the machine's uptime, not the process's uptime. A server that's been up for 10 days has `os.uptime()` around 864,000. `process.uptime()` gives you the Node.js process's own uptime, which is usually much shorter.

The underlying call on Linux reads `/proc/uptime` (the first number in that file is seconds since boot). On macOS, it uses `sysctl` with `KERN_BOOTTIME` and subtracts that from the current time. On Windows, `GetTickCount64()` returns milliseconds since boot, which libuv divides by 1000.

The value is useful for detecting whether the machine recently rebooted - if `os.uptime()` is under 300 seconds during a health check, something probably restarted the box. In containerized environments, `os.uptime()` reports the host's uptime, not the container's. For container uptime, you'd use `process.uptime()` (assuming the Node process starts with the container) or read `/proc/1/stat` for the container's init process start time.

## os.constants

Two primary sub-objects: `os.constants.signals` and `os.constants.errno`. These map human-readable names to their numeric values.

```js
os.constants.signals.SIGTERM; // 15
os.constants.signals.SIGKILL; // 9
os.constants.signals.SIGINT;  // 2
```

The signals object contains every POSIX signal the platform supports. On Linux, you get roughly 31 standard signals plus real-time signals up to 64. On macOS, about 31 standard signals. On Windows, only `SIGINT`, `SIGTERM`, `SIGKILL`, `SIGBREAK`, and a few others have meaning - the rest exist as constants but the OS won't deliver them. Signal handling is covered in the previous subchapter of this chapter, and `os.constants.signals` is the programmatic way to reference the numeric values.

```js
os.constants.errno.ENOENT;     // -2
os.constants.errno.EACCES;     // -13
os.constants.errno.EADDRINUSE; // -98 (Linux) or -48 (macOS)
```

Errno values are platform-dependent. `EADDRINUSE` is -98 on Linux and -48 on macOS. The numeric values come from libuv's normalization - libuv negates the POSIX errno values and adds its own platform-independent mapping. If you're writing cross-platform code that checks error codes, use the constant names from `os.constants.errno` rather than hardcoding numbers. Better yet, check `err.code` strings like `'EADDRINUSE'` on Node.js error objects, which is the portable approach. But if you're working with raw libuv return values in native addons, you'll need these numeric constants.

There's also `os.constants.priority`, defining process priority levels:

```js
os.constants.priority.PRIORITY_LOW;          // 19
os.constants.priority.PRIORITY_BELOW_NORMAL; // 10
os.constants.priority.PRIORITY_NORMAL;       // 0
os.constants.priority.PRIORITY_HIGH;         // -14
```

These are used with `os.getPriority()` and `os.setPriority()`, which I'll cover next.

## Process Priority

`os.getPriority()` and `os.setPriority()` control process scheduling priority.

```js
os.getPriority();     // 0 (normal priority for current process)
os.getPriority(1234); // get priority of process 1234
```

Pass no arguments or `0` to query the current process. Pass a PID to query another process. The return value is a Unix "nice" value: 0 is normal, positive values mean lower priority (up to 19), negative values mean higher priority (down to -20). Higher priority processes get more CPU time from the scheduler.

```js
os.setPriority(os.constants.priority.PRIORITY_LOW);
```

Setting priority to `PRIORITY_LOW` (19) gives other processes preference over yours. Background workers, batch jobs, maintenance scripts - tasks where latency doesn't matter. Setting `PRIORITY_HIGH` (-14) gives you preference, but requires root or admin privileges.

On Linux, these map to the `setpriority()` and `getpriority()` syscalls. Unprivileged users can only increase the nice value (lower their own priority). Lowering the nice value (raising priority) requires `CAP_SYS_NICE` capability or root. On Windows, the priority constants map to Windows priority classes: `IDLE_PRIORITY_CLASS`, `BELOW_NORMAL_PRIORITY_CLASS`, `NORMAL_PRIORITY_CLASS`, `ABOVE_NORMAL_PRIORITY_CLASS`, `HIGH_PRIORITY_CLASS`.

One mistake I've seen: calling `os.setPriority(pid, priority)` without catching the error when the process doesn't have permission. It throws an `ERR_SYSTEM_ERROR` with errno `EACCES` or `EPERM`. Always wrap it in try/catch.

There's a practical use case for priority in Node.js applications: if you're running a background job processor alongside a web server in the same machine (not ideal, but it happens), you could nice the background worker to `PRIORITY_BELOW_NORMAL` so it yields CPU time to the latency-sensitive HTTP server. In containerized deployments with dedicated containers per workload, this is less useful since the container scheduler handles resource isolation. But on shared VMs or bare metal with mixed workloads, process priority is a legitimate tuning knob.

## How os.cpus() and os.freemem() Work Under the Hood

Every `os` module function maps to a libuv function, which maps to platform-specific kernel interfaces. The chain for CPU information reveals how deep the abstraction goes.

When you call `os.cpus()`, Node's C++ binding invokes `uv_cpu_info()`. This function allocates an array of `uv_cpu_info_t` structs and populates them differently on each platform.

**Linux.** libuv opens `/proc/stat` and parses the per-CPU lines. Each line looks like:

```
cpu0 10132153 290696 3084719 46828483 16683 0 25195 0 0 0
```

Those numbers are, in order: user, nice, system, idle, iowait, irq, softirq, steal, guest, guest_nice. All measured in clock ticks, also known as jiffies. One jiffy is typically 10ms on modern kernels compiled with `CONFIG_HZ=100`, but some distributions use `CONFIG_HZ=250` (4ms per jiffy) or `CONFIG_HZ=1000` (1ms per jiffy). libuv normalizes these to milliseconds by dividing by `sysconf(_SC_CLK_TCK)` and multiplying by 1000. The CPU model string comes from `/proc/cpuinfo` (the `model name` field), and the speed value is parsed from the same file (the `cpu MHz` field).

The `iowait` field counts time the CPU was idle while there were outstanding I/O requests. libuv folds this into `idle` in the returned object. `steal` measures time the hypervisor allocated this virtual CPU to another VM - relevant in cloud environments where you're sharing physical hardware. `guest` and `guest_nice` count time spent running a guest VM. libuv doesn't expose these fields individually; they're folded into `user` and `nice` by the kernel's accounting.

There's a subtlety with the times values on 32-bit systems. The kernel stores per-CPU jiffies as `unsigned long`, which on a 32-bit system is a 32-bit integer. At CONFIG_HZ=100, one jiffy every 10ms means the counter overflows after roughly 497 days (2^32 * 10ms / 1000 / 86400). After overflow, the times values wrap around to zero and your delta calculations produce garbage - negative deltas or impossibly large CPU percentages. 64-bit systems use 64-bit counters that won't overflow for billions of years. If you're running Node.js on a 32-bit system with long uptimes (embedded devices, IoT gateways), account for this.

**macOS.** libuv uses the Mach `host_processor_info()` function with `PROCESSOR_CPU_LOAD_INFO` flavor. This returns an array of `processor_cpu_load_info` structs, one per logical CPU. Each struct has a `cpu_ticks` array with four elements: `CPU_STATE_USER`, `CPU_STATE_SYSTEM`, `CPU_STATE_IDLE`, `CPU_STATE_NICE`. macOS doesn't report IRQ time separately - it's folded into system time. The tick values are in Mach time units, which libuv converts to milliseconds using `mach_timebase_info()` to get the conversion ratio.

For CPU model and speed, libuv reads sysctl values. `machdep.cpu.brand_string` gives the CPU brand string, and `hw.cpufrequency` provides the clock speed in Hz. On Apple Silicon, `hw.cpufrequency` reports the performance core frequency. Efficiency cores run at a different frequency, but `os.cpus()` reports the same speed for all cores - there's no way to distinguish P-cores from E-cores through this API.

**Windows.** libuv calls `GetSystemInfo()` to determine the processor count, then `NtQuerySystemInformation()` with `SystemProcessorPerformanceInformation` to get per-CPU timing data. The times come back as 100-nanosecond intervals (FILETIME format). CPU model comes from the registry key `HKLM\HARDWARE\DESCRIPTION\System\CentralProcessor\0\ProcessorNameString`, and speed from the `~MHz` DWORD value in the same key.

The memory side has its own platform divergence. `os.freemem()` calls libuv's `uv_get_free_memory()`.

**Linux.** libuv opens `/proc/meminfo` and parses `MemAvailable`. Older kernels (before 3.14, released 2014) don't have `MemAvailable`, so libuv falls back to `MemFree`. The difference matters: `MemFree` counts only completely unused pages. `MemAvailable` is the kernel's estimate of how much memory can be freed without swapping, factoring in the page cache, reclaimable slab caches, and low watermark thresholds. When an application needs memory, the kernel can reclaim page cache pages - they're disk cache, and can be re-read from storage if needed. `MemAvailable` is the accurate answer to "how much can I actually allocate."

`os.totalmem()` calls `uv_get_total_memory()`, which reads `MemTotal` from `/proc/meminfo` on Linux.

**macOS.** Free memory comes from `host_statistics64()` with `HOST_VM_INFO64` flavor, which fills a `vm_statistics64_data_t` structure. libuv adds `free_count` and `inactive_count` (pages that haven't been accessed recently and can be reclaimed), then multiplies by `vm_page_size` (typically 16384 bytes on Apple Silicon, 4096 on Intel Macs). Total memory uses `sysctl` with `HW_MEMSIZE`.

The macOS memory model is distinct from Linux's. macOS categorizes pages as wired (pinned, used by the kernel, can't be paged out), active (recently accessed by a process), inactive (not recently accessed but still in RAM - reclaimable), speculative (prefetched), and free (never allocated or fully reclaimed). The "free" count alone is misleadingly low on a busy Mac because the OS aggressively fills RAM with cached data. Adding inactive pages to free pages gives a realistic picture of what's available for new allocations.

**Windows.** `GlobalMemoryStatusEx()` fills a `MEMORYSTATUSEX` structure. `ullAvailPhys` is the available physical memory, `ullTotalPhys` is the total. Windows also caches disk data aggressively, and the available memory number already accounts for reclaimable cache.

There's also `uv_get_constrained_memory()`, which backs `process.constrainedMemory()` in Node 19.6+. In containerized environments, this reads the cgroup memory limit (`memory.max` in cgroups v2, `memory.limit_in_bytes` in v1). The `os` module doesn't expose this directly, which is the gap I mentioned earlier - you need to use `process.constrainedMemory()` or read the cgroup files yourself.

## Practical Patterns

A system health check function for a monitoring endpoint:

```js
function systemHealth() {
  const cpuCount = os.availableParallelism();
  const load1m = os.loadavg()[0];
  const freeGb = os.freemem() / 1073741824;
  const totalGb = os.totalmem() / 1073741824;
  return { cpuCount, loadPerCpu: load1m / cpuCount, freeGb, totalGb };
}
```

For platform-conditional logic, cache the result - `os.platform()` is a constant, but function call overhead adds up in hot paths:

```js
const isWindows = os.platform() === 'win32';
const isMac = os.platform() === 'darwin';
const isLinux = os.platform() === 'linux';
```

For discovering the machine's IP in a service discovery or registration context:

```js
function getServiceAddress() {
  for (const [n, addrs] of Object.entries(os.networkInterfaces())) {
    const v4 = addrs.find(a => a.family === 'IPv4' && !a.internal);
    if (v4) return { interface: n, address: v4.address, cidr: v4.cidr };
  }
  return null;
}
```

In Kubernetes, the pod's IP is often what you bind the HTTP server to. Service mesh sidecars (Envoy, Linkerd) need to know the pod IP for proxying. And health check endpoints need to report which address they're listening on. `os.networkInterfaces()` is how you discover it dynamically rather than hardcoding an address or relying on environment variables alone.

### Startup Logging

Printing system info at process startup is a common pattern for debugging production issues:

```js
console.log({
  hostname: os.hostname(),
  platform: `${os.platform()}-${os.arch()}`,
  cpus: os.availableParallelism(),
  totalMemMb: Math.round(os.totalmem() / 1048576),
  nodeVersion: process.version,
  uptime: Math.round(os.uptime() / 3600) + 'h',
});
```

When something breaks at 3 AM and you're reading logs, knowing the machine had 2 CPUs and 512 MB RAM (because it was a tiny container) versus 64 CPUs and 256 GB (because it was a large bare-metal box) changes your diagnosis. The few lines of startup logging pay for themselves many times over.

## What the os Module Doesn't Cover

Process-level memory breakdown lives in `process.memoryUsage()`. Process uptime is `process.uptime()`. Environment variables are on `process.env`. The os module handles machine-level introspection exclusively.

Disk information is absent. There's no `os.diskfree()` or `os.disks()`. For disk stats, `fs.statfs()` (added in Node 18.15) returns total bytes, free bytes, and available bytes for the filesystem containing a given path. You have to know which path you care about - you can't enumerate all mounted filesystems through Node.js built-in APIs alone.

GPU information doesn't exist in the os module. Node.js has no built-in GPU introspection. If you need GPU data - VRAM usage, GPU temperature, utilization - that comes from native addons, child process calls to `nvidia-smi`, or platform-specific APIs.

Battery information is also missing. There's no `os.battery()` for laptop or UPS charge level. On Linux you'd read from `/sys/class/power_supply/`. On macOS, the `IOKit` framework provides battery data. On Windows, `GetSystemPowerStatus()`. None of these are wrapped by libuv or exposed by Node.

Temperature sensors, fan speeds, and other hardware monitoring data are similarly out of scope. The `os` module provides what libuv wraps, and libuv focuses on the primitives needed for I/O-driven server software: CPU, memory, network, and platform identity.

Process listing is another gap. There's no `os.processes()` to enumerate running processes. On Linux you'd scan `/proc/` directories (each numeric directory is a PID). On macOS, `sysctl` with `KERN_PROC` gives you the process table. On Windows, `CreateToolhelp32Snapshot()` enumerates processes. Libraries like `ps-list` wrap these platform-specific approaches, but Node doesn't provide this out of the box.

The os module is read-only for almost everything. The exception is `os.setPriority()` - that's the only function that modifies system state. You can't change the hostname, add network interfaces, adjust memory limits, or modify kernel parameters through the os module. For those operations, you need child processes running privileged commands (`hostname`, `ip`, `sysctl`) or native addons calling the appropriate syscalls.

