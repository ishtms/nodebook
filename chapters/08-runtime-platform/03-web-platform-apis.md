---
title: "Built-In Web Platform APIs"
date: "2026-05-11"
excerpt: "How Node exposes web-compatible globals for backend code: fetch, request and response bodies, web streams, payload objects, URL utilities, structured cloning, and stability-sensitive globals."
category: "Runtime Platform APIs & Tooling"
tags: ["nodejs", "web-platform", "fetch", "undici", "web-streams"]
author: "Ishtmeet Singh @ishtms"
chapter: "runtime-platform"
subchapter: "web-platform-apis"
published: true
toc: true
---

Node v24 gives backend code a selected web-compatible API surface on `globalThis`. That includes `fetch`, `Request`, `Response`, `Headers`, `Blob`, `File`, `FormData`, Web Streams, `TextEncoder`, `TextDecoder`, `URL`, `URLSearchParams`, `URLPattern`, `structuredClone`, `DOMException`, and a few more globals whose stability depends on the API. Many old polyfill imports disappear from application code, but the runtime underneath is still Node.

Web-compatible API surface means Node implements the same JavaScript-facing contracts used by web platform specs where those contracts make sense inside a server process. The object names, methods, body-consumption rules, stream shapes, and error classes line up with browser APIs. The backing runtime is Node: V8, libuv, native bindings, Undici, OS files, process state, and Node's module loaders.

The boundary matters.

```js
console.log(typeof fetch);
console.log(typeof Request);
console.log(typeof document);
```

In Node v24, the first two lines print `function`. The third prints `undefined`. `fetch` and `Request` are process globals. `document` belongs to browser page runtimes. Node gives backend code a web-compatible transport and data layer. Page globals such as `window`, `document`, DOM nodes, layout, navigation, and service-worker lifecycle stay with browsers.

`globalThis` is the standard name for the current global object. In Node modules, it is the place where these runtime globals live. `global` still exists as Node's older global namespace object, but Node's own docs point new code toward `globalThis`.

```js
console.log(globalThis.fetch === fetch);
console.log(globalThis.URL === URL);
console.log(globalThis.process === process);
```

The result is `true` for all three checks. `globalThis` contains web-compatible globals and Node-specific globals in the same namespace. That shared namespace is convenient, and it can also hide portability bugs. Code that uses `fetch` and `URL` may run in Node and a browser. Code that uses `process.env` in the same function is Node code.

A browser global is the global object exposed by a browser execution context. The common page global is `window`. Workers have another global shape. Node's global shape is process-oriented. The overlap is real, and the process model still wins. A backend service has process state: one process, one module graph per loader cache, OS resources, and server-side request handling. Page trees, origin storage models, user navigation stacks, and renderers belong to browsers.

That is the working model for this chapter: web-shaped JavaScript objects, Node-owned runtime plumbing.

The globals fall into a few runtime groups.

Fetch owns outbound HTTP(S) client calls through `fetch`, `Request`, `Response`, and `Headers`. Payload containers own byte and form shapes through `Blob`, `File`, and `FormData`. Stream globals own web stream objects through `ReadableStream`, `WritableStream`, `TransformStream`, and their controller and reader classes. Utility globals own encoding, URL parsing, cloning, and web-shaped errors. Optional or stability-sensitive globals sit at the edge: `navigator`, web storage, `CompressionStream`, `BroadcastChannel`, `WebSocket`, and `EventSource`.

Grouping them that way keeps the surface usable. Node remains a server runtime and now includes enough web-standard JavaScript contracts that backend code can use the same request, response, stream, URL, and payload objects that many libraries already expect.

There is a practical reason for that. Modern packages often publish code for several runtimes. A validation library might accept a `Request`. A storage client might return a `Response`. A multipart helper might build `FormData`. A compression helper might speak web streams. Before these globals existed, Node applications paid for adapters or third-party polyfills just to satisfy those object shapes. In v24, many of those shapes exist in the runtime.

That reduces dependency pressure, but it also moves compatibility into the Node version. A package that assumes `URLPattern` exists is assuming Node v24 or a polyfill. A package that assumes web storage exists is assuming flags and runtime state. A package that assumes `fetch` exists is fine on current Node, but its behavior still follows the Undici version bundled into that Node build.

The safest backend habit is boring: use the stable globals directly, feature-detect the unstable ones, and convert deliberately at boundaries where older Node stream APIs or buffers remain the better local type.

Global availability changes how you design small modules. Older Node code often imported `node-fetch`, `form-data`, `whatwg-url`, or stream ponyfills near the top of a file. Current Node code can often use the built-in objects. That sounds small, but it changes ownership. The runtime now owns API behavior, bug fixes, and compatibility. Your package lockfile owns fewer polyfills.

That is usually good. It also means a module should state its runtime floor. A library that calls global `fetch` is saying "Node 18+ at least, with current behavior depending on the active Node line." A library that calls `URLPattern` is saying "Node v24+ or caller-provided fallback." A service that calls `localStorage` is saying "startup flags and storage file policy exist." Those are runtime contracts, and hiding them deep in a helper makes failures look random.

