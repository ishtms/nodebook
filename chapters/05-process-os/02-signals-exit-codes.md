---
title: "Signals, Exit Codes, and Graceful Shutdown"
date: "2026-02-22"
excerpt: "POSIX signals, exit codes, graceful shutdown patterns, and how Node.js handles SIGINT, SIGTERM, and uncaught exceptions."
category: "Process & OS"
tags: ["nodejs", "signals", "exit-codes", "SIGINT", "SIGTERM", "graceful-shutdown"]
author: "Ishtmeet Singh @ishtms"
chapter: "process-os"
subchapter: "signals-exit-codes"
published: true
toc: true
---

# Signals, Exit Codes, and Graceful Shutdown

Every process on a Unix system can receive signals. That sentence sounds obvious, but the mechanics are worth understanding at a level deeper than "SIGTERM means stop." Signals are the operating system's way of poking a process asynchronously - interrupting whatever it's doing and demanding attention. How your Node.js process responds to them determines whether your deploys are clean or whether you're shipping data corruption on every restart.

The previous subchapter covered `process.exit()`, `process.exitCode`, and the `beforeExit`/`exit` events. This one picks up where that left off, focusing entirely on signals, the convention behind exit codes, and the patterns for shutting down a running server without dropping requests.

## What Signals Actually Are

A signal is an asynchronous notification delivered to a process by the kernel. The word "asynchronous" here means the process doesn't ask for it - the kernel delivers it at a scheduling boundary or when the process returns from a system call. The process has no control over *when* the signal arrives. It's the kernel reaching into a running process and saying "deal with this."

The concept goes back to the earliest Unix systems. Signals predate sockets, pipes, and shared memory as an inter-process communication mechanism. They're the crudest form of IPC - just a number, no payload, no acknowledgment.

Each signal has a number and a name. The names are standardized by POSIX.

```
SIGHUP    1    Terminal hangup
SIGINT    2    Interrupt (Ctrl+C)
SIGKILL   9    Forced termination
SIGUSR1  10    User-defined signal 1 (on Linux)
SIGUSR2  12    User-defined signal 2 (on Linux)
SIGTERM  15    Graceful termination request
```

These six come up constantly in server work. There are others - SIGPIPE (13), SIGWINCH (28), SIGSTOP (19), SIGQUIT (3) - but the ones above cover 90% of what you'll deal with.

Signals can come from multiple sources. The kernel generates them (SIGSEGV when you access invalid memory, SIGPIPE when you write to a broken pipe). Other processes send them via the `kill` syscall. The terminal driver sends them (Ctrl+C generates SIGINT, Ctrl+\ generates SIGQUIT). And a process can send signals to itself.

At the kernel level, signals work through a pending bitmask on the process's task structure. When the kernel wants to deliver a signal, it sets the corresponding bit. The process checks that bitmask on return from any system call and at context-switch boundaries. If a bit is set and the process has registered a handler for that signal, the kernel arranges for the handler to run. If there's no custom handler, the kernel applies the signal's default action.

