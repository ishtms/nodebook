---
title: "Async/Await Under the Hood"
date: "2026-03-01"
excerpt: "How V8 compiles async functions into state machines, suspend/resume mechanics, and the implicit promise wrapping."
category: "Async Patterns & Control Flow"
tags: ["nodejs", "async-await", "state-machine", "v8", "async-patterns"]
author: "Ishtmeet Singh @ishtms"
chapter: "async-patterns"
subchapter: "async-await"
published: true
toc: true
---

`async` changes a function's contract the moment you type it.

Call it and you get a promise. Every time. The body can return `42`, throw an error, run three network waits, or fall off the end. The caller still receives a promise, because V8 enters async-function machinery before your first line runs.

That shows up in boring bugs. An async callback passed to `Array.map()` gives you an array of promises. An async comparator passed to `Array.sort()` gives `sort()` a promise where it expects a number. The bad behavior sits at the boundary between a synchronous API and a promise-returning function.

Small keyword. Large contract change.

```js
async function getNumber() {
  return 42;
}

const result = getNumber();
console.log(result instanceof Promise);
```

The log prints `true`. The returned `42` becomes the fulfillment value of the promise returned from `getNumber()`. A missing return fulfills with `undefined`. A throw rejects the returned promise.

```js
async function boom() {
  throw new Error("broken");
}

boom().catch(e => console.log(e.message));
```

The throw runs during the call to `boom()`. The async wrapper catches it and rejects the outer promise. The caller receives failure through the promise returned by `boom()`.

Returning a promise makes the outer promise adopt the returned promise's state. Returning a thenable goes through thenable assimilation, covered in the previous subchapter. The native-promise path is optimized in modern V8, including the V8 shipped with Node v24, but the observable rule stays stable: callers observe one promise that settles with the returned value, rejection, or adopted state.

One return detail keeps paying rent. `return somePromise` forwards the promise through the async function's resolution path. `return await somePromise` observes `somePromise` at an await point, then resolves the outer promise with the fulfilled value. Modern V8 has a fast path for native promises at await sites. Use `return await` inside `try/catch` and `finally`, and when stack quality matters. Direct return is fine for plain forwarding.

## `await` Suspends One Function

`await` pauses the current async function. The process keeps running.

```js
async function example() {
  console.log("A");
  const val = await Promise.resolve("B");
  console.log(val);
  console.log("C");
}

example();
console.log("D");
```

Output: `A`, `D`, `B`, `C`.

The first log runs on the current call stack. V8 reaches `await`, records the function state, attaches a reaction to the awaited promise, and returns control to the caller. The caller prints `D`. Later, during a microtask checkpoint, V8 resumes the async function with the fulfilled value `"B"` and runs the remaining logs.

Code before the first `await` is synchronous. Fully synchronous. An async function whose body contains zero `await` expressions runs its whole body before returning to the caller, although its result is still delivered through a promise.

```js
async function noAwait() {
  console.log("sync");
  return "done";
}

noAwait();
console.log("after");
```

Output: `sync`, `after`. A `.then()` attached to the returned promise runs later as a microtask, because promise handlers keep the scheduling rule from the previous subchapter.

Plain values can be awaited too.

```js
async function waitValue() {
  const n = await 42;
  console.log(n);
}
```

V8 runs promise resolution for the value, suspends the function, then resumes it in a microtask with `42`. Generic code uses that property when an input may be either a value or a promise. Hand-written `await 42` mostly adds scheduling noise.

Awaiting an already-fulfilled promise still suspends. Same for `await 42`. V8 has reduced the number of microtask turns on the common native-promise path, while preserving the scheduling boundary. Code after the await runs after the current synchronous stack empties.

Sequential awaits create sequential work:

```js
async function three() {
  const a = await step1();
  const b = await step2(a);
  return step3(b);
}
```

`step2` starts after `step1` fulfills. `step3` starts after `step2` fulfills. The total latency is the sum of those waits plus scheduler overhead. That shape fits real data dependencies. It wastes latency when the operations are independent.

## The Promise-Chain Shape

Async/await reads linearly. The observable behavior lines up with a promise chain.

