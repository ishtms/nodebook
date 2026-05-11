---
title: "Environment Files and Configuration Loading"
date: "2026-05-11"
excerpt: "How Node.js v24 loads .env files, parses DotEnv syntax, merges values into process.env, handles NODE_OPTIONS, and keeps runtime config explainable."
category: "Runtime Platform APIs & Tooling"
tags: ["nodejs", "env-files", "configuration", "dotenv", "process-env"]
author: "Ishtmeet Singh @ishtms"
chapter: "runtime-platform"
subchapter: "env-files-configuration"
published: true
toc: true
---

A value from the parent process can take precedence over the same key in `.env`. That precedence lands before application code reads `process.env`, so a configuration bug can start in the launch command even when the file on disk looks correct.

```bash
PORT=9000 node --env-file=.env server.js
```

If `.env` contains `PORT=3000`, the process still starts with `process.env.PORT === "9000"`. The parent environment wins. Node reads the file, sees the key, then keeps the inherited value because the process already had one.

That rule is the first thing to internalize. `.env` support in Node is a lower-precedence input layer. The authority depends on when the value entered the process and which loading path wrote it.

The operating system starts the process with an argument vector and an environment block. Node reads both during native startup. If the command includes `--env-file`, Node reads that file before user JavaScript runs. Then it creates the JavaScript environment, exposes `process.env`, runs preloads, and evaluates the entrypoint. By the time `server.js` starts, the merge has already happened.

```js
console.log(process.env.PORT);
console.log(process.env.NODE_ENV);
```

That code reads the aftermath. `process.env` was covered in Chapter 5. The new piece is Node's built-in path for putting extra keys into it before the application module graph evaluates.

Runtime configuration and application configuration sit close together here. A value like `PORT` usually belongs to the app. A value like `NODE_OPTIONS` can change Node startup itself when it is present early enough. Same storage surface. Different consumption point.

## The Startup Boundary

Node v24 has two CLI flags for env-file loading.

```bash
node --env-file=.env server.js
```

`--env-file` loads a required file. Missing file, failed process. The entrypoint stays untouched because Node fails during startup option handling.

```bash
node --env-file-if-exists=.env.local server.js
```

`--env-file-if-exists` uses the same parser and assignment rules, then keeps going when the file is absent. That makes it useful for developer-local overrides. One machine can have `.env.local`; CI can omit it.

Both flags belong before the entrypoint.

```bash
node server.js --env-file=.env
```

That command passes `--env-file=.env` to `server.js` as an application argument. Node has already crossed the argument boundary, so no file is loaded.

Multiple files layer in command order.

```bash
node --env-file=.env --env-file=.env.local server.js
```

Node parses `.env`, then `.env.local`. Values from the later file override values from the earlier file when both values came from env files. The inherited environment still outranks them both.

```env
# .env
PORT=3000
LOG_LEVEL=info
```

```env
# .env.local
LOG_LEVEL=debug
```

With no inherited `LOG_LEVEL`, the process sees `"debug"`. Add `LOG_LEVEL=warn` in the shell or process manager, and the process sees `"warn"`.

That is environment variable precedence. It is the ordering rule that decides the final value when several startup inputs mention the same key. For Node's env-file CLI path, the useful model is:

```text
parent environment
  beats later env file
  beats earlier env file
```

The wording matters. Later env files beat earlier env files only inside the env-file layer. The parent environment sits above that layer.

Configuration layering is the practice of loading several configuration sources in a deliberate order. The common local pattern is base defaults first, machine-local overrides second, shell or process-manager values last.

```bash
node --env-file=.env --env-file=.env.development app.js
```

That command keeps the order visible. The base file says what the app normally needs. The development file narrows it for one mode. The launching environment can still override a key for a single run.

The reverse order is a real bug.

```bash
node --env-file=.env.local --env-file=.env app.js
```

With no inherited value, `.env` can overwrite `.env.local`. The command succeeds. The service starts. The visible failure is just the wrong database, wrong log level, or wrong port. File order is part of the startup contract.

Inspect the final value from the process that is actually running.

```js
console.log({
  port: process.env.PORT,
  execArgv: process.execArgv,
});
```

That print tells you the final value and the direct Node execution arguments. It does not show inherited `NODE_OPTIONS`, so inspect that key separately when startup behavior looks different from the visible command.

```js
console.log(process.env.NODE_OPTIONS);
```

Keep those prints temporary. Environment values often include credentials from layers your env file never mentioned.

## The DotEnv Grammar Node Parses

A `.env` file is a text file containing environment variable assignments. The usual filename is `.env`, but Node accepts any path supplied to the flag or API. `.env.local`, `.env.test`, and `config/service.env` are all just files as far as Node is concerned.

Dotenv syntax is the assignment grammar Node uses inside those files. Node documents its own grammar because the ecosystem had a convention before core had a parser. Most files are boring. Boring is good.

