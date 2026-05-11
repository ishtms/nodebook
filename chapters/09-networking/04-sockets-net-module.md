---
title: "Sockets and the net Module"
date: "2026-05-11"
excerpt: "How Node's net.Server and net.Socket wrap OS socket state, libuv TCP handles, connection events, writes, shutdown, timeouts, and local IPC endpoints."
category: "Network Fundamentals with Node.js"
tags: ["nodejs", "networking", "tcp", "sockets", "net"]
author: "Ishtmeet Singh @ishtms"
chapter: "networking"
subchapter: "sockets-net-module"
published: true
toc: true
---

`net.createServer()` gives you a JavaScript server object before any port is claimed. The port belongs to the operating system after `listen()` succeeds. That split is where most `node:net` behavior starts to make sense - one object in JavaScript, one socket below it.

```js
import net from 'node:net';

const server = net.createServer(socket => {
  socket.end(socket.remoteAddress + '\n');
});

server.listen(3000, '127.0.0.1');
```

`net.createServer()` creates a `net.Server`. It stores the connection callback. It sets up EventEmitter behavior. It prepares internal fields that will later point at native state. The port remains unclaimed. The kernel socket table remains unchanged.

`server.listen()` moves the operation below JavaScript. Node creates native TCP state, hands it to libuv, asks the operating system for a TCP socket, binds that socket to `127.0.0.1:3000`, and marks it as listening. After that succeeds, the process owns a listening endpoint.

Small API. Lots of state.

The object trace looks like this:

```text
net.Server
  -> TCPWrap
  -> libuv TCP handle
  -> OS listening socket
```

The names matter because each layer owns a different part of the behavior. `net.Server` owns the JavaScript API. TCPWrap is Node's native wrapper around a TCP handle. The libuv TCP handle joins that native object to event-loop readiness. The operating system owns the socket state, file descriptor or platform handle, bound address, listen state, and accept behavior.

A socket is the process endpoint for a network or local IPC conversation. In this subchapter, the common case is a TCP socket. It has an address family, protocol state, kernel buffers, and local or remote endpoint data. Node wraps that lower object in JavaScript so your code can use events, streams, and methods instead of system calls.

The useful split is simple:

```text
listening socket
  -> accepts new TCP connections

connected socket
  -> reads and writes bytes for one peer
```

A `net.Server` wraps a listening socket. A `net.Socket` usually wraps a connected socket. The server receives new peers. The socket talks to one peer.

That distinction explains most `node:net` bugs.

## `node:net` Owns Raw Streams

`node:net` is Node's built-in module for stream-oriented TCP and local socket endpoints. It gives you TCP servers, TCP clients, UNIX domain sockets on Unix-like systems, and Windows named pipes on Windows. It sits below HTTP, TLS, WebSocket, database clients, Redis clients, and most custom binary protocols.

Use it when you want bytes. Raw reads. Raw writes. Connected byte streams and socket lifecycle events. Your code supplies any parser, headers, or message framing above that.

```js
import net from 'node:net';

const server = net.createServer(socket => {
  socket.write('hello\n');
  socket.end();
});
```

The callback receives a `net.Socket`. It is a Duplex stream, so the stream vocabulary from Chapter 3 applies. The readable side emits data from the peer. The writable side accepts bytes headed to the peer. Backpressure still matters, but now some pressure lives in Node stream queues and some lives lower in kernel socket buffers and TCP flow control.

`net.Socket` is also an EventEmitter, so the event vocabulary from Chapter 7 applies. `connect`, `data`, `end`, `error`, `timeout`, and `close` are events on top of native socket transitions.

The lower state is the part to keep in your head.

```text
JavaScript net.Socket
  -> native TCPWrap or PipeWrap
  -> libuv handle
  -> OS socket or pipe endpoint
```

For TCP, the libuv handle is a `uv_tcp_t`. It stores libuv's TCP handle state and gives libuv a handle it can register with the event loop. On Unix-like systems, that handle is tied to a file descriptor. On Windows, the lower handle is a Windows socket handle with Windows I/O behavior. Node keeps the JavaScript API aligned across both.

TCPWrap is an internal Node binding object. The exact implementation can shift across Node versions, but the role is stable enough for debugging: it is the native object that connects the JavaScript `net.Socket` or `net.Server` to libuv's TCP handle. JavaScript calls methods. Native code turns those calls into libuv operations. libuv turns readiness and completion back into native callbacks. Node emits JavaScript events and calls user callbacks.

For local IPC endpoints, Node uses pipe-oriented native handles instead of TCP handles. The JavaScript API still uses `net.Server` and `net.Socket` for many operations. The endpoint format changes. The lower OS primitive changes. The stream contract stays familiar.

The module has two common creation paths:

```js
const server = net.createServer(onConnection);
const client = net.createConnection(3000, '127.0.0.1');
```

`net.createConnection()` and `net.connect()` are aliases for client creation. They create a `net.Socket` and call `socket.connect()` for you. Server code usually starts with `net.createServer()`. Client code usually starts with `net.connect()` when it has host and port values ready.

## The Native Handle Path

The deep part sits between a JavaScript method call and the event that comes back later.

`net.Server` and `net.Socket` are JavaScript objects. They carry user-visible state, event listeners, stream machinery, and references to a native handle. The native handle is where Node leaves JavaScript and reaches libuv. For TCP, the native object is backed by libuv's TCP handle. For local pipe endpoints, the native object is backed by a pipe handle.

The TCP handle is the event-loop object for TCP. In libuv terms, it is the thing that can be initialized, bound, connected, read from, written to, stopped, and closed through libuv APIs. It also has lifecycle state: initialized, active, closing, closed. Node's JavaScript object has its own stream flags, so there are two layers of state to reconcile.

That reconciliation is where many odd bugs live.

