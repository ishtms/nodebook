---
title: "EventEmitter Internals"
date: "2026-03-01"
excerpt: "The _events object, synchronous dispatch, listener storage optimizations, the error event contract, and memory leak warnings."
category: "Async Patterns & Control Flow"
tags: ["nodejs", "eventemitter", "events", "async-patterns", "observer-pattern"]
author: "Ishtmeet Singh @ishtms"
chapter: "async-patterns"
subchapter: "eventemitter-internals"
published: true
toc: true
---

Every HTTP server, every stream, every child process in Node.js inherits from the same class. `EventEmitter` sits at the bottom of most object hierarchies in the runtime, and yet the internals are simple enough to fit in a single file - `lib/events.js` in the Node.js source. The surface API (`on`, `emit`, `off`) hides an implementation that's worth understanding, especially the part most people miss: `emit()` is synchronous. Your listener runs on the same call stack as the code that emitted the event.

You already know what EventEmitter is from the streams chapters (covered in Chapter 3). This subchapter is about *how* it works. The data structures inside it, the dispatch mechanics, the error event contract that crashes your process, and where EventEmitter fits alongside callbacks, promises, and async/await as a coordination pattern.

## The _events Object

When you create a new `EventEmitter`, three internal properties get initialized:

```js
const EventEmitter = require('events');
const ee = new EventEmitter();
console.log(ee._events);       // [Object: null prototype] {}
console.log(ee._eventsCount);  // 0
console.log(ee._maxListeners); // undefined
```

`_events` is created with `Object.create(null)`. That's a deliberate choice. A `null`-prototype object has no inherited properties - no `toString`, no `hasOwnProperty`, no `constructor`. This prevents prototype pollution attacks where someone might emit an event named `__proto__` or `constructor` and accidentally invoke an inherited method instead of a listener. A regular `{}` inherits from `Object.prototype`, and `Object.prototype` has properties like `__proto__`, `toString`, `valueOf`, and `hasOwnProperty`. If you used a regular object for `_events` and someone called `ee.emit('toString')`, the lookup `this._events['toString']` would find `Object.prototype.toString` - a function - and the emit logic would try to call it as a listener. With `Object.create(null)`, there's nothing on the prototype chain. Every property lookup that doesn't find a directly-set key returns `undefined`.

The keys of `_events` are event names. The values are either a single function or an array of functions. Here's the optimization that surprises people: when only one listener exists for an event, Node stores the function directly on the key - no array wrapping. The second listener triggers promotion to an array. Removing listeners can demote back to a single function. This avoids array allocations for the common case where an event has exactly one listener (think `'error'` handlers, `'close'` handlers, `'finish'` handlers on streams). In practice, most events on most emitters have exactly one listener. A Readable stream typically has one `'data'` listener, one `'end'` listener, and one `'error'` listener. Wrapping each of those in a single-element array would be pure overhead.

`_eventsCount` is a simple integer. It tracks the total number of event names with at least one listener. Node uses this for a fast "are there any listeners at all?" check without iterating `_events`. When `_eventsCount` is 0, there's nothing to dispatch. The emit implementation checks this early and returns `false` immediately, avoiding even the property lookup on `_events`.

`_maxListeners` starts as `undefined`, which means "use the default." The default is 10, pulled from `EventEmitter.defaultMaxListeners`. You can override it per instance with `setMaxListeners()`. Setting it to `0` or `Infinity` disables the warning entirely. But the warning deserves its own section - we'll get there.

### EventEmitter.init()

Construction is minimal. `EventEmitter.init()` (called by the constructor, and also available for subclass constructors to call directly) checks whether `_events` already exists. If the instance already has an `_events` property from a prior initialization or inherited from the prototype, it creates a fresh one. Otherwise it assigns the `null`-prototype object. It sets `_eventsCount` to 0 and `_maxListeners` to `undefined`.

The reason for the "already exists" check: JavaScript prototype inheritance. If a subclass prototype has an `_events` object (because `EventEmitter.init()` was called on the prototype itself), every instance would share that same `_events` via the prototype chain. The guard detects this by comparing `this._events === ObjectGetPrototypeOf(this)._events`. When they match, the instance is seeing an inherited `_events` rather than its own, so `init()` creates a fresh one. Without this check, two instances of the same subclass could accidentally share event registrations through their shared prototype. The TCP socket wrapper in `net.Socket` is one example - `net.Socket` extends `stream.Duplex` which extends EventEmitter, and the prototype chain means this guard matters during construction.

One detail that catches people: `_events`, `_eventsCount`, and `_maxListeners` are regular enumerable properties. They show up in `JSON.stringify()`, in `Object.keys()`, in spread operations. If you're serializing an EventEmitter subclass, you'll see these internals in the output unless you filter them. A `toJSON()` method on your subclass that excludes these keys is the usual fix. Or just be aware that `Object.assign({}, myEmitter)` copies them too.