```env
PORT=3000
NODE_ENV=development
API_BASE_URL=https://api.local
```

Each declaration has a name, an equals sign, and a value. Node stores the value as a string. `3000` becomes `"3000"`. `true` becomes `"true"`. JSON-looking text stays text.

```env
FEATURE_ENABLED=true
RETRY_LIMIT=3
JSON_VALUE={"debug":true}
```

Your application owns coercion. Node does not infer booleans, numbers, arrays, or objects from env-file text.

The documented portable variable-name grammar is narrow:

```text
^[a-zA-Z_]+[a-zA-Z0-9_]*$
```

Names begin with a letter or underscore. After that, letters, digits, and underscores are documented. Uppercase with underscores remains the least surprising convention because shells, service managers, CI systems, and deployment tools all handle it cleanly.

```env
DATABASE_URL=postgres://localhost/app
LOG_LEVEL=debug
_BOOTSTRAP=1
```

Current Node parsers are permissive in places. Some names outside the documented pattern can still be accepted because the native parser mostly separates text around the first equals sign and then trims. Treat those spellings as outside the documented contract. If a project wants stricter names, validate the parsed keys or the final config object.

Spacing around unquoted keys and values gets trimmed.

```env
PORT = 3000
TOKEN =   abc123
```

Node stores `PORT` as `"3000"` and `TOKEN` as `"abc123"`. The whitespace beside the equals sign disappears.

Quoted values keep whitespace inside the quotes.

```env
GREETING="  hello  "
```

`GREETING` contains two leading spaces and two trailing spaces. Node removes the quote delimiters and keeps the inner bytes after parsing escape behavior.

Hash characters begin comments in unquoted values.

```env
LOG_LEVEL=debug # local override
PASSWORD_HASH="abc#123"
```

`LOG_LEVEL` becomes `"debug"`. `PASSWORD_HASH` keeps the hash because the character sits inside quotes. The environment comment syntax is simple: outside quotes, `#` starts ignored text through the end of the line.

Single quotes, double quotes, and backticks can wrap values.

```env
SQL='select * from users'
RAW=`literal text`
NAME="node"
```

A quoted environment value is a value whose boundaries are explicit. Quotes are useful when the value contains spaces, `#`, `=`, or leading and trailing whitespace.

Double-quoted values get one extra behavior in Node's native parser: `\n` becomes an actual newline character.

```env
PRIVATE_KEY="line1\nline2\nline3"
LITERAL='line1\nline2'
```

`PRIVATE_KEY` contains newline characters. `LITERAL` contains backslash plus `n`. Single quotes and backticks preserve that pair as ordinary text.

Multiline environment values are quoted values that continue across physical lines.

```env
CERT="-----BEGIN-----
abc123
-----END-----"
```

Node stores one string containing newline characters. Use this carefully. Large secrets in environment variables can leak through debug prints, diagnostic reports, crash dumps, and process inspection tools. Secrets management belongs later in the book, but the immediate rule is small: avoid turning env files into secret stores just because multiline parsing exists.

The `export` prefix is accepted and ignored.

```env
export PORT=3000
```

Node stores `PORT`. The environment export prefix exists so a simple assignment file can also be sourced by a shell in some workflows. That compatibility has limits. Shell expansion, command substitution, and shell-specific quoting stay outside Node's DotEnv grammar.

Duplicate keys inside one parsed input use the later value.

```env
PORT=3000
PORT=4000
```

The parsed result is `PORT: "4000"`. The parser overwrites the previous value inside its temporary result as it reads.

Malformed lines deserve a conservative mental model. The docs define the format. Current Node releases recover from many content-shape problems by skipping lines or accepting non-portable keys. Missing required files and invalid startup options fail startup; a weird line inside an env file usually needs application validation if you want it rejected.

Line endings are another boring detail that shows up in cross-platform repos. Node's parser handles common text-file line endings, including files created on Windows. If a value still contains unexpected control characters after parsing, check the parent environment, generated input, or a non-Node parser before blaming Node's env-file path.

Variable expansion stays outside Node's built-in grammar.

```env
ROOT=/srv/app
LOG_DIR=$ROOT/logs
```

Node stores `LOG_DIR` as `"$ROOT/logs"`. It does not read the previous key and substitute it. That behavior keeps parsing local to each assignment. Projects that rely on expansion need an explicit userland parser or an application-level expansion step. Keep that step visible because expansion rules affect security and quoting.

Shell command substitution also stays outside the grammar.

```env
BUILD_ID=$(git rev-parse HEAD)
```

Node stores the text. It does not run a command. Env-file parsing should parse configuration text, not execute code.

## The Startup Path Underneath

The CLI path runs early enough to change both application-visible environment and some Node startup behavior.

