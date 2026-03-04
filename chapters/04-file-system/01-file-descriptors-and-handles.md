---
title: "File Descriptors & Handles"
date: "2026-02-22"
excerpt: "How file descriptors work at the OS level, the kernel's per-process file table, and Node.js fs.open internals."
category: "File System"
tags: ["nodejs", "file-system", "file-descriptors", "fs", "posix"]
author: "Ishtmeet Singh @ishtms"
chapter: "file-system"
subchapter: "file-descriptors-and-handles"
published: true
toc: true
---

Every file operation in Node.js bottoms out at a single thing: an integer (or on Windows, an opaque pointer that Node abstracts into an integer). `fs.readFile()`, `fs.createReadStream()`, `fs.writeFile()` - under every one of these sits a small number that the operating system gave to your process. That number is the file descriptor.

> [!NOTE]
> **Opaque pointers** are memory addresses where the internal structure of the data being pointed to is hidden from the caller. Windows uses these `HANDLE` types for everything. You hold the pointer, but only the OS knows how to dereference it to read the actual state.

You've probably seen it. Call `fs.openSync('/tmp/foo', 'r')` and you get back something like `22`. An integer. You pass it to `fs.readSync()`, then to `fs.closeSync()`, and that's the lifecycle. Open, use, close. The number itself means nothing outside your process. It's an index into a table the kernel maintains, one per process, mapping these integers to internal data structures that track open files (on POSIX systems).

> [!NOTE]
> **POSIX** (Portable Operating System Interface) is a family of standards specified by the IEEE Computer Society for maintaining compatibility between operating systems. Linux, macOS, and BSDs are POSIX-compliant. Windows is not.

The reason file descriptors exist at all comes down to how operating systems manage I/O. Your process can't touch the disk directly. The kernel mediates every read, every write. File descriptors are the reference tokens it hands you - your process says "read 4096 bytes from descriptor 22" and the kernel looks up what file that maps to, checks permissions, does the read, and copies data back into your address space. The integer is just an indirection layer. But it governs everything.

> [!NOTE]
> The **kernel** is the core component of the OS with complete control over the system, operating in an isolated memory area. Your userland process runs in a restricted **address space**-a mapped range of memory it is allowed to access. An **indirection layer** means you interact with a proxy token (the descriptor) while the kernel maps it to the actual resource.

## The Per-Process File Descriptor Table

When a process starts, the kernel sets up a file descriptor table for it. On POSIX systems (Linux, macOS, BSDs), file descriptors are non-negative integers starting from 0. Three slots are already filled before your code runs a single line:

- **0** - stdin
- **1** - stdout
- **2** - stderr

These come from the parent process. When you run `node app.js` from a shell, the shell's stdin/stdout/stderr get inherited. `console.log()` writes to fd 1. `process.stderr.write()` hits fd 2. They're file descriptors like any other - they just happen to be pre-allocated.

Beyond those three, the kernel assigns the lowest available integer each time you open something. Open a file, get fd 3. Open another, fd 4. Close fd 3, open something else - you get 3 again, because it's free.

```js
const fs = require('fs');
const fd1 = fs.openSync('/tmp/a.txt', 'w');
const fd2 = fs.openSync('/tmp/b.txt', 'w');
console.log(fd1, fd2);
fs.closeSync(fd1);
const fd3 = fs.openSync('/tmp/c.txt', 'w');
console.log(fd3);
fs.closeSync(fd2);
fs.closeSync(fd3);
```

The actual numbers you see won't be 3 and 4. Node opens internal file descriptors during startup - pipes for libuv's thread pool communication, the IPC channel if you forked, maybe a few others. Your first user-opened descriptor will typically be in the mid-teens (like 14 or 18). But the sequential, lowest-available allocation pattern holds.

And it's worth being precise here: file descriptors cover more than just files. Sockets are file descriptors. Pipes are file descriptors. Even `/dev/null` and `/dev/urandom` get file descriptors when opened. The kernel treats them all the same way at the descriptor level - entries in a table pointing to kernel structures that know how to do I/O on that particular resource.

## How fs.open() Works Under the Hood

When you call `fs.open('/path/to/file', 'r', callback)`, several layers are involved.

Your JavaScript call hits Node's C++ binding layer. The binding constructs a `uv_fs_t` request struct and calls `uv_fs_open()` in libuv. Because file system operations are blocking at the kernel level (covered in Chapter 1), libuv dispatches the work to its thread pool. A thread pool worker executes the actual `open()` syscall - on Linux that's the POSIX `open()`, on macOS it's the same, on Windows libuv calls `CreateFileW()` and wraps the resulting `HANDLE` to look like a descriptor.