When you call `server.listen()`, Node eventually asks libuv to bind and listen. libuv performs platform-specific work. On Unix-like systems, the lower socket is represented by a descriptor and watched through the platform polling backend. On Linux that usually means epoll through libuv. On macOS and BSD systems, kqueue is common. On Windows, libuv uses Windows I/O completion behavior. The JavaScript event stays `connection` across those platforms.

The polling backend watches readiness. It reports that the listening socket is ready for accept work. Node then runs native accept logic. The accepted lower socket gets its own handle. Node creates a new JavaScript `net.Socket` and links it to that handle.

The important point is ownership:

```text
server JS object
  -> one native listen handle

accepted socket JS object
  -> one native connected handle
```

The server's handle and the accepted socket's handle are separate. Closing one targets one lower object. That is why `server.close()` and `socket.end()` do different work.

Reads follow another path. When a connected socket is readable, libuv reports readiness to Node. Node asks libuv to read bytes. libuv reads from the lower socket into memory provided through allocation callbacks. Node wraps those bytes into Buffers or uses existing Buffer-backed storage, then pushes data into the readable side of the `net.Socket`. The user-facing `data` event appears after all of that.

Writes run in the opposite direction. A JavaScript write enters the writable stream side. Node creates native write requests for the chunks that need to move downward. libuv submits the write to the OS. Completion comes back later, and Node drains callbacks, updates writable state, and possibly emits `drain`.

The write request has its own lifetime. It can outlive the JavaScript call that created it. It can complete after the stack that called `socket.write()` has returned. It can fail after the peer reset the connection. It can be discarded by local destruction before it reaches the lower layer.

Close also has two layers. Calling `socket.end()` schedules an orderly writable-side finish. Calling `socket.destroy()` marks JavaScript state as destroyed and starts handle teardown. libuv close callbacks run after the lower handle has closed. Node then emits `close` at the JavaScript layer.

That is why close timing sometimes feels delayed. The JavaScript object can enter destroyed state before the native handle has finished closing. The `close` event is the later observation that the handle teardown completed from Node's perspective.

`TCPWrap` is worth naming with restraint. It is an internal object outside the public API. Stack traces, diagnostics, and native code references can expose the name. Treat it as a debugging landmark. Keep application logic on the public contract: `net.Server`, `net.Socket`, events, stream methods, and documented options.

There is one more wrinkle: a `net.Socket` can exist before its native handle is fully useful. A socket created with `new net.Socket()` has JavaScript stream state immediately. The lower connection work begins after `connect()`. A socket accepted by a server arrives already connected. A socket created by `net.connect()` is created and connected as part of one helper call. Same class. Different lifecycle entry points.

That means `net.Socket` methods need to handle several states:

```text
created
connecting
connected
ending
closed
destroyed
```

Those names are a practical reading model rather than a promise about exact internal field names. The public flags and events expose enough of it: `connecting`, `pending`, `destroyed`, `closed`, `readyState`, `connect`, `end`, and `close`.

`readyState` can help during debugging. It reports string states such as `opening`, `open`, `readOnly`, `writeOnly`, and `closed`. Use it for diagnostics. Events and explicit protocol state usually produce cleaner application code.

The internal path also explains why a socket error can arrive after the operation that caused it. JavaScript writes bytes. Native code submits a write. The kernel later reports failure. libuv delivers completion. Node emits `error`. The original function returned long ago. That is normal asynchronous I/O, but sockets make it visible because the peer can change state at any point.

If you remember one native fact, remember this one: `net.Socket` is a stream facade around a lower handle whose state can change independently of the JavaScript call stack.

## Before and After `listen()`

`net.Server` is the JavaScript server object. It stores connection listeners, close state, address state after binding, and a native handle after the lower socket exists.

```js
const server = net.createServer(socket => {
  socket.end('ok\n');
});

console.log(server.address());
server.listen(0, '127.0.0.1');
```

Before the bind completes, `server.address()` returns `null`. The bound socket address is absent. After the server starts listening, `server.address()` returns an `AddressInfo` object for TCP servers.

```js
server.on('listening', () => {
  console.log(server.address());
});
```

`AddressInfo` is the small object Node returns for a TCP server address: `{ address, family, port }`. For an IPv4 loopback bind, it might print `{ address: '127.0.0.1', family: 'IPv4', port: 41891 }`. If you bind to port `0`, the OS chooses the port and `server.address().port` is the value your client needs.

`server.listen()` is the method that binds the server to an endpoint and starts accepting. For TCP, it takes a port and optional host, or an options object. The call can complete asynchronously because Node crosses into native code and the OS can reject the bind.

```js
const server = net.createServer();

server.on('error', err => console.error(err.code));
server.listen({ host: '127.0.0.1', port: 3000 });
```

Bind errors surface through the server's `error` event. `EADDRINUSE` means the requested local endpoint conflicts with existing socket state or platform rules. `EADDRNOTAVAIL` means the local address is unavailable in the current host or network namespace. Permission errors can appear for privileged ports or platform policy.

The success path emits `listening`.

```js
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  console.log(address.port);
});
```

The listen callback runs once the server is listening. It is equivalent to a one-time `listening` listener. At that point, the listening socket exists below JavaScript. The OS has claimed the endpoint. Incoming TCP handshakes can complete and wait for Node to accept them.

A listening socket is the OS socket state that accepts new connection attempts for a local endpoint. It has a protocol, address family, local address, local port, and listen state. It also participates in kernel queues that hold incoming connection work before user space accepts it. Backlog mechanics belong to Chapter 9.6, but the split belongs here: the server object is JavaScript; the listening socket is OS state.

The listen path is roughly:

```text
server.listen()
  -> create TCPWrap
  -> create libuv TCP handle
  -> create OS socket
  -> bind local address
  -> mark socket as listening
```