## Listener Registration

### on() and addListener()

`on(eventName, listener)` and `addListener(eventName, listener)` are the same function. Literally - `addListener` is an alias assigned to the same method reference. Both push the listener onto the array for that event name. If no listeners exist yet, they store the function directly. If one listener already exists (stored as a bare function), they promote to a two-element array.

```js
const ee = new EventEmitter();
ee.on('data', fn1);
console.log(ee._events.data === fn1); // true - bare function
ee.on('data', fn2);
console.log(Array.isArray(ee._events.data)); // true - promoted
console.log(ee._events.data.length);         // 2
```

Registration order matters. Listeners fire in the order they were added. `on()` appends to the end. `prependListener()` inserts at the beginning - it uses array `unshift()` semantics, so the prepended listener fires first. There's also `prependOnceListener()`, which does the same thing but with once-only semantics. Both prepend variants exist because sometimes you need to intercept an event before other handlers process it - logging middleware, validation checks, things like that.

The listener function must be a function. Passing anything else - a string, a number, `undefined` - throws a `TypeError`. This is validated inside `_addListener`, the internal function that all registration methods funnel through. The check happens synchronously, before the `'newListener'` event fires.

### The newListener Event

Before a listener is actually added, EventEmitter emits a `'newListener'` event with the event name and the listener function as arguments. This fires *before* the listener is appended to the array. That ordering is intentional: if your `'newListener'` handler itself calls `on()` for the same event, the new listener gets inserted before the one that triggered the `'newListener'` emission.

```js
ee.on('newListener', (event, listener) => {
  console.log(`Adding listener for ${event}`);
});
ee.on('connection', () => {});
// logs: "Adding listener for connection"
```

The `'newListener'` event fires for every `on()`, `once()`, `addListener()`, and `prependListener()` call. The symmetric counterpart is `'removeListener'`, which fires *after* a listener is removed. The asymmetry (newListener fires before add, removeListener fires after remove) is documented behavior.

The before/after asymmetry serves a purpose. `'newListener'` firing before the add means you can intercept the registration and modify behavior - add a different listener, set up dependencies, even skip the registration by calling `off()` on the listener that's about to be added (though that's unusual). `'removeListener'` firing after the remove means the listener is already gone when your handler runs, so you know the emitter state reflects the removal.

These events are primarily useful for debugging and instrumentation. Diagnostic tools use `'newListener'` to track which events are being listened to across the application. APM libraries hook into it to automatically instrument event handlers. Production code rarely needs them directly. But they're the mechanism that makes tools like `diagnostics_channel` integration possible - an observer can watch for listener registration patterns without modifying the code that registers the listeners.

One gotcha: `'newListener'` itself triggers `'newListener'`. If you register a listener for `'newListener'`, that registration emits `'newListener'`. If your handler isn't careful, you can create an infinite loop. The Node.js source doesn't guard against this - it's your responsibility.

### once()

`once(eventName, listener)` creates a wrapper function around your listener. The wrapper, when called, first removes itself using `off()`, then calls your original function. The listener fires exactly one time, then it's gone.

```js
ee.once('ready', () => {
  console.log('fired once');
});
ee.emit('ready'); // logs "fired once"
ee.emit('ready'); // nothing
```

The implementation stores a `.listener` property on the wrapper function pointing back to the original. This is how `removeListener()` can match your original function against a `once()` registration - it checks both the wrapper and the `.listener` property when searching for a match. Without this, you'd have no way to remove a `once()` listener before it fires, because the function stored in `_events` is the wrapper, not your original.

Here's the actual sequence when `emit()` triggers a `once()` listener:

1. `emit()` encounters the wrapper function in the listeners array (or as the bare function).
2. The wrapper calls `this.removeListener(type, wrapper)` - this removes the wrapper from `_events`.
3. The wrapper then calls `listener.apply(this, args)` - your original function runs.
4. If your function throws, it's already been removed. The throw propagates, but the listener is gone regardless.

That order (remove first, then call) matters. If your `once()` listener throws, the listener has already been removed. The error propagates, but the listener won't fire again even if you somehow catch the error and re-emit the event. And if your listener itself emits the same event on the same emitter, the once listener is already gone so it won't recurse.

### off() and removeListener()

`off()` is an alias for `removeListener()`. It searches the listener array for a match (using `===` strict equality, or checking `.listener` for `once()` wrappers), removes the first match, and if only one listener remains, demotes the array back to a bare function. If no listeners remain, it deletes the key from `_events` and decrements `_eventsCount`.

The "first match" behavior matters. If you've registered the same function twice for the same event, calling `off()` once removes only the first occurrence. The second registration stays. This is consistent with how `addEventListener` works in the DOM, though the DOM deduplicates by default (EventTarget rejects duplicate function+event+capture combinations).

Removing listeners during an `emit()` call has specific, well-defined behavior that comes from the array copy in `emit()`.

