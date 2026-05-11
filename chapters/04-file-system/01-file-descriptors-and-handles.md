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

Every file operation in Node uses a small process-local token.

On POSIX systems, that token is a file descriptor: a non-negative integer indexing the process's file descriptor table. On Windows, the OS gives libuv a `HANDLE`, and libuv presents a descriptor-shaped value back to Node. JavaScript mostly sees the same thing either way. An integer. Pass it to a read. Pass it to a write. Close it when the work is done.

That integer controls more state than its size suggests. `fs.readFile()`, `fs.createReadStream()`, `fs.writeFile()`, `fs.open()`, `FileHandle`, sockets, pipes, standard input, standard output. They all meet the operating system through an open resource recorded in kernel state.

```js
const fs = require('node:fs');

const fd = fs.openSync('/tmp/example.txt', 'w');
console.log(fd);
fs.closeSync(fd);
```

The printed value might be `17`, `22`, or something nearby. Node opens a few descriptors during startup, so user code rarely gets `3` in a real process. The number has meaning only inside that process. Another process can also have fd `17`, pointing at a different file, socket, pipe, or terminal.

## The Descriptor Table

A process starts with three descriptors already open.

- `0` is standard input.
- `1` is standard output.
- `2` is standard error.

The parent process sets those up before Node starts running your program. In a shell, fd `0` usually points at the terminal input, fd `1` at terminal output, and fd `2` at the same terminal through the error stream. In a service manager, container runtime, or pipeline, those descriptors may point at pipes, sockets, log collectors, or files.

Node treats them as streams because Chapter 3 already covered streams. The lower layer still sees descriptors. `console.log()` eventually writes bytes to fd `1`. `process.stderr.write()` writes bytes to fd `2`.

After those first three, the kernel assigns the lowest free descriptor number for each open operation. Close one, and the slot becomes reusable.

```js
const fs = require('node:fs');

const a = fs.openSync('/tmp/a.txt', 'w');
const b = fs.openSync('/tmp/b.txt', 'w');
fs.closeSync(a);
const c = fs.openSync('/tmp/c.txt', 'w');
console.log({ a, b, c });
fs.closeSync(b);
fs.closeSync(c);
```

`c` often equals `a`, because closing `a` frees that descriptor-table slot. The exact values depend on descriptors Node already holds, but the reuse behavior comes from the OS.

The table entry points at an open file description in kernel memory. That open file description tracks the current offset, access mode, append behavior, status flags, and a reference to the underlying file object. The file object eventually points at an inode on POSIX filesystems. If the descriptor represents a socket or pipe, the target kernel object has socket or pipe state instead.

Same interface. Different kernel object.

That is why a descriptor can refer to more than a regular file. TCP sockets consume descriptors. Unix domain sockets consume descriptors. Pipes consume descriptors. `/dev/null` consumes one after you open it. The descriptor table only records "fd N points at this open kernel object"; the object itself defines which operations make sense.

## Opening A File

`fs.open()` is the place where the JavaScript path turns into a descriptor.

```js
const fs = require('node:fs');

fs.open('/tmp/data.txt', 'r', (err, fd) => {
  if (err) return handleError(err);
  console.log(fd);
  fs.close(fd, (closeErr) => {
    if (closeErr) handleError(closeErr);
  });
});
```

The callback receives an fd because the open operation finished in native code. Node converted your path and flags, called into the C++ binding layer, created a libuv filesystem request, and handed the blocking work to libuv.

The kernel open path has a fixed shape. It resolves the path component by component. It checks permissions. It applies flags. It creates or finds the file object. It allocates an open file description. It installs a pointer to that description into the process descriptor table. Then it returns the descriptor number.

On Linux and macOS, the native call is `open()` or a close relative. On Windows, libuv calls `CreateFileW()` and maps the returned `HANDLE` into its file abstraction. Node's `fs` API covers most of that split, but a few Windows cases still show up around sharing modes, path length, and permission behavior.

A descriptor is process-scoped. Two processes opening `/tmp/data.txt` get separate descriptor table entries and separate open file descriptions. Each open call has its own file offset. Read 100 bytes through one descriptor, and the offset for that open description advances by 100. A separate open call keeps its own offset.

Duplicated descriptors behave differently. `dup()`, `fork()`, and descriptor inheritance can create multiple descriptor-table entries pointing at the same open file description. Those descriptors share the offset. If one reads 100 bytes, the next read through the other starts from the new position. Node keeps most application code away from raw `fork()` inheritance, but the OS behavior explains odd results when descriptors are passed between processes.

## Flags Decide The Open State

The second argument to `fs.open()` controls access mode and creation behavior. String flags map to OS-level bit flags.

`'r'` opens for reading. The file must already exist. Missing path gives `ENOENT`.