Keep global reads near the edge when the feature has stability risk.

```js
export function makeClient({ fetchImpl = fetch } = {}) {
  return url => fetchImpl(url);
}
```

That function defaults to the global and still accepts an injected implementation. Tests can pass a fake. Older runtime adapters can pass a polyfill. Production code can use the built-in path. The function body stays honest about the dependency.

Stable data objects need less ceremony. `URL`, `URLSearchParams`, `TextEncoder`, `TextDecoder`, `Blob`, and fetch classes are fine to use directly inside application code. They are part of the modern Node platform. The caution belongs around globals whose docs still mark them experimental, active development, release candidate, or flag-controlled.

## Fetch Is a Node HTTP Client API

`fetch()` is a global function that starts an HTTP(S) request and returns a `Promise` for a `Response`.

```js
const response = await fetch('https://example.com/status');

console.log(response.status);
console.log(await response.text());
```

The call creates a request, hands it to Node's built-in fetch implementation, waits for response headers, and gives JavaScript a `Response` object. The response body may still be streaming when the `Promise` resolves. Status and headers are available first. Body bytes arrive through the response body.

Node's `fetch()` is powered by Undici. Undici is Node's HTTP client implementation for this API surface. It owns the lower client machinery under fetch: request dispatch, connection reuse, parsing response data, streaming bodies, and translating lower-level failures into web-compatible objects and errors. Chapter 10 owns Undici connection pooling and HTTP client behavior in depth. Here, the useful fact is placement. `fetch()` is the public global. Undici is underneath it.

You can see the bundled Undici version:

```js
console.log(process.versions.undici);
```

That number matters during bug reports. A Node version includes a specific Undici version, and behavior can change when Node upgrades its bundled dependency. If a production issue mentions fetch redirects, body streaming, proxy support, or socket reuse, record the Node version and the Undici version before chasing application code.

`Request` is the object form of a request. It stores the URL, method, headers, body, credentials mode fields from the web contract, and other request metadata.

```js
const request = new Request('https://api.example.test/users', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Ada' })
});
```

Constructing a `Request` only creates a JavaScript object with a body source attached. Passing it to `fetch()` starts the request. That split is useful when code needs to normalize headers, attach a body once, then pass the request through a small client wrapper.

`Headers` stores header names and values with web header behavior. Names are case-insensitive. Iteration gives normalized entries. Multiple operations may combine values according to the Fetch spec's header list behavior. For backend code, use it as the canonical container when an API expects fetch objects.

```js
const headers = new Headers();
headers.set('content-type', 'application/json');
headers.append('x-trace-id', 'req-123');

console.log(headers.get('Content-Type'));
```

The last line returns the content type value. The lookup ignores casing. The internal container handles the matching.

`Response` is the object returned by fetch and also a constructor you can use in tests or internal boundaries.

```js
const response = new Response('created', {
  status: 201,
  headers: { location: '/users/123' }
});

console.log(await response.text());
```

That response has a body, a status, and headers. It is a data container with body-consumption methods. A synthetic `Response` can stay entirely inside tests, mocks, or internal adapter code unless some API chooses to send it.

The Body mixin is the shared body contract used by `Request` and `Response`. It gives both objects methods such as `.text()`, `.json()`, `.arrayBuffer()`, `.blob()`, and `.formData()`, plus the `.body` stream and `.bodyUsed` flag. The body is one-shot. Once code reads it, the object records that consumption and later reads reject.

```js
const res = new Response(JSON.stringify({ ok: true }));

console.log(await res.json());
console.log(res.bodyUsed);
console.log(await res.text());
```

The first read consumes the body and sets `bodyUsed` to `true`. The second read rejects because the bytes have already moved through the body reader. That is one of the easiest fetch bugs to create in logging middleware: code reads `response.text()` for diagnostics, then the caller tries to parse JSON from an empty, consumed body.

Clone before reading twice.

```js
const copy = response.clone();

console.log(await copy.text());
return response;
```

Cloning tees the body so two consumers can read it. That has memory and buffering consequences when the body is large or one consumer is slow. For small diagnostic bodies, it is fine. For large payloads, prefer one owner for body consumption and stream the bytes through the path that needs them.

Errors from `fetch()` follow the web shape more than older Node callback shapes. A network-level failure rejects the `Promise`. An HTTP status such as `404` resolves with `response.ok === false`. The request completed at the protocol level, so fetch gives you a response object. Chapter 10 owns HTTP semantics. For now, keep the operational rule simple: `try/catch` around fetch catches transport and construction failures, while status policy lives after the response arrives.

```js
const res = await fetch(url);

if (!res.ok) {
  throw new Error(`bad status: ${res.status}`);
}
```

That branch is application policy. Fetch delivered the status. Your code decides whether that status is acceptable.

The object lifetime has a few layers.

```text
Request object
  -> Undici dispatch
  -> response headers
  -> Response object
  -> web stream body
  -> body reader
```

