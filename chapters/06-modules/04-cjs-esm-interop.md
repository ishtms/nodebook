---
title: "CJS/ESM Interop and Dual Packages"
date: "2026-02-22"
excerpt: "Interop between CommonJS and ES Modules -- require of ESM, import of CJS, dual packages, and conditional exports."
category: "The Module System"
tags: ["nodejs", "modules", "CJS-ESM-interop", "dual-packages", "conditional-exports"]
author: "Ishtmeet Singh @ishtms"
chapter: "modules"
subchapter: "cjs-esm-interop"
published: true
toc: true
---

# CJS/ESM Interop and Dual Packages

The CJS and ESM module systems coexist in the same runtime, but they weren't designed together. CJS was there first - synchronous, dynamic, built around `module.exports` and a cache keyed by file paths. ESM came later - asynchronous by design, statically analyzed, with live bindings and a multi-phase loading pipeline. Making these two systems talk to each other required engineering compromises, and those compromises are where most of the interop confusion lives.

You already know how each system works internally. Subchapters 01 and 02 covered CJS's `require()` chain and the resolution algorithm. Subchapter 03 covered ESM's parse-link-evaluate pipeline and static analysis. The question now is: what happens at the boundary? When ESM code imports a CJS module, or when CJS code requires an ESM module, which system's rules win?

The answer depends on direction. And it's changed substantially across Node versions.

## The `"type"` field and file extensions

Subchapter 03 covered how Node determines module format before parsing. Here's the condensed version, because it matters constantly during interop work:

- `.mjs` files are always ESM. Always.
- `.cjs` files are always CJS. Always.
- `.js` files follow the nearest parent `package.json`'s `"type"` field. `"type": "module"` means ESM. `"type": "commonjs"` or absent means CJS.

These rules are absolute. No runtime flag overrides them for files on disk. The `"type"` field is the single most impactful line in your `package.json` when working on interop, because it determines what `.js` means throughout your package.

## Importing CJS from ESM

The easier direction. ESM can import CJS modules, and it works more or less the way you'd hope.

### Static import

```js
import config from './config.cjs';
```

When ESM imports a CJS module, Node executes the CJS module synchronously (through the normal `require()` path internally), then wraps the result. The value of `module.exports` from the CJS module becomes the default export in the ESM context.

So if your CJS module does this:

```js
module.exports = { port: 3000, host: 'localhost' };
```

The ESM import gets `{ port: 3000, host: 'localhost' }` as the default export. You'd access properties like `config.port` and `config.host`.

That much is intuitive. The tricky part is named exports.

### Named export extraction from CJS

When you import a CJS module from ESM, Node attempts to extract named exports. This means you can sometimes write:

```js
import { readFileSync } from 'node:fs';
```

Even though `node:fs` is technically a CJS module internally. Node uses a library called `cjs-module-lexer` to statically analyze the CJS source code and identify individual export names. When the analysis succeeds, those names become available as named exports in addition to the default export. You get both: the default export (the whole `module.exports` object) and named exports for each property the lexer detected.

Here's the part that trips people up. The named exports and the default export coexist. If a CJS module does `module.exports = { foo: 1, bar: 2 }` and the lexer successfully detects `foo` and `bar`, then all three of these work from ESM:

```js
import whole from './lib.cjs';          // { foo: 1, bar: 2 }
import { foo, bar } from './lib.cjs';   // 1, 2
import whole2, { foo as f } from './lib.cjs'; // both
```

The default gives you the entire object. The named exports give you individual properties. You can even mix them in one import statement.

The catch: static analysis of CJS is inherently limited. `cjs-module-lexer` can detect common patterns like:

```js
exports.foo = 42;
module.exports.bar = 'hello';
```

It can also detect the `Object.defineProperty(exports, ...)` pattern and some variations of `exports = { ... }`. But it operates on source text without evaluating the code. It doesn't run the module - it just scans the syntax.

So what fails? Dynamic exports. If a CJS module builds its exports at runtime:

```js
const methods = ['get', 'post', 'put', 'delete'];
methods.forEach(m => { exports[m] = createHandler(m); });
```

