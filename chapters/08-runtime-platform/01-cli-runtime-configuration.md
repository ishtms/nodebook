---
title: "CLI Flags and Runtime Configuration"
date: "2026-05-11"
excerpt: "How Node consumes startup flags before user code runs: argv boundaries, NODE_OPTIONS, preloads, module conditions, warnings, diagnostics, memory limits, and node --run."
category: "Runtime Platform APIs & Tooling"
tags: ["nodejs", "cli-flags", "runtime-configuration", "node-options", "startup"]
author: "Ishtmeet Singh @ishtms"
chapter: "runtime-platform"
subchapter: "cli-runtime-configuration"
published: true
toc: true
---

The first startup decision happens before the entrypoint exists.

Node receives the parent environment and the argument vector, then starts consuming the pieces that belong to the runtime. Flags, preloads, V8 options, source-map policy, and the `--` separator all get handled before your file is parsed.

```bash
NODE_OPTIONS="--trace-warnings" \
node --enable-source-maps --require ./boot.cjs app.mjs -- --port=3000
```

The shell starts the process and passes two things to Node: an environment block and an argument vector. Node reads both. It pulls `--trace-warnings` from `NODE_OPTIONS`, consumes `--enable-source-maps`, consumes `--require ./boot.cjs`, chooses `app.mjs` as the program entrypoint, and leaves `--port=3000` for your application because it appears after the `--` separator.

Your code sees the aftermath.

```js
console.log(process.execArgv);
console.log(process.argv);
```

`process.execArgv` contains Node runtime options. `process.argv` contains the executable path, the entrypoint, and script arguments. The interesting part happens earlier: Node decides which bytes belong to the runtime, which bytes belong to the program, and which settings are fixed before the entrypoint runs.

That boundary matters. A Node CLI flag is an option consumed by the Node executable itself. It changes how Node starts, parses source, loads modules, reports warnings, sizes V8 memory, enables diagnostics, or runs package scripts. Runtime configuration is the full startup state Node derives from those flags, environment variables, and a few experimental configuration surfaces before user code gets control.

Once the entrypoint starts, some of that state is already fixed.

Source maps have either been enabled or left alone. Preload modules have already run. V8 has already received its heap flags. Module resolution already has its condition set. Warnings already have output policy. Your app can still read environment variables, load more modules, and install handlers, but it starts inside a process whose runtime shape was chosen earlier.

The startup path is compact:

```text
shell command
  -> environment block and argv
  -> Node option parser
  -> V8 options and Node runtime config
  -> preload modules
  -> entrypoint source
  -> script arguments
```

That trace is the practical model. When a production command looks weird, walk it left to right. Stop when Node stops consuming options. Everything after that belongs to the program.

## Startup State Before JavaScript

Node startup begins in native code. The JavaScript entrypoint is late in the sequence.

The executable receives `argc`, `argv`, and the process environment from the operating system. The shell has already done its expansion work by then: quotes removed, variables expanded, globs expanded by shells that perform globbing, and redirections applied outside the argument vector. Node receives strings. The original shell text is gone.

That distinction explains a lot of weird command bugs. Node can parse `--require ./boot.cjs` because those are two argv entries. It can parse `--require=./boot.cjs` because that is one argv entry with an inline value. A quote consumed by the shell has already disappeared. A literal string, a shell variable, and a wrapper script can all produce the same final argv unless the wrapper leaves evidence in argv or the environment.

Then Node reads startup inputs in layers.

The first layer is the environment. Some variables are general runtime data, such as `PATH` and `TZ`. Some are Node-specific. `NODE_OPTIONS` is special because it feeds the Node option parser. Other Node variables affect subsystems directly: `NODE_NO_WARNINGS`, `NODE_PENDING_DEPRECATION`, `NODE_REDIRECT_WARNINGS`, `NODE_V8_COVERAGE`, and `UV_THREADPOOL_SIZE` are examples. The startup property is the same across them: Node reads the values during process initialization or during early subsystem initialization, before your application has a chance to rewrite `process.env`.

The second layer is the command-line option region. Node parses flags until it reaches the entrypoint form or the argument separator. During that parse, it builds internal option state for Node-owned settings and collects supported V8 settings for engine initialization. Bad flags fail here. Bad combinations fail here. A malformed value for a startup option fails before the application module graph begins.

The third layer is engine and environment creation. V8 needs options before its isolate is created. Node needs process-wide options before it creates the JavaScript environment that will host `globalThis`, `process`, built-in modules, and the module loaders. The event loop exists as part of that environment, but this chapter is about the configuration that shapes it before work starts.

After that, Node can expose the parsed result back to JavaScript. `process.execArgv` is the visible list of Node execution arguments. `process.argv` is the visible program argument vector. They are snapshots of the startup boundary. Mutating `process.execArgv` later changes an array. Source maps, warning policy, V8 heap sizing, and preloads have already been configured for the current process.

