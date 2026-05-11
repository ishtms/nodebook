---
title: "Promise Combinators and Advanced Patterns"
date: "2026-03-01"
excerpt: "Promise.all, allSettled, race, any -- short-circuit semantics, failure propagation, and concurrency limiting patterns."
category: "Async Patterns & Control Flow"
tags: ["nodejs", "promise-combinators", "promise-all", "promise-race", "async-patterns"]
author: "Ishtmeet Singh @ishtms"
chapter: "async-patterns"
subchapter: "promise-combinators"
published: true
toc: true
---

A single promise is manageable. You await it, get a value, move on. Production code almost never works that way. You're hitting three microservices in parallel, reading five files at once, racing an HTTP call against a timeout. The combinators -- `Promise.all`, `Promise.allSettled`, `Promise.race`, `Promise.any` -- define how multiple concurrent promises compose into one. Each has different semantics around failure propagation, short-circuiting, and result aggregation. Picking the wrong one means either swallowing errors you should've caught or bailing out of operations you should've let finish.

## Promise.all()

`Promise.all()` takes an iterable of promises and returns a single promise that resolves with an array of their results. Every input must fulfill for the combined promise to fulfill. If any input rejects, the combined promise rejects immediately with that rejection reason.

```js
const [user, posts, settings] = await Promise.all([
  fetchUser(id),
  fetchPosts(id),
  fetchSettings(id)
]);
```

Three requests fire concurrently. The combined promise resolves once all three are done. The results array preserves input order -- `user` corresponds to `fetchUser(id)`, `posts` to `fetchPosts(id)`, and so on, regardless of which HTTP call finishes first.

The short-circuit behavior is aggressive. If `fetchPosts(id)` rejects after 50ms while the other two are still in-flight, the combined promise rejects immediately with the posts error. The other two requests keep running. Promises are eager -- once started, they can't be cancelled. Their results are simply discarded because the combined promise is already settled. If `fetchUser` completes 200ms later, nothing happens. The result goes nowhere.

This has a practical consequence for resource usage. If you fire 100 requests with `Promise.all()` and the first one rejects in 10ms, you still have 99 HTTP connections open, doing work, consuming memory. The combined promise settled, but the underlying operations didn't stop. For operations that support cancellation (like `fetch()` with `AbortSignal`), you'd need to wire up cancellation yourself.

An empty iterable resolves synchronously. `Promise.all([])` returns a promise already resolved with `[]`. This is specified behavior and useful as a base case in recursive or accumulation patterns.

Non-promise values in the input iterable get wrapped in `Promise.resolve()`. So `Promise.all([1, fetch('/api'), 'hello'])` works fine -- `1` and `'hello'` resolve immediately, and the combined promise waits only for the fetch.

```js
const files = ['a.txt', 'b.txt', 'c.txt'];
const contents = await Promise.all(
  files.map(f => fs.promises.readFile(f, 'utf8'))
);
```

This reads three files in parallel. If any file doesn't exist, the whole thing rejects. For this particular scenario, that's usually what you want -- a missing file means the operation can't proceed.

When to use `Promise.all()`: when you need every result and any single failure invalidates the whole operation. Parallel database queries where a partial result is meaningless. Loading multiple configuration files where all must be present. Fetching resources needed to render a page where a missing one means the page can't render.

There's a subtle ordering detail worth understanding. `Promise.all()` iterates the input iterable synchronously, attaching `.then()` handlers to each promise during that initial loop. If the iterable contains values that aren't promises, they get wrapped in `Promise.resolve()` during this iteration. The synchronous iteration means the input order is locked in before any asynchronous work begins. The results array is pre-allocated at the correct length, and each resolve handler knows its index. Even if promise at index 4 fulfills before promise at index 0, the result lands at position 4.

A practical pattern you'll see in production codebases: creating the promise array separately from the `Promise.all()` call.

```js
const promises = [fetchUser(id), fetchPosts(id), fetchSettings(id)];
// All three requests are already in-flight here
const [user, posts, settings] = await Promise.all(promises);
```

The three fetch calls start the moment they're called -- they're already racing by the time `Promise.all()` sees them. `Promise.all()` is just collecting the results; it's not initiating the work. This distinction matters when debugging timing. If `fetchUser` takes 500ms, `fetchPosts` takes 100ms, and `fetchSettings` takes 200ms, the total time for `Promise.all()` is ~500ms (the slowest), because all three started simultaneously on the line that creates the array.