> [!NOTE]
> A **syscall** (system call) is the programmatic way user space code requests a service from the kernel. It forces a context switch from user mode to kernel mode where elevated privileges apply.

The kernel, upon receiving the `open()` syscall, does several things in sequence:

1. Resolves the path component by component - traversing directories, checking each one exists
2. Verifies the process has permission to open the file in the requested mode
3. Locates the file's inode on disk - the kernel data structure that stores the file's metadata and block pointers
4. Allocates an entry in the kernel's open file table, which tracks the current file offset (position), the access mode, and a reference to the inode
5. Finds the lowest available slot in the process's file descriptor table and points it at that open file table entry
6. Returns the slot number - the fd

> [!NOTE]
> An **inode** (index node) is a fundamental Unix data structure describing a file-system object entirely. **Block pointers** hold the exact physical disk addresses where the file's payload data resides.

Back in libuv, the thread pool worker finishes and posts the result to the event loop (covered in Chapter 1). The loop picks it up, and Node's C++ layer calls your JavaScript callback with the fd as the second argument.

The whole round trip: JS -> C++ bindings -> libuv -> thread pool -> kernel syscall -> back through libuv -> back to JS. For every single `fs.open()`.

One thing to be clear about: the file descriptor is process-scoped. The integer 22 in your process and the integer 22 in another process refer to completely different entries. Even if both processes open the same file, they get independent descriptors with independent state - separate file offsets, separate flags. Closing fd 22 in one process has zero effect on the other.

## File Flags

The second argument to `fs.open()` determines how the file gets opened. These strings map directly to POSIX open flags - the constants the kernel actually uses.

**'r'** - Read only. Maps to `O_RDONLY`. File must exist; if it doesn't, you get `ENOENT`.

**'r+'** - Read and write. Maps to `O_RDWR`. File must exist. The offset starts at byte 0, so reads and writes begin at the file's start. Existing content stays intact.

**'w'** - Write only, create or truncate. Maps to `O_WRONLY | O_CREAT | O_TRUNC`. If the file exists, it gets wiped to zero bytes immediately on open. If it doesn't exist, it's created.

**'w+'** - Read and write, create or truncate. Same as 'w' but with `O_RDWR` instead of `O_WRONLY`. Existing content is destroyed.

**'a'** - Append. Maps to `O_WRONLY | O_CREAT | O_APPEND`. Every write goes to the end of the file regardless of where you try to seek. Creates the file if missing.

**'a+'** - Read and append. Reads can happen anywhere in the file, but writes always land at the end.

**'wx'** - Write exclusive. Adds `O_EXCL` to the flags. The open fails with `EEXIST` if the file already exists. The check-and-create is atomic at the kernel level - there's no race window where another process could sneak in between checking and creating.

> [!NOTE]
> An **atomic** operation completes in a single, indivisible step. A **race condition** (or race window) occurs when system behavior depends on the unpredictable timing of multiple concurrent processes. Kernel-level atomicity outright prevents these timing dependencies.
>
> Constants like `ENOENT` (Error NO ENTry), `EEXIST` (Error EXISTs), and `EBADF` (Error BAD File descriptor) map to standard POSIX error codes. The `O_` flags match C-level definitions in `<fcntl.h>`, driving exact bitwise OS behavior.

The exclusive flag matters when you need to guarantee that two processes won't both think they successfully created the same file. Log rotation, lock files, temp file creation - anywhere a race condition between check-and-create would cause bugs.

You can also pass numeric flag values directly using `fs.constants`:

```js
const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC;
const fd = fs.openSync('/tmp/out.txt', flags);
```

But the string versions are easier to read, and I've rarely seen the numeric form in production code outside of native addons.

### Mode Bits

When a file gets created (flags 'w', 'a', 'wx', or any variant that includes `O_CREAT`), the third argument to `fs.open()` sets the permission bits. It's an octal number.

```js
fs.openSync('/tmp/secret.txt', 'w', 0o600);
```

`0o600` means: owner can read and write, nobody else can do anything. The three octal digits represent owner, group, and others. Each digit encodes read (4) + write (2) + execute (1). So `0o644` gives the owner read/write, and everyone else read-only.

> [!NOTE]
> An **octal number** is a base-8 numeral system (prefixed with `0o` in JS). Permissions map cleanly to octals because 3 bits (read, write, execute) perfectly represent values 0 through 7.