The `Request` object is JavaScript state. It holds a URL, method, headers, and optional body. The body may be a string, `Buffer`, typed array, `Blob`, `FormData`, `URLSearchParams`, or stream-like object accepted by fetch. When `fetch()` receives the request, Node validates enough of that state to dispatch the operation. Bad URLs, invalid methods, invalid header names, or illegal body shapes can reject before any useful network work happens.

After dispatch, Undici owns the in-flight client work. The request has crossed below the web object layer. JavaScript still has a `Promise`, and Node's fetch stack has native and JavaScript state tied to sockets, timers, parser state, and body queues. When headers arrive, fetch resolves the promise with a `Response`. That timing matters because the body can still be unread. A handler that only checks status can run before the full payload has arrived.

Body state is separate from header state. `response.status`, `response.ok`, and `response.headers` are immediately readable after the promise resolves. The body remains a stream. A call to `.text()` or `.json()` drains that stream into memory and then converts it. Manual streaming keeps the payload chunked. The choice belongs to the caller because the caller knows whether the payload is small metadata or a multi-gigabyte export.

The one-shot body rule comes from that ownership. A body has one consumption path. Helper methods such as `.json()` and `.arrayBuffer()` are consumers. A reader obtained from `.body.getReader()` is a consumer. Piping the body through a transform is a consumer. After consumption starts, the object records that state through `bodyUsed` or stream disturbance. A second consumer receives a rejection because the first consumer owns the bytes.

The `.clone()` method works by splitting the body into two branches. That is useful, and it has real buffering behavior. If one branch is consumed quickly and the other branch stalls, the implementation may need to buffer chunks for the slow branch. Logging every response body by cloning it can turn a client wrapper into a memory pressure source. For small JSON APIs, the tradeoff is often acceptable. For large downloads, put logging around metadata or sample a bounded prefix through one stream owner.

Headers have their own guard behavior. Some `Headers` objects are mutable. Others are constrained by where they came from. A response returned from fetch has headers that reflect the received response. A request being constructed by your code can usually have application headers set through the constructor or through a mutable `Headers` object. Runtime-owned forbidden or generated headers may still be controlled by fetch internals. Keep wrapper code focused on application headers and avoid trying to micromanage transport headers that Undici owns.

There is also a difference between a rejected fetch and a fulfilled fetch with a bad status. A DNS failure, refused connection, invalid request body stream, or aborted operation rejects the promise. A `500` response fulfills the promise because a response arrived. That split is the web fetch contract, and Node follows it. A backend wrapper usually needs both layers:

```js
const res = await fetch(url);

if (res.status >= 500) {
  throw new Error(`upstream failed: ${res.status}`);
}
```

That code leaves transport failures to `try/catch` around the call and handles response policy after the `Response` exists. Mixing those two layers makes retries and logging noisy because network failures and upstream status decisions carry different facts.

Redirects, cookies, cache modes, proxying, keep-alive behavior, and connection pooling all sit below or beside this object model. Those topics need HTTP semantics and Undici details, so Chapter 10 owns them. At this level, the fetch object graph is enough: create a request, dispatch it, receive response headers, consume one body stream.

Abort signals deserve a narrow mention because fetch accepts them.

```js
const signal = AbortSignal.timeout(2_000);
const response = await fetch(url, { signal });
```

That request receives a cancellation signal with a two-second timer. If the signal aborts before the operation finishes, fetch rejects. The full design of deadlines, cancellation propagation, cleanup, and retries belongs later. The local point is smaller: fetch accepts the same web-compatible signal object used by several Node APIs, and aborting affects the in-flight body as well as the header wait.

Timeouts belong outside low-level helpers unless the helper owns policy. A generic client wrapper can accept a signal. A service method can choose the deadline. That division keeps the transport object model clean:

```js
export function getJson(url, { signal } = {}) {
  return fetch(url, { signal }).then(res => res.json());
}
```

That helper forwards the signal and leaves deadline policy to the caller. It still has a body-consumption decision: `.json()` drains the body into memory. For large responses, return the `Response` or `ReadableStream` and leave parsing to the caller. Ownership of the body and ownership of cancellation should be visible at the same boundary.

## Payload Objects Carry Bytes and Metadata

`Blob`, `File`, and `FormData` show up as soon as fetch code handles uploads or generated payloads.

`Blob` is an immutable byte container with a size and a MIME type string. It can be built from strings, `ArrayBuffer`, typed arrays, other blobs, and buffers. In Node, `Buffer` still exists and stays useful for low-level code. `Blob` becomes useful at web API boundaries because fetch, `Response`, `Request`, and form payloads understand it.

```js
const payload = new Blob(['hello\n'], {
  type: 'text/plain'
});

console.log(payload.size);
```

The blob stores bytes. The `type` string is metadata. Reading a blob is asynchronous because the web contract exposes promise-returning methods:

```js
const bytes = await payload.arrayBuffer();
const text = await payload.text();
```

Those reads produce copies in the shapes requested by the API. If code already has a `Buffer`, keep the `Buffer` while doing Node-native file or socket work. Convert to `Blob` when the receiving API wants a web payload object.

`File` extends the blob idea with a name and last-modified timestamp. It is a byte container plus file-like metadata. File descriptor state stays with Node file-system APIs.

