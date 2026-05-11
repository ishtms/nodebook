---
title: "Promises and Microtask Scheduling"
date: "2026-03-01"
excerpt: "Promise state machines, the microtask queue, V8's internal slots, thenable assimilation, and scheduling order."
category: "Async Patterns & Control Flow"
tags: ["nodejs", "promises", "microtasks", "async-patterns", "v8"]
author: "Ishtmeet Singh @ishtms"
chapter: "async-patterns"
subchapter: "promises-microtasks"
published: true
toc: true
---

`Promise.resolve().then()` runs before a zero-delay timer because it never waits for the timers phase.

The `.then()` handler goes into V8's microtask queue. The timer callback goes through libuv's timer system. Node drains microtasks after the current JavaScript stack empties and before the event loop advances into timer callbacks. Same process. Different queues. Different priority.

A promise is a one-settlement state machine. Three states: pending, fulfilled, rejected. Two state transitions: pending to fulfilled, pending to rejected. One invariant: after settlement, the state and result stay fixed.

V8 stores that state in internal slots on the promise object. `[[PromiseState]]` is pending, fulfilled, or rejected. `[[PromiseResult]]` holds the fulfillment value or rejection reason. Two reaction lists hold the handlers registered by `.then()`, `.catch()`, and `.finally()`. Settlement drains the matching list into microtask jobs, then clears the list. One-shot dispatch. No second pass.

The public object gives you almost none of that state directly. `console.log(promise)` in Node may show `<pending>` or a fulfilled value through inspector formatting, but JavaScript code has no property read for `[[PromiseState]]`. Observation goes through reactions. That constraint is deliberate: promise state changes through the settlement path only, and every observer gets scheduled through the same job system.

The resolve and reject functions created by the constructor are called a promise capability. A capability binds three things together: the promise object, the function that fulfills it, and the function that rejects it. V8 passes that pair through the chain so each `.then()` link can settle the promise it returned. That is why a handler return value affects the next promise instead of mutating the previous one.

```js
const p = new Promise((resolve, reject) => {
  resolve(42);
  resolve(99);
  reject(new Error("too late"));
});
p.then(v => console.log(v)); // 42
```

The first `resolve(42)` fulfills the promise. The second `resolve(99)` returns without changing anything. The `reject()` call does the same. V8 checks the current state before applying either capability; settled promises ignore later attempts.

That single-settlement rule fixes one of the callback-era failure modes from the previous subchapter. A callback can fire twice if the API author gets sloppy. A promise capability can be called twice, but only the first call changes the observable state.

The fulfillment value can be any JavaScript value. Primitive. Object. `undefined`. Another promise. Rejection accepts any value too, although real code should reject with `Error` instances. A string rejection gives you a message and discards the stack frame that would tell you where the failure came from.

Promise resolution also protects against self-resolution. If code tries to resolve a promise with itself, the promise rejects with a `TypeError`. Without that guard, adoption would create a cycle where the promise waits on its own settlement forever. The spec checks that case before thenable assimilation runs.

```js
let resolve;
const p = new Promise(r => { resolve = r; });
resolve(p);
p.catch(e => console.log(e.name)); // TypeError
```

That edge case mostly appears in hand-written adapters. Still worth knowing. The runtime has a specific guard because promise resolution is recursive by design.

## The Executor Runs Inline

The function passed to `new Promise()` is the executor. The constructor calls it immediately, on the current stack.

```js
console.log("before");
const p = new Promise((resolve, reject) => {
  console.log("executor");
  resolve("done");
});
console.log("after");
```

Output: `before`, `executor`, `after`. The executor runs during construction. If it resolves synchronously, the promise is already fulfilled by the time the constructor returns. The handler still runs later. `.then()` always schedules a reaction job instead of calling the handler inline.

That split matters. Construction can do synchronous validation, capture inputs, and settle immediately. Observation stays async. Your handler gets a clean stack after the current turn of JavaScript finishes.

The constructor creates the `resolve` and `reject` capabilities and passes them only to the executor. After construction, outside code observes through `.then()`, `.catch()`, and `.finally()`. It can attach reactions. It can read the eventual value through handlers. It has no settlement capability unless the executor leaked one.

