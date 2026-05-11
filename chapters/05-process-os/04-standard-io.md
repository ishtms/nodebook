---
title: "Standard I/O"
date: "2026-02-22"
excerpt: "stdin, stdout, and stderr in Node.js -- how standard I/O streams work, TTY detection, and piping behavior."
category: "Process & OS"
tags: ["nodejs", "stdin", "stdout", "stderr", "TTY", "pipes"]
author: "Ishtmeet Singh @ishtms"
chapter: "process-os"
subchapter: "standard-io"
published: true
toc: true
---

Every Unix process starts with three open file descriptors. fd 0 is standard input. fd 1 is standard output. fd 2 is standard error. Node puts stream objects on top of them: `process.stdin`, `process.stdout`, and `process.stderr`. Same property names every time. Different backing handle depending on what the shell connected before Node started.

The annoying part sits under the familiar API. `.write()`, `.on('data')`, and `.pipe()` look ordinary. Then Node switches between synchronous writes, async writes, buffering, terminal mode, file mode, and pipe mode based on fd state that your script inherited. The code path is already chosen before your first import runs.

## The three streams

`process.stdin` is a Readable stream (covered in Chapter 3). `process.stdout` and `process.stderr` are Writable streams. They map to the standard file descriptors (covered in Chapter 4) that the parent process passes into Node.

Standard I/O streams carry extra runtime rules. A Readable from `fs.createReadStream()` follows file stream behavior. A socket Writable follows socket behavior. The standard streams inspect fd 0, fd 1, and fd 2, then pick TTY, pipe, or file handling. They can block. They can buffer. They can also lose buffered data when `process.exit()` cuts the process off.

```js
process.stdout.write('hello');
process.stderr.write('debug info');
```

Both calls write a string to a Writable stream. stdout carries program data. stderr carries diagnostics. When someone runs `node app.js | grep foo`, the pipe receives stdout only. stderr still goes to the terminal unless the shell redirects fd 2 too. That split keeps machine-readable output separate from warnings, stack traces, progress lines, and debug noise.

The split also explains a lot of CLI etiquette. A command that prints JSON should put only JSON on stdout. Timing information, skipped-file messages, parse warnings, and progress bars belong on stderr. That way a caller can do `node tool.js > data.json` and receive a clean file. The terminal still shows diagnostics because fd 2 stayed connected to the terminal.

Custom `Console` instances can write somewhere else entirely. We'll come back to that after the stream mechanics are on the table.

## process.stdin

`process.stdin` starts in paused mode (covered in Chapter 3). Nothing flows until code attaches a listener, resumes the stream, or pipes it somewhere. Once reading starts, stdin holds a ref on the event loop (covered in Chapter 1), so the process stays alive while input is active.

The smallest version looks boring:

```js
process.stdin.on('data', (chunk) => {
  console.log(`Got: ${chunk}`);
});
```

The `data` event delivers Buffer chunks. Terminal input usually arrives one line at a time because the terminal driver buffers input until Enter. Piped input has looser boundaries. `echo "hello" | node script.js` might produce one chunk, and a larger producer might produce many. Chunk boundaries are an implementation detail, so parser code has to treat them as arbitrary byte ranges.

That last sentence is the one that prevents bugs. A JSONL parser cannot assume one chunk equals one line. A protocol parser cannot assume one chunk equals one message. stdin is still a stream, so the usual stream rule applies: accumulate until you have a complete unit, then parse that unit.

The async iterator form uses the same stream underneath:

```js
for await (const chunk of process.stdin) {
  console.log(`Got: ${chunk}`);
}
```

Less wiring. Same bytes. The loop finishes when stdin ends: Ctrl+D on Unix, Ctrl+Z on Windows, or EOF from a piped source.

Buffers are raw bytes by default. `chunk.toString()` gives you text because `Buffer.prototype.toString()` defaults to `utf8`. Binary tools should keep the Buffer. Text tools can call `process.stdin.setEncoding('utf8')`, which makes `data` events deliver strings directly.

### Line-by-line with readline

Interactive CLI tools usually want complete lines, not raw chunks. The readline module (covered in Chapter 4) does the buffering:

```js
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  console.log(`You said: ${line}`);
});
```