Startup begins in native code. Node receives argv and the inherited environment from the operating system. Chapter 8.1 covered the option parser and `NODE_OPTIONS`; keep that boundary in mind here. `--env-file` is a Node CLI flag, so Node consumes it before the entrypoint and before application arguments.

The env-file path has three jobs.

It resolves the path relative to the current working directory unless you give an absolute path. It reads the file. It parses DotEnv text into key-value pairs, then merges those pairs into the environment state Node will expose as `process.env`.

For CLI loading, Node also gives `NODE_OPTIONS` from an env file startup meaning.

```env
NODE_OPTIONS=--trace-warnings
APP_MODE=local
```

```bash
node --env-file=.env app.js
```

The warning flag can affect the same process because Node sees it during startup. That detail is easy to miss if you only think of env files as application configuration. The file can feed Node's own startup configuration too.

The path is still ordered. Direct command-line options and inherited environment values have their own precedence, covered in 8.1. Env-file `NODE_OPTIONS` enters as part of startup, but it is still less authoritative than values supplied directly by the environment and command line when those surfaces conflict.

The env-file `NODE_OPTIONS` path is startup-only. Node reads it while building runtime option state. The parser tokenizes the string, checks the same environment-flag allowlist used for inherited `NODE_OPTIONS`, and applies accepted flags at the dotenv tier. That tier matters when the same setting appears somewhere stronger.

```bash
NODE_OPTIONS="--trace-warnings" \
node --env-file=.env app.js
```

If `.env` says `NODE_OPTIONS=--enable-source-maps`, the inherited `NODE_OPTIONS` string wins for that environment key. Node keeps `"--trace-warnings"` and ignores the env-file value. Direct command-line flags can still override singleton options or compound after repeatable options, but they operate against the effective `NODE_OPTIONS` string Node kept.

The allowlist is visible from JavaScript.

```js
console.log(
  process.allowedNodeEnvironmentFlags.has("--enable-source-maps"),
);
```

That check is useful for tooling that validates env files before launch. If a project permits `NODE_OPTIONS` in env files, validate the exact flags. A typo should fail in CI rather than in a service wrapper during deploy.

Preloads also see env-file values.

```bash
node --env-file=.env --import ./boot.mjs app.mjs
```

`boot.mjs` runs after env-file loading. If `.env` defines `APP_MODE=local`, the preload can read it from `process.env.APP_MODE`.

That ordering makes env files viable for local instrumentation toggles, test setup, and small bootstrap switches. It also makes env-file content part of the startup surface. A value loaded before a preload can affect code that runs before the entrypoint.

Missing files split into two cases.

```bash
node --env-file=.env.required app.js
```

That command fails when `.env.required` is absent. The application never starts.

```bash
node --env-file-if-exists=.env.local app.js
```

That command continues when `.env.local` is absent. Node may report the missing optional file, but it does not turn absence into a startup failure.

Read errors are startup errors for required files. Permissions, invalid paths, and filesystem problems surface before user code installs its own error handling. That behavior is useful. Required startup configuration should fail early.

The CLI env-file path is synchronous from the application's point of view. User JavaScript has no chance to observe half-loaded configuration. Node has either finished reading and merging the file set, or startup has failed before the entrypoint begins. That is a different failure shape from an application module that calls `fs.readFile()` and then loads config later.

The native startup path also means the event loop is the wrong place to look for env-file timing. No timer, promise job, stream callback, or application preload gets to run in the middle of CLI env-file processing. Node is still building the process state that JavaScript will see. After that state exists, preloads and the entrypoint run inside it.

The merge is string-to-string. Parsed keys and values become environment entries. No type metadata travels with them. No source metadata travels with them either. Once a value lands in `process.env`, the JavaScript object does not tell you whether it came from the shell, a service manager, `.env`, `.env.local`, or a test harness. If the source matters for debugging, log the startup command and the chosen config object at a safe level, not the whole environment.

That source loss explains a lot of config bugs. The final key looks ordinary.

```js
console.log(process.env.LOG_LEVEL);
```

The value might have come from a parent shell export six hours ago. It might have come from a CI variable. It might have come from the second env file. Node's job is to produce the environment view. Your app's job is to validate the final data and, when useful, make the chosen application config observable without exposing secrets.

`NODE_OPTIONS` gets one extra pass because Node itself consumes it. Env-file loading can contribute to that pass only when it happens through the CLI flag. That is why the same text has different consequences depending on the loading API.

```env
NODE_OPTIONS=--trace-warnings
```

Loaded by `--env-file`, it can affect warning traces for the current process. Loaded by `process.loadEnvFile()`, it becomes a string in `process.env` after warning behavior has already been chosen. Same key. Same parser. Different bootstrap point.

The merge step is guarded by existing keys. If the environment already has `DATABASE_URL`, the env-file value for `DATABASE_URL` stays below it. The guard is key-based, not meaning-based. Node does not know which key is more secure, newer, or better. It only sees strings.

