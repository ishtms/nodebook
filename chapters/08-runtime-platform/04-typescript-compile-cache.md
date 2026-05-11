---
title: "TypeScript Execution and Compile Cache"
date: "2026-05-11"
excerpt: "How Node v24 runs a limited subset of TypeScript directly, where type stripping stops, and what the module compile cache stores between process starts."
category: "Runtime Platform APIs & Tooling"
tags: ["nodejs", "typescript", "type-stripping", "compile-cache", "runtime"]
author: "Ishtmeet Singh @ishtms"
chapter: "runtime-platform"
subchapter: "typescript-compile-cache"
published: true
toc: true
---

Node's TypeScript path starts by erasing syntax the runtime can ignore. A `.ts` file can reach the normal module loader after Node removes annotations, interfaces, and other type-only text. 

The executable JavaScript is what remains.

```ts
interface Config {
  port: number;
}

const config: Config = { port: 3000 };
console.log(config.port);
```

Run that file with Node v24 and the output is `3000`. No build command. No generated `.js` file on disk. Node reads the TypeScript source, removes the type-only syntax it knows how to erase, and sends the remaining JavaScript into the normal module path.

That path has a narrow contract. TypeScript type stripping is Node's built-in source preparation step that removes TypeScript annotations while preserving the JavaScript program. Strip-only mode is the default form of that support: Node erases inline types and keeps byte offsets stable by replacing stripped text with whitespace. The TypeScript type checker stays outside that runtime path. `tsc` can reject a program that Node still runs because Node is preparing executable JavaScript; proof of the type model belongs to the checker.

```ts
const port: number = '3000';
console.log(port + 1);
```

Node runs that and prints `30001`. The annotation disappears. The string stays. Runtime semantics win because the executable program still assigns a string.

That boundary is the whole chapter. Node can remove syntax that has no runtime meaning. Node needs a transform when TypeScript syntax would have to become new JavaScript. Some files run. Some fail before evaluation. Imports need real runtime targets. And after the source has been prepared, the module compile cache can store V8 compilation data for later process starts.

## The Stripping Boundary

TypeScript puts two kinds of information in a file.

Some syntax exists only for the type system. A parameter annotation, a return annotation, an interface, a type alias, a type assertion, and a type-only import can disappear without changing the JavaScript operations that remain. Erasable TypeScript syntax is that category: syntax Node can delete because the runtime program has the same executable shape after removal.

```ts
type UserId = string;

function loadUser(id: UserId): Promise<UserId> {
  return Promise.resolve(id as string);
}
```

`type UserId = string` disappears. `: UserId` disappears. `as string` disappears. The function body still returns `Promise.resolve(id)`. There is no runtime object named `UserId`, and Node has nothing to emit for it.

Strip-only mode keeps that operation intentionally small. Node parses the TypeScript source well enough to identify erasable syntax. Then it replaces the erased regions with whitespace instead of reprinting the file. That whitespace detail matters. Stack traces and syntax locations can still point at useful columns because the source length and line structure mostly stay in place. Pure stripping preserves locations directly, so the default path runs without a source map.

The whitespace replacement also explains why the feature feels different from a compiler. A compiler usually produces a new output program. It may change spacing, normalize syntax, lower newer constructs, move helpers, rewrite imports, and produce a source map that connects the emitted file back to the original. Node's default TypeScript path is smaller than that. The source is still the source. The JavaScript grammar receives almost the same text, minus the TypeScript-only regions.

That choice keeps the runtime path cheap to understand. The parser sees enough TypeScript to know what to remove. The loader then sends prepared JavaScript into the same CommonJS or ESM machinery that would have handled a JavaScript file. No project graph is built. No declaration files are read. No `tsconfig.json` inheritance chain is followed. The current file is prepared for execution.

There is one consequence people miss: type-level mistakes can sit next to runtime success.

```ts
function listen(port: number) {
  console.log(port.toFixed(0));
}

listen('3000' as any);
```

Node strips `: number` and `as any`, then runs the call. The runtime receives a string and throws when `toFixed` is missing. A type checker could catch the bad call earlier if the project avoids `any`, but Node is already past that layer. Direct TypeScript execution is useful for execution. The project's type-quality gate remains the checker in editor, test, or CI flow.

`--no-strip-types` turns the feature off.

```bash
node --no-strip-types app.ts
```

With stripping disabled, a `.ts` file containing TypeScript syntax reaches the JavaScript parser as-is and fails on syntax JavaScript cannot parse. That flag is useful when a wrapper wants to prove no direct TypeScript execution is happening, or when a tool owns TypeScript transformation and wants Node to treat stray `.ts` input as an error.

The companion compiler option `erasableSyntaxOnly` belongs on the TypeScript side. It asks TypeScript to reject transform-required syntax during checking, which gives editor and CI feedback before Node sees the file. Node ignores the option at runtime. The value is still useful because it lines up the developer feedback loop with Node's strip-only execution boundary.

