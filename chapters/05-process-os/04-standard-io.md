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

Every process on a Unix system inherits three open file descriptors. fd 0 is standard input. fd 1 is standard output. fd 2 is standard error. Node wraps these in stream objects - `process.stdin`, `process.stdout`, `process.stderr` - and the behavior of those wrappers depends on what's connected on the other end. A terminal, a pipe, a file. Each one changes the semantics in ways that catch people off guard.

The annoying part: these three streams look normal. They have `.write()`, `.on('data')`, `.pipe()`. They quack like regular streams. But under the surface, they can be synchronous or asynchronous, blocking or buffered, depending on runtime conditions your code can't control. That's the whole story of standard I/O in Node - the interface is uniform, but the plumbing underneath isn't.

## The three streams

`process.stdin` is a Readable stream (covered in Chapter 3). `process.stdout` and `process.stderr` are Writable streams. They correspond directly to the three file descriptors (covered in Chapter 4) that every Unix process opens at birth.

But they're special. Unlike a Readable you create with `fs.createReadStream()` or a Writable from `net.Socket`, these three have platform-dependent behavior baked in. They can be synchronous or asynchronous. They can block or buffer. And they can silently lose data on process exit, depending on what they're hooked up to.

```js
process.stdout.write('hello');
process.stderr.write('debug info');
```

Both calls look identical. Both write a string to a Writable stream. The difference: stdout carries program output, stderr carries diagnostic output. When someone pipes your program's output into another program (`node app.js | grep foo`), only stdout goes through the pipe. stderr still prints to the terminal. That separation is the whole reason stderr exists - Unix invented it in the 1970s specifically so error messages wouldn't corrupt data flowing through a pipeline.

You can also construct your own Console instances that write to different streams entirely. More on that later.

## process.stdin

`process.stdin` starts in paused mode (covered in Chapter 3). Nothing happens until you attach a listener or pipe it somewhere. Once you start reading, the process stays alive - stdin holds a reference on the event loop (covered in Chapter 1).

Reading input, the simplest version:

```js
process.stdin.on('data', (chunk) => {
  console.log(`Got: ${chunk}`);
});
```

The `data` event fires with Buffer chunks. If stdin is connected to a terminal, you'll get one chunk per line - the user types, hits Enter, and the line (including the newline character) arrives as a single chunk. If stdin is piped (`echo "hello" | node script.js`), you might get everything in one chunk, or it might arrive in pieces. Stream chunking behavior is never guaranteed.

The async iterator form works too:

```js
for await (const chunk of process.stdin) {
  console.log(`Got: ${chunk}`);
}
```

Same behavior, cleaner syntax. The loop ends when stdin closes - when the user presses Ctrl+D (Unix) or Ctrl+Z (Windows), or when the piped input source runs out.

One thing to note about the Buffer chunks: they are raw binary data by default. The `chunk.toString()` call gives you a string because `toString()` defaults to the `utf8` encoding. But if someone pipes binary data into your program, you'll want to work with the raw Buffer. You can set the encoding explicitly with `process.stdin.setEncoding('utf8')` to get strings directly from data events, or leave it as Buffers for binary processing.

### Line-by-line with readline

For interactive CLI tools, you usually want lines, not raw chunks. The readline module (covered in Chapter 4) handles that:

```js
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  console.log(`You said: ${line}`);
});
```

The readline interface buffers incoming data and splits on newline characters (`\n` or `\r\n`). It also handles terminal niceties - arrow keys, backspace, history navigation with up/down keys. But only when stdin is a TTY. When piped, readline just splits on newlines and moves on. No line editing, no history, no tab completion. Those features come from the terminal's line discipline, and a pipe doesn't have one.

There's a promise-based variant too:

```js
import { createInterface } from 'node:readline/promises';
const rl = createInterface({ input: process.stdin });
const answer = await rl.question('Your name? ');
console.log(`Hello, ${answer}`);
rl.close();
```

`rl.question()` writes the prompt to stdout, waits for a line of input, and resolves with the string. The `rl.close()` call is necessary - without it, the readline interface keeps a ref on stdin and the process won't exit.

### Raw mode

When stdin is connected to a terminal, you can switch it to raw mode:

```js
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', (key) => {
  if (key[0] === 3) process.exit(); // Ctrl+C
  process.stdout.write(key);
});
```

