---
title: "Async Iterators and for-await-of"
date: "2026-03-01"
excerpt: "The async iteration protocol, Symbol.asyncIterator, for-await-of mechanics, and backpressure with async generators."
category: "Async Patterns & Control Flow"
tags: ["nodejs", "async-iterators", "for-await-of", "async-generators", "async-patterns"]
author: "Ishtmeet Singh @ishtms"
chapter: "async-patterns"
subchapter: "async-iterators"
published: true
toc: true
---

## The Sync Protocol You Already Know

`for...of` works because objects implement a protocol. You call `Symbol.iterator` on the object, and it hands you an iterator -- an object with a `next()` method. Each call to `next()` returns `{ value, done }`. When `done` is `true`, the loop stops. That's it. Arrays, Maps, Sets, strings, typed arrays -- they all follow this contract.

```js
const arr = [10, 20, 30];
const iter = arr[Symbol.iterator]();
console.log(iter.next()); // { value: 10, done: false }
console.log(iter.next()); // { value: 20, done: false }
console.log(iter.next()); // { value: 30, done: false }
console.log(iter.next()); // { value: undefined, done: true }
```

The `for...of` loop is syntactic sugar over exactly this sequence. Get the iterator. Call `next()`. Check `done`. If `false`, execute the loop body with `value`. Repeat. If `done` is `true`, stop.

Sync iterators work perfectly when the data is available immediately. Array elements are in memory. Map entries are in memory. But what about data that arrives over time? A database cursor returning rows one by one across a network. An HTTP response streaming chunks. A file being read off disk. The value isn't available when you call `next()` -- it'll be available *later*, after some I/O completes. The sync iteration protocol can't handle that. `next()` returns `{ value, done }` synchronously. There's no place for a delay.

## The Async Iteration Protocol

The async version mirrors the sync protocol almost exactly, with one fundamental change. `Symbol.asyncIterator` replaces `Symbol.iterator`. And instead of `next()` returning `{ value, done }` directly, it returns a **promise** that resolves to `{ value, done }`.

```js
const asyncIterable = {
  [Symbol.asyncIterator]() {
    let i = 0;
    return { next() {
      if (i < 3) return Promise.resolve({ value: i++, done: false });
      return Promise.resolve({ value: undefined, done: true });
    }};
  }
};
```

That's a complete async iterable. The object has a `Symbol.asyncIterator` method. That method returns an iterator. The iterator's `next()` returns promises. Each promise resolves to the familiar `{ value, done }` shape. The consumer awaits each promise before proceeding. Everything else -- `value`, `done`, the loop mechanic -- stays the same.

You've been using async iterables since Chapter 3. Readable streams (covered in Chapter 3) implement `Symbol.asyncIterator`. Every `for await...of` loop you write over a stream uses this protocol. But the streams chapter introduced the syntax; this subchapter covers the protocol itself -- how the loop desugars, how cleanup works, how to build your own async iterables, and the internal implementation in Node.js.

## for-await-of: How the Loop Desugars

`for await (const item of source)` looks clean. What happens underneath is worth spelling out, because the details matter for error handling and resource cleanup.

Here's the rough desugaring:

```js
const iterator = source[Symbol.asyncIterator]();
let result = await iterator.next();
while (!result.done) {
  const item = result.value;
  // ... loop body ...
  result = await iterator.next();
}
```

Get the async iterator. Call `next()`. Await the returned promise. If `done` is `false`, bind the `value` to the loop variable, execute the body, then call `next()` again and await. When `done` is `true`, stop.

The `await` keyword here does the same thing it does everywhere else (covered in the previous subchapter on async/await) -- it suspends the enclosing async function, schedules the continuation as a microtask when the promise settles, and resumes from where it left off. Each iteration is sequential. The loop processes one item at a time. It calls `next()`, awaits the result, runs the body, and only *then* calls `next()` again. There's no parallelism inside `for await...of`. If the loop body takes 500ms of async work per item, and there are 100 items, that's 50 seconds minimum.

### When the Loop Body Throws