The parser still has to understand the file. Bad JavaScript is bad JavaScript. Unsupported TypeScript syntax is a different failure: the source is valid TypeScript, but Node would need to generate JavaScript for it. In strip-only mode, Node reports that boundary with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`.

```ts
enum Level {
  Info = 1,
  Warn = 2,
}

console.log(Level.Warn);
```

An enum has runtime output in JavaScript. TypeScript normally emits an object-like structure for it. Deleting the declaration would change the program because `Level.Warn` needs a value. That makes `enum` transform-required TypeScript syntax. Node rejects it in the default path.

Parameter properties have the same shape problem.

```ts
class User {
  constructor(public id: string) {}
}

console.log(new User('42').id);
```

The `public id: string` parameter is also a field declaration and an assignment. JavaScript needs emitted code to store `id` on the instance. Strip-only mode has no emitted assignment to keep, so Node reports unsupported syntax.

Namespaces split in two. A namespace that contains only types can disappear. A namespace that creates runtime values requires emitted JavaScript. Import aliases and some older TypeScript-only constructs land on the same side of the line. The exact list belongs to Node's TypeScript parser and can move as Node updates it, but the working model is stable enough: if deletion preserves the executable JavaScript, stripping can work; if JavaScript must be generated, stripping stops.

`--experimental-transform-types` asks Node to cross part of that line.

```bash
node --experimental-transform-types level.ts
```

In Node v24, that flag enables transformation for supported TypeScript syntax that needs emitted JavaScript, such as enums and parameter properties. Node also prints an `ExperimentalWarning` for the flag. Treat it as a runtime convenience for controlled cases. Project compilation still belongs to tools that own checking, declaration emit, downlevel compilation, path aliasing, JSX, and build output.

The flag name is blunt on purpose. Stripping removes. Transforming emits. Once Node emits JavaScript, it has to make choices about output shape and source mapping, and that belongs to a bigger toolchain for many projects. Built-in runtime support stays useful because it handles the small case directly: scripts, local tooling, config files, and services that already target modern JavaScript and use TypeScript mostly for annotations.

Decorators sit outside this path in a different way. They depend on JavaScript language support and TypeScript transform behavior. If a TypeScript file uses decorator syntax under a Node version where the JavaScript parser rejects that syntax, the failure may appear as a parser error rather than `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. The practical answer is the same: that file needs a transform toolchain.

The shortest rule is file-local. Open the file and remove every type-only token by hand in your head. If the remaining text is valid modern JavaScript with the same runtime behavior, Node's default path probably handles it. If some TypeScript declaration would need to create a value, assign a property, rewrite an import, or lower syntax for older JavaScript, use a transform path.

## Files Choose Module Shape

TypeScript execution still enters the module system.

`.ts` is the flexible entrypoint. A `.ts` entrypoint has its module shape decided the same way a `.js` file does. The nearest package boundary can mark it as ESM with `"type": "module"`, or leave it as CommonJS with `"type": "commonjs"` or no package marker. Chapter 6 already covered the package `"type"` field; TypeScript stripping adds a source preparation step before the selected loader compiles the prepared JavaScript.

```json
{
  "type": "module"
}
```

With that package file nearby, `node app.ts` treats `app.ts` as ESM if the source uses module syntax. In a package with CommonJS defaults, a `.ts` file follows the same detection and package rules as `.js` under the current Node version. The `.ts` extension chooses TypeScript preparation; package rules and file syntax choose module shape.

That means a `.ts` file can change behavior when it moves across a package boundary.

```text
tools/app.ts
package.json
packages/api/package.json
packages/api/app.ts
```

If the root package marks `"type": "module"` and `packages/api/package.json` marks `"type": "commonjs"`, the two `app.ts` files inherit different defaults. The `.ts` extension only says TypeScript stripping may run. The package boundary still decides the JavaScript module shape for ambiguous TypeScript files.

Syntax detection can also matter for ambiguous input in modern Node. A file that contains ESM syntax pushes Node toward ESM handling under the documented detection rules. A service entrypoint should avoid depending on surprise detection. Use `.mts`, `.cts`, or an explicit package `"type"` field when the module shape is part of the contract.

`.mts` and `.cts` remove the ambiguity.

```bash
node server.mts
node worker.cts
```

A `.mts` entrypoint is an ES module entrypoint. A `.cts` entrypoint is a CommonJS entrypoint. Those extensions mirror `.mjs` and `.cjs`, with TypeScript stripping added before compilation. Use them when the file's module shape should survive package movement or a future package boundary edit.

The extension applies to dependencies in the graph too. An ESM `.mts` file can import another `.mts` file. A CommonJS `.cts` file can `require()` another `.cts` file. Mixed graphs still follow the CJS/ESM interop rules from Chapter 6. TypeScript stripping prepares source for the existing CommonJS or ESM loaders.