In raw mode, every keystroke fires immediately as a data event. No line buffering. No echo (characters don't appear on screen unless you write them yourself). The terminal hands you raw bytes. Ctrl+C doesn't trigger SIGINT anymore - you get the byte `0x03` and you have to handle it yourself. Password prompts, interactive menus, text editors - anything that needs character-by-character input uses raw mode.

`setRawMode()` only works when `process.stdin.isTTY` is true. Calling it on a piped stdin throws an error.

Multi-byte keys come through as multi-byte buffers. An arrow key press, for instance, sends the escape sequence `\x1b[A` (up), `\x1b[B` (down), `\x1b[C` (right), `\x1b[D` (left). You get a 3-byte Buffer. Parsing these escape sequences is the job of libraries like `keypress` or the readline module's internal key parser. If you're building something that needs to handle arrow keys in raw mode, you'll need to decode ANSI escape sequences yourself or use a library that does.

### Keeping the process alive (and not)

stdin has a ref on the event loop. If you attach a `data` listener and do nothing else, the process won't exit. That's usually what you want for interactive programs. But sometimes you set up stdin reading as an optional feature - maybe you listen for Ctrl+C or certain keypresses, but the program should exit when its main work is done regardless.

```js
process.stdin.resume();
process.stdin.unref();
```

After `unref()` (covered in Chapter 1), stdin's listener won't keep the event loop alive. The process will exit when all other ref'd work finishes, even though stdin is technically still listening. You can call `process.stdin.ref()` to re-ref it later if conditions change.

A common pattern in dev tools: start with stdin unref'd, then ref it when the user activates an interactive debugging prompt. The tool can exit normally during non-interactive use, but stays alive for input when the user asks for a REPL.

## process.stdout

`process.stdout` is a Writable stream. `console.log()` writes to it. So does `process.stdout.write()`.

The difference between the two:

```js
console.log('hello');            // writes "hello\n"
process.stdout.write('hello');   // writes "hello" (no newline)
```

`console.log()` calls `util.format()` on its arguments, appends a newline, and writes the result to `process.stdout`. It's a convenience wrapper. `process.stdout.write()` is the raw write call - you control exactly what bytes go out. Most of the time you want `console.log()`. But when you're writing progress bars, drawing terminal UI, or building output without trailing newlines (like a prompt), `process.stdout.write()` is the right call.

`util.format()` does more than you might expect. `console.log('count: %d', 42)` uses printf-style formatting. `console.log({ a: 1 })` calls `util.inspect()` on the object. `console.log('a', 'b', 'c')` joins arguments with spaces. All of that is `util.format()`'s job, and it runs synchronously before the write happens.

### The return value of write()

Like any Writable stream, `process.stdout.write()` returns a boolean. `true` means the internal buffer is below the highWaterMark (covered in Chapter 3). `false` means the buffer is full - you should wait for the `drain` event (covered in Chapter 3) before writing more.

```js
const ok = process.stdout.write(bigChunk);
if (!ok) {
  process.stdout.once('drain', () => {
    // safe to write again
  });
}
```

In practice, most programs ignore the return value of stdout writes. For interactive output - a few log lines, some status messages - backpressure on stdout rarely matters. But if you're writing a program that dumps megabytes to stdout (a JSON formatter, a CSV exporter, a log processor), ignoring backpressure will balloon your memory. The internal buffer grows without bound until the consumer catches up or you run out of heap space.

The highWaterMark for stdout defaults to 16KB when connected to a pipe. For a TTY, it doesn't matter because writes are synchronous and the buffer is always empty after each write.

### Terminal dimensions

When stdout is connected to a terminal:

```js
console.log(process.stdout.columns); // e.g., 120
console.log(process.stdout.rows);    // e.g., 40
```

These give you the terminal's width and height in characters. They update when the user resizes the terminal window, and stdout emits a `resize` event:

```js
process.stdout.on('resize', () => {
  console.log(`${process.stdout.columns}x${process.stdout.rows}`);
});
```

When stdout isn't a TTY - when it's piped or redirected to a file - `columns` and `rows` are `undefined`. Programs that draw progress bars or format tables use these values, falling back to a default width (usually 80) when piped.

The `resize` event fires every time the terminal dimensions change. If you're redrawing a full-screen terminal UI (think `top` or `htop`), you'd listen for this event and re-render. The event comes from libuv's `uv_tty_t` handle, which registers a SIGWINCH signal handler internally. When the terminal emulator notifies the process of a size change via SIGWINCH, libuv captures it and emits the event on the JavaScript side.

### ANSI cursor control

Since stdout connected to a TTY is just a terminal device, you can write ANSI escape sequences to control the cursor:

```js
process.stdout.write('\x1b[2J');   // clear screen
process.stdout.write('\x1b[H');    // move cursor to top-left
process.stdout.write('\x1b[5;10H'); // move to row 5, col 10
```

These are the same escape codes that C programs use with `printf`. Node has no special cursor API - you just write the raw bytes. Libraries like `ansi-escapes` or `chalk` wrap these sequences in convenient functions, but underneath, it's always `stdout.write()` with escape codes.

For clearing a line and redrawing (useful for progress bars):

```js
process.stdout.write('\r');         // carriage return (start of line)
process.stdout.clearLine(0);        // clear the current line
process.stdout.cursorTo(0);         // move cursor to column 0
process.stdout.write('Progress: 42%');
```

`clearLine()` and `cursorTo()` are methods available only on TTY streams. They write the appropriate ANSI sequences internally. Calling them on a piped stdout throws.

## process.stderr

`process.stderr` is also a Writable stream. `console.error()`, `console.warn()`, `console.trace()`, and `console.dir()` all write to stderr. `console.log()`, `console.info()`, `console.table()`, and `console.count()` write to stdout.

That split matters. When you run `node app.js | grep pattern`, grep only sees stdout. Error messages, warnings, stack traces - all of that goes to stderr and shows up in the terminal even though stdout is being piped.

```js
console.log('data output');   // goes to pipe -> grep
console.error('debug info');  // goes to terminal
```

stderr is the right place for anything that isn't your program's actual output. Log messages, progress indicators, debug traces, error details. If someone might pipe your program into another program, keep diagnostic output on stderr. A lot of Node developers put everything on `console.log()` and wonder why their piped output is full of debug noise. The fix is simple: `console.error()` for diagnostics, `console.log()` for data.

### Separate redirection

The shell lets you redirect stdout and stderr independently:

```bash
node app.js > output.txt 2> errors.txt
node app.js > output.txt 2>&1  # merge stderr into stdout
node app.js 2>/dev/null        # discard errors
```

Your Node program doesn't need to know about any of this. The OS handles the redirection before your process even starts. By the time Node opens fd 1 and fd 2, they already point wherever the shell told them to. The redirection happens at the `fork()`/`exec()` level - the shell opens the target files, uses `dup2()` to replace fd 1 or fd 2 with the new file descriptors, then executes your program. Your process inherits the redirected fds as if they were always there.

The `2>&1` syntax deserves a note. It means "redirect fd 2 to wherever fd 1 currently points." Order matters: `node app.js > out.txt 2>&1` sends both to `out.txt`. But `node app.js 2>&1 > out.txt` sends stderr to the terminal (wherever fd 1 pointed before the `>` redirect) and stdout to the file. Shell redirection is evaluated left to right.

## TTY detection

`process.stdout.isTTY` is `true` when stdout is connected to a terminal. When piped or redirected, it's `undefined` (the property simply doesn't exist on the object - it's not set to `false`).

```js
if (process.stdout.isTTY) {
  process.stdout.write('\x1b[31mred text\x1b[0m\n');
} else {
  process.stdout.write('red text\n');
}
```

This pattern shows up in every CLI tool that supports colors. When you're writing to a terminal, ANSI escape codes render as colors. When piped to a file or another program, those escape codes become garbage characters (`^[[31m` appearing literally). So you check `isTTY` and strip the escapes.

The same property exists on all three streams:

- `process.stdin.isTTY` - `true` when the user is typing interactively, `undefined` when input is piped
- `process.stdout.isTTY` - `true` when output goes to a terminal, `undefined` when piped/redirected
- `process.stderr.isTTY` - `true` when error output goes to a terminal, `undefined` when redirected

Note that each stream's TTY status is independent. `node app.js | cat` sets stdout's `isTTY` to `undefined` but leaves stderr's as `true`. `node app.js 2>/dev/null` does the opposite. Only a full terminal session has all three connected to TTYs.

### Color detection

Beyond raw `isTTY`, Node has built-in color detection methods:

```js
process.stdout.getColorDepth();  // 1, 4, 8, or 24
process.stdout.hasColors(256);   // true/false
```

`getColorDepth()` returns the number of bits of color the terminal supports. 1 means monochrome (2 colors). 4 means 16 colors. 8 means 256 colors. 24 means true color (16 million colors). On a non-TTY, it returns 1.

`hasColors(count)` checks whether the terminal supports at least `count` colors. `hasColors(256)` returns `true` if the terminal can do 256-color output. You can also pass an environment object as the second argument: `hasColors(256, myEnvObject)`, which is useful for testing without modifying `process.env`.

These methods check several environment variables: `COLORTERM` (often set to `truecolor` or `24bit`), `TERM` (e.g., `xterm-256color`), `NO_COLOR`, `FORCE_COLOR`. The `NO_COLOR` convention (`NO_COLOR=1`) tells programs to suppress color output entirely. It's a cross-language standard - see no-color.org. `FORCE_COLOR` overrides `isTTY` and forces color output even when piped - useful for CI systems where you want colored output in log files.

```js
if (process.env.NO_COLOR) {
  // user explicitly wants no color
} else if (process.stdout.hasColors(256)) {
  // use 256-color output
} else if (process.stdout.isTTY) {
  // basic 16-color output
}
```

Libraries like `chalk`, `kleur`, and `colorette` do this check internally. They inspect `isTTY`, `NO_COLOR`, `FORCE_COLOR`, and `COLORTERM` to decide whether to emit ANSI sequences or plain text. If you're using one of those libraries, you probably don't need to call `getColorDepth()` yourself.

## Blocking vs Non-Blocking Writes

Here's where stdin, stdout, and stderr get genuinely confusing. The blocking behavior of these streams depends on what they're connected to. And it's different on Linux, macOS, and Windows.

### Three connection types, three behaviors

**Connected to a TTY (terminal):**

On Linux and macOS, writes to `process.stdout` and `process.stderr` are synchronous. The `write()` call blocks the event loop until the bytes are flushed to the terminal driver. On Windows, writes to a TTY are asynchronous - the Windows console API works differently, and libuv uses async writes through its own abstraction layer.

**Connected to a pipe (e.g., `node script.js | cat`):**

Writes are asynchronous on POSIX platforms (Linux, macOS) and synchronous on Windows. On POSIX, the data goes into an internal buffer. If the pipe consumer (the program on the other end) reads slowly, the buffer fills up, and backpressure kicks in. The kernel's pipe buffer is typically 64KB on Linux and 16KB on macOS, so backpressure can start quickly with high-volume output.

**Connected to a file (e.g., `node script.js > output.txt`):**

Writes are synchronous on all platforms. The `write()` call blocks until the data is written to the file's kernel buffer (which the kernel will eventually flush to disk asynchronously).

Here's that in table form:

| Connected to | stdout/stderr behavior | Platform note |
|-------|-----------|--------|
| TTY | Synchronous (blocking) | Async on Windows |
| Pipe | Asynchronous (non-blocking) | Sync on Windows |
| File | Synchronous (blocking) | All platforms |

### Why the inconsistency

The behavior comes from libuv (covered in Chapter 1), the C library underneath Node. When libuv detects that fd 1 or fd 2 is a TTY, it uses `uv_tty_t` handles. TTY writes on Unix go through a blocking `write(2)` syscall - there's no async TTY writing in libuv on Unix. When it detects a pipe, libuv uses `uv_pipe_t` handles, which are fully asynchronous with their own event-loop-driven write queue. When it detects a regular file, libuv uses synchronous writes because file I/O on the thread pool (covered in Chapter 1) would reorder writes.

The underlying reason for the inconsistency is pragmatic. Terminal output is typically small and fast - a human reading text at a terminal doesn't generate backpressure. The write completes in microseconds. Making it async would add event loop overhead (registering writability interest, handling the write callback, scheduling the next write) for output that finishes instantly anyway. Pipe output can genuinely block - the kernel pipe buffer is finite, and a slow consumer creates real backpressure. Async handling is necessary there. File output blocks in the kernel for data consistency, and using the thread pool would let writes complete out of order.

### The process.exit() data loss problem

```js
process.stdout.write('results\n');
process.exit(0);
```

When stdout is a TTY: safe. The write is synchronous. By the time `process.exit()` runs, the data is already on the screen.

When stdout is a pipe: dangerous. The write is asynchronous. `process.stdout.write()` puts the data in a buffer and returns immediately. `process.exit()` fires next, terminating the process before the buffer flushes. Your data vanishes.

I've seen this bug in production more than once. The program works fine during development - you run it in a terminal, the output appears, everything looks correct. Then you deploy it, pipe the output to a log aggregator, and suddenly the last few lines are missing. The writes were async, `process.exit()` ran before the buffer drained, and the data was lost.

The fix:

```js
process.stdout.write('results\n', () => {
  process.exit(0);
});
```

The callback fires after the data is actually flushed. Or, if you're using `console.log()`:

```js
console.log('results');
process.stdout.once('drain', () => {
  process.exit(0);
});
```

But even this has a subtlety. If the write didn't trigger backpressure (the buffer wasn't full), `drain` won't fire because it only fires after a `write()` returned `false`. If you want to force an explicit exit, passing a callback to `.write()` is the safest option.