If your code inside the loop throws an error, the loop doesn't just bail out silently. It calls `iterator.return()` first -- if that method exists.

```js
for await (const chunk of readable) {
  if (chunk.length > 1024) {
    throw new Error('chunk too large');
  }
}
```

The throw triggers cleanup. The runtime calls `iterator.return()`, which gives the iterator a chance to release resources. For a readable stream, `return()` calls `stream.destroy()`. For an async generator, `return()` triggers any `finally` block in the generator body. The error then propagates outward to wherever the `for await...of` lives -- typically caught by a surrounding `try/catch`.

### break and return

Same behavior. If you `break` out of the loop or `return` from the enclosing function, the runtime calls `iterator.return()`. The iterator gets a chance to clean up. This is the protocol's resource management mechanism. Without it, breaking out of a `for await...of` over a stream would leave the stream open.

```js
async function findFirst(stream) {
  for await (const chunk of stream) {
    if (chunk.includes('target')) return chunk;
  }
  return null;
}
```

When `return chunk` executes, the loop calls `stream[Symbol.asyncIterator]().return()` (on the iterator obtained when the loop started). The stream gets destroyed. File descriptors get closed. No leak. This works because the `for await...of` loop internally wraps the iteration in a `try/finally` that calls `return()` in the `finally` block. You never see this wrapper, but it's always there.

### Errors from next()

When the promise returned by `next()` rejects, the rejection turns into a throw inside the loop. The `for await...of` statement catches the rejection, and you can handle it with `try/catch`:

```js
try {
  for await (const event of asyncSource) {
    process(event);
  }
} catch (err) {
  console.error('Source failed:', err.message);
}
```

If a readable stream has an error event, the stream's async iterator implementation converts that into a rejected promise from `next()`. The `for await...of` catches the rejection and throws. Your `try/catch` picks it up. This is the streamlined error model that makes `for await...of` attractive compared to manually attaching `'error'` event listeners. One `try/catch` handles both iterator-level errors and errors from your own loop body.

### Timing Implications

One thing that bites people: `for await...of` awaits even when the promise is already resolved. If the iterator returns `Promise.resolve(value)`, the await still yields to the microtask queue before continuing. Every single iteration involves at least one microtask hop. For sync-available data wrapped in an async iterable, this adds overhead compared to a regular `for...of`. It's usually negligible for I/O-bound work, but for CPU-bound iteration over already-available data, the microtask scheduling adds up.

You can observe this directly:

```js
async function* syncData() {
  yield 1; yield 2; yield 3;
}
console.log('before');
for await (const n of syncData()) {
  console.log(n);
}
console.log('after');
```

The output is `before`, `1`, `2`, `3`, `after` -- in that order. But between each number, the engine goes through a microtask hop. Each `await` on the already-resolved promise still defers to the microtask queue (as described in the async/await subchapter). You can observe the hops by scheduling a microtask that re-queues itself -- the ticks interleave between iterations because each `await` yields back to the microtask queue before resuming the loop. A single `queueMicrotask` call would fire once and vanish. But a self-re-queueing microtask keeps appearing between iterations, proving the hops are real. For tight loops over synchronous data, use `for...of` with a regular iterator if possible. Reserve `for await...of` for genuinely asynchronous sources.

## Async Generators

Writing an object with `Symbol.asyncIterator` and a manual `next()` method works, but it's verbose. Async generators -- `async function*` -- are the shorthand. An async generator function returns an `AsyncGenerator` object that automatically implements the async iteration protocol. You `yield` values, and the consumer gets them through `next()` calls that return promises.

```js
async function* fetchPages(url) {
  for (let page = 1; ; page++) {
    const res = await fetch(`${url}?page=${page}`);
    const data = await res.json();
    if (data.items.length === 0) return;
    yield data.items;
  }
}
```

This generator fetches paginated API results one page at a time. It `await`s the HTTP response, parses JSON, checks if there are more items, and `yield`s the items array. When there are no more items, `return` terminates the generator. The consumer drives the pacing:

```js
for await (const items of fetchPages('https://api.example.com/things')) {
  for (const item of items) {
    console.log(item.name);
  }
}
```

Each iteration of the outer `for await...of` triggers one `next()` call on the generator. The generator runs until it hits a `yield`, produces the value, and suspends. The consumer processes the yielded value. Then the next `next()` call resumes the generator from where it paused. The generator runs forward, awaiting the next fetch, parsing JSON, and yielding the next page.

### yield and await Combined

Inside an async generator, you can `await` and `yield` freely. They do different things. `await` suspends the generator until a promise settles. `yield` suspends the generator until the consumer calls `next()`. When you write `yield await somePromise`, the `await` resolves first, and then the resolved value is yielded to the consumer.

This distinction matters. The generator pauses at `yield` until the consumer asks for the next value. It pauses at `await` until the promise resolves. A generator sitting at a `yield` point is waiting for the consumer. A generator sitting at an `await` point is waiting for I/O or some other async operation.

Here's a generator that reads a file and yields each line after a transformation:

```js
async function* transformLines(filePath, transform) {
  const handle = await fs.promises.open(filePath, 'r');
  for await (const line of handle.readLines()) {
    const result = await transform(line);
    yield result;
  }
  await handle.close();
}
```

Three suspension points. The `await fs.promises.open()` suspends while the file opens. The `for await...of` internally awaits each line from the file. The `await transform(line)` suspends while the transform function runs (maybe it does an HTTP lookup or database query). And `yield result` suspends until the consumer calls `next()`. The generator's execution ping-pongs between these suspension points, advancing only when both the I/O and the consumer are ready.

### yield* Delegation

Async generators support `yield*` for delegating to another async iterable. If you have a helper generator that produces a subset of values, you can compose them:

```js
async function* allPages(urls) {
  for (const url of urls) {
    yield* fetchPages(url);
  }
}
```

`yield*` iterates through the delegated iterable and yields each value to the outer consumer. The delegation is transparent -- the consumer sees a flat sequence of yielded values, unaware that they came from multiple sources. `yield*` works with any async iterable, including readable streams.

### Controlling Generators from Outside

The `AsyncGenerator` object has three methods: `next(value)`, `return(value)`, and `throw(error)`.

`next(value)` resumes the generator from the last `yield` point. The value you pass becomes the result of the `yield` expression inside the generator. Most code doesn't use this -- `for await...of` always calls `next()` with no argument. But if you're manually stepping through a generator, you can send values back in.

`return(value)` forces the generator to finish. The generator's code jumps into any `finally` block, then the generator is done. The returned promise resolves to `{ value, done: true }`. This is what `for await...of` calls when you `break` or the loop body throws.

`throw(error)` resumes the generator by throwing the error at the `yield` point. If the generator catches it internally, execution continues. If it doesn't catch it, the generator terminates and the returned promise rejects.

In practice, most code uses `for await...of` and never touches these methods directly. The loop handles `next()` and `return()` automatically. But understanding them matters when you're debugging generator behavior or building higher-level abstractions. If your generator mysteriously stops producing values, it's often because something called `return()` unexpectedly -- a `break` in a loop you forgot about, or an error that triggered the loop's implicit cleanup.

### Cleanup with try/finally

Async generators handle resource cleanup through `try/finally`. When the consumer calls `return()` (via `break`, early `return`, or the loop body throwing), the generator's code jumps to the nearest `finally` block:

```js
async function* readLines(filePath) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    for await (const line of handle.readLines()) { yield line; }
  } finally {
    await handle.close();
  }
}
```

If the consumer breaks out of a `for await...of` loop over this generator, the `return()` call triggers the `finally` block. The file handle gets closed. The cleanup is deterministic and happens at the point of interruption. Without `try/finally`, breaking out of the loop would leave the file handle open until garbage collection (if ever).

This pattern -- open resource, try/yield values, finally/close resource -- is the canonical way to manage lifecycle in async generators. It's the reason generators are often better than manual `Symbol.asyncIterator` implementations: the cleanup logic is co-located with the resource acquisition, and the protocol guarantees the `finally` runs on any exit path.