```js
const file = new File(['id,name\n1,Ada\n'], 'users.csv', {
  type: 'text/csv',
  lastModified: Date.now()
});
```

The constructor supplies the bytes. File descriptor state stays with Node file-system APIs. The name travels as metadata for APIs that care about uploaded file names.

`FormData` is a key/value payload container. Values can be strings or blob-like file parts. In Node fetch code, it is the object you pass when the request body needs named fields and files.

```js
const form = new FormData();
form.set('name', 'Ada');
form.set('avatar', file);

await fetch(url, { method: 'POST', body: form });
```

The multipart encoding details belong with HTTP and API chapters. The local point is object ownership. `FormData` owns the field list. Fetch knows how to serialize it for a request body and set the matching content type. Avoid manually setting a multipart `content-type` header with a guessed boundary. Let the body serializer create the boundary that matches the bytes it writes.

These objects are easy to overuse in backend code. A service that reads files from disk, transforms buffers, and writes to a database may gain nothing from wrapping every byte array in a `Blob`. But at API boundaries, the web payload containers reduce glue code because Node's fetch stack already speaks them.

There is a copy boundary hiding in these payload types.

A `Buffer` can point at external memory owned by Node's buffer machinery. A typed array can view an `ArrayBuffer`. A `Blob` takes parts and produces an immutable byte sequence for the blob contract. The constructor can accept those inputs, but later writes to an original buffer should be treated as separate from the blob's logical value. Code that needs mutation should stay with `Buffer` or typed arrays until the last possible boundary. Code that needs an immutable payload for a request can build a `Blob` and hand it off.

`FormData` also changes ownership. After code appends a `File` or `Blob`, the form owns a part reference and metadata such as field name and optional filename. Serialization happens later, during fetch body production. That delayed serialization is why fetch can set a matching boundary. It is also why inspecting a `FormData` object prints a field list, while final bytes appear during body serialization.

```js
for (const [name, value] of form) {
  console.log(name, typeof value);
}
```

That loop shows fields before wire bytes exist. A string value appears as a string. A file part appears as an object. Treat `FormData` as a structured body source with serialization delayed until fetch consumes it.

For server code, that distinction prevents a common mistake. A helper that accepts either JSON or form payloads should decide body shape once:

```js
const body = asForm ? buildForm(data) : JSON.stringify(data);
const headers = asForm ? undefined : { 'content-type': 'application/json' };

await fetch(url, { method: 'POST', headers, body });
```

When the body is `FormData`, leave `content-type` alone. When the body is JSON text, set it. Two payload types. Two header paths.

`URLSearchParams` can also be a request body. For form-style key/value posts, fetch can consume it and set the matching encoded body shape.

```js
const body = new URLSearchParams();
body.set('grant_type', 'client_credentials');

await fetch(tokenUrl, { method: 'POST', body });
```

That is separate from `FormData`. `URLSearchParams` produces URL-encoded text. `FormData` produces field parts and file-capable payloads. JSON produces a string or bytes you label with `application/json`. Choosing the payload object chooses the serializer path.

The practical backend rule is to keep the input object close to the protocol boundary. Domain code should usually pass structured values. The client adapter can decide how those values become `FormData`, blobs, strings, or bytes. That keeps tests smaller and keeps request serialization in one place.

## Web Streams Cross the Boundary

Fetch response bodies use the Web Streams API.

```js
const response = await fetch(url);
const body = response.body;

console.log(body instanceof ReadableStream);
```

In Node v24, `response.body` is a `ReadableStream`. That is the web stream type, distinct from the Node `Readable` stream class covered in Chapter 3. The concepts overlap: chunks, backpressure, cancellation, and errors. The object model differs.

The Web Streams API is the standard stream contract used by fetch and other web-compatible APIs. A `ReadableStream` has an internal queue, a source algorithm that supplies chunks, and reader objects that consume those chunks. A `WritableStream` has a sink algorithm and a writer. A `TransformStream` has a readable side and a writable side with transform logic between them.

The most visible rule is locking. Calling `.getReader()` locks a readable web stream to that reader. The active reader keeps exclusive ownership. A competing `getReader()` call or body helper fails until the first reader releases the lock, cancels, or finishes.

```js
const reader = response.body.getReader();
const first = await reader.read();

console.log(first.done);
reader.releaseLock();
```

That reader owns consumption until it releases the lock, cancels, or the stream finishes. Methods such as `response.text()` also consume through the body contract, so mixing manual readers and body helper methods creates disturbed or consumed streams.

The lock is more than an API inconvenience. It is how the stream keeps consumption coherent. A stream has one active reader because reads affect queue state, pull timing, cancellation, and error delivery. Two independent readers over one body would race over chunk ownership. The API chooses one reader, and competing consumers fail while the lock is held.

The path through a fetch response looks like this:

```text
socket bytes
  -> Undici parser
  -> Response headers
  -> web ReadableStream body
  -> reader or Body mixin method
  -> JavaScript value
```