Or better yet, just use `process.exitCode = 0` and let the event loop drain naturally. Set the exit code, stop starting new work, and let Node exit on its own when everything flushes. No explicit `process.exit()` call needed. This is by far the most reliable way to prevent data loss.

### stderr is (mostly) blocking

stderr behaves like stdout regarding connection types, but there's a historical convention worth knowing: many programs treat stderr as always-synchronous for safety. If your program is crashing, you want the error message to actually make it to the screen before the process dies. Node follows this convention on Unix when stderr is a TTY - the write blocks. But when stderr is piped, it's async, and the same data-loss-on-exit problem applies.

## The console object

`console` in Node is an instance of the `Console` class, configured with `process.stdout` and `process.stderr`. You can create your own:

```js
import { Console } from 'node:console';
const logger = new Console({
  stdout: process.stdout,
  stderr: process.stderr
});
```

The default `console` does exactly this. Every method on `console` ultimately calls `.write()` on one of those two streams. You can also redirect a custom Console to files:

```js
import { createWriteStream } from 'node:fs';
const log = new Console({
  stdout: createWriteStream('/tmp/app.log'),
  stderr: createWriteStream('/tmp/app.err')
});
log.log('this goes to /tmp/app.log');
```

The custom Console has all the same methods - `log`, `error`, `table`, `time`, `trace`. They write to whichever streams you passed in the constructor.