## How Readable Streams Implement Symbol.asyncIterator

Readable streams gained `Symbol.asyncIterator` in Node 10. The implementation lives in `lib/internal/streams/async_iterator.js`. It's roughly 200 lines, and the design decisions are interesting because they solve a coordination problem: the stream pushes data, but the consumer pulls data. The async iterator protocol is pull-based -- the consumer calls `next()` when it's ready. Readable streams are push-based -- data arrives when the underlying source delivers it. The async iterator implementation bridges these models.

When you call `stream[Symbol.asyncIterator]()`, the stream creates an iterator object backed by the `ReadableStreamAsyncIteratorPrototype`. This object holds a reference to the stream and maintains an internal queue of pending read results. The iterator listens for `'readable'` directly, and uses the internal `finished()` utility to detect completion and errors -- which registers listeners for `'end'`, `'finish'`, `'error'`, and `'close'`.

The `next()` method checks the stream's internal buffer first. If data is available, `next()` calls `stream.read()` to grab a chunk and returns `Promise.resolve({ value: chunk, done: false })`. No waiting involved. The data was already buffered; the promise resolves immediately (or rather, it's a resolved promise -- the consumer still goes through a microtask hop due to `await`).

If no data is available in the buffer, `next()` creates a promise and stores its resolve/reject functions. The iterator then waits for the `'readable'` event. When the stream fires `'readable'` (meaning new data arrived in its internal buffer), the iterator calls `stream.read()`, grabs the data, and resolves the pending promise with `{ value: chunk, done: false }`. The consumer's `await` completes, and the loop body runs.

The `'end'` event fires when the stream has no more data. The iterator resolves any pending `next()` promise with `{ value: undefined, done: true }`. Future calls to `next()` also return `{ value: undefined, done: true }` immediately -- the iterator remembers that the stream ended.

Errors follow a parallel path. When the stream emits `'error'`, the iterator rejects the pending `next()` promise. If there's no pending `next()` (the consumer hasn't asked for data yet), the error gets queued. The next `next()` call will reject immediately with the stored error. This means errors are never swallowed -- they'll surface as soon as the consumer asks for the next value.

The iterator tracks its lifecycle through several Symbol-keyed internal slots: `kLastResolve` and `kLastReject` hold the pending promise's resolution functions (or `null` when no `next()` is outstanding), `kError` stores a queued error, `kEnded` flags whether the stream has finished, and `kStream` references the underlying readable. These slots act as guards -- calling `next()` on an already-errored iterator always rejects immediately with the stored error. Calling `next()` on an ended iterator always returns `{ done: true }`. Only one `next()` should be outstanding at a time (the `for await...of` loop enforces this by awaiting before calling `next()` again), which keeps the resolve/reject slot management simple.

### Backpressure and highWaterMark

The stream's async iterator pulls one chunk at a time via `stream.read()`. After the consumer processes a chunk and calls `next()` again, the iterator pulls another. This sequential pull pattern inherently respects backpressure. The stream buffers data up to its `highWaterMark`, and the async iterator drains it one chunk per iteration. If the consumer is slow (maybe it's writing each chunk to another stream or making an HTTP request per chunk), the iterator doesn't call `read()` until the consumer is ready. The stream's internal buffer fills up, and the underlying source gets told to stop pushing.

Compare this to `readable.on('data', handler)` in flowing mode. With `'data'` events, the stream pushes as fast as it can. The handler fires synchronously for each chunk. If the handler does async work, the stream doesn't wait -- it keeps pushing. The handler needs to manually call `stream.pause()` and `stream.resume()` to control flow. With `for await...of`, the backpressure is automatic. The pull-based model means the stream only delivers a chunk when the consumer asks for one.

The implementation also has a subtle optimization. When you use `for await...of` on a stream, the iterator calls `stream.read()` in a specific way. If the stream is in flowing mode, the iterator switches it to paused mode. It manages the reads explicitly through `stream.read()` rather than `'data'` events. This gives the iterator precise control over when data is consumed. The stream can still buffer ahead (up to `highWaterMark`), but the iterator drains the buffer at its own pace.