Node hides the system calls behind one method. The boundaries still leak through errors, address fields, and timing.

`server.listen()` has several overloads, and they all converge on the same lower operation. The numeric form is compact:

```js
server.listen(3000, '127.0.0.1');
```

The object form is easier to extend:

```js
server.listen({
  port: 3000,
  host: '127.0.0.1'
});
```

There is also a path form for local socket endpoints:

```js
server.listen('/tmp/nodebook.sock');
```

The TCP forms produce an `AddressInfo` object after binding. The path form returns the path string from `server.address()`. Your code should branch on the endpoint type when it needs to publish or log the address.

```js
const address = server.address();

if (typeof address === 'string') console.log(address);
else console.log(`${address.address}:${address.port}`);
```

That branch matters in libraries that support both TCP and local IPC. Treating `server.address()` as always having `.port` works in tests that use TCP, then breaks when a deployment uses a UNIX domain socket.

The listen callback is tied to successful listen setup rather than future connection health. A server can emit `listening`, run for an hour, then accept sockets that immediately reset because clients disconnect. The callback only means the listening endpoint was created.

The `error` event before `listening` often means startup failed. The process should usually fail fast or report a clear startup error.

```js
server.once('error', err => {
  console.error('listen failed', err.code);
});
```

After a server is listening, `error` can still surface for server-level failures. Per-connection failures belong on each `net.Socket`. A common mistake is handling `server.on('error')` and expecting it to catch all socket failures. Accepted sockets emit their own `error` events.

```js
net.createServer(socket => {
  socket.on('error', err => console.error(err.code));
}).on('error', err => {
  console.error('server', err.code);
});
```

Those two handlers cover different emitters. The server handler covers listen and server-handle failures. The socket handler covers one connection.

Binding to a host changes which local addresses can receive traffic:

```js
server.listen(3000, '127.0.0.1');
```

That listens on IPv4 loopback. Same-host clients can connect to `127.0.0.1:3000`. Remote machines need a non-loopback address on your host.

```js
server.listen(3000, '0.0.0.0');
```

That listens on all suitable IPv4 addresses for the current host or network namespace. The accepted socket later records the concrete local address the client reached. `server.address()` can report the wildcard bind address, while `socket.localAddress` reports the per-connection address.

Omitting the host asks Node and the OS to choose a default bind behavior. The exact result can involve IPv6 wildcard behavior and platform defaults. Use an explicit host while debugging. Numeric addresses remove DNS from the experiment.

## The Accept Path

A client connects. The kernel handles the TCP handshake. The listening socket becomes readable for accept purposes. libuv observes readiness. Node accepts the connection and creates a JavaScript socket.

The trace looks like this:

```text
incoming TCP handshake
  -> OS accepted connected socket
  -> libuv accept callback
  -> new TCPWrap
  -> new net.Socket
  -> server emits connection
```

A connection event is the server event Node emits when an inbound peer has been accepted and wrapped as a `net.Socket`. The callback passed to `net.createServer()` is registered as a listener for that event.

```js
const server = net.createServer();

server.on('connection', socket => {
  console.log(socket.remoteAddress, socket.remotePort);
});
```

By the time that listener runs, the connected socket exists. The lower TCP connection is established. The socket has a local endpoint and a remote endpoint. Node has created the JavaScript wrapper and attached stream state.

A connected socket is a socket with a peer endpoint. For TCP, it represents one established TCP connection with local and remote address fields, readable and writable state, kernel send and receive buffers, and TCP connection state below Node.

One listening server can accept many connected sockets:

```js
const sockets = new Set();

net.createServer(socket => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
}).listen(3000);
```

The set tracks JavaScript wrappers. The kernel tracks connected socket state. Each accepted TCP socket consumes its own lower socket handle. On Unix-like systems, that means another file descriptor. A busy server can run out of descriptors even though it has one `net.Server` object.

The accepted socket carries endpoint fields:

```js
net.createServer(socket => {
  console.log(socket.localAddress, socket.localPort);
  console.log(socket.remoteAddress, socket.remotePort);
}).listen(3000, '0.0.0.0');
```

`localAddress` and `localPort` describe your side of that connection. `remoteAddress` and `remotePort` describe the peer address reported by the TCP layer. If a proxy, NAT, or port forward sits in front, these fields describe the immediate TCP peer at this layer. Higher-level identity belongs to later chapters.

Data arrives as stream chunks:

```js
net.createServer(socket => {
  socket.on('data', chunk => {
    socket.write(chunk);
  });
}).listen(3000);
```

That is an echo server. It echoes bytes directly and leaves message parsing to your code. A `data` chunk is bytes read by Node from the socket receive path. TCP keeps byte order, while application message boundaries belong above TCP. One write from the client can arrive as several chunks. Several writes can arrive as one chunk. Chapter 9.3 owns the TCP byte-stream behavior; `node:net` exposes it directly.

Raw TCP protocols need framing above `net.Socket`. Framing is the application rule that says where one logical message ends and the next begins. Length prefixes, delimiters, fixed-size records, and parser state machines are common choices. The socket gives you bytes. Your protocol decides message boundaries.

Here is a delimiter parser kept intentionally small:

```js
let pending = '';

socket.on('data', chunk => {
  pending += chunk;
  const lines = pending.split('\n');
  pending = lines.pop();
});
```

That code is incomplete because it ignores encoding boundaries and unbounded memory growth. It still shows the mechanism: the parser stores leftover bytes or text across `data` events because chunk boundaries are read boundaries rather than protocol boundaries.

Buffers are usually safer for binary protocols:

```js
let pending = Buffer.alloc(0);

socket.on('data', chunk => {
  pending = Buffer.concat([pending, chunk]);
});
```