That has one sharp edge. An inherited empty string still counts as an existing value.

```bash
DATABASE_URL= node --env-file=.env app.js
```

If `.env` contains a real `DATABASE_URL`, the process still sees `""`. Empty string is a value. Your validation boundary has to reject it if empty is invalid.

Userland `dotenv` packages sit at a different point in the timeline.

```js
import "dotenv/config";
import "./server.js";
```

That preload is JavaScript. It can populate application configuration before `server.js`, provided it runs before the app graph. It cannot change V8 heap sizing, inspector startup, preloaded modules that already ran, or command-line option parsing already completed by Node.

```bash
node --require dotenv/config server.js
```

That shape is still JavaScript preload timing. It is early for the application, late for Node's native startup decisions.

```bash
node --env-file=.env server.js
```

The built-in flag moves env-file parsing into Node startup. That is the main runtime difference. The npm package ecosystem still has extension behavior, older Node compatibility, and expansion packages. Mentioning that ecosystem is enough here. Node core owns the common parser and startup loading path; package-specific features stay package-specific.

Migration from a package preload should be mechanical when the project used only basic DotEnv loading.

```bash
node --env-file=.env app.js
```

Then remove the JavaScript preload from the entrypoint.

```js
import "./server.js";
```

Run the config tests after that change. Pay attention to variable expansion, override mode, multiline values, duplicate keys, and quote behavior. Projects that relied on package-specific features should keep the package or replace those features with explicit application code.

A transitional switch can keep old launchers alive for a short period.

```js
if (process.env.LOAD_DOTENV === "1") {
  await import("dotenv/config");
}
```

That switch buys compatibility while service files, package scripts, and CI jobs move to `--env-file`. Remove it once the launchers have moved. Startup switches that nobody owns turn into invisible configuration layers.

The cleaner migration is visible in the command.

```json
{
  "scripts": {
    "dev": "node --env-file=.env.local src/main.js"
  }
}
```

That package script tells a reviewer where config enters. The entrypoint can focus on validation and app startup.

## Precedence Bugs Look Boring

Most env-file bugs look like ordinary wrong values.

```bash
PORT=9000 node --env-file=.env app.js
```

```js
console.log(process.env.PORT);
```

The print says `9000`. A developer opens `.env`, sees `PORT=3000`, and loses time editing the wrong file. The process is reading a different layer.

The fastest debug step is to print the final environment value and the launch command together. For local work, `env | grep PORT` before launch can expose shell state. For running Linux processes, `/proc/<pid>/environ` can show the inherited environment when permissions allow it. Keep that outside the app's normal logs; environment output often contains secrets.

Layering bugs also come from file order.

```bash
node --env-file=.env.local --env-file=.env app.js
```

That command loads local overrides first and base defaults second. For keys absent from the parent environment, `.env` can overwrite `.env.local`. Reverse the order for the usual base-then-override behavior.

Configuration drift is the gap between the configuration you think the process has and the configuration it actually has. Env files can create drift because local files, inherited shell values, service-manager values, CI variables, and deployment variables all write to the same final surface.

The dangerous part is quiet success.

```env
DATABASE_URL=postgres://localhost/app
```

```bash
DATABASE_URL= node --env-file=.env app.js
```

The process starts. The key exists. The value is empty. Code that checks only for key presence accepts bad configuration.

Validation should check meaning, not just existence.

```js
const url = process.env.DATABASE_URL;
if (typeof url !== "string" || url.trim() === "") {
  throw new Error("DATABASE_URL is required");
}
```

That snippet belongs near startup. It rejects missing and empty strings before the app opens sockets or begins background work.

Another common drift source is `NODE_OPTIONS`. A value loaded through `--env-file` can affect startup. A value loaded later with `process.loadEnvFile()` becomes plain environment text.

```js
import { loadEnvFile } from "node:process";

loadEnvFile(".env");
console.log(process.env.NODE_OPTIONS);
```

If `.env` contains `NODE_OPTIONS=--trace-warnings`, that call prints the string. It does not retroactively enable trace warnings. Node has already parsed startup options, created the runtime, and chosen warning behavior.

Drift also comes from key spelling.

```env
DATABSE_URL=postgres://localhost/app
```

Node can parse that line. The application probably reads `DATABASE_URL`. A presence check for the wrong key tells you nothing. Unknown-key validation catches this class of mistake before the app falls back to a default or starts with an empty value.

```js
const allowed = new Set(["DATABASE_URL", "PORT"]);
const extra = Object.keys(parsed).filter(k => !allowed.has(k));
if (extra.length > 0) throw new Error(`unknown env: ${extra}`);
```

The check belongs on parsed data or on a known env-file object. Running it against the whole parent environment is noisy because shells and platforms set many unrelated variables.