```js
async function fetchData(url) {
  const response = await fetch(url);
  const json = await response.json();
  return json;
}
```

Behaviorally, that has the same continuation shape as this:

```js
function fetchData(url) {
  return fetch(url)
    .then(response => response.json())
    .then(json => json);
}
```

Each `await` creates a continuation. Code after the await runs when the awaited promise settles. A final `return` resolves the promise that the async function gave to its caller.

The error path maps cleanly too.

```js
async function fetchSafe(url) {
  try {
    const resp = await fetch(url);
    return await resp.json();
  } catch (e) {
    console.error("failed:", e.message);
    return null;
  }
}
```

Rejection from either awaited operation is thrown at the corresponding `await` site. The catch block receives it. You get direct-style control flow with promise scheduling underneath.

The lexical scope is the practical win. A `.then()` chain splits code into separate functions. Sharing local state across steps means returning compound objects, closing over variables, or adding more functions. An async function keeps one lexical scope across suspension points. `response` remains available after later awaits because V8 stores the suspended execution context on the heap and restores it later.

That convenience has a memory cost. Hold a 50 MB buffer in a local variable, hit `await db.save()`, and the buffer stays reachable while the database promise is pending. The async function object retains its scope. V8 can collect objects only after live variables stop referencing them.

The generator connection is historical, and mostly useful when reading old code. Before async/await landed in ES2017, many Node projects used generator functions with runner libraries. The runner called `.next()` after each yielded promise fulfilled, then called `.throw()` after rejection. Async functions turned that pattern into syntax with promise integration built into the engine. V8 still shares some suspension machinery with generators, including suspend and resume bytecode concepts, while promise resolution and outer-promise handling are async-function-specific.

## V8's State Machine

Internals section. The practical rule is short: every await is a suspension point. The machinery behind it is where the cost model comes from.

When V8 compiles an async function, it emits bytecode that can suspend and resume. On call, V8 creates the promise returned to the caller and creates an internal async function object to track execution state. In V8's implementation, that object is a `JSAsyncFunctionObject`, related to generator machinery. It stores the outer promise, the current continuation state, and references needed to resume after an awaited promise settles.

The outer promise is allocated at function entry. The caller gets that promise even if the function body runs for a while before the first await. If the function reaches `return`, V8 resolves the outer promise. If the function throws and local code leaves it unhandled, V8 rejects the outer promise. If the function has five awaits, the same outer promise stays pending across all five suspensions.

The first part of the function runs like ordinary JavaScript. Local variables live in the active stack frame while execution is active. At an `await`, V8 evaluates the expression, runs promise resolution for the value, and attaches fulfillment and rejection reactions to the resulting promise. Then it saves the current execution context: local variables, operand state, and bytecode position. The active stack frame can unwind. The saved state lives on the heap.

The function is paused.

When the awaited promise settles, V8 enqueues a `PromiseReactionJob` into its microtask queue. Node v24 uses explicit microtask checkpoints, as covered in the previous subchapter: Node drains `process.nextTick()` first, then asks V8 to drain promise microtasks. When the reaction job for the await runs, V8 restores the async function's saved context and resumes at the bytecode immediately after the await expression.

Fulfillment resumes as a value. Rejection resumes as a throw. That is why this code works:

```js
try {
  const user = await fetchUser(id);
  return user.name;
} catch (e) {
  return null;
}
```

V8 resumes the function inside the original try region. If the promise rejected, the resumed bytecode throws the rejection reason at the await site, and the catch block receives it through the normal exception path. JavaScript uses the same exception machinery here.

Older V8 versions paid more per await. Before V8 7.2, awaiting an already-fulfilled native promise involved extra promise allocation and extra microtask turns. The V8 team changed both the implementation and the spec path for the native-promise case, reducing the common await path to one microtask turn. Node 12 picked up that work. Node v24 has the later optimized path, plus follow-on work around promise resolution, async stack traces, and allocation.

The fast path applies to native promises from the current realm. Thenables take the full assimilation path, because the engine must read and call the `.then` property. That property can run user code. It can throw. It can resolve later. V8 honors that protocol.