### Resource Cleanup

The iterator's `return()` method calls `stream.destroy()`. When you `break` out of a `for await...of` loop on a stream, the loop calls `return()`, which destroys the stream. File descriptors close. Network sockets terminate. This is the reason `for await...of` is the preferred way to consume streams -- it handles cleanup automatically, even on early exit.

One thing to watch: if you call `stream[Symbol.asyncIterator]()` manually and don't consume the full stream, you need to call `return()` on the iterator yourself. The `for await...of` syntax does this for you, but manual protocol usage requires manual cleanup. Forgetting `return()` on a partially-consumed stream iterator leaves the stream open.

There's a separate method -- `readable.iterator(options)` -- added in Node 16.3 that gives you control over this. By default, `return()` destroys the stream. But `readable.iterator({ destroyOnReturn: false })` creates an async iterator that won't destroy the stream on early exit. Note that `Symbol.asyncIterator()` itself takes no arguments -- you have to call `readable.iterator()` explicitly to pass options. This is useful when you want to share a stream between multiple consumers or resume reading later, but it shifts cleanup responsibility to you.

## events.on() and events.once()

The previous subchapter on EventEmitter internals introduced `events.on()` and `events.once()` as bridges between the event world and the async world. Here's how they actually work.

### events.on()

`events.on(emitter, eventName, options)` returns an `AsyncIterator` that yields arrays of event arguments. Every time the emitter fires the named event, the iterator produces the event's arguments as an array:

```js
const { on } = require('events');
const ee = new EventEmitter();

async function consume() {
  for await (const [msg] of on(ee, 'message')) {
    console.log('Got:', msg);
  }
}
```

Each time `ee.emit('message', 'hello')` fires, the `for await...of` loop gets `['hello']`. The destructuring `[msg]` pulls out the first argument.

The internal implementation registers a listener for `eventName` on the emitter. When the event fires, the listener pushes the arguments array into an internal queue (a simple array used as a FIFO). If there's a pending `next()` call waiting for data, the queued value immediately resolves the pending promise. If there's no pending `next()` (the consumer is busy processing a previous event), the value sits in the queue until the consumer calls `next()`.

This buffering behavior is worth paying attention to. If events fire faster than the consumer processes them, the queue grows. There's no built-in backpressure mechanism for `events.on()`. The emitter fires events synchronously (covered in the previous subchapter). The listener adds to the queue. The consumer drains the queue asynchronously. If the consumer is slow -- maybe it does a database write per event -- and the emitter fires 1,000 events per second, the queue fills up with 1,000 entries per second. Memory grows linearly. There's no highWaterMark, no pause mechanism, no flow control. For high-throughput event sources, consider a more explicit buffering strategy.

### Error Handling in events.on()

By default, if the emitter fires an `'error'` event, the async iterator throws. The `for await...of` loop gets the error as a rejection from `next()`. You handle it with `try/catch`:

```js
try {
  for await (const [data] of on(stream, 'data')) {
    process(data);
  }
} catch (err) {
  console.error('Stream error:', err);
}
```

You can specify which events signal completion by passing `close` in the options. Without this option, the iterator runs indefinitely (until the emitter errors or you break out). Passing event names to `close` tells the iterator when to finish:

```js
const iter = on(emitter, 'data', { close: ['end', 'finish'] });
```

Now the iterator completes (returns `{ done: true }`) when `'end'` or `'finish'` fires.

### AbortSignal Support

`events.on()` accepts an `AbortSignal` for external cancellation:

```js
const ac = new AbortController();
setTimeout(() => ac.abort(), 5000);

for await (const [msg] of on(ee, 'message', { signal: ac.signal })) {
  console.log(msg);
}
```

When the signal aborts, the iterator throws an `AbortError`. The `for await...of` loop exits, and cleanup runs. This is the standard way to add timeouts or cancellation to event-driven iteration. The iterator's internal listener gets removed from the emitter on cancellation, preventing memory leaks from lingering listeners.

