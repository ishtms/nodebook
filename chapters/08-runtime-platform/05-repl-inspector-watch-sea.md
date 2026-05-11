---
title: "REPL, Inspector, Watch Mode, and Single Executables"
date: "2026-05-11"
excerpt: "How Node's operator-facing runtime tools evaluate code, expose debugger state, restart on file changes, and package an application into a single executable."
category: "Runtime Platform APIs & Tooling"
tags: ["nodejs", "repl", "inspector", "watch-mode", "single-executable"]
author: "Ishtmeet Singh @ishtms"
chapter: "runtime-platform"
subchapter: "repl-inspector-watch-sea"
published: true
toc: true
---

The same Node executable can host an interactive evaluator, expose debugger state, restart a process on file changes, and package code into a single executable.

Each tool changes a different part of the process lifecycle. The REPL keeps evaluation state alive. The inspector opens a debugging endpoint. Watch mode owns restarts. SEA changes how the program reaches startup.

Run `node` with no file and you get an interactive prompt:

```console
$ node
> process.version
'v24.15.0'
> os.platform()
'linux'
```

That prompt is the REPL: read, evaluate, print, loop. It reads one input unit, evaluates it inside a persistent JavaScript environment, prints the result, then waits for more input. The loop part is literal. The process stays alive because the REPL owns active input and output streams, usually `process.stdin` and `process.stdout`, and keeps asking the evaluator to run the next piece of text.

The REPL is live runtime state behind a prompt. Bindings stay around. Built-in modules are reachable. The current working directory matters. The same process object exists. If you change `process.env.DEBUG` in the prompt, you changed the current process. If you `require()` a module, it enters the usual CommonJS cache. If you throw, the REPL catches the exception for that interactive turn and gives the prompt back.

Small tool. Large reach.

## The REPL Context

A REPL context is the object used as the local environment for evaluated input. The standalone Node REPL uses the JavaScript global context. An embedded REPL created by application code usually gets a separate context unless you configure it to use `global`.

That distinction shows up fast:

```console
> const port = 3000
undefined
> port
3000
```

The binding survives because the REPL keeps the context alive between evaluations. A script file gets one program evaluation and exits when no work remains. The REPL keeps accepting source text and evaluates each turn against the same session state.

The default evaluator also has Node-specific behavior. Core module names can resolve on demand in the prompt:

```console
> fs.existsSync('package.json')
true
> path.basename(process.cwd())
'nodebook'
```

`fs` and `path` become available through the REPL's default evaluation rules. That convenience belongs to the REPL. A normal `.js` file still needs `require('node:fs')` or an import.

The current working directory is the base for many prompt experiments. `process.cwd()` is whatever directory the process had when the REPL started, unless you changed it with `process.chdir()`. A relative `fs.readFileSync('x')` call uses that directory. A relative CommonJS `require('./x')` from the standalone REPL also resolves from the current working directory path used by the REPL's synthetic main context. A normal module resolves relative imports from its own file. The REPL has no real source file for the line you just typed, so path-sensitive experiments need that difference in mind.

Results are written through a writer function. The default writer uses `util.inspect()`, which is why objects print with inspection formatting instead of JSON. The previous result is assigned to `_` until you assign `_` yourself. The previous error is assigned to `_error` under the same kind of rule.

```console
> [1, 2, 3]
[ 1, 2, 3 ]
> _.length
3
```

The underscore state is useful during inspection. It is also session state. Treat it as a convenience variable, not program design.

The evaluator path is a little more involved than the prompt suggests. The REPL receives bytes from the input stream. `readline` turns terminal input into submitted lines, handles editing, and keeps pending multiline input buffered. The REPL server then decides whether the line is a special command, incomplete JavaScript, or source text ready for evaluation. Special commands run against the `REPLServer`. Incomplete JavaScript stays buffered. Complete JavaScript goes to the evaluator with four pieces of data: the submitted code, the context object, a resource name for diagnostics, and a callback that receives either an error or a value.

That callback matters. Evaluation can be sync at the JavaScript level and still return through the callback contract. A custom evaluator can also finish later. The REPL prompt comes back when the evaluator calls back and the writer finishes formatting the value.

The default evaluator compiles the submitted source as an interactive script. It is not exactly the same as executing a file through the CommonJS loader. The REPL already has a context. It wraps enough behavior around evaluation to keep bindings alive, expose core modules on demand, handle top-level await, assign `_`, and recover from syntax that needs more lines. A syntax error that looks incomplete can become a `repl.Recoverable` error internally, which tells the server to keep collecting lines instead of printing a failure immediately.

```console
> function f() {
| return 1
| }
undefined
> f()
1
```