Because signals use a bitmask, a given signal can only be pending once. If two SIGTERMs arrive before the process checks its pending mask, the process sees exactly one SIGTERM. The second one is lost. This is rarely an issue in practice, but it's worth knowing - you can't queue standard signals. (There are "real-time signals," SIGRTMIN through SIGRTMAX, that do queue. Node doesn't use them.)

## Default Signal Actions

Every signal has a default behavior. Three categories:

**Terminate.** The process dies. SIGTERM, SIGINT, SIGHUP, SIGUSR1, SIGUSR2, and SIGPIPE all default to termination.

**Core dump.** The process dies *and* writes a core dump file. SIGQUIT (3), SIGABRT (6), SIGSEGV (11), and SIGBUS (7) do this.

**Ignore.** The signal is silently discarded. SIGCHLD and SIGURG default to being ignored.

Two signals sit outside this entire system: SIGKILL (9) and SIGSTOP (19). The kernel handles them directly. There's no way to catch, block, or ignore them. When SIGKILL arrives, the process is gone. Period. The kernel reclaims its memory, closes its file descriptors, and informs the parent process. SIGSTOP pauses the process until a SIGCONT arrives. No userspace code runs in response to either of them.

Node changes some of these defaults. By default, Node installs its own handler for SIGINT that calls `process.exit()`. It also installs a handler for SIGUSR1 that starts the V8 inspector/debugger. Everything else keeps the OS default unless you register your own handler.

There's a subtlety around SIGPIPE worth noting here. Most Unix programs die on SIGPIPE by default - write to a closed pipe, get killed. Node suppresses SIGPIPE globally during startup. It sets the SIGPIPE handler to `SIG_IGN` so that broken pipe writes produce an EPIPE error code in the write call instead of killing the process. This is the right behavior for a server, where one broken client connection shouldn't crash everything.

## Catching Signals in Node

Registering a signal handler takes one line.

```js
process.on('SIGTERM', () => {
  console.log('Received SIGTERM');
  process.exit(0);
});
```

That callback runs on the main thread, during a normal event loop tick. There's no preemption here - if your JavaScript is in the middle of a tight `for` loop, the signal handler won't fire until that synchronous work finishes and control returns to the event loop (covered in Chapter 1). This is a huge difference from C signal handlers, which can interrupt execution at almost any point.

The implication is real. If you have code doing heavy synchronous work - parsing a large JSON blob, running a tight computation, even a long string concatenation - your process is effectively deaf to signals during that time. The kernel has delivered the signal, but your JavaScript won't see it until the current synchronous operation finishes.

You can register multiple handlers for the same signal. They stack and fire in the order they were added, just like any EventEmitter listener.

```js
process.on('SIGTERM', () => console.log('handler 1'));
process.on('SIGTERM', () => console.log('handler 2'));
// Both fire on SIGTERM, in order
```

Removing a handler works through the standard EventEmitter API.

```js
const handler = () => { /* ... */ };
process.on('SIGTERM', handler);
// Later:
process.removeListener('SIGTERM', handler);
```

One thing to keep in mind: after removing all listeners for a signal, Node goes back to the default behavior for that signal. So if you remove all SIGTERM handlers, the next SIGTERM terminates the process immediately (OS default).

## SIGINT and Ctrl+C

SIGINT deserves its own section because Node handles it differently from other signals. When you press Ctrl+C in a terminal, the terminal driver sends SIGINT to the foreground process group. Node's default behavior is to call `process.exit()`, which triggers the `exit` event and shuts down.

But the moment you add your own SIGINT handler, Node's default handler goes away.

```js
process.on('SIGINT', () => {
  console.log('Caught SIGINT');
  // If you don't call process.exit(), the process keeps running
});
```

After registering that handler, pressing Ctrl+C prints "Caught SIGINT" and... nothing else happens. The process stays alive. You've replaced the default "exit on SIGINT" behavior entirely. If you still want the process to exit, you have to call `process.exit()` yourself inside your handler.

This catches people off guard regularly. You add a SIGINT handler to do some cleanup, forget to call `process.exit()` at the end, and now Ctrl+C does nothing. The only way out is SIGKILL or closing the terminal.

A common pattern is cleanup-then-exit:

```js
process.on('SIGINT', () => {
  console.log('Cleaning up...');
  // flush logs, close connections, etc.
  process.exit(0);
});
```

There's another subtlety. If you're using `readline` with a terminal interface, readline installs its own SIGINT handler that emits a `'SIGINT'` event on the interface. This can interact with your process-level handler in confusing ways. Generally, if you're building a CLI tool with readline, handle SIGINT on the readline interface. If you're building a server, handle it on `process`.

One more thing about SIGINT specifically. When you press Ctrl+C, the terminal driver sends SIGINT to the entire foreground process group, not just your Node process. If your Node process spawned child processes and they're in the same process group, they all get SIGINT simultaneously. This can lead to confusing shutdown behavior where both parent and child try to clean up at the same time. Detached child processes and processes in different process groups don't receive the signal.

## SIGTERM and Graceful Termination

SIGTERM is the standard "please shut down" signal. Process managers (systemd, Docker, Kubernetes, PM2) send SIGTERM when they want your process to exit cleanly. The convention is: send SIGTERM, wait a grace period (usually 10-30 seconds), then send SIGKILL if the process is still running.

Node's default behavior for SIGTERM is plain OS default - terminate immediately. If you want graceful shutdown (and you do, for any server), you need your own handler.

```js
process.on('SIGTERM', () => {
  shutdown();
});
```

The `shutdown()` function is where all the real work happens, and I'll cover the full pattern in a moment.

## SIGHUP, SIGUSR1, SIGUSR2

**SIGHUP** (signal 1) originally meant "the terminal hung up." In modern usage, it often means "reload your configuration." Some daemons re-read their config files on SIGHUP. In Node, the default is termination. If you want config reload behavior, you'd register a handler:

```js
process.on('SIGHUP', () => {
  reloadConfig();
});
```

On macOS and Linux, SIGHUP also fires when the controlling terminal closes. If you're running a Node process in a terminal and close that terminal window, SIGHUP arrives. SSH disconnections trigger it too - if you're SSH'd into a server and your connection drops, every process attached to that terminal session receives SIGHUP. This is one reason you use `nohup`, `tmux`, `screen`, or a process manager - they detach the process from the terminal so SIGHUP doesn't kill it.

The `nohup` command specifically ignores SIGHUP for the child process. `tmux` and `screen` create a new virtual terminal that persists after the SSH session ends. Process managers like systemd don't use a controlling terminal at all - the process has no terminal to hang up on.

**SIGUSR1** (signal 10) is special in Node. The runtime intercepts it to activate the built-in debugger/inspector. Sending `kill -USR1 <pid>` to a running Node process makes it start listening for Chrome DevTools Protocol connections on port 9229. This is how you can debug a production process without restarting it. If you register your own SIGUSR1 handler, it replaces this behavior - the debugger activation goes away.

**SIGUSR2** (signal 12) has no special meaning in Node. It's entirely yours. Some process managers use it for custom actions. PM2, for example, uses SIGUSR2 internally. If you're running under PM2 and want graceful shutdown, you might use SIGUSR2 instead of SIGTERM, depending on your PM2 configuration.

There's a general pattern here. SIGUSR1 and SIGUSR2 exist specifically for application-defined behavior. The kernel attaches no semantic meaning to them beyond "deliver this signal." Node claimed SIGUSR1 for the debugger, which leaves SIGUSR2 as the only truly free signal. Some teams use it for log rotation triggers. Others use it to dump diagnostic information to stderr. It's convention, not enforcement - use it for whatever makes sense in your deployment.

## SIGPIPE, SIGQUIT, and SIGWINCH

A few more signals worth covering.

**SIGPIPE** (signal 13) fires when a process writes to a pipe or socket whose reading end is closed. In C programs, SIGPIPE kills the process by default. This is a common source of mysterious crashes in networked C applications - a client disconnects, the server writes to the now-dead socket, SIGPIPE arrives, server dies. Node ignores SIGPIPE globally (sets it to `SIG_IGN` at startup), so writing to a broken pipe produces an EPIPE error instead of a signal death. You'll almost never need to handle SIGPIPE in Node, and that's by design.

**SIGQUIT** (signal 3) is Ctrl+\ in the terminal. Its default action is to terminate the process *and* generate a core dump. Core dumps are files containing the process's memory state at the time of death, useful for post-mortem debugging. Node doesn't intercept SIGQUIT by default, so pressing Ctrl+\ in a terminal kills the Node process and produces a core dump (if core dumps are enabled in the OS - `ulimit -c unlimited` on Linux). Some teams register a SIGQUIT handler that triggers a heap snapshot or diagnostic report instead of crashing:

```js
process.on('SIGQUIT', () => {
  const report = process.report.getReport();
  fs.writeFileSync('/tmp/diag.json', JSON.stringify(report));
});
```

This gives operators a way to get diagnostics from a misbehaving production process without killing it. The handler runs synchronously on the main thread, and `process.report.getReport()` captures heap statistics, active handles, libuv metrics, and the JavaScript stack. Writing it to a file lets you analyze it later.

**SIGWINCH** (signal 28) fires when the terminal window is resized. Node exposes this so you can adjust terminal UI (progress bars, cursor positions). It's irrelevant for headless server processes. If you're building a CLI tool with a responsive terminal interface, `process.on('SIGWINCH', ...)` is how you detect size changes. Call `process.stdout.columns` and `process.stdout.rows` inside the handler to get the new dimensions.

## Exit Codes in Depth

When a process terminates, it reports a numeric exit code to its parent. Zero means success. Everything else means some kind of failure.

Node.js defines specific exit codes for its own error conditions:

| Code | Meaning |
|---|-----|
| 0 | Success |
| 1 | Uncaught fatal exception |
| 2 | Unused (reserved by Bash for builtin misuse) |
| 3 | Internal JavaScript parse error |
| 4 | Internal JavaScript evaluation failure |
| 5 | Fatal Error (e.g., V8 out of memory) |
| 6 | Non-function Internal Exception Handler |
| 7 | Internal exception handler runtime failure |
| 8 | Unused |
| 9 | Invalid argument (e.g., unknown CLI flag with `-throw-deprecation`) |
| 10 | Internal JavaScript runtime failure |
| 12 | Invalid debug argument |
| 13 | Unfinished top-level await |

Exit code 1 is by far the most common failure code. Uncaught exceptions, unhandled promise rejections (when `-unhandled-rejections=throw` is in effect, which is the default since Node 15), and explicit `process.exit(1)` calls all produce it.

Exit code 5 is the one that scares you. A fatal V8 error means V8 itself is in an unrecoverable state. You'll see this when the heap runs out of memory during garbage collection or when an internal assertion in V8 fires. The process is done - there's nothing to recover from. Your monitoring should alert differently on exit code 5 versus exit code 1.

Exit code 9 shows up when you pass an invalid flag. Running `node -invalid-flag app.js` exits with 9 before your code even loads. Same with `-inspect=garbage` or conflicting flags that Node can't reconcile.

Exit code 12 means you messed up the debugger arguments specifically. Something like `-inspect=not-a-port` or `-inspect-brk=abc`.

Exit code 13 is relatively new - it fires when an ES module uses top-level await but the awaited operation never resolves. The process hangs, Node detects it, and exits with 13. This is a timeout mechanism - Node realizes the module graph can't finish evaluating and gives up.

You can check the exit code of any Node process from the shell:

```sh
node -e "process.exit(5)"
echo $?  # prints 5
```

The `$?` variable in bash holds the exit code of the last command. This is how CI systems, process managers, and shell scripts decide what happened. In a CI pipeline, a test suite exiting with code 1 means "tests failed." Your build script can branch on `$?` to decide whether to deploy.

Exit codes are single bytes - values 0 through 255. If you call `process.exit(256)`, it wraps around to 0. `process.exit(-1)` becomes 255. Stick to 0-127 for your own codes, since 128+ is reserved for the signal convention.

Codes above 128 follow a different convention entirely.

## The 128+N Convention

When a process is killed by a signal, the shell reports the exit code as 128 plus the signal number. This isn't a Node.js thing - it's a POSIX shell convention that `bash`, `zsh`, `dash`, and others all follow. The kernel itself reports two separate pieces of information to the parent process: whether the child exited normally (and if so, the exit code) or was killed by a signal (and if so, which signal). Shells combine these into a single number using the 128+N scheme for convenience.

```
128 + 2  = 130  (killed by SIGINT)
128 + 9  = 137  (killed by SIGKILL)
128 + 15 = 143  (killed by SIGTERM)
128 + 11 = 139  (killed by SIGSEGV)
```

So when your monitoring system reports a process exited with code 137, you know it was SIGKILL. That means something (the OOM killer, Docker, Kubernetes, or a human running `kill -9`) forcibly terminated it. It didn't crash. It was killed.

Exit code 139 (SIGSEGV) typically means a native addon or V8 itself hit a segmentation fault. A code of 143 usually indicates a graceful shutdown that didn't complete - SIGTERM arrived, the process didn't exit in time, so something sent SIGKILL, but the parent only sees the SIGTERM exit code if the process handled it and exited voluntarily. If you see 143, the process *chose* to exit after receiving SIGTERM. If you see 137, something *forced* it.

You can check the signal that killed a child process in Node:

```js
const { spawn } = require('child_process');
const child = spawn('sleep', ['100']);
child.kill('SIGTERM');
child.on('exit', (code, signal) => {
  console.log(code);   // null (killed by signal, not exit)
  console.log(signal); // 'SIGTERM'
});
```

When a process is killed by a signal, the `code` is null and the `signal` field contains the signal name. That's the Node API convention. The 128+N convention is what the *shell* reports to scripts and pipelines.

There's an edge case that confuses people. If your process handles SIGTERM and calls `process.exit(0)`, the exit code reported is 0 - because the process exited voluntarily. The 128+N code only appears when the process is *killed* by the signal without handling it. So if you see exit code 143, the process did NOT have a SIGTERM handler (or had one that didn't call `process.exit()`). If you see 0, the handler ran successfully and exited cleanly. This distinction matters for monitoring: 143 means your graceful shutdown code didn't run. Zero means it did.

