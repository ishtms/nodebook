---
title: "CJS require() Internals"
date: "2026-02-22"
excerpt: "How require() works internally -- the Module._load chain, source wrapping, compilation, and the module cache."
category: "The Module System"
tags: ["nodejs", "modules", "require", "CommonJS", "module-cache"]
author: "Ishtmeet Singh @ishtms"
chapter: "modules"
subchapter: "cjs-require"
published: true
toc: true
---

Every Node.js developer has typed `require('something')` thousands of times. The function returns an object. You use that object. Done. But there's a full call chain behind that single line - a chain involving filename resolution, file reading, source wrapping, compilation, and caching - all happening synchronously, all blocking the main thread until the module is fully evaluated and its exports are sitting in memory.

This chapter walks through that entire chain, from the moment JavaScript calls `require()` to the moment you get back a populated `module.exports`. And it goes deep - into Node's internal `Module` class, the compilation pipeline, the caching layer, and the edge cases around circular dependencies that have confused just about everyone at least once.

## The require() Function

When you type `require('fs')` or `require('./myFile')`, you're calling a function that was injected into your module's scope by the module wrapper (covered in Chapter 1). But `require` isn't a global. It's a local variable, created specifically for your module, and it points to a function that eventually calls `Module._load`.

Here's the short version of what happens:

```js
require(id)
  -> Module._load(id, parentModule, isMain)
    -> Module._resolveFilename(id, parentModule)
    -> check Module._cache[resolvedFilename]
    -> if cached: return cached.exports
    -> new Module(resolvedFilename)
    -> Module._cache[resolvedFilename] = module
    -> module.load(resolvedFilename)
    -> return module.exports
```

That pseudocode is pretty close to the real thing. The `require` function your module receives is actually `Module.prototype.require`, which is a thin wrapper. It validates the argument is a string, then calls `Module._load` with the module's own `this` as the parent.

```js
Module.prototype.require = function(id) {
  validateString(id, 'id');
  requireDepth++;
  try {
    return Module._load(id, this, false);
  } finally {
    requireDepth-;
  }
};
```

That `requireDepth` counter tracks how deep the current require chain goes. It's mainly used for internal debugging and circular dependency detection logging. The third argument - `false` - tells `_load` that this module is being loaded as a dependency, not as the main entry point.

Notice the `try/finally` block. The `requireDepth` counter decrements regardless of whether the load succeeds or throws. This matters because a failed `require()` (say, a syntax error in the target file) should still clean up the depth tracking. Without `finally`, a thrown error during loading would leave `requireDepth` permanently inflated, and any internal logic that checks it would behave incorrectly for the rest of the process's lifetime.

## Module._resolveFilename

Before anything can be loaded, Node needs to figure out which file you're talking about. `require('./utils')` could mean `./utils.js`, `./utils.json`, `./utils.node`, or `./utils/index.js`. A bare specifier like `require('express')` triggers the `node_modules` lookup algorithm. That full resolution algorithm is its own deep topic (the next subchapter covers it exhaustively), but here's the high-level behavior of `Module._resolveFilename`.

The method receives the request string and the parent module. It first checks if the specifier matches a built-in module. Node maintains an internal list of built-in module names - `fs`, `path`, `http`, `net`, and so on. If the specifier matches a built-in, `_resolveFilename` returns the prefixed name (like `node:fs`) and the loading path skips file system access entirely. Built-in modules are compiled into the Node binary itself; they never touch disk during resolution.

```js
if (NativeModule.canBeRequiredByUsers(request)) {
  return request;
}
```

That early return skips all the filesystem work. For the dozens of `require('fs')` and `require('path')` calls scattered across a typical application, this shortcut matters. Node keeps a `Set` of all built-in module names and checks membership in O(1). In v24, you can also use the `node:` prefix explicitly - `require('node:fs')` - and that prefix forces the built-in path. Without the prefix, Node checks built-ins first but still falls through to the filesystem if the name doesn't match. With the prefix, there's no fallback.