### rawListeners()

`rawListeners()` returns a copy of the listeners array including the wrapper functions for `once()` registrations. Compare this with `listeners()`, which unwraps `once()` wrappers by returning the `.listener` property. If you need to know which listeners are once-only versus persistent, `rawListeners()` is the tool. The wrapper functions created by `once()` have a `.listener` property - if that property exists, the listener was registered with `once()`.

## Synchronous Dispatch: emit()

This is the thing about EventEmitter that trips people up. `emit()` is synchronous. Completely, entirely synchronous. When you call `emit('data', chunk)`, every listener registered for `'data'` runs on the current call stack, in registration order, before `emit()` returns. There's no queueing, no deferring, no microtask scheduling.

```js
ee.on('tick', () => console.log('A'));
ee.on('tick', () => console.log('B'));
console.log('before');
ee.emit('tick');
console.log('after');
// before -> A -> B -> after
```

The ordering is deterministic. `'A'` and `'B'` print between `'before'` and `'after'`. The `emit()` call doesn't return until both listeners have finished executing. If listener A takes 500ms of synchronous computation, listener B waits. Everything after the `emit()` call waits. The entire call stack above `emit()` is blocked.

This catches people who assume events are asynchronous because "events" sound asynchronous. They hear "event-driven" and think there's a queue somewhere, that listeners fire on the next tick. Nope. `emit()` is a synchronous function call loop. Nothing more.

The synchronous model has real implications for application design. If you have a stream with a `'data'` listener that does heavy processing, the stream can't deliver the next chunk until your listener returns. In a server context, a slow `'connection'` listener delays all subsequent connection acceptance for the duration of that listener. The event loop (covered in Chapter 1) can't advance to the next phase while your listener is running.

Here's a concrete example showing the blocking behavior:

```js
ee.on('work', () => {
  const start = Date.now();
  while (Date.now() - start < 200) {} // 200ms spin
  console.log('listener done');
});
console.log('before emit');
ee.emit('work');
console.log('after emit'); // 200ms later
```

The `'after emit'` line prints 200ms after `'before emit'`, because `emit()` doesn't return until the listener's busy-wait loop completes. This is the same behavior you'd get from a plain function call, because that's exactly what `emit()` is - a loop of function calls.

### How emit() Actually Works

The implementation in `lib/events.js` is roughly this logic:

1. If the event name is `'error'`, handle the special error contract (more on this later).
2. Look up `this._events[type]`. If nothing's there, return `false`.
3. If it's a single function, call it with the provided arguments.
4. If it's an array, make a copy of the array, then iterate and call each function.

The array copy in step 4 is the subtle part. Node copies the listeners array before iterating because a listener might call `off()` or `on()` during the emission. Without the copy, removing a listener would shift array indices and cause listeners to be skipped or called twice. The copy isolates the iteration from mutations.

```js
ee.on('test', function handler() {
  ee.off('test', handler); // remove self during emit
});
ee.on('test', () => console.log('second'));
ee.emit('test'); // "second" still fires
```

The second listener fires even though the first listener removed itself. The `emit()` call iterates over a snapshot of the listeners that existed when `emit()` was invoked. Listeners added *during* an `emit()` don't fire for the current emission - they'll fire on the next one.

Consider what would happen without the copy. You have listeners `[A, B, C]`. You're at index 0, calling A. A calls `off('test', A)`, which splices A out. Now the array is `[B, C]`. The loop increments to index 1, which is now C - B gets skipped entirely. This is the classic "mutating an array during iteration" bug, and the copy prevents it completely.

### Arguments and Return Value

`emit()` passes all arguments after the event name directly to each listener. No cloning, no wrapping, no intermediate object. If you pass an object as an argument, every listener receives the same object reference. Mutating it in one listener affects all subsequent listeners:

```js
ee.on('req', (ctx) => { ctx.modified = true; });
ee.on('req', (ctx) => { console.log(ctx.modified); }); // true
ee.emit('req', { modified: false });
```

This shared-reference behavior is intentional and matches how function arguments work in JavaScript generally. But it means listeners can interfere with each other. A listener that modifies its arguments is modifying the same object that other listeners see. In Express.js, this is how middleware works - the `req` and `res` objects are shared references passed through emit-like dispatch. But in general-purpose EventEmitter usage, mutating shared arguments is a source of subtle ordering bugs.

The return value of `emit()` is a boolean: `true` if at least one listener was registered for the event, `false` otherwise. This is useful for the error event pattern, but it's also used in Node internals to check whether anyone is listening before doing expensive work. The Readable stream, for instance, checks if there are `'data'` listeners before switching into flowing mode. If `emit('data', chunk)` returns `false`, the stream knows nobody is consuming data.

### When a Listener Throws