The `|` prompt means the REPL is holding buffered input. Node v24 changed the multiline indicator to that pipe and added multiline history support. The evaluator has not run the function declaration after the first line. It waits until the buffered source forms a complete input unit.

Context state and module state are separate pieces of process state. A `const` binding you create in the prompt belongs to the REPL's evaluated environment. A module loaded with `require()` belongs to the CommonJS module cache. In a separate-context REPL, `.clear` resets that context and aborts pending multiline input. In the standalone global-mode REPL, declarations and global mutations can survive. Loaded modules, open handles, changed environment variables, monkey-patched built-ins, active timers, and mutated objects can remain because they live outside the context object.

That is the first serious REPL lesson. The prompt feels disposable. The process is not.

REPL history is the saved list of previous input entries. The standalone Node REPL stores history across sessions unless configured otherwise. In Node v24, multiline history is preserved with a multiline prompt indicator of `|`, and previous multiline entries can be edited when brought back from history. Programmatic REPLs need explicit history setup with `replServer.setupHistory()` if you want file-backed history.

Special commands are dot-prefixed REPL commands handled by the REPL before normal JavaScript evaluation. `.help` lists them. `.exit` closes the session. `.clear` resets a separate REPL context and aborts pending multiline input; in the standalone global-mode REPL, existing declarations can remain available. `.save` writes the current session to a file. `.load` feeds a file into the current session. `.editor` switches the prompt into multiline editor mode.

```console
> .help
> .save scratch.js
> .exit
```

Those commands are REPL control input. They are parsed by the REPL server. They are not JavaScript syntax, and they do not pass through the same evaluator as `1 + 1`.

Signals and TTY behavior matter here because the prompt is interactive. `Ctrl+C` once aborts the current input or evaluation path. Pressing it twice on a blank prompt exits. `Ctrl+D` exits. Tab asks the REPL for completion candidates. Those are terminal interactions layered over the input stream, and a REPL connected to non-TTY streams gets a smaller feature set.

## Await at the Prompt

REPL top-level await means the prompt accepts `await` at the top level of an interactive input turn.

```console
> await Promise.resolve(42)
42
> await fs.promises.stat('package.json')
Stats { dev: 66307, mode: 33188, ... }
```

Top-level await already belongs to ES modules from Chapter 6 and async execution from Chapter 7. The REPL version is a convenience around interactive evaluation. It lets one prompt turn pause until the awaited Promise settles, then prints the fulfilled value or reports the rejection.

The prompt is still a REPL session. It is not suddenly a disk-backed ES module. CommonJS conveniences still exist. Core modules can still be pulled in by name under the default evaluator. `import()` works when you need ESM loading semantics from the prompt.

```console
> const { readFile } = await import('node:fs/promises')
undefined
> await readFile('package.json', 'utf8').then(s => s.length)
1361
```

That `1361` is example output. Your project prints whatever byte count its local `package.json` has.

One sharp edge is lexical scoping around `const` in awaited REPL input. Node's docs call out that REPL await can invalidate normal `const` lexical behavior in some interactive cases. The practical advice is boring: use the REPL for inspection and short experiments. Put repeatable module-loading behavior into a file when the module boundary itself is under test.

Await also changes prompt timing. The REPL receives a complete input unit, starts evaluation, observes that the result path is asynchronous, and waits before printing the final value. The process can still run other queued work while the Promise is pending because the event loop keeps moving. The prompt just withholds the next input turn until that awaited expression settles.

```console
> setTimeout(() => console.log('timer'), 10)
Timeout { ... }
> await new Promise(r => setTimeout(r, 50))
timer
undefined
```

The timer fires while the awaited Promise is pending. The REPL is interactive, but it is still the same Node process with the same event loop and microtask behavior covered earlier. The prompt waits for the evaluation result; the runtime keeps processing work.

Top-level await in a module participates in module linking and evaluation. REPL top-level await participates in one interactive evaluation turn. The difference matters when you test import ordering, cycles, or startup failures. A module graph has linker state. A REPL session has context state and whatever modules you explicitly load.

The same warning applies to package boundaries. A file named `tool.mjs` runs through the ES module loader. A package with `"type": "module"` changes how `.js` files load. The REPL does not become one of those files. It can import modules. It can require built-ins and CommonJS modules. It can await. It still remains an interactive evaluator with its own resource names, context rules, and convenience bindings.

`--no-experimental-repl-await` disables top-level await in the REPL. The flag name still carries the historical label. In Node v24, the behavior is there by default.

## Embedding a REPL

`node:repl` is the built-in module that creates REPL servers from code. An embedded REPL is a REPL started inside another Node program instead of by running `node` with no entrypoint.

```js
import repl from 'node:repl';

const r = repl.start({ prompt: 'admin> ' });
r.context.pid = process.pid;
```