Preload modules are the next major step. Node has enough JavaScript runtime online to load modules. The application entrypoint is still pending. That is a narrow phase with process-wide reach. Preloads can install handlers, patch modules, initialize instrumentation, and create global state before the entrypoint's dependency graph executes. They can also throw. A thrown preload error aborts startup before the app appears to start.

Only after those steps does Node evaluate the entrypoint. For a file, that means handing the path into the CommonJS or ESM loading path. For `--eval` and stdin, it means compiling the provided string with the selected input type. For `--check`, it means parsing and exiting. For `--run`, it means entering the package-script runner instead of loading an application file.

That native-to-JavaScript sequence is the reason startup flags feel different from normal configuration. Application code can inspect them, but it arrives after many of them have already been consumed.

## The Argument Boundary

Node's documented command shape is:

```text
node [options] [V8 options] [entrypoint | -e script | -] [--] [arguments]
```

The first region is Node-owned. The second region is source selection. The final region is yours.

```bash
node --trace-warnings --max-old-space-size=2048 server.js --verbose
```

`--trace-warnings` and `--max-old-space-size=2048` affect the runtime. `server.js` is the entrypoint. `--verbose` is passed to `server.js` because Node has already found the program entrypoint. Your application can parse it however it wants.

The explicit `--` marker makes the boundary unambiguous:

```bash
node --trace-warnings server.js -- --trace-warnings
```

The first `--trace-warnings` changes Node warning output. The second one is just a string in `process.argv`. Node leaves it alone.

You can see the split with a tiny script.

```js
console.log({ execArgv: process.execArgv });
console.log({ argv: process.argv.slice(2) });
```

Run it with a runtime flag and an application flag:

```bash
node --trace-warnings args.js --name=api
```

`process.execArgv` gets `--trace-warnings`. `process.argv.slice(2)` gets `--name=api`. That split is often enough to debug a broken startup command. If a flag should change Node but appears in `process.argv`, it landed after the entrypoint or after `--`. If a flag should belong to the app but Node rejects it, it landed before the boundary.

Node also accepts V8 flags in the runtime-owned region. V8 flag forwarding means Node recognizes a supported set of flags owned by the V8 engine and passes them down while building the isolate and runtime state. Memory flags are the usual example:

```bash
node --max-old-space-size=4096 worker.js
```

`--max-old-space-size` belongs to V8. Node accepts it, validates enough of the shape to pass startup, and V8 uses it while sizing the old generation heap. Your script sees it in `process.execArgv`. Heap sizing happened before your first line.

Some Node flags are repeatable. Some are single-value. That distinction shows up again when `NODE_OPTIONS` enters the process, so keep it in mind. A repeated preload flag accumulates. A repeated inspector port gets one winning value.

There is one more boundary hidden in plain sight: the executable path itself. `process.argv[0]` is the path used to start Node, or a value supplied through launch mechanics on some platforms. `process.argv[1]` is usually the entrypoint path when a file is involved. With `--eval`, `--print`, stdin, and `--run`, that second slot can differ because there is no normal script file. Tooling that blindly assumes `process.argv[1]` points at a disk file will break under those modes.

Process managers add another layer. A service file, shell script, Docker entrypoint, or package script can wrap the final Node command. The wrapper may inject flags before your visible app command, append arguments after it, or set `NODE_OPTIONS`. When the behavior is surprising, inspect the effective process. On Linux, `/proc/<pid>/cmdline` shows the null-separated argv for a running process, and `/proc/<pid>/environ` shows its environment if permissions allow it. That is outside Node, but it is often the fastest way to prove which startup inputs the process actually received.

For child Node processes, `process.execArgv` becomes practical again. Many APIs that spawn new Node instances default to inheriting or reusing the parent execution arguments. That can be exactly what you want for preloads and debugging. It can also spread a memory flag, warning suppression, or inspector setting into helper processes that were meant to be small. Treat inherited exec arguments as part of the child-process contract, even when the spawn call lives far away from the service startup command.

## Entrypoint Modes

Entrypoint mode is the way Node obtains the source text it will run. A file path is the common mode. There are others, and they change parsing in ways that show up during debugging.

A file entrypoint is the normal case:

```bash
node ./src/server.js
```

Node resolves the path from the current working directory, then sends the resulting file into the CJS or ESM loading path. The entrypoint path becomes part of `process.argv`. Flags before it belong to Node. Arguments after it belong to the program.

`--eval` runs source from the command line:

```bash
node --eval "console.log(process.execArgv)"
```

`--eval` is usually written as `-e`. It tells Node to run the following string as program source. There is no file entrypoint. The source text comes from the argv value itself, so path-based module details such as `import.meta.filename` have different behavior than they do for a disk file.

The current working directory becomes more visible in eval mode. Relative `require()` calls and `import()` calls still need a base. For CommonJS eval, Node evaluates the string in a synthetic main context. For ESM eval with `--input-type=module`, the source has module semantics, including top-level await. That is useful for one-off inspection commands. Scripts that assume file-local metadata exists can break under this mode.