Windows has one platform edge worth remembering. Environment variable names are case-insensitive in the main thread on Windows, while Node exposes them through `process.env` with platform-specific behavior. Keep project keys case-stable. `PORT`, `port`, and `Port` are three different strings in a file review, even when a platform may collapse them later.

Read a real command as a trace.

```bash
NODE_ENV=production \
node --env-file=.env --env-file=.env.local src/main.js
```

Start with the parent environment. `NODE_ENV` is already set before Node reads files. If either file defines `NODE_ENV`, the parent value still wins. Then Node reads `.env`. Then Node reads `.env.local`, with later-file values overriding earlier-file values for keys that the parent environment left open. Then `src/main.js` starts.

Now add an app argument.

```bash
node --env-file=.env src/main.js --env-file=.other
```

The first env-file flag belongs to Node. The second string belongs to the app because it appears after the entrypoint. If the app uses its own argument parser, it may see `--env-file=.other` and do something with it. Node will not.

Add a preload.

```bash
node --env-file=.env --import ./boot.mjs src/main.js
```

The env file loads first. The preload evaluates next. The entrypoint evaluates after that. If `boot.mjs` reads `process.env.FEATURE_X`, it sees the loaded value. If `boot.mjs` captures the value into an exported object, later mutation of `process.env.FEATURE_X` will not update that object.

Add inherited `NODE_OPTIONS`.

```bash
NODE_OPTIONS="--import ./trace.mjs" \
node --env-file=.env src/main.js
```

The inherited `NODE_OPTIONS` value enters before the command-line option layer. If `.env` also provides `NODE_OPTIONS`, the inherited value has higher precedence for that environment key. The exact interaction between repeatable flags and singleton flags follows Node's option parser rules from 8.1. The config bug you see in the app may have been caused by a preload that never appears in the visible `node ...` command.

That trace habit scales. When a service starts with the wrong configuration, write the layers in order:

```text
parent env -> env files -> NODE_OPTIONS -> preloads -> entrypoint
```

Then mark which layer owns the key. Guessing from `.env` alone is a bad debugging loop. The file is only one layer.

## Programmatic Loading With `process.loadEnvFile()`

`process.loadEnvFile(path)` is the imperative loading path. It reads a DotEnv file and writes keys into `process.env`.

```js
import { loadEnvFile } from "node:process";

loadEnvFile(".env.test");
```

The default path is `./.env` when you omit the argument. The path can be a string, URL, or Buffer. The function returns `undefined`; the mutation is the effect.

Use it at a controlled bootstrap point.

```js
import { loadEnvFile } from "node:process";

loadEnvFile(".env");
const { start } = await import("./server.js");
await start();
```

The `import()` expression matters in ESM. Static imports run before the importing module body. If `server.js` reads configuration at top level, a static import would evaluate it before `loadEnvFile()` runs. Runtime import puts the load first.

CommonJS has a similar boundary, but the syntax looks different.

```js
const { loadEnvFile } = require("node:process");

loadEnvFile(".env");
require("./server.cjs");
```

Here the `require()` call happens after the env file load. Modules required by `server.cjs` then see the loaded values.

Late loading creates stale assumptions.

```js
import "./server.js";
import { loadEnvFile } from "node:process";

loadEnvFile(".env");
```

`server.js` has already evaluated before the load call. Any top-level reads from `process.env` inside that graph saw the old environment. A configuration snapshot may already exist.

A configuration snapshot is a captured copy of configuration at one point in time. It might be a variable, an object, a module export, or a client constructed from env values.

```js
export const config = {
  port: process.env.PORT ?? "3000",
};
```

That module reads once. Later changes to `process.env.PORT` do not change `config.port`. The value still needs validation before application code treats it as a TCP port.

`process.loadEnvFile()` preserves existing environment keys. That includes keys set by the parent environment and keys set by earlier programmatic loads.

```js
loadEnvFile(".env");
loadEnvFile(".env.local");
```

Those calls do not behave like repeated CLI `--env-file` flags. After the first call writes `LOG_LEVEL`, the second call sees an existing `process.env.LOG_LEVEL` and keeps it. Use `util.parseEnv()` and explicit object merging when programmatic layering needs later files to win.

Path choice matters more for programmatic loading than for CLI loading because the call may live inside a package, a script, or a test helper.

```js
loadEnvFile(new URL("../.env.test", import.meta.url));
```

That form ties the file to the module location. A plain relative string ties it to `process.cwd()`. Both can be correct. The wrong one breaks when an IDE, package script, or test runner starts the same file from a different working directory.

CommonJS preloads can run `loadEnvFile()` before the application entrypoint.

```bash
node --require ./load-env.cjs server.cjs
```

```js
const { loadEnvFile } = require("node:process");
loadEnvFile(".env");
```

That setup is early enough for application modules loaded after the preload. It is still JavaScript timing, so `NODE_OPTIONS` inside the loaded file remains ordinary text for the current process.