`.tsx` is outside the built-in path. An unsupported `.tsx` entrypoint reaches Node's TypeScript support and fails because Node's runtime TypeScript support is not a JSX execution environment. Use a compiler, bundler, or third-party runner for that shape.

That boundary is useful for backend codebases. A server-side script named `.ts` can usually avoid build output. A React component in `.tsx` needs JSX handling, and JSX handling is a transform. Keeping `.tsx` unsupported prevents direct runtime execution from pretending it owns a frontend build pipeline.

Node also keeps the module syntax intact. It strips types, then hands the remaining source to the selected CommonJS or ESM loader.

```ts
import { readFile } from 'node:fs/promises';

const text: string = await readFile('data.txt', 'utf8');
console.log(text.length);
```

That file needs ESM module shape because it uses static `import` and top-level `await`. Type annotations can disappear, but the module form remains. If the file is treated as CommonJS, the module parser rejects the syntax or Node selects a different loading path according to its normal rules. TypeScript support does not paper over that boundary.

CommonJS TypeScript works too.

```ts
const path = require('node:path');

const file: string = path.join('logs', 'app.log');
module.exports = { file };
```

After stripping, that file is ordinary CommonJS source. `Module._compile()` still wraps and compiles it. `Module._cache` still caches the evaluated module value. Type stripping changes the source bytes that the existing loaders receive.

The CJS path has one sharp edge with ESM habits: static `import` syntax belongs to ESM, even in a TypeScript file. A `.cts` file with static `import` syntax is asking CommonJS to parse ESM syntax. TypeScript can sometimes rewrite that during compilation. Node's strip-only path leaves module syntax as written. Use CommonJS syntax in `.cts`, or make the file ESM with `.mts` or package metadata.

The extension also affects relative specifiers. Node wants the real file extension in TypeScript imports.

```ts
import { readConfig } from './config.ts';

console.log(readConfig().port);
```

Write `./config.ts`. Node's resolver works with runtime files. The TypeScript compiler can type-check extension-bearing imports when configured for that, but Node ignores `tsconfig.json` during runtime stripping. The runtime sees the specifier string in the source. If the specifier points nowhere, resolution fails before evaluation.

That rule also applies to `require()`.

```ts
const config = require('./config.cts');

console.log(config.port);
```

CommonJS has historical extension probing for JavaScript files, but Node's TypeScript documentation tells you to include the TypeScript extension for TypeScript files. Use the exact file. Direct TypeScript execution is already depending on Node-specific runtime behavior, so hiding the extension buys little and creates resolver ambiguity.

When you publish JavaScript output, the specifiers need to match the emitted files. A source file that imports `./config.ts` for direct execution cannot be copied unchanged into `dist/app.js` unless `dist/config.ts` also exists and the runtime is meant to strip it. That is where `rewriteRelativeImportExtensions` helps on the compiler side. The direct-run source names `.ts`; the emitted JavaScript names `.js`.

## Imports That Exist Only For Types

A common failure starts with an import that looks normal to TypeScript and becomes wrong at runtime.

```ts
import { UserRecord, readUser } from './user.ts';

const user: UserRecord = readUser('42');
console.log(user.id);
```

If `UserRecord` is only an interface or type alias in `user.ts`, the runtime module has no export named `UserRecord`. TypeScript may be happy because the name exists in the type namespace. Node is loading an executable module graph, so the import list names runtime bindings unless the source marks a binding as type-only.

The fix is explicit.

```ts
import { type UserRecord, readUser } from './user.ts';

const user: UserRecord = readUser('42');
console.log(user.id);
```

A type-only import/export is syntax that tells TypeScript and Node the binding belongs to the type layer. Node can erase it during stripping. The runtime import list keeps only `readUser`. ESM linking then validates a binding that actually exists.

Exports have the same split.

```ts
export type { UserRecord } from './user.ts';
export { readUser } from './user.ts';
```

The first line disappears during stripping. The second line survives and participates in runtime linking. A barrel file that re-exports types and values needs to mark the type side explicitly, because Node has to build an executable module graph from the stripped file.

Default type imports need the same treatment.

```ts
import type Config from './config-type.ts';

const config: Config = { port: 3000 };
console.log(config.port);
```

If `Config` is an interface exported as a default type, a plain `import Config from './config-type.ts'` asks ESM linking for a default runtime export. The module has none. `import type` makes the import disappear before linking.

The failure often appears late in a migration because TypeScript can infer when an import is only used as a type. Older compiler settings often removed those imports during JavaScript emit. Direct Node execution runs the source text through Node's stripper rather than the TypeScript emitter, so the source text needs to say which names are type-only. That is why `import type` is more than style here. It is runtime input.