`--print` is the same entry source with an extra print step:

```bash
node --print "process.version"
```

`--print`, or `-p`, evaluates the string and prints the result. It's useful for quick runtime inspection because the output comes from Node itself, inside the same startup configuration as any other command. If `NODE_OPTIONS` sets `--trace-warnings`, `node -p` inherits that too.

`--check` parses a file and stops after syntax validation:

```bash
node --check ./src/server.js
```

Node reads the file, parses it, reports syntax errors, then exits. The program body stays untouched. Preloads still deserve care here because `--check` is about the entrypoint source, while startup configuration can still affect the process before that parse step. Treat it as a syntax check with normal startup configuration.

`--check` also stays at syntax depth. It catches parse failures. Import resolution, top-level execution, and runtime feature availability happen on other paths. A file can pass `node --check` and still fail during ESM linking or CommonJS execution. Use it for the narrow thing it does.

Stdin is another entrypoint mode:

```bash
printf "console.log(1 + 1)\n" | node -
```

The `-` entrypoint tells Node to read source text from standard input. Without a file extension or package boundary to consult, Node needs another signal for module shape when the input uses ESM syntax or TypeScript stripping modes.

That signal is `--input-type`.

```bash
node --input-type=module --eval "await Promise.resolve()"
```

`--input-type` tells Node how to interpret string input from `--eval` or stdin. In Node v24, values include `commonjs`, `module`, `commonjs-typescript`, and `module-typescript`. The runtime fact here is narrow: `--input-type` applies to string input through `--eval`, `--print`, or stdin.

The default for string input has changed over Node releases as syntax detection has matured. In v24, Node can detect ESM syntax in ambiguous input under the default settings. A startup command that needs stable behavior across shells, CI machines, and Node minors should still say what it means. `--input-type=module` is clearer than relying on detection for an eval command that uses `await` or `import`.

The trap is easy to reproduce:

```bash
node --input-type=module ./script.js
```

For a disk file, Node rejects that shape during startup with `ERR_INPUT_TYPE_NOT_ALLOWED`. `--input-type` belongs to `--eval`, `--print`, and stdin. Use `.mjs`, `"type": "module"`, or package boundary metadata for a file-backed ES module entrypoint.

Interactive mode is another startup shape. REPL behavior has its own path. For now, the key point is source selection. File, eval string, print string, stdin, syntax check. Those modes determine what Node parses after runtime flags have been consumed.

## `NODE_OPTIONS` Enters Before the Command Line

`NODE_OPTIONS` is an environment variable that injects Node CLI options into startup. Node reads it before it processes the command line arguments. The practical result is inherited runtime state.

```bash
NODE_OPTIONS="--trace-warnings" node app.js
```

That command changes startup while the visible argv only names `node` and `app.js`. Inside the script, inspect both fields:

```js
console.log('execArgv:', process.execArgv);
console.log('NODE_OPTIONS:', process.env.NODE_OPTIONS);
```

`NODE_OPTIONS` is the environment evidence. `process.execArgv` records Node execution arguments supplied on the command line, so the command above prints an empty `execArgv` array and the `NODE_OPTIONS` string. The deeper point is earlier than inspection: `NODE_OPTIONS` changes the process before user code can sanitize it.

That makes it useful and dangerous.

Useful: a platform can enforce source maps, preloads, diagnostics, or memory settings for every Node process launched under a service wrapper.

Risky: a shell profile, CI job, test harness, process manager, or parent process can leak `NODE_OPTIONS` into a command that was meant to start clean.

The failure mode is boring and common:

```bash
export NODE_OPTIONS="--require ./instrumentation.cjs"
node tools/migrate.js
```

`tools/migrate.js` starts after `instrumentation.cjs` has already run. If that preload changes globals, installs hooks, changes warning policy, or reads configuration, the migration command now has behavior that is absent from the visible `node tools/migrate.js` text.

The bug usually appears as disagreement between two ways of starting the same file. A developer runs `node app.js` in a clean shell and sees one result. CI runs `node app.js` under a job environment and sees another. The file is identical. The module graph is identical on disk. Startup state differs.

Keep that temporary print early in a debugging branch, before the app loads its full dependency graph. It tells you which direct Node flags reached `process.execArgv` and which inherited flags came from the environment. For preloads, the print inside the entrypoint runs after the preloads, so put a second print in the preload itself if ordering is under suspicion.

Node restricts which flags are accepted in `NODE_OPTIONS`. The allowlist includes many runtime flags, preload flags, source-map and warning flags, diagnostic toggles, condition flags, and selected V8 flags. The parser rejects flags that would make environment injection too ambiguous or structurally unsafe for the command. Script filenames come from the real command. Entrypoint mode comes from the real command. The process still needs a real command boundary.