## The Full Graceful Shutdown Pattern

A graceful shutdown has one goal: finish what you're doing, then stop. Drop nothing. Corrupt nothing. Leave every resource in a clean state. The concept was introduced in Chapter 1 - here's the full mechanical breakdown.

Graceful shutdown is the difference between "we deployed and nobody noticed" and "we deployed and 200 users got 502 errors." Most production incidents during deployment trace back to shutdown handling.

The sequence has five steps. I'll walk through each one, then show the full implementation.

**Step 1: Stop accepting new work.** Call `server.close()`. This tells the HTTP server to stop accepting new TCP connections. Existing connections stay open. In-flight requests keep processing. Under the hood, `server.close()` calls `uv_close()` on the listening TCP handle, which removes it from the event loop's I/O watcher. The OS stops queueing new connections on the socket's backlog. Clients trying to connect after this point get `ECONNREFUSED`.

**Step 2: Set a force-exit timeout.** If cleanup takes too long, you need a fallback. Set a `setTimeout` with `unref()` so the timer itself doesn't keep the event loop alive (ref/unref was covered in Chapter 1). This is your safety net - if cleanup hangs, the process still exits.

**Step 3: Wait for in-flight requests.** After `server.close()`, the `'close'` event fires once all existing connections have ended. If clients are slow or keep-alive connections linger, this can take a while. HTTP/1.1 keep-alive connections are the biggest source of delays here - a client might hold a connection open for 5 seconds between requests, and your server waits for it. Some implementations track active connections and destroy idle ones when shutdown starts.