The failure mode to watch for: `Promise.all()` rejects with the *first* rejection reason. If three out of five promises reject, you only see the first one. The other two rejection reasons are silently discarded. If you need to see all failures, `Promise.allSettled()` is the right tool.

## Promise.allSettled()

`Promise.allSettled()` waits for every input promise to settle -- fulfilled or rejected -- and returns a promise that always resolves. It never rejects. The result is an array of settlement descriptor objects, one per input promise.

```js
const results = await Promise.allSettled([
  fetchUser(id),
  fetchPosts(id),
  fetchSettings(id)
]);
```

Each element in `results` is either `{ status: 'fulfilled', value: ... }` or `{ status: 'rejected', reason: ... }`. You inspect each one individually:

```js
for (const r of results) {
  if (r.status === 'fulfilled') handleData(r.value);
  else logError(r.reason);
}
```

The outer promise never short-circuits. If `fetchPosts` rejects at 50ms, `Promise.allSettled()` still waits for `fetchUser` and `fetchSettings` to finish. Every input gets its full chance to complete.

This is the combinator for partial-success scenarios. Health checks: you ping five services and want to know which ones responded and which didn't. Batch operations: you insert 100 records and want to know which succeeded and which failed. Cache warming: you prefetch 20 pages and some might 404 but that's fine. The pattern is always the same -- fan out, collect everything, handle each result individually.

The result format takes getting used to. You can't destructure the results directly into values like you can with `Promise.all()`. You need to inspect each descriptor's `status` field first. A common utility:

```js
const fulfilled = results
  .filter(r => r.status === 'fulfilled')
  .map(r => r.value);
```

This extracts just the successful values. You'd write a similar filter for rejected ones if you need the errors.

The naming convention: "settled" means either fulfilled or rejected. A promise is "pending" until it settles. `allSettled` waits for every promise to leave the pending state, regardless of outcome.

`allSettled` was added in ES2020. Before that, the standard workaround was wrapping each promise with a `.then()` and `.catch()` that both returned status objects:

```js
function reflect(p) {
  return p.then(
    v => ({ status: 'fulfilled', value: v }),
    e => ({ status: 'rejected', reason: e })
  );
}
```

Then `Promise.all(promises.map(reflect))` would give you the same result shape. You might still see this pattern in older codebases. The built-in `allSettled` replaced it, with the benefit of being a first-class API that engines can optimize internally.

One nuance: the outer promise from `allSettled` always fulfills. There's no condition under which it rejects. Even if every single input promise rejects, `allSettled` resolves with an array of rejection descriptors. This means you can use `await Promise.allSettled(...)` without a try/catch -- the await will always succeed. But you'd still want to inspect the results, since silent failures are worse than loud ones. A common follow-up pattern:

```js
const failed = results.filter(r => r.status === 'rejected');
if (failed.length > 0) {
  logger.warn(`${failed.length} operations failed`, failed.map(r => r.reason));
}
```

This logs failures without throwing. The caller decides what constitutes an acceptable failure rate. Maybe 1 out of 10 failing is fine for a cache warming job. Maybe any failure during a payment batch is unacceptable and should escalate.

## Promise.race()

`Promise.race()` settles with the first promise to settle. If the first promise to complete fulfills, the race fulfills. If the first promise to complete rejects, the race rejects. It takes the outcome of whoever crosses the line first.

```js
const result = await Promise.race([
  fetch('/api/data'),
  timeout(5000)
]);
```

This is the primary use case: timeout patterns. Fire the real operation and a timer. Whichever finishes first determines the outcome. The `timeout` function typically rejects after a delay:

```js
function timeout(ms) {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Timeout')), ms)
  );
}
```

If `fetch()` returns in 200ms, the race fulfills with the response. If 5000ms passes first, the race rejects with the timeout error. But here's the catch -- the fetch is still running. `Promise.race()` doesn't cancel the losing promises. The HTTP request continues in the background, consumes bandwidth, eventually resolves, and the result goes nowhere. The fetch callback fires, the microtask enqueues, the handler runs with a result nobody will ever read.

`Promise.race([])` with an empty iterable returns a promise that never settles. It stays pending forever. This is one of those edge cases that trips people up in code that dynamically constructs the input array. If you filter your inputs and end up with zero promises, the race hangs.