For non-built-in specifiers, `_resolveFilename` calls `Module._resolveLookupPaths` to build a list of directories to search. For relative paths (`./` or `../`), this list contains only the parent module's directory. For bare specifiers, it builds a chain of `node_modules` directories, walking up from the parent module's location to the filesystem root.

Then `Module._findPath` iterates through that directory list, trying each possible filename extension (`.js`, `.json`, `.node`) and checking for `index.*` files inside directories. The first hit wins. `_findPath` also has its own internal cache - `Module._pathCache` - that maps `(request, paths)` tuples to resolved filenames. This cache prevents repeated filesystem `stat` calls when the same module is resolved multiple times from different parents.

```js
const cacheKey = request + '\x00' + paths.join('\x00');
const entry = Module._pathCache[cacheKey];
if (entry) return entry;
```

That `\x00` null byte separator prevents collisions between different `(request, paths)` combinations. Smart. And cheap - just a string concatenation and an object property lookup.

If nothing matches after exhausting all paths, all extensions, and all directory index checks, you get the familiar `MODULE_NOT_FOUND` error. The error message includes the full list of paths that were searched, which is genuinely useful for debugging. Many developers have solved "can't find module" issues just by reading that path list carefully.

## Module._load - The Heart of require()

`Module._load` is where everything comes together. It's the coordinator. Here's what it does, step by step:

**Step 1: Resolve the filename.** It calls `Module._resolveFilename` to get the absolute path. At this point, `./utils` becomes something like `/home/user/project/utils.js`.

**Step 2: Check the cache.** `Module._cache` is a plain JavaScript object keyed by absolute filename. If the resolved path already exists as a key in `_cache`, the method returns `Module._cache[filename].exports` immediately. No file I/O. No compilation. Just a property lookup on an object.

```js
const cachedModule = Module._cache[filename];
if (cachedModule !== undefined) {
  updateChildren(parent, cachedModule, true);
  if (cachedModule.loaded) return cachedModule.exports;
}
```

That `cachedModule.loaded` check handles an edge case around circular dependencies. I'll come back to that.

**Step 3: Check for built-in modules.** If the resolved name is a built-in, Node loads it through `loadBuiltinModule` rather than reading from disk. Built-in modules have their own cache, separate from `Module._cache`.

**Step 4: Create a new Module instance.** If no cache hit and it's not a built-in, `_load` creates a `new Module(filename, parent)`. The Module constructor sets up a fresh object with properties like `id` (the filename), `exports` (initially an empty object `{}`), `parent`, `filename`, `loaded` (initially `false`), `children` (an empty array), and `paths` (the `node_modules` search list).

**Step 5: Cache immediately.** Before loading the file - before reading a single byte - Node sticks the module into `Module._cache`. This is how circular dependencies don't crash the process. If module A requires module B, and module B requires module A, the second `require('A')` finds A in the cache and returns A's `module.exports` as-is at that moment. A's exports might be incomplete (since A hasn't finished evaluating yet), but at least you get an object reference rather than an infinite loop. More on this soon.

**Step 6: Load.** `module.load(filename)` is called. This reads the file, wraps it, compiles it, and runs it. If the load throws an error - a syntax error, a runtime exception during evaluation, or a nested `require()` failure - Node removes the module from `Module._cache` before the error propagates. This cleanup prevents a broken module from being permanently cached. On the next `require()` attempt, Node tries loading from scratch.

```js
let threw = true;
try {
  module.load(filename);
  threw = false;
} finally {
  if (threw) delete Module._cache[filename];
}
```

That `try/finally` pattern with the `threw` boolean is a common Node internals idiom. You can't use `catch` here because the error needs to propagate to the caller - you just want the side effect (cache cleanup) before it does.

**Step 7: Return exports.** After `module.load` finishes, `module.loaded` is set to `true`, and `_load` returns `module.exports`.

## Module.prototype.load

The `load` method on a Module instance figures out how to handle the file based on its extension. Node maintains a registry of extension handlers in `Module._extensions`, and `load` looks up the right handler.