The interface buffers bytes, decodes text, and splits on newline boundaries (`\n` or `\r\n`). With a TTY, it also cooperates with terminal editing behavior: backspace, arrow keys, and history navigation. With a pipe, it just splits input into lines. A pipe carries bytes. The terminal line discipline supplies editing behavior.

There's a promise API too:

```js
import { createInterface } from 'node:readline/promises';
const rl = createInterface({ input: process.stdin });
const answer = await rl.question('Your name? ');
console.log(`Hello, ${answer}`);
rl.close();
```

`rl.question()` writes the prompt to stdout, waits for one line, and resolves with the string. `rl.close()` releases the readline interface's ref on stdin, which lets the process exit once other work has finished.

### Raw mode

TTY stdin can switch into raw mode:

```js
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', (key) => {
  if (key[0] === 3) process.exit(); // Ctrl+C
  process.stdout.write(key);
});
```

Raw mode delivers keystrokes immediately. The terminal stops line buffering. Your program receives bytes and decides whether to echo anything back. Ctrl+C arrives as `0x03` instead of becoming SIGINT, so the handler owns that behavior. Password prompts, menu UIs, REPL controls, and editor-style input all depend on this mode.

`setRawMode()` requires `process.stdin.isTTY === true`. A piped stdin has no terminal mode to change, so calling it throws.

Multi-byte keys arrive as multi-byte buffers. The up arrow sends `\x1b[A`; down sends `\x1b[B`; right sends `\x1b[C`; left sends `\x1b[D`. Your code receives a 3-byte Buffer. Libraries such as `keypress` and readline's internal key parser decode those ANSI escape sequences. Raw-mode tools that handle arrows need that parser somewhere.

Raw mode also changes terminal cleanup requirements. If your program enables raw mode and then crashes before restoring the original mode, the user's terminal can stay in a strange state: no line buffering, no visible echo, Ctrl+C delivered as a byte. Well-behaved terminal programs restore cooked mode in `finally` blocks and signal handlers. Node restores the original TTY mode during normal shutdown, but code that calls `process.exit()` from random places can still make cleanup harder to reason about.

stdin has a ref on the event loop. Attach a `data` listener and the process stays open. That's correct for interactive programs. Some tools only want optional keyboard input while the main job runs, and those tools should let the process exit when the main job finishes.

```js
process.stdin.resume();
process.stdin.unref();
```

After `unref()` (covered in Chapter 1), stdin still listens, but it stops keeping the event loop alive. The process exits when all other ref'd work finishes. You can call `process.stdin.ref()` later if an interactive prompt becomes active.

Dev tools use this pattern a lot. Start with stdin unref'd. Ref it when the user enters an interactive debugging prompt. Non-interactive runs exit normally.

## process.stdout

`process.stdout` is a Writable stream. `console.log()` writes to it. So does `process.stdout.write()`.

```js
console.log('hello');            // writes "hello\n"
process.stdout.write('hello');   // writes "hello" (no newline)
```

`console.log()` calls `util.format()` on its arguments, appends a newline, and writes the formatted string to `process.stdout`. `process.stdout.write()` writes the bytes you pass. For prompts, progress bars, terminal UI, and output that needs exact newline control, use the direct stream call.

`util.format()` does real work before the write. `console.log('count: %d', 42)` handles printf-style placeholders. `console.log({ a: 1 })` calls `util.inspect()`. `console.log('a', 'b', 'c')` joins arguments with spaces. All of that runs synchronously before stdout sees a chunk.

The formatting step matters in hot paths. A disabled debug line that still calls `console.log(obj)` pays inspection cost before stdout sees anything. For command-line tools that print a few dozen lines, nobody cares. For tight loops, logging cost is often formatting plus terminal I/O, not just the `write()` syscall.

Writable streams return a boolean from `write()`, and stdout follows that contract. `true` means the internal buffer remains below the highWaterMark (covered in Chapter 3). `false` means the buffer crossed the threshold, so more writes should wait for `drain` (covered in Chapter 3).

```js
const ok = process.stdout.write(bigChunk);
if (!ok) {
  process.stdout.once('drain', () => {
    // safe to write again
  });
}
```