The object layout has a few fields worth naming. The async function object carries the outer promise and resume closures for fulfilled and rejected awaits. V8 can reuse those closures across awaits in the same function, which saves handler allocation at repeated await expressions. The promise objects still carry the reaction lists. Microtask scheduling belongs to promise reactions, while the async function object carries suspended execution state.

Allocation usually starts in the young generation of V8's heap. Short async functions finish there and die cheaply. A function suspended on a slow network call may survive a young-generation collection and move to old generation. The object itself is small. Retained locals matter more. A suspended handler with a parsed request body, a large Buffer, and a closure over the request object can keep much more memory alive than the async machinery itself.

Async stack traces add another layer. A normal stack covers the current synchronous call stack. Await boundaries split execution across microtask turns, so V8 stores metadata that lets it reconstruct the chain of async calls. When an error is thrown, modern Node shows frames like this:

```txt
Error: oops
    at innerFn (file.js:12:11)
    at async middleFn (file.js:8:20)
    at async outerFn (file.js:3:18)
```

The `async` frames mark await boundaries. The metadata turns a rejected async flow into a stack trace that names the logical callers, which is the part you need when the innermost function only says `readFromReplica` or `parseConfig`.

One low-level detail explains many ordering bugs. `await` resumes through a `PromiseReactionJob`, the same job type described in the promise chapter. Await continuations share ordering with `.then()` handlers and `queueMicrotask()`. Node's nextTick queue still has priority at each checkpoint. That split explains most "why did this log first" cases in async/await code.

## Ordering Rules You Actually See

Code after `await` runs as a microtask.

```js
console.log("1");
async function run() {
  console.log("2");
  await Promise.resolve();
  console.log("3");
}
run();
console.log("4");
```

Output: `1`, `2`, `4`, `3`. Synchronous code runs first. The await continuation runs when the microtask queue drains.

Multiple async functions interleave in the order their continuations enter the microtask queue.

```js
async function a() {
  console.log("a1");
  await Promise.resolve();
  console.log("a2");
}
a();
```

Add a second function with the same structure and call `a(); b();`. The output is `a1`, `b1`, `a2`, `b2`. Both synchronous prefixes run immediately. Then the await continuations drain FIFO.

Extra awaits add extra turns. If `x()` prints before two awaits and `y()` prints before one await, calling `x(); y();` can produce `x1`, `y1`, `x2`, `y2`, `x3`. `x` resumes, prints `x2`, hits another await, and goes to the back of the microtask queue. `y` resumes before `x`'s second continuation.

Node-specific ordering still applies. `process.nextTick()` runs before V8 promise microtasks at each checkpoint.

```js
async function run() {
  await Promise.resolve();
  console.log("await");
}

run();
process.nextTick(() => console.log("nextTick"));
```

Output: `nextTick`, `await`. The await queues a promise reaction. `nextTick` queues into Node's separate nextTick queue. Node drains nextTick first, then V8's microtask queue.

Fire-and-forget changes ordering too. The async function starts immediately, runs until its first await, and then the caller moves on with zero completion handle stored anywhere.

```js
async function save(data) {
  await db.insert(data);
  console.log("saved");
}

save(myData);
console.log("continuing");
```

`continuing` prints before `saved`. That may be intended. The failure path needs an explicit catch when it is intended.

## Error Handling

Use `try/catch` around the awaits whose failures you can handle.

```js
async function loadUser(id) {
  try {
    const user = await fetchUser(id);
    return user;
  } catch (e) {
    console.error("fetch failed:", e.message);
    return null;
  }
}
```

If `fetchUser(id)` rejects, the await expression throws. The catch block receives the rejection reason. If all local catch blocks miss it, the async function's returned promise rejects.

```js
async function loadUser(id) {
  const user = await fetchUser(id);
  return user;
}

loadUser(99).catch(e => console.error(e.message));
```

The rejection travels through returned promises until a caller handles it. Leave it unhandled and Node treats it as an unhandled rejection, covered in the previous subchapter.

Errors from multiple awaits can share a catch block when the response is the same. The catch block becomes a boundary for that whole region. Keep that region small enough that the log message still means something.