ESM preloads use `--import`.

```bash
node --import ./load-env.mjs server.mjs
```

```js
import { loadEnvFile } from "node:process";
loadEnvFile(".env");
```

Again, this is application bootstrap timing. It can populate `process.env` before `server.mjs` evaluates. It cannot rewind startup flags.

Preloads should stay small. A preload that reads env, validates config, opens database connections, patches globals, and starts metrics creates a startup order that takes effort to inspect. Keep file loading close to config creation. Hand the resulting config object to the app.

Error handling also differs from the CLI path. A thrown error from `loadEnvFile()` is a JavaScript exception. You can catch it, wrap it, or decide which files are required.

```js
try {
  loadEnvFile(".env.local");
} catch (err) {
  if (err.code !== "ENOENT") throw err;
}
```

That pattern gives code-level control, but it also moves failure later. If the application has already imported modules that read configuration, catching a missing file there might be too late.

Use CLI loading for process-wide startup configuration. Use programmatic loading for scripts, tests, and carefully ordered boot modules where code owns the timing.

## Parsing Without Mutating

`util.parseEnv(content)` separates parsing from process-wide mutation.

```js
import { parseEnv } from "node:util";

const parsed = parseEnv("PORT=3000\nLOG_LEVEL=debug\n");
console.log(parsed);
```

The return value is a plain object containing parsed strings. `process.env` stays unchanged.

That difference is useful in tests.

```js
import assert from "node:assert/strict";
import { parseEnv } from "node:util";

const env = parseEnv("PORT=0\nLOG_LEVEL=test\n");
assert.equal(process.env.PORT, undefined);
```

No global process state changed. A test can parse several cases without cleaning up `process.env` after each one.

It is also useful for validation.

```js
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

const raw = readFileSync(".env", "utf8");
const parsed = parseEnv(raw);
```

At that point you have data, not global state. You can inspect keys, reject unknown names, merge objects, coerce values, and only then decide what the application should receive.

Explicit merging is clearer than relying on mutation.

```js
const base = parseEnv(readFileSync(".env", "utf8"));
const local = parseEnv(readFileSync(".env.local", "utf8"));

const merged = { ...base, ...local, ...process.env };
```

That object follows the same shape as the CLI layering model: base first, local second, inherited environment last. The order is visible in one expression.

You can also choose a different policy and make the choice visible.

```js
const merged = { ...process.env, ...base, ...local };
```

That gives files the last word, including over inherited values. It is a valid application policy for some tools, but it differs from Node's CLI env-file precedence. Put that policy in one place. Name it. Test it.

Parsing without mutation also lets a tool validate files before launching Node.

```js
const parsed = parseEnv(readFileSync(".env.example", "utf8"));
for (const key of Object.keys(parsed)) validateKey(key);
```

That command can run in CI. It checks names, required placeholders, reserved runtime keys, and value shape without depending on the developer's current shell.

Reserved-key checks are cheap.

```js
for (const key of ["NODE_OPTIONS", "NODE_EXTRA_CA_CERTS"]) {
  if (Object.hasOwn(parsed, key)) throw new Error(`reserved ${key}`);
}
```

Some teams allow Node runtime keys in env files. Some ban them because runtime behavior should be visible in the launch command. Either rule can work. The bad rule is the one nobody wrote down.

Now keep that object out of `process.env` unless a library requires environment variables. The cleaner boundary is a typed configuration object.

```js
function readPort(value = "3000") {
  if (value.trim() === "") throw new Error("PORT is required");
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("PORT must fit a TCP port range");
  }
  return port;
}
```

Then use it when constructing the object.

```js
const config = {
  port: readPort(merged.PORT),
  logLevel: merged.LOG_LEVEL ?? "info",
};
```

A typed configuration object is application-owned data created from raw environment strings. The word "typed" here means the app has converted strings into the shapes it actually uses: number, boolean, enum string, URL object, duration, byte size, or whatever the domain requires.

Schema validation libraries can automate this pattern, but this chapter only needs the boundary. Raw environment values enter at startup. The app validates once. The rest of the code receives an object with application meanings.

`parseEnv()` also makes parser behavior testable.

```js
import assert from "node:assert/strict";
import { parseEnv } from "node:util";

const parsed = parseEnv('A="x#y"\nB=one # two\n');

assert.equal(parsed.A, "x#y");
assert.equal(parsed.B, "one");
```

That kind of test catches accidental parser assumptions. It is small, fast, and independent of shell state.

Duplicate handling is testable too.

```js
import assert from "node:assert/strict";
import { parseEnv } from "node:util";

const parsed = parseEnv("PORT=3000\nPORT=4000\n");
assert.equal(parsed.PORT, "4000");
```

That is parser behavior only. Once values are merged into `process.env`, existing-key preservation may change the outcome. Keep parser tests separate from merge-policy tests.

## The Validation Boundary