### Which methods write where

stdout methods: `console.log()`, `console.info()`, `console.table()`, `console.count()`, `console.countReset()`, `console.time()`, `console.timeLog()`, `console.timeEnd()`, `console.group()`, `console.groupEnd()`.

stderr methods: `console.error()`, `console.warn()`, `console.trace()`, `console.dir()`, `console.assert()` (when the assertion fails).

`console.log()` and `console.info()` are identical - same implementation, different name. `console.error()` and `console.warn()` are identical too. They call `util.format()` on the arguments and write to the respective stream.

### console.table()

```js
console.table([
  { name: 'alice', score: 95 },
  { name: 'bob', score: 87 }
]);
```

Prints a formatted ASCII table to stdout. It inspects the array of objects, extracts the column headers from the keys, and pads everything to align. You can pass a second argument to select specific columns: `console.table(data, ['name'])`. It goes to stdout, so it shows up in pipes. If you're building a CLI tool that outputs structured data, be aware that `console.table()` output isn't machine-parseable - it's for human eyes. Pipe-friendly tools should output JSON or CSV instead.

### console.time() and console.timeEnd()

```js
console.time('query');
await db.query('SELECT * FROM users');
console.timeEnd('query');  // query: 42.123ms
```

`console.time()` starts a high-resolution timer labeled with the string you pass. `console.timeEnd()` stops it and prints the elapsed time in milliseconds to stdout. `console.timeLog()` prints the elapsed time without stopping the timer - useful for tracking incremental progress within a long operation. Internally, these use `performance.now()`, so they have sub-millisecond precision.