`repl.start()` returns a `REPLServer`. The server reads from an input stream, writes to an output stream, evaluates each submitted command, and exposes a `context` object. Assigning `pid` above makes `pid` visible inside the prompt as a local value.

The default streams are `process.stdin` and `process.stdout`. You can pass different streams, which is how tools build local sockets, test harnesses, or controlled admin consoles around a REPL. The streams decide how interactive the session feels. A TTY output stream gets colors, line editing, completion previews, and key handling. A plain stream gets text in and text out.

Custom context values are the main reason to embed a REPL:

```js
import repl from 'node:repl';

const state = { requests: 0 };
const r = repl.start('ops> ');
r.context.state = state;
r.context.close = () => r.close();
```

Inside the prompt, `state.requests` reads the same object the program mutates. That is the point. It is also the risk.

An embedded REPL can expose live process internals. If you put a database client in the context, the prompt can query the database. If you put a cache object there, the prompt can mutate it. If the context uses `global`, the REPL can see and modify global process state. Object properties are writable unless you define them otherwise.

Use `Object.defineProperty()` for read-only context values:

```js
const r = repl.start('ops> ');

Object.defineProperty(r.context, 'config', {
  enumerable: true,
  value: Object.freeze({ region: 'iad' }),
});
```

That freezes the object you provide and makes the context property stable. Nested objects still need their own policy. The REPL does exactly what JavaScript object rules say.

Custom evaluators exist too. They receive the input text, the context, a resource name, and a callback. That path is useful when the prompt is a command interface rather than a JavaScript prompt. For this chapter, the built-in evaluator is enough. The operational boundary matters more: embedding a REPL gives an interactive code execution path inside the process.

The `useGlobal` option decides how much the REPL shares with the host program:

```js
import repl from 'node:repl';

repl.start({
  prompt: 'global> ',
  useGlobal: true,
});
```

With `useGlobal: true`, evaluated code uses the JavaScript global object as its context. The standalone Node CLI REPL uses that mode. With the default `false` for `repl.start()`, Node creates a separate context for the REPL instance. Separate means the prompt gets its own global-like object for evaluated bindings, while values you attach to `r.context` still point at the original objects you provided.

That boundary is useful when you want a narrow inspection context. It is thin when you attach live objects. A separate context containing `server`, `db`, or `cache` still exposes those objects' methods. JavaScript object identity crosses the context property. If the object has a method that mutates state, the REPL can call it.

Input and output streams are another boundary. An embedded REPL connected to `process.stdin` competes with the application for terminal input. A REPL connected to a Unix socket, TCP socket, or custom stream moves the prompt somewhere else. The runtime does not add access control because you changed streams. The stream is the transport. Your program owns the policy around who can reach it.

Embedded REPLs also interact with process shutdown. A live REPL keeps input open. If the rest of the program finishes but the REPL still has an active input stream, the process can remain alive. Calling `r.close()` closes the REPL server. Closing the underlying stream can also end the session. If you embed one for local diagnostics, wire it into the same shutdown path as the rest of the process so it does not keep the event loop active after the useful work is gone.

Keep that boundary local unless you have a separate security design. Authentication, authorization, audit logs, and network exposure belong to later operational chapters. The runtime mechanism is simple: a REPL server accepts input and evaluates it with access to whatever context and process state you gave it.

## The Inspector Endpoint

The inspector is Node's debugging interface to the V8 inspector backend. It exposes runtime state through the Inspector Protocol, a JSON message protocol used by debugger frontends and programmatic clients.

Start a process with an inspector endpoint:

```bash
node --inspect app.js
```

Node opens a WebSocket endpoint, usually on `127.0.0.1:9229`, and prints a URL that starts with `ws://`. The inspector endpoint is that host, port, and generated path. A debugger client connects to it and sends protocol commands. Node routes those commands into V8 and Node's inspector integration, then sends responses and events back over the same connection.

The startup variants change when user code runs:

```bash
node --inspect app.js
node --inspect-brk app.js
node --inspect-wait app.js
```

`--inspect` starts the endpoint and begins running the program. `--inspect-brk` starts the endpoint and breaks before user code runs. `--inspect-wait` starts the endpoint and waits for a debugger to attach before running user code. All three accept an optional host and port. Port `0` asks the OS for an available port.

The path trace is short:

```text
node --inspect app.js
  -> parse inspector flag during startup
  -> open host:port for inspector messages
  -> publish a WebSocket URL
  -> debugger sends Inspector Protocol messages
  -> V8 and Node inspector agents answer
```