`'r+'` opens for reading and writing. The file must already exist. The offset starts at byte `0`.

`'w'` opens for writing, creates the file when needed, and truncates existing content to zero bytes during open.

`'w+'` opens for reading and writing with the same create-and-truncate behavior.

`'a'` opens for appending, creates the file when needed, and makes each write land at the current end of the file.

`'a+'` opens for reading and appending. Reads can use positions. Writes still append.

`'wx'` opens for writing with exclusive creation. If the path already exists, the open fails with `EEXIST`. The check and creation happen inside the kernel operation, so two processes competing for the same path get one winner.

```js
let fd;
try {
  fd = fs.openSync('/tmp/lock.pid', 'wx', 0o600);
  fs.writeSync(fd, `${process.pid}\n`);
} catch (err) {
  handleOpenError(err);
} finally {
  if (fd !== undefined) fs.closeSync(fd);
}
```

That pattern is common for lock files and one-time creation. `handleOpenError()` can log `EEXIST` and rethrow everything else. The `finally` handles the fd. If `writeSync()` throws after the open succeeds, the descriptor still closes. The flag matters more than a separate existence check. `fs.existsSync()` followed by `fs.openSync(..., 'w')` has a race between the two calls. `O_EXCL` folds the decision into the open operation.

Numeric flags exist too:

```js
const fs = require('node:fs');

const flags = fs.constants.O_WRONLY |
  fs.constants.O_CREAT |
  fs.constants.O_TRUNC;
const fd = fs.openSync('/tmp/out.txt', flags);
fs.closeSync(fd);
```

String flags read better in application code. Numeric flags show up when you need a specific platform flag, when porting C logic, or when a native addon boundary already speaks in flag bits.

## Creation Mode And `umask`

The third `fs.open()` argument applies when the open call creates a file. It sets the requested permission bits.

```js
const fs = require('node:fs');

const fd = fs.openSync('/tmp/secret.txt', 'w', 0o600);
fs.closeSync(fd);
```

`0o600` gives the owner read and write permission. Group and others get permission value `0`. The three octal digits encode owner, group, and others. Inside each digit, read is `4`, write is `2`, and execute is `1`.

Node's default creation mode is `0o666`, which means read and write for owner, group, and others before the process mask is applied. The process `umask` clears bits from that requested mode. A common `0o022` mask turns `0o666` into `0o644`: owner read/write, everyone else read-only.

That last sentence causes real bugs. Passing `0o666` asks for broad permissions. The OS mask narrows the result. In deployment, the service manager, shell, container image, or init system may set a different mask than your development shell.

Windows uses ACLs for actual permission decisions. Node maps POSIX-style modes onto Windows behavior where it can, but serious Windows permission control belongs in Windows-specific code.

## Close Is Part Of The Operation

Open. Use. Close.

The lifecycle is small, and every part has state behind it. `open` allocates descriptor-table state and kernel open-file state. `read`, `write`, `fstat`, `fsync`, and related calls use that state. `close` releases the descriptor slot and decrements the kernel reference count for the open file description.

```js
fs.open('/tmp/data.bin', 'r', (err, fd) => {
  if (err) return handleError(err);
  fs.read(fd, Buffer.alloc(64), 0, 64, 0, (readErr, bytesRead) =>
    fs.close(fd, (closeErr) => {
      if (readErr) return handleError(readErr);
      if (closeErr) return handleError(closeErr);
      console.log(`read ${bytesRead} bytes`);
    }));
});
```

The read call uses an explicit position of `0`, so it reads from the beginning and leaves the descriptor's current offset alone. The close happens inside the callback because the descriptor remains open until the async operation completes. The callback shape gets ugly fast. That ugliness is the point: raw fd code needs an explicit close path, and close can fail too. Move `fs.close()` above `fs.read()`, and the read races against descriptor reuse or fails with `EBADF`.

`close()` has one boundary worth remembering: it releases the descriptor. Written bytes may still sit in dirty pages in the page cache. Use `fs.fsync()` or `FileHandle.sync()` when crash durability matters, then close.

Descriptor reuse creates nasty bugs after a bad close pattern. Suppose code closes fd `18`, then later another part of the process opens a socket and gets fd `18`. A stale async callback that still holds the old integer can now operate on the new socket. Node's higher-level APIs reduce that risk by owning descriptors internally, but raw fd code leaves the lifecycle in your code.

## Leaks Become `EMFILE`

A leaked descriptor stays allocated until the process exits or the handle is closed by some cleanup path.

One leak barely moves the needle. A leak per request takes the service down. The OS enforces a per-process descriptor limit, and Node shares that budget across files, sockets, pipes, stdio, internal libuv descriptors, and active TCP connections.

Check the shell limit:

```sh
ulimit -n
```