```js
Module.prototype.load = function(filename) {
  this.filename = filename;
  this.paths = Module._nodeModulePaths(
    path.dirname(filename)
  );
  const extension = findLongestRegisteredExtension(filename);
  Module._extensions[extension](this, filename);
  this.loaded = true;
};
```

The `findLongestRegisteredExtension` function defaults to `.js` if no extension is found. That's why you can `require('./config')` and get `config.js` - the extension handler defaults to `.js` when nothing else matches.

After the handler runs, `this.loaded` flips to `true`. At that point, the module is done. Its exports are whatever `module.exports` was set to during evaluation.

## Module._extensions - The Handler Registry

`Module._extensions` is an object with three keys by default: `.js`, `.json`, and `.node`.

**The `.js` handler** reads the file synchronously (via `fs.readFileSync`), then calls `module._compile` with the source code. That's where wrapping and V8 compilation happen.

**The `.json` handler** reads the file synchronously and runs `JSON.parse` on the content. The parsed object becomes `module.exports` directly. There's no wrapping, no compilation, no function execution. Just a synchronous file read and a parse.

```js
Module._extensions['.json'] = function(module, filename) {
  const content = fs.readFileSync(filename, 'utf8');
  module.exports = JSONParse(stripBOM(content));
};
```

The `stripBOM` call removes UTF-8 byte order marks if present. Some editors on Windows add BOMs to files.

**The `.node` handler** calls `process.dlopen()`, which loads a compiled C++ addon via the operating system's dynamic linker (`dlopen` on Unix, `LoadLibrary` on Windows). The addon's `napi_register_module_v1` function (or legacy `NODE_MODULE` macro) sets `module.exports` to whatever the native code provides.

You can actually add your own handlers. `require.extensions['.txt'] = function(mod, filename) { ... }` still works, though it's deprecated. The mechanism is the same: read the file, do something with the content, set `module.exports`.

There's an ordering subtlety with `.json` files that catches people off guard. When you `require('./config.json')`, Node reads the file synchronously and parses it with `JSON.parse`. The result is a plain JavaScript object - a snapshot of the JSON data at load time. Subsequent calls to `require('./config.json')` return the cached object, even if the file on disk has changed. And because the cached value is a mutable object, any code that modifies the parsed JSON affects every other consumer that required the same file:

```js
const cfg = require('./config.json');
cfg.port = 9999;

const cfg2 = require('./config.json');
console.log(cfg2.port); // 9999 - same cached object
```

Both `cfg` and `cfg2` are references to the identical object sitting in `Module._cache`. Mutating one mutates "both." This has bitten production systems where one module innocently tweaks a config value and every other module sees the change.

## Module._compile - Where Source Becomes Code

This is the most interesting step. `_compile` takes raw source code (a string of JavaScript) and turns it into a running function. Here's the sequence:

**1. Strip the shebang.** If the file starts with `#!`, Node removes that line. This is why you can have `#!/usr/bin/env node` at the top of CLI scripts - the JavaScript engine never sees it.

**2. Wrap the source.** Node wraps your code in a function. The wrapper template is hardcoded:

```js
[
  '(function(exports, require, module, __filename, __dirname) { ',
  '\n});'
]
```

Your source code gets sandwiched between those two strings. If your file contains `const x = 5; module.exports = x;`, the wrapped result is:

```js
(function(exports, require, module, __filename, __dirname) {
const x = 5; module.exports = x;
});
```

This wrapper is the reason `exports`, `require`, `module`, `__filename`, and `__dirname` are available in every CJS module. They're function parameters, injected when Node calls the wrapper function. They're not globals. They're not magic. They're arguments to a function call.

**3. Compile with V8.** Node calls `vm.compileFunction` (or in older versions, wraps the string and uses `vm.Script`) to compile the wrapped source into a V8 function object. The compilation step parses the JavaScript, generates bytecode (via Ignition, covered in Chapter 1), and returns a callable function - but doesn't execute it yet.