The Inspector Protocol organizes commands into domains. `Runtime.evaluate` evaluates an expression. `Debugger.enable` turns on debugger events. `Profiler.*` and `HeapProfiler.*` exist too, but CPU profiles and heap snapshots belong to observability and performance chapters. Here, the detail to keep is the protocol boundary. Tools do not reach into your process by sharing JavaScript objects. They send protocol messages, and the process replies.

The endpoint publishes a target. A client discovers or receives the WebSocket URL, opens the connection, then starts exchanging messages with numeric IDs. Requests carry a method name such as `Runtime.evaluate` or `Debugger.setBreakpointByUrl`. Responses carry the same ID so the client can match them. Events, called notifications in the Node API, arrive without matching a specific request. A `Debugger.paused` notification can arrive because the process hit a breakpoint, because a `debugger` statement ran, or because the client asked execution to pause.

That request-response-plus-events shape explains the API design in `node:inspector`. A posted command can complete with a result. A session also emits events. Both paths are active at the same time.

```text
client -> {"id":1,"method":"Runtime.evaluate",...}
client <- {"id":1,"result":{...}}
client <- {"method":"Debugger.paused","params":{...}}
```

Protocol domains map to agents inside V8 and Node's inspector integration. The Runtime domain can evaluate expressions and expose object previews. The Debugger domain can enable script parsing events and control breakpoints. The Console domain can forward console activity. Node also has integration points for network-related inspector events behind experimental flags in v24, but those belong to tooling integration rather than the core debugging model here.

Object inspection over the protocol uses handles, previews, and explicit release commands. A debugger frontend can ask for a remote object, display a preview, then request more properties. The frontend is not holding the original object by direct reference inside its own JavaScript heap. The inspected process keeps the runtime objects, and the protocol describes them. That boundary is why a paused process can still show object state to a tool running elsewhere.

Pausing changes execution. When the debugger pauses the main thread, JavaScript execution stops at a known point. The event loop does not keep running user JavaScript while that thread is paused. Timers and I/O readiness can accumulate behind the pause. Resume hands control back. That is fine during local debugging. It is a production incident if it happens on the wrong process.

Binding the inspector to a public address exposes a code-execution debugging interface. The safe development default is loopback. `127.0.0.1` means local clients. `0.0.0.0` means clients that can route to that port may try to connect. Firewalls, tunnels, containers, and remote hosts can change who that includes. Treat the host binding as a security decision, not a convenience flag.

`--inspect-publish-uid` controls where Node publishes the inspector URL. The default includes `stderr` and HTTP discovery. That helps tools find the target. It also means the URL can land in logs. The URL contains a generated identifier, but the host and port are the real exposure boundary.

`--inspect-brk` and `--inspect-wait` are startup controls, so they affect preloads too. A preload from `--require` or `--import` belongs to startup work. When the debugger breaks before user code, the exact stop point depends on the mode and loader path, but the purpose is the same: give the debugger a chance to observe code before the application entrypoint has run far. That matters when the bug is in configuration bootstrap, preload instrumentation, or top-level module evaluation.

The inspector can be disabled from startup with flags such as `--disable-sigusr1`, which prevents the old Unix `SIGUSR1` inspector activation path. Permission-model flags can also restrict inspector use, but runtime permissions are deferred in this curriculum. The local point is that the inspector is a process capability. Decide at startup whether the process may expose it, then keep programmatic calls consistent with that decision.

## Inspector Sessions from Code

`node:inspector` is the built-in module for interacting with the inspector from JavaScript. It can open the endpoint, return its URL, wait for a debugger, and create inspector sessions.

```js
import inspector from 'node:inspector';

const disposable = inspector.open(0, '127.0.0.1');
console.log(inspector.url());
disposable[Symbol.dispose]();
```

`inspector.open()` activates the inspector after the process has already started. The first argument is the port. `0` asks for a random available port. The second is the host. The call returns a `Disposable` in Node v24, and disposing it closes the inspector through `inspector.close()`.

`inspector.waitForDebugger()` blocks until a connected client sends `Runtime.runIfWaitingForDebugger`. It throws when no inspector is active.

```js
import inspector from 'node:inspector';

inspector.open(9229, '127.0.0.1');
console.error(inspector.url());
inspector.waitForDebugger();
```

That code intentionally stops the current thread. It gives a debugger a chance to attach before later code runs. Use it where startup state matters. Remove it from normal service startup.

An inspector session is a client object connected to the inspector backend. The callback API lives at `node:inspector`. The Promise API lives at `node:inspector/promises`. In Node v24, `node:inspector/promises` carries Stability 1, experimental, even though the main `node:inspector` module is stable.

```js
import { Session } from 'node:inspector/promises';

const session = new Session();
session.connect();
const out = await session.post('Runtime.evaluate', {
  expression: 'process.pid',
});
console.log(out.result.value);
session.disconnect();
```

