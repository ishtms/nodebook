---
title: "ES Modules import/export"
date: "2026-02-22"
excerpt: "ES Modules in Node.js -- static analysis, the parse-link-evaluate pipeline, and how Node determines module format."
category: "The Module System"
tags: ["nodejs", "modules", "ESM", "import", "export", "static-analysis"]
author: "Ishtmeet Singh @ishtms"
chapter: "modules"
subchapter: "esm-import-export"
published: true
toc: true
---

## How Node Knows It's an ES Module

Every time Node loads a file, it has to make a decision before parsing a single line of code: is this CommonJS or ESM? The answer determines which parser rules apply, which global variables exist, and how the module's exports are structured. Getting this wrong crashes the program.

The determination follows a fixed priority order. And it's a bit more nuanced than you'd expect.

File extension wins first. A `.mjs` file is always ESM. A `.cjs` file is always CJS. No ambiguity, no configuration needed. If a file ends in `.mjs`, Node feeds it to the ES module loader regardless of any `package.json` settings.

For `.js` files, Node walks up the directory tree looking for the nearest `package.json`. If that file contains `"type": "module"`, every `.js` file under that package scope loads as ESM. If it contains `"type": "commonjs"` (or no `type` field at all), those `.js` files load as CJS. The default is CommonJS - that hasn't changed.

```json
{
  "name": "my-app",
  "type": "module"
}
```

That single `"type": "module"` field flips every `.js` file in this package to ESM. Any subdirectory can override this with its own `package.json` containing a different `type` field. Node looks for the *nearest* `package.json`, not the root one.

There's also `-input-type=module` for string input via `-eval` or `STDIN`. And Node v21.1 introduced `-experimental-detect-module` (backported to v20.10), which attempts to auto-detect the module type by looking for `import` and `export` statements. In v22.12+, module detection is enabled by default - Node parses the source, and if it finds static import/export syntax, it treats the file as ESM. But relying on detection rather than explicit configuration is a recipe for subtle bugs. Declare your module type.

## Static Analysis

CJS runs `require()` as a function call. It's a regular JavaScript expression. You can call it inside an `if` block, compute the path with string concatenation, even call it in a loop. The runtime doesn't know what you're going to require until it executes that line of code.

ESM works differently. `import` and `export` are declarations, analyzed at parse time. The engine reads the source text, extracts every `import` and `export` statement, and builds the complete dependency graph *before executing a single line of JavaScript*. The specifier - the string after `from` - must be a literal string. You can't compute it.

```js
// This is valid CJS
const mod = require(condition ? './a.js' : './b.js');

// This is a syntax error in ESM
import something from (condition ? './a.js' : './b.js');
```

The second line fails at parse time. The engine hasn't run any code yet. It hasn't evaluated `condition`. It can't, because parsing happens before evaluation. The specifier must be a static string that the parser can extract just by reading the source.

This constraint is the entire point. Because the engine knows every dependency at parse time, it can build the full module graph, detect cycles, allocate bindings, and optimize before any code runs. CJS modules are a runtime discovery process. ESM modules are a compile-time declaration.

The practical consequence: tools can analyze your import graph without running your code. Bundlers, tree-shakers, type checkers, and linters all exploit this. If you `export function foo()` and nobody imports `foo`, a bundler can prove it's dead code and strip it. That proof is impossible with CJS, because any module could `require()` yours at any point during execution, and the path to that `require()` might be buried in a conditional branch the tool can't evaluate.

Static analysis also catches errors earlier. If you import a name that the target module doesn't export, the engine tells you at link time - before your application logic runs. In CJS, you'd get `undefined` silently and discover the problem much later, probably in production.

## The Three-Phase Loading Pipeline

ESM loading in Node follows a three-phase pipeline: parsing, instantiation, and evaluation. Each phase has a distinct job, and they run sequentially. Understanding the boundary between these phases explains most of ESM's behavior.

### Parsing

Node reads the source text and parses it according to ES module grammar rules. This is where the static analysis happens - the thing that makes ESM fundamentally different from CJS. During this phase, the parser extracts two lists from the module source: all `import` declarations and all `export` declarations. It doesn't execute anything. It doesn't resolve imported values. It just records which names are imported from which specifiers, and which names are exported.

For every `import` statement, Node then resolves the specifier to a URL (more on URL-based resolution later), loads that module's source, and parses it too. This is recursive. If `a.js` imports `b.js` which imports `c.js`, all three are fetched and parsed before anything runs.

