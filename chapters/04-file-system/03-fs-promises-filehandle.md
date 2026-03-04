---
title: "fs.promises and the FileHandle API"
date: "2026-02-22"
excerpt: "The fs.promises API, FileHandle objects, and migrating from callbacks to async/await file operations."
category: "File System"
tags: ["nodejs", "file-system", "fs-promises", "FileHandle", "async-await"]
author: "Ishtmeet Singh @ishtms"
chapter: "file-system"
subchapter: "fs-promises-filehandle"
published: true
toc: true
---

Every `fs` function you've used so far has a callback. You pass a function, Node fires it when the operation finishes, and you handle the error or the result. It works. But managing nested callbacks across multiple file operations gets tangled fast - and coordinating error handling through chains of `if (err) return callback(err)` is tedious in a way that scales poorly.

The `fs.promises` namespace fixes this. Every asynchronous filesystem operation gets a Promise-returning twin. You import from `node:fs/promises`, `await` the result, and catch errors with `try`/`catch`. Same underlying libuv calls. Same kernel syscalls. The JavaScript wrapping changes, and that changes everything about how your code reads.

But the bigger deal is `FileHandle`. When you call `fs.promises.open()`, you don't get a raw integer file descriptor back. You get an object - one that wraps the fd, tracks its lifecycle, provides methods for every operation you'd want, and integrates with modern JavaScript cleanup semantics like `await using`. The file descriptor (covered in subchapter 01) is still in there. You just don't have to manage it by hand anymore.

## The fs.promises Namespace

Two ways to get at it:

```js
import { readFile, writeFile, open } from 'node:fs/promises';
```

Or if you want both the callback API and the promise API in the same file:

```js
import fs from 'node:fs';
const fsp = fs.promises;
```

The first form is cleaner. Named imports, tree-shakeable in bundlers, and you get exactly the functions you need. The second form is handy during migration when you're converting callback code to promises one function at a time.

### What's Available

The namespace mirrors almost every async `fs` function. A partial list of the commonly used ones:

- `readFile(path, options)` - whole file into memory, returns Buffer or string
- `writeFile(path, data, options)` - replaces file contents
- `appendFile(path, data, options)` - appends to end
- `open(path, flags, mode)` - opens file, returns a FileHandle
- `stat(path, options)` and `lstat(path, options)` - metadata
- `readdir(path, options)` - directory listing
- `mkdir(path, options)` - create directory (supports `{ recursive: true }`)
- `rm(path, options)` - remove files or directories (supports `{ recursive: true, force: true }`)
- `rename(oldPath, newPath)` - rename or move
- `copyFile(src, dest, mode)` - copy a file
- `cp(src, dest, options)` - copy files or directories recursively (added in v16.7)
- `unlink(path)` - delete a file
- `symlink(target, path, type)` - create symbolic link
- `link(existingPath, newPath)` - create hard link
- `chmod(path, mode)` - change permissions
- `chown(path, uid, gid)` - change ownership
- `utimes(path, atime, mtime)` - set timestamps
- `mkdtemp(prefix, options)` - unique temporary directory
- `realpath(path, options)` - resolve symlinks
- `access(path, mode)` - check accessibility
- `truncate(path, len)` - truncate file

Every one returns a Promise. Resolves with the result on success, rejects with the error on failure. The uniformity is the point - you can chain them, parallelize them with `Promise.all()`, and handle errors in one place.

### Comparing the Two APIs

The callback `fs.readFile` and the promise-based `readFile` from `node:fs/promises` call the same C++ binding code. Both end up at the same `uv_fs_read` libuv function. Both submit work to the thread pool the same way. The kernel syscall is identical.

```js
import { readFile } from 'node:fs/promises';

const data = await readFile('/tmp/config.json', 'utf8');
const config = JSON.parse(data);
```

Compare that to the callback form:

```js
import fs from 'node:fs';

fs.readFile('/tmp/config.json', 'utf8', (err, data) => {
  if (err) throw err;
  const config = JSON.parse(data);
});
```

Same operation. Same performance at the syscall level. The Promise version adds one microtask for the resolution, which is negligible compared to actual disk I/O. You'd need to be doing tens of thousands of tiny file operations in a tight loop before that overhead matters - and even then, you'd want to batch with `Promise.all()` rather than fall back to callbacks.

The real difference is code structure. Sequential operations with callbacks nest. With promises, they stay linear:

```js
const configText = await readFile('config.json', 'utf8');
const config = JSON.parse(configText);
const data = await readFile(config.dataPath, 'utf8');
processData(data);
```

Four lines. Top to bottom. Any of these throws, it falls through to the nearest `catch`. No nesting, no manual `if (err)` guards at every step.

### Error Handling Patterns

The `try`/`catch` block is the primary error handling pattern:

```js
try {
  const data = await readFile(path, 'utf8');
  return JSON.parse(data);
} catch (err) {
  if (err.code === 'ENOENT') return null;
  throw err;
}
```

Inspect `err.code` to decide what to do. `ENOENT` means the file doesn't exist - maybe that's okay, so return a fallback. Anything else, rethrow it. Same error objects you'd get in callbacks, same `code` and `syscall` properties. The handling just moves into `catch` blocks instead of `if (err)` branches.

One pattern that causes problems: swallowing errors accidentally.

```js
const data = await readFile(path, 'utf8').catch(() => null);
```

Looks clean. But it catches *every* error - permission denied, I/O failure, corrupted path - and silently returns `null`. If you're going to use `.catch()` inline, be specific about which errors you're okay with. Otherwise, use `try`/`catch` and be explicit.

Another pitfall: forgetting to `await` a promise that throws.

```js
async function cleanup() {
  readFile('/tmp/data.txt'); // no await - if an error occurs, it becomes an unhandled rejection
}
```

The error vanishes into an unhandled promise rejection. In Node v15+, unhandled rejections terminate the process by default. Always `await` your promise-based fs calls, or at least attach a `.catch()`.

### fs.promises.constants

The `constants` object on `fs.promises` mirrors `fs.constants`. Permission flags, file access modes, copy flags - they're all there:

```js
import { access, constants } from 'node:fs/promises';

await access('/tmp/data.txt', constants.R_OK | constants.W_OK);
```

The bitwise OR combines multiple checks. `R_OK` checks read permission, `W_OK` checks write. If the file fails either check, the promise rejects with an `EACCES` error.

You'll use these constants mostly with `access()`, `copyFile()`, and `open()`. For `open()`, you usually pass string flags like `'r'` or `'w'` instead of the numeric constants, but they map to the same underlying values.

One thing worth knowing about `access()`: it checks permissions at the moment you call it, but those permissions can change before you actually open the file. There's a race condition between checking and opening. A better pattern for most cases is to just `open()` the file inside a `try`/`catch` and handle the error. Using `access()` as a precondition check is only useful when you genuinely want to report on permissions without attempting the operation - building a file browser UI, for instance, or validating a config before a long-running process starts.

### Directory Operations

A few directory functions deserve a closer look because they have options that change their behavior substantially.

`mkdir` with `{ recursive: true }` creates the entire path, including intermediate directories:

```js
await mkdir('/tmp/a/b/c/d', { recursive: true });
```

No error if the path already exists. Without `recursive`, creating `/tmp/a/b/c/d` fails if `/tmp/a/b/c` doesn't exist yet. The return value is the first directory that was actually created, or `undefined` if none needed creating.

`readdir` with `{ withFileTypes: true }` returns `Dirent` objects instead of strings:

```js
const entries = await readdir('/tmp', { withFileTypes: true });
for (const entry of entries) {
  console.log(entry.name, entry.isFile(), entry.isDirectory());
}
```

Each `Dirent` has methods like `isFile()`, `isDirectory()`, `isSymbolicLink()`. You get the file type without a separate `stat()` call for each entry. For directories with thousands of files, this saves thousands of syscalls.

The `{ recursive: true }` option on `readdir` (added in v20.1.0 and backported to v18.17) walks the entire directory tree:

```js
const allFiles = await readdir('/project/src', { recursive: true });
```

Returns every file and subdirectory, with paths relative to the starting directory. Convenient, but be careful with large trees - the entire listing loads into memory at once.

`rm` with `{ recursive: true, force: true }` is the promise equivalent of `rm -rf`:

```js
await rm('/tmp/build-output', { recursive: true, force: true });
```

`force: true` suppresses the error when the path doesn't exist. Without it, removing a nonexistent path throws `ENOENT`.

## The FileHandle Object

Calling `fs.promises.open()` gives you a FileHandle. Unlike `fs.open()` from the callback API, which hands back a raw integer fd in the callback, `open()` from promises returns an object that wraps the descriptor and provides methods.