`session.connect()` attaches the session to the inspector backend. `session.post()` sends an Inspector Protocol command. The result shape comes from the protocol, so `Runtime.evaluate` returns a protocol object with fields such as `type`, `value`, and `description`.

Sessions extend `EventEmitter`, so notifications can be observed by event name:

```js
session.on('Debugger.paused', ({ params }) => {
  console.log(params.reason);
});
```

Same-thread debugging has limits. A session connected inside the same thread can send commands into the thing currently running the session code. Breakpoints on that same path can pause the debugger client and the debugged execution together. Worker inspection has its own rules and belongs later. For this chapter, keep the safe model narrow: use programmatic sessions for controlled protocol commands, and use an external debugger connection for interactive stepping.

Cleanup matters. `session.disconnect()` drops protocol state such as enabled agents and configured breakpoints. `inspector.close()` blocks until active inspector connections close, then deactivates the endpoint. That is process-level state, so library code should avoid opening or closing the inspector without a clear caller contract.

The Promise API and callback API share the same backend. Pick one per call path. The Promise API is experimental in Node v24, and it reads better in startup probes and one-shot scripts:

```js
import { Session } from 'node:inspector/promises';

const s = new Session();
s.connect();
await s.post('Runtime.enable');
s.disconnect();
```

The callback API is useful in older code or in places where a callback contract already exists. Either way, `session.post()` sends method strings defined by the Inspector Protocol. Misspell a method name and the backend responds with a protocol error. Pass the wrong parameter shape and the backend decides whether to reject it.

Programmatic inspector code should keep its lifetime obvious. Open the endpoint when the caller asked for it. Connect the session. Post the narrow command set. Disconnect. Close the endpoint if your code opened it. Leaving an inspector endpoint around after a diagnostic action changes the process's exposed state.

One more boundary sits between inspector and observability. An inspector session can ask V8 for profiles and heap snapshots. That does not make the inspector module an observability system. It is a protocol client. Storage, sampling policy, privacy filtering, upload paths, retention, and production runbooks live elsewhere. The useful skill here is naming when you have opened a debugger endpoint or sent a protocol command, and when you have crossed into a later operational concern.

## Watch Mode

Watch mode restarts a Node process when watched files change.

```bash
node --watch src/server.js
```

The `--watch` flag starts the entrypoint under Node's built-in restart loop. In Node v24, watch mode watches the entrypoint and any required or imported module by default. When one of those watched files changes, Node tears down the running child execution and starts it again.

The failure mode is familiar: a dev server keeps running old code because nobody restarted it, or it restarts too often because generated files sit in the watched set. Built-in watch mode handles the first case. Path selection handles the second.

```bash
node --watch-path=src --watch-path=config server.js
```

`--watch-path` specifies paths to watch and also turns on watch mode. When you use it, Node watches those paths instead of the auto-discovered required and imported modules. In Node v24, `--watch-path` support is limited to macOS and Windows. On platforms without support, Node throws `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`.

Watch mode is tied to an entrypoint file:

```bash
node --watch app.js
node --watch-path=src app.js
```

It does not combine with `--check`, `--eval`, `--interactive`, or the REPL. `--watch-path` also does not combine with `--test`. `--run` takes precedence and ignores watch mode. If you pass `--watch` without a file path, Node exits with status code `9`.

The watch restart signal is the signal Node sends to stop the running process before starting the next one. Node v24.4.0 added `--watch-kill-signal` for that choice:

```bash
node --watch --watch-kill-signal SIGINT app.js
```

The signal changes shutdown behavior because your process may handle `SIGINT`, `SIGTERM`, or another supported signal differently. Signal handling already belongs to Chapter 5. The watch-specific point is narrower: restart is process termination plus fresh startup. Any in-memory state disappears. Any cleanup path depends on the signal and the app's handlers.

By default, watch mode clears the console between restarts. Watch output preservation keeps previous output visible:

```bash
node --watch --watch-preserve-output app.js
```

That is useful when the line that explains the failed restart scrolled away or got cleared before you read it. Preserved output can get noisy during fast edit cycles. Pick the mode that helps the current debugging task.

Watch mode uses file watching underneath, and Chapter 4 already covered why file watching varies by platform. Editors can save by writing a temp file and renaming it. Build tools can rewrite whole directories. Network filesystems can coalesce or delay events. Node's watch mode sits on top of those platform signals and turns a detected change into a restart decision.

The restart loop has two sides. One side tracks files. The other side owns a running process. When the watcher reports a change, Node sends the configured restart signal to the current run, waits through its shutdown path, and launches a new run with the same entrypoint and execution arguments. The new run starts with fresh JavaScript heap state, fresh module caches, and a new startup sequence. External state remains external: ports, files, databases, sockets, and child processes follow their own cleanup behavior.