If you omit the mode, Node defaults to `0o666`. But the actual on-disk permissions get modified by the process's umask - a bitmask the kernel subtracts from the requested mode. A typical umask of `0o022` turns `0o666` into `0o644`. So even without specifying mode, you usually end up with reasonable permissions.

> [!NOTE]
> A **bitmask** is a sequence of bits used for bitwise operations. A **umask** (user file-creation mode mask) dictates the default permissions newly created files should NOT have. The kernel clears the bits defined in the umask from the requested permissions.

On Windows, mode bits have minimal effect. Windows uses ACLs for permissions, and Node does a best-effort mapping that's... approximate. If you're writing cross-platform code that needs specific permissions, you'll want to handle Windows separately.

> [!NOTE]
> **ACLs** (Access Control Lists) provide fine-grained permissions. Instead of Unix's broad owner/group/other breakdown, an ACL explicitly lists which individual Windows users or groups are granted or denied specific access rights.

## The fd Lifecycle

Open. Use. Close. That's it. But each stage has details that matter.

**Open** allocates the kernel structures and returns a descriptor. The descriptor is valid from this point until close.

**Use** means passing the fd to functions like `fs.read()`, `fs.write()`, `fs.fstat()`, `fs.fsync()`. Each call references the same kernel-side state - the same file offset, the same flags. If you `fs.read()` 100 bytes, the offset advances by 100, and the next read starts where the last one left off. Two different fd's opened on the same file maintain independent offsets.

**Close** releases everything. `fs.close(fd, callback)` triggers the `close()` syscall. The kernel releases the open file table entry and marks the fd number as available for reuse. Data that was written may still sit in the kernel's buffer cache - `close()` does not guarantee a flush to disk. Use `fs.fsync()` before closing if you need that guarantee. After close, the integer is invalid. Using it in an `fs.read()` call produces `EBADF` - bad file descriptor.

> [!NOTE]
> The **buffer cache** (or OS page cache) is main memory the kernel uses to temporarily store disk block contents. Writes hit RAM first for speed and get flushed to physical storage asynchronously.

```js
fs.open('/tmp/data.bin', 'r', (err, fd) => {
  if (err) throw err;
  const buf = Buffer.alloc(64);
  fs.read(fd, buf, 0, 64, 0, (err, bytesRead) => {
    fs.close(fd, () => {});
    if (err) throw err;
    console.log(`Read ${bytesRead} bytes`);
  });
});
```

Notice the close happens inside the read callback, regardless of whether the read succeeded. That's the pattern. Close must happen in every code path. Forgetting it leaks the descriptor.

### What Leaking Actually Means

When you open a file and don't close it, the fd stays allocated for the lifetime of your process. One leaked descriptor is usually harmless. A hundred, and you're wasting kernel memory. A thousand, and you're probably hitting the process limit.

The kernel enforces a per-process cap on open file descriptors. Check yours:

```sh
ulimit -n
```

Common defaults: 1024 on Linux, 256 on older macOS (newer macOS often defaults higher). That count includes everything - stdin, stdout, stderr, sockets, pipes, internal libuv descriptors. A Node.js HTTP server uses one fd per active TCP connection. Add in log files, database connections, and your application code, and 1024 can feel tight.

## The EMFILE Error

Hit the limit and `fs.open()` fails with `EMFILE`. The name comes from the errno constant - "Error: too Many FILES open" (the naming is old Unix whimsy). It's one of the more common production failures in Node applications.

Here's what a leak looks like:

```js
for (let i = 0; i < 2000; i++) {
  fs.open('/tmp/test.txt', 'r', (err, fd) => {
    if (err) return console.error(i, err.code);
    // never closing fd
  });
}
```

Run that with a 1024 limit and you'll see `EMFILE` errors starting around iteration 1000, after Node's internal descriptors and stdin/stdout/stderr eat into the budget. Each successful open consumes a slot. With no closes, slots only go in one direction.

But leaks in real code are subtler. Consider error paths:

```js
fs.open('/tmp/data.txt', 'r', (err, fd) => {
  if (err) throw err;
  doSomethingAsync(fd, (err) => {
    if (err) throw err;  // fd never closed on this path
    fs.close(fd, () => {});
  });
});
```

If `doSomethingAsync` passes an error to its callback, we throw - and the fd leaks. Each occurrence burns one descriptor. In a server handling requests, these add up over hours or days until EMFILE hits and the whole thing goes down.

### Debugging Descriptor Leaks