The configuration validation boundary is the place where raw strings stop being accepted as trusted application configuration.

Put it early.

```js
const raw = {
  PORT: process.env.PORT,
  DATABASE_URL: process.env.DATABASE_URL,
};
```

That object is still raw. It carries absent values, empty strings, misspellings, and values from any layer that won precedence.

Coerce deliberately.

```js
const port = readPort(raw.PORT);
const databaseUrl = new URL(required(raw, "DATABASE_URL"));
```

That code can throw. Let it throw during startup, or catch and replace it with a clearer configuration error. The main point is timing: fail before the app accepts traffic or starts background jobs.

Then pass the result.

```js
export const config = Object.freeze({
  port,
  databaseUrl,
});
```

Freezing is optional. The stronger habit is reading environment once and passing config as data. Reaching into `process.env` from every module creates hidden dependencies and makes tests depend on global mutation.

A small reader function is usually enough.

```js
function required(env, key) {
  const value = env[key];
  if (value === undefined || value.trim() === "") throw new Error(key);
  return value;
}
```

That function treats missing and empty as invalid. It accepts an `env` object, so production can pass `process.env` and tests can pass a plain object.

Booleans need special care.

```js
const debug = raw.DEBUG === "true";
```

That line accepts only the string `"true"` as true. It treats `"false"`, `"0"`, `"no"`, `""`, and absence as false. If your app accepts several spellings, encode that rule in one parser function and test it.

```js
function readBool(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("expected boolean");
}
```

That parser rejects `"1"` and `"yes"`. A different app may accept them. The point is a single rule, not scattered comparisons.

Numbers need blank-value checks and bounds.

```js
const port = readPort(env.PORT);
```

Node will not do this for you. Env-file parsing produced a string. `Number("")` returns `0`, so the parser needs to reject blank text before coercion unless blank means something in that application. Meaning belongs to the application.

URLs should be parsed once too.

```js
const databaseUrl = new URL(required(env, "DATABASE_URL"));
if (databaseUrl.protocol !== "postgres:") {
  throw new Error("DATABASE_URL must use postgres:");
}
```

The rest of the app can receive a `URL` object or a validated string. It should not repeat protocol checks in every module that creates a client.

Unknown keys can be useful to reject too.

```js
const allowed = new Set(["PORT", "DATABASE_URL", "LOG_LEVEL"]);
const unknown = Object.keys(parsed).filter(k => !allowed.has(k));
```

That check catches typos such as `DATABSE_URL`. Current Node may parse the misspelled key just fine. Your config layer can reject it before the process starts with a default by accident.

Keep configuration snapshots intentional. Reading once at startup makes the app predictable. Reading `process.env` repeatedly during request handling makes behavior depend on mutable global state. A later assignment can affect some requests and leave earlier constructed clients unchanged.

```js
process.env.LOG_LEVEL = "debug";
```

That assignment mutates the JavaScript environment object for the current process. It does not notify modules that already captured a log level, recreate clients, or re-run validation. Hot configuration reload is a separate operational design problem. Startup loading ends at the validation boundary.

## A Bootstrap Shape That Holds Up

The cleanest startup code has a narrow shape: load, parse, validate, construct config, then start the app. Keep those steps close together.

```js
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

const config = loadConfig(process.env);
const server = createServer(config);
server.listen(config.port);
```

`loadConfig()` receives raw environment data. `createServer()` receives application data. The server module never needs to know whether values came from `--env-file`, a shell, a test object, or a deployment platform.

The config module can stay small.

```js
export function loadConfig(env) {
  const port = readPort(env.PORT);
  const databaseUrl = readUrl(env.DATABASE_URL);
  return Object.freeze({ port, databaseUrl });
}
```

That function has no file I/O. It only turns strings into application data. That makes it testable without touching `process.env`.

```js
const config = loadConfig({
  PORT: "0",
  DATABASE_URL: "postgres://localhost/test",
});
```

Tests can pass exactly the keys they care about. They can also test bad values without mutating global state for the rest of the test process.

File loading can sit in a separate wrapper when the app needs programmatic loading.

```js
import { loadEnvFile } from "node:process";
import { loadConfig } from "./config.js";

loadEnvFile(".env.test");
export const config = loadConfig(process.env);
```

That wrapper owns mutation. The config reader owns validation. The rest of the app receives the frozen result.

For CLI loading, the wrapper shrinks.

```bash
node --env-file=.env --env-file=.env.local src/main.js
```

`src/main.js` can call `loadConfig(process.env)` immediately because Node already populated the environment before entrypoint evaluation.

Libraries should stay out of env-file loading unless their job is configuration. A database package that reads `process.env.DATABASE_URL` during import has chosen a global source before the application can validate it. Passing config into a factory keeps ownership with the application.

```js
const db = createDatabaseClient({
  url: config.databaseUrl,
});
```