You can have multiple named timers running simultaneously. Each label is independent. Calling `console.timeEnd()` with a label that doesn't exist prints a warning to stderr.

### console.trace()

```js
console.trace('checkpoint');
```

Prints `Trace: checkpoint` followed by a stack trace to stderr. It doesn't throw an error. It doesn't stop execution. It just dumps the current call stack as diagnostic output. Useful for tracking down where a function is being called from without setting breakpoints. The output includes the full call chain with file names and line numbers, just like an Error stack trace but without the Error.

## Piping patterns

The Unix philosophy: small programs that do one thing, composed via pipes. Node fits into this model through stdin and stdout.

The simplest pipe-through program:

```js
process.stdin.pipe(process.stdout);
```

Reads everything from stdin, writes it to stdout. That's `cat` implemented in one line. stdin is a Readable, stdout is a Writable, and `.pipe()` (covered in Chapter 3) connects them with automatic backpressure handling.

A filter that transforms each line:

```js
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  process.stdout.write(line.toUpperCase() + '\n');
}
```

You'd use this as `cat file.txt | node upper.js | head -5`. stdin comes from `cat`, stdout goes to `head`. stderr remains connected to the terminal for any error messages.

### Building a proper CLI filter

A slightly more realistic example - a JSON line filter:

```js
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  try {
    const obj = JSON.parse(line);
    if (obj.level === 'error') {
      process.stdout.write(line + '\n');
    }
  } catch {
    process.stderr.write(`invalid JSON: ${line}\n`);
  }
}
```