Common defaults range from a few hundred to many thousands. Containers and service managers can set lower or higher values than your interactive shell.

When the process runs out, open operations fail with `EMFILE`.

```js
const fs = require('node:fs');

for (let i = 0; i < 2000; i++) {
  fs.open('/tmp/test.txt', 'r', (err, fd) => {
    if (err) return console.error(i, err.code);
  });
}
```

Every successful open consumes a slot. The snippet leaks all of them. Eventually `fs.open()` starts returning `EMFILE`, usually before the loop reaches the configured limit because Node and the process already hold descriptors.

Real leaks often sit in error paths.

```js
fs.open('/tmp/data.txt', 'r', (err, fd) => {
  if (err) return handleError(err);
  doWork(fd, (workErr) => {
    if (workErr) return handleError(workErr);
    fs.close(fd, (closeErr) => {
      if (closeErr) handleError(closeErr);
    });
  });
});
```

If `doWork()` reports an error, the descriptor stays open. The error handler exits before the close call. In callback code, you need an explicit close path for success and failure.

On Linux, `/proc/self/fd` gives the current process's open descriptor list:

```js
const fs = require('node:fs');

const count = fs.readdirSync('/proc/self/fd').length;
console.log('open descriptors:', count);
```

For an external view, use `lsof`:

```sh
lsof -p $(pgrep -f 'node app.js')
```

That output shows descriptors, target paths, sockets, pipes, and deleted files still held open. A count that grows over time under steady traffic usually means a leak. Flat counts under load mean the process is opening and closing at a stable rate.

Raising the limit increases capacity:

```sh
ulimit -n 65536
```

That change helps a server with many legitimate concurrent sockets. Leaking code still fails after more requests. Fix the close path, then size the limit for real concurrency.

## `FileHandle` Is The Better Default

Raw fd integers are easy to mishandle. `open()` from `node:fs/promises` wraps the descriptor in a `FileHandle`.

```js
import { open } from 'node:fs/promises';

const fh = await open('/tmp/data.txt', 'r');
console.log(fh.fd);
await fh.close();
```

The `.fd` property exposes the underlying descriptor, but most code should stay on the object. `FileHandle` has methods for `read()`, `write()`, `stat()`, `readFile()`, `writeFile()`, `truncate()`, `sync()`, and `close()`. The object carries the resource and the operations together.

Use `try` and `finally` when a handle spans more than one operation.

```js
const fh = await open('/tmp/data.txt', 'r');
try {
  const buf = Buffer.alloc(256);
  const result = await fh.read(buf, 0, 256, 0);
  console.log(result.bytesRead);
} finally {
  await fh.close();
}
```

`finally` runs on success and failure. The descriptor closes when parsing throws, when a read fails, or when later code returns early. That structure is the main reason `FileHandle` is the default choice for new code.

Node also supports explicit resource management in current releases. `FileHandle` implements `Symbol.asyncDispose`, so `await using` can close it at scope exit when your runtime and tooling accept the syntax.

```js
import { open } from 'node:fs/promises';

{
  await using fh = await open('/tmp/data.txt', 'r');
  const text = await fh.readFile('utf8');
  console.log(text.length);
}
```

There are two waits here. `await open()` waits for the open operation. `await using` registers async disposal for the binding. ESM keeps top-level `await using` in the module context where readers usually see it. When execution leaves the block, Node calls the handle's async disposer, which closes the descriptor.

Garbage collection is a diagnostic fallback. If a `FileHandle` becomes unreachable while still open, Node can close it and emit a warning. Treat that warning as a bug. GC timing is unrelated to descriptor pressure, traffic bursts, or your fd limit.

Raw descriptors still have a place. Legacy callback code uses them. Native addons may expect them. Some low-level APIs still speak in integers. For application code written with `async` and `await`, `FileHandle` is the clearer API.

## The libuv Path

File I/O APIs expose async callbacks and promises. Regular file operations still run as blocking OS calls in the common Node path.

libuv exposes filesystem work through `uv_fs_*` functions: `uv_fs_open()`, `uv_fs_read()`, `uv_fs_write()`, `uv_fs_close()`, and the rest. Each async call uses a `uv_fs_t` request. Node's C++ binding fills that request with the path, fd, flags, mode, buffers, offsets, and callback state needed by the operation.

For regular files, portable readiness-based async I/O has platform-specific constraints. Linux has `io_uring`, older Linux AIO exists with constraints, macOS readiness APIs fit sockets better than regular files, and Windows has overlapped I/O with different semantics. Node's stable path through libuv uses the worker pool for filesystem calls in normal operation. The default pool has four threads and is controlled by `UV_THREADPOOL_SIZE`.

The sequence for `fs.open('/tmp/x', 'r', cb)` is concrete.