Leaking the capability is possible:

```js
let finish;
const p = new Promise(resolve => {
  finish = resolve;
});
finish("done");
```

That pattern is sometimes called a deferred promise. It is useful at integration boundaries: waiting for a one-time event, bridging a callback API, or wiring a test harness. It also spreads settlement authority away from the code that created the promise. Keep the `resolve` and `reject` references scoped tightly. A leaked capability is mutable shared state with nicer syntax.

If the executor throws, the constructor turns the throw into a rejection:

```js
const p = new Promise(() => {
  throw new Error("executor exploded");
});
p.catch(e => console.log(e.message)); // "executor exploded"
```

The constructor wraps the executor call. A synchronous throw becomes the rejection reason. That gives promise construction a clean failure channel while preserving the async scheduling rule for handlers.

`Promise.resolve(value)` and `Promise.reject(reason)` create settled promises without writing the constructor syntax. `Promise.resolve(42)` returns a fulfilled promise. `Promise.reject(new Error("no"))` returns a rejected promise. Tests, adapters, and small library branches use these constantly.

Native promises get a fast path:

```js
const original = Promise.resolve(1);
const wrapped = Promise.resolve(original);
console.log(original === wrapped); // true
```

`Promise.resolve()` returns the same object when the input is already a native promise created by the same constructor. V8 skips an extra wrapper and an extra microtask hop. Thenables take the slower path.

Subclassing changes that fast path. `Promise.resolve()` checks constructor identity. A promise created by a different promise constructor may get wrapped so the returned object has the requested constructor. You rarely care in application code. Library authors who subclass Promise need to care because the allocation and species behavior can surprise users.

## Resolving With a Promise

Resolving a promise with another promise makes the outer promise adopt the inner promise's eventual state.

```js
const inner = new Promise(resolve => {
  setTimeout(() => resolve("delayed"), 100);
});
const outer = new Promise(resolve => {
  resolve(inner);
});
outer.then(v => console.log(v)); // "delayed" (after 100ms)
```

`outer` stays pending while `inner` is pending. When `inner` fulfills with `"delayed"`, `outer` fulfills with `"delayed"`. If `inner` rejects, `outer` rejects with the same reason. The result is state adoption rather than fulfillment with the promise object.

The rule extends to thenables: objects with a callable `.then` property. Promise resolution reads the property, verifies that it's callable, and schedules work that calls it with the outer promise's resolve and reject capabilities. Native promises, old promise libraries, and custom promise-like objects can interoperate through that protocol.

The property read happens once. That detail matters for weird objects. If a getter for `.then` throws, the promise rejects with that thrown error. If the getter returns a non-callable value, the object becomes the fulfillment value. If the getter returns a function, V8 schedules the thenable job using that function reference. Later mutations to `obj.then` do not affect that already-scheduled job.

```js
const thenable = {
  then(onFulfill) {
    onFulfill("from thenable");
  }
};
Promise.resolve(thenable).then(v => console.log(v));
```

Output: `"from thenable"`. The promise resolution procedure treats the object as promise-like and follows the result produced by its `.then()` method.

Thenable assimilation costs extra scheduling. A plain value can fulfill the promise immediately, with attached handlers still deferred as reaction jobs. A thenable goes through `PromiseResolveThenableJob`, which calls the `.then()` method later from the microtask queue. When that thenable calls the supplied fulfillment capability, V8 schedules the usual `PromiseReactionJob` work for handlers. In precise ordering tests, that extra microtask turn shows up.

The check is duck-typed. Object. Callable `.then`. That is enough.

That affects data objects with an accidental `then` method. A database document, API response, or mock object containing a callable `then` property gets treated as a thenable when passed to `resolve()`. The promise resolution procedure calls it. If the method throws, the outer promise rejects. If it never calls either callback, the outer promise stays pending.

The fix is practical: wrap the value in another object, rename the property, or return it from a handler that already runs after the assimilation point. You mostly meet this in integration code, where untyped external data crosses a promise boundary.

Thenables can also be malformed or adversarial. The `.then()` method can call fulfillment twice, call rejection after fulfillment, throw after calling fulfillment, or call both callbacks from different turns. The promise resolution procedure creates resolving functions with an internal already-resolved flag. First call wins. Later calls return. A throw after the first successful callback gets ignored because the outer promise has already settled.