Most CLI output ignores the return value. A few log lines or status messages rarely build enough pressure to matter. A formatter that dumps megabytes to stdout is different. If the consumer reads slowly and your code keeps writing, Node's internal buffer grows until the consumer catches up or the heap gives out.

For pipe-backed stdout, the default highWaterMark is 16KB. For TTY-backed stdout on Unix, synchronous writes leave no pending stream buffer after each call, so the threshold rarely enters the picture.

Backpressure shows up quickly in pipelines. `node dump.js | gzip > out.gz` can make stdout wait on compression. `node dump.js | head -10` can close the pipe early. `node dump.js > /mnt/slow/out.txt` can block on filesystem latency. Different target. Same `process.stdout.write()` call.

The return value is also the only signal your loop gets before memory starts growing. A tight producer that ignores `false` can enqueue thousands of chunks while the downstream process is still reading the first few. Node will accept those chunks into the Writable buffer until normal heap pressure catches up with you. Respecting `false` turns the loop into a paced producer instead of a heap growth test.

### Terminal dimensions

TTY stdout exposes terminal size:

```js
console.log(process.stdout.columns); // e.g., 120
console.log(process.stdout.rows);    // e.g., 40
```

Those properties report width and height in character cells. They update when the terminal window changes size, and stdout emits `resize`:

```js
process.stdout.on('resize', () => {
  console.log(`${process.stdout.columns}x${process.stdout.rows}`);
});
```

Piped stdout and file-redirected stdout have `columns` and `rows` as `undefined`. Terminal UIs, progress bars, and table formatters usually fall back to 80 columns in that case.

The `resize` event comes from libuv's TTY handle. On Unix, the terminal sends SIGWINCH when its dimensions change. libuv tracks that signal, asks the terminal for the current size with `ioctl(fd, TIOCGWINSZ, &winsize)`, then reflects the result through the JavaScript stream.

### ANSI cursor control

TTY stdout accepts ANSI escape sequences:

```js
process.stdout.write('\x1b[2J');   // clear screen
process.stdout.write('\x1b[H');    // move cursor to top-left
process.stdout.write('\x1b[5;10H'); // move to row 5, col 10
```

Cursor control is just bytes written to stdout. Packages such as `ansi-escapes`, `chalk`, and `kleur` wrap those byte sequences, but the final operation is still a write to fd 1.

Progress output often clears and redraws one line:

```js
process.stdout.write('\r');         // carriage return (start of line)
process.stdout.clearLine(0);        // clear the current line
process.stdout.cursorTo(0);         // move cursor to column 0
process.stdout.write('Progress: 42%');
```

`clearLine()` and `cursorTo()` exist on TTY streams. They write ANSI sequences internally. Piped stdout lacks those methods, so code that draws terminal UI needs an `isTTY` branch.

That branch should also change the output format. Interactive output can redraw one line. Piped output should usually append plain records. A progress bar that writes carriage returns into a log file creates unreadable bytes. A CLI that switches to newline-delimited status records when stdout is piped behaves better under shells, CI logs, and test snapshots.

## process.stderr

`process.stderr` is also a Writable stream. `console.error()`, `console.warn()`, `console.trace()`, and `console.dir()` write there. `console.log()`, `console.info()`, `console.table()`, and `console.count()` write to stdout.

That split matters in pipelines. `node app.js | grep pattern` gives grep fd 1 only. Warnings, stack traces, progress lines, and debug output on fd 2 still appear in the terminal unless redirected.

```js
console.log('data output');   // goes to pipe -> grep
console.error('debug info');  // goes to terminal
```

stderr is where diagnostics belong. stdout is where program data belongs. Plenty of Node scripts start with `console.log()` for everything and later become hard to pipe because debug output contaminates the data stream. The small fix is consistent: `console.error()` for diagnostics, `console.log()` for data.

stderr is also the right stream for progress. A downloader can stream file bytes to stdout while progress goes to stderr. A formatter can write transformed JSON to stdout while parse warnings go to stderr. The caller can redirect them independently without asking the program for a custom flag.

The shell redirects fd 1 and fd 2 independently:

```bash
node app.js > output.txt 2> errors.txt
node app.js > output.txt 2>&1  # merge stderr into stdout
node app.js 2>/dev/null        # discard errors
```