Race has a subtlety with rejection. If you race a fast-rejecting promise against a slow-fulfilling one, you get the rejection. This matters when you're racing fallbacks -- if one of your "options" fails immediately, the race surfaces that failure even if another option would've succeeded 100ms later. For fallback scenarios, `Promise.any()` is usually what you want.

Another race pattern: using it as a primitive for polling. Say you want to check a resource's status, but you also want to check again in 5 seconds if the current check is slow:

```js
async function pollWithRefresh(checkFn, intervalMs) {
  while (true) {
    const result = await Promise.race([
      checkFn(),
      new Promise(r => setTimeout(() => r('timeout'), intervalMs))
    ]);
    if (result !== 'timeout') return result;
  }
}
```

Each iteration races the check function against a timer. If the check completes first, we return the result. If the timer fires first, the loop starts a new check. The old check is still running -- and that's intentional here. The next iteration might return its result if the new check is slower. This pattern is useful for health-check loops where you want periodic refresh attempts regardless of whether previous checks are still in-flight.

The hazard with `Promise.race()` is memory accumulation. Each "losing" promise still exists in memory until it settles. If you're in a tight loop racing promises that take a long time to settle, you accumulate pending promises. Each one holds references to its closure scope, its reaction callbacks, and any data it has buffered. For short-lived races (timeout patterns where the timeout is a few seconds), this is irrelevant. For long-running races in loops, track your outstanding promises and consider cancellation.

## Promise.any()

`Promise.any()` resolves with the first promise to *fulfill*. It ignores rejections unless every input rejects. If all inputs reject, it throws an `AggregateError` -- an Error subclass with an `.errors` array containing all the individual rejection reasons.

```js
const response = await Promise.any([
  fetch('https://cdn-a.example.com/data'),
  fetch('https://cdn-b.example.com/data'),
  fetch('https://cdn-c.example.com/data')
]);
```

Three CDN mirrors. First successful response wins. If CDN-A fails with a 503 and CDN-B times out, but CDN-C responds with 200, the combined promise resolves with CDN-C's response. The rejections from A and B are silently absorbed.

If all three reject:

```js
try {
  await Promise.any(mirrors.map(m => fetch(m)));
} catch (err) {
  console.log(err instanceof AggregateError); // true
  console.log(err.errors.length); // 3
  console.log(err.errors[0].message); // first rejection reason
}
```

`AggregateError` is a subclass of `Error`. Its `.errors` property is a standard array of the individual error objects. You can iterate it, map it, filter it -- whatever you need. The `message` on the AggregateError itself is generic ("All promises were rejected"), so the individual `.errors` entries are where the diagnostic information lives.