```js
const messy = {
  then(resolve, reject) {
    resolve("ok");
    reject(new Error("late"));
  }
};
Promise.resolve(messy).then(v => console.log(v));
```

Output: `"ok"`. The rejection attempt lands after fulfillment and changes nothing. That already-resolved flag is separate from `[[PromiseState]]`; it protects the capability during the adoption procedure, before the outer promise necessarily reaches its final state.

The adoption procedure is one reason promise code can look synchronous and still run later. A thenable may call `resolve()` inline from its `.then()` method. The outer promise still schedules reactions through microtasks. You get a stable rule even when the foreign object behaves oddly: handler execution waits for the checkpoint.

## Chaining

`.then()` takes two optional handlers: `onFulfilled` and `onRejected`. It returns a new promise every time.

```js
const result = Promise.resolve(5)
  .then(v => v * 2)
  .then(v => v + 1)
  .then(v => console.log(v)); // 11
```

Three `.then()` calls allocate three promises. Each handler receives the previous settled value. A normal return fulfills the next promise with that return value. A throw rejects it. Returning a promise makes the next promise adopt that returned promise's state.

Promise chains get their shape from that returned promise. Each link owns its next promise. Each handler transforms success or failure into the next state. Indentation stays flat, and the runtime provides exactly-once settlement for every link.

Missing returns still hurt.

```js
Promise.resolve("user")
  .then(name => {
    name.toUpperCase();
  })
  .then(v => console.log(v)); // undefined
```

The first handler returns `undefined`, so the next promise fulfills with `undefined`. V8 has no opinion about intent. Linters catch many of these. Runtime behavior stays silent.

Throws become rejections:

```js
Promise.resolve("ok")
  .then(v => { throw new Error("oops"); })
  .then(v => console.log("skipped"))
  .catch(e => console.log(e.message)); // "oops"
```

The second `.then()` has only a fulfillment handler, so the rejection passes through. `.catch(fn)` is `.then(undefined, fn)`. It attaches a rejection handler to the promise produced by the previous link.

Placement changes behavior. A `.catch()` at the end handles failures from every previous link. A `.catch()` in the middle can recover and send a normal value downstream.

```js
Promise.reject(new Error("fail"))
  .catch(e => "recovered")
  .then(v => console.log(v)); // "recovered"
```

The catch handler returns a string. The returned promise fulfills with that string, and the following `.then()` receives it. Re-throwing from the catch handler keeps the chain on the rejection path.

`.finally(fn)` runs for both outcomes. It receives no value. It passes the original value or reason through unless it throws or returns a rejected promise.

```js
Promise.resolve(42)
  .finally(() => console.log("cleanup"))
  .then(v => console.log(v)); // "cleanup" then 42
```

Use it for cleanup that should observe completion without changing the result: close a handle, clear a timer, release a lock, decrement an in-flight counter.

The two-argument form of `.then()` has a specific failure mode. In `.then(onFulfilled, onRejected)`, the rejection handler handles rejection from the previous promise. It does not handle a throw from `onFulfilled` in the same call. A chained `.catch()` handles the promise returned by `.then()`, so it catches throws from the fulfillment handler. End-of-chain `.catch()` is usually the clearer shape.

Empty `.then()` calls create pass-through promises. `promise.then()` follows the original promise and adds allocation. It shows up after refactors. Delete it when you see it.

One more chaining detail pays off during debugging: handlers attach to the promise on their left. In `a.then(f).catch(g)`, `g` handles rejections from `a` and throws from `f`, because it attaches to the promise returned by `then`. In `a.then(f, g)`, `g` handles only rejection from `a`. The returned promise from that call receives whatever `f` or `g` produces. Same API. Different attachment point.

Multiple handlers on the same promise behave differently from a chain. They all observe the same settlement value, and each `.then()` call returns its own next promise.

```js
const p = Promise.resolve(10);
p.then(v => console.log(v + 1));
p.then(v => console.log(v + 2));
p.then(v => console.log(v + 3));
```