Your program receives the final fd table. The shell does the setup before Node starts: it opens target files, calls `dup2()` to replace fd 1 or fd 2, then executes the Node binary. By the time JavaScript runs, `process.stdout` and `process.stderr` wrap whatever descriptors the shell left in place.

`2>&1` copies fd 1's current target into fd 2. Order matters because shells process redirections left to right. `node app.js > out.txt 2>&1` sends both streams to `out.txt`. `node app.js 2>&1 > out.txt` sends stderr to the original stdout target and stdout to the file.

## TTY detection

`process.stdout.isTTY` is `true` when stdout is connected to a terminal. For pipes and redirected files, the property reads as `undefined`.

```js
if (process.stdout.isTTY) {
  process.stdout.write('\x1b[31mred text\x1b[0m\n');
} else {
  process.stdout.write('red text\n');
}
```

Color-aware CLIs have a branch close to that. ANSI escape bytes render as colors in a terminal. In a file or downstream program, those bytes appear literally, often as `^[[31m`. `isTTY` tells the program whether fd 1 points at a terminal.

The same idea applies to all three streams:

- `process.stdin.isTTY` - `true` when input comes from an interactive terminal, `undefined` when input is piped
- `process.stdout.isTTY` - `true` when output goes to a terminal, `undefined` when output is piped or redirected
- `process.stderr.isTTY` - `true` when diagnostic output goes to a terminal, `undefined` when diagnostic output is redirected

Each stream has its own TTY status. `node app.js | cat` makes stdout non-TTY while stderr can still be a TTY. `node app.js 2>/dev/null` changes stderr and leaves stdout alone.

That independence matters for color decisions. Many tools disable color on stdout when stdout is piped, but keep colored diagnostics on stderr if stderr still points at a terminal. Treating the whole process as "interactive" or "non-interactive" loses that detail.

### Color detection

Node also exposes color capability checks on TTY streams:

```js
process.stdout.getColorDepth();  // 1, 4, 8, or 24
process.stdout.hasColors(256);   // true/false
```

`getColorDepth()` returns bits of color support. 1 means monochrome. 4 means 16 colors. 8 means 256 colors. 24 means true color. On non-TTY output, it returns 1.

`hasColors(count)` checks whether the terminal supports at least that many colors. You can pass an environment object as the second argument, such as `hasColors(256, myEnvObject)`, which makes tests easier because they can simulate `TERM`, `NO_COLOR`, or `FORCE_COLOR`.

Node checks environment conventions here: `COLORTERM`, `TERM`, `NO_COLOR`, and `FORCE_COLOR`. `NO_COLOR=1` tells programs to suppress color output. `FORCE_COLOR` asks for color even when output is piped, which CI systems sometimes use for readable logs.

```js
if (process.env.NO_COLOR) {
  // user explicitly wants no color
} else if (process.stdout.hasColors(256)) {
  // use 256-color output
} else if (process.stdout.isTTY) {
  // basic 16-color output
}
```

Libraries such as `chalk`, `kleur`, and `colorette` perform this detection internally. Application code usually calls the library and lets it decide whether to emit ANSI sequences.

## Blocking vs Non-Blocking Writes

stdin, stdout, and stderr have connection-dependent blocking behavior. The matrix changes across Linux, macOS, and Windows.

TTY first. On Linux and macOS, writes to `process.stdout` and `process.stderr` are synchronous when the stream is connected to a terminal. The `write()` call blocks the event loop until the kernel accepts the bytes for the terminal driver. On Windows, TTY writes are asynchronous because libuv routes them through the Windows console path.

Pipes flip part of the matrix. On POSIX platforms, pipe writes are asynchronous. Data enters a Node/libuv write path, then the kernel pipe buffer. A slow consumer fills that buffer and backpressure moves back into the Writable stream. The kernel pipe buffer is commonly 64KB on Linux and 16KB on macOS, though kernel versions and settings can change the exact number. On Windows, pipe-backed standard stream writes are synchronous.

Files are simpler. Redirect stdout to a file with `node script.js > output.txt`, and writes are synchronous on supported platforms. The syscall returns after the kernel accepts the bytes into the file path. The kernel may flush to physical storage later.