That distinction explains messy restarts. A server that handles `SIGINT` and closes its listening socket will usually restart cleanly. A server that ignores the restart signal can keep a port busy and can leave watch mode waiting for graceful termination until the process exits. A child process spawned by the app can outlive the watched parent if the app never tracks and terminates it. Watch mode starts the next run; your shutdown code controls what the previous run leaves behind.

Generated files deserve attention. Suppose `src/server.js` imports `src/routes.js`, and a build step writes `src/routes.generated.js` twice per save. Default `--watch` can see imported modules and restart on changes there. `--watch-path=src` may see both source and generated writes. In both cases, the restart frequency comes from the filesystem events Node receives. Keep generated output outside watched paths when possible, or point watch mode at a narrower directory.

There is also an entrypoint boundary. Watch mode restarts the Node program. It does not reload code inside the same process. Any code that relies on preserving in-memory state across edits belongs to a different design. For ordinary backend development, restart-from-zero is the sane behavior because startup bugs, module side effects, and configuration loading run again.

`NODE_OPTIONS` and CLI flags still apply. A command like this preserves the same runtime configuration on each restart:

```bash
NODE_OPTIONS="--enable-source-maps" \
node --watch --import ./boot.mjs app.js
```

Every new run gets the source-map setting and preload. If the preload changes and sits in the watched module graph or watched path, the process restarts and runs the new preload. If it lives outside the watched set, edit detection depends on the flags you chose.

Watch mode and terminals have their own small failure cases. Clearing output can hide the first stack trace after a fast restart. Preserving output can leave three failed startups on screen and make the current one harder to find. A syntax error can cause the new run to exit immediately while the watcher remains alive, waiting for the next edit. That is good for local development because a broken save does not kill the watch command itself.

The file list is runtime-derived unless you supply watch paths. Imported modules enter the watched set after they are loaded. Lazy imports may join later. A file that the process reads with `fs.readFile()` is data, not a module, so default watch mode may have no reason to track it. Use `--watch-path` when data files should trigger restarts, and remember the platform limit in Node v24.

There is a subtle test interaction too. The Node test runner has its own watch behavior, and `--watch-path` does not combine with `--test`. That split keeps restart ownership clear: application watch mode restarts an entrypoint; test watch mode reruns tests. If you are debugging a server and a test command at the same time, treat them as separate runtime commands instead of trying to fuse every edit loop into one process.

Watch mode also gives no transactional guarantee around a save. An editor can write half a file, rename it, then finish another related write a few milliseconds later. The watcher can restart between those writes. A TypeScript stripper, bundler, or code generator can do the same with output files. The fix is usually outside Node: write generated output atomically, keep partial files outside watched paths, or watch the final built directory rather than every intermediate input.

That makes watch mode a development tool. It is not a process manager. A process manager owns service supervision, backoff, logging policy, health checks, and boot ordering. Built-in watch mode owns edit-and-restart during local work.

## Single Executable Applications

A single executable application, or SEA, is a Node executable with an application preparation blob injected into it. In Node v24, the SEA flow takes a bundled CommonJS script, builds a preparation blob with Node, injects that blob into a copy of the Node binary, and starts by running the embedded script when the executable launches.

The smallest configuration looks like this:

```json
{
  "main": "dist/cli.cjs",
  "output": "sea-prep.blob"
}
```

That JSON file is a SEA configuration. `main` points at the bundled script. `output` names the preparation blob Node should write. Run Node with the v24 SEA flag:

```bash
node --experimental-sea-config sea-config.json
```

The output file is the SEA preparation blob. It is a binary payload generated by Node from the configuration. It can contain the bundled script, embedded assets, optional execution arguments, optional V8 code cache, and optional startup snapshot data.

Blob generation runs under the same Node version that will be injected later. Node's docs call that out because the preparation data is tied to the binary format and the runtime that consumes it. A blob from one Node version is the wrong input for a different Node binary. Keep `process.version` from the build step and the copied executable aligned.

The blob still has to enter an executable. In Node v24, that injection step is separate. A tool such as `postject` writes the blob into a copied Node binary under the resource name `NODE_SEA_BLOB`, then flips Node's SEA fuse string so the executable knows a blob is present.

The runtime trace matters more than the command sequence:

```text
sea-config.json
  -> node --experimental-sea-config
  -> sea-prep.blob
  -> copied node binary with injected blob
  -> launch executable
  -> Node detects blob and runs embedded main
```

On Windows, the blob is injected as a PE resource. On macOS, it is injected as a Mach-O section in the `NODE_SEA` segment. On Linux, it is injected as an ELF note. Those file-format details matter to packaging tools. The runtime fact is simpler: startup checks the executable for an injected `NODE_SEA_BLOB`; when present, Node runs the embedded application path.