Output: `11`, `12`, `13`. All three reactions attach to `p`. When `p` settles, V8 enqueues three reaction jobs in registration order. The return value from the first handler feeds only the promise returned by the first `.then()` call. It has no effect on the second or third handler because those handlers also attach to `p`.

Now compare a chain:

```js
Promise.resolve(10)
  .then(v => v + 1)
  .then(v => v + 2)
  .then(v => console.log(v + 3));
```

Output: `16`. Each handler attaches to the promise returned by the previous `.then()`. The value moves link by link. That distinction explains many confusing refactors. Splitting a chain into separate `.then()` calls on the original promise changes data flow while keeping the same visible API calls.

The same rule applies to errors. Three `.catch()` calls attached to one rejected promise all see the same rejection. Three catch handlers chained together behave as a recovery sequence, where each handler's return or throw decides the next link. Handler placement is the control-flow graph.

## How V8 Runs Promise Handlers

The handler never runs from inside `.then()`.

If the promise is pending, `.then()` stores a reaction in the promise's internal reaction list. If the promise is already settled, `.then()` creates a reaction job immediately. Either way, the handler runs from V8's microtask queue at a later checkpoint.

V8's microtask queue lives on the isolate. Promise reactions and `queueMicrotask()` callbacks go there. Libuv timers, I/O callbacks, and `setImmediate()` callbacks live in libuv-managed structures. `process.nextTick()` lives in a Node-managed queue in JavaScript. Node drains nextTick before V8 microtasks at each checkpoint.

The queue drains to exhaustion. If a microtask queues another microtask, the new one runs in the same drain before Node returns to event loop phases. That recursive drain is the source of both the ordering guarantee and the starvation failure mode.

The specific promise job is `PromiseReactionJob`. When a promise settles, V8 walks its dependent reactions and enqueues one job per reaction. A job does three pieces of work: call the correct handler with the settled value, inspect the handler result or thrown exception, and settle the promise returned by the `.then()` call.

Internally, a promise reaction carries the handler, the reaction type, and a promise capability for the next promise in the chain. The capability is a pair of functions: resolve and reject. If the handler returns normally, V8 calls the next promise's resolve capability with that value. If the handler throws, V8 calls reject with the thrown value. If the handler is missing for the current settlement type, V8 uses pass-through behavior: fulfillment passes to resolve, rejection passes to reject.

The chain uses jobs, handlers, and capabilities.

The implementation stores reactions compactly because promise-heavy programs create a lot of them. A pending promise keeps linked reaction records. On settlement, V8 reverses or walks that list to preserve registration order, creates jobs, and clears the promise's reaction slots so handlers can be collected after execution. The promise object keeps its final result. The reaction list goes away.

For fulfilled promises, a missing fulfillment handler becomes an identity continuation: pass the same value to the next promise. For rejected promises, a missing rejection handler becomes a thrower continuation: pass the same reason to the next promise's reject capability. V8 can represent those paths without allocating user-visible functions. The behavior is observable only through downstream handlers.

Microtask execution happens with V8 already inside an isolate and context. Node controls when that execution starts. Once V8 begins `PerformMicrotaskCheckpoint()`, it runs microtasks until the queue is empty. Promise jobs created during that drain go to the same queue. `queueMicrotask()` jobs created during that drain do the same. Native callbacks, timers, and I/O wait outside that drain.

```js
console.log("1");
setTimeout(() => console.log("2"), 0);
Promise.resolve().then(() => console.log("3"));
process.nextTick(() => console.log("4"));
console.log("5");
```

Output: `1`, `5`, `4`, `3`, `2`.

Synchronous code runs first. `setTimeout()` registers a libuv timer. `Promise.resolve().then()` enqueues a `PromiseReactionJob` in V8. `process.nextTick()` appends to Node's nextTick queue. The last `console.log()` runs before any queued callback.

The stack empties. Node enters a checkpoint. It drains nextTick first, printing `4`. Then it drains V8 microtasks, printing `3`. After those queues are empty, the event loop advances. The timers phase checks expired timers and prints `2`.

The practical order is: synchronous JavaScript, nextTick queue, V8 microtask queue, event loop phases. Node repeats that checkpoint after callbacks that enter JavaScript from native code. A timer callback can schedule promises. An I/O callback can schedule nextTick. Node drains the high-priority queues before moving on.