The compiled function gets a `cacheKey` for V8's code cache. On subsequent loads (not from `Module._cache` but from V8's bytecode cache), Node can skip parsing and go straight to bytecode. This matters at startup time for large applications.

**4. Execute the function.** Node calls the compiled function, passing in the five arguments:

```js
compiledWrapper.call(
  thisValue,
  module.exports,
  require,
  module,
  filename,
  dirname
);
```

The `this` value inside your module is `module.exports`. That's a detail most people miss. At the top level of a CJS module, `this === module.exports` is `true`. Not that you'd ever rely on it, but it's there.

After the function finishes executing, whatever `module.exports` points to is the module's export. If your code reassigned `module.exports = someFunction`, then `someFunction` is what `require()` returns. If your code only attached properties to `exports.foo = bar`, then the original object (which `module.exports` still references) has those properties.

## module.exports vs exports - The Aliasing Trap

Here's something that trips up developers for years. When the wrapper function is called, `exports` and `module.exports` start as the same object:

```js
console.log(exports === module.exports); // true
```

Both point to the same empty object `{}`. You can attach properties to either one and they show up on both - because they're the same object.

```js
exports.greet = () => 'hello';
console.log(module.exports.greet()); // 'hello'
```

Works fine. But the moment you reassign `exports`, the two diverge:

```js
exports = { greet: () => 'hello' };
console.log(module.exports); // {} - still the original
```

`require()` returns `module.exports`. Always. It never looks at `exports`. The `exports` variable is just a convenience alias. When you reassign it, you're overwriting a local variable - not changing what the module actually exports.

This is why you see `module.exports = class MyThing {}` in code that exports a single value. You can't do `exports = class MyThing {}` because that only changes the local binding, and `require()` still returns the original empty object.

The pattern is simple once you get it: use `exports.something` to add named exports, use `module.exports = something` to replace the entire export.

But even `module.exports` has a subtlety. The cache stores the module object, and `require()` returns `module.exports` - the value at the time of access. If you reassign `module.exports` after your module finishes loading but before someone else requires it... well, you can't, because the load is synchronous and `module.exports` is captured after execution. The point is that `module.exports` is evaluated once, at load time, and that's what goes into the cache.

There's a common pattern for exporting a constructor or class:

```js
module.exports = class Database {
  constructor(url) { this.url = url; }
  query(sql) { /* ... */ }
};
```

The calling module does `const Database = require('./database')` and gets the class directly. If this file had used `exports = class Database { ... }` instead, the caller would get an empty object. I've seen this mistake in code reviews more times than I'd like to admit. The rule of thumb: if you're exporting a single thing (a class, a function, a specific value), always assign to `module.exports`. If you're exporting multiple named things, use `exports.name = value`.

A less common pattern is exporting a function that also has properties:

```js
function greet(name) { return `hello ${name}`; }
greet.version = '1.0.0';
module.exports = greet;
```

The consumer can call `require('./greet')('world')` and also access `require('./greet').version`. Functions are objects in JavaScript, so they can carry properties. Several popular packages use this pattern - `express` itself is a function you call to create an app, but it also has `.Router`, `.static`, and other properties hanging off it.

## Module._cache and require.cache

`Module._cache` is a prototype-less object (`Object.create(null)`) keyed by absolute filenames. When `require('./utils')` resolves to `/home/user/project/utils.js`, that full path is the cache key.

`require.cache` is the exact same object. It's exposed so you can inspect or manipulate it:

```js
console.log(Object.keys(require.cache));
// ['/home/user/project/index.js', '/home/user/project/utils.js', ...]
```

Each value in the cache is a Module instance with properties like `id`, `filename`, `loaded`, `exports`, `parent`, and `children`.

You can delete from the cache to force a module to reload:

```js
delete require.cache[require.resolve('./config')];
const freshConfig = require('./config');
```

But there's a catch. Deleting the cache entry means the module's source file gets re-read and re-evaluated on the next `require()`. Any module that previously required the deleted module still holds a reference to the old exports. They don't get updated. So you end up with two different versions of the same module's exports floating around - the old one held by prior consumers, and the new one returned by fresh `require()` calls.