`cjs-module-lexer` can't detect those exports. The names are computed at runtime from an array. Static analysis sees a `forEach` call, not export assignments. For modules like this, you only get the default export.

The practical implication: when importing from CJS, always try named imports first. If Node can extract them, great - you get clean import syntax. If it can't, you'll get an error at load time telling you the named export doesn't exist. Fall back to importing the default and destructuring:

```js
import pkg from './dynamic-exports.cjs';
const { get, post, put } = pkg;
```

That last line is real destructuring. It copies values. It doesn't create live bindings. But for CJS interop, that's usually fine - CJS exports are snapshots anyway.

### Dynamic import of CJS

`import()` works on CJS modules too:

```js
const mod = await import('./config.cjs');
console.log(mod.default); // module.exports value
```

The returned object is a module namespace with a `default` property pointing to `module.exports`. If `cjs-module-lexer` successfully extracted named exports, they'll appear as additional properties on the namespace object alongside `default`.

One subtle gotcha: the namespace object always has a `default` property, even if the CJS module's `module.exports` is `undefined`. That's the contract. You'll always find `default` on the namespace. What it contains depends on what the CJS module assigned to `module.exports`.

## Importing ESM from CJS

The harder direction. Historically, this was the painful side of interop.

### ERR_REQUIRE_ESM

For years, calling `require()` on an ESM module threw `ERR_REQUIRE_ESM`. Full stop. CJS could only access ESM through dynamic `import()`, which returns a promise:

```js
async function loadESM() {
  const mod = await import('./lib.mjs');
  return mod.default;
}
```

That works, but it forces async patterns into code that might be entirely synchronous. If your CJS application startup calls `require('./config')` and that config file is ESM, you can't just drop in a replacement. You need to restructure your startup flow to handle the promise. For library authors especially, this was brutal - you couldn't publish an ESM-only package without breaking every CJS consumer.

The ecosystem response was messy. Some libraries shipped both CJS and ESM builds. Some stayed CJS-only to avoid breaking consumers. Some went ESM-only and told CJS users to use dynamic `import()`. Plenty of GitHub issues had heated debates about the right approach.

### The require(esm) Solution

Node v22 added `-experimental-require-module`. Node v23 made it on-by-default but still experimental. By Node v24, it's unflagged and stable.

With this feature, `require()` can load ESM modules. There's one constraint: the ESM module must be fully synchronous. No top-level await anywhere in the module or its dependency graph.

```js
// works in Node v24
const { readFile } = require('./esm-utils.mjs');
```

If the ESM module you're requiring uses top-level await, `require()` throws `ERR_REQUIRE_ASYNC_MODULE`. This makes sense mechanically - `require()` is synchronous, and it returns `module.exports` immediately. There's no place to await anything. When an ESM module has top-level await, the evaluate phase can't complete synchronously, so `require()` can't return a result.

The synchronous constraint is transitive. If `a.mjs` imports `b.mjs`, and `b.mjs` has top-level await, then `require('./a.mjs')` will also throw `ERR_REQUIRE_ASYNC_MODULE`. The entire dependency graph reachable from the required module must be synchronous.

When require(esm) succeeds, you get the module's namespace object. Named exports and the default export are all available:

```js
const utils = require('./utils.mjs');
console.log(utils.default);    // default export
console.log(utils.helperFn);   // named export
```

Notice the difference from requiring CJS. When you `require()` a CJS module, you get `module.exports` directly. When you `require()` an ESM module, you get the module namespace object, which has a `default` property for the default export plus all named exports as properties.

### Dynamic import() from CJS

`import()` always works from CJS, regardless of Node version. It returns a promise that resolves to the module's namespace:

```js
const mod = await import('./lib.mjs');
console.log(mod.someFunction);
console.log(mod.default);
```

You can use `import()` at top-level in CJS if you wrap your module body in an async IIFE, or just use it inside async functions. The namespace object has named exports as properties and a `default` property for the default export, just like ESM's static import namespace.

The `import()` approach is the universal escape hatch. If you're in CJS and something about `require()` isn't working - wrong Node version, top-level await in the target, version constraints - fall back to `import()`. It always works. It's just async.