`verbatimModuleSyntax` is the TypeScript compiler option that keeps this discipline honest. With it enabled, TypeScript preserves your import/export syntax instead of rewriting imports based on how names are used. That matches Node's runtime view: imports that should disappear need the `type` marker in the source. The compiler option lives in `tsconfig.json`; Node still ignores the file during execution. The value is for development feedback.

The option also reduces drift between dev and runtime. If TypeScript silently rewrites imports during checking or emit, the checked graph may differ from the graph Node loads directly. `verbatimModuleSyntax` pushes that difference back into the source. You either wrote a runtime import or you wrote a type-only import. Node then sees the same distinction.

`rewriteRelativeImportExtensions` is another compiler-side helper. It tells TypeScript to rewrite relative TypeScript extensions when emitting JavaScript, so `./config.ts` can become `./config.js` in build output. For Node's direct execution path, the `.ts` extension is the runtime file and should appear in the import. For emitted JavaScript, the emitted file extension should appear. That split is why many projects use one config for direct TypeScript scripts and another for distributable build output.

There is a smaller trap with `exports` maps. A package can expose runtime files through package subpaths while source files use relative `.ts` imports internally. Node will honor the package's `"exports"` field during package resolution, while TypeScript path aliases remain compiler-side configuration. If the specifier begins with `.` or `/`, it is a path. If it is bare, it is a package or built-in specifier. TypeScript path configuration leaves those runtime categories unchanged.

Path aliases stay outside the built-in runtime path.

```ts
import { loadConfig } from '@app/config';

console.log(loadConfig().port);
```

If `@app/config` is only a `tsconfig.json` path alias, Node treats it as a package-style specifier and runs normal module resolution. It finds a package or import map entry, or it fails. Node's built-in type stripping ignores `compilerOptions.paths`. A third-party runner, loader, or bundler can add that behavior. The built-in path keeps resolution as Node resolution.

There is a clean rule for direct execution: every runtime import in the stripped file needs to resolve under Node's normal module resolver, and every type-only binding needs the `type` marker so it disappears before linking.

That rule is boring. Good. Boring import rules make runtime failures easier to localize. A failed direct TypeScript run should leave you with one of a few layers: stripping rejected the syntax, resolution missed a runtime file, linking missed a runtime export, or evaluation threw. Hidden compiler rewrites blur those layers.

## Eval, Print, And Stdin

File extensions carry module shape for disk files. String input has no extension. That is where the TypeScript `--input-type` values come in.

```bash
node --input-type=module-typescript \
  --eval "const n: number = 1; console.log(n)"
```

`--input-type=module-typescript` tells Node to treat `--eval` or stdin source as TypeScript with ESM semantics. The annotation is stripped, then the remaining module source runs. Top-level `await` belongs to the module shape, so it works in this mode.

The command-line string is still source text. Shell quoting happens before Node receives it. If the snippet contains quotes, newlines, or shell metacharacters, the shell can change the final string. That is a shell boundary, not a TypeScript boundary. When an eval command behaves oddly, inspect the exact argument vector or move the snippet into stdin.

CommonJS string input has its own value.

```bash
printf "const n: number = 1; console.log(n)\n" \
  | node --input-type=commonjs-typescript
```

`--input-type=commonjs-typescript` tells Node to strip TypeScript syntax and run the result as CommonJS. That is useful for shell probes and small generated scripts where writing a temporary file would add noise.

`--print` belongs with the CommonJS TypeScript input type. The printed value is the result of evaluating the expression or script under that selected mode.

```bash
node --input-type=commonjs-typescript \
  --print "const x: number = 2; x * 10"
```

Node strips the annotation, evaluates the CommonJS-style input, and prints `20`. `--input-type=module-typescript --print` reports `ERR_EVAL_ESM_CANNOT_PRINT` because printed expression output is a CommonJS-style CLI probe.

The flag belongs to string entrypoint modes. Disk files use extension and package-boundary rules.

```bash
node --input-type=module-typescript app.ts
```

Node accepts that command, then the file entrypoint stays in control. `--input-type` is for string input. With a disk file, Node uses the file extension and package-boundary rules instead. Passing `--input-type=module-typescript` before `app.ts` leaves `app.ts` on the file-entrypoint path.

Flag position still matters.

```bash
node app.ts --no-strip-types
```

`--no-strip-types` appears after the entrypoint, so it is an application argument. Node has already selected `app.ts` as the program. To disable stripping, the flag must appear in Node's option region:

```bash
node --no-strip-types app.ts
```

`NODE_OPTIONS` can also carry that setting because Node reads it before command-line option parsing. A service wrapper that exports `NODE_OPTIONS="--no-strip-types"` can make direct TypeScript execution fail even when the visible command is just `node app.ts`. Startup bugs in this area often reduce to the same trace from the CLI chapter: identify the layer that consumed the flag.