This pattern is sometimes used for hot-reloading in development. It's fragile. In production, you'd want a different approach entirely.

One thing worth pointing out: `Module._cache` uses `Object.create(null)` as its backing store. No prototype chain. A plain object created with `{}` has `Object.prototype` in its chain, meaning keys like `toString`, `constructor`, and `hasOwnProperty` could collide with module filenames. That's unlikely in practice (you'd need a file literally named `toString.js` in the right location), but the prototype-less object eliminates the edge case entirely. It's a small defensive detail in Node's internals.

The cache also interacts with `require.main` in a specific way. `require.main` points to the Module instance for the entry-point file - the one you ran with `node something.js`. Every module can check `require.main === module` to determine if it's the entry point. This pattern is common in files that act as both a library and a CLI:

```js
if (require.main === module) {
  startServer();
}
module.exports = { startServer };
```

When you run `node server.js`, `require.main === module` is `true`, so `startServer()` fires. When another file does `require('./server')`, `require.main` points to whatever file was the entry point - not `server.js` - so the check is `false` and only the exports happen.

## Synchronous Loading

Every step of `require()` is synchronous. The file read uses `fs.readFileSync`. The compilation is synchronous. The execution of your module code is synchronous (unless your module code does something async internally, but `require()` doesn't wait for that).

This has real consequences. If you `require()` a module at the top level of your entry point, the event loop hasn't started yet. Even if you `require()` a module later - say, inside a request handler - you're blocking the event loop while that module loads. For small modules, the block is imperceptible. For a module that reads a 5MB JSON file, you'll feel it.

```js
app.get('/report', (req, res) => {
  const report = require('./heavy-report-generator');
  res.json(report.generate());
});
```

That `require()` call on the first request will block the event loop while reading and compiling `heavy-report-generator.js`. Subsequent requests hit the cache and return immediately. But the first hit pays the full cost - synchronous disk I/O, parsing, compilation, execution.

The standard practice is to put all `require()` calls at the top of the file, before any async work begins. During Node's bootstrap phase, synchronous loading is fine because nothing else is running yet. Inside async handlers, it's a problem.

There's a subtle reason `require()` is synchronous: CommonJS modules can have side effects during evaluation, and other code might depend on those side effects being complete before `require()` returns. If `require()` were async, every `require()` call would need an `await`, and every file would need to be structured as an async module. That's basically what ES Modules did - but CJS came first, and synchronous loading was the pragmatic choice in 2009.

The synchronous design also means you can use `require()` conditionally and inside branches:

```js
let parser;
if (process.env.USE_FAST_PARSER) {
  parser = require('fast-parser');
} else {
  parser = require('slow-but-safe-parser');
}
```

Only the matching branch loads. The other module's file is never read, never compiled, never evaluated. With ES Modules, `import` declarations are hoisted and static - both modules would be loaded regardless of the condition (you'd need dynamic `import()` for conditional loading). The ability to conditionally `require()` is one of the practical advantages of CJS's synchronous model, and it's used heavily in libraries that want to optionally depend on packages that may or may not be installed.

Another place where synchronous loading matters: startup ordering. Libraries that register process-level event handlers (like custom `uncaughtException` handlers or APM tools) rely on being required early in the entry point file. Because `require()` completes before the next line runs, you can guarantee that the error handler is installed before any other code executes. With async module loading, that guarantee gets harder to reason about.

## Circular Dependencies

Circular dependencies are the weird corner case that makes people nervous. Module A requires module B, and module B requires module A. In many module systems, this is a fatal error. In CJS, it works - sort of.

Remember that `Module._load` caches the module *before* executing it. When A starts loading and reaches `require('./B')`, B starts loading. When B reaches `require('./A')`, A is already in the cache. But A hasn't finished evaluating yet. Its `module.exports` is whatever it was at the point where execution paused to load B.

```js
// a.js
exports.fromA = 'hello from A';
const b = require('./b');
exports.afterB = 'set after B loaded';

// b.js
const a = require('./a');
console.log(a.fromA);  // 'hello from A'
console.log(a.afterB); // undefined
```