That allowlist is a security and predictability boundary. An inherited environment can enable `--require`, `--import`, warnings, conditions, diagnostics, selected permission flags, selected inspector flags, and selected V8 flags. Program source and application arguments stay attached to the actual command line. Node still has to parse the real command and find the program mode there.

Option precedence is the rule Node uses when the same setting appears in more than one startup source. For single-value flags, the command line wins over `NODE_OPTIONS`.

```bash
NODE_OPTIONS="--inspect=127.0.0.1:4444" \
node --inspect=127.0.0.1:5555 app.js
```

The inspector listens on port `5555`. The command line gives the later, more specific value. The environment supplied a default. The direct command overrode it.

Repeatable flags combine in order. `NODE_OPTIONS` entries come first, then command-line entries.

```bash
NODE_OPTIONS="--require ./a.cjs" \
node --require ./b.cjs app.js
```

That behaves as if the command had listed `--require ./a.cjs` and then `--require ./b.cjs`. Ordering matters because preload modules execute in order and can mutate process state.

Quoting matters too. `NODE_OPTIONS` is a string parsed by Node's option parser. Spaces split arguments unless quoted for the shell and then parsed by Node. In practice, keep it boring. Use full flag names. Quote paths that need quoting. Prefer visible command-line flags when the setting belongs to one command rather than the whole process tree.

Cross-platform quoting adds another reason to keep `NODE_OPTIONS` small. POSIX shells, PowerShell, `cmd.exe`, service managers, and container runtimes each have their own quoting rules before Node receives the string. The Node parser sees the environment value after that layer. A flag that works in an interactive shell can fail under a service wrapper because the quoting changed before Node started.

For stable operations, separate defaults from command-specific policy. A default such as `--enable-source-maps` may belong in a launcher if every service ships transformed code. A one-off preload for a migration should live on that migration command. A memory flag for a worker should live on that worker command. Broad environment injection is convenient until a helper process inherits a setting it was never designed to carry.

`NODE_OPTIONS` also interacts with environment-file loading. Node v24 can load environment variables from files, and those files can contain `NODE_OPTIONS`. That gives you multiple configuration layers. The precedence rules decide which one wins. The parsing details belong with environment-file configuration; the startup review already has the rule it needs.

## Preloads Run Before the Entrypoint

Preload flags run code before the program entrypoint. They are startup hooks in the literal sense: Node resolves and evaluates modules during bootstrap, then evaluates your entrypoint.

`--require` is the traditional CommonJS preload path.

```bash
node --require ./boot.cjs app.js
```

`--require` preload means Node loads `./boot.cjs` with the CommonJS loader before `app.js`. Resolution follows the same CommonJS rules as a later `require()` call. The module runs once and lands in `Module._cache`. If `app.js` later calls `require('./boot.cjs')`, it gets the cached exports instead of running the file again.

Modern Node can also preload a synchronous ESM graph with `--require`. The useful split for most commands is practical: use `--require` for CommonJS setup, and use `--import` for ESM setup when the preload uses top-level await or should follow the ESM-native startup path.

The cache detail has real consequences. A preload that exports mutable state can become the shared instance the application later imports. That can be intentional:

```js
module.exports.startedAt = Date.now();
module.exports.mode = process.env.NODE_ENV;
```

If the entrypoint requires that module, it reads the instance initialized during preload. The same object identity comes back. That is a clean way to centralize tiny startup state. It is a poor place for large application configuration because it couples startup order to module state and makes test setup harder.

That makes `--require` a common place for instrumentation and process-wide setup:

```js
process.on('warning', warning => {
  console.error(warning.stack);
});
```

Put that in `boot.cjs`, pass it with `--require`, and the warning handler exists before the entrypoint loads its dependency graph. That timing is the whole feature. A handler installed inside `app.js` can miss warnings emitted while loading modules imported by `app.js`.

Instrumentation packages use this phase because they need to patch or wrap APIs before the application imports them. If an HTTP library is loaded before the instrumentation module, the instrumentation may miss the chance to wrap the exported functions or constructors. Preload order turns that race into a startup rule: instrumentation first, app second.

Patching has a cost. When a preload changes a built-in module export, modifies globals, or installs async hooks, every later module runs in that modified runtime. The application source may look clean while behavior comes from earlier startup code. For production, put the preload in the deployable command and review process rather than a hidden local shell setting.

Repeated `--require` flags run in the listed order:

```bash
node --require ./env.cjs --require ./tracing.cjs app.js
```

`env.cjs` runs first. `tracing.cjs` runs second. Then `app.js` starts. If `tracing.cjs` reads configuration prepared by `env.cjs`, the order is part of your startup contract. Hide that order inside a long process manager config and someone will eventually break it.

The ESM-native preload path is `--import`.

```bash
node --import ./boot.mjs app.mjs
```