Startup begins the same way as any Node executable: the operating system launches the binary, passes argv and environment, and Node initializes runtime state. The SEA path diverges when Node checks the executable for the SEA marker and blob. With no blob, the binary behaves like normal `node`. With a blob, Node uses the embedded application metadata and runs that main script instead of looking for a file entrypoint supplied on the command line.

User arguments still exist. In the SEA execution-argument examples, `process.argv[0]` and `process.argv[1]` both point at the executable path, then user arguments begin at index `2`. `process.execArgv` contains execution arguments configured through the SEA configuration and any permitted extension mechanism. That startup shape is close enough to normal Node for many CLI tools, but code that assumes `process.argv[1]` is a source file path will get the executable path instead.

SEA is packaging, not bundling. Node v24's SEA feature runs one embedded CommonJS script. Your dependency graph needs to be bundled into that file before the SEA step if it depends on files from `node_modules` or your source tree. The injected main script gets a `require()` with narrow behavior: it can load built-in modules, and it lacks most properties of normal file-based `require()` except `require.main`. If you need file-based loading, you can create it explicitly:

```js
const { createRequire } = require('node:module');

require = createRequire(__filename);
```

That gives the embedded script a file-based resolver rooted at `__filename`. Inside a SEA main script, `__filename` and `module.filename` equal `process.execPath`, and `__dirname` equals the directory containing the executable. Those values point at the executable, not at the original source file that produced the blob.

That file identity change breaks quiet assumptions. Code that finds templates with `path.join(__dirname, 'templates')` now points beside the executable. Code that reports its own filename reports the executable. Code that expects a package root by walking up from `__dirname` walks up from the install location. Some CLI programs want exactly that. Many server applications want a controlled config directory, cache directory, or data directory chosen through normal runtime configuration.

Assets are files bundled into the preparation blob under keys from the SEA configuration:

```json
{
  "main": "dist/cli.cjs",
  "output": "sea-prep.blob",
  "assets": { "schema": "schema.json" }
}
```

Inside the embedded script, `node:sea` exposes SEA-specific APIs:

```js
const sea = require('node:sea');

if (sea.isSea()) {
  const schema = sea.getAsset('schema', 'utf8');
  console.log(schema.length);
}
```

`node:sea` is the built-in module for code running inside a single executable application. `sea.isSea()` reports whether the script is running from an injected application. `sea.getAsset()` returns a copy as a string or `ArrayBuffer`. `sea.getAssetAsBlob()` returns a `Blob`. `sea.getRawAsset()` returns the raw `ArrayBuffer` from the executable without copying. `sea.getAssetKeys()` returns the embedded asset keys in Node v24.8.0 and later.

Raw assets deserve care. The raw buffer points at memory associated with the injected executable section. Node's docs warn against writing to it because alignment and writability depend on how the binary was injected. Use `getAsset()` when a copy is fine. Use `getRawAsset()` when avoiding a copy is part of a measured design.

Asset keys are application-level names. They are not filesystem paths unless you choose path-like strings. A key such as `"schema"` can point at `schema.json` during blob generation, then the embedded executable retrieves the bytes with `sea.getAsset('schema')`. Moving the original `schema.json` after build changes nothing about the already-built executable. Rebuilding the blob is the update mechanism.

That behavior is useful for small read-only data: schemas, templates, migration text, default configuration, certificates used for local development, or help output. It is a poor fit for mutable state. Write mutable data to a real filesystem path chosen at runtime. The asset APIs read data injected into the executable.

Execution arguments can be baked into the SEA configuration:

```json
{
  "main": "dist/cli.cjs",
  "output": "sea-prep.blob",
  "execArgv": ["--no-warnings"]
}
```

When the executable starts, those Node execution arguments are applied and appear in `process.execArgv`. `execArgvExtension` controls whether extra Node execution arguments can come from `NODE_OPTIONS`, from a `--node-options` CLI argument, or from neither. The default is `"env"`, which keeps `NODE_OPTIONS` active. That default can surprise people who expected a packaged executable to ignore the parent environment.

The three extension modes are worth naming. `"none"` accepts only `execArgv` from the SEA configuration and ignores `NODE_OPTIONS`. `"env"` accepts `NODE_OPTIONS` as an extension, matching normal Node startup behavior. `"cli"` accepts a `--node-options="..."` argument to the executable and parses those values as Node execution arguments instead of user arguments. Choose `"none"` for a packaged tool that should have a fixed runtime contract. Choose `"env"` when a platform wrapper still owns runtime settings. Choose `"cli"` when advanced users need an explicit escape hatch.