When `b.js` runs `require('./a')`, it gets A's `module.exports` as-is at that moment. `exports.fromA` was set before the `require('./b')` call, so it's there. `exports.afterB` hasn't been set yet because that line hasn't executed - A's execution was paused while B loads.

After B finishes, control returns to A, and `exports.afterB` gets set. But B already has a reference to A's exports object. So if B later accesses `a.afterB`, it *will* find it, because `a` holds a reference to the same object that A's `module.exports` points to. The property was added after B's initial access, but the reference is live.

The gotcha is reassignment. If A does `module.exports = new SomeClass()` after B has already grabbed the old `module.exports`, B holds a reference to the original empty object. The reassignment creates a new object; it doesn't mutate the old one.

Most circular dependency bugs come from exactly this: code that reassigns `module.exports` in a file that's part of a cycle. The fix is usually to avoid reassignment (use `exports.thing = ...` instead) or restructure the dependency graph to break the cycle.

There's a practical technique for working around circular deps when you can't restructure. Move the `require()` call to inside the function that uses it, instead of at the top of the file:

```js
// a.js
exports.getB = function() {
  const b = require('./b');
  return b.value;
};
```

By the time `getB` is actually called, both modules have finished loading. The `require('./b')` hits the cache and gets B's complete exports. This pattern is called "lazy require" and it shows up in Node's own internal codebase. The downside is the overhead of a function call and cache lookup on every invocation, though in practice that overhead is negligible - a hash table lookup on a string key.

Node also exposes a way to detect circular dependency situations. The `module.children` array tracks which modules were loaded by a given module. If you follow the children recursively and find a cycle, there's a circular dependency. But nobody actually debugs this way. Usually you just notice undefined properties in your exports and trace backward through the `require()` chain.

## require.resolve()

`require.resolve()` runs the full resolution algorithm - `Module._resolveFilename` - but returns the resolved absolute path without loading the module.

```js
console.log(require.resolve('express'));
// '/home/user/project/node_modules/express/index.js'

console.log(require.resolve('./utils'));
// '/home/user/project/utils.js'
```

It throws `MODULE_NOT_FOUND` if the module can't be located. There's no way to get a "does this module exist?" boolean from `require.resolve` without wrapping it in try/catch.

`require.resolve.paths(request)` returns the array of directories that would be searched for a given request string. For relative paths it returns `null` (since only the parent directory matters). For bare specifiers, it returns the `node_modules` chain:

```js
console.log(require.resolve.paths('express'));
// ['/home/user/project/node_modules',
//  '/home/user/node_modules',
//  '/home/node_modules',
//  '/node_modules']
```

This is a debugging tool. When someone says "I installed the package but Node can't find it," `require.resolve.paths` shows you exactly where Node is looking.

There's a second argument to `require.resolve` that most developers haven't seen:

```js
require.resolve('express', {
  paths: ['/custom/lookup/path']
});
```

The `paths` option overrides the default `node_modules` search list. Instead of walking up from the current file's directory, Node searches only the directories you specify. This is useful in build tools, plugin systems, or anything that needs to resolve modules from a non-standard location. Webpack's `resolve.modules` configuration, for instance, generates calls with custom paths under the hood.

One edge case: `require.resolve` caches its results in `Module._pathCache`, same as the internal resolution. If you resolve the same module twice with the same options, the second call skips the filesystem checks. But if the underlying file gets deleted between calls, the cached result still points to the old path. For long-running processes that care about this (dev servers, watch-mode tools), clearing `Module._pathCache` is occasionally necessary. There's no public API for it, but `Module._pathCache = Object.create(null)` works.

## Inside lib/internal/modules/cjs/loader.js

The source file that implements all of this is `lib/internal/modules/cjs/loader.js` in the Node.js repository. It's around 1,500 lines of JavaScript. Everything discussed so far - `Module._load`, `Module._resolveFilename`, `Module._compile`, `Module._extensions`, the cache - lives in this one file.