### events.once()

`events.once(emitter, eventName, options)` returns a promise that resolves with an array of the event arguments the first time the event fires:

```js
const { once } = require('events');
const server = require('http').createServer();

server.listen(3000);
await once(server, 'listening');
console.log('Server is up');
```

The promise resolves with the argument array when the event fires once. If the emitter fires an `'error'` event before the target event, the promise rejects with the error. If you pass an `AbortSignal` and it aborts before the event fires, the promise rejects with an `AbortError`.

`events.once()` is the promise equivalent of `emitter.once(eventName, listener)`, but instead of a callback, you get a promise you can `await`. It removes the listener after the event fires (or after an error), so there's no cleanup to worry about.

A practical pattern is using `events.once()` to wait for server readiness, socket connection, or any one-time lifecycle event. It's cleaner than wrapping `emitter.once()` in a `new Promise()` manually, and it handles the `'error'` event edge case automatically.

The difference between `events.on()` and `events.once()` is the iteration model. `events.on()` gives you a continuous stream of events -- you keep looping until the emitter closes or errors. `events.once()` gives you a single event -- one promise, one resolution. They complement each other. Use `once()` for waiting on one-time lifecycle events (server listening, connection established, process exit). Use `on()` for consuming ongoing streams of events (incoming requests, incoming messages, incoming data chunks).

## Building Custom Async Iterables

Sometimes you need an async iterable that doesn't come from a stream or an EventEmitter. Maybe you're wrapping a callback-based API, or building a producer-consumer queue, or implementing your own data pipeline.

### Manual Implementation

The manual approach is short. An object with a `Symbol.asyncIterator` method that returns an iterator with `next()`, and optionally `return()` and `throw()`:

```js
function createCounter(limit, delay) {
  let count = 0;
  return { [Symbol.asyncIterator]() { return { async next() {
    await new Promise(r => setTimeout(r, delay));
    if (count < limit) return { value: count++, done: false };
    return { value: undefined, done: true };
  }};}};
}
```

The `next()` function is `async`, so it returns a promise automatically. Each call waits for a timeout, then returns the next count value. When the count reaches the limit, it returns `done: true`. You'd consume this with `for await (const n of createCounter(5, 100))`.

### Wrapping Callback-Based APIs

Async generators excel at wrapping callback-based APIs into pull-based iterables. Say you have a function that reads records from a database cursor, one at a time, via callbacks:

```js
async function* iterateCursor(cursor) {
  try { while (true) {
    const rec = await new Promise((res, rej) =>
      cursor.next((e, r) => e ? rej(e) : res(r)));
    if (!rec) return;
    yield rec;
  }} finally { cursor.close(); }
}
```

The generator wraps each callback invocation in a promise, `await`s it, and `yield`s the result. The `try/finally` ensures the cursor closes whether the consumer reads all records or breaks early. This is a common pattern for adapting older callback-based APIs to the async iteration model.

### Queue-Based Async Iterable

The most flexible custom pattern is a queue-based async iterable with separate producer and consumer sides. The producer pushes values in. The consumer pulls values out via `for await...of`. The coordination problem: what happens when the producer pushes a value and no consumer is waiting? Or when the consumer calls `next()` and no value is available?

Here's a minimal implementation. The producer side:

```js
function createQueue() {
  const values = [], waiters = [];  let done = false;
  return {
    push(v) { if (waiters.length) waiters.shift()(v); else values.push(v); },
    end() { done = true; while (waiters.length) waiters.shift()(null); },
    [Symbol.asyncIterator]() { return { next: () => pull() }; }
  };
```

And the `pull()` function that implements the consumer side:

```js
  function pull() {
    if (values.length)
      return Promise.resolve({ value: values.shift(), done: false });
    if (done) return Promise.resolve({ value: undefined, done: true });
    return new Promise(resolve => waiters.push(v =>
      resolve(v === null ? { done: true, value: undefined }
                         : { value: v, done: false })));
  }
}
```