Put together: TTY writes are synchronous on POSIX and asynchronous on Windows. Pipe writes are asynchronous on POSIX and synchronous on Windows. File writes are synchronous across supported platforms.

One extra detail: the callback passed to `.write()` means Node finished processing that chunk through the stream write path. For a pipe, that means libuv completed the async write request. For a Unix TTY, it can run after the blocking syscall returns in the same turn. Same API. Different timing.

The behavior comes from libuv (covered in Chapter 1). When fd 1 or fd 2 is a TTY, libuv uses `uv_tty_t`. On Unix, that path writes directly with blocking `write(2)` calls. Terminal output is usually small, so the blocking path avoids queue setup for writes that normally complete during the syscall. When the fd is a pipe, libuv uses `uv_pipe_t`, which participates in the event loop and owns an async write queue. Pipe output can stall for longer because the reader controls how fast the kernel buffer drains. Regular files use synchronous writes because thread-pool file I/O could complete out of order.

That last bit matters. Two stdout writes should preserve insertion order. If Node sent redirected file writes through the libuv thread pool (covered in Chapter 1), worker scheduling could let write 2 finish before write 1. Synchronous writes preserve output order at the cost of blocking the main thread when the file target is slow.

Slow files are real. Redirecting to a network mount, a nearly full disk, or a busy filesystem can make a stdout write block long enough to show up in latency. Most CLI tools accept that cost. A server process that logs heavily to a slow redirected stdout should measure it instead of assuming logging is free.

### process.exit() and buffered output

```js
process.stdout.write('results\n');
process.exit(0);
```

TTY stdout on Unix flushes before `process.exit()` because the write blocks until the kernel accepts the bytes. Pipe-backed stdout on POSIX can lose the line. `process.stdout.write()` queues the chunk and returns. `process.exit()` terminates the process before the queued write completes.

I've seen that exact bug in CLIs. Works in a terminal. Loses the last line under `| tee` or a log collector. The bug sits in the connection type, not in the string being written.

Use the write callback when explicit exit is required:

```js
process.stdout.write('results\n', () => {
  process.exit(0);
});
```

For `console.log()`, the cleaner answer is usually `process.exitCode`:

```js
process.exitCode = 0;
console.log('results');
```

Set the exit code. Stop scheduling new work. Let the event loop drain so pending writes can finish. `drain` helps only after a `write()` returns `false`; a small queued pipe write can still have no `drain` event to wait for. The write callback is the precise hook for one chunk.

There is also a subtle console-specific issue. `console.log()` has no per-call completion callback. It formats and writes, then returns. If the process needs to exit after a final message, `process.stdout.write(message, callback)` gives you a concrete completion point. `console.log()` is fine for normal natural exit. It is clumsy for explicit shutdown sequencing.

stderr follows the same connection-type matrix, with a practical convention layered on top. Crash diagnostics usually go to stderr because stderr is often still attached to a TTY, and Unix TTY writes block. Piped stderr can still lose buffered data if `process.exit()` runs before the write completes.

That is why fatal-path code should be boring. Write the diagnostic. Prefer synchronous cleanup where the process is already dying. Use `process.exitCode` when the program can finish normally. Reserve `process.exit()` for cases where immediate termination is the actual requirement.

## The console object

`console` in Node is a `Console` instance wired to `process.stdout` and `process.stderr`.

```js
import { Console } from 'node:console';
const logger = new Console({
  stdout: process.stdout,
  stderr: process.stderr
});
```

The default global console is configured this way. Each method formats arguments, picks stdout or stderr, and writes to that stream. You can wire a custom Console to files:

```js
import { createWriteStream } from 'node:fs';
const log = new Console({
  stdout: createWriteStream('/tmp/app.log'),
  stderr: createWriteStream('/tmp/app.err')
});
log.log('this goes to /tmp/app.log');
```

The method split is fixed. `console.log()`, `console.info()`, `console.table()`, `console.count()`, `console.countReset()`, `console.time()`, `console.timeLog()`, `console.timeEnd()`, `console.group()`, and `console.groupEnd()` write to stdout. `console.error()`, `console.warn()`, `console.trace()`, `console.dir()`, and failed `console.assert()` calls write to stderr.