```js
import { open } from 'node:fs/promises';

const fh = await open('/tmp/data.txt', 'r');
console.log(fh.fd); // the raw integer, e.g. 21
```

The `fd` property is there if you need it - passing to a native addon, or interfacing with some legacy callback-based code that expects a number. But most of the time, you call methods directly on the FileHandle.

### Methods on FileHandle

Here's what a FileHandle gives you:

**Reading and writing:**
- `fh.read(buffer, offset, length, position)` - low-level byte read into a buffer
- `fh.write(buffer, offset, length, position)` - low-level byte write from a buffer
- `fh.readFile(options)` - read the whole file from current position
- `fh.writeFile(data, options)` - overwrite file contents
- `fh.appendFile(data, options)` - append data

**Metadata and control:**
- `fh.stat(options)` - file metadata (size, timestamps, permissions)
- `fh.truncate(len)` - shrink or extend file to `len` bytes
- `fh.chmod(mode)` - change permissions
- `fh.chown(uid, gid)` - change ownership
- `fh.utimes(atime, mtime)` - update access/modification timestamps

**Durability:**
- `fh.sync()` - flush data and metadata to disk (wraps fsync)
- `fh.datasync()` - flush data only, skip metadata (wraps fdatasync)

**Vectored I/O:**
- `fh.readv(buffers, position)` - scatter read into multiple buffers
- `fh.writev(buffers, position)` - gather write from multiple buffers

**Streams:**
- `fh.createReadStream(options)` - readable stream from this file
- `fh.createWriteStream(options)` - writable stream to this file

**Lifecycle:**
- `fh.close()` - close the underlying fd
- `fh[Symbol.asyncDispose]()` - automatic close (used by `await using`)

Every method returns a Promise. You `await` each one.

### Reading Bytes

The low-level `fh.read()` works with buffers directly:

```js
const fh = await open('/tmp/data.bin', 'r');
const buf = Buffer.alloc(64);
const { bytesRead, buffer } = await fh.read(buf, 0, 64, 0);
console.log(bytesRead, buffer.subarray(0, bytesRead));
await fh.close();
```

The return value is an object with `bytesRead` (how many bytes were actually read - could be less than 64 if the file is smaller) and `buffer` (a reference to the same buffer you passed in). The `position` argument is the byte offset in the file to start reading from. Pass `null` to read from the current file position.

There's a simpler overload if you just want the data:

```js
const fh = await open('/tmp/data.bin', 'r');
const { bytesRead, buffer } = await fh.read({ buffer: Buffer.alloc(64) });
await fh.close();
```

The object form lets you skip the positional arguments you don't care about. `offset` defaults to 0, `length` to the buffer's length, `position` to `null` (current position).

### Writing Bytes

`fh.write()` mirrors `fh.read()`:

```js
const fh = await open('/tmp/out.bin', 'w');
const data = Buffer.from('hello, file');
const { bytesWritten } = await fh.write(data, 0, data.length, 0);
await fh.close();
```

You can also write strings directly:

```js
const fh = await open('/tmp/out.txt', 'w');
const { bytesWritten } = await fh.write('some text', null, 'utf8');
await fh.close();
```

When passing a string, the second argument is position (or `null` for current position) and the third is encoding.

### readFile and writeFile on FileHandle

Sometimes you open a file for a reason - checking its stat, conditionally reading it, doing multiple operations - and partway through you just want to read the entire thing. FileHandle has `readFile` and `writeFile` methods for that:

```js
const fh = await open('package.json', 'r');
const stats = await fh.stat();
if (stats.size > 10_000_000) throw new Error('too large');
const content = await fh.readFile('utf8');
await fh.close();
```

You opened the file, checked its size, and only then read the contents. A single `open` call. One fd used. The alternative - calling `stat()` then `readFile()` separately from the top-level namespace - would open the file twice.

`fh.writeFile()` replaces the file's contents entirely:

```js
const fh = await open('/tmp/state.json', 'w');
await fh.writeFile(JSON.stringify({ count: 42 }));
await fh.close();
```

### FileHandle as an Async Iterable

FileHandle implements the async iterable protocol. You can iterate over a file's lines directly:

```js
const fh = await open('/tmp/log.txt', 'r');
for await (const line of fh.readLines()) {
  process.stdout.write(line + '\n');
}
await fh.close();
```