That has its own cost because `Buffer.concat()` copies. High-throughput parsers usually keep a list of chunks, track offsets, and copy only when a full frame needs contiguous storage. Chapter 2 already covered Buffer ownership and copying; `node:net` makes those costs show up on the hot path.

Pausing reads is also stream behavior, but the network consequence is lower. `socket.pause()` stops the JavaScript readable side from flowing. Data may still sit in Node buffers and kernel receive buffers. If the application stays paused and the peer keeps sending, TCP flow control eventually applies pressure through the receive window.

```js
socket.pause();

setTimeout(() => socket.resume(), 1000);
```

That pause changes local read behavior only. The peer sees slower progress or blocked writes through TCP pressure rather than a custom message.

Use `pause()` when a local parser or downstream consumer needs time. Use protocol messages when the peer needs semantic feedback. They solve different problems.

Accepted sockets can start reading immediately. If the server needs to perform setup before reading bytes, attach handlers early and pause deliberately.

```js
const server = net.createServer(socket => {
  socket.pause();
  setup(socket).then(() => socket.resume(), err => socket.destroy(err));
});
```

The socket exists while setup runs. The peer can already send bytes. Pausing keeps Node from emitting flowing `data` events before the setup code is ready, while lower buffers still have finite capacity. Long setup times need timeouts or early rejection.

Accepted sockets can outlive the server's listening socket.

```js
const server = net.createServer(socket => {
  socket.write('connected\n');
});

server.listen(3000);
```

If the listening server later closes, existing connected sockets can keep reading and writing until they end, error, or get destroyed. Server lifetime and connection lifetime are separate lifetimes because they wrap separate lower sockets.

## Client Sockets

Client code starts with a `net.Socket` before a remote peer is attached. `socket.connect()` starts the outbound connection attempt.

```js
import net from 'node:net';

const socket = new net.Socket();

socket.connect(3000, '127.0.0.1');
```

`socket.connect()` tells Node to connect the socket to a remote endpoint. For TCP, Node resolves hostnames when needed, creates or uses a TCP handle, asks the OS to connect, and emits `connect` after the lower connection is established.

Most code uses `net.connect()`:

```js
const socket = net.connect(3000, '127.0.0.1', () => {
  socket.write('ping\n');
});
```

The callback is a one-time `connect` listener. It runs after the socket is connected. Writes before connection are queued by Node and flushed after the connect succeeds, subject to errors and writable state.

The options form is clearer once you care about address selection:

```js
const socket = net.connect({
  host: 'example.com',
  port: 80,
  localAddress: '192.0.2.10'
});
```

`host` and `port` describe the remote endpoint request. `localAddress` constrains the local source address. The OS validates that local address against interface and route state. DNS lookup behavior belongs to Chapter 9.2, but the boundary matters here: a hostname must become at least one address before TCP can connect.

The options object also supports `family` and `lookup`. `family` constrains address family. `lookup` supplies a custom lookup function with the same basic shape as `dns.lookup()`.

```js
const socket = net.connect({
  host: 'localhost',
  port: 3000,
  family: 4
});
```

That asks for IPv4 results. It is a useful debugging switch when `localhost` resolves to both IPv6 and IPv4 and the server only listens on one family. The broader lookup-order behavior belongs to Chapter 9.2.

A custom lookup function is a sharp tool:

```js
net.connect({
  host: 'service.local',
  port: 9000,
  lookup: dns.lookup
});
```

That example passes the default lookup function explicitly. Real custom lookup functions usually add caching, metrics, overrides, or service discovery. Keep the contract tight. The connect path expects an address and family answer it can use for TCP.

Node can try connection candidates according to its lookup and connection logic. The full client-to-process path and connection racing details belong to Chapter 9.7. At the `net.Socket` level, your code receives one of two outcomes: `connect` or `error`.

```js
socket.on('connect', () => {
  console.log(socket.localAddress, socket.localPort);
  console.log(socket.remoteAddress, socket.remotePort);
});
```

After `connect`, endpoint fields are populated. The local port is often ephemeral. The local address usually comes from route selection unless you constrained it. The remote address may be a resolved numeric address rather than the hostname string you passed.

Connection failures surface as errors:

```js
socket.on('error', err => {
  console.error(err.code, err.address, err.port);
});
```

`ECONNREFUSED` means the destination rejected the connection attempt at the transport layer. `ETIMEDOUT` means the attempt timed out according to lower networking behavior. DNS errors such as `ENOTFOUND` can also appear when a hostname fails before TCP starts. The same event channel carries errors from several layers, so log the code and endpoint fields.

Writes before connect are legal because Node queues them:

```js
const socket = net.connect(3000, '127.0.0.1');

socket.write('hello before connect\n');
```

That can be convenient for small clients. It can also hide ordering mistakes. If the connect fails, the queued write has nowhere useful to go and the socket reports an error. For protocols with setup state, waiting for `connect` makes failures easier to read.

```js
socket.once('connect', () => {
  socket.write('HELLO\n');
});
```

That puts protocol start after transport establishment. The peer still may close immediately, but your local sequence is clear: connect first, then write.

Client sockets also have `readyState` and `pending` state worth logging during connection bugs:

```js
console.log(socket.pending, socket.readyState);
```

`pending` reports whether the socket is still waiting for connection. `readyState` reports readable and writable status at the stream layer. These fields are diagnostic helpers. They should support logs and assertions, while protocol state belongs in your own state machine.

The client socket emits `close` after the socket has closed. The `close` event may include a boolean argument that tells you whether an error happened before close.

```js
socket.on('close', hadError => {
  console.log({ hadError });
});
```

Treat `error` and `close` as different events. `error` reports a failure. `close` reports that the socket is closed. Many cleanup paths belong in `close` because it fires after normal end and after error paths.

## Writes Are Local Commitments

`socket.write()` accepts bytes into the socket's writable path. It can accept a string, `Buffer`, `TypedArray`, or `DataView`. Strings are encoded before they move into the lower write path.