The `Module` class is defined with a standard constructor:

```js
function Module(id = '', parent) {
  this.id = id;
  this.path = path.dirname(id);
  this.exports = {};
  this.filename = null;
  this.loaded = false;
  this.children = [];
  this.paths = [];
}
```

Every time you `require()` an uncached module, one of these gets created. The `id` is typically the resolved absolute filename. The `path` is the directory containing the file. The `exports` starts as an empty plain object. `filename` gets set later in `load()`. `loaded` starts as `false` and flips to `true` only after the extension handler has run. `children` accumulates references to modules that this module requires - it's how Node tracks the dependency tree, though in practice few people use it.

The `Module._nodeModulePaths` method is where the `node_modules` search list gets built. It takes a directory path and walks up to the root, appending `/node_modules` at each level:

```js
Module._nodeModulePaths = function(from) {
  from = path.resolve(from);
  const paths = [];
  for (/* each parent directory */) {
    paths.push(path.join(dir, 'node_modules'));
  }
  return paths;
};
```

On a Unix system, for a file at `/home/user/project/src/utils.js`, the paths would be `['/home/user/project/src/node_modules', '/home/user/project/node_modules', '/home/user/node_modules', '/home/node_modules', '/node_modules']`. On Windows, the same logic applies but with backslash separators and drive letters.

These paths are computed once per module and stored in `module.paths`. The resolution algorithm iterates them when looking for bare specifiers.

The `_compile` method is where the real engine integration happens. In modern Node (v24), it uses `vm.compileFunction` rather than wrapping the string in `vm.Script`. The difference is that `compileFunction` directly creates a function with the specified parameters, avoiding the need to wrap the source string manually. The wrapper strings (`Module.wrapper[0]` and `Module.wrapper[1]`) are still used in the public API for backward compatibility, but internally the compilation is done with something closer to:

```js
const compiledWrapper = compileFunction(
  content, filename,
  0, 0,                                   // line/column offset
  undefined,                              // cachedData
  false,                                  // produceCachedData
  undefined, undefined,                   // context, extensions
  ['exports', 'require', 'module', '__filename', '__dirname']
);
```

The `compileFunction` call takes the source content, the filename (for stack traces and debugging), line/column offsets (for source map alignment), and the parameter names that the function will accept. V8 parses the source, generates an AST (covered in Chapter 1), produces bytecode through Ignition, and returns a callable function object.

After compilation, `_compile` builds the `require` function for this specific module. Each module gets its own `require` that has the correct `Module.prototype.require.call(this, ...)` binding and the right `resolve` and `cache` properties. The `require.main` property points to the module that was loaded as the entry point - the one passed to `node main.js`.

Then the compiled function is called with `Reflect.apply`, passing `module.exports` as the `this` value and the five wrapper parameters as arguments. At that point, your module code runs. Top-to-bottom, synchronous execution. Every `require()` call inside your module triggers the same sequence recursively - resolve, cache check, load, compile, execute - and blocks until it returns.

One more detail about caching and V8 bytecode. Node can generate and consume V8 code caches for compiled modules. When `compileFunction` runs, it can optionally produce a bytecode cache (`cachedData`). On subsequent runs of the same application (across process restarts, not just `require()` calls), Node can feed that cached bytecode back to V8, skipping the parse and initial compilation stages. This is the mechanism behind Node's `-experimental-vm-modules` and the bytecode caching in tools like `v8-compile-cache`. For large applications with hundreds of modules, bytecode caching shaves noticeable time off startup.

The internal module loading also handles a few special cases worth mentioning. When loading the main module (the file passed as the argument to `node`), `Module._load` receives `true` for the `isMain` parameter. It sets `process.mainModule` (deprecated in favor of `require.main`) and `module.id` to `'.'` instead of the filename. This is how `require.main === module` detects whether your file is the entry point or a dependency.

Another special case: if you require a directory (like `require('./myLib')`), and that directory has a `package.json` with a `main` field, that field is used to resolve the entry point. If there's no `package.json`, Node tries `index.js`, then `index.json`, then `index.node`. This lookup is part of `Module._findPath`, and it's the reason libraries can expose their entry point through `"main": "lib/index.js"` in `package.json`.