Resolve that as a startup-state trace. Environment variables enter first. Node options come next. The entrypoint mode decides whether `--input-type` can apply. The file extension or package boundary chooses module shape for disk files. Then TypeScript preparation runs, if enabled for that file. Keeping those decisions ordered prevents most CLI confusion around `.ts` execution.

## Dependencies Under `node_modules`

Node refuses to strip TypeScript inside `node_modules`.

That failure is deliberate. The built-in TypeScript path is for application-controlled source, scripts, and local tooling. Published dependencies are expected to provide executable JavaScript. If Node started erasing TypeScript from dependency packages by default, dependency execution would depend on the consumer's Node version and TypeScript parser behavior. Package authors would also be tempted to publish source that only works under one runtime stripping implementation.

The error code is explicit: `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`.

```text
node_modules/some-package/index.ts
```

If an import resolves to that file and Node's built-in type stripping would be needed, Node stops with that error. The fix belongs at the package boundary. Consume JavaScript output. Ask the package to publish executable files. Or choose a toolchain that owns TypeScript transformation for dependencies. Node's built-in runtime path keeps the dependency contract boring: dependency packages should already be runnable by Node.

The rule applies even when the TypeScript syntax is erasable. A dependency file under `node_modules` with only annotations still triggers the restriction if Node would need the type-stripping path. The syntax category is secondary. The package boundary is the policy.

That also means a local workspace can surprise you. A symlinked package, a package manager workspace, or a vendored dependency can still land under a `node_modules` path in the resolved URL. The restriction follows the resolved file location, not your intent. When the error appears, inspect the final resolved path before changing flags.

The practical packaging answer is old and boring: publish JavaScript. Include types for the checker if the package supports TypeScript consumers. Keep source TypeScript in the repository if you want. The runtime artifact should be JavaScript unless the consumer has explicitly opted into a tool that transforms dependencies.

## Failure Order

Direct TypeScript execution becomes easier to debug when you keep the failure layers separate.

Node reaches the layers in order. Startup flags are parsed before source selection. Module resolution runs before source preparation for a resolved file. TypeScript stripping runs before JavaScript compilation. ESM linking runs before evaluation. The compile cache, when enabled, participates around compilation. Each layer has its own error shape.

Start with source selection.

```bash
node --input-type=module-typescript \
  --print "const n: number = 1; n"
```

That fails before TypeScript syntax matters because the CLI selected printed expression output with ESM input. Node reports `ERR_EVAL_ESM_CANNOT_PRINT` during entrypoint handling. No file has resolved. No stripping has happened.

A missing file sits at the resolver layer.

```ts
import { readConfig } from './missing.ts';

console.log(readConfig());
```

Node can parse the importer enough to discover the static import, then resolution fails because the target file is absent. The error is about the specifier and resolved URL. Changing `import type` would be wrong here because `readConfig` is a runtime binding. The target has to exist as an executable module.

Unsupported TypeScript syntax sits at source preparation.

```ts
enum Mode {
  Dev,
  Prod,
}
```

In strip-only mode, Node reports `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. Resolution already found the file. The loader reached TypeScript preparation. The file still has transform-required syntax. Adding the compile cache changes nothing because compilation never receives prepared JavaScript for that file.

A value import that names only a type usually fails during ESM linking.

```ts
import { Settings } from './settings.ts';

const settings: Settings = { port: 3000 };
console.log(settings.port);
```

If `Settings` is an interface, the annotation can be stripped, but the import still asks for a runtime export named `Settings`. ESM linking validates exports across module records and rejects the graph. The correct source uses `import type { Settings } ...` so the import disappears during preparation.

Runtime exceptions come last.

```ts
const port: number = JSON.parse('"3000"');
console.log(port.toFixed(0));
```

The syntax is erasable. The file compiles. Linking succeeds. Evaluation then throws because the runtime value is a string. TypeScript could report a type problem in a separate check depending on how the code is written, but Node has done its job: it prepared and executed JavaScript.

That order also explains weird cache observations. A program can populate compile-cache files and still fail later during linking or evaluation. A program can fail during stripping and create no useful V8 code-cache artifact for that module. A program can get a compile-cache hit and still throw every time. The cache helps one layer. It never changes the next layer's rules.

When a direct `.ts` run fails, classify the error before changing tools. A resolver error wants a real specifier. A stripping error wants erasable syntax or a transform path. A linking error wants runtime exports to match runtime imports. An evaluation error wants ordinary JavaScript debugging. A type-checking error from `tsc` belongs to the checker and may have no runtime symptom at all.

## Programmatic Stripping

`node:module` exposes the stripping operation directly.

```js
import { stripTypeScriptTypes } from 'node:module';