Two arrays. `values` holds items pushed by the producer that haven't been consumed yet. `waiters` holds resolve functions from promises created by `pull()` when no data was available. When the producer calls `push(value)`, it first checks if there's a waiting consumer. If so, it resolves the consumer's promise directly. If not, it queues the value. When the consumer calls `next()` (via `pull()`), it checks if there's a queued value. If so, it returns immediately. If not, it creates a promise and parks the resolve function in `waiters`.

This is the producer-consumer coordination pattern at its core. The two arrays act as a rendezvous point. When producer and consumer are matched in time, data flows directly. When they're mismatched, the faster side queues its work until the slower side catches up.

The problem with this simple version: no backpressure. If the producer calls `push()` 10,000 times before the consumer starts iterating, the `values` array holds 10,000 entries in memory. For bounded producers (a fixed number of database rows, a finite API response), this might be fine. For unbounded producers (a live event stream, a continuous sensor feed), you need a buffering limit and a way to signal the producer to slow down.

A practical approach: track the buffer size and return a boolean from `push()` indicating whether the buffer is below a threshold. The producer checks the return value and backs off if the buffer is full. This mirrors how `writable.write()` returns `false` when the internal buffer exceeds `highWaterMark` (covered in Chapter 3). The pattern repeats across Node.js APIs.

### When to Use Generators vs Manual Implementation

Async generators are the right choice 90% of the time. They handle cleanup through `try/finally`. They're readable. The protocol compliance is automatic -- you just `yield` values and the generator object handles `next()`, `return()`, and `throw()` for you.

Manual `Symbol.asyncIterator` implementations make sense in a few cases. When you need fine-grained control over the promise lifecycle -- for example, if you want to return already-resolved promises from `next()` to avoid unnecessary microtask hops. When you need to implement custom behavior for `return()` or `throw()` that doesn't map cleanly to generator control flow. Or when you're building a library primitive that needs to be as lightweight as possible and can't afford the per-iteration overhead of generator suspension and resumption.

The queue-based pattern above is the most common case for manual implementation. The producer and consumer are decoupled -- they might be in different parts of the codebase, different modules, different timing contexts. An async generator assumes the producer and consumer are the same function (the generator body both creates and yields values). A queue explicitly separates them. The producer calls `push()`. The consumer iterates with `for await...of`. They don't need to know about each other.

## Patterns and Practical Considerations

### Pipeline with Async Generators

You can compose async generators into transformation pipelines. Each generator takes an async iterable as input and yields transformed values:

```js
async function* map(source, fn) {
  for await (const item of source) { yield fn(item); }
}
async function* filter(source, predicate) {
  for await (const item of source) {
    if (predicate(item)) yield item;
  }
}
```

Chain them: `filter(map(source, transform), predicate)`. Each stage pulls from the previous stage, transforms, and yields. The pull-based nature means only one item flows through the entire pipeline at a time. There's no intermediate buffering between stages (beyond what each async iterator implementation might buffer internally). This is lazy evaluation -- no work happens until the final consumer asks for a value.

### stream.pipeline() with Async Generators

Since Node 13, `stream.pipeline()` (covered in Chapter 3) accepts async generators as transform stages. You can mix streams and generators in a single pipeline:

```js
const { pipeline } = require('stream/promises');
await pipeline(
  fs.createReadStream('input.txt'),
  async function* (source) {
    for await (const chunk of source) { yield chunk.toString().toUpperCase(); }
  },
  fs.createWriteStream('output.txt')
);
```

The pipeline connects the read stream to the async generator to the write stream. Backpressure propagates through all three stages. If the write stream's buffer fills up, the generator pauses at `yield`, and the read stream's async iterator pauses at `next()`. The generator acts as a transform stage without needing to subclass Transform or implement `_transform()`. For simple transformations, this is less ceremony than building a Transform stream.

The pipeline also handles errors and cleanup. If any stage fails, the entire pipeline is torn down. The read stream gets destroyed, the write stream gets destroyed, and the async generator's `return()` method triggers its `finally` block.

### The Serial Nature of for-await-of