Node validates arguments in JavaScript. The C++ binding receives the call and creates an FS request object. libuv queues work to the thread pool. A worker thread calls the platform open primitive. The kernel resolves the path, checks permissions, allocates open-file state, and returns either an fd-shaped value or an error. The worker stores the result on the `uv_fs_t` request and posts completion back to the loop. On the main thread, Node reads the request result, builds the JavaScript callback arguments, and calls your callback.

That means the event loop stays available while the worker thread blocks in the syscall. It also means the worker pool can become the bottleneck. Fire 500 concurrent `fs.open()` calls with the default pool, and four calls run while the rest wait in libuv's queue. The queue accepts the extra work. Latency rises.

The pool is shared. `dns.lookup()`, many crypto operations, compression work, and user code queued through libuv compete with filesystem operations. Increasing `UV_THREADPOOL_SIZE` can help file-heavy workloads, but it increases native thread count and can add scheduling overhead. Measure the workload. Blindly setting it to a large number often moves the wait from libuv's queue to the kernel scheduler or storage device.

The kernel has another layer of state after the worker reaches `open()`. On Linux, the process has a descriptor table. Entries in that table point at open file descriptions. Open file descriptions point at inodes or other kernel objects. Multiple descriptors can point at one open file description after duplication or inheritance. Multiple open file descriptions can point at the same inode after independent opens.

That distinction explains offset behavior. Two independent calls to `fs.open('/tmp/log', 'r')` produce separate open file descriptions. Their offsets move independently. A duplicated descriptor shares the same open file description. Its offset moves with the original. Append mode adds another rule: with `O_APPEND`, the kernel positions each write at end-of-file as part of the write operation.

`close()` unwinds references. The descriptor-table slot is freed. The open file description reference count drops. When the last descriptor pointing at that open file description closes, the kernel releases it. If the directory entry has already been removed, POSIX keeps the file data alive until that last close. That is why disk space may stay used after `rm` when a process still has the file open.

Node spawned children get a controlled view of descriptors. libuv opens file descriptors with close-on-exec where appropriate, and Node's `child_process` APIs pass only the stdio descriptors and any entries explicitly configured through `stdio`. That behavior keeps random application files from leaking into child programs.

Sync APIs take a shorter native path. `fs.openSync()` calls the filesystem operation on the main JavaScript thread and blocks until the OS returns. The call can be cheap when metadata is hot in cache. It can stall the whole process when storage is slow, remote, busy, or waiting on permissions infrastructure. Use sync file calls during startup, CLIs, and scripts where blocking the event loop has zero request traffic cost.

## Cross-Platform Cases

Most descriptor code stays portable when you use Node APIs and `node:path`. A few platform cases still matter.

Path separators differ. Use `path.join()` and `path.resolve()` for separator handling.

Case behavior differs. Linux filesystems are usually case-sensitive. Windows and default macOS filesystems usually treat `File.txt` and `file.txt` as the same path. Tests that pass on one platform can create name collisions on another.

Permission bits differ. POSIX modes and `umask` map cleanly on Unix-family systems. Windows ACLs carry the real permission model.

File locking differs. POSIX locks are commonly advisory. Windows sharing modes can prevent other opens. Node core exposes limited locking support, so applications that need lock files usually use a package built for that job and test it on the target OS.

Path length differs. Modern Windows APIs can handle long paths with the right prefixes and process settings, while old assumptions around `MAX_PATH` still surface in tools. POSIX path limits are byte-based and vary by filesystem.

## Production Habits

Prefer APIs that own descriptors internally. `readFile`, `writeFile`, `appendFile`, `createReadStream`, and `createWriteStream` open and close for you. Reach for `fs.open()` or `FileHandle` when you need repeated operations against one descriptor, random access, explicit durability calls, or integration with code that already expects an fd.

Limit fan-out. Processing 50,000 files can still use a small active descriptor set.

```js
const pLimit = require('p-limit');
const limit = pLimit(50);

const jobs = paths.map((path) => limit(() => processFile(path)));
await Promise.all(jobs);
```

That keeps at most 50 file operations active through your code path. The exact number depends on descriptor limits, storage latency, thread-pool pressure, and the rest of the process.

Track open descriptors in production. On Linux, export `/proc/self/fd` count as a gauge. Watch it beside request rate and active sockets. A rising descriptor count during flat traffic is a leak signal.

Close in `finally`. Use `await using` where your toolchain supports it. Keep raw fd integers contained to the smallest scope that needs them.

Descriptors are finite process resources. Node gives you high-level APIs that own most of the lifecycle, but the kernel still accounts for every open file, socket, and pipe. When the count hits the limit, the next open fails. The fix is usually boring: fewer concurrent opens, tighter cleanup, and metrics that show the count before `EMFILE` becomes the first alert.
