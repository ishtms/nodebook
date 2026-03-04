---
title: "import.meta, Caching, and Circular Deps"
date: "2026-02-22"
excerpt: "import.meta properties, the ESM module cache, and how circular dependencies resolve in ES Modules."
category: "The Module System"
tags: ["nodejs", "modules", "import-meta", "module-cache", "circular-dependencies"]
author: "Ishtmeet Singh @ishtms"
chapter: "modules"
subchapter: "import-meta-caching"
published: true
toc: true
---

## import.meta

CJS gave you `__filename` and `__dirname` for free, injected by the module wrapper function (covered in Chapter 1). ESM has no wrapper function. No magic variables baked in at load time. The module's location information lives on a different object entirely: `import.meta`.

`import.meta` is a host-provided object. The ECMAScript spec defines the syntax - `import.meta` as an expression - but says almost nothing about what properties it should have. That's left to the host environment. In browsers, `import.meta.url` is pretty much all you get. Node fills in more properties, and the set has grown over the past few major releases.

The object itself is created lazily. V8 allocates it the first time your code accesses `import.meta` in a given module. If you never touch it, V8 never calls into Node's initialization callback for it. Each module gets its own distinct `import.meta` object - they don't share one across the module graph.

### import.meta.url

Every ES module gets `import.meta.url` set to a `file://` URL pointing to the module's source file on disk.

```js
console.log(import.meta.url);
// file:///home/app/src/index.mjs
```

The URL scheme matters. It's `file://` with a leading slash on the authority component, which means three slashes total on Unix (`file:///home/...`). On Windows, you'll see something like `file:///C:/Users/app/src/index.mjs`. The path component uses forward slashes regardless of platform. And special characters in directory names get percent-encoded - a space becomes `%20`, a hash becomes `%23`.

One immediate practical use: building relative paths. Because `import.meta.url` is a proper URL string, you can feed it into the `URL` constructor as a base.

```js
const dataUrl = new URL('./data.json', import.meta.url);
console.log(dataUrl.pathname);
// /home/app/src/data.json
```

The `URL` constructor handles the relative resolution according to the URL specification. You get back a URL object, and `.pathname` gives you the path component. But be careful - `.pathname` is still URL-encoded. A file at `/home/my app/data.json` gives you `/home/my%20app/data.json` as the pathname. For a proper OS-native path string (decoded, with backslashes on Windows), you want `url.fileURLToPath()` from the `node:url` module.

Before Node added `import.meta.filename` and `import.meta.dirname`, this `new URL` + `fileURLToPath` pattern was the only way to get the equivalent of `__filename` and `__dirname` in ESM. You'd see it everywhere in codebases that adopted ESM early:

```js
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
```

Six lines to get what CJS gives you for free. Tedious. And easy to mess up - people would forget the `fileURLToPath` step, pass a `file://` URL directly to `fs.readFileSync`, and get confused when it worked on Linux but not on Windows (where the drive letter threw things off).

### import.meta.filename and import.meta.dirname

Node v21.2.0 introduced `import.meta.filename` and `import.meta.dirname`. Both are stable in Node v24. They do exactly what you'd expect.

```js
console.log(import.meta.filename);
// /home/app/src/index.mjs

console.log(import.meta.dirname);
// /home/app/src
```

These are regular filesystem paths. No URL encoding, no `file://` prefix, just the absolute path string the OS understands. `import.meta.filename` returns the same thing as `fileURLToPath(import.meta.url)`. And `import.meta.dirname` is equivalent to `dirname(import.meta.filename)`. The old six-line pattern is obsolete.