`console.log()` and `console.info()` share implementation. So do `console.error()` and `console.warn()`. They call `util.format()` and write the result to the selected stream.

```js
console.table([
  { name: 'alice', score: 95 },
  { name: 'bob', score: 87 }
]);
```

`console.table()` prints a formatted ASCII table to stdout. It inspects the objects, extracts column names from keys, and pads cells to align. A second argument selects columns: `console.table(data, ['name'])`. The output targets people. Pipe-friendly tools should emit JSON, NDJSON, or CSV.

Because the table goes to stdout, it will be captured by shell redirection. That is fine for human-readable reports. It is a poor default for APIs between programs because spacing, truncation, and object inspection rules are presentation details.

```js
console.time('query');
await db.query('SELECT * FROM users');
console.timeEnd('query');  // query: 42.123ms
```

`console.time()` starts a high-resolution timer under the label you pass. `console.timeEnd()` stops it and writes elapsed milliseconds to stdout. `console.timeLog()` writes elapsed time without stopping the timer. Multiple labels can run at once. A missing label warning goes to stderr.

Internally, the timing path uses a high-resolution clock, so the value can include fractional milliseconds. The output still goes through the same stdout path as `console.log()`. In a pipeline, timing lines become part of the data stream unless you use a custom `Console` that sends timing output to stderr.

```js
console.trace('checkpoint');
```

`console.trace()` writes `Trace: checkpoint` plus the current stack trace to stderr and keeps the program running. It uses the same file and line formatting you see in Error stacks.

That makes it useful for temporary diagnostics in a CLI pipeline. The transformed data keeps moving through stdout, while stack information lands on stderr where the next program in the pipe will not parse it as data.

## Piping patterns

Node fits Unix-style pipelines through stdin and stdout.

```js
process.stdin.pipe(process.stdout);
```

That reads fd 0 and writes fd 1. stdin is a Readable, stdout is a Writable, and `.pipe()` (covered in Chapter 3) connects them with backpressure handling.

A line filter starts with readline:

```js
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  process.stdout.write(line.toUpperCase() + '\n');
}
```

Run it as `cat file.txt | node upper.js | head -5`. stdin comes from `cat`. stdout goes to `head`. stderr remains available for diagnostics.

A JSONL filter keeps good output and bad input separate:

```js
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
```

That creates a line iterator over fd 0. The loop does the filtering:

```js
for await (const line of rl) {
  try {
    const obj = JSON.parse(line);
    if (obj.level === 'error') process.stdout.write(`${line}\n`);
  } catch {
    process.stderr.write(`invalid JSON: ${line}\n`);
  }
}
```

Valid matching records go to stdout. Parse failures go to stderr. With `node filter.js < logs.jsonl > errors.jsonl 2> parse-failures.txt`, the caller gets clean data in one file and diagnostics in another.

The `try/catch` keeps the pipeline alive after malformed input. Report the bad line. Skip it. Keep reading.

One more detail: `process.stdout.write()` inside that loop can return `false`. For small log filters, ignoring it may be acceptable. For high-volume filters, pause the input path or use a Transform plus `pipeline()` so backpressure travels through the whole chain.

When stdin is piped, it ends when the upstream writer closes:

```js
let total = 0;
process.stdin.on('data', (chunk) => {
  total += chunk.length;
});
process.stdin.on('end', () => {
  console.log(`Read ${total} bytes`);
});
```

TTY stdin ends when the user sends EOF. Code can handle both cases through the same `end` event (covered in Chapter 3).

Pipeline shutdown has direction. In `node producer.js | node consumer.js`, producer exit closes the pipe and consumer stdin emits `end`. Consumer exit closes the read side, and the producer sees SIGPIPE or an `EPIPE` error on stdout. Those two failure directions surface differently.

That asymmetry is normal for Unix pipes. Upstream completion is data EOF. Downstream completion is a broken output target. Good CLI programs treat the first as completion and the second as a clean early stop when the downstream command intentionally quits.

For stream transformations, `pipeline()` (covered in Chapter 3) gives you error propagation and cleanup:

```js
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

const upper = new Transform({
  transform(chunk, enc, cb) {
    cb(null, chunk.toString().toUpperCase());
  }
});
await pipeline(process.stdin, upper, process.stdout);
```