Headers arrive before the full body. Body chunks move through the web stream. A helper such as `.json()` drains the stream, decodes text, parses JSON, and resolves with the result. A manual reader gives you chunks as they arrive. Either way, the body is consumed once.

Backpressure crosses this path. A web stream has queueing strategy state and a desired size. When the consumer slows down, the stream's pull algorithm stops asking for more chunks until demand returns. Under fetch, that pressure interacts with Undici and the socket layer. The exact socket behavior belongs to Chapter 10, but the application-level signal is visible: if code leaves `response.body` unread, bytes may remain buffered until the body is canceled, drained, or the connection is closed according to client rules.

Web stream internals are small enough to name while Chapter 3 remains the stream owner. A `ReadableStream` has an internal state, an internal queue, a stored error slot, and algorithms supplied by the underlying source. The source exposes hooks such as `start`, `pull`, and `cancel`. The stream calls `pull` when the queue needs more data. It calls `cancel` when the consumer gives up. The queueing strategy computes desired size. That desired size is the backpressure signal.

```js
const stream = new ReadableStream({
  pull(controller) {
    controller.enqueue(new Uint8Array([1, 2, 3]));
    controller.close();
  }
});
```

That snippet creates a web readable from an underlying source object. The controller receives chunks. Closing marks the stream as finished. In fetch, you usually receive a stream. Creating one yourself is rarer, but the same control points exist under the implementation.

Readers sit on top of that state. A default reader returns chunks in `{ value, done }` records. A BYOB reader exists for byte streams where the consumer provides a buffer, but fetch body code rarely needs to start there. The main backend skill is recognizing the default read loop:

```js
const reader = response.body.getReader();

for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  console.log(value.byteLength);
}
```

That loop owns the body until it exits. If it throws, release or cancel deliberately in real code. A helper method such as `.arrayBuffer()` does the same ownership work internally, but it collects every chunk before resolving.

Use adapters when a Node API expects Node streams.

```js
import { Readable } from 'node:stream';

const response = await fetch(url);
const nodeStream = Readable.fromWeb(response.body);
```

A stream adapter converts between the Web Streams API object model and Node's stream classes. `Readable.fromWeb()` wraps a web readable as a Node `Readable`. `Readable.toWeb()` wraps a Node `Readable` as a web `ReadableStream`. Writable and duplex adapters exist too.

That adapter is a wrapper. It translates read requests, chunk delivery, backpressure signals, cancellation, destroy, and errors between two stream contracts. Data still moves through queues. Chunks still have types. Backpressure still depends on the receiving side reading at a sane pace.

The chunk type matters. Fetch bodies typically produce `Uint8Array` chunks. Node streams often produce `Buffer` chunks for binary data, although `Buffer` is a `Uint8Array` subclass. Most code can treat those chunks as bytes, but strict type checks can break.

```js
for await (const chunk of nodeStream) {
  console.log(chunk.byteLength);
}
```

That loop uses the async iterator support already covered earlier. The adapter gives a Node-readable shape, and the loop consumes it chunk by chunk.

The opposite direction shows up when a Node stream needs to feed a web API.

```js
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';

const file = createReadStream('data.ndjson');
const body = Readable.toWeb(file);
```

`body` is a web `ReadableStream`. Some web-compatible APIs accept it directly. Fetch request bodies in Node also need the `duplex: 'half'` option for streaming request bodies. That tiny option is easy to miss.

```js
await fetch(url, {
  method: 'POST',
  body,
  duplex: 'half'
});
```

That option tells Node the request body is streamed. The HTTP reason belongs later. The local rule is practical: when you pass a streaming body to Node's fetch, include `duplex: 'half'`.

Adapter failure modes usually look mundane. A web stream gets locked by one helper and then passed to another. A body gets read for logging and then parsed again. A Node stream emits an error and the web consumer sees a rejected read. A web stream cancellation destroys the Node stream underneath. When the bug involves streams at a web/Node boundary, inspect the ownership path before changing highWaterMark values or adding buffering.

`Readable.isDisturbed()` can help during debugging because it reports whether a Node readable or web readable has been read from or canceled.

```js
import { Readable } from 'node:stream';

console.log(Readable.isDisturbed(response.body));
```

A `true` result means some consumer touched that body. It narrows the search to body ownership, then the code review has to find the first consumer.

Adapters also preserve enough error shape to keep debugging sane, but they translate between different event models. A Node readable can emit `'error'`. A web readable can make `reader.read()` reject and put the stream into an errored state. When `Readable.fromWeb()` wraps a web stream, the wrapper maps web stream errors into Node stream errors. When `Readable.toWeb()` wraps a Node stream, the adapter maps Node errors into rejected reads. The original error object usually travels through, but the observation point changes.

Destruction and cancellation deserve the same care. Destroying a Node stream created from a web stream cancels the web source. Canceling a web stream created from a Node stream destroys the Node stream. That is the behavior you want when one side gives up. It can surprise code that expects a source to stay alive after an adapter consumer stops early.

```js
const nodeStream = Readable.fromWeb(response.body);
nodeStream.destroy(new Error('stop early'));
```