If any listener throws an exception, `emit()` stops iterating. The remaining listeners for that event don't fire. The exception propagates up through `emit()` to whatever code called it. There's no try/catch inside `emit()` - the error surfaces naturally through the call stack.

This means a throwing listener in position 2 of 5 will prevent listeners 3, 4, and 5 from running. The caller of `emit()` needs to handle the error or let it propagate to the process-level `uncaughtException` handler (covered in Chapter 1). There's no mechanism to "resume" emission after a throw - the remaining listeners are simply skipped.

The design choice here is intentional. Adding a try/catch around each listener call would mask errors and make debugging harder. If a listener throws, something is wrong. Silently continuing to the next listener could produce corrupted state - the previous listener might have partially modified shared data before throwing. Stopping emission and surfacing the error is the safer default.

If you genuinely need fault isolation between listeners, you have to implement it yourself:

```js
for (const listener of ee.listeners('data')) {
  try {
    listener(chunk);
  } catch (err) {
    console.error('Listener failed:', err);
  }
}
```

But this is unusual. Most code relies on the default behavior of stopping on throw.

## Walking Through lib/events.js

The Node.js source for EventEmitter lives in `lib/events.js`. The file is around 1,200 lines, and a good chunk of it is devoted to input validation, deprecation warnings, and edge case handling. The core logic is compact. Walking through the key internal functions reveals the design decisions that shaped the API.

### The _addListener Internal

All listener registration routes through an internal `_addListener` function. It takes the target emitter, the event name, the listener function, and a boolean `prepend` flag. The function:

1. Checks that `listener` is a function. Throws `TypeError` if not.
2. Gets or creates the `_events` object.
3. If a `'newListener'` event exists on the emitter, emits it first (before adding the new listener).
4. Looks up `existing = events[type]`.
5. If `existing` is `undefined`, sets `events[type] = listener` and increments `_eventsCount`.
6. If `existing` is a function (single listener), converts to array: `events[type] = prepend ? [listener, existing] : [existing, listener]`.
7. If `existing` is an array, either pushes (append) or unshifts (prepend) the new listener.
8. After adding, checks the listener count against `_maxListeners`. If exceeded and a warning hasn't been issued for this event yet, fires `process.emitWarning()`.

The maxListeners check uses a flag on the array itself (`warned` property) to ensure the warning fires only once per event name. Once you've been warned about having 11 listeners on `'data'`, you won't get warned again when you add the 12th, 13th, and so on. The warning resets if all listeners are removed and then re-added past the threshold.

Step 3 is worth pausing on. The `'newListener'` emission happens before the listener is added to `_events`. This means the `'newListener'` handler sees the emitter state *before* the new listener exists. If your `'newListener'` handler calls `listenerCount()` for the event being added, it'll return the count without the new listener. The new listener appears in `_events` only after `_addListener` returns from step 5/6/7.

This ordering also means that if the `'newListener'` handler throws, the listener never gets added. The throw propagates out of `on()` / `once()` / `addListener()`, and the emitter state hasn't been modified.

### The emit() Implementation

The actual `emit` method on `EventEmitter.prototype` uses rest parameters: `function emit(type, ...args)`. The function signature is simple. The optimization lives in how it dispatches, not in argument handling.

The single-listener case (bare function in `_events[type]`) calls the handler directly with `ReflectApply(handler, this, args)` - no array copy needed. For multiple listeners (stored as an array), it copies the array first with `arrayClone()`, then iterates the copy. The `arrayClone` implementation uses a switch statement with hard-coded return values for small arrays (2, 3, 4 elements), falling back to `ArrayPrototypeSlice` for larger arrays. This is faster than `Array.from()` or spread in V8.

The distinction between single-handler and array-handler is the main fast path. Most events on most emitters have exactly one listener, so the array copy and iteration loop are skipped entirely in the common case. This matters because `emit()` runs millions of times per second in a busy Node.js server - every I/O completion, every timer tick, every stream chunk, every connection event runs through this code path.

The method sets `this` to the emitter instance for each listener call. When you write:

```js
ee.on('event', function() {
  console.log(this === ee); // true
});
```

`this` is the emitter. Arrow functions ignore this binding, of course, so it only matters for regular function expressions. In older Node.js code (pre-ES2015), the `this` binding was how listeners accessed the emitter instance. Modern code typically uses arrow functions and captures the emitter in a closure instead, making the `this` binding irrelevant for most new code. But it's still there, and libraries that predate arrow functions depend on it.

### Error Event Special Handling

Inside `emit()`, before any listener dispatch happens, there's a check: `if (type === 'error')`. This block handles the special error event contract. If no listeners exist for `'error'`, the implementation does the following:

1. Checks for `this.domain` - the legacy domain module. If a domain exists and has an error handler, the error gets routed there.
2. If the first argument (`er`) is an instance of `Error`, throws it directly.
3. If `er` is something else (a string, a number, `undefined`), wraps it: `new Error('Unhandled error.' + (er ? (' (' + er + ')') : ''))`. The wrapper error gets a `.context` property set to the original value. Then it throws the wrapper.