The output of Phase 1 is a **module graph** - a directed graph where each node is a parsed module and each edge is an import relationship. Every module in the graph has been fetched and parsed, but none have been executed.

### Instantiation

This is the least intuitive phase, and the one most people skip when learning ESM. With the full graph in hand, the engine walks it and creates the binding infrastructure. For each module, it allocates memory slots for every export that module declares. These slots are initially uninitialized - they hold no value yet.

Then, for every import in the graph, the engine creates a live reference from the importer's imported name to the exporter's export slot. The two become linked. When module A imports `count` from module B, A's `count` identifier is wired directly to B's `count` export slot. They point to the same memory location.

No code has run. No values exist. But the wiring is complete. Every import across the entire graph is now connected to its corresponding export. If a module tries to export a name that the target module doesn't declare, the engine throws a `SyntaxError` here - at link time, before evaluation.

```js
// b.js
export let count = 0;

// a.js
import { count } from './b.js';
```

After instantiation, `a.js`'s `count` and `b.js`'s `count` are the same binding. The same memory slot. The value hasn't been filled yet (that's Phase 3), but the reference is established.

### Evaluation

The wiring is done. Time to actually run code. The engine executes module code, one module at a time, bottom-up through the dependency graph. Leaf modules (those with no imports) run first. Their top-level code executes, and their export bindings get populated with actual values.

Then their dependents run, then their dependents' dependents, and so on. By the time a module's code runs, all the modules it depends on have already been evaluated. Their export slots contain real values.

Top-level `await` (covered in Chapter 1) pauses evaluation of the current module - and everything that depends on it - until the awaited promise resolves. If `b.js` has a top-level `await`, and `a.js` imports from `b.js`, then `a.js` won't start evaluating until `b.js`'s `await` completes.