`--import` preload means Node resolves and evaluates the module through the ES module loader before the entrypoint. It follows ESM resolution rules, participates in the ESM module map, and can use top-level await. That last property affects startup timing: if a preloaded ESM module awaits a promise, Node waits for that module evaluation before it runs the entrypoint.

```js
await connectTelemetry();
globalThis.telemetryReady = true;
```

That works in an ESM preload. It also delays the entrypoint. If the awaited operation hangs, the program hangs before `app.mjs` starts. Entry-point code runs too late to install a timeout around a preload that has already taken control.

ESM preloads also pass through ESM linking before evaluation. Their static imports resolve and link first. Then evaluation runs, including top-level await. A failure in that graph rejects startup before the entrypoint's graph begins. The stack trace points at the preload graph, which is accurate, but teams often search inside the app entrypoint because that is the file named in the service command.

CommonJS preloads run before ESM preloads.

```bash
node --import ./esm-boot.mjs --require ./cjs-boot.cjs app.mjs
```

The text order there is misleading. Node runs `--require` preloads before `--import` preloads. The documented rule is explicit because the loaders have different bootstrap requirements. If both kinds are present, treat the order as:

```text
NODE_OPTIONS --require entries
command-line --require entries
NODE_OPTIONS --import entries
command-line --import entries
entrypoint
```

Within each family, repeatable flags preserve their source order with `NODE_OPTIONS` entries before command-line entries. Across families, CommonJS preloads go first.

Preloads also apply beyond the main thread in several Node startup paths. Worker threads, forked child processes, and clustered processes can inherit the same preload behavior when they start new Node instances with inherited exec arguments. That detail matters for instrumentation. It also matters for code that mutates globals, patches built-ins, or opens resources during preload. A preload written for one host process can run once per Node instance.

The clean preload is small and boring. Install a hook. Register instrumentation. Set a global bridge if the application already owns that convention. Then stop. Heavy I/O, network calls, and process exits inside preload code create startup failures that are hard to attribute because the application entrypoint may be absent from the stack where people expect it.

There is a useful test for preload code: remove the application entrypoint and run only the preload.

```bash
node --require ./boot.cjs --eval "console.log('ready')"
```

For ESM:

```bash
node --import ./boot.mjs --eval "console.log('ready')"
```

That isolates startup behavior. If the command hangs, throws, opens handles, or prints warnings, the preload owns that behavior. The app may still have its own bugs, but the runtime reached it with state already changed.

## Conditions Change Package Selection

`--conditions` adds custom conditions to the package exports resolver.

```bash
node --conditions=development app.mjs
```

Conditional exports let a package expose different files for different resolution conditions. Node already has built-in conditions such as `node`, `import`, and `require`. A custom condition lets the startup command add another selector.

Given a package with conditional exports:

```json
{
  "exports": {
    ".": {
      "development": "./dev.js",
      "default": "./prod.js"
    }
  }
}
```

Running with `--conditions=development` can select `./dev.js` for that package entry. A command with the default condition set selects the default path.

That means a startup flag can change which file a package loads. Same source. Same import string. Different module graph, because the resolver received a different condition set.

Use that with restraint. A custom condition can be clean when a package intentionally publishes separate runtime entries. It gets messy when teams use it as a hidden environment switch. If two commands import the same package name but use different conditions, they may execute different source files with different side effects and different dependency graphs.

The flag affects resolution, so the timing is earlier than evaluation. Once a specifier resolves to a concrete file URL or CommonJS filename, the loader proceeds with that file. The cache key follows the resolved target. Two processes with different condition sets can build different module graphs from the same import strings. Inside one process, the condition set is startup state. Mutating `process.env` halfway through the module graph leaves the resolver's startup condition set unchanged.

That makes `--conditions` useful for deliberate package-level variants and awkward for request-level behavior. A service process has one condition set. Every request handled by that process shares it. If you need per-request behavior, put that branch in application code. If you need package-resolution behavior, put the condition in the startup command and treat it as process identity.

Repeated conditions accumulate:

```bash
node -C development -C local app.mjs
```

Both custom conditions become available to resolution. The package's `"exports"` object still controls the final match, including key order and fallback behavior. The flag only adds condition names. Package metadata keeps control over which target wins.

Condition names are plain strings. Pick names that belong to your package contract rather than a single laptop or branch. `development` and `production` are common because many tools understand them. A team-specific name can work when the package publishes it intentionally. A surprising name in a startup command should send you to the package's `"exports"` field to see which file it selects.

## Source Maps, Warnings, and Deprecation Policy

Some flags change what developers and operators see when the process reports a problem. Business logic stays the same. The runtime output path changes.

Source map support maps generated stack traces back to original source locations when source maps are available.

```bash
node --enable-source-maps dist/server.js
```

With source maps enabled, Node consults source map data when formatting stack traces. That is useful for bundled or transformed code, including code that was originally TypeScript. The mechanism belongs to stack trace preparation. Node still runs `dist/server.js`; the source map changes the locations printed in errors.