The distinction between `Promise.race()` and `Promise.any()` is about what constitutes a "win." Race: first to settle (fulfill or reject). Any: first to fulfill (rejections don't count). Race is about speed. Any is about success.

`Promise.any()` was added in ES2021 -- the newest of the four combinators. Before it existed, the workaround involved inverting the logic with `Promise.all()`: map each promise to reject on success and resolve on failure, pass them through `Promise.all()` (which now rejects on the first original success), then invert the result back. Ugly, error-prone, and hard to read. The built-in version is cleaner in every way.

The `AggregateError` class is worth examining. It extends `Error` and adds a single property: `.errors`, which is an array. The error's `.message` defaults to "All promises were rejected" but you can construct `AggregateError` yourself with a custom message:

```js
throw new AggregateError(
  [new Error('CDN-A down'), new Error('CDN-B timeout')],
  'All CDNs failed'
);
```

You might use `AggregateError` in your own code when multiple independent operations fail and you want to report all failures at once. It's a general-purpose error container, not specific to `Promise.any()`. Libraries can throw it from their own retry logic, validation functions, or batch processing code.

| Combinator | Resolves when | Rejects when | Short-circuits | Empty input |
|---|---|---|---|---|
| `all` | All fulfill | Any rejects | On first rejection | Resolves `[]` |
| `allSettled` | All settle | Never | No | Resolves `[]` |
| `race` | First settles | First settles (if rejection) | On first settlement | Pending forever |
| `any` | First fulfills | All reject | On first fulfillment | Rejects (AggregateError) |

## How V8 Implements Promise.all

The combinators look simple from the API side. Under the hood, V8 implements them as built-in functions with careful bookkeeping.

`Promise.all()` is implemented via `PerformPromiseAll`, a built-in C++ function in V8. The algorithm works roughly like this: V8 iterates through the input iterable, and for each element, it creates a pair of resolve/reject reaction callbacks. These callbacks are attached to each input promise via an internal equivalent of `.then()`. But they're special-purpose callbacks, optimized for the combinator's specific behavior.

The central mechanism is a **remaining elements counter**. V8 allocates a `PromiseAllResolveElementContext` for each input, plus a shared counter object initialized to the number of input promises. Each resolve reaction callback stores the index it corresponds to (0, 1, 2, ...) and a reference to the shared results array.

When an input promise fulfills, its resolve reaction fires. The callback does three things: it stores the fulfillment value at the correct index in the results array, it decrements the remaining elements counter, and it checks if the counter has reached zero. If zero, all inputs have fulfilled, and V8 resolves the combined promise with the results array. The index assignment is why results always match input order -- each callback knows its position.

The short-circuit path for rejection is simpler. Each input promise gets a reject reaction that points directly at the combined promise's reject capability. The first rejection rejects the combined promise with that rejection reason. Once a promise is settled, further resolve or reject calls on it are no-ops per the spec. So when the remaining input promises eventually settle, their reaction callbacks fire but the calls to resolve or reject the combined promise silently do nothing. The callbacks still run. The decrement still happens. But the combined promise has already settled, so nobody cares.

One thing to note: all the reaction callbacks are allocated up front during iteration, and they hold references to the shared context (results array, counter, combined promise capabilities). These allocations persist even after a short-circuit rejection. If you `Promise.all()` 10,000 promises and the first one rejects immediately, V8 still allocates contexts for all 10,000. The remaining 9,999 reaction callbacks will eventually fire (as the promises settle) and decrement the counter to no effect. Garbage collection cleans up the context objects once all references are released, which happens after all 10,000 promises have settled and their reaction callbacks have run.

`Promise.allSettled()` uses a structurally identical approach with two differences. First, the resolve reaction wraps the value in `{ status: 'fulfilled', value }` before storing it. Second, the reject reaction *also* decrements the counter and stores `{ status: 'rejected', reason }` instead of short-circuiting. Both fulfillment and rejection count toward completion. The combined promise resolves (never rejects) when the counter hits zero.

`Promise.race()` is the simplest implementation. V8 iterates the input and attaches `.then(resolve, reject)` to each input promise, where `resolve` and `reject` point directly at the combined promise's settlement capabilities. First one to fire wins. There's no counter, no results array, no index tracking. Each reaction callback is effectively just a forwarding function.

`Promise.any()` is more complex than race because it needs to track rejections. V8 allocates an errors array and a remaining counter (similar to `Promise.all()`). Each input's reject reaction stores the rejection reason at the correct index and decrements the counter. If the counter hits zero (all rejected), V8 creates an `AggregateError` from the errors array and rejects the combined promise. Each input's resolve reaction points directly at the combined promise's resolve capability -- first fulfillment wins, same as race.

The memory overhead per combinator depends on the input count. `Promise.all()` and `Promise.allSettled()` allocate O(n) resolve element contexts plus a results array. `Promise.race()` allocates essentially nothing beyond the reaction pairs. `Promise.any()` allocates an errors array. For typical usage with 5-50 concurrent promises, the overhead is negligible. For extreme cases (10,000+ inputs), it's worth knowing that V8 pre-allocates all the bookkeeping before any promise has settled.

In the V8 source, these implementations live in `src/builtins/promise-all.tq`, `promise-all-element-closure.tq`, `promise-race.tq`, and `promise-any.tq` (Torque files, V8's internal language that compiles to CSA -- CodeStubAssembler). The Torque code is more readable than raw CSA but still quite different from JavaScript. The key insight is that combinators are built-in fast paths -- they don't go through the general-purpose `.then()` machinery but use internal shortcuts to attach reactions with minimal overhead.

## Concurrency Limiting

Here's a problem. You have 500 URLs to fetch:

```js
const results = await Promise.all(urls.map(url => fetch(url)));
```

This fires all 500 requests simultaneously. Your server opens 500 TCP connections, probably runs out of file descriptors, hammers the target API, and gets rate-limited or banned. `Promise.all()` is great for parallelism but has no concept of concurrency control.

The fix: a concurrency limiter. Allow at most N operations to run simultaneously. When one completes, start the next from the queue.

```js
async function pMap(items, fn, concurrency) {
  const results = new Array(items.length);  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;  results[idx] = await fn(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));  return results;
}
```

This spawns `concurrency` workers. Each worker pulls the next item from a shared index counter, runs `fn`, stores the result at the correct index, and loops. When all items are consumed, the workers exit. `Promise.all()` waits for all workers to finish. The result array preserves input order because each worker records its result at `idx`.

`i++` is atomic here despite JavaScript being single-threaded. Two workers can't race on the increment because `await fn(...)` yields to the event loop, and when execution resumes, only one worker runs at a time. The shared mutable counter works because JavaScript has cooperative concurrency -- you yield explicitly, and between yields, you have exclusive access.

Usage:

```js
const responses = await pMap(urls, url => fetch(url), 10);
```

At most 10 concurrent fetches. When one completes, the next URL starts. The total time is roughly `(urls.length / concurrency) * averageLatency` rather than `averageLatency` for unlimited parallelism or `urls.length * averageLatency` for fully serial execution.

This is a **worker pool** pattern. You spin up a fixed number of concurrent workers (consumers) that pull tasks from a shared source (the index counter) until the work is exhausted. The concurrency bound comes from the number of workers, not from an explicit locking primitive. In Node.js, you don't need OS-level thread pools because you're controlling concurrency cooperatively through promises.

Libraries like `p-limit` and `p-map` (both by sindresorhus) package this pattern with additional features -- error handling options, progress callbacks, AbortSignal support. In production, you'd probably use one of these rather than rolling your own, unless you have specific requirements around error behavior or result ordering.

There's an alternative implementation approach using `p-limit`'s style -- a function that returns a concurrency-limited wrapper:

```js
function pLimit(concurrency) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active < concurrency && queue.length > 0) {
      active++;
      queue.shift()();
    }
  };
```

And the function it returns:

```js
  return (fn) => new Promise((resolve, reject) => {
    queue.push(() => fn().then(resolve, reject).finally(() => {
      active--;
      next();
    }));
    next();
  });
}
```

The limiter tracks the number of active executions. When you call `limit(fn)`, the function gets queued. If there's capacity (`active &lt; concurrency`), it runs immediately. When it finishes, `active` decrements and the next queued function starts. This is a **counting semaphore** -- the `active` counter tracks available permits, `queue` is the waitlist, `next()` is the acquire operation, and the `finally` block is the release. The name comes from Dijkstra's 1965 paper. This design is more flexible than the worker pool -- you can limit different types of operations through the same limiter, and each call returns a promise for that specific operation's result.

The difference between the worker pool pattern (`pMap`) and the limiter pattern (`pLimit`) is scope. A worker pool operates over a fixed collection -- here are 500 URLs, process them with concurrency 10. A limiter is a long-lived object that gates access to a resource across the application's lifetime. You might create a limiter at startup with `const dbLimit = pLimit(20)` and use it everywhere that queries the database. Both enforce the same constraint. The pool is batch-oriented. The limiter is request-oriented.

When you need concurrency limiting:

- **API rate limits.** Third-party APIs enforce request-per-second caps. Exceeding them returns 429 errors.
- **Database connection pools.** A typical pool has 10-50 connections. Firing 500 queries exhausts the pool and makes everything wait.
- **File descriptor limits.** `ulimit -n` defaults to 1024 on most systems (covered in Chapter 4). Each socket uses a file descriptor.
- **Memory.** Each in-flight HTTP request holds buffers for the request body and response. 500 simultaneous large downloads can exhaust available RAM.

## Retry with Exponential Backoff

Network requests fail transiently. A 503, a connection reset, a DNS timeout. The server was busy for a second but is fine now. The correct response: wait a bit and try again.

Naive retry -- immediately retry on failure -- creates a problem. If the server is overloaded and 1,000 clients all retry immediately, you've doubled the load. The server goes from struggling to collapsing.

Exponential backoff spreads retries over time. The delay grows with each retry:

```
retry 0: wait 1000ms
retry 1: wait 2000ms
retry 2: wait 4000ms
retry 3: wait 8000ms
```

The formula: `delay = baseDelay * 2^retryIndex`. Common base delays are 100ms-1000ms depending on the operation. The first retry waits `baseDelay` (1000 * 2^0 = 1000ms), the second waits double that (1000 * 2^1 = 2000ms), and so on. Each retry waits twice as long as the previous one, reducing pressure on the failing service.

But pure exponential backoff has its own problem: **thundering herd**. If 1,000 clients all start retrying at the same time with the same base delay, they'll all retry at the same intervals. First attempt: 1,000 clients at t=0. Second attempt: 1,000 clients at t=1s. Third attempt: 1,000 clients at t=2s. The retries are synchronized.

**Jitter** fixes this by adding randomness to the delay:

```js
async function retry(fn, { maxRetries = 3, baseMs = 1000 } = {}) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try { return await fn(); } catch (err) {
      if (attempt === maxRetries) throw err;
      const jitter = baseMs * 2 ** attempt * (0.5 + Math.random() * 0.5);
      await new Promise(r => setTimeout(r, jitter));
    }
  }
}
```

The jitter formula randomizes the delay between 50% and 100% of the calculated backoff. The AWS architecture blog calls this pattern "equal jitter" -- half the delay is deterministic (the 0.5 floor), and the other half is random. Instead of 1,000 clients retrying at exactly t=1s, they spread across the 500ms-1000ms window. The load on the server becomes a gradual ramp instead of synchronized spikes. AWS's "full jitter" goes further, randomizing across the entire range from zero to the max backoff (`random_between(0, base * 2^attempt)`), which spreads load even more aggressively but occasionally produces very short delays.

Usage:

```js
const data = await retry(() => fetch('/api/data').then(r => r.json()));
```

A few guidelines on when to retry:

Retry transient failures: connection resets (ECONNRESET), 503 Service Unavailable, 429 Too Many Requests (respect the Retry-After header if present), DNS resolution failures, socket timeouts.

Don't retry permanent failures: 400 Bad Request (your data is wrong), 401/403 (authentication/authorization -- retrying won't change your credentials), 404 (resource doesn't exist), 422 (validation error). Retrying these wastes time and bandwidth.

The boundary between the two: set a maximum retry count. Three to five retries is typical. Beyond that, the failure is probably persistent. For production systems, you'd also track failure rates and implement a circuit breaker (covered in Chapter 29) -- if a dependency fails consistently, stop retrying and fail fast to protect both your service and theirs.

A more refined retry function would accept a predicate for deciding whether to retry:

```js
const data = await retry(
  () => fetch('/api/data'),
  { shouldRetry: (err) => err.status === 503 || err.code === 'ECONNRESET' }
);
```

The predicate inspects the error and returns true if the failure is transient. This prevents retrying permanent errors. The implementation adds one line to the catch block: `if (!shouldRetry(err)) throw err`. Simple, but it changes the behavior from "retry everything" to "retry selectively."

Retry interacts with idempotency. If you're retrying a POST request that creates a resource, you might create duplicates. The first request succeeded (the server created the record) but the response was lost (network timeout). Your retry creates the same record again. For mutations, either make the operation idempotent (use a client-generated idempotency key) or only retry GET/read operations. This is a general distributed systems concern, but it shows up immediately when you add retry logic to HTTP clients.

## Timeout and Cancellation

The timeout pattern with `Promise.race()` has a fundamental flaw: the operation continues after timeout. You told the caller "this timed out" but the actual work -- the HTTP request, the database query, the file read -- keeps going.

```js
const result = await Promise.race([
  fetch('/api/slow-endpoint'),
  timeout(3000)
]);
```

If the timeout fires at 3 seconds, the fetch is still running. It holds a TCP connection, consumes bandwidth, and eventually completes with a response that nobody reads. For one request, this is wasteful. For thousands of concurrent timeouts, it's a resource leak.

`AbortController` is the standard cancellation mechanism. It creates a signal that you pass to cancellable operations. When you call `controller.abort()`, the signal triggers and the operation stops.

```js
async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally { clearTimeout(timer); }
}
```

`fetch()` natively supports `AbortSignal`. When `controller.abort()` fires, the fetch cancels the underlying HTTP request. The TCP connection closes. The promise rejects with an `AbortError`. No wasted resources.

The `finally` block clears the timer if the fetch succeeds before the timeout. Without this, the timer would fire after the request completes, calling `abort()` on an already-settled operation. Harmless, but you'd be leaving timers around unnecessarily.

`AbortController` isn't limited to `fetch()`. The signal is a generic event target that fires an `abort` event. You can make any async operation cancellable:

```js
function delay(ms, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () =>
      { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }
    );
  });
}
```

This creates a delay that can be cancelled. If the signal aborts before the delay completes, the timer is cleared and the promise rejects. You can compose this with other operations:

```js
const controller = new AbortController();
await Promise.all([
  fetchData(controller.signal),
  processRecords(controller.signal),
  delay(1000, { signal: controller.signal })
]);
```

Calling `controller.abort()` cancels all three operations. A single abort signal propagates through everything it's connected to.

`setTimeout` from `node:timers/promises` (available since Node 15) accepts an `AbortSignal` directly:

```js
const { setTimeout: sleep } = require('node:timers/promises');
await sleep(5000, null, { signal: controller.signal });
```

The signal parameter lets you cancel the timer without manually managing `clearTimeout`. If the signal aborts, the returned promise rejects with an `AbortError`.

The combination of `Promise.race()` for timeout semantics and `AbortController` for actual cancellation gives you both -- the caller gets a timely rejection, and the underlying operation actually stops.

`AbortSignal.timeout()` is a static factory added in Node 17.3 that creates a signal which automatically aborts after a given number of milliseconds. It replaces the manual `setTimeout + AbortController.abort()` pattern:

```js
const response = await fetch(url, {
  signal: AbortSignal.timeout(5000)
});
```

One line. No manual timer management, no finally block to clean up. The signal aborts after 5 seconds, and the underlying timer is managed by the runtime. For simple timeout-then-cancel patterns, `AbortSignal.timeout()` is the cleanest option. For cases where you need to cancel based on external conditions (user action, parent operation completion), you still need a full `AbortController`.

`AbortSignal.any()` (Node 20+) composes multiple signals into one. The combined signal aborts when *any* of the input signals abort:

```js
const controller = new AbortController();
const combined = AbortSignal.any([
  controller.signal,
  AbortSignal.timeout(10000)
]);
```

This creates a signal that aborts either on manual trigger (`controller.abort()`) or after 10 seconds, whichever comes first. The composition parallels `Promise.race()` but for cancellation signals instead of promise values.

The `AbortController` / `AbortSignal` pattern has spread through the Node.js API surface. `fs.readFile()`, `fs.writeFile()`, `stream.pipeline()`, `events.once()`, `events.on()`, `child_process.exec()`, and `timers/promises` all accept an `AbortSignal` option. When you build async utilities, accepting an optional `{ signal }` parameter and forwarding it to underlying operations gives callers control over cancellation. It's become the idiomatic way to make async operations stoppable.

## Composing Patterns

These patterns compose naturally. A real-world example: fetch data from an API with timeout, retry on transient failure, limit concurrency to avoid overwhelming the server.

```js
const results = await pMap(urls, async (url) => {
  return retry(
    () => fetchWithTimeout(url, 5000),
    { maxRetries: 3, baseMs: 500 }
  );
}, 10);
```

This processes `urls` with at most 10 concurrent requests. Each request has a 5-second timeout with proper cancellation via AbortController. On transient failure, it retries up to 3 times with exponential backoff (500ms, 1s, 2s base delays with jitter). The outer `pMap` handles concurrency. The inner `retry` handles resilience. `fetchWithTimeout` handles cleanup.

Another composition: fan-out with partial failure tolerance.

```js
const health = await Promise.allSettled(
  services.map(s =>
    Promise.race([
      checkService(s),
      timeout(2000)
    ])
  )
);
```

Health-check every service, but don't wait more than 2 seconds for any of them, and collect results even if some fail. `Promise.race()` handles per-service timeout. `Promise.allSettled()` handles aggregate collection. Each service either responds in time, times out, or errors -- you get a complete picture regardless.

For CDN fallback with overall timeout:

```js
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 10000);
try {
  const data = await Promise.any(
    cdns.map(c => fetch(c, { signal: controller.signal }))
  );
  return data;
} finally { clearTimeout(timer); }
```

`Promise.any()` takes the first CDN to respond successfully. The AbortController enforces a 10-second overall deadline. If all CDNs fail, `AggregateError` surfaces every failure. If the deadline passes, the abort signal cancels every in-flight request.

## Gotchas and Edge Cases

A few things that bite people in production.

**Lost rejections in Promise.all().** When `Promise.all()` short-circuits on the first rejection, the remaining promises keep running. If more of them reject, those rejection reasons are silently discarded -- `Promise.all()` only surfaces the first one. The individual rejections don't cause `unhandledRejection` events (V8 attaches internal reject handlers to every input promise during iteration), but you lose diagnostic information. If three out of five database queries fail for different reasons, you only see the first error.

If you need visibility into all failures, either use `Promise.allSettled()` or wrap each promise to capture its outcome:

```js
const promises = urls.map(url =>
  fetch(url).catch(e => ({ error: e }))
);
const results = await Promise.all(promises);
```

Every promise always fulfills (with either data or an error object). You can then inspect `results` for entries with an `.error` property. This turns `Promise.all()` into a manual `Promise.allSettled()`.

**Sequential vs parallel by accident.** A common mistake:

```js
// Sequential -- each await blocks the next
const a = await fetchA();
const b = await fetchB();
const c = await fetchC();
```

This runs in series. `fetchB` doesn't start until `fetchA` completes. If each takes 200ms, total time is 600ms. The parallel version:

```js
// Parallel -- all start immediately, await together
const [a, b, c] = await Promise.all([
  fetchA(), fetchB(), fetchC()
]);
```

Total time: 200ms (assuming equal latency). The difference is when the promises are created. In the sequential version, each `await` suspends before the next `fetch()` call even starts. In the parallel version, all three `fetch()` calls execute immediately (creating three HTTP requests), and `Promise.all()` waits for all of them.

**Promise.race() with mixed promise types.** If you race a fetch against a timeout and the timeout rejects, the fetch's eventual resolution creates an unhandled fulfillment. This is less dangerous than an unhandled rejection (no `unhandledRejection` event), but the fetch still runs to completion. With `AbortController`, you avoid this entirely by cancelling the fetch when the timeout fires.

**AggregateError is iterable but not always helpful.** The `.errors` array preserves input order, matching the input iterable. But the individual errors might be connection resets, DNS failures, HTTP errors -- different types with different structures. You often need to inspect each one separately to decide on the appropriate recovery action. A generic `catch` that logs `err.message` misses the detail. Log `err.errors` instead.

**Microtask ordering between combinators.** `Promise.all()` with already-resolved promises doesn't resolve synchronously. It still goes through the microtask queue. Each input promise's `.then()` handler fires as a microtask, the resolve handler stores the value and decrements the counter, and when the counter hits zero, the combined promise resolves via another microtask. For two already-resolved promises, that's at least two microtask ticks before the combined promise resolves. The exact count depends on V8's internal optimization level (some paths are fast-tracked), but it's always asynchronous. This matters if you're reasoning about interleaving with `process.nextTick()` or other microtask-producing code.

**Error swallowing with `Promise.allSettled()` in loops.** A common antipattern:

```js
for (const batch of batches) {
  await Promise.allSettled(batch.map(process));
}
```

This processes every batch, ignoring all errors. If 90% of operations fail, you'd never know. `allSettled` is the "don't throw on failure" combinator, which means the responsibility for error handling shifts entirely to the caller. If you use it without inspecting the results, you're silently dropping errors. Always log or aggregate the rejected entries.

**Promise.all() with sparse arrays.** If the input iterable has holes (e.g., `[fetch('/a'), , fetch('/c')]`), the undefined slot gets wrapped in `Promise.resolve(undefined)`. The result array has `undefined` at that index. No error, no warning. Just a subtle bug if you're dynamically building the array and accidentally leave gaps.

## Putting It Together

Each combinator solves a different coordination problem. `Promise.all()` is for parallel execution with fail-fast semantics. `Promise.allSettled()` is for parallel execution with fault tolerance. `Promise.race()` is for time-boxing. `Promise.any()` is for redundancy with fallback.

The advanced patterns -- concurrency limiting, retry with backoff, timeout with cancellation -- layer on top. They control *how* the promises run, while the combinators control *how the results are aggregated*. A retry function wraps a single promise-returning function. A concurrency limiter gates how many promises execute simultaneously. AbortController stops operations that are no longer needed. You combine them freely: retry with timeout per-request, concurrency-limited across the batch, with `allSettled` collecting partial results.

This chapter started with callbacks -- the lowest-level async primitive. Then promises, which gave composition and chaining. Then async/await, which gave imperative-looking control flow over those compositions. EventEmitters, which gave the push-based event model. Async iterators, which gave pull-based consumption. And now the combinators, which give concurrent orchestration of multiple parallel operations.

Together, they form a complete set. Every async pattern you'll encounter in Node.js production code is a combination of these primitives. A WebSocket server that processes messages? EventEmitter for the incoming events, async iteration if you want pull-based consumption, promise combinators for parallel downstream calls, retry for resilience, AbortController for connection cleanup. A batch import job? Concurrency-limited map over the input, retry on transient database errors, `allSettled` to collect results, timeout per-item to bound execution time.

The primitives are simple. The power is in composition.