The `readLines()` method returns an async iterable that yields one line at a time, using the readline module internally. Memory usage stays constant regardless of file size - it reads chunks and splits on line boundaries.

You can also use the FileHandle itself as an async iterable with `createReadStream`:

```js
const fh = await open('/tmp/data.csv', 'r');
const stream = fh.createReadStream({ encoding: 'utf8' });
for await (const chunk of stream) {
  processChunk(chunk);
}
```

The stream is tied to the FileHandle's fd. When the stream finishes, the fd stays open - you still need to close the FileHandle. Or use `await using` and skip worrying about it entirely.

### stat, truncate, and datasync

A few of the less obvious FileHandle methods:

`fh.stat()` returns the same `Stats` object as the top-level `stat()`, but operates on the already-open fd. Avoids the path resolution and an extra open/close cycle. Particularly useful when you've opened a file and need to make decisions based on its metadata before proceeding with reads or writes.

`fh.truncate(len)` sets the file's size. If `len` is shorter than the current size, the file shrinks - the trailing bytes are gone. If `len` is longer, the file grows and the new bytes are filled with zero bytes (a sparse hole, on filesystems that support it). You'd use this when rewriting a file's contents where the new data is shorter than the old - without truncation, the tail of the old content remains.

```js
await using fh = await open('/tmp/data.txt', 'r+');
await fh.writeFile('short');
await fh.truncate(5);
```

`fh.datasync()` and `fh.sync()` both force buffered data to disk. The difference: `sync()` flushes the data *and* the file's metadata (size, timestamps, permissions). `datasync()` flushes only the data, skipping metadata updates. On Linux, `datasync()` maps to the `fdatasync` syscall, which can be faster because updating metadata requires an extra disk write for the inode. If you only care that your bytes are on disk and don't need the metadata to be consistent, `datasync()` is the right call.

## The close() Obligation

When you `open()` a file and get a FileHandle, you own that file descriptor until you call `close()`. Forget to close it, and the descriptor leaks. Do that enough times and you hit the per-process fd limit, which triggers EMFILE errors (covered in subchapter 01) for everything - file opens, socket connections, pipe creation.

The basic pattern:

```js
const fh = await open(path, 'r');
try {
  const data = await fh.readFile('utf8');
  return JSON.parse(data);
} finally {
  await fh.close();
}
```

`finally` runs whether `try` succeeds or throws. The fd gets closed either way. You can add a `catch` block between them if you want to handle errors specifically, but the `finally` is what matters for cleanup.

A subtlety: if `open()` itself fails, `fh` is never assigned. The `try`/`finally` block never executes. Nothing to close. The error propagates up normally.

When you have multiple FileHandles:

```js
const src = await open(srcPath, 'r');
try {
  const dest = await open(destPath, 'w');
  try {
    const data = await src.readFile();
    await dest.writeFile(data);
  } finally {
    await dest.close();
  }
} finally {
  await src.close();
}
```

Nested `try`/`finally`. Verbose. Each resource gets its own cleanup block. The nesting gets worse with three or four handles. `await using` exists precisely because this pattern doesn't scale.

### What Happens When You Don't Close

Node tracks unclosed FileHandles. If a FileHandle becomes unreachable without being closed - garbage collected while still open - Node will close the underlying fd for you and print a warning:

```
(node:12345) Warning: Closing file descriptor 21 on garbage collection
```

The warning includes the fd number. Helpful for debugging, but you shouldn't rely on this. Garbage collection timing is unpredictable. V8 might not GC for seconds or minutes, depending on memory pressure. During that window, the fd stays open, counting against your process's limit.

The cleanup mechanism uses a `FinalizationRegistry`. When a FileHandle is created, Node registers it with a FinalizationRegistry callback. If the GC reclaims the FileHandle's JavaScript object before `close()` is called, the registry fires and Node closes the fd. More on this in the internals section below.

## await using

The TC39 Explicit Resource Management proposal landed in V8 and is available in Node.js v22 without any flags. FileHandle implements `Symbol.asyncDispose`, which means `await using` works out of the box:

```js
async function readConfig(path) {
  await using fh = await open(path, 'r');
  return JSON.parse(await fh.readFile('utf8'));
}
```

When the function scope exits - whether by returning normally or throwing - the runtime calls `fh[Symbol.asyncDispose]()`, which calls `fh.close()`. No `try`/`finally` needed. No forgetting to close. The language handles it.