```js
socket.write('hello\n');
socket.write(Buffer.from([0x6f, 0x6b, 0x0a]));
```

The return value is the stream backpressure signal. `true` means the writable side is below its configured threshold. `false` means the writable side has buffered enough that the producer should wait for `drain`.

```js
if (!socket.write(chunk)) {
  socket.once('drain', sendMore);
}
```

That signal is Node stream state. It is close to the socket path, but it is still local. A write returning `true` means Node accepted the chunk into its writable path. A write callback means the chunk has been flushed from Node's write queue to the lower layer. The peer may still have processed zero bytes.

The path has several holding areas:

```text
JavaScript call
  -> Node writable queue
  -> libuv write request
  -> kernel send buffer
  -> TCP transmission
```

The kernel send buffer is below Node. TCP may wait on peer receive-window space, congestion state, retransmission timers, route state, or interface availability. `socket.write()` gives you a local signal, then the network keeps going.

That distinction matters when you implement a protocol.

```js
socket.write('DONE\n', () => {
  socket.end();
});
```

The callback orders local operations. It makes Node ask to end after the write has moved through Node's write queue. It confirms local queue progress. If the peer protocol requires acknowledgment, the peer needs to send bytes back and your code needs to read them.

Node can batch chunks before they move downward. The public API keeps the contract simple: you write chunks, and the stream implementation decides how to stage them for native writes.

`cork()` and `uncork()` from Writable streams also work here:

```js
socket.cork();
socket.write('A');
socket.write('B');
socket.uncork();
```

That batches small writes in the stream layer until `uncork()`. TCP behavior below that point still depends on socket options and kernel state. Nagle and `TCP_NODELAY` belong to Chapter 9.6, so keep the local claim narrow: corking changes Node's writable buffering before bytes move lower.

The write callback order follows the chunks you submitted through the stream path. It is useful for freeing per-chunk memory or advancing a local send queue.

```js
socket.write(payload, err => {
  if (err) return onWriteFailure(err);
  release(payload);
});
```

The callback can receive an error when the write fails. A socket can fail between enqueue and completion, so callback code should accept that argument.

Large writes deserve their own care. Passing a 100 MiB Buffer to `socket.write()` asks Node to accept that memory into the stream path. Backpressure can tell you to stop after the call, but the allocation already happened. Streaming a large payload in chunks gives the runtime more room to apply pressure.

```js
source.on('data', chunk => {
  if (!socket.write(chunk)) source.pause();
});
socket.on('drain', () => source.resume());
```

That is the old-school pattern. `stream.pipeline()` usually gives cleaner error propagation when both sides are streams, but raw socket protocols often need parser state and protocol decisions between reads and writes.

`socket.write()` can also fail synchronously for invalid arguments or invalid local state. Network failures usually surface through `error` events or callbacks after lower state changes.

```js
socket.on('error', err => {
  if (err.code === 'EPIPE') console.error('write after close');
});
```

`EPIPE` usually means your code wrote after the peer or local stack closed the write path. `ECONNRESET` usually means a reset arrived from the peer or from lower network state. Timing decides where you see the failure. A peer can reset a connection, and your next write can be the call that discovers it.

Backpressure needs special care because `net.Socket` is both a stream and a network endpoint. If you ignore `false` from `write()`, Node can buffer more data in memory. If the peer stops reading, the kernel receive window can shrink and the local send path can stop making progress. Your JavaScript producer can outrun both the Node queue and the network.

Small tests hide that. Loopback is fast. Kernel buffers are generous. The process may finish before the pressure becomes visible. The same code can fall over against a slow client or a congested path.

The safe shape is ordinary stream code:

```js
function send(socket, chunks) {
  const queue = Array.from(chunks);
  const pump = () => {
    while (queue.length && socket.write(queue.shift())) {}
    if (queue.length) socket.once('drain', pump);
    else socket.end();
  };
  pump();
}
```

That snippet is intentionally too small to be a full helper. It shows the control point: stop producing when `write()` returns `false`, then resume on `drain`. The queue lives in the closure because `drain` calls `pump` with no arguments. Real code also needs cleanup, error handling, and protocol state.

## `end()` Sends Intent

`socket.end()` finishes the writable side of the socket. It can take a final chunk.

```js
socket.end('bye\n');
```

For TCP, a graceful end maps to the FIN path described in Chapter 9.3. Node queues the optional final data, then closes the write side. The peer can still send data until its own side closes. With the default `allowHalfOpen: false` behavior, Node usually ends the writable side after the readable side ends, giving you the common full-close behavior.

The readable side and writable side have separate events:

```js
socket.on('end', () => {
  console.log('peer ended writes');
});

socket.on('close', () => {
  console.log('socket closed');
});
```

`end` means the peer has finished sending data to you. `close` means the socket handle has closed. Data can still be pending between those moments depending on timing and state.

For simple request-response protocols, `end()` is often the right shutdown call:

```js
socket.write('result\n');
socket.end();
```

That sequence says: send these bytes, then finish our writable side. It preserves queued writes through the normal stream path. It gives TCP the chance to perform an orderly close.

Half-open behavior is where `node:net` exposes TCP detail. If you create a server with `allowHalfOpen: true`, Node leaves the writable side open after the peer ends its writable side.

```js
const server = net.createServer({ allowHalfOpen: true }, socket => {
  socket.on('end', () => socket.end('ack\n'));
});
```

The `end` event means the peer sent FIN. With `allowHalfOpen: true`, your code chooses when to send its own FIN by calling `socket.end()`. Chapter 9.3 explained half-open connections as TCP state. Here you see the Node option that exposes it.

Keep half-open support tied to a protocol reason. Most application protocols prefer a clear close after the response. A socket left writable after the peer has ended can keep descriptors, timers, and application state alive longer than intended.