const code = 'const port: number = 3000;';
console.log(stripTypeScriptTypes(code));
```

`module.stripTypeScriptTypes()` accepts a source string and returns JavaScript text with TypeScript types stripped. The default mode is `'strip'`, matching the runtime's erasable-syntax path. It throws when the code contains transform-required syntax, such as an enum.

In Node v24, this API also prints an `ExperimentalWarning`. The runtime file-stripping path is stable, while this helper API is still release-candidate.

The returned string preserves locations in strip mode by leaving whitespace behind.

```js
const js = stripTypeScriptTypes('const a: number = 1;');
console.log(js);
```

The output still has space where `: number` used to sit. That behavior is useful when the next step is `vm.compileFunction()` or another execution path that reports positions against the prepared source. It is awkward if you expected pretty output. Pretty output is a compiler job.

The API is useful when your program already owns source text and wants Node's parser to prepare it before passing it to a lower-level execution API. It is not a compiler replacement. It does not type-check. Its output is documented as unstable across Node versions because parser and printer details can change. Persisting that output as part of a build artifact ties the artifact to Node's implementation details.

Source URLs are a small diagnostic hook.

```js
stripTypeScriptTypes(source, {
  mode: 'strip',
  sourceUrl: 'virtual.ts',
});
```

Node appends a source URL comment so stack traces and tooling can name the virtual source. In strip mode, `sourceMap: true` is invalid because the stripped output preserves locations by construction. In transform mode, source maps can exist because emitted JavaScript may no longer line up with the input text.

Transform mode exists here too.

```js
stripTypeScriptTypes(source, {
  mode: 'transform',
  sourceMap: true,
});
```

With `mode: 'transform'`, Node can emit JavaScript for supported transform-required syntax and can generate a source map. That is a different contract from whitespace-preserving stripping. The moment you ask for generated JavaScript, output shape matters. For application builds, `tsc`, a bundler, or a TypeScript-aware runner remains the place to own that decision.

The programmatic API also clarifies the runtime order. TypeScript support is a source-preparation step. It happens before JavaScript compilation, linking, and evaluation. Once the source has been prepared, the rest of Node's loaders do the work they already did for JavaScript files.

That makes the API a sharp fit for small controlled tools: a config runner, a migration script, a code-generation helper that needs to execute user-owned TypeScript snippets. It is a poor fit for project-wide compilation because project-wide compilation needs graph awareness, checker state, output policy, and usually declaration behavior. The API takes one string.

## The Compile Cache Path

The module compile cache stores V8 compilation data on disk.

That sentence is the most useful guardrail. A module value cache keeps the evaluated result of a module inside one process. For CommonJS, Chapter 6 covered `Module._cache`: after a module evaluates, later `require()` calls in the same process get the cached `exports` object. For ESM, the module map keeps module records and evaluation state for the current process.

The module compile cache sits at a different layer. It persists V8 code cache data on disk so a later Node process can compile the same module source faster. V8 code cache is serialized compilation output associated with source text and runtime details. It can help V8 skip part of parsing or bytecode generation for code it has already seen under compatible conditions. The result of running your module remains process-local evaluation state.

That distinction matters more with TypeScript because people hear "cache" and expect the stripped JavaScript to be cached as a build output. The compile cache is lower and narrower. Node prepares the source, V8 compiles it, and V8 can serialize code-cache data. The cache directory contains private Node/V8 data rather than generated JavaScript.

Here is the path as a compact trace:

```text
resolve specifier
  -> load source
  -> strip or transform TypeScript
  -> compile prepared JavaScript
  -> link if ESM
  -> evaluate module
```

The compile cache participates in the compile step. The TypeScript source-preparation step has already accepted or rejected the file. Resolution has already found a file. For ESM, link-time export validation still has to finish before evaluation can run.

Trace a `.ts` ESM file through the path.

```ts
import { readConfig } from './config.ts';