The string concatenation in step 3 means you get error messages like `"Unhandled error. (connection refused)"` if someone does `emit('error', 'connection refused')` instead of `emit('error', new Error('connection refused'))`. The `.context` property on the wrapper lets you recover the original value if needed.

### getEventListeners() and eventNames()

`eventNames()` returns an array of event names that have at least one listener. It uses `Reflect.ownKeys()` rather than `Object.keys()`, which means it includes Symbol-typed event names. EventEmitter supports Symbols as event names, though it's uncommon in practice. Symbols are useful for creating private or non-colliding event names - a library can use `Symbol('internal')` as an event name that won't accidentally collide with user-defined event names.

`getEventListeners(emitter, event)` is a static method on the `events` module (not on instances). It returns a copy of the listeners array. The copy is intentional - modifying the returned array doesn't affect the emitter's internal state. This static method also works with `EventTarget` instances, making it a universal listener inspection tool.

`listenerCount()` exists in two forms: `emitter.listenerCount(eventName)` as an instance method, and the older static `EventEmitter.listenerCount(emitter, eventName)` which is deprecated. Both return the number of listeners for a given event. The instance method just looks at `_events[eventName]` and returns 0, 1, or the array length. The deprecation of the static form happened because the instance method is clearer and works with subclasses properly.

### captureRejections

Node 13 added `captureRejections` as an option. When enabled (either per-instance via the constructor option or globally via `EventEmitter.captureRejections = true`), EventEmitter wraps each listener invocation in logic that detects rejected promises. If a listener returns a promise that rejects, the rejection is caught and routed to the emitter's `'error'` event.

```js
const ee = new EventEmitter({ captureRejections: true });
ee.on('event', async () => {
  throw new Error('async failure');
});
ee.on('error', (err) => {
  console.log(err.message); // "async failure"
});
ee.emit('event');
```

Without `captureRejections`, the async listener returns a rejected promise that nobody awaits. It becomes an unhandled rejection - the `process.on('unhandledRejection')` handler fires, and depending on your Node version, the process may terminate. With `captureRejections`, EventEmitter `.then()`s the return value and routes any rejection to the `'error'` handler. The emitter can also define a `Symbol.for('nodejs.rejection')` method to customize how rejections are handled instead of routing them to `'error'`.

How it works internally: after calling each listener, `emit()` checks whether `captureRejections` is enabled. If so, it checks whether the listener's return value is a thenable (has a `.then` method). If yes, it attaches a `.then(undefined, rejectionHandler)` where the rejection handler calls `emitter[Symbol.for('nodejs.rejection')](err, type, ...args)` if that method exists, or `emitter.emit('error', err)` as a fallback.

This is a bridge between EventEmitter's synchronous dispatch model and the async/await world. The listener itself still starts synchronously - `emit()` calls it on the current stack. But if the listener is an `async` function, it returns a promise immediately (the async function's body runs synchronously up to the first `await`, then the promise is returned). `captureRejections` attaches a rejection handler to that promise. The rejection handler runs later, on a subsequent microtask, when the promise settles. The error routing to `'error'` is therefore asynchronous relative to the original `emit()` call, even though the initial listener invocation was synchronous.

There's a performance consideration. When `captureRejections` is off (the default), `emit()` ignores listener return values entirely. When it's on, `emit()` must inspect every return value to check for thenables. For emitters that fire thousands of events per second, this check adds overhead. That's why it's opt-in.

## The Error Event Contract

The `'error'` event has behavior that no other event name has. If you call `emit('error', err)` and there are no listeners for `'error'`, Node doesn't return `false` and silently continue. It throws the error. If the first argument is an Error instance, it throws that directly. If it's something else, Node wraps it in an Error with a message like "Unhandled error. (value)" and throws that wrapper.

```js
const ee = new EventEmitter();
ee.emit('error', new Error('boom'));
// Throws: Error: boom
// The process crashes if nothing catches this.
```

This is a design decision from Node's earliest days. Silent errors are worse than crashes. If you create a TCP server and it encounters a network error, you need to know about it. If you create a stream and the underlying resource fails, you need to know. The `'error'` event contract forces you to acknowledge errors or accept a crash.

The thrown error propagates up the call stack from `emit()`. If you've wrapped `emit()` in a try/catch, you'll catch it. If you haven't, it becomes an uncaughtException (covered in Chapter 1). In most production code, the uncaughtException handler logs and exits.

The practical pattern: always attach an `'error'` listener to any EventEmitter you interact with.

```js
const server = net.createServer();
server.on('error', (err) => {
  console.error('Server error:', err.message);
});
server.listen(3000);
```