The `finish` event belongs to the writable side. It fires when the writable stream has ended and all data has been flushed from the stream implementation.

```js
socket.end('done\n');
socket.on('finish', () => console.log('write side ended'));
```

`finish` is local writable-stream completion. `end` is peer readable-side completion. `close` is handle closure. The names are easy to mix up because they all show up near shutdown.

A simple server often needs all three:

```js
socket.on('end', onPeerEnded);
socket.on('finish', onLocalEnded);
socket.on('close', onClosed);
```

Those handlers observe different edges. If a bug report says "the socket ended," ask which event fired. The answer changes the root cause.

## `destroy()` Tears Down Local State

`socket.destroy()` closes the socket immediately from Node's point of view. It tears down the stream, closes the underlying handle, and discards queued writes still held by Node.

```js
socket.destroy();
```

Use it for failure paths, protocol violations, shutdown cuts, and cleanup after a timeout. It is the call that says local code is finished with this socket now.

You can pass an error:

```js
socket.destroy(new Error('bad frame'));
```

That error is emitted on the socket as part of teardown. The socket then closes. The pattern is useful when a parser detects invalid input and you want downstream listeners to receive a reason.

`destroy()` and TCP RST are related at the JavaScript API boundary, with the OS making the packet-level decision. Node requests local teardown. The OS decides what packets to send based on socket state, unread data, pending writes, platform behavior, and options. The practical result is the same for your code: queued userland writes can be dropped, the handle closes, and future reads or writes stop.

That makes `destroy()` the wrong call for normal protocol completion:

```js
socket.write('ok\n');
socket.destroy();
```

The write may still be in Node's queue when `destroy()` runs. The peer may receive nothing. Or it may receive partial bytes. Or it may receive the data and then a reset depending on timing. Code that cares about delivery through the local write path should use `end()` or wait for the write callback before teardown.

Failure paths are different:

```js
socket.on('data', chunk => {
  if (chunk.length > 1024) socket.destroy();
});
```

That code rejects input by closing the socket abruptly. It stops reading and writing for that peer and releases lower resources once close finishes.

Destroying twice is harmless in normal use. After a socket enters destroyed state, additional calls become no-ops. The `destroyed` property tells you the JavaScript stream state.

```js
if (!socket.destroyed) {
  socket.destroy();
}
```

The `closed` and `destroyed` state fields can be useful when debugging lifecycle bugs, but event ordering tells the cleaner story. `error` reports failure. `end` reports peer write-end. `timeout` reports inactivity. `close` reports final handle closure.

`destroySoon()` also exists. It is a legacy-ish socket method that ends the writable side after queued writes drain, then destroys the socket. Most new code reads cleaner with explicit `end()` for graceful completion and `destroy()` for failure. The explicit calls force you to choose the shutdown path.

There is also `resetAndDestroy()` for TCP sockets. It closes the connection by sending a TCP reset when possible, then destroys the stream.

```js
if (typeof socket.resetAndDestroy === 'function') {
  socket.resetAndDestroy();
}
```

Use that only when a reset is the protocol behavior you want. It is stronger than ordinary `destroy()` because it asks for a TCP reset path directly. On a pipe, Node throws `ERR_INVALID_HANDLE_TYPE`. The usable TCP states are connecting and connected; closed TCP sockets get destroyed with `ERR_SOCKET_CLOSED`. Normal servers rarely need it.

## The Event Timeline

The happy server path has a short timeline:

```text
server.listen()
  -> listening
  -> connection
  -> socket data
  -> socket end
  -> socket close
```

Real timelines branch. A client can reset. A parser can destroy. A timeout can fire. A write can discover a broken pipe. A server can stop accepting while connected sockets keep running.

For a client socket, the normal path is:

```text
socket.connect()
  -> connect
  -> data
  -> end
  -> close
```

Errors can occur before `connect`, after `connect`, during write, during read, or during close. Use one error handler per socket. Unhandled `error` events on EventEmitter instances still crash the process.

```js
socket.on('error', err => {
  console.error(err.code);
});
```

An `error` event is followed by `close` for socket failures. Put release logic that must always run in `close`. Put diagnosis and logging in `error`.

The `data` event is just one read mode. You can also use stream methods, `pipe()`, or async iteration.

```js
for await (const chunk of socket) {
  console.log(chunk.length);
}
```

That loop ends when the readable side ends or errors. It uses stream async iteration from Chapter 7. It still reads from the same lower socket receive path.

The server also has lifecycle events:

```js
server.on('listening', () => console.log('ready'));
server.on('close', () => console.log('closed'));
server.on('error', err => console.error(err.code));
```

`listening` means the listening socket is active. `close` means the server handle has closed. `error` means a server-level operation failed, often bind or listen setup.

Events are JavaScript observations translated from lower state. When timing is weird, inspect both: log socket events and inspect the host socket table with OS tools.

## Timeouts Report Inactivity

A socket timeout in `node:net` is an inactivity timer on the socket. It reports zero socket activity for the configured interval.

```js
socket.setTimeout(30_000);

socket.on('timeout', () => {
  socket.destroy();
});
```

The `timeout` event is a notification. Node leaves the socket open. Your code decides what to do. Most servers destroy idle raw sockets after the event because an idle connected socket still consumes memory, a lower handle, and protocol state.

The timer resets on socket activity. Reads and writes count as activity. The exact activity accounting belongs to Node's stream and socket implementation, so treat it as idle detection rather than a protocol deadline.

```js
const server = net.createServer(socket => {
  socket.setTimeout(10_000);
  socket.on('timeout', () => socket.end('idle\n'));
});
```

That sends a final message and ends gracefully. It can still hang if the peer stops reading and your final write cannot make progress. A hard idle policy often uses `destroy()` after timeout. A polite protocol can try `end()` and then set a second timer for destruction.