const config: { port: number } = readConfig();
console.log(config.port);
```

Node resolves the entrypoint. The loader reads the source. TypeScript stripping removes the annotation. The prepared JavaScript still has an import. Node resolves and loads `./config.ts`, prepares that source too, and hands prepared JavaScript source into V8 compilation. With the compile cache enabled, Node can look for V8 code-cache data for each compiled CommonJS, ESM, or TypeScript module.

For ESM, V8 compilation creates module records from the prepared source. Linking then validates imported and exported bindings across those records. Evaluation runs after successful linking. That ordering matters because the compile cache can participate before a missing export kills the graph. A cached compilation artifact targets compilation work while import validity remains a linking concern.

Missing exports are a good test case. Suppose `app.ts` imports `{ missing }` from `ok.ts`, and `ok.ts` exports only `present`. Node may still compile both prepared module records and produce code-cache data before ESM linking reports the absent binding. The next run can reuse compilation data and still fail with the same linking error. The cache improved nothing visible because the program is invalid at a later layer.

CommonJS has a different loader shape, but the same cache layer appears after source preparation.

```ts
const config: { port: number } = require('./config.cts');
console.log(config.port);
```

Node strips the type annotation, wraps the prepared source for CommonJS, and compiles it. With the compile cache enabled, that compile can use or produce on-disk V8 code-cache data. After evaluation, `Module._cache` holds the module's exported value for the current process. On the next process start, `Module._cache` begins empty again, while the disk compile cache may already contain compilation data from the previous run.

Inside one process, `Module._cache` usually hides repeated CommonJS compilation because a second `require()` returns the same evaluated `exports` object. The compile cache helps across processes, where `Module._cache` starts empty. CLIs, short-lived scripts, serverless-style launchers, and test workers can benefit more than a long-running service that starts once and stays alive.

ESM has similar process-local state through the ESM module map. A second static import or later `import()` call for the same resolved module in one process reuses the existing module record and evaluation state. On a fresh process start, that map is empty. The compile cache can still have V8 data on disk.

So there are three separate states:

- source preparation state: TypeScript annotations removed or transform-required syntax rejected
- compilation state: V8 parses and compiles prepared JavaScript, with optional on-disk code-cache help
- evaluation state: module code runs and produces process-local module state

Those states explain the cache misses that feel confusing at first.

A compile cache hit still runs the module. Top-level side effects run again on every process start. A missing file still fails during resolution. A missing ESM export still fails during linking. A thrown error still tears through evaluation. A type error from the TypeScript type checker still belongs to a separate tool, so the compile cache has no opinion about it.

Top-level side effects are worth calling out because startup optimization sometimes hides the wrong concern. If `config.ts` opens a socket, mutates a database, or logs a startup record at top level, the compile cache may reduce compilation time before the side effect. The side effect still runs during evaluation.

The cache key details are implementation details. Node's docs are explicit about that. Cache files are usually reusable only under the same Node version, and different Node versions keep separate cache data under the same base directory. Absolute paths can participate in invalidation unless portable cache mode is enabled. Source content changes invalidate the useful artifact because V8 code cache has to match the source it was generated from.

Node also has to protect correctness when cache data goes stale. V8 code cache is tied to source and engine details. If those details stop matching, Node compiles normally and can write newer cache data later. A stale compile cache should cost time and disk while preserving program behavior. If deleting the cache directory changes the result of your program, the cache is exposing a bug somewhere else in the launch setup.

There is also a timing detail. Node v24 generates code-cache data when a module is loaded fresh, but writes accumulated data to disk when the process is about to exit. `module.flushCompileCache()` forces a flush earlier. That matters for parent processes that spawn child Node processes and want children to reuse cache data before the parent exits.

The exit-time write means a process that crashes hard may leave less cache data behind. A normal exception that Node handles during shutdown may still allow exit work, depending on how the process ends. A `SIGKILL` gives Node no JavaScript-level cleanup path. Treat the cache as opportunistic performance data.

The first process can get slower. It has extra cache generation and disk work. Later process starts may get faster if they load the same module graph under compatible conditions. "May" is doing real work there. Startup time depends on file I/O, module graph size, CPU, storage, invalidation, and how much time the app spends outside JavaScript compilation. Measure before treating the cache as a performance fix.

TypeScript can make the cache more appealing for scripts because the path includes both source preparation and compilation. Still, the compile cache stores V8 compilation data after source preparation. If stripping itself dominates, or if module resolution and file reads dominate, the cache may move the needle less than expected.

## Enabling The Compile Cache

The programmatic switch lives in `node:module`.

```js
import module from 'node:module';

const result = module.enableCompileCache();
console.log(result);
```

`module.enableCompileCache()` enables the module compile cache for the current Node instance. Called with no directory, it uses `NODE_COMPILE_CACHE` if that environment variable is set. Otherwise it defaults to a directory under the operating system temp directory. The returned object includes a `status` value and, when enabled, a `directory`.

The method is designed to report failure instead of throwing. That shape is intentional. A compile cache is an optimization. If the directory cannot be created, is read-only, or is disabled by environment, the application should usually keep starting. The returned object gives launch code enough information to log diagnostics without turning cache setup into a fatal dependency.

Production launchers should branch on `status`.

```js
import module from 'node:module';

const { compileCacheStatus } = module.constants;
const result = module.enableCompileCache();