Multiple handles? Each one gets cleaned up in reverse declaration order:

```js
async function copyFile(src, dest) {
  await using srcFh = await open(src, 'r');
  await using destFh = await open(dest, 'w');
  await destFh.writeFile(await srcFh.readFile());
}
```

When the function exits, `destFh` closes first, then `srcFh`. Reverse order, matching the convention for resource cleanup stacks. Compare this to the nested `try`/`finally` version from earlier - same behavior, a fraction of the code.

### How Symbol.asyncDispose Works

When you write `await using x = expr`, the runtime:

1. Evaluates `expr` and assigns the result to `x`.
2. Checks that `x` has a `[Symbol.asyncDispose]` method (or `[Symbol.dispose]` for the synchronous `using` variant).
3. Registers `x` in a disposal stack for the current block scope.
4. When the block exits, iterates the stack in reverse order, calling `await x[Symbol.asyncDispose]()` for each resource.

FileHandle's implementation is minimal:

```js
[Symbol.asyncDispose]() {
  return this.close();
}
```

It just calls `close()`. The magic is in the language syntax, not the method. `await using` guarantees the call happens at scope exit. An error during disposal gets wrapped in a `SuppressedError` if the block was already throwing - both the original error and the disposal error are preserved.

### When to Use await using vs try/finally

Use `await using` when:
- You're opening a file, doing work, and want cleanup guaranteed.
- Multiple resources need cleanup in a predictable order.
- You want the code to be self-documenting about resource ownership.

Fall back to `try`/`finally` when:
- You need custom logic in the cleanup path (logging, metrics, conditional cleanup).
- You want to handle close errors differently from operation errors.
- You're maintaining code that needs to run on older Node versions.

For new code targeting Node v22+, `await using` should be your default. It's shorter, harder to get wrong, and communicates intent.

## Convenience Functions vs FileHandle

The `fs.promises` namespace has two tiers of API. The convenience functions - `readFile`, `writeFile`, `stat`, `mkdir`, and so on - operate on paths. They open the file, do the operation, close the file, and return the result. One call, one operation, resource cleanup built in.

```js
const data = await readFile('/tmp/config.json', 'utf8');
```

FileHandle operations go through `open()` first. You get a handle, call methods on it, and close it when done. More code, more control.

When to use which?

**Convenience functions** for one-shot operations. Reading a config file. Writing a result. Checking if a path exists. The open/close lifecycle is handled for you.

**FileHandle** when you need multiple operations on the same file. Read a header, then seek to a position, then write. Check the stat, conditionally read. Or when you want to hold a file open across async boundaries - processing data in batches, appending results over time.

There's a performance angle too. If you're reading a file's stat and then reading its contents, the convenience approach opens the file twice:

```js
const stats = await stat(path);
const data = await readFile(path, 'utf8');
```

Two `open()` calls, two `close()` calls under the hood. With FileHandle:

```js
await using fh = await open(path, 'r');
const stats = await fh.stat();
const data = await fh.readFile('utf8');
```

One `open()`, one `close()`. Half the syscalls. For a single file, the difference is microseconds. For thousands of files in a batch job, it adds up.

## Parallel File Operations

Independent file operations can overlap. `Promise.all()` fires them all at once:

```js
const [configText, schemaText, dataText] = await Promise.all([
  readFile('config.json', 'utf8'),
  readFile('schema.json', 'utf8'),
  readFile('data.json', 'utf8'),
]);
```

Three reads, all submitted to the thread pool simultaneously. The `await` resolves when all three complete. If any one rejects, `Promise.all` rejects with that error and the other results are discarded.

For cases where you want all results regardless of individual failures:

```js
const results = await Promise.allSettled([
  readFile('a.json', 'utf8'),
  readFile('b.json', 'utf8'),
  readFile('maybe-missing.json', 'utf8'),
]);
```

Each element in `results` has a `status` of `'fulfilled'` or `'rejected'`, with `value` or `reason` respectively. You process whatever succeeded and handle the failures individually.

### When Parallel Hurts

Parallel file I/O isn't always faster. The thread pool has a finite size (default 4 workers). If you fire 200 file reads simultaneously, only 4 run at a time - the rest queue up. And if those files live on the same physical disk, parallel reads can cause head thrashing on spinning drives or exceed I/O controller throughput on SSDs.

A bounded concurrency approach works better for large batches:

```js
async function readBatch(paths, concurrency = 8) {
  const results = [];
  for (let i = 0; i < paths.length; i += concurrency) {
    const batch = paths.slice(i, i + concurrency);
    const data = await Promise.all(batch.map(p => readFile(p, 'utf8')));
    results.push(...data);
  }
  return results;
}
```

Process `concurrency` files at a time. Wait for the batch to finish. Move to the next batch. You control how many are in-flight, preventing thread pool starvation and keeping I/O pressure manageable.

### Mixing Sequential and Parallel

Real workflows combine both patterns. You read a config file (sequential, because you need it to decide what to do), then process a batch of data files (parallel, because they're independent), then write a summary (sequential, because it depends on all the results):

```js
const config = JSON.parse(await readFile('config.json', 'utf8'));
const datasets = await Promise.all(
  config.files.map(f => readFile(f, 'utf8'))
);
const summary = buildSummary(datasets);
await writeFile('summary.json', JSON.stringify(summary));
```

The structure mirrors the data dependencies. Sequential where you must be, parallel where you can be. The thread pool handles the overlap, and your code reads naturally from top to bottom.

One gotcha with `Promise.all` and file writes: if you're writing to the *same* file from multiple promises, the writes race. File I/O isn't atomic at the `writeFile` level - two concurrent writes to the same path can interleave, producing corrupted output. Only parallelize writes to *different* files.

## Migrating from Callbacks to Promises

If your codebase already uses callback-based `fs`, converting to promises is mechanical. The pattern is consistent across every function:

**Before:**

```js
fs.readFile(path, 'utf8', (err, data) => {
  if (err) return handleError(err);
  doSomething(data);
});
```

**After:**

```js
try {
  const data = await readFile(path, 'utf8');
  doSomething(data);
} catch (err) {
  handleError(err);
}
```

The mapping: callback parameters become `await` assignments. Error-first `if (err)` branches become `catch` blocks. Nested callbacks flatten into sequential `await` lines.

### Wrapping Legacy Code

For third-party libraries or your own functions that still use callbacks, `util.promisify` converts them:

```js
import { promisify } from 'node:util';
import { stat } from 'node:fs';

const statAsync = promisify(stat);
const info = await statAsync('/tmp/data.txt');
```

You won't need this for `fs` itself - `node:fs/promises` already exists. But for older modules or custom callback-based APIs, `promisify` bridges the gap.

Going the other direction - calling promise-based code from callback-based callers - is also possible:

```js
function legacyReadConfig(path, callback) {
  readFile(path, 'utf8')
    .then(data => callback(null, JSON.parse(data)))
    .catch(err => callback(err));
}
```

Both directions work. Mix them during migration. Convert incrementally. Start with new code using promises, and refactor old code as you touch it.

### Migration Pitfalls

A few things that catch people:

**Forgetting to await.** An `async` function that calls `writeFile()` without `await` returns immediately. The write happens in the background. If the next line depends on that file existing, it might fail intermittently.

**Double error handling.** Wrapping `await` in `try`/`catch` and also chaining `.catch()` - one of them is redundant, and the interaction can be confusing. Pick one style per call site.

**Unhandled rejections from fire-and-forget.** Calling an async function without awaiting it and without `.catch()` means a rejection has nowhere to go. Node v15+ treats unhandled rejections as fatal. If you intentionally fire-and-forget, attach a `.catch()`:

```js
writeFile('/tmp/log.txt', logData).catch(console.error);
```

**Mixing sync and promise in the same function.** Sometimes you'll see code that calls `fs.existsSync()` before an `await readFile()`. It works, but it defeats the purpose. The sync call blocks the event loop. If you're in an async function, keep everything async:

```js
try {
  await access(path);
} catch {
  // file doesn't exist - handle it
}
```

Or better, just attempt the operation and handle the error, rather than checking first.

**Error code differences.** The error objects from `fs.promises` are identical to callback errors. Same `code` property (`ENOENT`, `EACCES`, `EISDIR`, etc.), same `syscall` property (`open`, `read`, `stat`), same `path` property. Your existing error handling logic transfers directly - you're just moving it from `if (err)` into `catch`.

## How fs.promises Wraps libuv

Both the callback and promise APIs end up at the same place: libuv's `uv_fs_*` functions. The difference is in the JavaScript-side plumbing that connects your code to those C++ calls.

The callback API path goes through `lib/fs.js`. When you call `fs.readFile(path, cb)`, Node creates an `FSReqCallback` object - a C++ request wrapper that stores your JavaScript callback. It calls `uv_fs_read()` with this request object. When libuv finishes the operation (in a thread pool worker), it signals completion back to the event loop. The event loop fires the C++ completion callback, which extracts your JavaScript function from the `FSReqCallback` and calls it with the error or result.

The promise API path goes through `lib/internal/fs/promises.js`. Same libuv call, different wrapper. Instead of `FSReqCallback`, it creates an `FSReqPromise` - a C++ request object that holds a persistent reference to the V8 Promise Resolver object. When libuv completes the operation, the C++ completion handler calls `resolver->Resolve(result)` or `resolver->Reject(error)` internally. The resolved value flows back to your `await` expression through the microtask queue.

The code in `lib/internal/fs/promises.js` is surprisingly direct. Here's a simplified version of how `readFile` works internally:

```
function readFile(path, options) {
  const req = new FSReqPromise();
  binding.read(fd, buffer, offset, length, position, req);
  return req.promise;
}
```

`FSReqPromise` has a `.promise` property - a real `Promise` object whose resolve/reject functions are captured during construction. The `binding.read()` call sends the work to libuv. When it finishes, the C++ side resolves the promise. The intermediary never touches the JavaScript thread until resolution.

### FileHandle Internals

The `FileHandle` class lives in `lib/internal/fs/promises.js`. It's a JavaScript class that holds the fd and provides methods. Each method creates an `FSReqPromise`, dispatches the operation, and returns the promise.

But there's more going on under the surface. FileHandle tracks whether it's been closed. Calling any method on a closed handle throws `ERR_USE_AFTER_CLOSE`. The `fd` property returns `-1` after closing. And every FileHandle is ref-counted - the underlying C++ handle has a reference count that keeps the event loop alive while the handle is open. This means an unclosed FileHandle prevents your process from exiting cleanly, the same way an active timer or server socket would.

When you call `fh.close()`, it decrements the ref count, submits a `uv_fs_close` request to the thread pool, and returns a Promise that resolves when the kernel actually closes the descriptor. The FileHandle marks itself as closed immediately - you can't call methods on it anymore even though the close hasn't completed yet.

### The FinalizationRegistry Safety Net

Every FileHandle created by `open()` is registered with a `FinalizationRegistry`. The code looks roughly like this (simplified from Node's source):

```
const kCloseResolve = Symbol('kCloseResolve');
const kFd = Symbol('kFd');

const registry = new FinalizationRegistry((ref) => {
  // ref contains the raw fd
  if (ref.fd !== -1) {
    process.emitWarning(
      `Closing file descriptor ${ref.fd} on garbage collection`
    );
    // Node issues an asynchronous background close (e.g., via uv_fs_close)
    // instead of a blocking closeSync, to prevent stalling the event loop.
    internalBackgroundClose(ref.fd);
  }
});
```

When the FileHandle constructor runs, it calls `registry.register(this, { fd: this[kFd] })`. The weak reference lets V8 know: if this FileHandle gets garbage collected, run the finalization callback with the held value (which contains the fd number).

The safety net has limits. `FinalizationRegistry` callbacks run on the microtask queue after GC, but GC timing is non-deterministic. V8 runs GC when it wants to - based on allocation pressure, heap size thresholds, and idle time heuristics. Your fd might stay open for seconds, minutes, or the entire process lifetime if there's no memory pressure to trigger collection.

And there's a subtlety: the held value (the `{ fd }` object) must not reference the FileHandle itself. If it did, the FileHandle could never become unreachable - the FinalizationRegistry would keep it alive through the held value, defeating the whole purpose. Node is careful about this, storing only the raw fd integer in the held value.

The warning is intentional. Node wants you to know you forgot to close a handle. In production, these warnings should be treated as bugs.

### The FSReqPromise C++ Class

Down in `src/node_file.cc`, the `FSReqPromise` class inherits from `FSReqBase`. It holds a persistent reference to the V8 Promise Resolver object. When libuv calls the completion handler:

1. The C++ callback extracts the `FSReqPromise` from the request.
2. If the libuv operation returned an error, it creates a JavaScript error object with the appropriate code (`ENOENT`, `EACCES`, etc.) and calls `resolver->Reject()`.
3. On success, it marshals the result (bytes read, stat structure, etc.) into JavaScript values and calls `resolver->Resolve()`.

The marshaling step is where the promise and callback paths diverge slightly. The callback path calls your function synchronously on the event loop thread. The promise path calls `resolver->Resolve()`, which schedules a microtask - your `await` picks it up on the next microtask checkpoint. One additional microtask per operation, which is the source of the (negligible) overhead mentioned earlier.

One more detail: `FSReqPromise` shares a base class (`FSReqBase`) with the callback-style `FSReqCallback`, so the underlying C++ plumbing for dispatching work to libuv is identical. The promise variant just swaps the completion mechanism - resolve/reject instead of calling a JS callback. You'd only notice the difference in benchmarks doing millions of file operations, and even then the gap is negligible.

## Combining FileHandle with Streams

FileHandle can create streams tied to its fd:

```js
await using fh = await open('/tmp/large-file.csv', 'r');
const stream = fh.createReadStream({ encoding: 'utf8' });
```

The stream reads from the file handle's descriptor. A few things to be aware of: the stream doesn't own the fd. Closing the stream doesn't close the FileHandle. You need to manage both lifecycles. With `await using`, the handle closes at scope exit, but you should ensure the stream has finished reading before that happens.

A safe pattern using `pipeline()`:

```js
import { pipeline } from 'node:stream/promises';

await using fh = await open('input.csv', 'r');
const readable = fh.createReadStream();
await pipeline(readable, transformStream, outputStream);
```

The `await pipeline(...)` resolves when all data has flowed through. After that, `fh` is closed by `await using`. The ordering is correct because `pipeline` finishes before the scope exits.

For writable streams:

```js
await using fh = await open('output.log', 'a');
const writable = fh.createWriteStream();
writable.write('entry 1\n');
writable.write('entry 2\n');
writable.end();
```

Calling `writable.end()` signals the stream is done. The underlying fd stays open until the FileHandle is closed. The `autoClose` option on `createWriteStream` defaults to `true` regardless of whether you use a path or a FileHandle. With `autoClose: true`, the fd closes automatically on `'error'` or `'finish'` - but that closes the underlying fd, which can invalidate your FileHandle. If you're managing the handle's lifecycle yourself with `await using` or `try`/`finally`, set `autoClose: false` explicitly.

## When to Use Which API

Three options on the table: synchronous `fs.*Sync`, callback `fs.*`, and promise-based `fs.promises.*`.

**Sync** - startup code, CLI tools, build scripts. Anywhere the event loop doesn't matter. Simple, no error handling complexity, blocks the thread.

**Callbacks** - legacy code that's already callback-based. Performance-sensitive hot paths where you've measured that microtask overhead matters (rare). Interfacing with libraries that expect callbacks.

**Promises** - everything else. New application code, server handlers, middleware, batch processing, anything using `async`/`await`. The default choice for modern Node.js.

The ecosystem has moved to promises and `async`/`await`. HTTP frameworks, database drivers, queue clients - they all return promises. File operations should match. Mixing callbacks into an otherwise promise-based codebase creates friction, makes error handling inconsistent, and confuses new developers reading the code.

For performance: the overhead of promises over callbacks is one microtask per operation. File I/O takes milliseconds. The microtask takes microseconds. The math is clear. Use promises unless you have profiler data showing otherwise - and if you do, the answer is probably "batch operations with `Promise.all`" rather than "switch to callbacks."

One more consideration. The `fs.promises` API is the one that gets attention in new Node releases. New methods like `cp()` for recursive directory copying, `readdir` with `{ recursive: true }`, and `glob()` (added in v22) land in `fs.promises` first. The callback API gets them too, but the momentum is clearly on the promise side. Sticking with callbacks means waiting longer for new features and reading docs that increasingly assume promise-based usage.

The `glob()` function is worth mentioning specifically. It's new enough that some codebases still reach for third-party packages like `fast-glob` or `globby`:

```js
import { glob } from 'node:fs/promises';

for await (const tsFile of glob('**/*.ts', { cwd: '/project/src' })) {
  console.log(tsFile);
}
```

Returns an async iterable of matching paths. You iterate with `for await...of`, or collect them into an array with `Array.fromAsync()`. Built into Node, no extra dependency. The pattern matching follows standard glob rules - `*` matches any characters except path separators, `**` matches any number of directories. Having this in the standard library is a big deal for tooling scripts and build systems that used to require third-party glob packages.