Timeouts on outbound connection attempts are a separate design topic. `socket.setTimeout()` can detect inactivity while connecting, but retry budgets, cancellation, AbortController, and request deadlines belong to later chapters. For raw `net.Socket` code, remember the local rule: the timeout event fires; Node leaves close policy to your code.

The common bug is a handler that logs and leaves the socket alive:

```js
socket.setTimeout(60_000);
socket.on('timeout', () => console.warn('idle socket'));
```

That code records the idle state and keeps the descriptor open. Under load, those sockets accumulate. If the intent is cleanup, perform cleanup in the handler.

## Local Socket Endpoints

`node:net` also supports local socket endpoints. On Unix-like systems, that means UNIX domain sockets. On Windows, that means named pipes.

A UNIX domain socket is a local IPC socket addressed by a filesystem path. It uses socket APIs and stream semantics, but traffic stays on the same host. The address is a path rather than an IP address and port.

```js
import net from 'node:net';

const path = '/tmp/nodebook.sock';

net.createServer(socket => {
  socket.end('local\n');
}).listen(path);
```

For a UNIX domain socket server, `server.address()` returns the path string. `AddressInfo` is a TCP address shape, so the local socket path is returned directly.

Clients connect with the same path:

```js
const socket = net.connect('/tmp/nodebook.sock');

socket.on('data', chunk => {
  process.stdout.write(chunk);
});
```

The JavaScript socket still behaves as a Duplex stream. The lower endpoint is local IPC. Permissions, path cleanup, and OS limits become the common failure points.

Stale socket path files cause local development bugs. If a Unix server crashes after binding a path, the filesystem entry may remain. A later `listen(path)` can fail because the path already exists.

```js
import fs from 'node:fs';

try { fs.unlinkSync('/tmp/nodebook.sock'); } catch {}
server.listen('/tmp/nodebook.sock');
```

That cleanup pattern is common in examples, but production code should avoid blindly unlinking a path owned by another live process. A safer startup checks whether something is listening there before removing stale state. Full IPC design and supervisor behavior belong later.

Windows named pipes use a pipe name instead of a filesystem socket path:

```js
const pipe = '\\\\.\\pipe\\nodebook';

net.createServer(socket => {
  socket.end('pipe\n');
}).listen(pipe);
```

A Windows named pipe is a local named IPC endpoint. Node exposes it through the same `net.Server` and `net.Socket` shapes where possible. The naming rules and security model are Windows-specific.

Local socket endpoints are useful for same-host services, sidecars, test fixtures, and supervisor-managed daemons. They avoid TCP port allocation and remote network exposure. They still need lifecycle cleanup, permissions, and timeout policy.

Use TCP when the endpoint must be reachable by IP address and port. Use a local socket or named pipe when both peers are on the same host and you want an OS-local endpoint. IPC handle passing is a separate topic and belongs to Chapter 14.

## Closing the Server

`server.close()` stops the server from accepting new connections. Existing connected sockets keep their own lifecycle.

```js
const server = net.createServer(socket => {
  socket.write('still alive\n');
});

server.listen(3000, () => {
  server.close();
});
```

After `server.close()`, the listening socket is closing or closed. New clients cannot connect through that server. Accepted sockets that already exist can continue until they end or get destroyed.

The close callback runs when the server has closed:

```js
server.close(err => {
  if (err) console.error(err.code);
  else console.log('server closed');
});
```

If the server was never open, the callback receives an error. The `close` event has zero error argument. Use the callback when code needs to distinguish "closed normally" from "close requested while already closed or never started."

Tracking sockets is your job when shutdown requires connection cleanup:

```js
const sockets = new Set();

const server = net.createServer(socket => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});
```

That set gives your code a way to end or destroy accepted sockets after closing the listener.

```js
server.close(() => console.log('listener closed'));

for (const socket of sockets) {
  socket.end();
}
```

That is a local shutdown sketch. Production draining needs deadlines, readiness changes, supervisor contracts, HTTP semantics, and deployment behavior. Chapter 31 owns that. The `node:net` fact is smaller: closing the server stops accepts; connected sockets remain separate objects.

Connection ownership should be explicit in raw `net` servers. Frameworks often hide this by owning the request lifecycle. A `node:net` server gives you the socket and steps away.

The simplest ownership rule is: the code that accepts the socket also registers the socket's terminal handlers.

```js
const server = net.createServer(socket => {
  socket.on('error', logSocketError);
  socket.on('close', () => sockets.delete(socket));
  sockets.add(socket);
});
```

Register `error` immediately. A socket can fail before your parser finishes setup. Register `close` immediately too, because every path should release tracking state in the same place.

Per-socket state usually belongs next to the socket:

```js
const state = { bytes: 0 };

socket.on('data', chunk => {
  state.bytes += chunk.length;
});
```

That state dies with the socket. If a shared map tracks it, delete from the map in `close`. If a timer tracks it, clear the timer in `close`. If a parser holds buffers, drop references in `close`. The lower handle is gone by then, and the application state should stop retaining memory for that peer.

Timers are easy to leak:

```js
const timer = setInterval(() => socket.write('.'), 1000);

socket.on('close', () => clearInterval(timer));
```

The interval keeps a reference to the socket through the callback. Missing `close` cleanup lets JavaScript keep trying to write to a dead socket and retain state that should have disappeared. The socket API leaves that ownership with your code.

Backpressure state also needs a terminal path. If a producer is paused because `socket.write()` returned `false`, a socket error should resume or destroy that producer intentionally. Otherwise the producer may wait forever for a `drain` event that will never fire.

```js
socket.on('error', err => {
  source.destroy(err);
});
```