**Step 4: Close external resources.** Database connection pools, Redis clients, message queue consumers, file handles, open write streams - all of these need explicit cleanup. Most client libraries expose a `.close()` or `.end()` or `.disconnect()` method. Call them in sequence or in parallel, depending on dependencies. If your Redis client depends on data that's being flushed from a database transaction, close the database last.

**Step 5: Exit.** Call `process.exit(0)` or just let the event loop drain. If you've closed everything properly and there are no remaining refs, the process exits naturally (covered in the previous subchapter). Calling `process.exit(0)` explicitly is fine and common in shutdown handlers.

Here's a concrete implementation:

```js
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const forceExit = setTimeout(() => process.exit(1), 10000);
  forceExit.unref();
  server.close(() => {
    db.end().then(() => process.exit(0));
  });
}
```

The `shuttingDown` flag prevents double-shutdown. Without it, a second SIGTERM (or a SIGINT following a SIGTERM) could trigger overlapping cleanup. The `setTimeout` with `unref()` is there for situations where `server.close()` or `db.end()` hangs - after 10 seconds, the process exits with code 1 regardless.

The `unref()` call is key. A normal `setTimeout` registers a timer handle in libuv, and that handle keeps the event loop alive. Calling `unref()` removes it from the alive-count. So if everything else finishes before the 10-second timeout, the process exits naturally without waiting for the timer.

Both SIGTERM and SIGINT should trigger the same function:

```js
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

You might want SIGHUP in there too, depending on your deployment environment.

### Tracking Active Connections

The basic pattern above waits for `server.close()` to complete, but keep-alive connections can hold things open for a long time. A more aggressive approach tracks connections and destroys them when shutdown starts:

```js
const connections = new Set();
server.on('connection', (socket) => {
  connections.add(socket);
  socket.on('close', () => connections.delete(socket));
});
```

Then during shutdown:

```js
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(() => cleanup());
  // Danger: this drops active requests too!
  for (const socket of connections) {
    socket.destroy();
  }
}
```

This is flawed because `socket.destroy()` forcibly and immediately closes the TCP socket, dropping any in-flight requests and returning `ECONNRESET` to the client. It does *not* wait for active requests to finish. To actually let active requests finish, you'd have to track which sockets are currently processing an HTTP request and only destroy the idle ones, which is complicated.

The `Connection: close` approach is more polite. When the server sends a response with this header, the client knows not to reuse the connection. After the response is complete, the client closes its end, and the server's `socket.on('close')` fires. This avoids the jarring experience of a forcibly destroyed socket. But it takes longer.

A middle ground is to track idle state and gracefully close sockets, but Node 18.2+ added `server.closeAllConnections()` and `server.closeIdleConnections()` specifically to solve this natively:

```js
server.close();
server.closeIdleConnections();
setTimeout(() => server.closeAllConnections(), 5000);
```

`closeIdleConnections()` destroys keep-alive sockets with no in-flight request. `closeAllConnections()` destroys everything. Using them together with a delay gives active requests time to finish before force-closing.

### Draining Queues and Background Work

Servers don't just handle HTTP requests. They might have background intervals, message queue consumers, or scheduled tasks. All of these need attention during shutdown.

```js
clearInterval(metricsInterval);
consumer.stop();   // stop consuming from Kafka/RabbitMQ/etc
await flushLogs(); // push buffered log entries
```

The order matters. Stop new work first, then finish existing work, then flush output. If you flush logs before stopping consumers, you might miss logging the last batch of processed messages.

### Health Check Integration

Here's something most shutdown guides skip. If your application runs behind a load balancer that performs health checks, you should start failing the health check as soon as shutdown begins. This tells the load balancer to stop routing new traffic to this instance *before* you close the server.

```js
let isHealthy = true;