On Linux and macOS, `lsof` is the go-to tool:

```sh
lsof -p $(pgrep -f 'node app.js')
```

You'll see every open descriptor for your Node process: file paths, socket addresses, pipe endpoints. If you see hundreds of entries pointing to the same file, or descriptors that should've been closed still hanging around, that's your leak.

You can also monitor the count programmatically. On Linux, `/proc/self/fd` is a directory listing all open descriptors for the current process:

```js
const fds = fs.readdirSync('/proc/self/fd');
console.log('Open descriptors:', fds.length);
```

In production, tools like Prometheus exporters can track `process.open_fds` as a gauge metric. Set an alert threshold. If the count grows monotonically over time, something's leaking.

### Raising the Limit

For short-term relief, bump the soft limit:

```sh
ulimit -n 65536
```

That applies to your current shell session and processes spawned from it. The hard limit caps how high you can go - check with `ulimit -Hn`. Root can raise the hard limit via `/etc/security/limits.conf` on Linux.

But raising the limit is a band-aid if your code leaks. Fix the leak first. Then tune the limit to match your actual concurrent connection count plus a comfortable margin.

## The FileHandle Abstraction

Raw fd integers are error-prone. Forgetting `fs.close()` is easy, especially in async code with branching error paths. Node's `fs.promises` API provides a better model: the `FileHandle` object.

```js
const fh = await require('fs').promises.open('/tmp/data.txt', 'r');
console.log('fd:', fh.fd);
await fh.close();
```

`fs.promises.open()` returns a `FileHandle` instead of a raw integer. The `.fd` property gives you the underlying descriptor if you need it, but you typically don't - `FileHandle` has methods for everything: `.read()`, `.write()`, `.stat()`, `.readFile()`, `.writeFile()`, `.truncate()`, `.sync()`, `.close()`.

All of them return Promises. And because they're methods on the handle object, you don't pass the fd around to standalone functions. The resource and the operations on it are bundled together.

### The try/finally Pattern

The standard way to use `FileHandle`:

```js
const fs = require('fs').promises;
const fh = await fs.open('/tmp/data.txt', 'r');
try {
  const buf = Buffer.alloc(256);
  const { bytesRead } = await fh.read(buf, 0, 256, 0);
  console.log(`Got ${bytesRead} bytes`);
} finally {
  await fh.close();
}
```

The `finally` block runs whether the try block succeeds or throws. The descriptor gets closed either way. Compare this to the callback version where you need to remember `fs.close(fd, ...)` in every branch - the Promise version makes the cleanup path explicit and harder to mess up.

### What Happens If You Forget to Close a FileHandle

Node tracks `FileHandle` instances. If one gets garbage collected without `.close()` being called, Node closes the underlying fd and prints a warning:

```
(node:12345) Warning: Closing file descriptor 21 on garbage collection
```

This is a diagnostic safety net, and you should never rely on it. Garbage collection timing is unpredictable - V8 might not run a GC cycle for minutes, and during that time the descriptor is leaked. In a server processing requests, that's potentially hundreds of leaked descriptors before GC triggers.

Future Node versions may turn this warning into a hard error. Close your handles.

### `await using` - Automatic Resource Cleanup

Node.js v24 supports the Explicit Resource Management proposal. `FileHandle` implements `Symbol.asyncDispose`, which means you can use `await using`:

```js
const fs = require('fs').promises;
await using fh = await fs.open('/tmp/data.txt', 'r');
const content = await fh.readFile('utf8');
console.log(content);
// fh.close() called automatically when fh goes out of scope
```

The two `await` keywords serve different purposes. `await fs.open()` waits for the file to actually open. `await using` registers the variable for async disposal - when execution leaves the scope (end of block, exception, return, whatever), the runtime calls `fh[Symbol.asyncDispose]()`, which calls `fh.close()`.

No try/finally needed. No manual close call. The resource is tied to lexical scope, and the runtime handles cleanup. If you're on Node v20.4.0+ (where this was added to FileHandle) and your toolchain supports the syntax, prefer this pattern.

###  When to Choose FileHandle vs Raw fd

For new code, use `FileHandle` via `fs.promises`. The cleanup guarantees are worth the negligible overhead of wrapping an integer in an object. The `fs.promises` API deliberately omits functions that take raw fd arguments - there's no `fs.promises.read(fd, ...)`. The design pushes you toward the safer abstraction.