Without the error handler, a port-in-use `EADDRINUSE` error would throw from the `emit('error', ...)` call inside the `listen()` implementation and crash the process. With the handler, you get a log line and can decide what to do - retry on a different port, wait and retry, log and exit gracefully.

### Why This Design Exists

The error event contract exists because early Node.js code had a problem: people would create streams, sockets, and servers without error handlers. The errors happened silently - a socket would fail, nobody would notice, and the application would accumulate broken state. Connections would hang. Data would be lost. Memory would leak from resources that never got cleaned up.

The crash-on-unhandled-error approach forces the issue. You either handle the error or your process stops. It's a forcing function for correctness. In practice, this means you see `ECONNRESET` errors crash development servers when clients disconnect unexpectedly, and that's annoying, but it means you *know* about the disconnect. In production, you add the error handler, log the error, clean up resources, and move on.

Every Node.js class that extends EventEmitter and can encounter errors follows this contract: `net.Server`, `net.Socket`, `http.Server`, `http.IncomingMessage`, `fs.ReadStream`, `child_process.ChildProcess`, `tls.TLSSocket` - they all emit `'error'` when something goes wrong. The convention is universal across the standard library.

### captureRejections and the Error Event

The error event also interacts with `captureRejections`. When an async listener rejects and `captureRejections` is on, the rejection flows through `emit('error', rejectionReason)`. If there's no error listener... same rule applies. The process crashes. Enabling `captureRejections` without an `'error'` handler just changes the crash from "unhandled rejection" to "thrown error from emit('error')."

There's a timing difference though. Without `captureRejections`, the async listener's rejection fires as an unhandled rejection on a future microtask. The original `emit()` call returned long ago. With `captureRejections`, the rejection still fires later (because the rejection handler is a `.then` callback, which runs as a microtask), but it manifests as a synchronous throw from `emit('error')` - which itself propagates through whatever code is running when the microtask executes. The stack trace changes. The behavior changes. The crash is the same, but it happens at a different point in the event loop.

### Domain Integration (Legacy)

Domains (the `domain` module) wrap EventEmitter error handling. If an emitter is bound to a domain, the domain's error handler catches errors emitted without listeners instead of throwing. Domains are deprecated and have been for years. But they're still in the codebase, and `emit()` has a code path checking `this.domain` before throwing. The domain check runs before the throw logic - if a domain exists and has an error handler, the error goes there instead of being thrown. Mentioning this because you'll see the domain check in the source and wonder why it's there.

## Memory Leaks and maxListeners

The default `maxListeners` value is 10. When you add the 11th listener to any single event name, Node prints a warning through `process.emitWarning()`:

```
MaxListenersExceededWarning: Possible EventEmitter memory leak
detected. 11 data listeners added to [EventEmitter]. MaxListeners
is 10. Use emitter.setMaxListeners() to increase limit.
```

This is a warning, not an error. The listener still gets added. The emitter still works. But the warning exists because adding unbounded listeners is one of the most common memory leaks in Node.js applications.

The classic leak pattern:

```js
function handleRequest(req, res) {
  db.on('change', () => { /* respond to change */ });
  // oops - never removes the listener
}
```

Every request adds a listener to the `db` emitter. After 1000 requests, the `db` emitter has 1000 `'change'` listeners. After 100,000 requests, it has 100,000. Each listener holds a closure over `req` and `res`, so those objects can't be garbage collected either. Memory grows linearly with request count. And every time the `db` emitter fires `'change'`, it calls all 100,000 listeners synchronously on the same tick. The application slows to a crawl before it runs out of memory.

The warning gives you a stack trace pointing to where the 11th listener was added. That stack trace is your starting point for finding the leak. The warning includes the constructor name of the emitter and the event name, so you can immediately see which emitter and which event are accumulating listeners.

The `MaxListenersExceededWarning` is emitted via `process.emitWarning()` with a specific `code` property. You can listen for it programmatically:

```js
process.on('warning', (warning) => {
  if (warning.name === 'MaxListenersExceededWarning') {
    console.log(warning.emitter, warning.type, warning.count);
  }
});
```

The warning object has `emitter` (the EventEmitter instance), `type` (the event name), and `count` (the current listener count) properties. This gives you everything you need for automated leak detection in production.

### Controlling the Limit

`setMaxListeners(n)` sets the limit per instance:

```js
ee.setMaxListeners(20);    // raise for this emitter
ee.setMaxListeners(0);     // disable warning entirely
ee.setMaxListeners(Infinity); // same effect
```

`EventEmitter.defaultMaxListeners` is the global default. Changing it affects all emitters that haven't called `setMaxListeners()`. Emitters created after the change inherit the new default. Emitters created before the change also use the new default, because the check reads `EventEmitter.defaultMaxListeners` at registration time, not at construction time.

```js
EventEmitter.defaultMaxListeners = 20;
```

Node 15.4 added `events.setMaxListeners(n, ...targets)` which sets the limit on multiple emitters at once. Handy for initialization code that creates several emitters that all need a higher limit:

```js
const { setMaxListeners } = require('events');
setMaxListeners(50, server, db, cache, queue);
```

`events.getMaxListeners(emitter)` returns the effective limit for an emitter. If the instance hasn't called `setMaxListeners()`, it returns `EventEmitter.defaultMaxListeners`. This static method works with both EventEmitter and EventTarget instances.

### Legitimate High Listener Counts

Sometimes 10 listeners is genuinely too low. A process-level emitter like `process` itself often has more than 10 listeners across `'SIGINT'`, `'SIGTERM'`, `'uncaughtException'`, `'unhandledRejection'`, `'warning'`, `'exit'`, and various signal handlers from different parts of the application. A shared database connection pool might have 20+ listeners if multiple modules subscribe to `'error'` or `'connection'` events. In those cases, bump the limit and move on.

But be deliberate about it. If you're setting `maxListeners` to `Infinity` as a band-aid, you're hiding a potential leak. Set it to a specific number that matches your expected listener count, and you'll catch genuine leaks that exceed that expectation. If you expect 25 modules to listen for `'change'` events, set the limit to 30 - close enough to detect unexpected growth, high enough to avoid false warnings.

### Detecting Leaks in Practice

The maxListeners warning is your first line of defense. But it only triggers once per event name. If you need continuous monitoring, use `listenerCount()` in health checks or metrics:

```js
setInterval(() => {
  const count = ee.listenerCount('data');
  if (count > 100) console.warn(`data listeners: ${count}`);
}, 60_000);
```

In production monitoring, exporting listener counts as metrics (Prometheus gauges, for example) lets you graph listener growth over time. A monotonically increasing listener count is a leak. A stable count with occasional spikes (during deployments, reconnections) is normal.

The other common leak source beyond the "add listener on every request" pattern is event forwarding. If you have an intermediary object that forwards events from one emitter to another:

```js
source.on('data', (chunk) => dest.emit('data', chunk));
```

And the intermediary is created per-request but `source` persists, you've got the same problem - unbounded listener growth on `source`. The fix is the same: remove the listener when the intermediary is done.

## removeAllListeners and Cleanup

`removeAllListeners()` with no arguments removes every listener from every event. With an event name argument, it removes all listeners for that specific event. Either way, it fires `'removeListener'` for each listener being removed.

The cleanup pattern for short-lived subscriptions:

```js
function subscribe(emitter) {
  const handler = (data) => process(data);
  emitter.on('update', handler);
  return () => emitter.off('update', handler);
}
const unsub = subscribe(db);
// ... later
unsub();
```

Returning an unsubscribe function is a common pattern in Node.js code. It avoids the need to keep a reference to the handler function in a wider scope. The closure captures the handler, and calling the returned function removes it. React users will recognize this from `useEffect` cleanup functions - same concept.

For `once()` listeners, cleanup is automatic - the listener removes itself after firing. But if the event never fires, the `once()` listener stays registered forever. This is another source of memory leaks: registering `once()` handlers for events that might never occur. A `once('drain')` on a writable stream that never fills its buffer, for instance, will sit there indefinitely.

The `AbortSignal` integration (available since Node 15) helps with this. `events.once()` and `events.on()` both accept an `AbortSignal` option. Aborting the signal cancels the waiting listener, preventing the leak:

```js
const ac = new AbortController();
setTimeout(() => ac.abort(), 5000); // timeout after 5s
await once(server, 'listening', { signal: ac.signal });
```

If the `'listening'` event doesn't fire within 5 seconds, the AbortController aborts, the promise rejects with an `AbortError`, and the internal listener is cleaned up.

## EventEmitter in the Async Pattern Landscape

Callbacks, promises, and async/await all represent a single completion. A callback fires once (covered in Chapter 7.1). A promise resolves or rejects once (covered in Chapter 7.2). An async function returns one result (covered in Chapter 7.3). EventEmitter breaks this constraint. It can emit the same event name an unlimited number of times over an unlimited time span. Multiple listeners can react to the same event independently.

This makes EventEmitter the right pattern for ongoing, repeating state changes: new connections on a server, chunks arriving on a stream, file changes from a watcher, log lines from a child process. These are events in the original sense - things that happen repeatedly, at unpredictable times, and multiple consumers might care about each one.

Callbacks: one function, one invocation, one result. Promises: one resolution, one result (or rejection). EventEmitter: many listeners, many invocations, over time.

The tradeoff is lifecycle management. With a promise, you get a result and you're done. With EventEmitter, you have to think about when to start listening, when to stop, and what happens to listeners you forget to remove. The memory leak section above is the concrete manifestation of this tradeoff.

### When to Use Which

Choosing between these patterns comes down to cardinality and timing:

One result, known when to expect it: use a promise or callback. Database query, file read, HTTP request. You call a function, you get one answer.