Good output goes to stdout. Bad input errors go to stderr. The calling shell can redirect them independently. If someone runs `node filter.js < logs.jsonl > errors.jsonl 2> parse-failures.txt`, they get clean separation of output and diagnostics.

The `try/catch` around `JSON.parse()` matters here. In a pipeline, one malformed line shouldn't crash the whole filter. Write the error to stderr, skip the line, keep processing. That's how well-behaved Unix filters work.

### Handling stdin end

When stdin is piped, it has a finite length. The `end` event (covered in Chapter 3) fires when all input has been consumed:

```js
let total = 0;
process.stdin.on('data', (chunk) => {
  total += chunk.length;
});
process.stdin.on('end', () => {
  console.log(`Read ${total} bytes`);
});
```

When stdin is a TTY, `end` fires when the user signals EOF with Ctrl+D. Your program should handle both cases identically - the stream abstraction takes care of the difference.

A detail worth noting: in a pipeline like `node producer.js | node consumer.js`, if the producer exits, the pipe closes, and consumer's stdin gets `end`. But if the consumer exits first, the producer gets SIGPIPE (or an EPIPE error on its stdout). The two directions of failure are asymmetric.

### Transform with pipeline()

For more structured transformations, you can use `pipeline()` (covered in Chapter 3) with a Transform stream:

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

`pipeline()` handles error propagation and cleanup. If any stream in the chain errors or closes, the others are cleaned up properly. The `for-await-of` approach from earlier is simpler for line-by-line work, but `pipeline()` with Transform streams gives you proper backpressure end-to-end.

## How Node bootstraps stdin, stdout, and stderr