Each module evaluates exactly once. The result is cached. Subsequent imports of the same module get the cached module namespace - the same binding slots, the same values (or whatever those bindings currently hold, since they're live).

This three-phase separation has a cost that CJS doesn't pay. CJS loads modules one at a time, depth-first, executing each file as it encounters the `require()` call. ESM has to discover the entire graph before running anything. For a deeply nested dependency tree, that means a lot of file reads and parses upfront. But the payoff is correctness guarantees - every binding is validated, every cycle is detected, and every dependency is resolved before your code starts executing. You're trading startup latency for reliability.

## Import Syntax

### Named Imports

The most common form. You import specific named bindings from a module.

```js
import { readFile, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
```

The names inside the braces must match named exports in the target module. If `node:fs/promises` doesn't export something called `readFile`, you'll get a `SyntaxError` at link time. You can rename on import:

```js
import { readFile as read } from 'node:fs/promises';
```

`read` is now a local alias. It references the same binding slot as `readFile` in the exporting module. Renaming doesn't create a new binding or copy the value - it's the same live reference under a different local name.

### Default Imports

```js
import EventEmitter from 'node:events';
```

This imports the binding named `default` from the module. The name `EventEmitter` here is arbitrary - it's a local alias for whatever the module exports as its default. There's nothing special about default exports at the binding level. They're just a named export with the name `"default"`.

### Namespace Imports

```js
import * as fs from 'node:fs/promises';
```

`fs` becomes the module namespace object - a sealed, immutable object whose properties are the module's named exports. You access them as `fs.readFile`, `fs.writeFile`, etc. The namespace object itself is frozen. You can't add properties to it or reassign its properties. But the values those properties reference can change (because live bindings).

### Side-Effect Imports

```js
import './setup.js';
```

No bindings are imported. The module is loaded, instantiated, and evaluated for its side effects only. If it registers event handlers, sets up global state, or modifies the environment, those effects happen. But nothing is bound into the importing module's scope.

This is commonly used for polyfills, instrumentation setup, or configuration modules that modify global state. The module still goes through all three loading phases - it's parsed, its own imports are resolved and linked, and its code runs. You just don't import anything from it into your scope.

### Combining Forms

You can combine a default import with named imports in one statement:

```js
import fs, { readFile, writeFile } from 'node:fs';
```

`fs` is the default export. `readFile` and `writeFile` are named exports. This works because the default is just a named export called `"default"`, and you can import any combination of named exports in one declaration.

## Export Syntax

### Named Exports

You export a binding by prefixing its declaration with `export`:

```js
export const PORT = 3000;
export function startServer() { /* ... */ }
export class Router { /* ... */ }
```

Each of these creates a named export - `PORT`, `startServer`, `Router` - that other modules can import by name. You can also export existing bindings with an export list:

```js
const PORT = 3000;
function startServer() { /* ... */ }
export { PORT, startServer };
```

Same result. Different syntax. You can rename during export:

```js
export { startServer as start };
```

Now the exported name is `start`, even though the local variable is `startServer`.

### Default Export

```js
export default function createApp() { /* ... */ }
```

This exports the function as the `default` binding. Only one default export per module. It's syntactic sugar - `export default expr` is roughly equivalent to `export { expr as default }`, but with some nuances around anonymous expressions. If you write `export default function() {}`, the function's `.name` property is `"default"`. With `export default class {}`, the class name is `"default"`.

A subtle point: `export default` can take any expression. `export default 42` is valid. `export default { foo: 1, bar: 2 }` is valid. The expression is evaluated and the result becomes the value of the `default` binding.

Here's a gotcha. `export default` with an expression doesn't create a live binding in the same way named exports do. If you write `export default count`, the default binding gets the current value of `count` at evaluation time. If `count` later changes, the default export stays at its original value. Named exports (`export { count }`) maintain the live reference. This asymmetry trips people up.

### Re-Exports

You can forward bindings from another module without importing them into the current scope:

```js
export { readFile, writeFile } from 'node:fs/promises';
export { default as EventEmitter } from 'node:events';
```

The first line makes `readFile` and `writeFile` available from this module, but they don't exist as local variables here. They're forwarded directly. The second line takes the default export of `node:events` and re-exports it as a named export called `EventEmitter`.

The wildcard re-export grabs everything:

```js
export * from './utils.js';
```

All named exports from `./utils.js` become named exports of this module. Default exports are explicitly excluded from `export *` - you have to re-export those individually. If two `export *` sources both export the same name, and the consuming module tries to import that name, you'll get an ambiguity error at link time.

Re-exports are the foundation of barrel files - `index.js` files that aggregate and re-export from multiple submodules. They're also how package authors expose a curated public API from a package that internally has many files. The bindings pass through without an intermediate import/export cycle - V8 wires them directly from source to consumer.

## Live Bindings

This is where ESM's behavior diverges sharply from CJS. In CJS, `require()` returns an object. The importing module receives a copy of the exported values at the time `require()` runs. If the exporting module later changes a value, the importer's copy is stale.

ESM bindings are live. The importer doesn't get a copy. It gets a reference to the exporter's binding slot. When the exporter changes the value, the importer sees the change immediately.

```js
// counter.js
export let count = 0;
export function increment() { count++; }
```

```js
// main.js
import { count, increment } from './counter.js';
console.log(count);  // 0
increment();
console.log(count);  // 1
```

`count` in `main.js` isn't a local variable holding the value `0`. It's a live reference to the `count` binding in `counter.js`. When `increment()` mutates `count` inside `counter.js`, the change is visible in `main.js` immediately.

But there's a constraint. The importing module can only read the binding. It can't reassign it. `count = 5` inside `main.js` throws a `TypeError`. Only the module that owns the export can modify it. The binding is live but read-only from the importer's perspective.

This is different from CJS, where you'd get a snapshot:

```js
// CJS equivalent
const { count, increment } = require('./counter.js');
console.log(count);  // 0
increment();
console.log(count);  // still 0 - it's a copy
```

CJS destructured the exports object. `count` became a local variable holding the number `0`. The `increment()` function modified the original `count` inside `counter.js`, but the local copy in this file didn't change.

ESM eliminates this class of bugs entirely by making every import a live reference. You always see the current value. There's no moment where your view of a dependency's state is stale. This matters most for long-lived processes - servers, workers, daemons - where module-level state evolves over the process lifetime.

Live bindings also explain how circular imports survive in ESM. If module A imports from module B and module B imports from module A, both can reference each other's bindings. During instantiation, the binding slots are created and cross-linked before any code runs. During evaluation, one module will execute first and see the other's bindings as `undefined` initially. But as the other module evaluates and fills in its export values, those values become visible through the live references. The bindings aren't snapshots - they update.

There's one more subtlety. Live bindings apply to `let` and `var` exports because those are mutable. A `const` export is still a live binding at the implementation level - the importer's reference points to the exporter's binding slot - but since `const` can't be reassigned after initialization, the value never changes. The binding is live; the value is fixed. If the export is an object declared with `const`, the reference to the object is fixed, but the object's properties can still be mutated. And those mutations are visible through the live binding, because the binding points to the same object in memory.

## The import() Expression

Static `import` declarations handle most use cases. But sometimes you need to load a module conditionally, or load it lazily, or compute the specifier at runtime. `import()` fills this gap.

```js
const mod = await import('./heavy-module.js');
mod.doSomething();
```

`import()` is a function-like expression. It looks like a function call but it's actually a syntax form - an operator. You can't alias it (`const myImport = import` is a syntax error), you can't call `.bind()` on it, and you can't pass it as a callback. It takes a specifier string and returns a Promise that resolves to the module's namespace object. The specifier can be a variable, a computed string, or any expression.

```js
const lang = getUserLanguage();
const i18n = await import(`./locales/${lang}.js`);
```

That's valid. The specifier is computed at runtime. This is the only way to conditionally load modules in ESM, or to defer loading until you actually need the module. Static `import` can't do this.

`import()` works in both ESM and CJS contexts. A CJS file can use `import()` to load ES modules - that's one of the interop bridges between the two systems. The returned namespace object contains all named exports as properties, plus a `default` property for the default export.

One thing to note: `import()` always returns a fresh evaluation if the module hasn't been loaded yet, but returns the cached namespace if it has. It doesn't re-evaluate modules. Once a module is in the module map, all `import()` calls for that specifier return the same cached module namespace.

Because `import()` returns a promise, it integrates naturally with `async/await`. But it also means you're introducing an asynchronous boundary. In CJS, `require()` is synchronous - the module is loaded, compiled, and executed before `require()` returns. `import()` starts that process but defers the result. If you need the module's exports to set up synchronous state, you have to restructure your code around the async gap. This is one reason people still reach for `require()` in certain initialization paths, even in otherwise-ESM codebases.

## URL-Based Module Resolution

ESM in Node uses URLs internally. Every module specifier is resolved to a `file://` URL. This is a departure from CJS, which works with file paths.

```js
import { something } from './utils.js';
// Resolves to: file:///Users/dev/project/utils.js
```

For most practical purposes, this doesn't matter. But the URL-based model has one real consequence: query strings and fragments create separate module instances.

```js
import a from './module.js?v=1';
import b from './module.js?v=2';
// a and b are different module instances
```

`a` and `b` come from separate evaluations of the same source file. The module map keys on the full URL, including query string. This is actually useful for cache-busting during development or testing, but it's also a source of confusion if you import the same file with different URLs accidentally.

Bare specifiers - names without `./`, `../`, or `/` prefix - still go through Node's module resolution, checking `node_modules`. But the resolution produces a `file://` URL, and that URL is what gets cached and compared.

There's also the `data:` URL scheme, which lets you create modules inline:

```js
import { name } from 'data:text/javascript,export const name="inline"';
```

This creates a module from the URL's contents. It's mostly used in testing and edge-case tooling, but it's part of the URL-based model. `node:` URLs for builtins (`import fs from 'node:fs'`) are another special scheme - they bypass filesystem resolution entirely and load from Node's compiled-in module set.

### Mandatory File Extensions

ESM in Node requires explicit file extensions in relative imports.

```js
// Works in CJS
const utils = require('./utils');

// Fails in ESM
import utils from './utils';
// Error: Cannot find module

// Must be explicit
import utils from './utils.js';
```

CJS tries `.js`, `.json`, `.node` automatically. ESM doesn't. You must include the extension. This is by design - it aligns with browser ESM behavior, where URLs always include extensions. The resolution algorithm is simpler and more predictable as a result. No guessing, no probing multiple extensions.

For `node:` built-in modules and bare specifiers resolved from `node_modules`, extensions are handled by the package's `exports` field. But for relative and absolute specifiers, you write the extension yourself.

Directory imports (`import './utils/'` expecting `./utils/index.js`) also don't work in ESM by default. CJS automatically looks for `index.js` inside a directory. ESM requires the full path to the file. You can restore this behavior with the `-experimental-specifier-resolution=node` flag, but that's opting out of spec-compliant resolution. Most projects just write explicit paths.

## How Node Implements ESM

The ESM loader lives in `lib/internal/modules/esm/` inside the Node source tree. It's a layered system with distinct components handling different stages of the pipeline. Understanding these internals explains why ESM behaves differently from CJS and where the performance characteristics come from.

### ESMLoader

The `ESMLoader` class (in `loader.js`) is the orchestrator. It coordinates module loading by dispatching work to specialized hooks: `resolve`, `load`, and `evaluate`. When you write `import { foo } from './bar.js'`, the ESMLoader:

1. Calls the `resolve` hook to turn the specifier `'./bar.js'` into an absolute URL
2. Calls the `load` hook to fetch the source text for that URL and determine its format (module, commonjs, json, wasm, or builtin)
3. Creates or retrieves a `ModuleJob` for the resolved URL

The `ESMLoader` also manages the module map - a `Map<string, ModuleJob>` keyed by resolved URL. Before creating a new `ModuleJob`, it checks the map. If a job already exists for that URL, it returns the existing one. This is the caching mechanism.

Custom loaders registered via `-loader` or the `register()` API hook into this pipeline. They can intercept `resolve` to remap specifiers (useful for import maps, TypeScript path aliases, or mocking) and intercept `load` to transform source code (TypeScript compilation, JSX transformation, etc.). The loaders run in a separate worker thread since Node v20, isolating them from the main thread's module graph.

### ModuleJob

Each module in the graph gets a `ModuleJob` instance (in `module_job.js`). The job manages the lifecycle of a single module through all three phases. It holds a reference to the `ModuleWrap` (the V8 binding for the module), tracks the module's dependencies, and coordinates linking and evaluation.

When you create a `ModuleJob`, it immediately starts resolving the module's dependencies. For each `import` in the source, it asks the `ESMLoader` for the corresponding `ModuleJob` (which may trigger resolution and loading of that dependency). The result is a tree of `ModuleJob` instances mirroring the module graph.

The `job.run()` method drives a module through instantiation and evaluation. It calls `module.instantiate()` on the underlying `ModuleWrap`, which triggers V8's linking phase. Then it calls `module.evaluate()`, which runs the module's code. If the module has a top-level `await`, `evaluate()` returns a promise that resolves when the `await` completes.

### ModuleWrap

`ModuleWrap` (in `lib/internal/vm/module.js` with a C++ counterpart in `src/module_wrap.cc`) is the bridge between Node's JavaScript-side loader and V8's C++ module API. It wraps V8's `v8::Module` object, which is V8's internal representation of an ES module.

When Node creates a `ModuleWrap` from source code, it calls `v8::ScriptCompiler::CompileModule()`. This parses the source into V8's internal AST, extracts the import/export declarations, and creates a `v8::Module` in "uninstantiated" state. The `v8::Module` exposes methods like `GetModuleRequests()` (returns the list of import specifiers), `GetModuleNamespace()` (returns the namespace object), and status tracking.

The instantiation phase calls `v8::Module::InstantiateModule()`. V8 walks the module graph and calls a "resolve callback" for each import - this callback is provided by Node and uses the `ESMLoader`'s resolution logic to find the corresponding `ModuleWrap` for each dependency. V8 then creates the internal binding infrastructure: `Module::Binding` objects for each export, and cross-module references for each import. The allocations happen in V8's heap. The bindings are represented as `Cell` objects in V8's internal type system - mutable containers that can hold any V8 value.

After instantiation, `v8::Module::Evaluate()` runs the module's bytecode. V8 compiles the module source through the same Ignition/Sparkplug/TurboFan pipeline as regular scripts. The difference is how the top-level scope works. Module code runs in strict mode (always), has its own scope (no shared globals between modules), and export bindings are stored in the module's `Cell` slots rather than as properties on an object.

Evaluation returns a `v8::Promise`. For modules without top-level `await`, the promise is already resolved when `Evaluate()` returns. For modules with top-level `await`, the promise stays pending until the awaited operation completes. Node's `ModuleJob` hooks into this promise to know when evaluation finishes.

### The Module Graph and Cycle Detection

V8 handles cycle detection during instantiation. When it encounters a cycle (module A imports B imports C imports A), it doesn't loop infinitely. It marks each module's instantiation status and skips modules that are already being instantiated. The cyclic module's exports will be allocated but uninitialized at that point.

During evaluation, V8 uses a topological sort with Tarjan's strongly connected components algorithm to determine execution order. Modules in a cycle form a strongly connected component and are evaluated together. The first module to evaluate in the cycle will see some of its dependencies' exports as `undefined` (because they haven't been evaluated yet). As evaluation proceeds through the cycle, the live bindings get filled in.

This is why circular imports work in ESM but produce `undefined` for some values at the time of first access. The bindings exist - they were allocated during instantiation. They just haven't been assigned a value yet because the exporting module hasn't finished evaluating. Once it does, the value becomes visible through the live binding.

### SourceTextModule vs SyntheticModule

V8 exposes two module types. `SourceTextModule` represents modules created from JavaScript source code - the standard case. `SyntheticModule` represents modules created programmatically with predefined exports. Node uses `SyntheticModule` for JSON modules (`import data from './config.json'`) and WebAssembly modules. A `SyntheticModule` skips the parsing phase entirely - Node creates it with a known set of export names and directly assigns values during evaluation.

The loader figures out which type to create based on the `load` hook's response. If the format is `"module"`, it creates a `SourceTextModule`. If it's `"json"`, it parses the JSON and creates a `SyntheticModule` with a single `default` export containing the parsed object. This is why JSON modules only have a default export - they're synthetic modules with one binding.

### Worker Thread Isolation for Loaders

Since Node v20, custom loaders run in a dedicated worker thread. The main thread sends `resolve` and `load` requests to the loader thread via an internal MessagePort. The loader thread runs the custom hooks and sends results back. This isolation prevents custom loader code from sharing state with the application, avoids reentrancy issues (a loader calling `import()` during a load hook), and keeps the main thread's module graph consistent.

The communication overhead is real but small. The main thread blocks (using `Atomics.wait()`) while waiting for the loader thread's response. It's a synchronous wait in the resolution path, which means module resolution can't be fully concurrent in the presence of custom loaders. Without custom loaders, the built-in resolve and load logic runs entirely on the main thread with no cross-thread communication.

The loader thread architecture also explains a common frustration: custom loaders can't directly access the application's global state. If your loader needs configuration (say, a TypeScript config file path), it has to receive it through the `register()` API's `data` option, which gets structurally cloned across the thread boundary. Closures, class instances, and functions can't cross. Only serializable data.

### The Module Map and Caching

The module map is the central caching mechanism. It's a `SafeMap` (a Map that's immune to prototype pollution) keyed by the module's resolved URL string. When the ESMLoader encounters an import specifier, it resolves it to a URL and checks the map. A hit means the module is already in some stage of processing - maybe it's still loading, maybe it's fully evaluated. Either way, the existing `ModuleJob` is returned.

This has a subtle consequence for `import()`: if you call `import('./foo.js')` from two different places in your code, the second call gets the same module instance as the first. The module evaluates once. Both callers get the same namespace object with the same live bindings. This is different from `require()` in one way that matters: CJS caches by the resolved file path, and ESM caches by the resolved URL. Since URLs include query strings and fragments, `import('./foo.js')` and `import('./foo.js?bust')` are different cache entries, producing different module instances from the same source file.

## Module Namespace Object

When you do `import * as ns from './module.js'`, `ns` is the module namespace object. Here's what that object actually is.

The namespace object is created by V8 during instantiation. Its properties correspond to the module's named exports. It's sealed - `Object.isSealed(ns)` returns `true`. You can't add, delete, or reconfigure properties. The properties themselves are getter-backed: reading `ns.count` goes through V8's binding infrastructure to read the current value of the `count` export slot. So the namespace object is also live - changes to exports are reflected through it.

```js
import * as counter from './counter.js';
console.log(counter.count);          // 0
counter.increment();
console.log(counter.count);          // 1
console.log(Object.keys(counter));   // ['count', 'increment']
```

The `default` export appears as a property named `"default"` on the namespace object. `counter.default` works, though it's an unusual access pattern.

The namespace object has a `null` prototype - `Object.getPrototypeOf(ns)` returns `null`. It also has a `Symbol.toStringTag` property set to `"Module"`, so `Object.prototype.toString.call(ns)` returns `"[object Module]"`.

## import.meta

Every ES module has access to `import.meta` - an object containing metadata about the current module. In Node, it provides:

```js
console.log(import.meta.url);
// file:///Users/dev/project/src/app.js

console.log(import.meta.filename);
// /Users/dev/project/src/app.js

console.log(import.meta.dirname);
// /Users/dev/project/src
```

`import.meta.url` is the module's fully resolved `file://` URL. `import.meta.filename` and `import.meta.dirname` are the equivalent of CJS's `__filename` and `__dirname`, added in Node v21.2 and backported to v20.11. Before that, you'd convert the URL manually with `fileURLToPath(import.meta.url)`.

There's also `import.meta.resolve()`, which resolves a specifier relative to the current module without actually loading it:

```js
const resolvedPath = import.meta.resolve('./config.json');
// file:///Users/dev/project/src/config.json
```

This is synchronous in Node (it returns a string, not a Promise) and useful for resolving paths without triggering the full load pipeline.

`import.meta.resolve()` goes through the same resolution algorithm as `import` - it checks `package.json` `exports` maps, handles `node:` prefixed builtins, and resolves bare specifiers through `node_modules`. The only difference is that it stops at resolution. It gives you the URL. It doesn't fetch, parse, or evaluate anything.

One more: `import.meta` is module-specific. Each module gets its own `import.meta` object with its own `url`, `filename`, and `dirname`. You can't access another module's `import.meta` from outside. The object is created by V8 during module instantiation and populated by Node through a host-defined callback (`HostInitializeImportMeta` in the spec). Node's implementation sets the URL-based properties at this point, before the module's code runs.

## Strict Mode, Scoping, and Other Differences

ES module code always runs in strict mode. No `"use strict"` directive needed. This means `this` at the top level is `undefined` (not `globalThis`), undeclared variable assignment throws, duplicate parameter names are forbidden, and `with` statements are illegal.

Each module has its own scope. Variables declared at the top level of a module are local to that module. They're invisible to other modules unless explicitly exported. CJS also has module-level scope (via the wrapper function), but ESM's scoping is enforced by the engine at a deeper level - it's part of the module's `Environment Record` in V8's internal representation.

The `arguments` object doesn't exist at the top level of an ES module. Neither does `require`, `module`, `exports`, `__filename`, or `__dirname`. These are CJS-specific variables injected by the module wrapper function (covered in Chapter 1). In ESM, their equivalents come from `import` declarations and `import.meta`.

`typeof` works normally. `eval()` works in strict mode. `new Function()` creates functions in the global scope, not the module scope. These are all consequences of strict mode semantics, applying to any strict-mode code.

One area that catches people: `this` at the module's top level. In CJS, `this` equals `module.exports` (because of the wrapper function). In ESM, `this` is `undefined`. If you're porting code that uses `this` at the top level, it'll break silently. The value just becomes `undefined` and any property access on it throws a `TypeError`.

Another area: `JSON.parse` is your friend for loading JSON data in ESM. CJS could `require('./config.json')` directly, getting the parsed object back. ESM can import JSON files too, but only with an import attribute (stable syntax in modern Node versions):

```js
import config from './config.json' with { type: 'json' };
```

Without the attribute, Node refuses to load it. The attribute tells the loader to create a `SyntheticModule` with the parsed JSON as the default export. If you don't want to use this syntax, `fs.readFileSync` plus `JSON.parse` still works. Or use `createRequire()` from `node:module` to get a CJS `require` function that can load JSON the old way.

## Putting the Pieces Together

The separation into three phases - parsing, instantiation, evaluation - produces behavior that can seem counterintuitive if you're coming from CJS. Here's a sequence that shows all three phases interacting:

```js
// config.js
export const debug = process.env.DEBUG === '1';
export let requestCount = 0;
export function trackRequest() { requestCount++; }
```

```js
// server.js
import { debug, requestCount, trackRequest } from './config.js';
```

During parsing, Node finds that `server.js` depends on `config.js`. Both are parsed. During instantiation, `config.js`'s `debug`, `requestCount`, and `trackRequest` export slots are allocated and wired to `server.js`'s import bindings. During evaluation, `config.js` runs first (it's the dependency). `process.env.DEBUG` is read, `debug` gets its value, `requestCount` is set to `0`, and `trackRequest` is defined.

When `server.js` evaluates, `debug` already has a value. `requestCount` is `0`. If `server.js` calls `trackRequest()`, `requestCount` in both modules reflects the updated value immediately. The live binding means there's no stale copy anywhere in the system.

That's the ES module system in Node. Static declarations give the engine full knowledge of the dependency graph before execution. Three-phase loading separates concerns cleanly. Live bindings eliminate value-copy bugs. And the whole thing is backed by V8's `SourceTextModule` API, with Node's `ESMLoader` and `ModuleJob` classes managing the coordination.