```js
async function pipeline() {
  try {
    const raw = await fetchData();
    const parsed = await parseData(raw);
    return await saveData(parsed);
  } catch (e) {
    console.error("pipeline failed:", e);
  }
}
```

Broad catch blocks are fine when the recovery is the same for every step. Use smaller regions when the failure message or recovery differs by step.

```js
async function pipeline() {
  let raw;
  try { raw = await fetchData(); }
  catch (e) { throw new Error("fetch: " + e.message); }
  return await parseData(raw);
}
```

The boring bug is also the common bug: a promise gets created and discarded.

```js
async function process() {
  doSomethingAsync();
  console.log("done");
}
```

`doSomethingAsync()` starts. Its returned promise goes nowhere. If it rejects, local error handling is absent. Linters call these floating promises. Treat them as defects unless fire-and-forget is intentional and error handling is attached.

```js
doSomethingAsync().catch(e => {
  console.error("background task failed:", e);
});
```

`return await` has one legitimate use that keeps coming up: catching a returned promise inside the current function.

```js
async function risky() {
  try {
    return await doSomethingAsync();
  } catch (e) {
    console.error("caught:", e);
  }
}
```

Direct return sends the promise from `doSomethingAsync()` back to the caller before the try block observes rejection. With `return await`, the function stays inside the try region until the promise settles. Use that form when local cleanup, wrapping, logging, or stack quality matters.

Direct return is leaner when the function only forwards a promise:

```js
function getUser(id) {
  return db.query("SELECT * FROM users WHERE id = ?", [id]);
}
```

An async wrapper gives you room for transformation or local error handling:

```js
async function getUser(id) {
  const row = await db.query("SELECT * FROM users WHERE id = ?", [id]);
  return normalizeUser(row);
}
```

Both return promises to the caller. The second version allocates async-function state. Usually fine. In library internals processing very high call rates, measure it.

`finally` works with awaited cleanup.

```js
async function withLock(resource, fn) {
  await resource.lock();
  try {
    return await fn();
  } finally {
    await resource.unlock();
  }
}
```

If `fn()` rejects and `unlock()` rejects too, the `finally` rejection wins. Same rule as synchronous `finally`: a throw during cleanup replaces the earlier error. Dangerous. Cleanup code should be small, tested, and noisy when it fails.

Cleanup often belongs in `finally` even when the function returns directly from `try`. The return waits for the cleanup await to finish. That behavior fits locks, temporary files, spans, transactions, and file handles.

## Patterns That Matter

Sequential awaits are explicit. Sometimes they are exactly right.

```js
for (const migration of migrations) {
  await runMigration(migration);
}
```

Database migrations, ordered writes, and rate-limited calls often need that shape. One completes before the next starts.

Independent work should start together.

```js
async function fetchAll(urls) {
  const responses = await Promise.all(
    urls.map(url => fetch(url))
  );
  return Promise.all(responses.map(r => r.json()));
}
```

Calling `fetch(url)` starts the work. `await` waits for the result. Collect promises first when operations are independent. Await them together. Subchapter 06 covers combinators in detail, including failure behavior and bounded concurrency.

The distinction is start versus wait. People often treat `await fetch(url)` as the operation itself. The function call starts the operation; `await` observes completion. That distinction is what lets you overlap independent work.

Array iteration methods deserve suspicion around async callbacks.

```js
urls.forEach(async (url) => {
  const res = await fetch(url);
  console.log(await res.text());
});

console.log("done");
```

`forEach` ignores the promises returned by the async callback. The final log runs immediately. Errors inside the callbacks become unhandled unless each callback catches them. Use `for...of` for sequential work or `Promise.all(urls.map(...))` for concurrent work.

Top-level await (covered in Chapter 1) makes async IIFEs less common in ES modules, but CommonJS still uses the pattern:

```js
(async () => {
  const config = await loadConfig();
  const server = await startServer(config);
  console.log("listening on", server.address().port);
})();
```

That is fine in scripts and older CommonJS modules. In ESM on Node v24, module-scope `await` is available.

Avoid wrapping async code in a fresh `Promise` constructor.

