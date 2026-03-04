---
title: "Reading and Writing Files"
date: "2026-02-22"
excerpt: "Reading and writing files in Node.js with fs.readFile, fs.writeFile, and their synchronous counterparts."
category: "File System"
tags: ["nodejs", "file-system", "fs", "readFile", "writeFile"]
author: "Ishtmeet Singh @ishtms"
chapter: "file-system"
subchapter: "reading-writing-files"
published: true
toc: true
---

Every file operation in Node.js starts with a file descriptor. The previous subchapter covered how those descriptors get allocated, tracked, and released. This subchapter is about what you do with them - read bytes in, write bytes out. The `fs` module gives you five tiers of abstraction for this, ranging from "read the entire thing into memory" down to "read exactly 47 bytes starting at offset 8192." Picking the right one depends on the file size, whether you need the whole thing at once, and how much control you need over memory and positioning.

We'll go through all of them: the buffer-all APIs (`readFile`, `writeFile`, `appendFile`), the stream-based APIs (`createReadStream`, `createWriteStream`), the low-level byte APIs (`fs.read`, `fs.write`), line-by-line reading with `readline`, and the durability layer (`fsync`). And then we'll dig into what actually happens inside libuv when any of these gets called - the thread pool dispatch mechanism that most Node developers never think about but that governs the performance of every file operation.

## Reading Entire Files with readFile

The simplest reading API is `fs.readFile()`. Hand it a path, get back the contents.

```js
const fs = require('fs');
fs.readFile('./config.json', 'utf8', (err, data) => {
  if (err) throw err;
  const config = JSON.parse(data);
});
```

Node opens the file, calls `fstat` to learn the size, allocates a buffer that big, reads every byte into it, closes the descriptor, and hands you the result through the callback. If you pass an encoding like `'utf8'`, Node converts the buffer to a string before returning it. Omit the encoding, you get a raw Buffer.

The promise-based version reads cleaner:

```js
const data = await fs.promises.readFile('./config.json', 'utf8');
const config = JSON.parse(data);
```

Same behavior, but wrapped in a promise so you can use async/await. Under the hood, the I/O path is identical - it dispatches to the thread pool, runs the syscalls, and resolves the promise when done.

### readFileSync and Blocking

The synchronous counterpart blocks the main thread:

```js
const data = fs.readFileSync('./config.json', 'utf8');
```

Everything stops while the read completes. No timers fire. No incoming requests get processed. No microtasks run. The event loop is frozen.

For startup code, that's fine. Loading configuration before the server starts accepting connections doesn't hurt anyone - there's no concurrency to protect yet. CLI tools that read a file, transform it, and exit are the same. There's no event loop doing useful work, so blocking it costs nothing.

```js
// At startup - fine
const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
const app = createServer(config);
app.listen(3000);
```

But in a request handler, `readFileSync` is catastrophic. A 10 ms file read blocks the entire process for 10 ms. If every request does this, your absolute maximum theoretical throughput becomes exactly 100 requests per second (1000 ms / 10 ms). An app that could normally handle 5,000 requests per second hits a hard brick wall at 100. And that's with fast SSD reads - on network-mounted filesystems or under heavy disk load, reads can take 50-100 ms, dropping your maximum throughput to 10-20 requests per second.

### Memory Implications

`readFile` loads the entire file into a single buffer. A 10 KB config file uses 10 KB. A 500 MB log file uses 500 MB. The relationship is linear and unforgiving.

Buffer memory lives outside V8's managed heap (covered in Chapter 2), but V8 still tracks it through external memory accounting. Large allocations trigger more frequent garbage collection cycles. V8 pauses the event loop during these GC sweeps to scan the heap. With a few hundred megabytes of buffer allocations, you can see GC pauses of 50-200 ms - during which every connection stalls.

Concurrent reads compound the problem. Ten requests each reading a 100 MB file? That's a gigabyte of simultaneous buffer allocations. In a container with 512 MB of RAM, you're dead. Even with 4 GB, the GC pressure alone tanks performance.

The threshold where `readFile` stops being practical depends on your environment and concurrency level. As a rough guide: files under 1 MB are almost always fine. Files between 1-50 MB work if you're reading one at a time. Anything beyond that, use streams.

### Error Handling

File operations fail. The path might not exist. Permissions might be wrong. The disk might be full or disconnected. The error object's `.code` property tells you what happened:

```js
try {
  const data = await fs.promises.readFile(path, 'utf8');
  return JSON.parse(data);
} catch (err) {
  if (err.code === 'ENOENT') return {};  // file doesn't exist
  if (err.code === 'EACCES') throw new Error('permission denied');
  throw err;
}
```

`ENOENT` means the path doesn't exist. It's often expected - a cache file that hasn't been created yet, an optional config file. Handle it by returning a default value. `EACCES` means the process doesn't have read permission. `EISDIR` means you accidentally passed a directory path. `EMFILE` means you've hit the file descriptor limit (covered in the previous subchapter).

With the callback API, errors arrive as the first callback argument. With promises, they're rejected. With sync calls, they're thrown as exceptions. The error codes are the same regardless of which style you use.

### The AbortSignal Option

You can cancel an in-flight `readFile` with an AbortSignal:

```js
const controller = new AbortController();
setTimeout(() => controller.abort(), 500);

try {
  const data = await fs.promises.readFile('./huge.bin', {
    signal: controller.signal
  });
} catch (err) {
  if (err.name === 'AbortError') console.log('read cancelled');
}
```

If the abort fires before the read completes, Node cleans up the file descriptor and rejects with an `AbortError`. Handy for enforcing timeouts on file operations or letting a user cancel a long-running read.

## Writing Entire Files with writeFile

`fs.writeFile()` is the write-side counterpart. Pass a path and data:

```js
await fs.promises.writeFile('./output.json', JSON.stringify(data));
```