The cost sits on the error path and in metadata handling. For backend services, source maps are often worth enabling when deployed code differs from authored code. But make the setting visible. A crash report with mapped paths is much easier to read, while a broken or stale map can point at lines that no longer match the deployed artifact.

Source maps also affect coverage metadata through V8 coverage output. Node consumes source map comments and map data that already exist. The compiler, bundler, or TypeScript stripping path produced those files earlier. If the map is missing, stale, or points at paths absent from the runtime image, Node has limited information to work with.

Warnings have their own policy flags.

```bash
node --trace-warnings app.js
node --no-warnings app.js
node --redirect-warnings=warnings.log app.js
```

`--trace-warnings` prints stack traces for process warnings, including deprecations. `--no-warnings` suppresses the default warning output to stderr. `--redirect-warnings` writes warnings to a file, falling back to stderr if the file write fails.

Warning controls are runtime output policy. They affect how warnings surface. A deprecated API call still happened. A max-listeners warning still means an emitter crossed its configured listener count. Suppressing output only changes visibility.

Node also has targeted warning controls:

```bash
node --disable-warning=ExperimentalWarning app.js
```

That disables warnings by code or type. It can quiet a known noisy path during a migration. It can also hide the only startup signal that a flag, API, or dependency is using an unstable path. Use the narrowest control that matches the problem, and prefer trace output while investigating.

Deprecation mode is the startup policy for deprecation warnings.

```bash
node --pending-deprecation app.js
node --throw-deprecation app.js
node --trace-deprecation app.js
node --no-deprecation app.js
```

`--pending-deprecation` enables pending deprecations that are quiet by default. `--trace-deprecation` prints stack traces for deprecations. `--throw-deprecation` turns deprecations into thrown errors. `--no-deprecation` suppresses deprecation warnings.

Those modes are useful at different points in a codebase. CI can run with stricter deprecation behavior to catch usage early. Production may prefer trace output during a short investigation window. Blanket suppression removes one of Node's few built-in migration signals, so it should have an owner and an expiry date.

Warnings also have environment-variable forms. `NODE_NO_WARNINGS=1` suppresses warnings. `NODE_PENDING_DEPRECATION=1` enables pending deprecations. `NODE_REDIRECT_WARNINGS=file` redirects warning output. Those variables are startup configuration too, even though they are not spelled as CLI flags. When warning output differs between two environments, inspect both the command and the environment.

There is a separate unhandled-rejection policy:

```bash
node --unhandled-rejections=strict app.js
```

For promises, the runtime fact here is narrow: this flag changes how Node reacts when a rejection remains unhandled. In Node v24, the default mode is `throw`. A startup command that changes it can alter whether a process warns, throws, exits with a code, or stays quiet for that class of failure.

## V8, Memory, and Diagnostics

Node owns the CLI. V8 owns the JavaScript engine. Startup flags cross that boundary.

```bash
node --v8-options
```

That command prints V8 options accepted by the embedded engine. The full catalog rarely belongs in application docs or service manifests. The review skill is recognizing when a flag affects the engine rather than Node's JavaScript APIs.

Memory limit flags are the common case:

```bash
node --max-old-space-size=2048 app.js
```

`--max-old-space-size` sets the maximum size, in MiB, of V8's old generation heap. The old generation stores long-lived JavaScript objects. When that space approaches the limit, garbage collection runs more aggressively; when V8 fails to free enough memory, the process can terminate with an out-of-memory failure.

The flag is read before V8 builds the heap for the isolate. That timing gives it different semantics from application configuration. A config file loaded by your app can decide how many jobs to run, how many database connections to open, or how large an in-memory cache should be. V8 heap size has already been chosen by then. If heap size belongs to the service contract, put it in the startup command or the process manager config that launches Node.

That flag caps one V8 heap region. Buffers can use external memory. Native code can allocate memory. The C++ side of Node, OpenSSL, zlib, mmap-backed data, thread stacks, and allocator fragmentation all contribute outside the old generation heap. Here the startup point is specific: `--max-old-space-size` sizes one major V8 heap region, and it must be present before V8 initializes the isolate.

That distinction explains a common mismatch: a service with `--max-old-space-size=512` can still show RSS above 512 MiB. The JavaScript old generation has a limit. The process has more memory regions. Container limits, operating-system accounting, native allocations, and external buffers all matter. Use the V8 flag to control V8 heap pressure. Use platform memory limits for whole-process memory policy.

There is also `--max-semi-space-size`, which affects the young generation semi-space size. Most backend services touch it less often. Tuning it from a guess can trade allocation throughput against garbage collection frequency in ways that vary by workload. Name it when you see it. Reach for profiling before changing it.

Node v24 also has `--max-old-space-size-percentage`, which sizes old space as a percentage of available memory. That is useful in constrained environments because the runtime can derive a heap size from the memory limit Node observes. The exact usefulness depends on how the operating system and container expose memory constraints. Treat it as startup policy, then confirm the process behavior under the same environment where it will run.