The C++ boundary matters here. Node sets V8's `MicrotasksPolicy` to `kExplicit`, which means V8 waits for the embedder to request a microtask checkpoint. Node does that because it has its own nextTick queue and rejection tracking to fold into the same checkpoint. V8's automatic browser-style checkpointing would give Node less control over the order.

During native-to-JavaScript callback dispatch, Node creates an `InternalCallbackScope`. When the callback returns, `InternalCallbackScope::Close()` runs the checkpoint path. In the JavaScript layer, `processTicksAndRejections` in `lib/internal/process/task_queues.js` drains nextTick entries, handles promise rejection bookkeeping, and triggers V8 microtask execution through the isolate. If either nextTick or V8 microtasks created more work, the loop runs again until both queues are empty.

The native entry point uses the same callback mechanism you saw in the callback chapter. A libuv completion reaches Node's C++ binding. Node enters the right V8 context, calls into JavaScript, then closes the callback scope. Closing the scope is where async hooks `after` work, nextTick draining, microtask draining, and rejection reporting get coordinated. That order is why a promise scheduled inside an `fs.readFile()` callback can run before the next completed I/O callback is delivered.

Node also runs checkpoints after the initial script evaluation and around other embedder-controlled entries into JavaScript. Browser descriptions often say microtasks run after each task. Node's rule is embedder-specific: Node chooses checkpoint points that preserve nextTick priority and align with native callback dispatch. The observable result is stable enough for real code, but the system belongs to Node plus V8, not libuv alone.

A detail worth keeping: nextTick has priority at checkpoint boundaries, but it does not interrupt an active V8 microtask drain. If a `.then()` handler calls `process.nextTick()`, that nextTick callback waits until V8 finishes the current microtask queue. Then Node loops and drains nextTick again. The priority rule applies between drains.

That gives a slightly non-obvious ordering when queues create each other:

```js
Promise.resolve().then(() => {
  process.nextTick(() => console.log("tick"));
  queueMicrotask(() => console.log("micro"));
});
```

The `queueMicrotask()` callback runs before the `process.nextTick()` callback created inside the promise handler. V8 is already draining microtasks, so the new microtask joins the active drain. The nextTick callback waits for control to return to Node's checkpoint loop. After V8 finishes, Node sees the nextTick queue and drains it.

Reverse the creation site and the order changes:

```js
process.nextTick(() => {
  Promise.resolve().then(() => console.log("promise"));
  process.nextTick(() => console.log("tick"));
});
```

The nested nextTick runs before the promise handler. Node is draining the nextTick queue, and new nextTick entries stay in that queue until it empties. After that, Node runs V8 microtasks. Same checkpoint. Different active queue.

Use that knowledge sparingly. Code that depends on nested nextTick-versus-promise ordering is hard to review. The real value is debugging: when a log line appears one turn earlier than expected, active-queue rules usually explain it.

`queueMicrotask(fn)` schedules directly into V8's microtask queue without allocating a promise for the scheduling operation.

```js
process.nextTick(() => console.log("nextTick"));
queueMicrotask(() => console.log("microtask"));
Promise.resolve().then(() => console.log("promise"));
```

Output: `nextTick`, `microtask`, `promise`. `queueMicrotask()` and promise reactions share FIFO ordering inside V8's queue. The nextTick queue runs ahead of both at the checkpoint.

### Starvation

Exhaustive draining has a cost. A self-replenishing microtask queue prevents the event loop from reaching timers, poll, check, and close callbacks.

```js
function flood() {
  Promise.resolve().then(flood);
}
flood();
```

Every handler queues another handler. The checkpoint keeps running JavaScript. Timers stay pending. I/O completions sit behind the checkpoint. The process consumes CPU and makes no event-loop progress.

`process.nextTick()` can do the same thing, and historically caused more production pain because people used it as a yield primitive. It yields from the current stack. It stays ahead of event-loop phases.

V8 and Node leave microtask depth under application control. There is no fixed queue-depth cap that saves a recursive chain. Bounded recursion is fine. Unbounded recursion starves the loop.