```js
async function getData() {
  return new Promise(async (resolve) => {
    const data = await fetch("/api");
    resolve(data);
  });
}
```

The outer async function already returns a promise. The async executor creates another promise path and can lose rejections in ugly ways. Write the function directly.

```js
async function getData() {
  return fetch("/api");
}
```

Wrap callback APIs with a promise when you have a callback source. Avoid wrapping promises with more promises.

The async executor bug deserves hard wording. The executor passed to `new Promise()` is expected to call `resolve` or `reject` directly. Marking that executor `async` makes it return its own promise. If the executor throws after an await, that rejection belongs to the executor's promise, while the outer promise can remain pending depending on the code path. Bad failure mode: neither completed nor rejected, just hanging.

## Production Shape

In production Node v24 code, async/await should be the default shape for application logic. It matches the ecosystem: HTTP clients, database drivers, queues, test runners, and framework hooks mostly speak promises now.

Performance usually points somewhere else. A network call takes milliseconds. An await continuation costs microseconds. If profiling says async overhead matters, the first fix is usually batching, limiting concurrency, or removing accidental sequential waits. Rewriting readable async/await code into raw `.then()` chains buys little outside library internals and tight loops.

Memory needs more attention. Every suspended async function retains its locals. Keep scopes lean around awaits. Drop large references before long waits.

```js
async function handle(req) {
  let body = await readBody(req);
  const parsed = parseRequest(body);
  body = null;
  return await db.save(parsed);
}
```

Setting `body = null` makes intent plain: the raw payload can die before the database await. V8 may still make its own optimization choices, but removing the reference gives the collector permission.

Large fan-outs need bounds.

```js
const results = await Promise.all(
  items.map(item => transform(item))
);
```

For 100 items, fine. For 100,000 items, that creates 100,000 promises and likely 100,000 async continuations. Batch the work or use a concurrency limiter. The thread pool, database, remote API, and heap all have limits, even when the syntax makes the fan-out one line.

A simple batch shape is boring and effective:

```js
for (let i = 0; i < items.length; i += 100) {
  const batch = items.slice(i, i + 100);
  await Promise.all(batch.map(item => transform(item)));
}
```

That keeps only 100 transforms in flight. The right number depends on the downstream system. Databases, queues, and APIs usually tell you the limit through latency, errors, or rate-limit headers.

What I would actually do in production:

- Use async/await for request handlers and business logic.
- Treat floating promises as bugs unless they have an explicit `.catch()`.
- Use `return await` inside `try/catch` or `finally`; return the promise directly elsewhere.
- Use `Promise.all()` for independent work, with bounded concurrency for large batches.
- Keep large buffers and parsed payloads out of scope before long awaits.
- Prefer `for...of` for ordered async loops.
- Avoid async callbacks with `forEach`, `filter`, `some`, `every`, and `sort`.
- Profile before replacing async/await with `.then()` for speed.

## Cost Model

Each await costs a promise reaction, a microtask turn, and a suspend/resume of async function state. Node v24 is fast here. Still a cost.

Raw `.then()` chains can be a little faster in microbenchmarks because they avoid the async function object and some state restoration. The difference is usually 5-15% in tiny loops that do almost zero real I/O. In server code dominated by sockets, file reads, database calls, and timers, that difference gets buried.

The cost becomes visible in code that creates huge numbers of async function instances with tiny bodies:

```js
const out = await Promise.all(
  items.map(async item => transformSyncPart(item))
);
```

If `transformSyncPart()` is effectively synchronous, the async callback adds promise and async-function allocation for zero scheduling benefit. Use a synchronous `map()` for synchronous work. Keep async functions for work that crosses an async boundary.

The more common performance failure is accidental serialization:

```js
for (const user of users) {
  await sendEmail(user);
}
```

Correct for rate-limited or ordered sends. Slow for independent sends. Syntax gives you zero proof of intent. The data dependency tells you.

Debugging has improved enough that keeping async/await is usually worth it. Async stack traces are enabled by default in modern Node. The inspector can step across await points and show locals while a function is suspended. You get readable source and usable stack traces. That combination beats a hand-built promise chain for most code I want to maintain.