Use raw fd's when you need to interface with native addons expecting integer descriptors, or when you're maintaining legacy callback-based code where refactoring to Promises isn't practical. The callback-based `fs.open()` / `fs.close()` / `fs.read(fd, ...)` API still works and will continue to work.

Performance-wise, the difference is negligible. The I/O cost of actually reading or writing data dwarfs the cost of one extra JavaScript object. Profile before optimizing here.

## How File Operations Actually Execute

This is the part most documentation skips. When Node performs a file operation, the actual execution path goes through libuv's file system layer, and understanding that path explains behaviors you might otherwise find puzzling.

libuv exposes file operations through the `uv_fs_*` family of functions. `uv_fs_open()`, `uv_fs_read()`, `uv_fs_write()`, `uv_fs_close()` - each one takes a `uv_fs_t` request struct, a `uv_loop_t*` loop reference, and a callback.

Here's the thing about file I/O on most operating systems: there is no true asynchronous API for regular files. Linux has `io_uring` (since kernel 5.1) and the older `aio` interface. Libuv actually *does* have built-in support for `io_uring` to perform async file operations without the thread pool, but as of Node v24, it is disabled by default due to performance regressions and past security vulnerabilities, falling back to the thread pool (though it can be toggled via environment variables). On macOS, `kqueue` works for sockets and pipes but provides unreliable notifications for regular files. Windows has overlapped I/O for files, but libuv's implementation uses its own thread pool there too.

So libuv does the pragmatic thing: it offloads every file operation to its thread pool. The default pool size is 4 threads (controlled by `UV_THREADPOOL_SIZE`, max 1024). When you call `fs.open('/path', 'r', callback)`, the operation gets queued as a work item. One of the pool threads picks it up and issues the blocking `open()` syscall. When the syscall returns, the thread posts the result back to the event loop via a platform-specific notification mechanism - an `eventfd` on Linux, a pipe on macOS.

The event loop (covered in Chapter 1) picks up the notification in its poll phase and fires your JavaScript callback.

The `uv_fs_t` struct holds everything the thread pool worker needs: the path, the flags, the mode, and space for the result (the fd or an error code). After the operation completes, the struct also holds timing information and the OS error if one occurred. Node's C++ binding reads these fields and constructs the JavaScript arguments for your callback.

One implication: every outstanding file operation consumes a thread pool slot. With the default pool of 4, if you fire off 100 concurrent `fs.open()` calls, 4 execute at once and 96 queue up. The queue is unbounded, so you won't get errors - but throughput plateaus at 4 concurrent syscalls. Bump `UV_THREADPOOL_SIZE` if file I/O throughput matters, but remember the pool is shared with DNS lookups (`dns.lookup()`), crypto operations, and any other work offloaded via `uv_queue_work()`.

The kernel side has its own structure for tracking open files. On Linux, there are three tables involved:

1. **The per-process file descriptor table** - maps fd integers (0, 1, 2, ...) to entries in the open file table. One per process.
2. **The system-wide open file table** - each entry tracks the current offset (position within the file), the access mode (read/write/append), and a pointer to the inode. Shared across the system.
3. **The inode table** - each entry represents a file on disk. Tracks metadata (permissions, size, timestamps) and the locations of data blocks. Multiple open file entries can point to the same inode - that's what happens when the same file is opened multiple times.

When `fork()` creates a child process, the child gets a copy of the parent's fd table. Both parent and child now have entries pointing to the same open file table entries. That means they share the file offset. If the parent reads 100 bytes, advancing the offset, the child's next read starts at byte 100 too. This shared-offset behavior is specific to forked processes sharing descriptors - two independent `open()` calls on the same file create separate open file table entries with independent offsets.

Node's `child_process.fork()` sets up IPC channels using socketpair file descriptors. But importantly, **libuv opens all files with the `O_CLOEXEC` (Close-on-exec) flag by default**. While a raw POSIX `fork()` duplicates the entire fd table, when you spawn a child process in Node, any regular files you previously opened via `fs.open()` are automatically closed for the child. The child only inherits `stdin`, `stdout`, `stderr` (fds 0, 1, 2) and the `ipc` channel, unless you explicitly pass other descriptors through the `stdio` array.

> [!NOTE]
> A **socketpair** is a connected pair of unnamed sockets used for two-way communication. An **IPC channel** (Inter-Process Communication) abstracts this pair so Node parent and child processes can pass messages natively. `O_CLOEXEC` ensures descriptors aren't accidentally leaked into spawned child programs.