That line is application-specific, but the pattern is general: connect the socket lifecycle to the lifecycle of whatever feeds it and whatever consumes it. Raw TCP code has fewer abstractions, so ownership bugs show up as retained Buffers, open descriptors, stuck producers, and sockets that keep a process alive.

The distinction is easy to observe:

```js
const server = net.createServer(socket => {
  server.close();
  socket.write('connected after close call\n');
});
```

The accepted socket can still write because it is a connected socket with its own handle. The server's listening handle is the part being closed. The connection callback already received a different socket.

Repeated close calls can produce errors depending on timing and server state. Treat close as a state transition. Own it with a flag if several parts of a program can request shutdown.

```js
let closing = false;

function stop() {
  if (closing) return;
  closing = true;
  server.close();
}
```

That small guard saves noisy shutdown logs. It also documents ownership: one path moves the server from accepting to closing.

## One Local Trace

A compact server and client can show the whole object path without DNS or remote routing.

```js
const server = net.createServer(socket => {
  socket.end('pong\n');
});

server.listen(0, '127.0.0.1');
```

That creates the server object, then binds a TCP listening socket on IPv4 loopback with an OS-selected port. The port is unknown until the listen operation completes.

```js
server.on('listening', () => {
  const { port } = server.address();
  const client = net.connect(port, '127.0.0.1');
});
```

The client connect call starts after the server reports `listening`. It targets the exact port the OS selected. The numeric address keeps hostname lookup out of the path.

The event order is usually:

```text
server listening
client connect starts
server connection
client connect
client data
client end
client close
```

The exact interleaving around `connection` and client `connect` depends on scheduling. Both represent state that already crossed below JavaScript. The server accepted a connected socket. The client established its connected socket.

Add logs to make the lower identities visible:

```js
server.on('connection', socket => {
  console.log('server local', socket.localPort);
  console.log('server remote', socket.remotePort);
});
```

The server's accepted socket has a local port equal to the listening port. Its remote port is the client's ephemeral port.

The client sees the mirror:

```js
client.on('connect', () => {
  console.log('client local', client.localPort);
  console.log('client remote', client.remotePort);
});
```

The client's local port is ephemeral. Its remote port is the server's listening port. Same TCP connection. Different local view.

Now add cleanup:

```js
client.on('close', () => {
  server.close();
});
```

The client closes after reading the server's `pong\n` and receiving the peer's FIN. Then the server closes the listening socket. The accepted socket has already gone through its own close path. Server close now only needs to close the listener.

That trace has three socket objects at different layers:

```text
server listening socket
server accepted socket
client connected socket
```

JavaScript has one `net.Server` and two `net.Socket` objects. The OS has one listening socket and one TCP connection represented from both endpoint perspectives inside the same host stack. Loopback keeps the path local, but the socket state split is the same shape as a remote connection.

The trace also shows why raw TCP tests should use port `0`. The OS picks a free port. The test reads it after `listening`. The client connects to that value. Parallel runs avoid a fixed global port.

One more version makes the failure path visible:

```js
const client = net.connect(9, '127.0.0.1');

client.on('error', err => {
  console.error(err.code);
});
```

Port `9` is usually closed on local machines. The likely result is `ECONNREFUSED`. That error belongs to connect establishment. Accept never occurred. A `data` event cannot follow from that client attempt.

Change only the address family and the result can change:

```js
net.connect(3000, '::1')
  .on('error', err => console.error(err.code));
```

If the server listens on `127.0.0.1`, that client targets IPv6 loopback and can fail even while the IPv4 listener is healthy. The port number matches. The socket address differs. Address family is part of the endpoint.

The same trace works for a UNIX domain socket with a different endpoint shape:

```js
const path = '/tmp/nodebook-trace.sock';

const server = net.createServer(socket => socket.end('pong\n'));
server.listen(path);
```

The server address is now a path string. The accepted object is still a `net.Socket`. The lower handle is a local pipe/socket endpoint instead of TCP. Code that only needs stream reads and writes barely changes. Code that logs endpoint details must handle the different address shape.

## Debugging the Object Boundary

The fastest way to debug raw socket code is to log the transition that changed ownership.

For a server, log bind result and accepted endpoint data:

```js
server.on('listening', () => console.log(server.address()));
server.on('connection', socket => {
  console.log(socket.localAddress, socket.remoteAddress);
});
```

For a client, log connect result and errors:

```js
socket.on('connect', () => console.log(socket.address()));
socket.on('error', err => console.error(err.code));
socket.on('close', hadError => console.log({ hadError }));
```

`socket.address()` returns the local address for a TCP socket, again as an `AddressInfo` object. It is the client-side partner to `server.address()`. The remote fields live on the socket as `remoteAddress`, `remotePort`, and `remoteFamily`.

When a server never receives `connection`, check the listener first. Confirm the address family the client uses. Confirm whether the server is bound to loopback while the client runs outside that namespace. Check whether `server.listen()` emitted an error. Inspect the host socket table for the port.

When a client never reaches `connect`, separate name lookup, route selection, and TCP establishment. Use a numeric address to remove DNS. Log `err.code`, `err.address`, and `err.port`. Check whether the server is listening on the same family and address.

When writes appear to vanish, inspect the close path. A write followed by `destroy()` can drop queued data. A write callback confirms local queue progress rather than peer processing. A protocol acknowledgment has to come from bytes read back from the peer.

When idle sockets pile up, inspect timeout handlers. `setTimeout()` emits an event. It leaves policy to your code. A timeout handler that only logs is a leak under steady traffic patterns.

Raw `node:net` code is small because Node already did the wrapping work. The hard part is remembering which object owns which state. `net.Server` owns accepting. `net.Socket` owns one conversation. TCPWrap and libuv bridge those JavaScript objects to the event loop. The OS owns the actual socket state. Once that split is clear, the API stops looking magical and starts looking inspectable.