The line-by-line version is smaller for text filters. `pipeline()` is the better fit when the transformation is naturally stream-shaped and you want backpressure end to end.

## How Node bootstraps stdin, stdout, and stderr

Before user code runs, Node installs lazy getters for the standard streams on `process`. The main-thread path lives in `lib/internal/bootstrap/switches/is_main_thread.js`; worker threads use a separate path for proxied stdout and stderr.

Access triggers creation. The first `process.stdout` read calls an internal `getStdout()` function. That function calls `createWritableStdioStream(1)`. From there, Node calls `guessHandleType(fd)`, which crosses into the C++ binding for `process.binding('uv').guessHandleType(fd)`, which calls libuv's `uv_guess_handle(fd)`.

`uv_guess_handle()` runs `fstat()` on the fd and checks terminal status with `isatty(fd)` on Unix. It returns a libuv handle type: `UV_TTY`, `UV_NAMED_PIPE`, `UV_FILE`, or `UV_UNKNOWN`. Node uses that result to decide which JavaScript stream object to create.

The writable path has a small but meaningful chain. `getStdout()` handles caching so repeated `process.stdout` reads return the same object. `createWritableStdioStream(1)` classifies fd 1. The classification chooses the constructor and write policy. After that, the resulting stream is stored on the process object and reused. `process.stderr` follows the same path with fd 2. stdin follows a sibling readable path with fd 0.

The lazy part matters. A script that writes to stdout and never touches stdin leaves the stdin handle uncreated. That avoids creating a libuv handle that would need lifetime management during shutdown.

`UV_TTY` means fd 1 or fd 2 points at a terminal. Node creates a `TTYWrap` around libuv's `uv_tty_t`, then exposes it as a `net.Socket` in TTY mode. The handle stores the fd, the original terminal mode for restoration on exit, and window size data fetched with `ioctl(fd, TIOCGWINSZ, &winsize)`. That is where `columns`, `rows`, `setRawMode()`, and color-capability helpers come from.

The JavaScript object with a socket-shaped API comes from Node's stream stack. TTY streams need duplex-ish behavior for stdin and stream-compatible writes for stdout and stderr, so Node reuses the socket-shaped wrapper around native handles. The fd still points at a terminal device. Socket methods that require a peer address have little useful information to return.

`UV_NAMED_PIPE` means fd 1 or fd 2 points at a pipe or Unix domain socket. Node creates a pipe handle around `uv_pipe_t` and exposes a `net.Socket` in pipe mode. Writes enter libuv's write queue as `uv_write_t` requests. libuv registers interest in fd writability through epoll on Linux or kqueue on macOS. When the kernel says the pipe can accept bytes, libuv writes. If the kernel pipe buffer is full, the request stays queued and Node's stream buffer eventually reports backpressure through `write() === false`.

That path is why pipe-backed stdout can keep the process alive after your synchronous JavaScript has finished. Pending `uv_write_t` requests are active work. The event loop keeps running until those requests complete or fail. Calling `process.exit()` bypasses that drainage. Natural exit lets it happen.

`UV_FILE` means the fd points at a regular file. Node creates an `fs.WriteStream` for stdout or stderr, or an `fs.ReadStream` for stdin. Standard stream writes to files use synchronous `fs.writeSync()` internally. The thread pool path could reorder concurrent writes because worker completion order is scheduler-dependent. Sync writes preserve textual order.

Regular files also explain why redirected stdout can be slower than terminal output. On a local SSD, synchronous writes into the kernel page cache can be cheap. On a remote filesystem, the same call can block longer. The stream API hides that distinction, but latency still lands on the JavaScript thread.

`UV_UNKNOWN` is the fallback. Node creates a socket wrapper as the least-bad option for an fd libuv cannot classify. That path is rare for normal shells, but it matters for embedded runtimes, unusual supervisors, and test harnesses that hand Node custom descriptors. The fallback keeps the standard stream API present while still surfacing write errors through the stream.

stdin uses the same detection path with Readable stream creation. TTY stdin gets a TTY-capable socket wrapper. Pipe stdin gets a pipe-backed socket. File stdin, such as `node script.js < input.txt`, gets an `fs.ReadStream`.