Use `setImmediate()` when a large CPU-light batch needs to give I/O and timers a turn between chunks. `setImmediate()` runs in the check phase, so the loop can complete a phase rotation between batches. Microtasks run inside checkpoints and must empty before phase work continues.

The tradeoff is overhead versus latency. Microtasks are cheap and ordered tightly. `setImmediate()` costs more and gives other work a scheduling opportunity. For request-serving code, bounded latency for unrelated sockets usually matters more than finishing one batch through a microtask chain.

Batch size is the control value. Process a few hundred items, schedule the next chunk with `setImmediate()`, and keep per-request latency bounded. Process the entire batch through promise recursion, and every socket that became readable during the batch waits behind your microtask chain. The right number depends on item cost and latency budget, so measure it under load rather than copying a magic constant.

API design gets cleaner when you separate "start work" from "observe result." Promise construction or function entry starts work. `.then()` observes completion. Those are separate acts, and they can happen at different times.

```js
const p = readConfig();
doSomethingSync();
p.then(config => applyConfig(config));
```

`readConfig()` decides when the file read, cache lookup, or network call begins. The later `.then()` only registers a reaction. If `readConfig()` already fulfilled by then, the reaction still goes through the microtask queue. If it is pending, the reaction sits in the promise's internal list until settlement.

That distinction affects lazy APIs. A promise represents work that has usually already started. A function returning a promise can be lazy because the work starts when you call the function. Passing a promise around passes an in-flight or already-settled operation. Passing a function around passes the ability to start it later.

```js
const eager = fetchUser(id);
const lazy = () => fetchUser(id);
```

`eager` begins immediately. `lazy` begins when called. The scheduling rules after settlement stay the same, but resource timing changes: sockets open earlier, timers start earlier, and unhandled rejection tracking can begin before the consumer has attached handlers. That is why library APIs often accept functions for retry loops, concurrency limiters, and deferred batches. They need to control when each promise-producing operation starts.

Promise handlers also run after synchronous cleanup in the current turn. That can be useful, and it can be surprising.

```js
const p = Promise.resolve();
let closed = false;
p.then(() => console.log(closed));
closed = true;
```

The handler prints `true`. The assignment runs before the microtask checkpoint. If the handler needed the earlier value, capture it in a local before scheduling the handler. Microtasks preserve ordering; they do not freeze your variables.

One small convention helps during reviews: name promise-returning functions with verbs, and name promise values as values in progress. `loadUser()` starts work. `userPromise` is an observable result from work already started. The naming cannot enforce timing, but it exposes the distinction where mistakes happen. A retry helper should receive `() => loadUser()` because it needs a fresh attempt each time. A renderer can receive `userPromise` because it only needs to observe the result. Same promise mechanism. Different ownership of start time.

That boundary is small, but it separates deterministic scheduling from accidental early execution in code that mixes caches, I/O, and setup during startup.

That usually matters during startup, retries, and request fan-out under load too.

## Errors and Rejections

Rejections propagate until a rejection handler handles them.

```js
Promise.reject(new Error("bad"))
  .then(v => console.log("skipped"))
  .then(v => console.log("also skipped"))
  .catch(e => console.log(e.message)); // "bad"
```

Fulfillment-only handlers are bypassed. The rejection value moves through pass-through reactions until `.catch()` receives it. Inside `.catch()`, returning a normal value recovers, throwing keeps the chain rejected, and returning a rejected promise keeps the chain rejected.

Logging and re-throwing is the usual shape when one layer wants observability and another layer owns the response:

```js
someAsyncOp()
  .catch(e => { console.error("logged:", e); throw e; })
  .then(v => processResult(v))
  .catch(e => sendErrorResponse(e));
```

The first catch logs and throws. The second catch sees the same failure. If the first catch returned normally, the chain would continue with that returned value, often `undefined`.

`throw` inside a handler and `return Promise.reject(error)` both reject the promise returned by that handler's `.then()` call. I prefer `throw` inside synchronous handler bodies because the intent is direct and the stack is cleaner. `Promise.reject()` fits expression-heavy code or helper functions that already return promises.

```js
fetchUser(id).then(user => {
  if (!user.active) throw new Error("inactive");
  return user;
});
```

Same behavior as returning `Promise.reject(new Error("inactive"))`, with shorter syntax.