if (result.status === compileCacheStatus.FAILED) {
  console.warn(result.message);
}
```

Compile-cache status is the integer result code returned by `enableCompileCache()`. `ENABLED` means the current call turned it on. `ALREADY_ENABLED` means an earlier call or `NODE_COMPILE_CACHE` already enabled it. `FAILED` means Node tried and could not enable it. `DISABLED` means `NODE_DISABLE_COMPILE_CACHE=1` blocked it. Diagnostic text can appear when the cache is unavailable, so status is the control field and `message` is supporting evidence.

That status-first handling also helps with repeated setup. A preload can enable the cache before the entrypoint. The entrypoint might call `enableCompileCache()` again. `ALREADY_ENABLED` is a successful state. Use the returned directory if your code needs to pass the location to child processes.

The environment form is simpler for service startup.

```bash
NODE_COMPILE_CACHE=/var/tmp/node-compile-cache node server.ts
```

`NODE_COMPILE_CACHE` enables the cache before application code runs and chooses the base directory. That is usually cleaner than putting an `enableCompileCache()` call in application code, especially when the goal is startup behavior across scripts, CLIs, and services.

Environment setup also reaches preloads. If you enable the cache from application code, every preload has already been loaded and compiled. If you enable it with `NODE_COMPILE_CACHE`, preloads can participate because Node sees the environment variable during startup. For tooling that uses `--require` or `--import` heavily, that ordering can matter.

Programmatic setup still has a place. A CLI can call `enableCompileCache()` before it imports the rest of its command graph.

```js
import module from 'node:module';

module.enableCompileCache();
await import('./cli-main.ts');
```

That shape gives the cache a chance to cover `cli-main.ts` and everything loaded after it. Static imports at the top of the same file would run before the call, because ESM dependencies are loaded and linked before the module body executes. Put the call in a tiny bootstrap file when ordering matters.

CommonJS has a more direct bootstrap shape.

```js
const moduleApi = require('node:module');

moduleApi.enableCompileCache();
require('./cli-main.cts');
```

Here the call runs before the later `require()`. That makes CommonJS bootstrap code a compact place to enable the cache for a larger command graph. The same principle applies either way: enable before loading the modules you want covered.

The directory should be disposable. Node can recreate it. Removing stale cache data is a valid cleanup strategy. A temp directory is usually a better fit than a project source directory because cache layout is Node-owned and version-specific.

Permissions still matter. The process user needs enough access to create directories and files under the chosen base path. A read-only filesystem, a locked-down service account, or a container image path used as a cache directory can turn setup into `FAILED`. The application can continue, but the returned status should make the misconfiguration visible in logs.

You can inspect the active directory.

```js
import module from 'node:module';

module.enableCompileCache();
console.log(module.getCompileCacheDir());
```

`module.getCompileCacheDir()` returns the active compile-cache directory. It returns `undefined` while the cache is disabled or still inactive. That makes it useful for diagnostics and child-process setup.

Child Node processes are separate instances. The compile cache setting is process-local unless inherited through environment. If a parent calls `enableCompileCache()` and then spawns `node child.ts`, the child needs `NODE_COMPILE_CACHE` in its environment or its own call to `enableCompileCache()`. Worker-thread details belong later, but separate Node processes are simple: pass the environment if you want shared cache storage.

Flushing is explicit.

```js
import module from 'node:module';

module.enableCompileCache();
await import('./worker-entry.ts');
module.flushCompileCache();
```

`module.flushCompileCache()` writes accumulated compile-cache data for modules already loaded in the current instance. Node also writes on exit, but early flush gives later Node processes a chance to reuse artifacts while the current process keeps running. Flush failures are silent because compile-cache misses should not break the application.

That silent failure policy should affect how you log. Use `enableCompileCache()` status for setup diagnostics. Use `flushCompileCache()` when the timing matters. Avoid building correctness checks around the presence of files in the cache directory, because Node owns that layout and can change it across versions.

There is a portable mode too.

```js
module.enableCompileCache({
  directory: '.cache/node-compile',
  portable: true,
});
```

Portable mode tells Node to make cache reuse less tied to absolute project paths when it can compute paths relative to the cache directory. The feature is best-effort. It helps when a project directory moves with its cache directory. Cache contents still depend on Node version and source compatibility, so portable mode stays in the startup-cache category rather than the packaging category.

The environment form is `NODE_COMPILE_CACHE_PORTABLE=1`. Use it when the cache directory moves with the project, such as a workspace restored into a different absolute path. Keep expectations modest. If Node cannot compute a useful relative path for a module, that module may skip caching.

Coverage deserves one warning. V8 coverage can become less precise for functions deserialized from code cache. For test commands that collect coverage, disable the compile cache with `NODE_DISABLE_COMPILE_CACHE=1` or avoid enabling it. Coverage correctness beats a faster test startup path.

The disable variable wins over convenience. `NODE_DISABLE_COMPILE_CACHE=1` blocks the cache even if code calls `enableCompileCache()` or `NODE_COMPILE_CACHE` is set. That gives CI and coverage jobs a clean override without changing application startup code.

The compile cache has a clean operational shape when you keep it boring: enable it at startup, put it in a disposable directory, inspect status rather than assuming success, flush only when another process needs the data early, and expect every module to resolve, link, and evaluate exactly as it would without the cache.

TypeScript stripping and compile caching meet at one narrow point. Node prepares TypeScript into JavaScript first. V8 compilation comes next. The cache can help repeat that compilation on a later process start, but the runtime still has to load the same graph, validate the same imports, and run the same code.