The file case for stdin is common in batch tools. `node parse.js < input.ndjson` gives your program an `fs.ReadStream` over fd 0. The JavaScript code can still consume `process.stdin` with `for await`, `data`, or `pipe()`. The source changed from a terminal to a file descriptor backed by a regular file; the consumer code sees a Readable.

TTY stdin has one extra path: terminal-generated Ctrl+C. In cooked mode, the terminal driver turns Ctrl+C into SIGINT. In raw mode, the byte `0x03` reaches JavaScript. Switching between those modes requires saving and restoring terminal attributes with `tcsetattr()`, and libuv's TTY code coordinates that state with Node's signal behavior.

Worker threads receive proxied standard output. `process.stdout` and `process.stderr` in a worker send data to the parent thread over an internal channel, and the parent writes to its own fd 1 or fd 2. That makes worker stdout and stderr asynchronous. `process.stdin` in a worker is `null`; input has to arrive through messages from the main thread.

That worker behavior can affect test output. A worker's `console.log()` call travels through the parent before hitting the real stdout. Ordering against parent-thread logs depends on message delivery, stream state, and the parent write path. For exact ordering, send structured messages to the parent and let one thread own the final output.

## Edge cases and gotchas

TTY stdout is a `net.Socket` instance:

```js
const net = require('net');
console.log(process.stdout instanceof net.Socket);
// true (when connected to a TTY)
```

Some inherited socket methods make little sense on a terminal fd. The useful detail is error behavior: stdout can emit `error` if the underlying fd write fails.

Broken pipes are the common case. Run `node app.js | head -1`, and `head` exits after one line. The next stdout write in your program hits a closed read side. Node ignores SIGPIPE at startup and turns the failed write into an `EPIPE` error on `process.stdout`.

```js
process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE') {
    process.exit(0);
  }
});
```

Any program intended for pipelines should handle `EPIPE`. The handler turns early consumer exit into normal completion instead of an uncaught stream error.

`head` is the usual repro because it exits intentionally after receiving enough lines. The producer did nothing wrong. The consumer closed the pipe on purpose. Treating `EPIPE` as success keeps shell pipelines quiet.

Mixed sync and async writes can surprise you:

```js
process.stdout.write('A');
setTimeout(() => process.stdout.write('B'), 0);
process.stdout.write('C');
```

On a TTY, `A` and `C` write synchronously, then the timer writes `B`, so output is `ACB`. On a pipe, `A` and `C` usually queue before the timer phase, so the output is still `ACB`. With enough data and backpressure, timing can become more visible, but JavaScript call order still determines queue order until you yield to the event loop.

`console.log()` can block. It writes to stdout, and stdout can be synchronous. Heavy terminal logging can dominate a benchmark. Pipe to `/dev/null` or redirect to a file when you want to measure application work without terminal write latency.

There is a second benchmarking trap: redirecting stdout to a regular file can also be synchronous. `/dev/null` usually removes most cost because the kernel discards the bytes quickly. A real file on a slow device measures the filesystem too.

`isTTY` gives one bit of classification. Pipes and redirected files both read as `undefined`. If code truly needs to distinguish them, `fs.fstatSync(1)` can inspect fd 1 and report whether it points at a pipe, character device, or regular file. Most CLIs only need the TTY branch.

That deeper detection belongs in tools with different file and pipe behavior. A program might choose seek-friendly output when fd 1 is a regular file, but stream records when fd 1 is a pipe. Most programs skip that branch because stdout is a destination, not a random-access file API, even when the descriptor points at a file.

Process exit is the last trap. `process.exit()` runs `exit` handlers synchronously and terminates. Pending async writes stay pending forever. `process.exitCode = N` is the safer control point:

```js
process.exitCode = 1;
console.error('something went wrong');
// let the event loop drain
```

Set the code. Stop creating new work. Let the loop empty. That gives pipe-backed stdout and stderr a chance to flush before the process disappears.

Standard streams look small from JavaScript, but they carry the process boundary with them. The shell decides the descriptors. Node wraps them lazily. libuv picks the handle type. Your code only sees a stream, and the stream's behavior comes from that whole setup.