SEA code cache is V8 code cache stored in the preparation blob. With `"useCodeCache": true`, Node compiles the embedded main script while generating the blob and stores V8's cached compilation data. At launch, Node can use that cache while compiling the embedded script, reducing startup compilation work. The cache is tied to platform and engine details. For cross-platform SEA generation, set `useCodeCache` to `false`.

There is a specific `import()` edge too: `import()` does not work when `useCodeCache` is `true` in this SEA path. If the embedded script uses `import()`, leave code cache off.

SEA startup snapshot support takes a different route. With `"useSnapshot": true`, the main script runs while generating the preparation blob on the build machine. The resulting blob contains serialized V8 heap state. At launch, Node deserializes that state and runs the function registered through `v8.startupSnapshot.setDeserializeMainFunction()`. Snapshot constraints belong to V8 and startup performance work later in the book; the local model is enough here: code runs at blob generation time, heap state is captured, and launch starts from that captured state.

Snapshot generation changes when side effects happen. With the default SEA path, the embedded main script runs when the user launches the executable. With snapshot enabled, the main script runs while generating the blob. That means file reads, environment reads, random values, date reads, and initialization side effects may occur on the build machine unless you isolate them behind the deserialize main function. A snapshot-friendly entrypoint separates build-time heap preparation from launch-time user work.

Code cache and snapshots share a portability limit. The generated data matches the platform and Node/V8 build that produced it. A blob prepared on one platform can fail when injected into a binary for another platform if it carries code cache or snapshot data. Plain script and asset blobs have fewer moving parts.

The clean SEA build habit is to separate four steps. Bundle the application into one CommonJS file. Generate the preparation blob with the same Node version as the copied binary. Inject the blob into a clean copy of that binary. Run the executable in an empty-ish directory that lacks your source tree. That last test catches accidental filesystem dependencies. If the executable still reaches into `src/`, `node_modules/`, or a local `.env` file you forgot about, the SEA build did not produce the runtime contract you thought it did.

The error modes tend to be concrete. A missing asset key throws when `node:sea` cannot find it. A file-based `require()` throws when the embedded script asks for a dependency that was never bundled. A blob generated by one Node binary can fail when injected into another. A signed binary on macOS or Windows can lose its signature when modified and then fail platform policy checks until signed again. Those are build and launch failures, not mysteries inside your application code.

SEA also changes update mechanics. Replacing `schema.json` beside the project no longer updates an embedded asset. Rebuilding the blob and reinjecting the executable updates it. Replacing a config file beside the executable still works if your program reads that runtime file from the filesystem. The distinction is simple: blob data is build-time data; filesystem data is launch-time data.

SEA also changes the deployment assumptions around files. A normal Node app often reads relative files from its project directory. A SEA runs from an executable path. Assets included in the blob are available through `node:sea`; files left beside the executable are regular filesystem files; dependencies left in the original project tree are invisible unless the running process can still reach them through a configured file-based resolver. That is the boundary to test before treating a SEA as a release artifact.

Native addons can be included as assets, but loading them still requires a real file path because `process.dlopen()` loads a native binary from the filesystem. The usual pattern writes the asset to a temporary file and then calls `process.dlopen()`. That is platform packaging work, and Chapter 31 owns the release strategy. At runtime, SEA assets give you bytes. Native loader APIs decide what can execute.

The feature is marked active development in Node v24. That label matters for tooling compatibility. The high-level path is stable enough to reason about, but exact generation commands, supported platforms, and helper tooling can change across Node releases. For Node v24 specifically, use `--experimental-sea-config` and injection. Newer Node releases have additional SEA build commands, but this book's baseline stays on v24.

Signing, notarization, installer layout, Docker images, and production release channels are deployment topics. The runtime platform piece ends at the executable's behavior: argv shape, embedded main script, assets, optional execution arguments, optional code cache, optional snapshot, and changed path semantics.

## Production Boundaries

These tools all cross normal application boundaries.

The REPL evaluates input inside a live process. An embedded REPL exposes whatever context you attach. Keep it local or wrap it with a separate operational design.

The inspector opens a debugging endpoint. It can evaluate expressions, pause code, inspect memory, and emit profiling data through protocol domains. Loopback binding is the development default. Public binding is an exposure decision.

Watch mode owns restart-on-change for local iteration. It restarts from scratch and uses file watching signals that vary by platform. It does not own supervision policy.

SEA packages a Node runtime plus an embedded application payload into one executable. It changes path assumptions, module loading assumptions, and asset access. It does not remove the need to test startup flags, environment interaction, filesystem expectations, and platform-specific release steps.

Runtime platform tooling is useful because it runs close to the process. The same closeness is the boundary. A prompt, a debugger port, a restart loop, and an injected executable all become part of the way the process starts, stops, accepts input, and exposes state.