One subtlety: these properties only exist when the module was loaded from a `file://` URL. If you somehow load a module over `https://` (Node's experimental network imports) or from `data:` URLs, `import.meta.filename` and `import.meta.dirname` are both `undefined`. The `import.meta.url` property still works in those cases - it just won't have a `file://` scheme. In practice, for code running from disk (which is basically all production Node code), this edge case doesn't matter.

Another subtlety: `import.meta.filename` follows symlinks. If your file at `/home/app/lib/index.mjs` is actually a symlink to `/home/shared/lib/index.mjs`, `import.meta.filename` gives you the original symlink path, the one that was used to load the module. It preserves the path the loader actually resolved, which may or may not be the realpath. The behavior here can vary depending on whether `-preserve-symlinks` is set.

### import.meta.resolve()

`import.meta.resolve()` takes a module specifier and returns a fully resolved URL string, using the current module's context for resolution.

```js
const resolved = import.meta.resolve('lodash');
console.log(resolved);
// file:///home/app/node_modules/lodash/lodash.js
```

The returned value is always a URL string, formatted with the `file://` scheme for local packages. For a bare specifier like `'lodash'`, it walks the resolution algorithm - checking `node_modules`, the `exports` map in `package.json`, conditions, subpath patterns, the whole thing. For relative paths like `'./utils.js'`, it resolves against the current module's URL. For built-in modules, it returns a `node:` URL: `import.meta.resolve('fs')` returns `'node:fs'`.

`import.meta.resolve()` is synchronous in Node v24. The spec originally left the door open for it to return a Promise (and it briefly did behind a flag in earlier Node versions), but the synchronous behavior landed as the stable default. It resolves the path. It does not load the module. It does not evaluate any code. You get the URL string back and do whatever you want with it.

This is the ESM equivalent of `require.resolve()` from CJS. The use cases are identical: figuring out where a package lives on disk, checking if a module exists (it throws `ERR_MODULE_NOT_FOUND` if resolution fails), building paths relative to a dependency's location, or passing the resolved path to some other API.

```js
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const schemaUrl = import.meta.resolve('my-lib/schema.json');
const schema = readFileSync(fileURLToPath(schemaUrl), 'utf8');
```

You resolve the specifier to a URL, convert it to a filesystem path, then read it. The module `my-lib` was never imported - you just used its resolution context to locate a file it ships.

One thing that trips people up: `import.meta.resolve()` uses the `exports` field of the target package's `package.json`. If the package doesn't export `schema.json` in its `exports` map, resolution fails even though the file exists on disk. The resolver respects encapsulation. `require.resolve()` in CJS bypasses `exports` encapsulation in most cases, so code migrated from CJS to ESM can hit unexpected resolution failures here.

### How import.meta Gets Populated

V8 doesn't know anything about file paths or Node's module system. When V8 encounters `import.meta` in a module's source during evaluation, it calls a host-defined hook. Node registers this hook during bootstrap - specifically the `importMetaInitializeCallback`.

The callback receives two arguments: the `import.meta` object (an empty object that V8 just created) and the module's internal `Module` record. Node's C++ layer looks up the module's URL from the `ModuleWrap` binding - the C++ class that backs each ES module in Node, wrapping V8's `v8::Module` - and populates the properties:

- `url` gets set to the module's URL string as stored in the `ModuleWrap`.
- `filename` gets computed by running `fileURLToPath()` on the URL. If the scheme isn't `file://`, this stays `undefined`.
- `dirname` gets computed by running `dirname()` on the filename. Same caveat applies.
- `resolve` gets a function bound to the current module's URL. The function calls into Node's `ESMLoader.resolve()` with the module's URL as the parent, so specifiers resolve relative to the correct location.

The population happens lazily - V8 triggers the callback the first time your code actually accesses `import.meta` in a given module. If you define a module that exports functions but never references `import.meta`, the callback never fires for that module. This is a small optimization, but it adds up across large dependency trees where most modules don't need their own location info.

The implementation lives in `lib/internal/modules/esm/initialize_import_meta.js` in the Node source (as of v24). The C++ side is in `ModuleWrap::InitializeImportMeta` in `src/module_wrap.cc`. The file is surprisingly small - maybe 30 lines of JavaScript. Most of the complexity is in the C++ bridge that connects V8's module hooks to Node's JavaScript layer.


## Module Caching

Both CJS and ESM cache loaded modules. Once a module has been loaded and evaluated, subsequent requests for the same module return the cached result without re-reading or re-executing the source. A project with 500 files might `require` or `import` some utility module from 200 different places. The file gets read once, executed once, and every consumer gets the same result.

The mechanics of *how* each system caches - the data structures, the cache keys, what you can do about stale entries - diverge substantially.

### Module._cache

When you call `require('./foo')`, Node resolves the path to an absolute filename (say, `/home/app/foo.js`), then checks `Module._cache['/home/app/foo.js']`. If there's a hit, Node returns the cached `module.exports` object immediately. No file read. No compilation. No evaluation.

`Module._cache` is a plain JavaScript object. The keys are fully resolved absolute filesystem paths. The values are `Module` instances - the same objects with `.exports`, `.id`, `.filename`, `.loaded`, `.children`, and `.paths` properties.

`require.cache` is the same object. They're literally the same reference:

```js
console.log(require.cache === Module._cache);
// true (when Module is require('module'))
```

You can iterate over `require.cache` to see every CJS module currently loaded in the process. The keys tell you every file path that's been `require()`d. In a medium-sized Express app, there might be thousands of entries.

And because it's a plain object, you can inspect it, iterate over it, and - here's the part people actually care about - delete entries from it.

```js
delete require.cache[require.resolve('./myModule')];
```

After that deletion, the next `require('./myModule')` re-reads the file from disk, re-compiles it, re-evaluates it, and inserts a fresh entry into the cache. Hot reloading in development mode works exactly like this. Tools like `nodemon` or `chokidar`-based dev servers watch for file changes, delete the relevant cache entries, and re-require the changed modules.

But there's a catch. Deleting a cache entry doesn't retroactively update anything. If another module already grabbed a reference to the old `module.exports` object, that reference still points to the old version. You've evicted the cache entry, but every `const foo = require('./foo')` statement that already ran still has its local `foo` pointing at the stale exports. The old closures survive. The old state persists.

Cache invalidation in CJS is partial at best. The new `require()` call gets fresh exports, but existing references are orphaned copies. For a proper hot reload, you'd need to re-require every module in the dependency chain - starting from the changed module and working up to the entry point. Some hot-reload libraries do this (they track the dependency graph and invalidate transitively), but it's messy and error-prone.

There's another subtlety: the `module.children` array. When module A requires module B, B gets pushed into A's `children` array. Deleting B from `require.cache` doesn't remove it from A's `children`. If you're trying to clean up thoroughly (say, for a testing framework that needs module isolation between tests), you need to walk the `children` arrays too.

### CJS Cache Keys and Symlinks

The cache key is the resolved filename - the real, absolute path after following symlinks via `fs.realpathSync()`. If `/home/app/node_modules/foo` is a symlink to `/home/shared/foo`, the cache key is `/home/shared/foo/index.js`, the resolved target. Two different `require()` calls from two different symlink paths will hit the same cache entry as long as they resolve to the same physical file.

There's a `realpathSync` cache too - `Module._realpathCache` - because calling the OS to resolve symlinks on every `require()` would be too slow. The realpath result gets cached so subsequent resolutions skip the syscall.

You can override this behavior with the `-preserve-symlinks` flag. When set, Node uses the symlink path itself as the cache key, rather than the resolved target. This changes deduplication behavior: the same physical file required through two different symlink paths produces two separate cache entries. Monorepos with workspace symlinks sometimes need this flag, though it can cause its own headaches with duplicate module instances.

### The Module Map

ESM caching works differently. The cache is internal to the ESM loader - there's no userland `import.cache` object you can poke at. No public API. The module map lives inside `lib/internal/modules/esm/module_map.js` and is an instance of `SafeMap`, which is a `Map` variant hardened against prototype pollution attacks.

The cache is keyed by URL string. When you write `import './foo.js'`, Node resolves the specifier to a URL like `file:///home/app/foo.js` and looks it up in the module map. If the entry exists, you get the same module instance back.

Because the key is a URL, query strings and fragments create distinct cache entries:

```js
import './foo.js';        // cached as file:///home/app/foo.js
import './foo.js?v=1';    // cached as file:///home/app/foo.js?v=1
import './foo.js?v=2';    // cached as file:///home/app/foo.js?v=2
```

All three load the same file on disk, but each gets its own module instance with its own evaluation. The `?v=1` and `?v=2` query strings are part of the URL, so they produce different cache keys. You can abuse this for cache busting during development - change the query string, get a fresh module evaluation. But it's hacky. Each "busted" entry stays in memory for the process lifetime. Do it in a loop and you'll leak modules.

There's no API to clear the ESM module map. You can't delete entries. Once a module is loaded, it stays loaded until the process exits. The design is intentional, and the reasons are technical - V8's internal `Module` records go through an irreversible state machine. A module that has reached the "evaluated" state can't be rewound to "uninstantiated." Removing it from the map would leave other modules holding live binding references to deallocated slots.

### Singletons Through Caching

Because both CJS and ESM cache modules, any module-level state acts as a process-wide singleton. There's one evaluation, one set of variables, shared across every importer.

```js
// counter.mjs
let count = 0;
export function increment() { count++; }
export function getCount() { return count; }
```

Every file that imports `counter.mjs` gets the same live bindings. Calling `increment()` from anywhere modifies the same `count` variable. There's one module instance, one scope, one `count`.

In CJS, the same pattern works through the shared `module.exports` object:

```js
// counter.js
let count = 0;
module.exports = {
  increment() { count++; },
  getCount() { return count; },
};
```

The first `require('./counter')` evaluates the module and caches the exports. Every subsequent `require('./counter')` returns the same object. The closure over `count` is shared. Same singleton behavior.

You don't need a special singleton class or pattern. Module caching handles it. As long as every consumer resolves to the same cache entry, they share one instance.

The gotcha: if two consumers resolve to *different* cache entries, they get separate module instances with separate state. A package installed in two different `node_modules` directories - say, once in the project root and again in a nested dependency's own `node_modules` - produces two cache entries, two evaluations, two singletons that don't share state. Duplicate package issues in monorepos almost always trace back to this. Your logging library has two instances, your database pool gets created twice, your configuration object exists in two copies with potentially different values. Tools like `npm ls <package>` can help you spot the duplication.


## V8 Module States and Cache Internals

The ESM module map in Node lives in `lib/internal/modules/esm/module_map.js`. It's a `SafeMap` keyed by the resolved URL string. The values are `ModuleJob` instances - objects that track a module through its entire lifecycle, from fetching source text to final evaluation.

Each `ModuleJob` wraps a `ModuleWrap`, the C++ binding class that sits between Node's JavaScript layer and V8's native `v8::Module`. V8's internal `Module` class has a status field that progresses through a strict sequence of states. Understanding these states explains a lot about why ESM caching is immutable and why circular deps behave the way they do.

**Uninstantiated.** The source has been parsed and the module record created. V8 knows what the module's imports and exports look like from static analysis of the `import` and `export` statements. But the memory slots for those bindings haven't been allocated yet. The module exists as metadata, not as a living thing with values.

**Instantiating.** The engine is allocating binding slots and linking them across the module graph. V8 walks the graph depth-first, calling back into Node's resolve hook for each import specifier it encounters. For each import, it finds the target module, locates the matching export, and wires the import slot to the export slot - a direct memory-level connection. The import doesn't get a copy. It gets a reference to the exporter's binding.

Cycle detection happens during this phase. If V8 encounters a module that's already in the "instantiating" state while walking the graph, it knows there's a circular reference. It doesn't abort. It records the binding as existing but potentially uninitialized at evaluation time. The instantiation still succeeds - the binding slot is linked, but V8 marks it as possibly in TDZ.

**Instantiated.** All bindings are linked. Every import in the entire module graph points to a specific export slot in some other module. The binding slots exist in memory but hold no values - they're in TDZ state. No module code has run yet.

**Evaluating.** V8 is executing the module's top-level code. As assignments to exported `let`, `const`, or `var` declarations execute, the corresponding binding slots get filled with values. Other modules that imported those bindings can observe the values through their linked references - that's live binding behavior in action. But if a dependent module's code runs before the exporting module assigns a value (which happens in circular deps), accessing the binding throws `ReferenceError` because the slot is still in TDZ.

**Evaluated.** Execution completed successfully. All exported bindings have their values (at least the values they had when top-level execution finished). Bindings exported as `let` or mutable objects can still change after this point - and importers will see the changes because the bindings are live. The module status is permanent. V8 provides no mechanism to revert it.

**Errored.** Evaluation threw an exception. The error object is cached on the module record itself. Any future attempt to access this module - even from a different part of the code - re-throws the same error. There's no retry mechanism. The module is permanently broken for the lifetime of the process. If you fix the source file and want to try again, you need to restart the process (or, in development, use query-string cache busting with dynamic `import()` to load the fixed file as a different URL).

Now, CJS caching. The internals are simpler but have a timing detail that makes circular dependencies behave uniquely. When `Module._load()` runs for a fresh module:

1. It creates a new `Module` object with `module.exports` set to an empty object `{}`.
2. It inserts that `Module` into `Module._cache[filename]` - before any evaluation happens.
3. It compiles the source (wrapping it in the module wrapper function).
4. It evaluates the compiled function, which populates `module.exports` as the code runs.

Step 2 happens before step 4. The module goes into the cache with an empty `{}` as its exports *before* its code even starts running. If the module's code calls `require()` on another module that circles back and `require()`s the first module, that circular `require()` finds the partially-populated cache entry and returns whatever `module.exports` looks like at that exact moment. It doesn't wait for evaluation to finish. It doesn't block. It grabs the half-finished exports object and continues execution.

The ESM loader takes a fundamentally different approach. The `ModuleMap` receives entries early (the `ModuleJob` is created during the fetch/parse phase), but the binding slots are genuinely uninitialized until evaluation progresses past the declaration. There's no "empty object" placeholder to return. There are binding slots in TDZ. Accessing them before the assignment executes throws a `ReferenceError`. The failure mode is explicit and immediate rather than silent and data-dependent.

ESM cache invalidation is deliberately impossible because of V8's module state machine. Once a `Module` record reaches the "evaluated" state, V8 provides no API to reset it to "uninstantiated." The binding slots are actual memory addresses that other modules hold direct references to - they were wired together during instantiation. Removing the module from Node's map wouldn't unwire those references. It would just prevent future lookups from finding the module, while leaving a zombie of live bindings still attached to every module that imported from it.

The CJS cache, by contrast, is a JavaScript object. `delete require.cache[key]` is a property deletion on a regular `Object`. The old `Module` instance remains in memory as long as anything references it, but the next `require()` won't find it and will create a fresh one. Crude. Effective enough for development hot-reload workflows. Insufficient for anything more sophisticated.


## Circular Dependencies

Two modules that import each other create a circular dependency. Both CJS and ESM handle cycles without crashing the process. But the behaviors are different enough that the same logical structure can work in one system and throw in the other.

### Partial Exports in CJS

Here's the classic CJS cycle. Two files, `a.js` and `b.js`, each requiring the other.

```js
// a.js
module.exports.x = 1;
const b = require('./b');
module.exports.y = 2;
console.log('a sees b:', b);
```

```js
// b.js
const a = require('./a');
module.exports.value = 42;
console.log('b sees a:', a);
```

Run `node a.js`. The execution sequence matters here, and understanding it requires knowing the cache-before-evaluation behavior described in the previous section.

Node starts loading `a.js`. It creates a `Module` object, sets `module.exports` to `{}`, inserts it into `Module._cache`, and begins evaluating. First line: `module.exports.x = 1`. The cached exports object is now `{ x: 1 }`.

Next line: `const b = require('./b')`. Node starts loading `b.js`. Creates a new `Module`, caches it, begins evaluating. First line of `b.js`: `const a = require('./a')`. Node checks the cache, finds `a.js` already present, and returns its current `module.exports`: `{ x: 1 }`. Just `{ x: 1 }`. The `y: 2` assignment hasn't happened yet. `a.js` is suspended at its `require('./b')` call, halfway through its own evaluation.

`b.js` continues. Sets `module.exports.value = 42`. Logs `b sees a: { x: 1 }`. Returns. Control goes back to `a.js`, which resumes after `require('./b')`, sets `module.exports.y = 2`, and logs `a sees b: { value: 42 }`.

The output:

```
b sees a: { x: 1 }
a sees b: { value: 42 }
```

`b.js` saw a partial snapshot of `a.js`'s exports - only the properties assigned before the circular `require()` call. The `y` property is invisible to `b.js` at the time it accessed `a`.

But here's a nuance. `b.js` has a reference to the actual `module.exports` object from `a.js`. Same object in memory. If `b.js` defers its access - say, in a function called later - it sees the full picture:

```js
// b.js (deferred access)
const a = require('./a');
module.exports.value = 42;
module.exports.getA = () => a;
```

Calling `b.getA()` after `a.js` finishes evaluation returns `{ x: 1, y: 2 }`, because the local variable `a` in `b.js` points to the same object that `a.js` mutated. The object reference stays the same. Properties added later show up through the reference. Only the timing of when you read the properties matters.

The dangerous case: if `a.js` replaces `module.exports` entirely instead of adding properties to it. A full reassignment like `module.exports = { x: 1, y: 2 }` near the end of `a.js` creates a new object. The cache entry updates to point to the new object. But `b.js`'s local `a` variable captured the old object - the one from step 1, the empty `{}` that got `x` added to it. The reassignment orphans `b.js`'s reference. This is one reason the community convention prefers adding properties to `module.exports` over reassigning it entirely, especially in modules that might be involved in cycles.

### Live Bindings and TDZ in ESM

ESM handles cycles through live bindings. Instead of receiving a snapshot of an exports object, each `import` gets a reference to a binding slot in the exporter's module scope. The slot's value can change. But the slot might also be uninitialized when you try to read it.

```js
// a.mjs
import { value } from './b.mjs';
export const x = 1;
console.log('a sees value:', value);
```

```js
// b.mjs
import { x } from './a.mjs';
export const value = 42;
console.log('b sees x:', x);
```

The ESM loader first parses both files (phase 1). It discovers the full dependency graph and identifies the cycle. Then it instantiates both modules (phase 2), allocating binding slots and wiring imports to exports. `x` in `b.mjs`'s scope links to the `x` export slot of `a.mjs`. `value` in `a.mjs`'s scope links to the `value` export slot of `b.mjs`.

During evaluation (phase 3), the loader has to pick a module to start with. In a cycle, there's no valid ordering where both modules are fully evaluated before the other needs their exports. The loader picks based on the dependency graph traversal. Say it starts evaluating `a.mjs`.

`a.mjs` runs. It hits `console.log('a sees value:', value)`. The `value` binding points to `b.mjs`'s export slot. But `b.mjs` hasn't been evaluated yet. The `export const value = 42` line in `b.mjs` hasn't executed. The binding is in TDZ. Accessing it throws:

```
ReferenceError: Cannot access 'value' before initialization
```

The key difference from CJS: CJS gives you an object - possibly half-populated, but an actual value you can hold. ESM gives you a binding that may or may not be initialized. There's no "partial exports" concept. Either the binding has been assigned a value by the exporting module's code, or it's TDZ. Binary.

But live bindings also mean that once the value *is* assigned, everyone sees it immediately. No stale copies. No orphaned references. If you restructure the code so the evaluation order works, the circular dep is fine:

```js
// c.mjs
export let count = 0;
import { logCount } from './d.mjs';
count = 10;
logCount();
```

```js
// d.mjs
import { count } from './c.mjs';
export function logCount() {
  console.log('count is:', count);
}
```

When `c.mjs` calls `logCount()`, `d.mjs`'s function reads `count` - the live binding from `c.mjs`. By the time the function body executes, `count` has been assigned to `10`. The function sees `10`. Live bindings let you read the current value at call time, not at import time.

Function exports are a common workaround for circular deps in ESM. The function declaration is hoisted - the binding slot is filled during instantiation, before evaluation starts. The function's *body* doesn't execute until called. By the time someone calls it, the bindings it references inside its body have usually been initialized. If `d.mjs` exported a `const` that tried to read `count` during its initialization (like `export const snapshot = count`), it would either get `0` or hit TDZ depending on evaluation order. But wrapping the access in a function defers it past the danger zone.

### Detecting and Breaking Cycles

Circular dependencies are usually a symptom of tangled responsibilities between modules. Two modules that each need something from the other often share a concern that should be extracted into a third module. A few practical approaches for dealing with them.

**Detection.** The most direct signal is a `ReferenceError` at startup in ESM code. In CJS, cycles are silent - you just get partial exports, and the bug manifests later as `undefined` properties or missing functions. Third-party tools like `madge` can parse your import/require statements and report cycles in the dependency graph. `dpdm` does the same for TypeScript projects. Running `madge -circular src/` gives you a list of every cycle.

**Extract shared logic.** If `a.js` and `b.js` both need some function from each other, pull that function into a `shared.js` and have both import from `shared.js`. The cycle breaks. The shared module has no reason to import back from either `a.js` or `b.js`, so the graph becomes acyclic.

**Dependency inversion.** Instead of module A importing module B directly for some operation, have module A accept a callback or interface that module B provides at runtime. The static `import` or `require` disappears. The coupling still exists at the behavioral level, but the module graph is acyclic.

**Lazy requires (CJS).** Move the `require()` inside a function so it runs at call time instead of load time:

```js
// a.js
module.exports.x = 1;
module.exports.getB = () => require('./b');
```

The `require('./b')` doesn't execute during `a.js`'s initial evaluation. It fires when someone calls `getB()`, at which point `b.js` has fully loaded and is sitting in the cache with all its exports populated.

**Dynamic import (ESM).** The `import()` expression is the ESM equivalent of lazy loading. It returns a promise that resolves to the module namespace object:

```js
// a.mjs
export const x = 1;
export async function getB() {
  const b = await import('./b.mjs');
  return b.value;
}
```

The dynamic `import()` runs at call time. The static module graph (what the loader sees during parsing and instantiation) contains no cycle. The runtime dependency still exists, but the loader handles it without TDZ issues because by the time `getB()` is called, `b.mjs` has already been loaded and evaluated through some other import path, or it gets loaded fresh at that point with no cycle in the static graph.

Cycles are technically valid. Both module systems support them. But code that silently depends on evaluation order is fragile. A refactor that changes file loading order - renaming a file, restructuring imports, adding a new entry point - can shift the evaluation sequence and break things in ways that are hard to trace. Restructuring the dependency graph to eliminate cycles is almost always the better long-term investment.