When the Node process starts, before your script runs, the runtime sets up the three standard streams. The logic lives in `lib/internal/bootstrap/switches/is_main_thread.js` (and a separate path for worker threads, which don't get real standard streams).

### The bootstrap sequence

Node lazily initializes `process.stdin`, `process.stdout`, and `process.stderr` using getters on the `process` object. The first time you access `process.stdout`, the getter fires and creates the actual stream. Here's the rough sequence:

1. Node calls `getStdout()` (an internal function).
2. `getStdout()` calls `createWritableStdioStream(1)` - fd 1.
3. `createWritableStdioStream()` calls `guessHandleType(fd)` to figure out what fd 1 is connected to.
4. `guessHandleType()` calls the C++ binding `process.binding('uv').guessHandleType(fd)`, which calls libuv's `uv_guess_handle(fd)`.
5. `uv_guess_handle()` runs an `fstat()` on the fd and checks whether it's a TTY (using `isatty(fd)` on Unix), a pipe, a regular file, or something else.
6. Based on the result, Node creates different stream types.

The lazy initialization is deliberate. If your program never reads `process.stdin`, the underlying libuv handle is never created. The getter remains dormant. For short-lived scripts that don't need stdin, this avoids creating a handle that would need to be closed during shutdown.

### Handle type detection

`uv_guess_handle()` returns one of several constants:

- `UV_TTY` - fd is connected to a terminal. Node creates a `TTYWrap` handle internally, which wraps a `uv_tty_t` struct in libuv. The resulting JavaScript object is a `net.Socket` in a special TTY mode, with extra methods like `setRawMode()`, `getColorDepth()`, and properties like `columns` and `rows`. The `uv_tty_t` struct contains the fd, the terminal's original mode (saved at init so it can be restored on exit), and window size information obtained via `ioctl(fd, TIOCGWINSZ, &winsize)`.

- `UV_NAMED_PIPE` - fd is connected to a pipe (including Unix domain sockets). Node creates a `Pipe` handle wrapping `uv_pipe_t`. The JavaScript object is a `net.Socket` operating in pipe mode. Pipes are fully asynchronous - libuv registers the fd with epoll (Linux) or kqueue (macOS) for writability notifications and manages an internal write queue.

- `UV_FILE` - fd is a regular file. Node creates an `fs.WriteStream` (for stdout/stderr) or `fs.ReadStream` (for stdin). File streams for standard I/O are special-cased to use synchronous `fs.writeSync()` calls.

- `UV_UNKNOWN` - libuv can't determine the handle type. Node falls back to a `net.Socket` as a last resort.

The distinction between `uv_tty_t` and `uv_pipe_t` is where the blocking behavior originates. In libuv, `uv_tty_t` on Unix uses blocking `write(2)` syscalls directly. There's a reason for this: terminal output is expected to be low-volume and low-latency. A blocking write to the terminal completes in microseconds under normal conditions, and making it asynchronous would add complexity (event loop integration, write queue management) for no practical benefit. The write just goes straight to the kernel's TTY driver.

`uv_pipe_t` is fully integrated with the event loop. Writes go through libuv's standard write queue (`uv__write()`). When you call `process.stdout.write()` on a pipe-connected stdout, libuv enqueues the data in a `uv_write_t` request, registers interest in the fd being writable (via epoll/kqueue), and writes when the event loop gets to it. If the pipe's kernel buffer is full (the consumer isn't reading fast enough), the write stays queued and backpressure propagates up through the Node stream's internal buffer into your code as a `false` return from `.write()`.

### The file case

When stdout or stderr is redirected to a file (`node script.js > out.txt`), `uv_guess_handle()` returns `UV_FILE`. Node creates an `fs.WriteStream`. But here's the thing - `fs.WriteStream` for standard streams is special-cased. It uses synchronous `fs.writeSync()` calls internally, bypassing the thread pool entirely. The reason: if file writes went through the libuv thread pool, write ordering wouldn't be guaranteed. Two consecutive `process.stdout.write()` calls might complete in any order depending on which thread pool worker picks them up first, garbling your output. Synchronous writes maintain insertion order.

The cost is that a very slow filesystem (a network mount, a full disk, an overloaded SSD) will block the event loop on stdout writes. For most programs writing human-readable output, this is irrelevant. For programs dumping gigabytes to stdout redirected to a slow NFS mount - it could matter. The event loop stalls on each `write()` syscall until the kernel accepts the data.

### stdin bootstrap

stdin follows a similar path but creates Readable streams instead of Writable ones. When fd 0 is a TTY, Node creates a `net.Socket` with TTY capabilities - the same `uv_tty_t` based wrapper with `setRawMode()` and `isTTY`. When it's a pipe, it creates a pipe-backed `net.Socket`. When it's a file (rare, but possible with `node script.js < input.txt`), it creates an `fs.ReadStream`.

One special case: if stdin is a TTY, Node also sets up signal handling for Ctrl+C (SIGINT) through the TTY layer. In raw mode, this signal handling is disabled - as mentioned earlier, you get the raw byte `0x03` instead of SIGINT. The TTY layer has to cooperate with libuv's signal handling code to make this work correctly, and switching between raw and cooked mode involves saving and restoring terminal attributes via `tcsetattr()`.

### Worker threads

Worker threads don't inherit the parent's standard streams directly. `process.stdout` and `process.stderr` in a worker are redirected to the parent thread via an internal communication channel. The parent thread then writes to its own stdout/stderr. Worker thread stdout/stderr is always asynchronous - the data travels through a MessagePort to the main thread before hitting the actual fd.

`process.stdin` in a worker is null. Workers can't read from the terminal. If a worker needs input from the user, it has to request it from the main thread via messaging.

## Edge cases and gotchas

### stdout as a net.Socket

When stdout is a TTY, `process.stdout` is actually a `net.Socket` instance:

```js
const net = require('net');
console.log(process.stdout instanceof net.Socket);
// true (when connected to a TTY)
```

It has `net.Socket` methods - `.address()`, `.remoteAddress`, `.setKeepAlive()`, etc. Most of them return meaningless values or throw, since the "socket" is really a TTY device. But it also means `process.stdout` emits `error` events if something goes wrong with the underlying fd, and you need to handle those errors to prevent uncaught exceptions.

### The EPIPE error

When your program writes to stdout and the pipe consumer has already exited (e.g., `node app.js | head -1` - head exits after one line), the next write triggers SIGPIPE. Node catches this and emits an `error` event with code `EPIPE` on `process.stdout`. If you don't handle the error event, the process crashes with an unhandled error.

```js
process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE') {
    process.exit(0);
  }
});
```

Any program designed to be piped should handle EPIPE. Without the handler, `node generate-logs.js | head -5` crashes after head reads its five lines and closes the pipe. With the handler, your program exits cleanly. Most CLI frameworks handle this automatically, but if you're building a raw Node script that might be piped, add the handler.

### Mixed sync/async writes

Because stdout can be sync (TTY, file) or async (pipe), code that mixes `process.stdout.write()` with other async operations can produce surprising output ordering.

```js
process.stdout.write('A');
setTimeout(() => process.stdout.write('B'), 0);
process.stdout.write('C');
```

On a TTY: you see `ACB`. Both sync writes complete immediately, then the timer fires.

On a pipe: you still see `ACB` most of the time, because both `write('A')` and `write('C')` queue in order before the event loop advances to the timer phase. But with enough data to trigger backpressure, the ordering could shift. The key insight: even on a pipe, synchronous JavaScript execution order is preserved in the write queue. The writes go into libuv's queue in the order you call them. Reordering only happens if you yield to the event loop between writes and backpressure intervenes.

### console.log() is synchronous (sometimes)

Because `console.log()` writes to `process.stdout`, and stdout can be synchronous when connected to a TTY, `console.log()` can block the event loop. A program that logs heavily to a terminal will run slower than one that pipes to `/dev/null`. I've seen Node applications where switching from terminal output to piped output improved throughput by 10-20%, purely because the synchronous TTY writes were blocking the event loop between each write.

If you're benchmarking a Node program, make sure your measurement isn't affected by stdout blocking. Pipe to `/dev/null` or redirect to a file to remove TTY write latency from your numbers.

### Detecting the connection type

You can combine `isTTY` with other checks:

```js
const isTTY = process.stdout.isTTY;
const columns = process.stdout.columns || 80;

if (isTTY) {
  // interactive: colors, progress bars, cursor movement
} else {
  // piped: plain text, machine-parseable output
}
```

There's no built-in property to distinguish piped from redirected-to-file. Both show `isTTY` as `undefined`. If you need that distinction, you'd have to use `fs.fstatSync(1)` and check whether the fd points to a pipe or a regular file - but that level of detection is rarely necessary.

### The write buffer and exit

One more subtlety about process exit. When you call `process.exit()`, Node runs `process.on('exit')` handlers synchronously, then terminates. It doesn't wait for pending async writes. If `process.stdout` is backed by a pipe, any data in the write buffer is lost.

`process.exitCode = N` is the safe alternative. Set the exit code, stop doing work, and let the event loop drain. Node will flush the write buffers before exiting naturally when there's nothing left to process.

```js
process.exitCode = 1;
console.error('something went wrong');
// don't call process.exit() - let it drain
```

In cases where you must exit immediately (catastrophic error, signal handler), accept that piped stdout data might be truncated. Send diagnostic info to stderr (which may be synchronous if it's a TTY), and let the process die. That's the tradeoff. Fast exit vs complete output. For most programs, letting the event loop drain is the right call.