Memory flags also affect failure shape. A lower heap limit can make leaks fail earlier and more predictably. A higher heap limit can delay failure while increasing garbage collection pause cost and memory pressure on the host. Neither setting fixes retention. It only changes the envelope in which retention becomes visible.

Diagnostic startup flags turn on data capture or change failure output.

```bash
node --report-uncaught-exception app.js
node --report-on-fatalerror app.js
node --trace-uncaught app.js
```

Those flags belong to diagnostics. `--report-uncaught-exception` writes a diagnostic report when an uncaught exception reaches the top. `--report-on-fatalerror` writes a report for fatal errors inside the runtime. `--trace-uncaught` prints stack information for uncaught exceptions with extra throw-site context.

The deep report workflow belongs with diagnostics. The startup fact belongs here: a report flag changes what artifact exists when the process fails. A dead process can only produce the artifacts configured before failure.

Diagnostic flags often need companion path flags:

```bash
node --report-dir=./reports --report-filename=crash.json app.js
```

Those paths are evaluated in the process environment. Relative paths resolve from the current working directory, which may differ under a service manager. If reports are part of the production contract, use a directory that exists, has write permission for the service user, and is collected by your log or artifact system. A report flag that writes into a missing or unwritable directory gives you less than the command implies.

Heap and CPU profiling flags sit in the same startup category:

```bash
node --cpu-prof app.js
node --heap-prof app.js
```

Those are recognizable as startup diagnostics. They can create files, add overhead, and produce data that needs separate interpretation. The profiling chapters own that interpretation. In a startup command review, your job is to spot that the process is collecting profile data and ask where the files land, how they rotate, and whether the overhead belongs in that environment.

Some diagnostic flags run continuously. Some trigger on failure. Some trigger on a signal. That difference changes operational risk. A startup command with `--heap-prof` is asking the process to collect heap profile data. A command with `--heapsnapshot-signal=SIGUSR2` is asking the process to react when that signal arrives. The owning chapters will walk through the files. Here, classify the flag by when it activates.

Inspector flags are visible here too:

```bash
node --inspect=127.0.0.1:9229 app.js
```

Inspector flags open a debugging endpoint during startup. Binding that endpoint to a public interface changes the process exposure. Treat it as a runtime configuration decision with a network boundary.

The same review habit applies to permission flags, TLS flags, test flags, and OpenSSL flags. You will see them in real commands. Name the category, then defer the mechanism to its owning chapter. A startup command can mix concerns:

```bash
node --test --enable-source-maps --trace-warnings
```

That command is using the test runner, source-map support, and warning policy at the same time. Separate those layers during review. One command can carry several runtime concerns.

Some flags are platform-limited. Some V8 options exist only on Linux or Windows. Some Node flags are experimental in v24. The command parser can reject unsupported combinations before the entrypoint runs. That early failure is good. It means the process died before half-initialized application code started doing work.

## `node --run` Runs Package Scripts

`node --run` executes a script from `package.json` through Node's built-in package-script runner.

```bash
node --run test
```

Node walks upward from the current directory until it finds a `package.json`, then looks in the `"scripts"` object for `test`. It executes the command from the directory containing that `package.json`. It also prepends matching `node_modules/.bin` directories from the current path upward so local package binaries can resolve.

That directory walk matters in monorepos. Running `node --run test` from `packages/api/src` can select the nearest parent `package.json` that contains the script. The executed command runs from that package directory. A script that assumes `process.cwd()` equals the shell's starting directory can behave differently under `--run`.

Arguments after `--` pass to the script:

```bash
node --run test -- --watch
```

The `--watch` string there belongs to the package script command. Node watch mode has its own flag region. The boundary is the same idea as a normal entrypoint command: Node consumes `--run test`, then `--` separates script-runner arguments from the child command's arguments.

`node --run` is intentionally smaller than package-manager script runners. It runs the named script directly. npm lifecycle scripts such as `pretest` and `posttest` stay in npm's runner. npm-specific environment variables stay in npm's runner too. Node sets Node-specific script metadata such as the script name and package path, then runs the configured command.

That smaller contract is the feature. Node can start the requested script with less package-manager machinery. Compatibility depends on the script's assumptions. If `npm run build` works because `prebuild` generates files, `node --run build` skips that lifecycle script and the build may fail. If a script reads npm-specific environment variables, direct Node execution changes its inputs.

That difference is useful. A fast direct runner is nice for simple package scripts:

```json
{
  "scripts": {
    "lint": "eslint .",
    "test": "node --test"
  }
}
```

```bash
node --run lint
```

If your project relies on npm lifecycle behavior, `node --run` changes the contract. Direct script execution. Node metadata. Local binaries on `PATH`. Use it where the script command has all required setup inside the script itself.