### Unhandled Rejections

Node reports rejected promises that lack a rejection handler by the time its rejection check runs. In Node v24, the default `--unhandled-rejections` mode is `throw`: an unhandled rejection becomes an uncaught exception. The flag also accepts `warn`, `strict`, and `none`, but production code should treat unhandled rejections as process-level bugs.

The detection path starts in V8. When a promise rejects without a handler, V8 calls Node's promise rejection hook. Node records the promise and delays reporting until after the current turn has had a chance to attach a handler. If a handler appears in time, Node emits or records the handled transition instead of reporting it as unhandled. If the promise still lacks a handler, `unhandledRejection` fires on `process`, and the default mode turns that into a thrown exception.

The delay is small, but it exists because immediate reporting would flag valid patterns. A promise can reject, then a `.catch()` can be attached later in the same synchronous turn. A chain can also attach rejection handling through a later `.then()` call before Node finishes the checkpoint. Node gives that code a chance to connect the handler before it reports the promise.

Two process events describe the lifecycle. `unhandledRejection` fires when Node decides the promise lacked a handler in time. `rejectionHandled` fires later if a handler appears after reporting. The second event is diagnostic cleanup, not a rewind of the first event. In `throw` mode, the process may already be headed through uncaught-exception handling.

That delay is observable:

```js
const p = Promise.reject(new Error("oops"));
setTimeout(() => {
  p.catch(e => console.log("caught:", e.message));
}, 0);
```

The `setTimeout()` callback runs after the microtask checkpoint and timer scheduling boundary. Node can report the rejection before the delayed catch attaches. Later, the catch may cause a `rejectionHandled` event, but the original report already happened.

Attach rejection handlers in the same chain you create. End a floating promise with `.catch()` when it is intentionally detached. With `async` functions, use `try/catch` around awaited work or return the promise to a caller that will handle it.

`promise.catch(() => {})` counts as handling. It also hides the failure. Sometimes that is the intended behavior for best-effort telemetry or cache writes. Put that decision in code. Log at least enough context for later debugging unless the failure is intentionally silent.

Library code should avoid installing global `process.on("unhandledRejection")` policy. Applications own that decision. A library can return promises, document rejection reasons, and attach internal catches for detached background work it starts itself. Process-level rejection policy belongs at the entry point, next to process-level signal and exit handling.

## `util.promisify()` and Callback APIs

Node still has many callback-shaped APIs, and plenty of packages expose only error-first callbacks. `util.promisify(fn)` wraps one of those functions and returns a promise-returning function.

```js
const { promisify } = require("util");
const readFile = promisify(require("fs").readFile);
readFile("/etc/hostname", "utf8").then(data => {
  console.log(data.trim());
});
```

The wrapper calls the original function with your arguments and appends a generated callback. If that callback receives a truthy `err`, it rejects the promise. Otherwise, it resolves with the success value.

Each wrapper call allocates a promise and a callback closure. For one file read, nobody cares. In busy library paths, those allocations appear in heap profiles.

Binding also matters. `promisify()` calls the original function as a plain function unless you bind it yourself. Methods that depend on `this` need binding before wrapping.

```js
const read = obj.read.bind(obj);
const readAsync = promisify(read);
```

Core functions usually avoid that problem because they take all state through arguments or internal bindings. User-space classes often rely on `this`. A promisified unbound method can fail before it even reaches async work.

Some Node APIs return multiple callback success values. `fs.read()` receives `(err, bytesRead, buffer)`. Node core uses internal metadata so promisified versions can resolve with an object such as `{ bytesRead, buffer }` instead of dropping everything after the first success value. Your own APIs can define `util.promisify.custom` for the same reason.

```js
function myFn(cb) { cb(null, "a", "b"); }
myFn[require("util").promisify.custom] = () => {
  return Promise.resolve({ first: "a", second: "b" });
};
```

Prefer promise-native Node APIs when they exist. `require("node:fs/promises")` uses promise-oriented request objects in the native layer. For file system operations, Node can use `FSReqPromise` rather than creating a JavaScript callback wrapper around `FSReqCallback`. The completion path resolves or rejects the promise directly from the binding layer.