app.get('/health', (req, res) => {
  // If using native Node: res.writeHead(isHealthy ? 200 : 503).end();
  // In Express:
  res.status(isHealthy ? 200 : 503).end();
});
```

Then in your shutdown function, set `isHealthy = false` before calling `server.close()`. The load balancer detects the 503, marks the instance as unhealthy, and stops sending traffic. By the time you actually close the server socket, no new requests are arriving. Without this step, there's a race window where the load balancer is still sending requests to a server that's about to stop accepting them, resulting in connection refused errors for those requests.

The timing depends on your load balancer's health check interval. If it checks every 5 seconds, you might want to wait 5-10 seconds after failing the health check before actually closing the server. Some teams add an explicit delay:

```js
function shutdown() {
  isHealthy = false;
  setTimeout(() => {
    server.close(() => cleanup());
  }, 5000);
}
```

This gives the load balancer time to see the failed health check and drain traffic away. It adds 5 seconds to your shutdown time, so make sure your total shutdown fits within the orchestrator's grace period.

### The PID 1 Problem in Containers

When your Node process runs inside a Docker container, it's probably PID 1. And PID 1 has special behavior in Linux: the kernel does not deliver unhandled signals to PID 1. On a normal system, SIGTERM to a process without a SIGTERM handler kills it (default action: terminate). But for PID 1, the kernel skips the default action. The signal is simply ignored.

This means if you run `node server.js` as the entrypoint of a Docker container without a SIGTERM handler, `docker stop` sends SIGTERM, the process ignores it (because it's PID 1 and there's no handler), Docker waits 10 seconds, then sends SIGKILL. Your process gets no chance to clean up.

Two fixes. First: always register a SIGTERM handler in your Node code. If you've got one, the signal is handled, and PID 1 behavior doesn't matter. Second: use `dumb-init` or `tini` as your container's entrypoint. These lightweight init systems run as PID 1 and forward signals to your Node process, which then runs as a normal PID (not 1). Most official Docker images now include `tini`.

```dockerfile
ENTRYPOINT ["tini", "--"]
CMD ["node", "server.js"]
```

With this setup, `tini` is PID 1 and handles signal forwarding. Your Node process is PID 2 and receives SIGTERM normally.

## Sending Signals from Node

`process.kill()` sends a signal to any process, given its PID.

```js
process.kill(childPid, 'SIGTERM');
```

The name is misleading. It doesn't necessarily kill anything - it sends whatever signal you specify. `process.kill(pid, 'SIGUSR2')` sends SIGUSR2, which by default terminates the target, but the target might handle it and do something else entirely.

You can also send signal 0 to check if a process exists:

```js
try {
  process.kill(pid, 0);
  console.log('Process exists');
} catch (e) {
  console.log('Process is gone');
}
```

Signal 0 doesn't deliver any actual signal. The kernel just checks permissions and existence. If the process exists and you have permission to signal it, the call succeeds. Otherwise it throws with an `ESRCH` error ("No such process"). This is a standard Unix idiom ported into Node.

The permission check matters. On Unix, you can only send signals to processes you own (same UID), unless you're root. If your Node process tries to `process.kill(1, 'SIGTERM')` (sending SIGTERM to PID 1, which is init), it'll throw an `EPERM` error unless you're running as root. In containerized environments where your process might be PID 1, this isn't an issue because you own that PID.

`process.kill()` also works for sending signals to your own process:

```js
process.kill(process.pid, 'SIGUSR2');
```

This is a roundabout way of triggering your own signal handlers. The signal goes through the kernel and back to your process, so it's asynchronous - the handler fires on the next event loop tick, not inline where you called `process.kill()`.

## Windows Differences

Windows doesn't have POSIX signals. The Windows kernel uses a completely different mechanism for process communication. Node fakes some signal support on Windows, but it's limited.

**SIGINT** works on Windows because it maps to the console Ctrl+C handler. Pressing Ctrl+C in a Windows terminal sends SIGINT to the foreground process, and Node's handler fires.

**SIGTERM** sort of works. `process.kill(pid, 'SIGTERM')` unconditionally terminates the target process on Windows. There's no opportunity for the target to catch it. It's closer to SIGKILL than SIGTERM in behavior.

**SIGHUP** fires on Windows when the console window is closed. But `process.kill(pid, 'SIGHUP')` unconditionally terminates the target, similar to SIGTERM.

**SIGKILL** always terminates unconditionally, which matches the Unix behavior.

**SIGUSR1 and SIGUSR2** don't exist on Windows at the OS level. Node emulates SIGUSR1 for the debugger: if you send it via `process.kill(pid, 'SIGUSR1')` from within the same Node process, it triggers the inspector. But you can't send it from an external process.

**SIGBREAK** (Ctrl+Break) is a Windows-specific signal that Node does support.

The bottom line: if you're writing cross-platform code, stick to SIGINT and SIGTERM. Handle the fact that SIGTERM on Windows is unconditional. For graceful shutdown in containers (which are Linux), SIGTERM works as expected. For Windows services, you'd use the `windows-service` npm package or similar, which hooks into the Windows Service Control Manager instead of signals.

Here's a practical cross-platform pattern:

```js
const isWindows = process.platform === 'win32';
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
if (isWindows) process.on('SIGBREAK', shutdown);
```

On Windows, SIGBREAK fires when you press Ctrl+Break, and it's the closest equivalent to "please stop gracefully." Some Windows process managers generate SIGBREAK rather than SIGTERM.

Windows also has the `CTRL_CLOSE_EVENT` for when the console window is closed. Node maps this to SIGHUP. But again - `process.kill(pid, 'SIGHUP')` from another process on Windows results in unconditional termination, so it's only useful for detecting terminal close events on the receiving process.

## How Node Registers Signal Handlers in libuv

This is where it gets interesting. JavaScript can't handle signals directly. V8 runs single-threaded JavaScript on the main thread, and signals are delivered by the kernel asynchronously - possibly while the thread is executing a syscall or sleeping in `epoll_wait()`. So there's a translation layer between the OS and your `process.on('SIGTERM', ...)` callback.

When you call `process.on('SIGTERM', ...)` for the first time, Node's C++ binding calls two libuv functions: `uv_signal_init()` and `uv_signal_start()`. `uv_signal_init()` allocates a `uv_signal_t` handle and associates it with the event loop. `uv_signal_start()` registers a C-level signal handler using `sigaction()` on Unix and starts watching for that signal number.

The C-level signal handler that libuv installs is tiny. It has to be - POSIX restricts what you can safely do inside a signal handler to a small set of async-signal-safe functions. You can't allocate memory, can't call `printf`, can't acquire locks. So libuv's handler does the absolute minimum: it writes a single byte to a pipe.

This pipe is the self-pipe trick. During initialization, libuv creates an internal pipe (or an `eventfd` on Linux, which is more efficient). The write end is used by the signal handler. The read end is registered with the event loop's I/O polling mechanism (epoll on Linux, kqueue on macOS). When the signal handler writes to the pipe, it wakes up the event loop.

Here's the flow:

1. Kernel delivers SIGTERM to the process.
2. libuv's C-level signal handler runs. It writes a byte to the self-pipe, encoding which signal number was received. This write is async-signal-safe because `write()` is on the POSIX safe list.
3. The event loop's poll phase (`uv__io_poll`) is blocked in `epoll_wait()` or `kevent()`. The pipe write wakes it up.
4. libuv reads from the pipe and sees "SIGTERM was received."
5. libuv calls the callback registered by `uv_signal_start()`. This callback is a C++ function inside Node that schedules the JavaScript signal handlers to run.
6. On the next event loop tick, your `process.on('SIGTERM', ...)` callback fires.

The self-pipe trick is a classic Unix pattern dating back to the 1990s. The problem it solves: `select()`, `poll()`, and `epoll_wait()` are blocking calls that wait for I/O. Signals can arrive during that wait, but they interrupt the syscall with `EINTR` rather than delivering the signal to the application in any structured way. By writing to a pipe from within the signal handler, you convert the asynchronous signal into a regular I/O event that the event loop knows how to process.

On Linux, libuv uses `eventfd` instead of a pipe when available. An eventfd is a kernel object that's lighter than a pipe - it's a single counter instead of a buffer, and it uses less kernel memory. The semantics are the same: write from the signal handler, read from the poll phase.

This architecture has a consequence worth understanding. Your JavaScript signal handler does NOT run at the instant the signal arrives. It runs on the next event loop tick after the poll phase wakes up and processes the pipe notification. If your code is in the middle of a synchronous computation that takes 500ms, the signal handler won't fire for 500ms. The signal is pending - the kernel has delivered it, libuv's C handler has written to the pipe - but JavaScript won't see it until the current JavaScript stack unwinds and the event loop rotates.

This explains why a tight synchronous loop makes your process unresponsive to signals. The event loop can't tick, so the pipe read never happens, so the JavaScript callback never fires. The only signal that can break through is SIGKILL, because the kernel handles it directly without involving userspace.

Internally, libuv maintains a red-black tree of active signal watchers, keyed by signal number. Multiple watchers can exist for the same signal (multiple calls to `uv_signal_start()` with the same signal). When the signal fires, libuv walks the tree and invokes every matching watcher's callback. In Node terms, this is how multiple `process.on('SIGTERM', ...)` listeners all fire - each one has its own `uv_signal_t` handle in the tree.

One more detail: `uv_signal_start()` uses `sigaction()` with `SA_RESTART` cleared. This means signal delivery will interrupt blocking syscalls like `read()` or `write()` with `EINTR`. libuv's internal I/O routines handle this by retrying on `EINTR`, so it's transparent to your application. But it's worth knowing because some native addons might not handle `EINTR` correctly, and signal delivery can surface bugs in those addons.

The `uv_signal_t` handle is ref'd by default - meaning it keeps the event loop alive. If your process has no other work and only a signal watcher is active, the event loop stays running, waiting for signals. This makes sense for a server that's waiting for SIGTERM. But if you want the signal watcher to not keep the process alive (maybe you have optional signal handling that shouldn't prevent natural exit), you'd call `uv_unref()` on the handle. In Node's JavaScript API, this maps to the ref/unref behavior on the internal signal handle, though Node doesn't expose it directly for signal watchers.

There's also a performance consideration. Each registered signal watcher adds one `uv_signal_t` handle to the loop, and each handle involves a kernel-level `sigaction()` call during setup. For typical applications registering 2-3 signal handlers, this is negligible. But if you were somehow registering and deregistering signal handlers in a loop (don't do this), you'd pay a syscall cost each time.

## Double-Signal and Force-Kill Patterns

In production, you'll encounter situations where a process doesn't exit after the first SIGTERM. Maybe a database connection is hanging, maybe a DNS lookup is stuck, maybe there's a bug in your cleanup code. The standard approach from the outside is:

1. Send SIGTERM.
2. Wait 10-30 seconds.
3. Send SIGKILL.

This is exactly what Docker does. The `docker stop` command sends SIGTERM, waits for the container's stop timeout (default 10 seconds), then sends SIGKILL. Kubernetes does the same with its `terminationGracePeriodSeconds` (default 30 seconds). systemd sends SIGTERM, waits for `TimeoutStopSec` (default 90 seconds in most distributions), then sends SIGKILL. PM2 sends the configured kill signal (SIGINT by default), waits for `kill_timeout` (default 1600ms, which is surprisingly short), then sends SIGKILL.

Each process manager has different defaults. Knowing them matters because your internal timeout should always be shorter than the external grace period. If PM2's default is 1.6 seconds, your cleanup needs to be fast - or you need to increase PM2's `kill_timeout`.

From inside your process, the `setTimeout(...).unref()` pattern mirrors this. You give yourself a grace period, and if cleanup doesn't finish, you force-exit.

Some processes handle a second SIGTERM or a second SIGINT as a force-exit signal:

```js
let termCount = 0;
process.on('SIGTERM', () => {
  termCount++;
  if (termCount > 1) process.exit(1);
  shutdown();
});
```

This gives operators a manual override: first SIGTERM triggers graceful shutdown, second SIGTERM forces immediate exit. The same pattern works for SIGINT - many CLI tools use it. First Ctrl+C means "stop gracefully," second Ctrl+C means "stop now."

The counter approach and the boolean `isShuttingDown` approach solve the same problem in slightly different ways. The boolean is cleaner for the SIGTERM case - you just want idempotent shutdown. The counter is better for the SIGINT case - where you specifically want the second press to be a force-exit, giving the user explicit feedback that "I heard you, shutting down" on first press and immediate termination on second press.

## Putting It All Together

A production-ready signal handler isn't complicated, but it does have to handle multiple edge cases: double-signal, timeout fallback, connection tracking, and resource cleanup ordering.

```js
async function gracefulShutdown(signal) {
  if (isShuttingDown) return process.exit(1);
  isShuttingDown = true;
  const killer = setTimeout(() => process.exit(1), 15000);
  killer.unref();
  if (server.closeIdleConnections) server.closeIdleConnections();
  await new Promise(resolve => server.close(resolve));
  await Promise.all([db.end(), redis.quit()]);
  process.exit(0);
}
```

The `isShuttingDown` variable is declared at module scope (a simple `let isShuttingDown = false`).

The key decisions in this pattern: the 15-second timeout is chosen to be shorter than your container orchestrator's grace period (which defaults to 30 seconds in Kubernetes). You want your application to finish cleanup before the orchestrator sends SIGKILL. If your Kubernetes terminationGracePeriodSeconds is 30, set your internal timeout to 20 or 25 to leave a buffer.

Crucially, you must wait for `server.close()` to finish by wrapping it in a Promise. Calling it without waiting means you might close the database before in-flight HTTP requests have finished processing them, causing errors.

The `isShuttingDown` check on re-entry means a second signal during shutdown calls `process.exit(1)` immediately. That's the manual force-exit escape hatch.

Calling `server.closeIdleConnections()` (available in Node 18.2+) drops keep-alive sockets that aren't processing requests so they don't hold the server open. The `Promise.all` for external resources runs cleanup in parallel - if your database and Redis and message queue are independent, there's no reason to close them sequentially.

The exit code is 0 for clean shutdown, 1 for forced/timeout shutdown. Monitoring systems can use this distinction to alert differently on graceful vs. forced restarts.

Both SIGTERM and SIGINT should use this function:

```js
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
```

## Common Mistakes

A few patterns I've seen go wrong often enough to be worth calling out.

**Not handling the `'error'` event on `server.close()`.** If the server was never listening (maybe it failed to bind to the port), calling `server.close()` throws. Wrap it:

```js
server.close((err) => {
  if (err && err.code !== 'ERR_SERVER_NOT_RUNNING') {
    console.error('Server close error:', err);
  }
  cleanup();
});
```

**Using `process.exit()` inside async cleanup without awaiting.** This one is sneaky. If you call `process.exit(0)` before your async cleanup finishes, the cleanup is aborted. `process.exit()` is synchronous and immediate - it doesn't wait for pending promises or callbacks. Always `await` your cleanup before exiting.

**Forgetting that `process.exit()` skips `beforeExit`.** If your cleanup code is in a `beforeExit` handler and you call `process.exit()` from a SIGTERM handler, the `beforeExit` handler never fires. The `exit` event fires, but `beforeExit` does not. If you need both, call your cleanup explicitly from the signal handler rather than relying on event ordering.

**Setting a force-exit timeout that's longer than the orchestrator's grace period.** If Kubernetes gives you 30 seconds and your internal timeout is 45 seconds, the orchestrator sends SIGKILL at second 30 while your process is still trying to clean up. Your timeout never fires. Always set internal timeouts shorter than external grace periods.

**Registering signal handlers inside request handlers or conditional blocks.** Signal handlers should be registered once, at startup, before the server starts listening. Registering them conditionally or inside request handlers means you might not have a handler when the signal arrives.

## Signal Handling Across Process Boundaries

When you spawn child processes from Node (covered in a later chapter), signal handling gets more complex. By default, spawned child processes are in the same process group as the parent. SIGINT from Ctrl+C hits the entire group.

If you want the parent to manage shutdown ordering - shut itself down first, then terminate children, or vice versa - you need to spawn children in a separate process group using the `detached: true` option. Then you're responsible for sending signals to children explicitly.

```js
const child = spawn('node', ['worker.js'], {
  detached: true,
  stdio: 'ignore',
});
child.unref();
```

A detached process won't receive SIGINT from the terminal's Ctrl+C. The parent has to send it explicitly with `child.kill('SIGTERM')` during its own shutdown sequence. This gives you full control over shutdown ordering, at the cost of more code.

For processes managed by cluster (also a later chapter), the primary process handles signals and coordinates worker shutdown. Each worker has its own signal handlers, but the primary is the one receiving SIGTERM from the orchestrator.

The general principle: whoever receives the signal is responsible for propagating shutdown to its children. The kernel doesn't do it for you unless the children are in the same process group and the signal comes from the terminal.

## Debugging Signal Issues

When your shutdown code isn't working right, the problem is usually one of four things: the signal isn't arriving, the handler isn't firing, the cleanup is hanging, or the process exits before cleanup finishes.

**The signal isn't arriving.** Your process might not be receiving the signal at all. This happens when you're running inside a container as a subprocess of a shell script. If your Dockerfile uses `CMD node server.js` (the shell form), Docker actually runs `/bin/sh -c "node server.js"`. The shell (PID 1) receives SIGTERM, but it doesn't forward it to the Node process. Your Node process never sees the signal. Fix: use the exec form - `CMD ["node", "server.js"]` - which runs Node directly as PID 1.

**The handler isn't firing.** The signal is delivered but your JavaScript handler doesn't run. Most likely cause: the event loop is blocked by synchronous work. Remember, signal handlers run during event loop ticks. If you've got a synchronous operation that takes 30 seconds, your signal handler waits 30 seconds. Check if you have any long-running synchronous code on the main thread.

**Cleanup is hanging.** Your shutdown function is called, but `server.close()` or `db.end()` never completes. For `server.close()`, this is usually keep-alive connections holding things open. For database clients, it might be pending queries that never resolve. The force-exit timeout catches this case, but 10 seconds of hanging shutdown is still 10 seconds of deployment delay.

**The process exits too early.** You call `process.exit(0)` before async cleanup finishes. Or an unhandled rejection in your cleanup code triggers an uncaught exception handler that calls `process.exit(1)`. Wrap your cleanup in try/catch and make sure every async operation is awaited.

You can add timing instrumentation to your shutdown handler:

```js
async function shutdown(signal) {
  const start = Date.now();
  console.log(`${signal}: starting shutdown`);
  server.close();
  console.log(`${signal}: server closed (${Date.now() - start}ms)`);
  await db.end();
  console.log(`${signal}: db closed (${Date.now() - start}ms)`);
  process.exit(0);
}
```

This tells you exactly which step is slow. In production, ship these timings to your logging system so you can see shutdown durations across your fleet. If one instance consistently takes 8 seconds to shut down while others take 200ms, you've got a specific problem to investigate on that instance.

You can also use `process.on('exit', ...)` as a last-resort diagnostic. The `exit` event fires synchronously right before the process actually terminates. If your shutdown handler completed but something else triggered an unexpected exit, the `exit` handler catches it:

```js
process.on('exit', (code) => {
  console.log(`Process exiting with code ${code}`);
  if (code !== 0 && !isShuttingDown) {
    console.log('Unexpected exit - not from shutdown handler');
  }
});
```

The `exit` handler is synchronous only. No async work here. No timers. No I/O. Just logging, incrementing counters, or other synchronous operations. Anything async is silently dropped. This is your last chance to write information before the process is gone.