That call tells the wrapped body that consumption ended with an error. For a fetch response, early cancellation can affect connection reuse and body cleanup under the client. Chapter 10 owns the transport outcome. The local point is ownership: the adapter becomes the consumer, and destroying it has upstream effects.

Use one shape per boundary. If your pipeline is mostly Node streams, convert once at the edge and stay in Node streams. If your pipeline is mostly fetch and web transforms, keep it in web streams and use `pipeThrough()` / `pipeTo()`. Repeated conversion makes state harder to inspect because every adapter adds another place where errors, cancellation, and backpressure translate.

There is one more body-state trap: helper methods hide streaming. `.json()` appears to be a parser call, but it drains the whole body first. `.arrayBuffer()` appears to be a conversion call, but it also drains the whole body first. `.blob()` builds a blob from the whole body. Those methods are fine for bounded API responses. They are poor defaults for exports, media, backups, and unknown-size upstream bodies.

Streaming code should say so in the type it returns.

```js
import { Readable } from 'node:stream';

export async function download(url) {
  const res = await fetch(url);
  return Readable.fromWeb(res.body);
}
```

That function returns a Node stream, so callers can pipe it, observe backpressure, and attach error handling in the Node stream style. A web-streaming helper would return `res.body` directly. A parsing helper would return data. Each helper should pick one ownership model.

Mixing ownership models creates the bug. A helper returns a `Response` after peeking at the body. A caller expects the body to be fresh. A transform reads from a web stream and then passes the same stream into `Readable.fromWeb()`. A logging layer clones large responses and falls behind. Unclear stream ownership creates those failures.

## Text and URL Utilities Remove Small Dependencies

`TextEncoder` turns JavaScript strings into UTF-8 bytes.

```js
const encoder = new TextEncoder();
const bytes = encoder.encode('ready\n');

console.log(bytes.byteLength);
```

The result is a `Uint8Array`. The encoding is UTF-8. That pairs cleanly with web APIs that expect typed arrays or web streams of bytes.

`TextDecoder` turns bytes into strings.

```js
const decoder = new TextDecoder('utf-8');
const text = decoder.decode(bytes);

console.log(text);
```

Text decoding has edge cases around partial multibyte sequences. For whole buffers, `.decode(bytes)` is enough. For chunked input, pass `{ stream: true }` until the final chunk so the decoder can keep incomplete sequence state between calls.

```js
const decoder = new TextDecoder();

let out = decoder.decode(chunkA, { stream: true });
out += decoder.decode(chunkB);
```

That state is the reason `TextDecoderStream` exists, although most backend code can stay with `TextDecoder` or Node stream transforms until it reaches a web stream boundary.

`URL` is the standard parser and formatter for URLs.

```js
const url = new URL('/users?id=123', 'https://api.example.test');

console.log(url.pathname);
console.log(url.searchParams.get('id'));
```

The base URL supplies the origin for a relative path. `URLSearchParams` owns the query string state.

```js
const params = new URLSearchParams();
params.set('limit', '50');
params.set('cursor', 'abc');

console.log(params.toString());
```

Every value is a string at the query boundary. Keep that boundary visible. Parse numbers and booleans after reading them. Serialize values deliberately before writing them.

`URL` also normalizes. It percent-encodes where needed, resolves `.` and `..` path segments under the URL rules, and exposes components through properties. That is useful for backend code that receives callback URLs, proxy targets, redirect locations, or internal service endpoints. It is also a reason to avoid ad hoc string concatenation for URLs.

```js
const base = new URL('https://api.example.test/v1/');
const users = new URL('users?active=true', base);

console.log(users.href);
```

That produces a normalized absolute URL. The slash at the end of the base path matters under URL resolution rules. If the base is `https://api.example.test/v1`, then `users` replaces `v1`; if the base is `https://api.example.test/v1/`, then `users` sits under `v1/`.

Query parameters need the same discipline. `URLSearchParams` stores repeated keys, string values, and encoded output. The object preserves repeated entries during iteration.

```js
const params = new URLSearchParams('tag=node&tag=runtime');

console.log(params.getAll('tag'));
```

That returns both values. `get()` would return the first. Backend filters often need repeated parameters, so use `getAll()` when the API contract permits repeated keys. Treat every value as untrusted text until validation has converted it into the application type.

URL parsing also gives you a clean place to reject unsupported schemes.

```js
const target = new URL(input);

if (target.protocol !== 'https:') {
  throw new Error('https required');
}
```

That check belongs before fetch, before redirects, and before any code that opens a socket. It is basic input handling, separate from security review, and it keeps string parsing out of lower-level client code.

`URLPattern` matches URL components against patterns. In Node v24 it is experimental, and that status should shape production use. The API is still useful for small backend routing or validation cases where a web-standard pattern object is enough.

```js
const pattern = new URLPattern({
  pathname: '/users/:id'
});

console.log(pattern.exec('https://x.test/users/42')?.pathname.groups.id);
```

The pattern parses the pathname and returns named groups from the match. It can also match protocol, hostname, port, search, hash, and username/password fields when those parts are supplied. For backend services, the sweet spot is narrow: validate or route a small set of URL shapes at an edge in your own code.