`util.promisify()` remains useful for third-party callback APIs and old internal modules. It is an adapter. Keep it at the boundary. Once data is in promise form, keep the rest of the code in one async style.

Do the same in the other direction. If a callback-based public API must remain for compatibility, keep the callback adapter thin and route into a promise-native implementation. Mixed internal styles create duplicated error handling and make ordering harder to reason about.

`util.callbackify()` adapts the other direction. It calls a promise-returning function, attaches handlers, and routes fulfillment or rejection to an error-first callback. That adds the same promise reaction scheduling boundary. Callback consumers that expect exact timing may observe the extra microtask turn.

`callbackify()` has one odd case: rejected falsy values get wrapped, because an error-first callback uses a truthy first argument to signal failure. Rejecting with `null` or `undefined` gives the callback a generated `Error` object with the original reason attached. Another reason to reject with real errors.

## Cost Model

Every `.then()` allocates a promise. Every settled promise with a dependent handler schedules a `PromiseReactionJob`. Every handler closure can retain outer variables until the chain releases them.

Measured costs are real.

Promise handlers always run asynchronously. Even `Promise.resolve(42).then(fn)` schedules `fn` in a microtask. That "always async" behavior comes from the promise contract and removes the mixed sync/async callback behavior covered in the previous subchapter. Cached results and I/O results use the same observation timing: current stack first, microtasks next.

Long chains create short-lived objects. Ten `.then()` calls produce ten intermediate promises and ten reaction jobs. V8's young-generation collector handles that shape well, especially in Node v24, but heap churn becomes visible in code that builds huge numbers of tiny chains per second.

V8 has spent years tightening the promise path: fast paths for already-settled native promises, optimized built-ins for `.then()` and `.finally()`, better async stack tracking, and await-specific optimizations in async functions. Still, a callback-only internal path can allocate less than a promise-heavy one. Database drivers, parsers, schedulers, and transport libraries sometimes expose promises at the public API and use callbacks or internal request objects below that line.

Most application code should keep promises. The readability and error-channel consistency usually matter more than the allocation delta. Profile before replacing a promise chain with callback code. If promise allocation shows up in the profile, you will see it as young-generation churn, frequent minor GC, and `PromiseReactionJob` frames in CPU profiles.

Memory retention is the easy-to-miss part. A chain like `a.then(f1).then(f2).then(f3)` creates intermediate promises that can die quickly when the next link settles. But a handler closure can retain whatever it captures from the outer scope. A `.finally()` closure that closes over a large buffer keeps that buffer reachable until the finally handler runs and the returned promise settles. A stored reference to a mid-chain promise can keep related state alive longer than expected.

The common retention bug is accidental capture:

```js
function handle(req, big) {
  return doWork(req.id).finally(() => {
    metrics.observe(big.length);
  });
}
```

The `finally` closure keeps `big` alive until the chain settles. If `big` is a request body buffer and the operation waits on remote I/O, memory pressure climbs with concurrency. Extract the small value you need before creating the closure.

```js
function handle(req, big) {
  const bytes = big.length;
  return doWork(req.id).finally(() => {
    metrics.observe(bytes);
  });
}
```

Same behavior. Less retained memory.

The debugging tradeoff is also real. Modern Node enables async stack traces by default, and V8 stores extra continuation metadata so rejected chains can show useful async frames. That metadata has memory cost. I keep it enabled for the debuggability unless a measured workload says otherwise.

Performance work starts with shape, not syntax. A chain that serializes independent operations costs more than the promise mechanism itself. A detached promise with no handler creates failure ambiguity. A busy loop that builds millions of promises creates allocator pressure. Fix those first. Then look at whether a lower-level callback path earns its complexity.

What I would actually do in production:

- Use promise-native Node APIs instead of promisifying core APIs.
- Attach `.catch()` in the chain that creates detached work.
- Prefer end-of-chain `.catch()` over two-argument `.then()` for most code.
- Use `throw` inside handlers unless a helper already returns a promise.
- Use `setImmediate()` between large independent batches that must let I/O proceed.
- Watch heap profiles for retained closures around large buffers or request objects.
- Treat `PromiseReactionJob` hotspots as profiling data, not as a reason to preemptively rewrite clean code.