`--run` also interacts with other startup modes. It is a command mode. Watch mode, eval mode, and syntax-check mode have their own expectations. When reviewing a command, parse `node --run name` as package-script execution and treat everything after `--` as arguments to that script.

## Experimental Configuration Files

Node v24 includes an experimental configuration-file surface.

```bash
node --experimental-config-file=node.config.json app.js
```

A Node configuration file is a JSON file that centralizes supported runtime options. It can hold `nodeOptions` and namespace-specific settings for subsystems such as test, watch, and permission. The CLI docs define a schema URL tied to the Node version.

The file is still startup input. Node reads it before the entrypoint runs, validates keys, applies supported values, and fails early for unknown or misplaced keys. Values under `nodeOptions` are limited to options allowed in `NODE_OPTIONS`. Namespace blocks can enable the matching subsystem through configuration. That makes the file more structured than a long environment variable, but it also means the exact schema matters.

The priority is part of the design: command-line options and `NODE_OPTIONS` sit above the configuration file; the configuration file sits above `NODE_OPTIONS` loaded from dotenv files. Unknown keys and unsupported namespace usage fail during parsing.

The precedence rule creates an audit path. A command-line flag is the strongest visible input. `NODE_OPTIONS` from the real environment sits with it. The config file fills in lower-priority structured defaults. Dotenv-provided `NODE_OPTIONS` sits below the config file. The same option can appear in multiple layers, and the highest-priority layer wins.

Long commands make this surface tempting. In Node v24 it is still experimental. Treat it as a visible emerging API. For a production startup contract today, a small shell command or process-manager command with explicit flags is easier to audit than a config file whose stability and namespace behavior can still change.

## Startup Debugging Pass

Startup bugs usually fall into a few mechanical groups.

The first group is misplaced flags. A Node flag after the entrypoint becomes an application argument. A script flag before the entrypoint gets parsed by Node and can fail the process. The fix is the `--` separator or a reordered command.

```bash
node app.js --trace-warnings
```

That command gives `--trace-warnings` to `app.js`. Node warning policy remains unchanged.

```bash
node --trace-warnings app.js
```

That command changes warning policy. Same string. Different region.

The second group is inherited runtime state. `NODE_OPTIONS`, `NODE_NO_WARNINGS`, `NODE_PENDING_DEPRECATION`, and related variables can arrive from the parent process. The visible command looks clean while the effective process starts with extra configuration. Print `process.execArgv`, inspect the environment, and check the wrapper that launches Node.

The third group is preload side effects. A preload can throw, hang, patch a built-in, open a handle, or install a handler before the entrypoint runs. Reproduce with `--eval "0"` and the same preload flags. If the failure appears with that reduced command, the startup hook owns it.

The fourth group is loader selection. `--conditions`, `--input-type`, package `"type"`, file extensions, and preload kind all affect which loader path runs. Keep the ownership straight. `--input-type` shapes eval and stdin. File entrypoints use extension and package metadata. `--require` uses CommonJS. `--import` uses ESM. `--conditions` affects package exports resolution.

The fifth group is output policy. `--no-warnings`, `--redirect-warnings`, deprecation flags, and source-map settings can change what operators see while the underlying runtime condition stays present. A clean log can mean the process is healthy. It can also mean warning output moved or was suppressed.

The sixth group is resource envelope mismatch. V8 heap flags affect V8 heap regions. Total process memory includes more regions. Diagnostic flags create files only where the process can write. Inspector flags open endpoints only where the interface and port bind. Startup configuration crosses into the operating system at those edges.

Guessing adds noise. Classify the flag, find the boundary, identify the layer that supplied it, then check whether that layer is present in the environment where the bug occurs.

## Command Review Pass

A dense command becomes manageable when you classify each part.

```bash
NODE_OPTIONS="--require ./otel.cjs --trace-warnings" \
node --max-old-space-size=2048 --conditions=prod \
  --enable-source-maps ./dist/server.mjs -- --port=8080
```

`NODE_OPTIONS` injects a CommonJS preload and warning traces. The command line sets the V8 old-space limit, adds the `prod` condition for package exports, enables source maps, and picks `./dist/server.mjs` as the entrypoint. `--port=8080` belongs to the application.

The execution order follows from that classification.

```text
parse NODE_OPTIONS
parse command-line runtime flags
configure V8 heap and Node warning/source-map policy
run ./otel.cjs preload
resolve and evaluate ./dist/server.mjs
leave --port=8080 in process.argv
```

Small changes alter behavior. Move `--enable-source-maps` after `./dist/server.mjs`, and Node stops treating it as a runtime flag. Add `--` before `--conditions=prod`, and package resolution never sees the condition. Put another `--require` on the command line, and it runs after the one from `NODE_OPTIONS`. Replace `--require` with `--import`, and CommonJS cache behavior becomes ESM module-map behavior.

That is the habit to keep. Read the command as startup state. The runtime begins before your file, and the flags that matter most are often the ones your application never gets to parse.