That call is boring and explicit. Boring wins here. The database client receives a validated value. The config source remains outside the client.

The same rule applies to loggers, HTTP clients, feature flags, and worker setup. Read the raw environment once. Convert it. Pass data. A module that reads `process.env` at import time can still be acceptable for small scripts, but service code becomes easier to reason about when configuration flows through function arguments.

Generated config should follow the same boundary.

```js
const envText = renderEnvFile(templateData);
const parsed = parseEnv(envText);
const config = loadConfig(parsed);
```

That sequence validates generated env text before it reaches the process-wide environment. Tooling can fail on invalid keys, empty required values, or reserved runtime keys without mutating `process.env`.

A child process needs an explicit environment too.

```js
spawn(process.execPath, ["worker.js"], {
  env: { ...process.env, WORKER_MODE: "jobs" },
});
```

That object becomes the child's parent environment. If the child also uses `--env-file`, the same precedence rule applies inside the child: the inherited `WORKER_MODE` value outranks env-file values for that key. Parent process code should construct that `env` object deliberately because it becomes the strongest layer for the child.

## Operational Edges

Env files are convenient because they are files. That is also the edge.

A checked-in `.env` file can expose credentials. A copied local file can drift from production. A file with permissive permissions can be readable by another local user. A diagnostic report or debug log can include environment values. Secrets management and credential rotation belong in Chapter 26, but the local habit starts here: commit examples, not secrets.

```env
# .env.example
PORT=3000
DATABASE_URL=
```

An example file documents required keys without carrying live values. The real file stays local or comes from the deployment platform.

Make the example file useful.

```env
PORT=3000
LOG_LEVEL=info
DATABASE_URL=
```

Safe defaults can be filled in. Sensitive or deployment-specific values should be blank or fake. A reviewer should be able to tell which keys exist without seeing a real credential.

File permissions still matter for local env files.

```bash
chmod 600 .env.local
```

That command is Unix-specific, and Chapter 4 already covered permission bits. For this chapter, the relevant point is narrower: a local env file containing secrets should have a smaller read surface than source files.

Deployment-provided environment variables usually outrank env files because they arrive in the parent environment. That includes service managers, CI jobs, container runtimes, and orchestration platforms. The mechanics belong to later deployment chapters. The precedence result belongs here: if the platform sets `PORT`, your env file probably loses.

File names carry meaning because Node accepts any filename.

```text
.env.defaults
.env.development
.env.test
.env.local
```

Those names tell a maintainer the intended layer. Names like `.env2`, `.env.new`, and `.env.prod.bak` force the reader to inspect content and command history. The loader will accept them. The project has to impose discipline.

A test env file can have values production would reject.

```env
PORT=0
LOG_LEVEL=warn
DATABASE_URL=postgres://localhost/app_test
```

`PORT=0` asks the operating system to choose an available port when the server binds. The parser still returns the string `"0"`. Your validator needs to allow it for the test path if the app intentionally uses ephemeral ports.

Give each source a job.

The committed example file describes shape. It lists keys, safe defaults, and empty placeholders. The local env file describes a developer machine. The deployment environment describes the running service. The command line describes Node runtime policy. A secret manager describes sensitive values. Mixing those jobs turns a small config system into guesswork.

```env
# .env.example
PORT=3000
DATABASE_URL=
SESSION_SECRET=
```

That file belongs in source control. It documents the contract. It carries safe placeholders.

```env
# .env.local
DATABASE_URL=postgres://localhost/app
SESSION_SECRET=dev-only
```

That file belongs on a developer machine. It belongs in `.gitignore`. The values may be low-risk development values, but treating the file as local-only builds the right habit.

Node runtime flags deserve a separate review path.

```bash
node --report-on-fatalerror --env-file=.env dist/server.js
```

The command has two kinds of data. The report flag changes Node behavior. `.env` supplies strings. Keeping that split visible helps reviewers see which part changes the runtime and which part changes the app.

The hidden version works too, but it needs a project rule.

```env
NODE_OPTIONS=--report-on-fatalerror --enable-source-maps
PORT=8080
```

Some platforms want one mounted env file to carry every startup value. Some teams keep runtime flags in service definitions and app values in env files. Pick one. Then validate for it.

Diagnostic output deserves suspicion.

```js
console.log(process.env);
```

That print can include tokens, database URLs, private keys, and service credentials. It can also include values from the parent environment that the env file never mentioned. Debug the smallest key you need, then remove the print.

Node's diagnostic reports have controls for excluding environment data. That belongs to observability later, but the risk starts with the same storage surface: `process.env` is easy to inspect, easy to log, and easy to leak.

Use env files for local development, test setup, and small startup inputs. Use the deployment platform for production values when the platform owns them. Convert strings into application config once. After that boundary, the rest of the code should depend on config data, not on whatever value happens to be sitting in `process.env` at the moment a module evaluates.
