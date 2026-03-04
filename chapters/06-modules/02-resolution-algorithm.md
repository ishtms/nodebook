---
title: "Module Resolution Algorithm"
date: "2026-02-22"
excerpt: "Node.js module resolution -- how specifiers become file paths, node_modules traversal, and package.json exports."
category: "The Module System"
tags: ["nodejs", "modules", "resolution", "node_modules", "package-exports"]
author: "Ishtmeet Singh @ishtms"
chapter: "modules"
subchapter: "resolution-algorithm"
published: true
toc: true
---

Every `require()` call starts with a string. `'fs'`. `'./utils'`. `'lodash'`. Just a string. And Node has to turn that string into an absolute file path pointing at actual bytes on disk. The algorithm that does this is more involved than you'd expect - it branches on the very first character of the specifier, runs synchronous filesystem calls, and walks directory trees upward toward the root.

The resolution process has been refined over a decade and a half of Node releases, but the core logic hasn't fundamentally changed since the early days. What has changed is the addition of `"exports"` and `"imports"` fields in package.json, which overlay a new permissions-like system on top of the original filesystem-probing approach. Getting a mental model of the full sequence - old and new - makes debugging module-not-found errors take seconds instead of minutes.

## Three categories of specifiers

The resolution algorithm looks at the string you pass to `require()` and immediately classifies it into one of three categories. The category determines which code path runs.

**Built-in modules** are specifiers matching a name in Node's internal native module registry. `'fs'`, `'path'`, `'http'`, `'crypto'` - there's a fixed list. These get resolved first, before anything touches the filesystem. You can also write `'node:fs'` to be explicit about it.