Every `for await...of` loop processes items one at a time. There's no built-in way to process multiple items in parallel. This is by design -- the protocol is sequential. `next()` returns one promise. You await it. You process the value. Then you call `next()` again.

If you need parallel processing, you have to break out of `for await...of` and manage concurrency manually. One pattern: collect items into batches, then process each batch with `Promise.all()`:

```js
async function processBatched(source, batchSize, fn) {
  let batch = [];
  for await (const item of source) {
    batch.push(fn(item));
    if (batch.length >= batchSize) { await Promise.all(batch); batch = []; }
  }
  if (batch.length > 0) await Promise.all(batch);
}
```

This collects up to `batchSize` promises, runs them concurrently, waits for the batch to complete, then moves to the next batch. It's not fully parallel (items within a batch are concurrent, but batches are sequential), but it's a practical middle ground between fully serial and unbounded concurrency.

### Memory with events.on()

As mentioned earlier, `events.on()` buffers events internally. If your consumer does async work per event and the emitter fires events faster than the consumer processes them, memory grows. There's no warning, no error, no highWaterMark. The queue just grows.

For most use cases -- a server emitting request events at moderate rates, a socket emitting data events with inherent I/O pacing -- this isn't a problem. The producer's natural rate limiting (network latency, disk I/O speed) keeps the queue short. But for synthetic event sources (timers firing at high frequency, programmatic emit calls in a tight loop), the queue can balloon.

If you're worried about this, consider using a readable stream with `for await...of` instead of `events.on()`. Streams have backpressure built in. Or implement a custom queue with a bounded buffer and explicit flow control, as shown in the queue section above.

### Async Iteration as a Unifying Abstraction

Streams, EventEmitters, database cursors, paginated APIs, file line readers, WebSocket messages -- all of these can be consumed through `for await...of`. The async iteration protocol is the lowest common denominator. If a data source implements `Symbol.asyncIterator`, you can iterate it. The error handling model is consistent (rejections become throws). The cleanup model is consistent (`return()` gets called on early exit). The sequential processing model is consistent (one item at a time).

### for await...of with Non-Async Iterables

A detail from the spec: `for await...of` works with regular (sync) iterables too. If the object has `Symbol.iterator` but no `Symbol.asyncIterator`, the loop falls back to the sync protocol and wraps each `{ value, done }` result in `Promise.resolve()`. This means you can write `for await (const item of [1, 2, 3])` and it works. Each value gets awaited. If any value is a promise, it gets resolved before the loop body runs.

But there's rarely a good reason to do this. Using `for await...of` on a sync iterable adds a microtask hop per iteration for no benefit. It's occasionally useful when you have an array of promises and want to process them sequentially as they resolve:

```js
const urls = ['https://a.com', 'https://b.com'];
const promises = urls.map(url => fetch(url));
for await (const response of promises) {
  console.log(response.status);
}
```

Each response is awaited in order. The second `await` doesn't start until the first completes. This is sequential processing of an array of promises -- the same as writing `await promises[0]; await promises[1]`. If you wanted parallel execution, you'd use `Promise.all()` instead (covered in the next subchapter).

Where things get interesting is composability. Because async generators both consume and produce async iterables, they're the natural building blocks for data pipelines. A generator can read from a stream, transform each chunk, and yield the result. Another generator can take that output, filter it, and yield the filtered values. `stream.pipeline()` can wire them together with backpressure and error propagation. The protocol is simple enough that building custom async iterables for specialized use cases takes maybe 20 lines of code. The queue-based pattern above is a template that covers most producer-consumer scenarios.

The async iteration protocol and `for await...of` are the pull-based counterpart to EventEmitter's push-based model. EventEmitter says "here's data, deal with it." Async iteration says "give me data when I'm ready." Both have their place. For high-throughput scenarios where the consumer needs flow control, pull-based wins. For fire-and-forget event dispatching where every listener should react immediately, push-based wins. And `events.on()` sits at the bridge between them, converting push-based events into a pull-based async iterable, with the caveat that it buffers unboundedly when the consumer can't keep up.