Keep `URLPattern` below framework scope. Routing frameworks handle method selection, middleware order, path decoding policy, parameter validation, error shaping, and observability hooks. `URLPattern` matches URL parts. That is plenty for small internal tools and low-level boundaries. Chapter 12 owns API routing design.

`URLPattern` also separates match input from groups. A successful match returns component-specific group objects. That shape keeps route extraction tied to the part of the URL that matched.

```js
const match = pattern.exec('https://x.test/users/42');

console.log(match.pathname.input);
console.log(match.pathname.groups.id);
```

That result is useful for internal dispatch tables:

```js
const routes = [
  ['GET', new URLPattern({ pathname: '/users/:id' })],
  ['GET', new URLPattern({ pathname: '/health' })]
];
```

The array still needs application policy around methods, ordering, validation, and error responses. The pattern only answers the match question. Because `URLPattern` is experimental in v24, feature detection or a small compatibility wrapper belongs around library code that may run on multiple Node lines.

Encoding and URL parsing often meet at request-signing boundaries. The exact bytes matter there. `URLSearchParams` serializes with its own encoding rules. `TextEncoder` serializes strings as UTF-8. `Buffer.from(string)` also defaults to UTF-8, but returning a `Uint8Array` from `TextEncoder` makes web API intent clear.

```js
const canonical = `${url.pathname}?${url.searchParams}`;
const bytes = new TextEncoder().encode(canonical);
```

That byte array can feed hashing or signing code. The crypto details belong later. The useful boundary here is deterministic string-to-byte conversion. Build the URL with URL objects, choose the canonical string, encode it once, then hand bytes to the next layer.

For incoming URLs, parse once near the edge and pass a typed shape inward.

```js
const url = new URL(requestUrl, 'https://service.local');
const limit = Number(url.searchParams.get('limit') ?? 50);
```

Validation still has to check `Number.isInteger(limit)` and range. The URL layer only extracts text under URL parsing rules. Keeping that line explicit prevents lower layers from receiving a raw URL string and each applying its own parsing policy.

## Structured Clone Copies Values by Runtime Rules

`structuredClone()` copies values using the structured clone algorithm.

```js
const copy = structuredClone({
  createdAt: new Date(),
  ids: new Set([1, 2, 3])
});

console.log(copy.ids.has(2));
```

The clone preserves many built-in data shapes that JSON would flatten or drop: `Date`, `Map`, `Set`, typed arrays, `ArrayBuffer`, nested arrays, and plain objects. It also handles cycles.

```js
const value = { name: 'root' };
value.self = value;

const copy = structuredClone(value);
console.log(copy.self === copy);
```

That works because structured clone tracks object identity during the copy. JSON serialization would throw on the cycle.

Some values reject. Functions, module namespace objects, promises, and many host objects fall outside the structured-clone set. When cloning fails, the error is a `DOMException`, often with the name `DataCloneError`.

```js
try {
  structuredClone({ run() {} });
} catch (err) {
  console.log(err.name);
}
```

`DOMException` is the web-compatible error class used by several of these APIs. The name property often carries the useful category: `DataCloneError`, `AbortError`, `QuotaExceededError`, or another web-defined name depending on the API. Treat the name as part of the boundary contract when interoperating with web-compatible APIs.

Transfers are part of structured clone too. An `ArrayBuffer` can move to the clone when passed in the transfer list.

```js
const buffer = new ArrayBuffer(16);
const copy = structuredClone(buffer, { transfer: [buffer] });

console.log(buffer.byteLength);
console.log(copy.byteLength);
```

After transfer, the original buffer is detached and its byte length becomes zero. That is a sharp edge. It is useful when ownership should move, and it is a bug when the caller expects to keep using the original. Worker communication owns this topic later. For this chapter, remember the local rule: clone copies supported values; transfer moves supported backing storage.

The clone result has fresh object identity. A cloned `Map` is a different `Map`. A cloned typed array has a different wrapper. A copied `ArrayBuffer` has separate backing storage unless transferred. Shared backing storage stays shared only for types whose contract says so, such as `SharedArrayBuffer`.

That makes `structuredClone()` useful for boundary snapshots. If a configuration object or test fixture contains maps, sets, dates, typed arrays, or cycles, structured clone keeps more of the runtime shape than JSON. It also rejects unsupported values earlier than a hand-written shallow copy that silently carries functions or live handles across a boundary.

Use it for data. Keep resources out. File handles, sockets, streams, and module objects have lifecycle state tied to the process. A clone boundary should carry values, and live capabilities should stay outside. When the object graph includes a stream body or request object, choose an API-specific clone method such as `Request.clone()` or `Response.clone()` only when that body split is part of the design.

## Stability-Sensitive Globals Need Feature Detection

Some web-compatible globals in Node v24 are stable. Some are experimental or active development. Some can be disabled by flags. Treat them as runtime features with explicit checks in package code.

Feature detection is cheap:

```js
if (typeof URLPattern === 'function') {
  console.log('URLPattern available');
}
```