**Relative and absolute paths** start with `'./'`, `'../'`, or `'/'`. They resolve against the directory of the calling module. `require('./utils')` in a file at `/home/app/src/lib/foo.js` looks for something at `/home/app/src/lib/utils` (with extension probing, which we'll get to).

**Bare specifiers** are everything else. `'lodash'`, `'@scope/pkg'`, `'express/lib/router'`. These trigger the node_modules climbing algorithm - the most complex of the three paths.

The classifier runs in `Module._resolveFilename()`, the entry point for all CJS resolution. A single `if` chain determines the branch. Built-in check first. Then path check. Then bare specifier. That ordering matters.

## Built-in modules

Built-in modules short-circuit the entire resolution process. When you `require('fs')`, Node checks its internal `NativeModule` map (an object populated at startup from the compiled-in module list). If the string matches, resolution returns immediately with a reference to the built-in module's exports. No filesystem access. No stat calls. No path manipulation.

```js
const fs = require('fs');
const also_fs = require('node:fs');
```

Both lines resolve to the same built-in module. The `node:` prefix was introduced in Node 14.18 / 16.0 to disambiguate built-in modules from npm packages with the same name. Before `node:`, if someone published a package called `fs` to npm, `require('fs')` could theoretically load it instead of the built-in - though Node's built-in check happens first, so the built-in wins. The `node:` prefix makes the intent unambiguous. And some newer built-in modules (like `node:test`) are *only* available with the prefix.

There's a subtlety here. The built-in check uses a hardcoded list, and that list includes modules you might think are user-land: `'assert'`, `'util'`, `'string_decoder'`. If you have a local file called `assert.js` and write `require('assert')`, you'll get the built-in, every time. The only way to load your local file is `require('./assert')`.

The full list of built-in modules is accessible at runtime:

```js
const builtins = require('module').builtinModules;
console.log(builtins.length, builtins.slice(0, 5));
```

On Node 24, `builtinModules` returns about 80 entries. The array includes both prefixed (`'node:fs'`) and unprefixed (`'fs'`) forms. Internal modules starting with `_` (like `_http_agent` or `_stream_readable`) are present in older Node versions but were gradually removed from the public list. They still exist in the binary - you can sometimes load them with `require('_http_agent')` - but relying on them is asking for trouble across Node upgrades.

## Relative and absolute paths

When the specifier starts with `./`, `../`, or `/`, Node treats it as a filesystem path. Relative paths resolve against `__dirname` of the calling module. An absolute path is used as-is.

The resolved path goes through a series of probes. Node doesn't just look for the exact file - it tries multiple extensions and even checks for directories.

### Extension probing

If you write `require('./utils')` and there's no file literally named `utils` (no extension), Node tries appending extensions in this order:

1. `.js`
2. `.json`
3. `.node`

Each attempt calls an internal stat binding to check if the file exists. The first hit wins. So if both `utils.js` and `utils.json` exist in the same directory, `require('./utils')` loads `utils.js`.

```js
require('./config');
```

That line might resolve to `config.js`, `config.json`, or `config.node`. The `.node` extension means a compiled C++ addon (a shared library). The `.json` extension triggers `JSON.parse()` on the file contents. The `.js` extension runs through the module wrapper function (covered in Chapter 1) and executes as JavaScript.

Each extension has its own handler registered on `Module._extensions`. You can technically add your own:

```js
require.extensions['.txt'] = function(module, filename) {
  const content = require('fs').readFileSync(filename, 'utf8');
  module.exports = content;
};
```

That's deprecated. Has been for years. But it still works in Node 24, and some tools (like ts-node with its `.ts` handler) use the mechanism internally. The deprecation warning only fires if you set `-pending-deprecation`.

The handler for `.json` files is especially interesting. Here's basically what it does internally:

```js
Module._extensions['.json'] = function(module, filename) {
  const content = fs.readFileSync(filename, 'utf8');
  module.exports = JSON.parse(stripBOM(content));
};
```

The `stripBOM` call removes UTF-8 byte-order marks if present. JSON files loaded through `require()` are parsed once, cached as the parsed JavaScript object, and subsequent `require()` calls for the same file return the cached object. Mutations to that object are visible everywhere that required the same file - a detail that surprises people who expect `require('./config.json')` to return a fresh copy each time. It doesn't. You get the same reference.

The `.node` handler calls `process.dlopen()`, which is a thin wrapper around `dlopen()` on Unix and `LoadLibrary()` on Windows. The shared library has to export a `node_register_module_v*` symbol that Node uses to initialize the addon. Binary addons are platform-specific: a `.node` file compiled on Linux won't load on macOS, and vice versa. node-gyp and prebuild handle the compilation and distribution of these files.

### The exact file check

Before extension probing even starts, Node tries the specifier as an exact path. `require('./utils.js')` skips extension probing entirely - it goes straight to a stat call on `utils.js`. If the file exists, done. If it doesn't, you get `MODULE_NOT_FOUND`. No fallback to `utils.js.js` or anything weird like that.

So there's a practical difference between `require('./utils')` and `require('./utils.js')`. The first tries `utils`, then `utils.js`, then `utils.json`, then `utils.node`, then checks if `utils` is a directory. The second tries `utils.js` only.

Including the extension explicitly saves stat calls. In a large codebase with thousands of require calls, that adds up. Some linting rules (like `import/extensions` from eslint-plugin-import) enforce explicit extensions for this reason. TypeScript projects using `-moduleResolution node` follow the same probe order, which is why you'll sometimes see `.js` extensions in TypeScript source that actually resolve to `.ts` files - TypeScript's resolver mirrors Node's, then swaps the extension.

### Directory-as-module

When `require('./mylib')` resolves to a directory (stat says it's a directory, not a file), Node looks inside that directory for an entry point. The search order:

1. Read `package.json` in the directory and check the `"main"` field
2. Try `index.js`
3. Try `index.json`
4. Try `index.node`

```json
{
  "name": "mylib",
  "main": "lib/entry.js"
}
```

If `./mylib/package.json` contains that, `require('./mylib')` loads `./mylib/lib/entry.js`. Without a `package.json` (or without a `"main"` field), it falls back to `index.js` in the directory.

The `index.js` convention is old - it dates back to Node's earliest days. A lot of projects still use it. You'll see directories with just an `index.js` re-exporting things from sibling files. It's one of those patterns that's too entrenched to ever go away.

One thing to watch: if a directory has both a `package.json` with `"main"` and an `index.js`, the `"main"` field wins. The fallback chain only continues if each step fails. And if `"main"` points to a file that doesn't exist, you get `MODULE_NOT_FOUND` - Node won't fall back to `index.js` as a recovery attempt. The `"main"` field, once read, is treated as authoritative.

```js
// Assuming ./mylib/ has package.json with "main": "entry.js"
const lib = require('./mylib');
// Loads ./mylib/entry.js, ignores ./mylib/index.js
```

The directory check itself uses internal stat bindings that return an integer representing the file type. If the stat call indicates a file, the path is treated as a file (with extension probing). If it indicates a directory, the directory-as-module logic kicks in. If the stat call fails with `ENOENT`, that probe path is exhausted.

## The node_modules climbing algorithm

Bare specifiers - strings without a path prefix - trigger the most complex resolution path. `require('lodash')` needs to find lodash somewhere on the filesystem. Node's approach: start from the caller's directory and walk upward, checking for `node_modules` directories at each level.

The function `Module._nodeModulePaths(from)` generates the list of directories to search. For a file at `/home/app/src/lib/foo.js`, the list looks like this:

```
/home/app/src/lib/node_modules
/home/app/src/node_modules
/home/app/node_modules
/home/node_modules
/node_modules
```

Node builds this array by taking the caller's directory and repeatedly chopping off the last path segment, appending `/node_modules` each time, until it hits the filesystem root. Then it tries to resolve the bare specifier as a file or directory within each of these `node_modules` directories, in order.

So `require('lodash')` from `/home/app/src/lib/foo.js` first checks `/home/app/src/lib/node_modules/lodash`, then `/home/app/src/node_modules/lodash`, then `/home/app/node_modules/lodash`, and so on. At each location, the same extension probing and directory-as-module logic applies. The first match wins.

### Why it climbs

The climbing algorithm means nested packages can have their own dependencies. `/home/app/node_modules/express/node_modules/accepts` is a separate copy of `accepts` used only by express. A different version of `accepts` could exist at `/home/app/node_modules/accepts` for the main application. npm's deduplication tries to hoist shared versions to the highest possible level, but when versions conflict, nested `node_modules` directories keep them isolated.

The tradeoff is filesystem depth. In pre-npm-v3 days, the tree could get absurdly deep - `node_modules/a/node_modules/b/node_modules/c/node_modules/d/...` - deep enough to hit Windows's 260-character path limit. npm v3+ flattens the tree aggressively. pnpm uses a different approach entirely, with symlinks to a content-addressable store. But the resolution algorithm stays the same regardless of the package manager; it just follows whatever filesystem structure it finds.

### Scoped packages

Scoped packages like `@babel/core` are a directory nesting detail. `require('@babel/core')` looks for `node_modules/@babel/core/`, where `@babel` is a directory and `core` is a subdirectory inside it. The climbing algorithm works identically - it just treats `@babel/core` as a two-segment path inside each `node_modules` directory.

### Subpath requires

You can require files deep inside a package: `require('express/lib/router')`. The algorithm resolves `express` through the climbing chain, then appends `/lib/router` and applies the same extension probing and directory logic. So `require('express/lib/router')` might resolve to `node_modules/express/lib/router/index.js` or `node_modules/express/lib/router.js`.

But if the package has an `"exports"` field, deep subpath requires are blocked unless the `"exports"` map explicitly includes them. A package can expose `require('express')` and `require('express/Router')` while preventing `require('express/lib/router')`. The `"exports"` map acts as an allow-list for the package's public surface.

Before `"exports"` existed, anyone could reach into a package's internal files. Library authors had no way to mark files as private. Changing an internal file's name or location would break consumers who depended on that path, even though the file was never part of the public API. `"exports"` solved this by giving packages a way to declare their boundary.

## package.json "main" field

When the climbing algorithm finds a matching directory in `node_modules`, it needs to figure out which file to actually load. The first thing it checks is `package.json` in that directory, looking for the `"main"` field.

```json
{
  "name": "lodash",
  "version": "4.17.21",
  "main": "lodash.js"
}
```

That `"main"` value gets resolved relative to the package directory. If `"main"` points to `"./dist/index.js"`, the resolved file is `/path/to/node_modules/lodash/dist/index.js`. If `"main"` is missing, Node falls back to `index.js` in the package root.

Some packages set `"main"` to a CJS entry point and provide a separate field for ESM. The `"main"` field is a CJS-era concept. For ESM resolution, there's `"module"` (a field invented by the bundler ecosystem, never officially recognized by Node) and the newer `"exports"` field, which subsumes both.

A common pattern you'll see in npm packages:

```json
{
  "name": "some-lib",
  "main": "./dist/cjs/index.js",
  "module": "./dist/esm/index.js"
}
```

Node ignores `"module"` completely. Webpack, Rollup, and esbuild read it when they're bundling for browser or ESM targets. Node only looks at `"main"` and `"exports"`. If you're writing a package that targets both Node and bundlers, you want `"exports"` with conditional entries - it covers all cases in a single field.

## package.json "exports" field

The `"exports"` field is the modern way to define a package's public API. It was added in Node 12.7 and has grown in capability since. When `"exports"` is present, it takes precedence over `"main"` for `require()` resolution. It also restricts which files inside the package can be imported - anything not listed in `"exports"` is off-limits.

```json
{
  "name": "my-pkg",
  "exports": {
    ".": "./lib/index.js",
    "./utils": "./lib/utils.js"
  }
}
```

With that configuration, `require('my-pkg')` loads `./lib/index.js` and `require('my-pkg/utils')` loads `./lib/utils.js`. But `require('my-pkg/lib/internal.js')` throws `ERR_PACKAGE_PATH_NOT_EXPORTED` even if the file exists on disk. The `"exports"` map is the only entry point.

### Conditional exports

The `"exports"` field supports conditions - different resolutions based on the context of the import.

```json
{
  "exports": {
    ".": {
      "import": "./lib/index.mjs",
      "require": "./lib/index.cjs",
      "default": "./lib/index.js"
    }
  }
}
```

When you `require('my-pkg')`, Node matches the `"require"` condition and loads `./lib/index.cjs`. When you `import 'my-pkg'` in an ES module, it matches `"import"` and loads `./lib/index.mjs`. The `"default"` condition is the fallback when nothing else matches.

Other condition names include `"node"` (Node.js environment), `"browser"` (ignored by Node, used by bundlers), and `"development"` / `"production"` (custom, opt-in via `-conditions` flag). You can define arbitrary condition names, but they won't be recognized unless the consumer knows about them.

Condition evaluation order matters. Node walks the conditions object top to bottom and picks the first match. So putting `"default"` before `"require"` means `"require"` never matches - `"default"` catches everything first.

### Subpath patterns

Starting in Node 12.20, `"exports"` supports wildcard patterns:

```json
{
  "exports": {
    "./features/*": "./src/features/*.js"
  }
}
```

`require('my-pkg/features/auth')` resolves to `./src/features/auth.js`. The `*` replaces a single path segment. You can use this for packages with many entry points without listing each one individually.

The `*` wildcard acts as a simple string replacement and matches any string, including one with multiple path segments containing `/` separators. So `require('my-pkg/features/auth/handler')` will successfully match the pattern `./features/*`, resolving to `./src/features/auth/handler.js`. The Node docs call this "subpath patterns" and it allows a single pattern to expose entire nested directory structures automatically.

### Exports vs main precedence

When both `"exports"` and `"main"` exist in a package.json, `"exports"` wins for any consumer that supports it (Node 12.7+). The `"main"` field still works as a fallback for older Node versions. In practice, most packages shipping `"exports"` keep `"main"` around purely for backward compatibility.

## package.json "imports" field

The `"imports"` field is the package-internal counterpart to `"exports"`. Where `"exports"` defines what consumers can load, `"imports"` defines private aliases that only the package itself can use.

```json
{
  "name": "my-app",
  "imports": {
    "#utils": "./src/utils/index.js",
    "#db": "./src/database/client.js"
  }
}
```

Inside any file belonging to `my-app`, you can write `require('#utils')` and it resolves to `./src/utils/index.js`. The `#` prefix is mandatory - it distinguishes imports-map entries from bare specifiers. Outside the package, `require('#utils')` would fail because the `"imports"` field is scoped to the package that defines it.

The `"imports"` field supports conditions too:

```json
{
  "imports": {
    "#db": {
      "development": "./src/database/mock.js",
      "default": "./src/database/client.js"
    }
  }
}
```

Running with `node -conditions=development app.js` makes `require('#db')` resolve to the mock. Without that flag, it resolves to the real client.

There's a practical benefit here beyond aesthetics. Deep relative paths like `require('../../../../utils/helpers')` are brittle - renaming or moving the current file breaks them. Imports map entries stay stable regardless of where the requiring file lives in the directory tree.

The resolution of `#`-prefixed specifiers works differently from bare specifiers. Node doesn't climb the filesystem looking for node_modules directories. Instead, it finds the nearest `package.json` to the calling file (walking upward from the file's directory), reads the `"imports"` field from that package.json, and resolves the mapping. If the nearest package.json doesn't have an `"imports"` field, the specifier fails immediately. There's no fallback to other package.json files higher in the tree.

This scoping is intentional. The `"imports"` field belongs to a single package. A dependency can define its own `#`-prefixed mappings without conflicting with yours. Package A's `#utils` and Package B's `#utils` resolve independently, each reading from their own package.json.

## NODE_PATH

`NODE_PATH` is an environment variable containing additional directories to search for modules. It's a colon-separated list on Unix, semicolon-separated on Windows. Directories in `NODE_PATH` are searched after the climbing algorithm exhausts all `node_modules` directories.

```bash
NODE_PATH=/home/shared/libs:/opt/custom/modules node app.js
```

With that, `require('some-lib')` would check all the usual `node_modules` locations first, and if the module isn't found, try `/home/shared/libs/some-lib` and `/opt/custom/modules/some-lib`.

`NODE_PATH` is legacy. The Node docs describe it as "for compatibility reasons" and recommend against using it. In practice, you'll encounter it in a few specific situations: Docker containers with shared module directories, monorepo setups that predate npm workspaces, and CI environments with pre-cached dependencies. But for normal development, node_modules is the expected mechanism.

## Global folders

Beyond `NODE_PATH`, there are a few more global locations Node checks as a last resort:

- `$HOME/.node_modules`
- `$HOME/.node_libraries`
- `$PREFIX/lib/node`

`$PREFIX` is the path returned by `node -e "process.stdout.write(process.config.variables.node_prefix)"` - typically `/usr/local` on Unix.

These paths exist for historical reasons. I've never seen them used in production, and I'd be surprised if you have either. They're the very last directories checked before the module-not-found error fires.

## require.resolve()

`require.resolve()` runs the full resolution algorithm and returns the absolute path to the file that *would* be loaded - without actually loading it. No execution, no caching side effects.

```js
const p = require.resolve('lodash');
console.log(p);
```

That might print `/home/app/node_modules/lodash/lodash.js`. If the module can't be found, it throws `MODULE_NOT_FOUND` just like `require()` would.

You can pass options to control the search:

```js
require.resolve('lodash', {
  paths: ['/custom/search/path']
});
```

The `paths` option replaces the default search directories. Only the specified paths are checked, along with built-in module names.

There's also `require.resolve.paths()`, which returns the array of directories that `require()` would search for a given specifier:

```js
const dirs = require.resolve.paths('lodash');
console.log(dirs);
```

The output is the same list `Module._nodeModulePaths()` generates - the climbing chain from the caller's directory up to root, plus any `NODE_PATH` entries and global folders.

`require.resolve()` is useful for conditional loading, finding a package's root directory, and debugging resolution issues. Here's a conditional loading pattern you'll see in the wild:

```js
let yaml;
try {
  yaml = require(require.resolve('js-yaml'));
} catch {
  yaml = null;
}
```

The outer `require.resolve()` call tests whether `js-yaml` exists. If it doesn't, the thrown error gets caught and the feature degrades gracefully. You could also use just `require('js-yaml')` inside the try block - `require.resolve` is slightly more explicit because it separates "can I find it?" from "load and execute it."

For finding a package's root directory:

```js
const path = require('path');
const pkgDir = path.dirname(require.resolve('lodash/package.json'));
console.log(pkgDir);
```

That resolves lodash's package.json, then strips the filename to get the package's root directory. From there you can read the package's version, find other files inside it, or construct paths relative to it. The `require.resolve('lodash/package.json')` pattern works even with `"exports"` restrictions because package.json is implicitly accessible (Node needs to read it for resolution itself).

## Symlink behavior

When the resolution algorithm finds a file, it calls `fs.realpathSync()` on the path before using it as the cache key. Symlinks get resolved to their real targets.

Say you have two symlinks:

```
/home/app/node_modules/my-pkg -> /opt/packages/my-pkg
/home/app/vendor/my-pkg -> /opt/packages/my-pkg
```

Both point to the same real directory. When `require()` loads either one, the cache key is the real path `/opt/packages/my-pkg/index.js`. So the module gets loaded once, cached once, and both `require('my-pkg')` and any resolution through `/home/app/vendor/my-pkg` return the same exports object.

This has practical implications for pnpm, which symlinks packages from a central store. Every project using the same version of lodash shares the same real path, so the module cache stays small across projects (within the same Node process, which isn't common across projects, but matters within a monorepo).

You can disable realpath resolution with `-preserve-symlinks`. With that flag, the symlink path itself becomes the cache key. Two symlinks to the same file become two separate module instances, each with their own exports object. That flag exists mainly for edge cases where the file's apparent location matters - some module systems expect `__dirname` to match the symlink location, not the target location.

There's also `-preserve-symlinks-main`, which applies the same logic only to the main entry script (the file you pass to `node`). Without this flag, `node /path/to/symlink.js` resolves the symlink before determining `__dirname` for the entry module. With it, `__dirname` reflects the symlink's location. Both flags are rare in practice. Most codebases never need them. But if you're working with npm link or pnpm and seeing unexpected module duplication (two instances of the same package, causing `instanceof` checks to fail across them), understanding the symlink resolution step is the key to diagnosing it.

The realpath call also canonicalizes casing-but only on certain operating systems like Windows. On macOS with case-insensitive APFS, `fs.realpathSync('/Users/App/Index.js')` simply returns `/Users/App/Index.js` (the requested case, not the actual casing on disk). The returned path becomes the cache key. This means on macOS, the same file can be loaded twice if required with different casing, creating subtle bugs where two instances of a module exist with separate, disconnected state (the dual-package hazard).

## Inside Module._resolveFilename

The resolution algorithm lives in `lib/internal/modules/cjs/loader.js`, inside the function `Module._resolveFilename(request, parent, isMain, options)`. Walking through this function reveals the exact order of operations, including details that get lost in higher-level descriptions.

The function receives four parameters: `request` is the specifier string, `parent` is the `Module` object of the calling module (null for the entry point), `isMain` indicates whether this is the main module being loaded by `node app.js`, and `options` is the optional configuration object (from `require.resolve()`'s second argument).

The first thing `_resolveFilename` does is check for built-in modules. It calls `NativeModule.canBeRequiredByUsers(request)` - a function that checks the specifier against a set of strings compiled into the Node binary. Built-in module names are hardcoded at build time; they're derived from the filenames in Node's `lib/` directory. If the check passes, the function returns the specifier string as-is (e.g., `'fs'`) - no file path needed. The `node:` prefix is handled by stripping it before the lookup, then returning the prefixed form.

If it's not a built-in, `_resolveFilename` builds the list of search paths. For relative or absolute specifiers, the only search path is the directory of the parent module (extracted from `parent.filename`). For bare specifiers, it calls `Module._resolveLookupPaths(request, parent)`, which combines `Module._nodeModulePaths(parent.path)` (the climbing chain) with any `NODE_PATH` entries, plus the global folders. The result is an array of directories to probe.

With the paths array ready, the function calls `Module._findPath(request, paths, isMain)`. Here's where the actual filesystem work happens. `_findPath` has its own internal cache - a `Map` keyed by `request + '\x00' + paths.join('\x00')`. If the cache has an entry, it returns immediately. The cache-miss path is where stat calls happen.

For each directory in the paths array, `_findPath` constructs a candidate filename. If the request is a relative path, it joins the directory with the request. If it's a bare specifier inside a node_modules search, it joins the node_modules path with the specifier.

Then it calls `tryFile(basePath)` - a wrapper around a fast C++ binding (`internalModuleStat`) that returns the path if the file exists, or `false` otherwise. The stat result gets cached in `Module._pathCache` to avoid repeating filesystem calls for the same path.

If `tryFile` fails, it calls `tryExtensions(basePath, exts)`, where `exts` is the array `['.js', '.json', '.node']`. This function appends each extension to the base path and calls `tryFile` for each. First match wins.

If extensions fail too, it tries loading the path as a directory. `tryPackage(basePath)` reads `package.json` in the directory, extracts the `"main"` field (falling back to `"."` if absent), and resolves that. If `"exports"` is present in the package.json, it takes a different path through `resolveExports()`, which handles the conditional exports logic, subpath matching, and pattern expansion.

If none of these probes succeed across all search directories, `_findPath` returns `false`, and `_resolveFilename` throws the `MODULE_NOT_FOUND` error with the familiar message: `Cannot find module 'whatever'`.

### The synchronous cost

Every one of these filesystem operations is synchronous. `internalModuleStat()`. `fs.readFileSync()` for package.json. `fs.realpathSync()` for symlink resolution. The event loop (covered in Chapter 1) is blocked during the entire resolution process. Although Node avoids the overhead of instantiating JS `fs.Stats` objects by using internal bindings, the stat calls still take microseconds. But large applications can have thousands of require calls at startup, and the stat calls add up - especially on slow filesystems (network mounts, some Docker volume configurations) or when the node_modules tree is deeply nested.

Each unsuccessful stat call is wasted work. If you `require('lodash')` from a file deep in `src/lib/utils/helpers/`, the algorithm stats six or more directories before finding it in the top-level `node_modules`. The `_pathCache` mitigates repeat lookups within the same process, but the first resolution of each unique specifier pays the full cost.

The stat calls are particularly visible in profiling. `strace` on Linux or `dtrace` on macOS will show hundreds of `stat()` syscalls during application startup, most of them returning `ENOENT` for node_modules directories that don't exist at intermediate path levels. This is the cost of the climbing algorithm - it's thorough, but it's brute-force.

Tools like `require-cache` and `module-alias` try to short-circuit this by rewriting specifiers or pre-populating the path cache. Bundlers like webpack and esbuild avoid the runtime cost entirely by resolving everything at build time and producing a single file with no `require()` calls at all.

One last detail: `fs.realpathSync()` is called on the final resolved path to canonicalize symlinks. On Linux, this translates to a `readlink()` syscall. On macOS, `realpath()`. Both involve additional kernel calls. The `-preserve-symlinks` flag skips this step, which can measurably speed up startup in symlink-heavy environments (like pnpm workspaces with thousands of packages).

There's a Node-internal optimization worth mentioning: `fs.realpathSync.native()`. Node has two implementations of realpathSync - one in JavaScript that manually traverses each path component, and one that delegates to the native C `realpath()` function. The native version is faster but has historically had edge-case differences on certain platforms. The module system uses the native variant for resolution. You don't need to think about this unless you're profiling startup performance and see `realpathSync` showing up in your flamegraph - in which case, `-preserve-symlinks` is the knob to turn.

### The resolution cache

`Module._resolveFilename` caches its results in `Module._cache` indirectly - the resolved filename becomes the cache key for the loaded module object. But `_findPath` has its own string-keyed cache that stores the mapping from `(request, paths)` to the resolved absolute path. This two-level caching means that even if a module hasn't been loaded yet, subsequent resolution of the same specifier from the same location skips all filesystem probing.

You can observe the cache by inspecting `require.cache`, which is a reference to `Module._cache`:

```js
console.log(Object.keys(require.cache));
```

Each key is an absolute file path (after symlink resolution). The values are `Module` objects with `exports`, `filename`, `loaded`, `children`, and other properties.

Clearing specific entries from `require.cache` forces re-loading on the next `require()` call. Some hot-reloading tools use this technique: delete the cache entry, then `require()` the file again to pick up changes. But it's tricky - you need to also delete the file from its parent module's `children` array, or the parent retains a reference to the old module object. And any module that already captured a reference to the old exports won't see updates. Hot-reloading via cache invalidation is fragile, which is why tools like `nodemon` prefer restarting the entire process.

```js
delete require.cache[require.resolve('./myModule')];
const fresh = require('./myModule');
```

The first line removes the cached module object. The second line triggers a full resolution and load, as if the module had never been required before.

## Debugging resolution

When a module won't resolve and you can't figure out why, there are a few built-in tools.

`require.resolve()` is the first thing to try. If it throws, the module truly can't be found from that location. If it returns a path you didn't expect, you've found your problem - maybe a different version is being picked up from a higher-level node_modules.

`Module._nodeModulePaths(process.cwd())` shows you exactly which directories would be searched from the current working directory:

```js
const Module = require('module');
console.log(Module._nodeModulePaths(process.cwd()));
```

And `require.resolve.paths('some-pkg')` shows the search paths for a specific specifier, including NODE_PATH and global directories.

For more visibility, the `DEBUG` environment variable doesn't help here (that's a userland convention). But you can monkey-patch `Module._findPath` to log every probe:

```js
const Module = require('module');
const orig = Module._findPath;
Module._findPath = function(request, paths, isMain) {
  console.log('findPath:', request, paths);
  return orig.call(this, request, paths, isMain);
};
```

That's hacky, but it works. You'll see every specifier and every directory list that the algorithm considers. In production you'd never do this, but for debugging a gnarly resolution issue in development, it's faster than reading stack traces.

There's another approach that's less invasive. Node's `-require` flag combined with a small diagnostic module can intercept and log resolution without modifying application code. Or you can use `node -print "require.resolve('some-pkg')"` from the command line to test resolution from a specific directory.

One more trick: `NODE_DEBUG=module` enables verbose logging of the module system's internals. Set this environment variable and Node prints detailed messages about every module load, resolution path, and cache check to stderr. The output is verbose - hundreds of lines for a typical application - but it shows you exactly what the runtime is doing.

```bash
NODE_DEBUG=module node app.js 2>&1 | head -20
```

The output includes lines like `MODULE: looking for "./utils" in ["/home/app/src"]` and `MODULE: load "/home/app/src/utils.js" for module "."`. Grep through it for your specific module specifier and you'll see every step the algorithm took.

## Edge cases worth knowing

**Self-referencing:** Starting in Node 13.1, a package can `require()` itself by name if it has an `"exports"` field. So inside a file belonging to `my-pkg`, `require('my-pkg')` resolves through the package's own `"exports"` map. Without `"exports"`, self-referencing produces a `MODULE_NOT_FOUND` error. This feature exists mainly for packages with subpath exports - it lets internal code use the same public API paths that consumers use.

**The `"type"` field:** The `"type"` field in package.json (`"commonjs"` or `"module"`) affects whether `.js` files are treated as CJS or ESM. But for `require()` resolution specifically, it doesn't change the algorithm. The resolution is the same; only the loader behavior after resolution changes. A `require()` call in CJS ignores the `"type"` field entirely - it always treats `.js` as CJS.

**Circular references in resolution:** Resolution itself doesn't have circular reference problems. The circularity issue with `require()` happens during *loading* (module A requires module B which requires module A), and even then Node handles it by returning a partially-constructed exports object. But the resolution step - turning a string into a path - always terminates because it's a finite filesystem traversal.

**Case sensitivity:** On case-insensitive filesystems (macOS's default HFS+/APFS configuration, Windows NTFS), `require('./Utils')` and `require('./utils')` resolve to the same file. But the module cache key preserves the original casing from the `fs.realpathSync()` result. If the actual filename is `utils.js` and you write `require('./Utils')`, the realpath returns `utils.js`, so the cache works correctly. But if you deploy code from macOS to Linux (case-sensitive ext4), `require('./Utils')` suddenly fails because there's no `Utils.js` - only `utils.js`. This is a common source of "works on my machine" bugs.

**package.json without a name:** A package.json without a `"name"` field is fine for resolution purposes. The `"main"` and `"exports"` fields work regardless. The `"name"` field matters for npm publishing and for the self-referencing feature, but the resolution algorithm only cares about `"main"`, `"exports"`, and `"imports"`.

**Relative specifiers and ESM vs CJS context:** In a CJS file, `require('./foo')` probes extensions. In an ESM file, `import './foo'` does *not* probe extensions - you must provide the full filename with extension. The resolution algorithm for CJS and ESM differs in meaningful ways, and we'll cover the ESM side in the next subchapter. For now, everything described here applies specifically to `require()` resolution.

**Multiple package.json files:** A project can have package.json files at many levels of the directory tree. The one that matters for a given `require()` call depends on context. For bare specifier resolution, the package.json inside the resolved `node_modules` directory is what's read. For `"imports"` resolution, the nearest package.json above the calling file is used. These are different lookups, and they can return different package.json files. In monorepo setups where nested packages have their own package.json files, this distinction becomes relevant for getting the right configuration scope.