The `close()` syscall does more than mark a slot as free. It decrements the reference count on the open file table entry. If the reference count hits zero (no more descriptors pointing to it from any process), the entry is freed. The inode's reference count gets decremented too, and if it reaches zero and the link count (from hard links) is also zero, the file's data blocks are actually released. That's why you can delete a file while another process has it open - the name disappears from the directory, but the data stays until the last fd closes.

> [!NOTE]
> **Hard links** are multiple independent directory entries mapped to the identical inode. The kernel tracks this via a link count. Subjacent data blocks are strictly wiped only when both descriptor and link counts reach zero.

libuv also provides synchronous versions of every file operation - `uv_fs_open()` can be called without a callback, blocking the calling thread until the syscall completes. Node uses these for the `*Sync` variants (`fs.openSync()`, `fs.readSync()`, etc.). When you call `fs.openSync()`, it skips the thread pool entirely and blocks the main JavaScript thread on the syscall. Fast if the file is in the OS page cache, potentially slow if it requires disk access. Avoid in server code.

## Cross-Platform Behavior

Node abstracts over platform differences through libuv, and most of the time you won't notice. But some edges leak through.

**Path separators.** Windows uses `\`, POSIX uses `/`. Node's `path` module handles this - `path.join('dir', 'file.txt')` produces the right separator for your platform. Pass paths through `path.join()` or `path.resolve()` instead of concatenating strings with `/`.

**Case sensitivity.** NTFS (Windows) and APFS (macOS) are case-insensitive by default. `File.txt` and `file.txt` are the same file. ext4 (Linux) is case-sensitive. Code that works on Linux might fail on Windows or macOS if it depends on case-distinct filenames.

> [!NOTE]
> **NTFS** (New Technology File System), **APFS** (Apple File System), and **ext4** (Fourth Extended File System) dictate exactly how paths are stored, indexed, and retrieved at the lowest OS level.

**Descriptor vs handle.** On Windows, `CreateFileW()` returns an opaque `HANDLE`, a pointer-sized value. libuv converts it into something that looks like a POSIX fd to your JavaScript code. The conversion is internal - you see an integer and use it the same way.

**File locking.** POSIX has advisory locks via `flock()` and `fcntl()`. "Advisory" means they only work if all processes cooperate by checking locks before accessing the file. Windows has mandatory locks - opening a file with exclusive access prevents other processes from opening it at all. Node's `fs` module doesn't expose locking directly. If you need cross-platform file locking, use a package like `proper-lockfile`.

> [!NOTE]
> **Advisory locks** require explicit opt-in from all processes; the kernel won't stop rogue writes. **Mandatory locks** are strictly enforced by the kernel on every single read/write call, refusing access regardless of whether the caller checked the lock.

**Path length.** Windows historically limits paths to 260 characters (`MAX_PATH`). The Unicode APIs support up to 32,767 characters with the `\\?\` prefix, and Node tries to use those, but edge cases remain. POSIX limits are typically 4096 bytes - rarely a problem.

## Patterns for Resource Management

A few patterns that prevent descriptor leaks in production code.

**Limit concurrency.** If you're processing 10,000 files, don't open all of them at once. Use a concurrency limiter:

```js
const pLimit = require('p-limit');
const limit = pLimit(50);
const tasks = paths.map(p => limit(() => processFile(p)));
await Promise.all(tasks);
```

50 concurrent opens, max. The rest queue up. Same concept as backpressure (covered in Chapter 3) - controlling resource consumption rate to prevent exhaustion.

**Use high-level APIs when you can.** `fs.readFile()`, `fs.writeFile()`, `fs.createReadStream()` - these open and close descriptors internally. You don't touch the fd, so you can't forget to close it. Reserve `fs.open()` for when you actually need low-level control: random access reads, keeping a file open across multiple operations, interfacing with native code.

**Monitor in production.** Track open fd count as a metric. On Linux, `fs.readdirSync('/proc/self/fd').length` gives you the count. Export it to your monitoring system. Set alerts. A monotonically increasing fd count over time means a leak.

**Close in finally.** Always. Whether you're using callbacks or Promises, the close must happen on every code path, including error paths. With `FileHandle` and `await using`, the runtime handles this for you.

The underlying principle: file descriptors are a finite pool. The kernel enforces hard limits. Your code should treat them as a resource to acquire, use briefly, and release promptly - the same discipline you'd apply to database connections or mutex locks.

> [!NOTE]
> A **mutex lock** (mutual exclusion object) is a synchronization primitive used to prevent concurrent execution of critical sections of code by multiple threads. You lock it before proceeding, do your work, and then unlock it.