Node opens the file (creating it if it doesn't exist), truncates it to zero length, writes all the bytes, and closes the descriptor. The default flag is `'w'` - open for writing, create if needed, truncate if exists.

Data can be a string (encoded to bytes using `'utf8'` by default), a Buffer, a TypedArray, or a DataView. For strings, you can specify a different encoding:

```js
await fs.promises.writeFile('./output.txt', content, 'latin1');
```

### Exclusive Creation with 'wx'

The `'wx'` flag makes file creation atomic: it fails if the file already exists.

```js
await fs.promises.writeFile('./lock.pid', process.pid.toString(), {
  flag: 'wx'
});
```

At the syscall level, this sets `O_CREAT | O_WRONLY | O_EXCL`. The kernel either creates the file and opens it, or returns `EEXIST`. There's no race window between "check if exists" and "create." Two processes competing to create the same lock file? Exactly one wins.

### File Permissions on Creation

When `writeFile` creates a new file, it uses the `mode` option to set permissions:

```js
await fs.promises.writeFile('./secret.key', keyData, {
  mode: 0o600  // owner read/write only
});
```

The default is `0o666`, modified by the process umask (typically `0o022`, resulting in `0o644`). But here's a subtlety: `mode` only applies when the file is being created. If the file already exists, its permissions stay unchanged. To enforce permissions regardless, call `chmod` after writing.

### The Truncation Problem

The `'w'` flag truncates the file before writing new data. If the process crashes between truncation and write completion, you're left with an empty or partially written file. For config files, state files, or anything where corruption means a broken application on restart, this is a real risk.

The fix is the temp-file-and-rename pattern:

```js
const crypto = require('crypto');
const tmpPath = `${target}.tmp.${crypto.randomBytes(4).toString('hex')}`;
await fs.promises.writeFile(tmpPath, data);
await fs.promises.rename(tmpPath, target);
```

Write to a uniquely named temp file. If the write fails, the original is untouched. If the write succeeds, rename atomically replaces the old file. On POSIX systems, `rename()` on the same filesystem is atomic - readers see either the old content or the new content, never a half-written state. The random suffix prevents collisions when multiple processes write to the same target.

### writeFileSync

Same blocking behavior as `readFileSync`. Uses main-thread syscalls, freezes the event loop. Appropriate for startup code and scripts. Fatal for server throughput if used in hot paths.

```js
try {
  fs.writeFileSync('./output.json', JSON.stringify(result));
} catch (err) {
  console.error('write failed:', err.code);
}
```

Errors throw exceptions. Forget the `try/catch` and an `ENOSPC` (disk full) or `EACCES` kills your process.

## Appending to Files

`fs.appendFile()` opens the file with the `O_APPEND` flag and writes at the end:

```js
const entry = `${new Date().toISOString()} Server started\n`;
await fs.promises.appendFile('./server.log', entry);
```

If the file doesn't exist, it's created. If it does, the new data goes at the end - the existing content stays intact.

The `O_APPEND` flag is interesting at the kernel level. It atomically seeks to the end and writes, as a single operation. Even if two processes append to the same file concurrently, each individual write lands intact at the end. The writes don't overlap or corrupt each other. What can interleave is the ordering - process A's line might appear before or after process B's line, depending on scheduling. But each line remains whole. For log files, where lines are independent and order can be reconstructed from timestamps, this is exactly what you want.

You get the same behavior by passing `{ flag: 'a' }` to `writeFile`. `appendFile` exists purely for clarity - it makes the intent obvious.

### When Append Falls Short

Append mode is great for log files, CSV files that grow over time, and audit trails. But it's the wrong tool for structured formats that require the full file to be valid. You can't append to a JSON file and get valid JSON - the closing bracket is already there. You'd need to read the file, parse it, modify the data structure, and write the whole thing back (ideally with atomic replacement).

For high-throughput logging, `appendFile` called repeatedly is inefficient because it opens and closes the file each time. A write stream in append mode is better:

```js
const log = fs.createWriteStream('./app.log', { flags: 'a' });
log.write('entry one\n');
log.write('entry two\n');
```

The stream keeps the file descriptor open and handles backpressure if writes can't keep up with the write rate.

## Stream-Based File I/O

Streams process data in chunks. Instead of loading an entire file into memory, you work with pieces - typically 64 KB at a time. Memory usage stays constant regardless of file size. A 10 MB file and a 10 GB file both use roughly the same amount of memory during processing.

### createReadStream

```js
const stream = fs.createReadStream('./access.log', 'utf8');
stream.on('data', (chunk) => {
  // chunk is a string, typically ~64 KB
});
stream.on('end', () => console.log('done'));
```

Node opens the file, reads `highWaterMark` bytes (default 64 KB), emits a `'data'` event with that chunk, reads the next 64 KB, emits again, and repeats until EOF. Then it emits `'end'` and closes the file descriptor.

Passing `'utf8'` means chunks arrive as strings. Without it, they're Buffers. For binary files - images, videos, archives - leave the encoding off and work with the raw bytes.

The `highWaterMark` option controls chunk size:

```js
const stream = fs.createReadStream('./file.bin', {
  highWaterMark: 256 * 1024  // 256 KB chunks
});
```

Larger chunks mean fewer syscalls (and fewer event loop iterations) but more memory per chunk. For NVMe drives, larger chunks can improve throughput because the overhead is dominated by JS processing, not disk I/O. For memory-constrained environments reading many files concurrently, smaller chunks (4-16 KB) reduce per-stream memory. The default 64 KB is reasonable for most cases.

### Byte Range Reads

`createReadStream` supports `start` and `end` for reading slices:

```js
const stream = fs.createReadStream('./video.mp4', {
  start: 1048576,   // byte 1 MB
  end: 2097151      // byte 2 MB - 1 (inclusive)
});
```

Node seeks to `start`, reads until `end`, then stops. The rest of the file is never touched. HTTP range requests (for video seeking, download resumption) use exactly this pattern - the server reads only the requested byte range and sends it to the client.

### createWriteStream

The write counterpart:

```js
const out = fs.createWriteStream('./output.txt');
out.write('first chunk\n');
out.write('second chunk\n');
out.end('final chunk\n');
```

Each `write()` call buffers the data. When the internal buffer exceeds `highWaterMark` (default 16 KB for write streams), `write()` returns `false` - a backpressure signal telling you to pause. The `'drain'` event fires when the buffer drops below the threshold and writing is safe to resume. In practice, you rarely handle backpressure manually because `pipeline` does it for you.

`end()` flushes remaining data, closes the descriptor, and emits `'finish'`. To append instead of overwrite, use the `'a'` flag:

```js
const log = fs.createWriteStream('./server.log', { flags: 'a' });
```

### Piping with pipeline

The real power of file streams shows when you connect them:

```js
const { pipeline } = require('stream/promises');
await pipeline(
  fs.createReadStream('./input.bin'),
  fs.createWriteStream('./output.bin')
);
```

Data flows chunk by chunk from source to destination. `pipeline` wires up backpressure - if the write side can't keep up, the read side automatically pauses until the buffer drains. If any stream errors, `pipeline` destroys all of them and rejects the promise. Use `pipeline` over `pipe()` for new code; `pipe()` doesn't propagate errors, which means a write failure can leave the read stream hanging open, leaking a file descriptor.

Transform chains work the same way:

```js
const zlib = require('zlib');
await pipeline(
  fs.createReadStream('./data.json'),
  zlib.createGzip(),
  fs.createWriteStream('./data.json.gz')
);
```

Three streams, two connections. Chunks flow from disk through compression to a new file. Memory stays constant - at any moment, only a few chunks exist in memory across the entire pipeline. You could compress a 100 GB file with under a megabyte of memory usage.

### Serving Files over HTTP

A common pattern is streaming a file directly to an HTTP response:

```js
const http = require('http');
http.createServer((req, res) => {
  const stream = fs.createReadStream('./static/bundle.js');
  stream.on('error', () => {
    res.writeHead(404);
    res.end();
  });
  stream.pipe(res);
}).listen(3000);
```

The file streams directly to the client without buffering the whole thing in memory. Ten concurrent downloads of a 50 MB file use roughly 640 KB total (10 streams * 64 KB per chunk), rather than the 500 MB that ten `readFile` calls would allocate.

### Buffer-All vs. Stream - The Decision

Buffer-all (`readFile`/`writeFile`) when:
- The file is small (under a few MB) and you need the whole thing at once
- You're parsing a format that requires full content (JSON, XML)
- Simplicity matters more than memory efficiency

Stream when:
- The file is large or unpredictable in size
- You're processing incrementally (log analysis, data transformation, file copying)
- You're forwarding data without needing to inspect all of it (proxying, serving)
- Memory is constrained (containers, many concurrent file operations)

The tradeoff is complexity for efficiency. Streams mean dealing with chunks, async events, and flow control. For large files, though, there's no alternative. `readFile` on a 10 GB file either crashes the process with an allocation failure or triggers GC pauses measured in seconds.

## Low-Level Byte Operations with fs.read and fs.write

`fs.read()` and `fs.write()` operate at the byte level. You allocate the buffer, specify the offset in the file, and control exactly how many bytes transfer. These are the APIs underneath everything else - `readFile`, streams, and readline all eventually call into `fs.read` under the hood.

### Reading at Specific Positions

The API takes six parameters in its traditional form:

```js
fs.read(fd, buffer, offset, length, position, callback);
```

You provide the file descriptor, a pre-allocated buffer, the position within that buffer to start writing, how many bytes to read, and the position in the file to read from. The callback receives `(err, bytesRead, buffer)`.

The promise-based FileHandle version is cleaner:

```js
const fd = await fs.promises.open('./data.bin', 'r');
const buf = Buffer.allocUnsafe(64);
const { bytesRead } = await fd.read(buf, 0, 64, 0);
```

Read 64 bytes from position 0 of the file into `buf`, starting at offset 0 in the buffer. `bytesRead` tells you how many bytes were actually read. It can be less than 64 if the file is shorter, or zero if you're already at EOF.

The `position` parameter is where random access happens. Pass a number, and Node seeks to that byte offset. Pass `null`, and it reads from the current file position and advances it. Explicit positions let you jump anywhere in a file without reading sequentially from the start.

### Parsing a Binary Header

Many binary formats begin with a fixed-size header containing metadata. PNG files start with an 8-byte signature. ZIP files have a central directory at the end. Database files store record counts, version numbers, and data offsets in the header.

Here's parsing a hypothetical file format with a 64-byte header:

```js
const fd = await fs.promises.open('./database.db', 'r');
const header = Buffer.allocUnsafe(64);
const { bytesRead } = await fd.read(header, 0, 64, 0);

if (bytesRead < 64) throw new Error('Incomplete header');

const magic = header.readUInt32BE(0);    // 4-byte signature
const version = header.readUInt32LE(4);  // format version
const recordCount = header.readUInt32LE(8);
const dataOffset = header.readUInt32LE(12);
```

Four reads from the header buffer (which is already in memory - these are just buffer offset reads, not file reads). Now you know where the data lives. To read record number 5, assuming 128-byte fixed records:

```js
const recordBuf = Buffer.allocUnsafe(128);
const pos = dataOffset + (5 * 128);
const { bytesRead } = await fd.read(recordBuf, 0, 128, pos);

if (bytesRead < 128) throw new Error('Incomplete record');

await fd.close();
```

Two file reads - 64 bytes for the header, 128 for the record. If the file is 10 GB with millions of records, you've read 192 bytes total. Compare that to `readFile`, which would try to allocate 10 GB of memory.

### Writing at Specific Positions

`fs.write()` works the same way in reverse:

```js
const fd = await fs.promises.open('./database.db', 'r+');
const buf = Buffer.allocUnsafe(4);
buf.writeUInt32LE(42, 0);
await fd.write(buf, 0, 4, 16);  // write at byte 16
await fd.close();
```

Opens the file in read-write mode (`'r+'` preserves existing content), writes 4 bytes at offset 16. The rest of the file stays untouched. Only those 4 bytes change. This is how databases update individual records without rewriting entire files.

The `'r+'` flag is important here. `'w'` would truncate the file to zero length before your write, destroying all existing data. `'r+'` opens for both reading and writing without truncation.

### Buffer Reuse in Read Loops

One major advantage of low-level reads is buffer reuse. Instead of allocating new memory for each read, you allocate once and reuse:

```js
const buf = Buffer.allocUnsafe(4096);
let position = 0;
let bytesRead;
do {
  ({ bytesRead } = await fd.read(buf, 0, 4096, position));
  if (bytesRead > 0) processChunk(buf.subarray(0, bytesRead));
  position += bytesRead;
} while (bytesRead > 0);
```

One 4 KB buffer, reused for every read. In a tight loop processing a large file, this reduces GC pressure compared to `readFile` (which allocates a single massive buffer) or streams (which allocate a new buffer for each chunk). The `subarray` call creates a view into the existing buffer without copying - covered in Chapter 2.

`allocUnsafe` is safe here because the read immediately overwrites the buffer contents. Just make sure you only process `buf.subarray(0, bytesRead)`, not the full buffer. Bytes beyond `bytesRead` contain uninitialized memory - potentially data from a previous allocation.

### When to Go Low-Level

Use `fs.read()`/`fs.write()` when you need:

- **Byte-level precision.** Reading specific byte ranges from binary formats, file headers, fixed-size records, or length-prefixed protocols.
- **Random access.** Jumping to calculated offsets based on an index or metadata, reading only the parts you need.
- **Buffer reuse.** Allocating once and reusing across many reads in performance-sensitive loops.
- **Custom abstractions.** Building something that `readFile` and streams don't cover, like a paged database engine or a binary protocol parser.

Most application code never touches these APIs. They exist for the cases where higher-level abstractions don't fit - binary file formats, database internals, network protocol implementations.

## Flushing to Disk with fsync

When a write "succeeds," the data might still be in the OS's buffer cache, not yet on physical storage. The kernel batches disk writes for performance - your data sits in RAM until the kernel decides to flush it (typically within 30 seconds, controlled by the `dirty_expire_centisecs` sysctl on Linux).

If the machine loses power or the kernel panics before that flush, the data is gone. Your write callback returned successfully, your promise resolved, but the bytes never reached the disk.

`fsync()` forces the kernel to flush all buffered writes for a file descriptor to the physical device:

```js
const fd = await fs.promises.open('./critical.dat', 'w');
await fd.write(buf, 0, buf.length, 0);
await fd.sync();
await fd.close();
```

The `sync()` call blocks the thread pool worker until the disk controller confirms the write is on persistent media. That's slow. SSDs might take 1-10 ms. Spinning disks can take 10-50 ms. NFS mounts can be even slower.

For the temp-file-and-rename pattern with durability:

```js
const fd = await fs.promises.open(tmpPath, 'w');
await fd.write(data, 0, data.length, 0);
await fd.sync();     // data is on disk
await fd.close();
await fs.promises.rename(tmpPath, targetPath);
```

The `sync` before `close` guarantees the data is physically written before the rename makes it visible. Without it, a crash between `close` and the kernel's background flush could lose the data.

Most application writes don't need `fsync`. Log files, caches, temporary files - they're all regenerable. `fsync` matters for database transaction logs, financial records, or any state file where loss means silent data corruption.

## Line-by-Line Reading with readline

Text files frequently have line structure - log files, CSVs, configuration files, JSONL (one JSON object per line). The `readline` module parses a readable stream into individual lines with constant memory:

```js
const readline = require('readline/promises');
const file = await fs.promises.open('./access.log');
const rl = readline.createInterface({
  input: file.createReadStream(),
  crlfDelay: Infinity
});

for await (const line of rl) {
  if (line.includes('ERROR')) console.log(line);
}
await file.close();
```

`crlfDelay: Infinity` normalizes line endings. It ensures that a `\r\n` pair split across two different chunks is treated as a single line break. Without it, if the `\r` arrives at the end of one chunk and the `\n` arrives in the next chunk more than 100ms later (the default `crlfDelay`), `readline` would treat them as two separate line breaks, resulting in an unwanted empty line.

The `for await` loop is an async iterator. It pulls one line at a time from the readline interface. Natural backpressure: the underlying stream won't read the next chunk until you're ready for the next line. If your line processing is slow (making API calls, writing to a database), the file read automatically throttles to match.

### How readline Buffers Lines

Under the hood, readline reads chunks from the input stream (just regular `'data'` events), appends them to an internal string buffer, and scans for newline characters. When it finds one, it slices the line out of the buffer and emits it.

The tricky part is chunk boundaries. A 64 KB chunk from the read stream can split a line in half. The first chunk ends with `"2024-01-15 request to /api/us"` and the next chunk starts with `"ers 200 OK\n"`. readline handles this by holding the partial line in the buffer until the next chunk completes it. Complete lines get emitted immediately; partial lines wait.

When the stream ends, whatever's left in the buffer (the last line, which may not have a trailing newline) gets emitted as a final line event.

### Early Exit and Searching

You can break out of the loop early:

```js
for await (const line of rl) {
  if (line.startsWith('FATAL')) {
    console.log('Found:', line);
    break;
  }
}
await file.close();
```

Breaking out of a `for await` loop tears down the async iterator, which closes the readline interface and stops reading from the stream. If the file is 10 GB and the target line is in the first 100 KB, you read only 100 KB.

### Batched Concurrent Processing

Sequential processing is fine for I/O-bound work, but if each line requires an independent async operation (API call, database insert), sequential processing might be too slow. Batching adds controlled concurrency:

```js
const batch = [];
for await (const line of rl) {
  batch.push(processLine(line));
  if (batch.length >= 20) {
    await Promise.all(batch);
    batch.length = 0;
  }
}
if (batch.length > 0) await Promise.all(batch);
```

Read 20 lines, process them concurrently, wait for all to complete, then read the next 20. The `await Promise.all(batch)` call also throttles the read - readline pauses while you're processing the batch, so you don't accumulate unbounded numbers of in-flight promises.

### readline vs. Manual Chunk Splitting

You could implement line-by-line reading yourself with `createReadStream` and `split('\n')`:

```js
const stream = fs.createReadStream('./file.txt', 'utf8');
let leftover = '';
stream.on('data', (chunk) => {
  const lines = (leftover + chunk).split('\n');
  leftover = lines.pop();
  for (const line of lines) processLine(line);
});
stream.on('end', () => {
  if (leftover) processLine(leftover);
});
```

This works, and for simple cases it's fine. But readline handles several edge cases that manual splitting misses: proper `\r\n` handling, the `crlfDelay` behavior for cross-platform compatibility, integration with the promises API and async iterators, and proper cleanup of the underlying stream. For anything beyond a quick script, `readline` is the better choice.

## How libuv Dispatches File I/O

Here's the part most developers skip, but it explains a lot about Node's file I/O performance characteristics.

POSIX operating systems don't provide truly asynchronous file I/O in the way they do for sockets. Linux added `io_uring` in kernel 5.1, and libuv has experimental support for it, but as of Node.js v24, file operations on most deployments still go through the thread pool. macOS has `kqueue` and Windows has IOCP, but those async mechanisms handle sockets and pipes, not regular file operations. So libuv fakes async file I/O using a pool of worker threads.

When you call `fs.readFile('./data.json', callback)`, here's the actual sequence:

Node's JavaScript layer validates your arguments and creates a `FSReqCallback` C++ object. This object wraps a `uv_fs_t` struct - libuv's request type for filesystem operations. The `uv_fs_t` holds everything about the operation: which syscall to perform (`UV_FS_OPEN`, `UV_FS_READ`, `UV_FS_CLOSE`), the file path, the buffer, file flags, and a pointer back to your JavaScript callback.

Node then calls `uv_fs_open()`. This doesn't execute the `open()` syscall immediately. Instead, libuv posts the request to its thread pool's work queue - a linked list protected by a mutex. One of the pool's worker threads (4 by default, configurable with `UV_THREADPOOL_SIZE` up to 1024) picks up the request when it becomes available.

The worker thread executes the blocking POSIX `open()` syscall. The kernel traverses directory entries, checks permissions, allocates a file descriptor, reads inode metadata from disk if it's not cached. This can take microseconds on a warm cache or milliseconds if it requires disk I/O. But because it happens on a worker thread, the main event loop continues running JavaScript concurrently.

Once `open()` returns, the worker thread stores the file descriptor (or an error code) in the `uv_fs_t` result field. For `readFile`, Node then issues a second request - `uv_fs_fstat()` to learn the file size, then `uv_fs_read()` - each going through the same flow: posted to the work queue, picked up by a worker, blocking syscall, result stored. Finally `uv_fs_close()` follows the same pattern.

After the last operation completes, the worker thread signals the main event loop by writing to an async handle - an inter-thread notification mechanism in libuv. The event loop picks this up during its poll phase, retrieves the result from the `uv_fs_t` struct, unwraps the JavaScript callback from the `FSReqCallback` C++ object, and invokes it with the data (or error).

The full cycle - JavaScript -> C++ binding -> libuv work queue -> worker thread -> syscall -> worker stores result -> event loop notification -> callback invocation - happens for every filesystem operation. A single `readFile` triggers at least three trips through this pipeline (open, read, close), plus potentially a stat call.

### Thread Pool Contention

The thread pool defaults to 4 worker threads. At most 4 filesystem operations execute simultaneously. If you fire off 100 concurrent `readFile` calls, 4 run at once and 96 sit in the work queue waiting. This is a bottleneck in I/O-heavy applications.

You can increase `UV_THREADPOOL_SIZE`:

```js
// Set before any I/O happens (e.g., in your entry point)
process.env.UV_THREADPOOL_SIZE = '16';
```

But more threads means more memory (each thread gets an 8 MB stack by default in libuv) and more context switching overhead. There's a sweet spot that depends on your workload - for disk-heavy applications, 8-16 threads is common. Beyond 32, you rarely see improvement.

The other subtlety: `fs` operations share the thread pool with DNS resolution (`dns.lookup`), some crypto operations, and `zlib` compression. If a burst of DNS lookups occupies all 4 threads, your file reads queue up behind them. This explains mysterious file I/O latency spikes - the files aren't slow, the thread pool is congested with unrelated work.

### Sync Variants Skip the Thread Pool

`readFileSync`, `writeFileSync`, and other sync calls bypass the thread pool entirely. They call the blocking syscall directly on the main thread. That's why they freeze the event loop - there's no offloading, no background execution, just a direct `open()` + `read()` + `close()` sequence that blocks everything until the disk responds.

The promise-based APIs use the same thread pool mechanism as callbacks. The only difference is the JavaScript layer: instead of invoking a callback, Node resolves a Promise, which schedules microtasks. The underlying I/O path is identical.

## Choosing the Right API

| Scenario | API | Why |
|-----|---|---|
| Small config/JSON at startup | `readFileSync` | Blocking is harmless pre-event-loop |
| Small file in a request handler | `promises.readFile` | Non-blocking, simple |
| Large file processing | `createReadStream` | Constant memory, any file size |
| Writing state/config | `writeFile` + temp-rename | Atomic replacement prevents corruption |
| Appending log entries | `appendFile` or write stream | `O_APPEND` guarantees positioning |
| Large data output | `createWriteStream` | Backpressure-aware, memory efficient |
| Binary format parsing | `fs.read` with positions | Random access, byte-level control |
| Log analysis, CSV parsing | `readline` + read stream | Line-by-line, constant memory |
| Durability after write | `fsync` before close | Forces flush to physical storage |

The sync variants are for startup code, CLI tools, and scripts. In any code path that runs while the event loop is active and handling concurrent work, use the async versions. The promise-based API (`fs.promises.*`) is the cleanest for modern applications - async/await syntax, try/catch error handling, works naturally with the rest of your async code.

There's a spectrum of control. `readFile` and `writeFile` handle everything - opening, sizing, reading or writing, closing. Streams add chunked processing with automatic flow control. `fs.read` and `fs.write` give raw byte-level access. `readline` adds line-oriented parsing on top of streams. Each tier down trades simplicity for precision. Pick the highest abstraction that solves your problem. Drop down only when you need the control.