The `Module._extensions` registry also explains a pattern you might've seen in older codebases: `require.extensions['.coffee'] = ...`. CoffeeScript, TypeScript transpilers, and other language tools used to hook into this registry to compile non-JS files on the fly during `require()`. The approach still works in Node v24, but it's officially deprecated because it's synchronous, hard to reason about, and doesn't compose well with ES Modules. Modern alternatives use loaders or pre-compilation steps.

There's a less obvious part of `_compile` that deals with error stack traces. When the compiled function throws, V8 needs to report accurate line numbers. But the source code has been wrapped - there's an extra line at the top (the wrapper function declaration). Node accounts for this by passing line/column offsets to `compileFunction`, so stack traces point to the correct line in the original source file rather than the wrapped version. Without this offset, every line number in every CJS module stack trace would be off by one. It's a small correction that makes a big difference in debuggability.

The `_compile` method also handles source maps. If the module's source contains a `//# sourceMappingURL=` directive, Node can pick it up for the `-enable-source-maps` flag. Source maps translate compiled/transpiled line numbers back to original source locations. TypeScript, Babel, and other transpilers embed or reference source maps so that stack traces show the original `.ts` or `.jsx` line numbers rather than the compiled `.js` lines. Node's module loader integrates this at the compile step.

One more implementation detail: the `content` parameter passed to `_compile` is the raw UTF-8 string from `fs.readFileSync`. Before compilation, Node strips the BOM (byte order mark, `\uFEFF`) if present and removes the shebang line. The shebang removal is done by replacing `#!...` up to the first newline with an equivalent-length sequence of blank characters. This preserves character offsets in the rest of the file, keeping source maps and stack traces accurate. If Node simply deleted the shebang line, every subsequent line number would be wrong.

## The Full Lifecycle, Start to Finish

Tracing one `require('./math')` call end-to-end:

1. `Module.prototype.require` is called with the string `'./math'`.
2. `Module._load('./math', parentModule, false)` begins.
3. `Module._resolveFilename` turns `'./math'` into `/home/user/project/math.js` by checking relative path, trying `.js`/`.json`/`.node` extensions.
4. `Module._cache['/home/user/project/math.js']` is checked. Cache miss on first load.
5. Built-in check fails (it's a file path, not a core module name).
6. `new Module('/home/user/project/math.js', parentModule)` creates a fresh Module instance.
7. The module is stored in `Module._cache` immediately - before any code runs.
8. `module.load('/home/user/project/math.js')` is called.
9. The extension is `.js`, so `Module._extensions['.js']` is invoked.
10. `fs.readFileSync('/home/user/project/math.js', 'utf8')` reads the entire file into memory as a string.
11. `module._compile(sourceString, filename)` is called.
12. The shebang line (if any) is stripped.
13. `vm.compileFunction` compiles the source with the wrapper parameters.
14. The compiled function is called with `(module.exports, require, module, filename, dirname)`.
15. Your module code runs. Every assignment to `module.exports` or `exports.x` mutates the exports object.
16. The function returns. `module.loaded = true`.
17. `Module._load` returns `module.exports`.
18. Your calling code receives the exports and continues.

That whole sequence - all 18 steps - runs synchronously. If step 10 takes 50ms (big file, cold disk cache), you're blocked for 50ms. If step 14 triggers 10 nested `require()` calls, each one goes through the same 18 steps (minus cache hits).

The design makes CJS predictable. When `require()` returns, the module is fully loaded. Its side effects have run. Its exports are complete (barring circular dependency weirdness). There's no async gap where another part of your program could observe a partially-loaded module.

That predictability comes with a cost: synchronous disk I/O and synchronous compilation. ES Modules took the opposite approach - asynchronous loading with a three-phase pipeline (covered in Chapter 1). Both systems coexist in Node v24, and the interop between them is its own set of complexities covered later in this chapter.