One result, unknown when it arrives: use `events.once()` to wrap a one-time event as a promise. Server startup, first connection, process exit.

Multiple results over time, push-based: use EventEmitter with `on()`. Stream data, socket messages, file changes. The producer pushes data to consumers as it arrives.

Multiple results over time, pull-based: use an async iterator via `events.on()`. Same use case as above, but the consumer controls the pace. More on this in the next subchapter.

The foundation role is worth emphasizing. EventEmitter underpins most of Node's built-in modules. Streams (covered in Chapter 3) extend EventEmitter. `net.Server` extends EventEmitter. `http.Server` extends `net.Server` (which extends EventEmitter). `child_process.ChildProcess` extends EventEmitter. `fs.FSWatcher` extends EventEmitter. The `process` object itself is an EventEmitter instance. Understanding EventEmitter internals means understanding the base behavior of nearly every I/O object in Node.js.

### Bridging EventEmitter to Promises and Async Iteration

The `events` module provides two static functions that bridge the gap between EventEmitter's push-based model and the promise/async-await world:

`events.once(emitter, eventName)` returns a promise that resolves when the event fires. The resolved value is an array of the arguments passed to `emit()`. It registers a `once()` listener internally, and also attaches an `'error'` listener that causes the promise to reject if an error is emitted before the target event. When either listener fires, both are cleaned up.

```js
const { once } = require('events');
const server = net.createServer();
server.listen(3000);
await once(server, 'listening');
console.log('Server is ready on', server.address().port);
```

This is the clean way to await a one-time event. The `'listening'` event passes no arguments, so the resolved array is empty - you grab the address from `server.address()` after the event fires. Without `events.once()`, you'd write the promise wrapper yourself and probably forget to handle the error case. Or you'd handle errors but forget to clean up the success listener when the error fires. `events.once()` handles both cases correctly.

For events that pass arguments, the promise resolves to an array of those arguments. `await once(server, 'connection')` gives you `[socket]`. `await once(process, 'exit')` gives you `[code]`. The array wrapping is consistent regardless of argument count.

`events.on(emitter, eventName)` returns an `AsyncIterator`. Each time the event fires, the iterator yields the arguments as an array. This bridges EventEmitter into the `for await...of` world - the next subchapter covers async iterators in depth, so I'll keep this brief.

```js
const { on } = require('events');
for await (const [chunk] of on(stream, 'data')) {
  process.stdout.write(chunk);
}
```

The async iterator buffers events that arrive between iterations and yields them in order. It runs indefinitely by default - you specify which events signal completion via the `close` option, or use an `AbortSignal` to cancel. If the emitter emits `'error'`, the iterator throws. This is a fundamentally different consumption model from registering a listener: instead of push-based (the emitter calls your function), it's pull-based (your loop pulls from the iterator when it's ready). The buffering means events aren't lost if the consumer is temporarily busy with async work between iterations.

Both `events.once()` and `events.on()` accept an `AbortSignal` for cancellation. This is the recommended way to add timeouts or cancellation to event waiting:

```js
const ac = new AbortController();
setTimeout(() => ac.abort(), 10_000);
try {
  await once(server, 'listening', { signal: ac.signal });
} catch (err) {
  if (err.code === 'ABORT_ERR') console.log('Timed out');
}
```

### EventTarget: The Web Standard Alternative

Node.js added `EventTarget` (the browser's event API) starting in Node 15. It follows the DOM EventTarget spec: `addEventListener()`, `removeEventListener()`, `dispatchEvent()`. Events are `Event` objects with a `type` property, not arbitrary argument lists.

EventTarget exists mainly for Web API compatibility. `AbortController` uses it. `MessagePort` uses it. `WebSocket` in the upcoming Node web API uses it. The performance characteristics are different from EventEmitter - EventTarget creates Event objects on every dispatch, while EventEmitter passes raw arguments. For Node-native code, EventEmitter remains the standard. EventTarget shows up where browser compatibility matters.

The key behavioral differences: EventTarget's `dispatchEvent()` expects an Event object. EventEmitter's `emit()` accepts any arguments. EventTarget listener removal requires the exact same function reference *and* the same `capture` option. EventEmitter just needs the function reference. EventTarget has no `'error'` event contract - there's no special throw-on-unhandled behavior. EventTarget supports the `{ once: true }` option on `addEventListener()`, similar to EventEmitter's `once()` but passed as an option rather than being a separate method.

EventTarget also has the `capture` and `passive` options from the DOM spec, but these are mostly meaningless in Node.js (there's no DOM bubble/capture phase in a server-side context). They exist for spec compliance.

For most Node.js work, EventEmitter is what you'll use. EventTarget is there when you need it for web-compatible APIs, and the two coexist without conflict. `events.getEventListeners()` and `events.setMaxListeners()` work with both types, providing a unified API surface for tooling that needs to inspect either kind of event source.