### Comparing the two directions

A quick reference, because the asymmetry between "CJS from ESM" and "ESM from CJS" generates constant confusion:

**CJS from ESM** (ESM is the consumer):
- `import x from './lib.cjs'` - default export is `module.exports`
- `import { named } from './lib.cjs'` - works if `cjs-module-lexer` detects the export
- `await import('./lib.cjs')` - returns `{ default: module.exports, ...namedExports }`
- Always works. No version constraints. No flags needed.

**ESM from CJS** (CJS is the consumer):
- `require('./lib.mjs')` - returns the module namespace object (Node v24+, synchronous ESM only)
- `await import('./lib.mjs')` - returns the module namespace object (any Node version)
- The namespace object has `default` plus all named exports as properties
- `require()` throws `ERR_REQUIRE_ASYNC_MODULE` if any module in the graph uses top-level await

The biggest practical difference: CJS imported into ESM gets its `module.exports` as the default export. ESM required from CJS gives you the whole namespace object, and the default export is just one property on that namespace. If you're switching between these patterns, the shape of what you get back changes.

## The dual package hazard

There's a problem that surfaces specifically in packages that ship both CJS and ESM entry points. The same package can get loaded twice: once through the CJS loader and once through the ESM loader. Two separate module instances. Two separate copies of any module-level state.

Here's a concrete scenario. Suppose a package called `my-lib` ships:
- `dist/cjs/index.cjs` (CJS entry)
- `dist/esm/index.js` (ESM entry)

Your application imports `my-lib` from ESM (loads the ESM entry). A dependency somewhere in `node_modules` does `require('my-lib')` (loads the CJS entry). Now there are two copies of `my-lib` in memory. If `my-lib` maintains internal state - a connection pool, a config cache, a singleton - that state is duplicated. Two pools. Two caches. Two singletons.

The consequences go beyond wasted memory. `instanceof` checks break across the boundary. An object created by the ESM instance of `my-lib` won't be an `instanceof` a class from the CJS instance, even though they're the "same" class from the "same" package. Any type-checking logic that relies on identity fails silently.

### Why it happens

CJS and ESM maintain separate module caches. The CJS cache lives in `Module._cache`, keyed by absolute file path. The ESM cache is managed by the ESM loader, also keyed by URL. When the CJS and ESM entries are different files (`dist/cjs/index.cjs` vs `dist/esm/index.js`), they get different cache keys. Two files, two cache entries, two module evaluations.

Even if the code is functionally identical, the runtime treats them as completely separate modules. There's no deduplication across loaders.

### Mitigation strategies

**Strategy 1: Stateless packages.** If your package has no module-level state - it exports only pure functions, constants, and stateless classes - the dual package hazard is a non-issue. Two copies of the same pure functions don't conflict. This is the simplest approach and the recommended one for libraries where it's feasible.

**Strategy 2: The wrapper approach.** Ship ESM as the canonical implementation. The CJS entry is a thin wrapper that re-exports from the ESM version:

```js
// dist/cjs/index.cjs
module.exports = require('../esm/index.js');
```