That check is better than checking a Node major version when an API can be behind a flag, disabled by a flag, or affected by the exact runtime build.

A small startup probe can make the process contract explicit.

```js
const required = ['fetch', 'Request', 'Response', 'ReadableStream'];

for (const name of required) {
  if (typeof globalThis[name] === 'undefined') throw new Error(name);
}
```

That code belongs in applications with a strict runtime contract. Libraries should prefer injected capabilities or graceful fallback because they run inside someone else's process. Applications can fail fast because they own the deployment image and Node version.

`navigator` in Node is a partial process-level object inspired by browser `navigator`. In v24 it is active development. It exposes fields such as `hardwareConcurrency`, `language`, `languages`, `platform`, and `userAgent`. The values describe the Node instance and runtime environment, separate from browser tab state.

```js
console.log(navigator.userAgent);
console.log(navigator.hardwareConcurrency);
```

`navigator.hardwareConcurrency` reports logical processors available to the Node instance. It can reflect process constraints. That makes it a useful signal, but still a signal. Thread pool sizing, worker counts, and job concurrency need application policy on top.

Web Storage is more dangerous in backend code. Node v24 includes `localStorage` and `sessionStorage` as release-candidate web storage APIs. `localStorage` stores unencrypted data in the file named by `--localstorage-file`, with a 10 MB quota. `sessionStorage` stores data in memory for the current process. Server code shares process globals across requests, so request-specific or user-specific data belongs elsewhere.

```js
if (typeof localStorage === 'object') {
  localStorage.setItem('last-start', String(Date.now()));
}
```

That code writes process-level state. In a server, every request handler sees the same global storage object. Use it for tooling experiments or process-local metadata only when the startup contract explicitly enables it. User session data belongs in an application-owned store.

`CompressionStream` and `DecompressionStream` expose web-compatible compression transforms. They are globals in Node v24 and marked stable. They use web streams, so they fit naturally with fetch bodies and other web stream paths.

```js
const compressed = response.body
  .pipeThrough(new CompressionStream('gzip'));
```

That line creates a web stream pipeline. Node's older `node:zlib` APIs still matter for Node stream pipelines and lower-level compression controls. The choice follows the boundary: web streams on one side, Node streams on the other.

`BroadcastChannel` is a named message channel API. In Node, it is useful around workers and runtime contexts that participate in the same process-level channel model. Chapter 15 owns worker design. At this point, just recognize the object: named channel, `message` events, explicit close.

```js
const channel = new BroadcastChannel('events');
channel.postMessage({ type: 'ready' });
channel.close();
```

`WebSocket` is also global in Node v24 and stable, with a browser-compatible client shape. The protocol belongs to Chapter 13. For now, keep it out of generic fetch wrappers. A WebSocket is a long-lived bidirectional protocol endpoint with its own state machine.

`EventSource` is the global shape for Server-Sent Events. SSE also belongs to Chapter 13. Use feature detection before relying on it, because runtime flags and stability changed across recent Node releases.

Web Crypto is available through `crypto` and `SubtleCrypto` globals when the Node binary has the crypto module built in. The security chapter owns that API. Mentioning it here is enough because crypto code has policy, key-management, and algorithm-selection concerns that deserve their own space.

`AbortController` and `AbortSignal` appear throughout fetch and stream APIs. They were introduced earlier as web-compatible globals, but cancellation design belongs later. For this chapter, pass a signal when an API accepts one, and keep timeout and cancellation policy owned by the calling layer.

The deeper pattern is stable: feature-detect web-compatible globals at runtime when stability or flags matter. Use fetch objects and web streams where Node's built-in web APIs expose them. Convert at the boundary when a Node API expects Node streams or buffers. And keep protocol semantics in their owning chapters, because the web-shaped object is only the JavaScript surface over a much lower stack.

That last boundary is where many production bugs start. A package treats Node as browser-compatible because `fetch` exists. Then it reaches for `localStorage`, `EventSource`, `URLPattern`, or newer `navigator` fields and crosses into stability or flag-sensitive territory. A service wrapper disables a global through a CLI flag. A test runner uses a different Node major. A bundled library brings a polyfill whose behavior disagrees with the built-in object.

The fix is boring and explicit. Own the runtime contract near startup:

```js
export const platform = {
  fetch,
  URLPattern: globalThis.URLPattern ?? null,
  storage: globalThis.localStorage ?? null
};
```

That module gives the rest of the app one place to inspect. It also makes tests honest. A test can set `URLPattern` to `null` and verify the fallback path. A production boot check can reject a missing stable dependency before the service handles traffic.

For libraries, keep the contract even smaller. Accept objects from callers and keep global reads out of deep package code. A function that accepts a `fetch` implementation, a `Request`, or a `ReadableStream` is easier to run in Node, browsers, workers, and tests. Runtime globals are convenient at the application edge. Passing the object through the code keeps the dependency visible.

Node's web-compatible surface is best treated as a set of native boundary types. They are real globals. They are backed by Node runtime code. They reduce adapter code. They also carry the exact body, stream, clone, and stability rules of the APIs they implement. Use those rules directly, and the surface stays small enough to reason about.