In Node v24, this works because `require()` can load ESM (as long as there's no top-level await). Both the CJS and ESM entry points ultimately execute the same ESM module. One module instance, one cache entry, no duplication.

Before require(esm) was available, this pattern used dynamic import:

```js
// dist/cjs/index.cjs (legacy approach)
module.exports = import('../esm/index.js');
```

But that returns a promise from `require()`, breaking CJS consumers who expect synchronous access. The modern require(esm) approach is cleaner.

**Strategy 3: Shared state via a separate module.** Factor all state into a single internal module (either CJS or ESM, pick one) that both entries import. The state module gets loaded once and cached. Both wrappers reference the same cached state.

Strategy 3 is more complex than the wrapper approach but works when you can't make one entry simply re-export the other.

**Strategy 4: ESM-only.** Just stop shipping CJS. If your minimum supported Node version is v18+ (which covers all active LTS lines as of 2024), your ESM consumers import normally, and your CJS consumers use `import()` or upgrade to a Node version with `require(esm)`. More and more popular packages are taking this route - `chalk`, `execa`, `got`, and many others went ESM-only years ago. The tradeoff is clear: you simplify your build, but CJS consumers need to adapt.

**How to detect the dual package hazard in practice:** if a module-level `Map`, `Set`, or singleton is supposed to be shared globally and consumers report it's empty or duplicated, you're probably seeing this. Another telltale: `instanceof` checks that should pass but return `false`. The debugging approach is to log the file path of the module where the class/state lives from both the CJS and ESM sides. If the paths differ, you have two instances.

## Conditional exports in package.json

The `"exports"` field in `package.json` is the mechanism that makes dual packages work. It maps entry points to different files based on how the package is being loaded.

```json
{
  "name": "my-lib",
  "exports": {
    ".": {
      "import": "./dist/esm/index.js",
      "require": "./dist/cjs/index.cjs"
    }
  }
}
```

When someone writes `import 'my-lib'`, Node sees the `"import"` condition and resolves to `./dist/esm/index.js`. When someone writes `require('my-lib')`, Node sees the `"require"` condition and resolves to `./dist/cjs/index.cjs`.

Order matters here. Node evaluates conditions top-to-bottom and takes the first match. The `"import"` and `"require"` conditions are the two main ones for CJS/ESM interop, but there are others:

- `"node"` - matches when running in Node.js (vs. browser bundlers)
- `"default"` - fallback if nothing else matches
- `"types"` - used by TypeScript for type resolution
- Custom conditions - can be set with `-conditions` flag

A more complete exports map might look like:

```json
"exports": {
  ".": {
    "types": "./dist/types/index.d.ts",
    "import": "./dist/esm/index.js",
    "require": "./dist/cjs/index.cjs",
    "default": "./dist/esm/index.js"
  }
}
```

The `"types"` condition should come first because TypeScript resolves it at build time and it needs to match before the runtime conditions. `"default"` should come last as the fallback.

### Subpath exports

You can expose multiple entry points:

```json
"exports": {
  ".": {
    "import": "./dist/esm/index.js",
    "require": "./dist/cjs/index.cjs"
  },
  "./utils": {
    "import": "./dist/esm/utils.js", "require": "./dist/cjs/utils.cjs"
  }
}
```

Consumers can now do `import { helper } from 'my-lib/utils'` or `const { helper } = require('my-lib/utils')`, each resolving to the appropriate format.

One thing the `"exports"` field also does: it locks down your package's public API. If a path isn't listed in `"exports"`, consumers can't import it. Trying `import 'my-lib/dist/internal/secret.js'` throws `ERR_PACKAGE_PATH_NOT_EXPORTED`. Before the `"exports"` field existed, any file in your package was accessible by path. The `"exports"` field introduced encapsulation for packages - consumers only access what you explicitly expose.

### The "main" and "module" fallbacks

If `"exports"` isn't present, Node falls back to `"main"` for the CJS entry point:

```json
{
  "main": "./dist/cjs/index.js"
}
```

The `"module"` field (e.g., `"module": "./dist/esm/index.js"`) is something bundlers like webpack and Rollup recognize, but Node itself ignores it. Node uses `"exports"` or `"main"`, not `"module"`. If you're setting up a dual package, use `"exports"` with conditions. The `"module"` field can live alongside it for bundler compatibility, but it's not part of Node's resolution.

## Setting up a dual build

The common approach for dual CJS/ESM packages involves building your source code to both formats. Here's a typical project structure:

```
src/
  index.js       (source, written in ESM)
dist/
  esm/index.js   (ESM build output)
  cjs/index.cjs  (CJS build output)
package.json
```

Build tools like `tsup`, `unbuild`, and `esbuild` handle this transformation. They take your ESM source and produce both an ESM copy (possibly with minor transformations) and a CJS version where `import` becomes `require()` and `export` becomes `module.exports`.

A minimal `tsup` configuration:

```js
export default {
  entry: ['src/index.js'],
  format: ['esm', 'cjs'],
  outDir: 'dist',
};
```

Your `package.json` then maps each format:

```json
{
  "type": "module",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  }
}
```

And there's the `.cjs` extension again. When your `package.json` has `"type": "module"`, all `.js` files are ESM. Your CJS build output needs the `.cjs` extension so Node treats it correctly. Build tools handle this naming automatically.

Some projects take a simpler approach: write CJS source and produce only CJS output. Use the wrapper approach for the ESM entry:

```js
// esm-wrapper.js
export { default } from './dist/index.cjs';
export * from './dist/index.cjs';
```

The wrapper re-exports everything from the CJS build. Named export extraction (via `cjs-module-lexer`) makes the `export *` work for common CJS patterns. Fewer moving parts. The tradeoff is that your ESM consumers are running through CJS under the hood, which means they get snapshot semantics instead of live bindings.

### Testing both entry points

A common mistake with dual packages: you test one entry point and ship the other untested. Your CJS build might have a subtle difference from your ESM build - a missing export, a different default value, a function that behaves differently because of how the build tool transformed async/await.

The simplest guard:

```js
// test/dual-entry.test.js
import esmExports from '../dist/esm/index.js';
import cjsExports from '../dist/cjs/index.cjs';
assert.deepStrictEqual(Object.keys(esmExports).sort(),
  Object.keys(cjsExports).sort());
```

That just checks that both entries expose the same set of export names. It doesn't verify behavior, but it catches the most common issue: the CJS build dropping or renaming an export. For behavior parity, run your actual test suite against both entry points. Most test runners can be configured to run twice with different import paths.

### Package.json for a real-world dual package

Pulling it all together, a complete `package.json` for a dual CJS/ESM package looks something like:

```json
"type": "module",
"main": "./dist/cjs/index.cjs",
"exports": {
  ".": {
    "types": "./dist/types/index.d.ts",
    "import": "./dist/esm/index.js",
    "require": "./dist/cjs/index.cjs" }
},
"files": ["dist"]
```

The `"main"` field provides a fallback for older tools that don't understand `"exports"`. The `"type": "module"` tells Node that `.js` files in this package are ESM. The `"files"` array controls what ends up in the npm tarball. And `"exports"` handles the conditional resolution for modern Node and bundlers.

## Common errors and how to debug them

Interop errors have specific error codes. Learn the codes and you'll know exactly what went wrong.

### ERR_REQUIRE_ESM

```
Error [ERR_REQUIRE_ESM]: require() of ES Module /path/to/module.mjs
```

You're calling `require()` on an ESM module in a Node version that doesn't support `require(esm)`, or the feature is disabled. In Node v22, enable it with `-experimental-require-module`. In Node v24, it's on by default - if you're still seeing this, the module might be using a `.mjs` extension in a context where the ESM loader should handle it, or something about your Node build has the feature disabled.

Check your Node version first: `node -version`. If it's v22 or v23, try the flag. If it's v24+, something else is going on - check if a loader hook is interfering.

`ERR_REQUIRE_ESM` was the bane of the npm ecosystem for years. It's what you saw when a dependency you'd been using for years suddenly published an ESM-only version and your CJS codebase broke. The `chalk` v5 migration was a famous example - chalk v4 was CJS, v5 went ESM-only, and every CJS project that upgraded got `ERR_REQUIRE_ESM`. The fix was either pinning to v4, switching to `import()`, or converting your project to ESM.

### ERR_REQUIRE_ASYNC_MODULE

```
Error [ERR_REQUIRE_ASYNC_MODULE]: require() cannot be used on an ESM
graph with top-level await
```

The ESM module (or one of its imports) uses top-level await. `require()` can't handle this. Your options: switch to `import()` (async), or remove the top-level await from the ESM module.

To figure out which module in the graph has top-level await, look at the error's stack trace. It usually points to the specific file. If the top-level await is in a transitive dependency, you might need to trace the import chain.

### ERR_PACKAGE_PATH_NOT_EXPORTED

```
Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath './internal'
is not defined by "exports"
```

You're importing a subpath that the package's `"exports"` field doesn't expose. The package author intentionally restricted access. Either use a listed subpath, or if you really need the internal file, you can bypass exports by importing the file directly by its full path relative to `node_modules` - but that's fragile and breaks with any package restructuring.

### Named export not found

```
SyntaxError: Named export 'someFunction' not found
```

You're trying to import a named export from a CJS module, but `cjs-module-lexer` couldn't detect it. The CJS module probably uses dynamic export patterns. Fall back to default import:

```js
import pkg from 'the-package';
const { someFunction } = pkg;
```

### SyntaxError from mixing module syntaxes

```
SyntaxError: Cannot use import statement in a CommonJS module
```

The file is being treated as CJS (because of its extension or the `"type"` field) but contains `import` statements. Either rename the file to `.mjs`, or set `"type": "module"` in the nearest `package.json`.

The reverse error is rarer:

```
ReferenceError: module is not defined in ES module scope
```

The file is ESM but uses CJS syntax like `module.exports`. Rename to `.cjs`, or remove the CJS syntax and use `export` instead.

### The default export confusion

The default export confusion doesn't produce an error - it just gives unexpected results. A CJS module that does:

```js
module.exports = function greet() { return 'hello'; };
```

When imported from ESM:

```js
import greet from './greet.cjs';
greet(); // works - greet is the function
```

But if you accidentally do:

```js
import { greet } from './greet.cjs';
```

That fails because there's no named export called `greet`. The entire function is the default export. Named exports only exist if the CJS module assigns individual properties to `exports` or `module.exports`.

The mental model: `module.exports = X` maps to `export default X`. `exports.foo = Y` maps to `export { Y as foo }` (when `cjs-module-lexer` can detect it).

### Debugging interop issues systematically

When you hit an interop error and the fix isn't obvious, there's a reliable debugging sequence:

1. **Check the file's determined format.** Run `node -input-type=module -e "import('./problematic-file.js').then(m => console.log(m))"` to see how Node treats the file. Or just check the file extension and the nearest `package.json`'s `"type"` field.

2. **Check what exports are detected.** For CJS modules, `await import('./module.cjs')` in a `.mjs` script and log `Object.keys()` of the result. If you only see `['default']`, named export extraction failed.

3. **Check the package's `"exports"` field.** Run `node -e "console.log(require.resolve('package-name'))"` to see where Node resolves the package to. Compare with the `"exports"` map in the package's `package.json` to understand which condition matched.

4. **Check for dual loading.** If you suspect the dual package hazard, add logging in the module's initialization code and watch if it runs twice.

Most interop issues fall into a handful of categories, and the error codes are specific enough to narrow it down quickly. The most common root cause, in my experience, is a mismatch between what you think `"type"` is set to and what it actually is - especially in monorepos where different packages can have different `"type"` settings.

## How the CJS/ESM bridge works internally

The boundary between CJS and ESM inside Node's source is where two loading pipelines meet. Understanding what happens at this junction explains why interop has the constraints it does and why certain patterns work while others don't.

### The translatedSource Path

When an ESM `import` statement targets a CJS file, Node can't just hand the file to the ESM parser - the syntax is wrong. CJS files use `require()`, `module.exports`, and other constructs that aren't valid ESM syntax. The ESM parser would reject them immediately.

Instead, Node creates a synthetic ESM wrapper around the CJS module. Internally, this happens in `lib/internal/modules/esm/translators.js`. The relevant function is the CJS translator, which runs the CJS module through the normal `require()` path first, then constructs an ESM module facade on top of the evaluated result.

The flow goes: Node detects the file is CJS (by extension or `"type"` field). It calls `Module._load()` to execute the CJS module synchronously, populating `module.exports`. Then it passes the evaluated `module.exports` value to the `cjs-module-lexer` analysis step, wraps the result into an ESM module record with a default export (equal to `module.exports`) and optionally named exports (from the lexer analysis), and returns that synthetic module to the ESM loader.

The key insight: the CJS module is fully evaluated before the ESM wrapper is constructed. The ESM loader never sees or parses the CJS source code as ESM. It works entirely with the evaluated output. This is why CJS loaded as ESM always has the `default` export pointing to `module.exports` - Node takes the already-computed value and wraps it.

### cjs-module-lexer

Named export extraction from CJS is handled by `cjs-module-lexer`, a dependency vendored into Node's source tree. It's a WASM-compiled parser (originally written in C) that scans CJS source code and identifies export assignment patterns without evaluating the code.

The lexer recognizes these patterns:

1. **Direct property assignment:** `exports.name = value` and `module.exports.name = value`
2. **Object.defineProperty:** `Object.defineProperty(exports, 'name', { ... })`
3. **Object literal assignment:** `module.exports = { name: value, other: value2 }`
4. **Re-export patterns:** `module.exports = require('./other')` - in this case, the lexer records that the exports come from another module, and Node recursively analyzes that module too

The lexer processes source code as raw bytes. It doesn't build an AST. It doesn't understand control flow. It scans for specific byte patterns - the characters `e`, `x`, `p`, `o`, `r`, `t`, `s` followed by a dot or bracket accessor, essentially. The WASM implementation makes this fast enough to run on every CJS module loaded via ESM import without noticeable overhead.

But the byte-scanning approach has inherent blind spots. Any export pattern that involves computation or indirection at runtime is invisible to the lexer:

- `Object.assign(module.exports, someObject)` - the lexer can't evaluate `someObject`
- `exports[dynamicKey] = value` - computed property names are opaque
- Conditional exports inside `if` blocks - the lexer doesn't evaluate conditions, so it might detect exports inside both branches or neither
- Re-exports through intermediate variables: `const e = exports; e.foo = 42` - the lexer tracks `exports` and `module.exports` directly, not aliases

When the lexer fails to detect exports, the fallback is clean: the CJS module gets only a `default` export containing `module.exports`. No named exports. No error. Just a less convenient import syntax.

You can check what `cjs-module-lexer` detects for a given file. The `module.createRequire()` function combined with `import()` gives you a way to inspect the namespace:

```js
const ns = await import('./some-cjs-lib.cjs');
console.log(Object.keys(ns));
```

That prints all named exports the lexer found, plus `default`.

### The Synchronous ESM Execution Path

The `require(esm)` implementation in Node v24 takes a different path from `import`. When `Module._load()` detects that the target file is ESM (by checking the extension and `"type"` field), it delegates to the ESM loader - but synchronously.

Here's the internal sequence:

1. `Module._load()` calls `Module._resolveFilename()` as usual to find the file.
2. It detects the file is ESM and calls into the ESM machinery: specifically `esmLoader.import()` in a synchronous wrapper.
3. The ESM loader runs its normal pipeline: parse the module source, extract `import` and `export` declarations, resolve all dependencies recursively, link bindings, then evaluate.
4. During the evaluate phase, if any module in the graph contains top-level await, the evaluation produces a promise instead of completing synchronously. The synchronous wrapper detects this and throws `ERR_REQUIRE_ASYNC_MODULE`.
5. If evaluation completes synchronously, the module namespace object (with all named exports and the default export) is returned to `Module._load()`, which returns it as the value of `require()`.

The synchronous wrapping is the key engineering decision. `require()` has always been synchronous - it returns a value, not a promise. Making `require()` support ESM means making ESM evaluation synchronous when possible. And it is possible when there's no top-level await in the graph. ESM's three-phase loading (parse, link, evaluate) can complete entirely synchronously for modules that don't await anything at the top level.

The module gets cached in the ESM cache after this process. If later code does `import` of the same file, the ESM loader finds it already cached and returns the same module instance. If other CJS code does `require()` on the same file, `Module._load()` checks the ESM cache first and returns the cached namespace. Either way, you get a single instance. No dual-loading problem for the same file.

The cache unification is actually one of the nicer aspects of the require(esm) implementation. Before this feature, if a file was loaded via `import` and via `require()`, they could be separate instances (since CJS and ESM had separate caches). With require(esm), ESM files loaded through `require()` are stored in the ESM cache, and future `require()` calls for the same file check the ESM cache. One file, one instance.

### How the evaluation synchronicity check works

When Node evaluates an ESM module, the V8 API returns either a resolved value or a promise. V8's `Module::Evaluate()` method returns a `Local<Value>` that can be either the evaluation result (for synchronous modules) or a `Promise` (for modules with top-level await).

Node's synchronous wrapper checks the return type. If it's a promise, the evaluation can't complete synchronously, and `ERR_REQUIRE_ASYNC_MODULE` is thrown. The check is recursive through the dependency graph - if module A imports module B, and B has top-level await, then A's evaluation will also produce a promise (because A waits for B to finish evaluating), which triggers the error when A is required.

There's a subtle timing aspect here. The parse and link phases of ESM loading are inherently synchronous - V8 parses the source and resolves import bindings without any async operations. The only phase where top-level await introduces asynchrony is evaluation. So `require(esm)` runs parse and link exactly as `import` would, and only diverges at evaluate by checking for synchronous completion.

### The __esModule convention

Before Node had official CJS/ESM interop, bundlers like webpack and Babel invented their own. When Babel compiled ESM to CJS, it added a property to the exports object:

```js
Object.defineProperty(exports, '__esModule', { value: true });
```

Bundlers checked for `__esModule` to decide whether to treat `require()` output as a default-export-wrapping (CJS) or a module-namespace (transpiled ESM). If `__esModule` was truthy, the bundler knew the CJS code was originally ESM and treated `exports.default` as the default export rather than wrapping the entire exports object.

Node's native interop doesn't use `__esModule`. It has its own mechanisms (the translator system, `cjs-module-lexer`). But you'll still encounter `__esModule` in legacy codebases and in the output of build tools. It's a convention from the transpiler era. When you see bundler-related interop issues - default exports wrapped in an extra `{ default: ... }` layer, for instance - `__esModule` handling is often involved.

## Practical patterns for library authors

If you're publishing a package that needs to work for both CJS and ESM consumers, here's the decision tree I'd recommend:

**If your package is stateless** (pure functions, no module-level singletons): ship dual builds via `tsup` or `unbuild`, use conditional exports, and don't worry about the dual package hazard.

**If your package has state:** use the wrapper approach. Make ESM the canonical implementation. The CJS entry re-exports from ESM using `require()`. In Node v24, this works cleanly. For older Node support, the CJS entry can use `module.exports = require('./esm-entry.js')` if the ESM is synchronous, or you need to accept the dual-instance tradeoff.

**If you're writing an application** (as opposed to a library): pick one format and stick with it. Set `"type": "module"` for ESM. Don't bother with dual builds. Your dependencies handle their own interop. You just `import` whatever you need, and Node sorts out whether each dependency is CJS or ESM.

**For the transition period:** most real-world projects have dependencies spanning both module formats. Some dependencies only ship CJS. Some only ship ESM. A few ship both. Your application code can be entirely ESM while consuming CJS dependencies via `import` - Node handles the translation. The only time you'll notice the boundary is when named export extraction fails and you need to fall back to default imports.

One more practical note: TypeScript complicates this. If your `tsconfig.json` has `"module": "commonjs"`, TypeScript compiles your ESM-style `import/export` to `require/module.exports`. If it has `"module": "nodenext"` or `"module": "node16"`, TypeScript respects the file extension and `"type"` field to decide output format. Getting TypeScript and Node to agree on module format is its own debugging adventure, but the underlying principles are the same as what we've covered here.

## The state of interop in Node v24

The interop story has improved dramatically. Five years ago, loading ESM from CJS meant async `import()` everywhere. Named export extraction from CJS was unreliable. The dual package hazard had no clean solutions.

In Node v24, the situation is cleaner. `require(esm)` works without flags for synchronous ESM. Named export extraction is mature and handles most common CJS patterns. The `"exports"` field provides a standard mechanism for dual packages. The wrapper approach eliminates the dual package hazard for stateful libraries.

Interop edges still exist. Top-level await in ESM prevents `require()`. Dynamic CJS export patterns defeat named export extraction. Cache isolation between loaders can still cause subtle bugs in complex dependency graphs. These are known constraints, documented in error codes, and debuggable with the knowledge from this subchapter.

The general trajectory is toward ESM as the default. New packages increasingly ship ESM-only. CJS isn't going away - there are billions of lines of it on npm - but the interop machinery means ESM consumers rarely need to think about it. `import` a CJS package, get a default export, maybe get named exports. Import an ESM package, get live bindings and static analysis. The runtime handles the translation.

