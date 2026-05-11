---
title: "Full Request Path from Client to Process"
date: "2026-05-11"
excerpt: "Trace a Node connection from hostname lookup through routing, TCP connect, accept queues, libuv readiness, JavaScript callbacks, and the boundary before HTTP."
category: "Network Fundamentals with Node.js"
tags: ["nodejs", "networking", "tcp", "sockets", "libuv"]
author: "Ishtmeet Singh @ishtms"
chapter: "networking"
subchapter: "request-path-client-process"
published: true
toc: true
---

A client call returns a `net.Socket` before the connection exists. The object can hold listeners and queued writes while Node resolves the name, chooses an address, asks the OS for a route, allocates a local endpoint, and waits for TCP setup.

```js
import net from 'node:net';

const socket = net.connect(3000, 'api.internal');

socket.on('connect', () => {
  socket.write('ping\n');
});
```

The call creates JavaScript state first. The object can have listeners. It can queue a write. It can emit an error. The connected TCP socket arrives later, after name resolution, address selection, route lookup, local endpoint allocation, and the TCP handshake.

The outbound connection path is that client-side sequence from a Node connect request to a connected socket. It includes the JavaScript object, Node's native socket path, libuv, the OS resolver path when `dns.lookup()` semantics are used, the routing table, the kernel socket table, and the remote peer's answer.

The server has its own path.

```js
import net from 'node:net';

net.createServer(socket => {
  console.log(socket.remoteAddress, socket.remotePort);
  socket.end('pong\n');
}).listen(3000, '0.0.0.0');
```

The inbound accept path is the server-side sequence from an arriving SYN to the JavaScript `connection` callback. The packet reaches an interface. The kernel matches it to a listening socket. TCP state advances. A completed connection waits in the accept queue. libuv observes readiness. Node accepts the connection, wraps the connected descriptor, and emits the event.

Two paths. One connection.

Keep the shape narrow:

```text
client JS
  -> lookup
  -> address selection
  -> route and local address
  -> TCP connect
  -> server SYN/accept queues
  -> libuv watcher
  -> server JS callback
```

The trace is the whole point of this subchapter. Earlier chapter pieces become one path here. DNS success gives you candidate addresses. It gives you no guarantee that any address accepts a TCP connection. TCP success gives you a byte stream. It gives you no guarantee that the peer speaks the protocol your application expects. And the address the server sees may differ from the address the client process used if NAT, a proxy, or a load balancer sits between them.

Short JavaScript blocks from here use the surrounding `net`, `server`, or `socket` variable when the import or setup would repeat the previous example. They isolate the operation being discussed.

## Outbound: Hostname to TCP Socket

`net.connect()` accepts a host and a port. With a hostname, Node has to resolve addresses before the kernel can connect.

```js
const socket = net.connect({
  host: 'example.com',
  port: 80,
});
```

The hostname is application input. The kernel connect path needs a remote socket address: an IP address, a port, and an address family. Node gets there through lookup behavior covered earlier in this chapter. The short version is enough here: `dns.lookup()` style resolution uses the OS resolver path, and the result ordering depends on Node options, OS resolver behavior, and the address records returned.

Once Node has candidate addresses, it needs a local endpoint. Local address selection is the OS decision that chooses the source IP address for an outbound connection. It is based on the destination address, address family, routes, configured interfaces, and any explicit `localAddress` supplied by your code.

```js
const socket = net.connect({
  host: 'example.com',
  port: 80,
  localAddress: '192.168.1.20',
});
```

The option narrows the source address. The OS still has to accept it as a local address in the right family and with a route that can reach the destination. If the address is absent, bound to the wrong interface, or unusable for that destination, the connection fails before the remote server has any say.

Most client code leaves `localAddress` unset. Then the route lookup drives source selection. The kernel checks the routing table for the destination IP. The chosen route points at an output interface or a next hop. The local address usually comes from that interface. The kernel also picks an ephemeral port, creating the client-side socket address.

The TCP stack now has enough state to send a SYN:

```text
remote address: 93.184.216.34:80
local address:  192.168.1.20:52744
protocol:       TCP
state:          connecting
```

The exact local port varies. The exact source address depends on host configuration. In a container, the source may be a container-side address first, then rewritten later by NAT. On a laptop with VPN active, the selected route may use a tunnel interface. Node owns none of those policies. Node asks for a connection; the OS constructs the local endpoint.

The JavaScript object moves through states that mirror lower state without exposing every lower transition. Before connect completes, writes can queue inside Node. If the TCP connection succeeds, the socket emits `'connect'`. If the lookup or connect path fails, the socket emits `'error'`.

Several pieces of state now exist at once:

```text
JavaScript net.Socket
  -> native TCP wrapper
  -> libuv TCP handle
  -> kernel socket table entry
  -> route-selected local endpoint
  -> remote endpoint candidate
```

The JavaScript object is the one your code can hold. The native wrapper is the bridge into Node's C++ side. The libuv handle joins the socket to event-loop I/O readiness. The kernel socket table entry owns the protocol state and the local descriptor. The route-selected local endpoint is the source address and port the kernel will put on outgoing packets. The remote endpoint candidate is one resolved address plus the requested port.

Those states can fail at different times.

Allocation can fail before DNS if the process cannot create more descriptors. Lookup can fail before any socket reaches the remote network. A connect attempt can fail after the kernel created a local socket but before the peer accepted anything. A successful connect can still lead to an immediate close if the server accepts and then rejects the application-level session.

`socket.pending` exposes one small part of that state from JavaScript:

```js
const socket = net.connect(3000, '127.0.0.1');

console.log(socket.pending);
socket.on('connect', () => console.log(socket.pending));
```

While the connection is in progress, the socket is pending. After connect, it is a live connected stream. If an error happens during lookup or connect, the socket never becomes useful for reads and writes. Your error handler gets the result of the failed path, and cleanup follows.

The outbound path also decides the address family before the kernel can build the socket call. IPv4 and IPv6 use different socket families below Node. A hostname can yield both, so Node may create different connection attempts for different families. An explicit numeric host skips DNS but still goes through route lookup and local endpoint selection.

```js
net.connect(5432, '::1');
net.connect(5432, '127.0.0.1');
```

Those calls target different loopback addresses in different families. A server listening only on IPv4 loopback will not receive the IPv6 connection. A dual-stack listener may receive both, depending on OS socket options from the previous subchapter. The client-side path has to match the server-side bind shape.

Explicit local ports are rare, but they expose another stage:

```js
net.connect({
  host: '127.0.0.1',
  port: 3000,
  localPort: 40000,
});
```

Now the client is asking for a specific local port instead of letting the kernel choose one. That can fail if another socket already uses the same local tuple or if the platform rejects the reuse pattern. Outbound clients usually leave `localPort` alone because ephemeral port selection is exactly the kernel job you want here.

Local address selection gets noisy on hosts with more than one route.

A developer laptop might have Wi-Fi, loopback, a VPN tunnel, and a container bridge. A cloud VM might have a primary interface, an extra private interface, and IPv6 on only one of them. A container might have a small interface view that maps through host networking rules. The same `net.connect()` call runs against the route table visible to the process. Move the process to another network namespace, and the visible route table can change even though the JavaScript code is byte-for-byte identical.

The route lookup starts from the destination candidate. For a public IPv4 destination, the default IPv4 route may choose the Wi-Fi interface. For a private corporate address, a VPN route may win. For `127.0.0.1`, loopback wins. For `::1`, IPv6 loopback wins. The local address follows that choice unless code pins `localAddress`.

Pinned local addresses can be useful in tests and multi-homed systems, but they turn route selection into an explicit contract. Pin an address that belongs to the wrong interface and the connect fails. Pin an IPv4 address while the chosen remote candidate is IPv6 and the families do not match. Pin an address that exists on the host but lacks a route to the destination, and the failure can look like a connect problem even though the bad decision was local.

```js
net.connect({
  host: '2001:db8::10',
  port: 443,
  localAddress: '192.168.1.20',
});
```

The call mixes an IPv6 remote address with an IPv4 local address. The OS cannot build one TCP socket with those two families. Node reports the failure through the connect path because the request never becomes a valid outbound socket.

The local endpoint also affects server-side logs after middle boundaries. Without NAT or proxying, the server sees the client's selected source address and ephemeral port. With NAT, the server sees the translated tuple. With a proxy, the server sees the proxy tuple. Local address selection is still real on the client, but it may disappear from the backend's socket view.

For debugging, log before and after connect with different labels:

```js
const socket = net.connect({ host, port });

socket.on('connect', () => {
  console.log('selected local', socket.address());
});
```

Here, `host` and `port` are the endpoint values for the operation you're tracing.

The log line is available only after connect because the kernel has selected the final local tuple by then. Before connect, your code has intent. After connect, the socket has assigned state.

At the end of a successful outbound path, the connected socket has a four-tuple:

```text
local address
local port
remote address
remote port
```

For TCP, that tuple identifies the connection inside the host's TCP state. Many client sockets can connect to the same remote address and port because each gets a different local port. Many remote clients can connect to one server port because each connection has a different remote endpoint. The listening socket owns the local listen address and port. Accepted sockets own full connected tuples.

```js
const socket = net.connect(80, 'bad.invalid');

socket.on('error', err => {
  console.error(err.code);
});
```

A failed name lookup commonly reports `ENOTFOUND`. A temporary resolver failure can report `EAI_AGAIN`. Those errors belong before TCP. No SYN went to the application server because Node never obtained a usable destination address.

Different failure:

```js
const socket = net.connect(9, '127.0.0.1');

socket.on('error', err => {
  console.error(err.code);
});
```

If no process is listening on that port, the connection commonly reports `ECONNREFUSED`. That is a connect-stage failure. The address existed. The route was local. TCP reached a host stack that rejected the connection for that port.

Timeouts sit in another place. A connect timeout means the client waited long enough without a successful connection. The reason may be packet loss, a firewall that drops traffic, routing failure, a remote host that never answered, or some middle system that absorbed the attempt. The error location is "connect path did not complete." The cause still needs evidence.

## Address Racing

Resolved addresses are candidates, not a plan.

A hostname can produce IPv6 and IPv4 addresses. A client that tries only the first address can wait on a broken path while another address family would have connected quickly. Address ordering influences the first attempt, but ordering alone gives weak behavior when one family is partially broken.

Happy Eyeballs is a client connection strategy that races address families or address candidates with short delays so one slow or failing path does not stall the whole connection. The common shape is: try an IPv6 candidate, wait a small delay, then try an IPv4 candidate too if the first path has not completed. The winner becomes the connection. The loser is closed or abandoned.

A connection race is the overlap between multiple in-flight connection attempts where the client commits to the first successful attempt and tears down the rest. The race is about connection establishment, not DNS record ordering. DNS provides candidates. The connection logic decides how aggressively to try them.

Node's low-level `net` module has evolved here. In modern Node, connection attempts can use auto-selection behavior for multiple addresses depending on options and defaults. The exact timing knobs are API-level details, but the mechanism is stable enough to reason about: Node may have more than one candidate address, and it may attempt more than one connect before it emits the final result.

Address racing changes debugging.

```js
const socket = net.connect({
  host: 'localhost',
  port: 3000,
});
```

On one machine, `localhost` may resolve to `::1` before `127.0.0.1`. On another, IPv4 may come first. If your server listens only on `127.0.0.1`, an IPv6 attempt to `::1` can fail while the IPv4 attempt succeeds. The final application behavior may look fine, with a small delay. A trace can show a refused IPv6 attempt followed by a successful IPv4 connection.

The reverse happens too. A service may listen on IPv6 only. The client may try IPv4 first and then recover through IPv6. Or one address may route through a VPN while another uses a local network. The name is the same. The path differs.

Failures become aggregated or staged. One address can produce `ECONNREFUSED`, another can time out, and another can succeed. The error JavaScript sees depends on the policy that collected those attempts. Treat a final connect error as the outcome of candidate selection plus connection attempts, not as proof that one specific DNS answer failed in isolation.

The practical rule is simple enough: log the selected local and remote addresses after connect.

```js
socket.on('connect', () => {
  console.log(socket.address());
  console.log(socket.remoteAddress, socket.remotePort);
});
```

`socket.address()` shows the local address after the OS picked it. `remoteAddress` and `remotePort` show the peer address for the connected socket. With address racing, those values tell you which candidate won.

Node also has to decide what to do with the attempts that lose. A losing attempt may still be in progress when the winning attempt connects. Node closes or abandons the losing handle so the application sees one connected socket. The loser can still create lower traffic: a SYN may have left the host, a refusal may have come back, or a timeout may be pending. The API result hides most of that because the application asked for one connection.

Hidden work can show up in packet captures and server logs. A dual-stack server may see a short-lived attempt on one address family and then the real session on another. A firewall may log blocked IPv6 attempts while the application works over IPv4. A local test may pass but still spend time on a doomed first candidate.

The timing is deliberately small. A long delay would recreate the user-visible stall Happy Eyeballs is meant to avoid. A zero-delay full fanout would create more network noise and more connection churn. Modern client behavior usually uses staggered attempts. The exact delay is a policy knob, but the mechanism is the same: overlap enough to avoid waiting too long on a bad path.

Failure reporting gets less tidy when every candidate fails. Some APIs report the last error. Some aggregate. Node's low-level behavior depends on the connect options and version. The stable reading discipline is to separate candidate generation from candidate connection. A resolver failure means no useful candidates. A connect failure means at least one candidate existed. A raced connect failure may summarize several failed candidates.

One small script makes the difference visible on machines where `localhost` resolves to both families:

```js
import net from 'node:net';

const socket = net.connect(3000, 'localhost');

socket.on('error', err => console.error(err.code));
socket.on('connect', () => {
  console.log(socket.remoteFamily, socket.remoteAddress);
});
```

`remoteFamily` tells you which family won. If the server binds only to `127.0.0.1`, a successful output of `IPv4 127.0.0.1` says the IPv4 path won or recovered. If the server binds only to `::1`, an IPv6 result says the opposite. Localhost tests become less mysterious when you print the family.

## Inbound: SYN to `connection`

The server path starts before JavaScript sees anything.

```js
const server = net.createServer(socket => {
  console.log('accepted', socket.remoteAddress);
});

server.listen(3000, '0.0.0.0');
```

`listen()` creates a listening socket in the kernel, with Node and libuv handles attached above it. From that point on, incoming TCP attempts are kernel state first. The JavaScript callback is stored. It waits.

An inbound accept path for a normal TCP connection looks like this:

```text
client SYN
  -> server network interface
  -> IP and TCP receive path
  -> listening socket match
  -> TCP handshake completion
  -> accept queue
  -> readiness notification
  -> libuv I/O watcher
  -> accept loop
  -> JavaScript connection callback
```

A readiness notification is the kernel's signal to the event system that a file descriptor can make progress on an operation such as accept, read, or write. The notification does not carry your application data into JavaScript. It says the descriptor has a state worth handling.

An I/O watcher is libuv state that registers interest in readiness for a file descriptor or platform equivalent. For a TCP server, libuv watches the listening socket for readable readiness because a readable listening socket means there are completed connections to accept.

When the kernel completes the TCP handshake, the new connected socket waits in the accept queue. The listening socket becomes readable from the event system's point of view. libuv receives the readiness notification during the event loop's I/O processing. Node's native TCP server callback runs. It accepts one or more pending connections and wraps each accepted descriptor as a `net.Socket`.

The accept loop is that native loop that drains available completed connections from the listening socket until the kernel reports that no more are immediately available or Node reaches its per-iteration limits. The loop exists because readiness can mean "at least one connection is available." Several may be waiting.

The detail matters under load. A connection spike can fill the completed accept queue faster than JavaScript callbacks run. The backlog from the previous subchapter controls part of that capacity, with platform caps and separate SYN queue behavior below it. Once the accept queue is full, new handshakes may be delayed, reset, or dropped depending on OS policy and network conditions.

JavaScript sees the result after the native accept work:

```js
server.on('connection', socket => {
  console.log(socket.localAddress, socket.localPort);
  console.log(socket.remoteAddress, socket.remotePort);
});
```

At callback time, the socket already has local and remote endpoint metadata. It also already consumes a descriptor. If the callback immediately destroys the socket, the connection still existed. The process accepted it and then closed it.

`server.maxConnections` and application-level admission checks live above the accept path. They can close or refuse work after a connection is accepted by the process. They do not change the kernel's decision to complete the TCP handshake. That distinction shows up in metrics: a server can accept connections and close them immediately while clients report resets or early EOFs.

The listening socket and accepted sockets keep separate lifetimes.

```js
const sockets = new Set();

const server = net.createServer(socket => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});
```

Closing the server stops future accepts. Existing accepted sockets remain open unless your code ends or destroys them. During shutdown, a process often calls `server.close()` to stop the inbound accept path, then drains or terminates the connected sockets it already owns.

The inbound path has another hidden split: TCP handshake completion and JavaScript admission are separate events.

The kernel can complete a handshake and place the connection in the accept queue before Node has run your callback. From the client's point of view, `connect` can succeed during that window. From the server application's point of view, no JavaScript has accepted the connection yet. The OS has accepted it on behalf of the listening socket. Node still has to pull it out of the queue and create the JavaScript wrapper.

The split explains a common load-test pattern. Clients report successful TCP connects. The server reports fewer application-level accepts than expected at the same timestamp. The missing interval can be accept queueing, event-loop delay, process CPU, descriptor pressure, or application logging lag. The TCP layer and the JavaScript layer are coupled, but they are not one timestamp.

Descriptor pressure hits here too. Each accepted TCP connection consumes a descriptor in the process. If the process is near its descriptor limit, accept can fail even though the listening socket is readable. Node may emit an error on the server or close accepted state depending on where the failure occurs. The client may see a reset or close after handshake. The lower fact is simple: the kernel had a connection, and the process could not attach all required user-space state cleanly.

The accept loop can also interact with JavaScript work already queued. A burst of completed connections can produce many `connection` events. Each callback can attach listeners, allocate buffers, start timers, and add the socket to application structures. If the callback does heavy synchronous work, the event loop spends less time returning to I/O readiness. The kernel keeps accepting packets, queues fill, and the next batch of callbacks arrives later.

Lean connection callbacks help for that reason.

```js
const server = net.createServer(socket => {
  socket.setNoDelay(true);
  socket.on('error', logSocketError);
  handOff(socket);
});
```

Here, `logSocketError` and `handOff` are application functions.

The callback sets socket policy, attaches failure handling, and hands the socket away. It does not parse a large configuration file, run CPU-heavy authentication, or block on synchronous filesystem work. Higher protocols may require more work soon after accept, but the accept callback itself should stay small when connection volume matters.

`pauseOnConnect` exposes one more useful boundary:

```js
const server = net.createServer({ pauseOnConnect: true }, socket => {
  socket.resume();
});
```

With `pauseOnConnect`, accepted sockets arrive paused. Node has accepted the descriptor and created the `net.Socket`, but readable data will not flow into JavaScript until the socket resumes. Process managers and handoff patterns can use that to transfer sockets or attach setup before data events start. The TCP connection already exists. The read side is held at the Node stream boundary.

## The Readiness Path Inside Node

The deep part sits between the kernel and the JavaScript callback.

libuv does not ask the kernel to run JavaScript. It registers native interest in file descriptor readiness and then reports readiness to Node-owned callbacks inside the event loop. The operating system event API differs by platform: Linux commonly uses epoll, macOS and BSD use kqueue, Windows uses IOCP with different completion semantics. libuv hides that platform split behind handles, watchers, and callbacks that Node can build on.

For a server socket on Unix-like systems, the listening descriptor is watched for readability. Readability on a listening socket means `accept()` can return a connected descriptor without blocking. libuv keeps a watcher associated with the TCP handle. When the event loop reaches the poll provider and the kernel reports the descriptor readable, libuv runs the native connection callback associated with that handle.

Node's native TCP server code then calls into libuv accept machinery. The accept path pulls a connected socket from the kernel. Node creates the native wrapper for the accepted socket, associates it with a JavaScript `net.Socket`, initializes stream state, and emits the JavaScript event through the server object. That emission uses the EventEmitter mechanics already covered in Chapter 7. The networking-specific part is the lower handoff: readiness becomes accept, accept becomes a descriptor, the descriptor becomes a wrapped stream.

Reads follow the same readiness pattern with different work. A connected socket becomes readable when the kernel receive buffer has bytes or when TCP state changes in a way the read path must surface, such as peer shutdown. libuv receives readability. Node asks for bytes. The kernel copies bytes into a buffer supplied by the runtime path. Node pushes those bytes through the `net.Socket` readable side. Your `'data'` listener or async iterator sees chunks.

Chunk shape belongs to the stream and read path, not to TCP segment boundaries. One TCP segment can contribute to several JavaScript chunks if reads are small. Several TCP segments can become one chunk if bytes have accumulated. Application protocols that need message boundaries have to parse bytes above TCP. Chapter 10 owns HTTP parsing. For raw `net.Socket` code, your protocol code owns framing.

Writes start in JavaScript and move downward. `socket.write()` puts bytes into Node's writable path. If Node can hand them to libuv and the kernel accepts them into the socket send buffer, the write progresses. If user-space buffering grows past the stream threshold, `socket.write()` returns `false` and later `'drain'` tells you the writable side has room again. TCP flow control and kernel send buffers sit below that JavaScript signal, so a local `true` from `write()` means "accepted by the local writable path," not "read by the peer."

Shutdown is readiness too. A peer FIN eventually becomes end-of-stream behavior on the readable side. A peer RST usually surfaces as an error or abrupt close. A local `socket.end()` asks Node to finish writes and send a graceful TCP close. A local `socket.destroy()` tears down local state more aggressively. The TCP chapter owns the state machine. The path trace here is enough: lower TCP state changes become readiness, libuv reports them, and Node translates them into stream events.

The translation has latency. If JavaScript is running CPU-heavy code, the kernel can keep receiving packets and filling buffers while callbacks wait. Readiness has been recorded, but the event loop has to get back to I/O processing before Node can run the handler. That is one reason networking bugs can look like remote slowness when the process is actually busy above libuv.

The watcher model also explains why a single tick can process several accepts or reads. Readiness says work is available. Native code may loop until it would block. Then control returns upward. JavaScript callback order still follows Node's event loop rules, but the supply of work came from lower descriptor state.

Level-triggered and edge-triggered readiness are kernel event API details, and libuv smooths them into its own behavior. The operational consequence is still visible: when readiness fires, native code should drain enough work that the descriptor state no longer needs immediate service. If it leaves work sitting, the event provider may report readiness again. If it drains too much in one pass, other handles can wait longer. Runtime code balances those concerns with per-handle loops and event-loop iteration boundaries.

JavaScript code only sees the final scheduling point. A `'data'` event can mean the kernel had data ready earlier. A `'connection'` event can mean the handshake completed earlier. A `'drain'` event can mean user-space buffering dropped below the threshold after lower writes progressed. The callback time is the JavaScript observation time, not the network event time.

The distinction becomes clear when a process is CPU-bound:

```js
server.on('connection', socket => {
  const start = Date.now();
  while (Date.now() - start < 200) {}
  socket.end('late\n');
});
```

Clients can complete TCP handshakes while the server is stuck in that loop from a previous callback. The kernel can queue them. libuv can only deliver their JavaScript callbacks after control returns. A network trace shows packets on time. Application logs show late accepts. Both are true.

## Data After Both Sides Connect

After connect and accept, both processes have connected sockets. The path becomes byte movement plus state changes.

```js
const socket = net.connect(3000, '127.0.0.1');

socket.write('one\n');
socket.write('two\n');
```

The peer may receive one chunk, two chunks, or a different split. TCP carries a byte stream. Node streams expose chunks produced by reads from that byte stream. Write call boundaries are application events on the sender, not protocol boundaries on the receiver.

```js
server.on('connection', socket => {
  socket.on('data', chunk => {
    console.log(chunk.toString());
  });
});
```

The `chunk` is a Buffer from Node's read side. It contains bytes that were available when Node read. If your protocol uses newline-delimited messages, length prefixes, or fixed-size frames, parsing belongs in your code. TCP gives ordered bytes. It does not give application messages.

Backpressure crosses layers here. The receiving process can stop reading from the `net.Socket`, either directly with `pause()` or indirectly because downstream work slows down. Node's readable-side buffering grows. The kernel receive buffer may fill. TCP flow control can reduce the sender's usable window. On the sending side, `write()` may start returning `false` as Node's writable buffering grows.

```js
if (!socket.write(payload)) {
  socket.once('drain', sendMore);
}
```

Here, `payload` is the next bytes from your protocol code, and `sendMore` is the continuation that resumes production after Node reports writable room.

The code handles Node stream pressure. It does not inspect the peer's receive buffer. It gives the local process a sane production rule: stop adding bytes when the writable side says it is backed up, then resume on `drain`.

Reads can also surface connection teardown.

```js
socket.on('end', () => {
  console.log('peer finished writes');
});

socket.on('close', hadError => {
  console.log({ hadError });
});
```

`'end'` means the readable side saw the peer's orderly finish. `'close'` means the socket handle closed. The two events answer different questions. One is about incoming byte stream completion. The other is about local resource teardown.

Errors fit the same path. `ECONNRESET` usually means the peer reset the connection or an intermediate device generated reset behavior. `EPIPE` can happen when code writes after the peer has closed enough state that the local write cannot continue. The exact surfacing depends on timing, platform, and which operation observed the failure.

The useful debugging move is to place the error in the path. Resolver error. Connect error. Accepted-then-closed. Read error. Write error. Idle timeout. Reset. Those are different investigations.

One more byte-path detail matters for request protocols: the first application bytes may arrive before your callback has finished setup.

TCP permits the client to send data immediately after the connection establishes. On the server, the kernel can receive those bytes and hold them in the socket receive buffer before JavaScript attaches every listener. Node stream state controls when data flows upward. If the socket is in flowing mode because a listener was attached, data events can fire quickly. If the socket is paused, bytes stay buffered until code reads or resumes.

Normal behavior.

```js
server.on('connection', socket => {
  socket.pause();
  queueMicrotask(() => socket.resume());
});
```

The pause does not stop the peer from sending. It stops Node from emitting readable data to your JavaScript code until resume. The kernel receive buffer can still fill. TCP flow control can still push back on the sender if the process waits too long. The pause is an application-side flow decision, not a network admission decision.

For servers that hand sockets into protocol parsers, the order is usually: accept, attach error and close handling, attach parser or stream pipeline, then resume if needed. Missing the error handler can crash a process if an `'error'` event fires unhandled. Missing the parser setup can drop bytes only if code actively consumes them without parsing. Node's stream buffering protects the common setup window, but careless flowing-mode code can still make a mess.

## One Connection, Two Observation Points

A client and a server do not observe the same connection at the same instant.

Client code observes its outbound socket. Server code observes an accepted socket. The kernel and network observe packets and TCP state between those two JavaScript objects. A successful client `'connect'` event and a server `'connection'` event are related, but neither callback is a distributed timestamp.

Use a tiny pair:

```js
const server = net.createServer(socket => {
  console.log('server accepted');
  socket.end('ok\n');
});
```

The server callback fires after the kernel has already completed the accept path and Node has wrapped the descriptor. It is late relative to the TCP handshake. It is early relative to any application protocol parsing.

```js
const socket = net.connect(3000, '127.0.0.1');

socket.on('connect', () => {
  console.log('client connected');
});
```

The client callback fires when the client-side connect path completes. The server process may already have accepted the socket, or the connected socket may still be sitting in the server's accept queue waiting for Node to process readiness. Both cases can produce a successful client connect.

Add first-byte logging:

```js
socket.on('data', chunk => {
  console.log('client read', String(chunk));
});
```

Now the trace has three application observations: client connected, server accepted, client read. The network path has more events underneath: SYN sent, SYN-ACK received, ACK sent, accept queue insertion, libuv readiness, write into server send buffer, packet transmission, client receive readiness, JavaScript data event. Logs from the two processes can interleave in several valid orders because scheduling on each side is independent.

Interleaving affects request latency analysis. A slow "request" can spend time before connect, during connect, in the server accept queue, waiting for server JavaScript, waiting in the server write path, crossing the network back, or waiting for client JavaScript to read. Higher-level timing usually compresses those into one duration. Raw socket tracing lets you split them.

For a raw TCP service, you can mark the boundary where the connection became usable:

```js
socket.on('connect', () => {
  socket.write('hello\n');
});
```

The write happens after the client connect event. The peer may receive bytes before its application code is ready to parse them because the kernel receive buffer sits below JavaScript. Node stream buffering then controls upward delivery. Nothing in TCP says "the server callback finished setup." TCP only says the connection state can carry bytes.

Servers that expect a first message immediately after connect should set up reads before doing optional work. The order matters:

```js
server.on('connection', socket => {
  socket.on('data', onData);
  socket.on('error', onError);
  startSession(socket);
});
```

The handlers exist before `startSession()` runs. If `startSession()` performs synchronous work, data may still wait in Node or kernel buffers, but the socket has an error path and a read path attached. For protocols with strict first-message timeouts, start the timeout after accept and clear it after enough bytes arrive.

```js
server.on('connection', socket => {
  const timer = setTimeout(() => socket.destroy(), 5000);
  socket.once('data', () => clearTimeout(timer));
});
```

The timer measures application-level first-byte arrival at the server process. It does not measure DNS, route selection, the client TCP handshake, or the server accept queue before the callback. If you need those, you need client-side timestamps, server-side accept timestamps, and sometimes kernel or proxy data.

A load balancer adds another pair of observation points. The client may connect to the balancer, then the balancer connects to the backend. The backend's accept timestamp measures the second TCP connection, not the original client connection. If the balancer waits for backend selection, health state, or a free upstream connection, the client can see connect success while the backend still sees nothing. Later HTTP chapters will name the headers and proxy behaviors. At this layer, the relevant fact is connection splitting.

The same split explains why `remoteAddress` can be correct and still incomplete. It is correct for the immediate TCP peer. It can be incomplete for the user or device that started the request several boundaries away. Treat it as socket truth, not identity truth.

Connection lifetime has two observation points too. The client can call `end()` and believe it finished writes. The server may still have unread bytes in its receive buffer. The server can call `end()` and the client may read the final bytes later. A reset can erase pending delivery. Logs that say "closed at 10:00:00.100" on one side and "read at 10:00:00.120" on the other side can both be plausible when clocks, buffers, and scheduling differ.

For local debugging, keep a compact timeline:

```text
client lookup start
client connect start
client connect event
server connection event
server first data
client first data
client close
server close
```

You rarely need every line in production logs. During a local failure, this sequence shows which part of the path disappeared. Missing client connect points at lookup/connect. Missing server connection points at routing, bind, firewall, backlog, or middle boundaries. Missing server first data points at client writes, buffering, or early close. Missing client first data points at server write path, peer close, or response-side routing.

## Middleboxes Change What Each Side Sees

The direct path is the cleanest path to explain. Production paths often add systems between client and server.

NAT, or Network Address Translation, rewrites packet addresses or ports as traffic crosses a boundary. A client process may bind a local address such as `10.0.0.20:52744`, while the server sees a different source such as `203.0.113.7:61002`. The connection is still TCP end to end across the translated path, but the visible address tuple changes at the boundary.

Address rewriting matters for logs.

```js
server.on('connection', socket => {
  console.log(socket.remoteAddress, socket.remotePort);
});
```

Those fields show the peer address visible to the server's kernel. Behind NAT, that may be the translated address, not the original client host address. With raw TCP, Node cannot recover the pre-translation address unless some higher protocol or infrastructure passes it along. HTTP headers for forwarded addresses belong to later chapters.

A firewall is policy that permits, rejects, or drops traffic based on packet fields, connection state, process rules, or host configuration. For the Node process, firewall behavior often appears as a refused connection, a timeout, or traffic that reaches one direction and fails in the other. The observed error depends on whether the firewall actively rejects or silently drops.

Proxy boundaries change ownership more sharply. A proxy boundary is a network hop where a client connects to an intermediate process, and that process creates or manages a separate connection toward the next destination. The client TCP connection ends at the proxy. The server-side TCP connection begins from the proxy or from another proxy layer. HTTP proxying, CONNECT, and reverse proxy behavior are Chapter 10 material. The boundary name is enough here because it explains why the remote address on the backend is the proxy address.

A load balancer boundary is a hop where traffic enters a balancing system before it reaches one backend process. At the TCP level, the balancer may pass through connections, terminate and create new ones, or use platform-specific forwarding. Load balancing algorithms belong much later. For this path trace, the relevant facts are smaller: the backend may see the balancer as the peer, the client may connect to an address that belongs to the balancer, and connection failures can occur before the backend process receives anything.

Source addresses can also change more than once. A laptop behind home NAT connects to a cloud load balancer. The load balancer forwards to a backend. The backend Node process sees the balancer-side address. The application-level client address, if needed, has to be carried above TCP by a protocol or side channel with clear trust rules.

Those boundaries also affect timeouts. A client-side timeout may come from the client's own timer. A load balancer may close idle connections. A firewall may drop state for idle flows. A backend may destroy sockets during shutdown. The same JavaScript error code can sit after different lower events, so timing and address evidence matter.

NAT also creates state outside both endpoint processes. A translator has to remember how an internal tuple maps to an external tuple. Idle mappings can expire. After expiration, later packets may be dropped or mapped differently. Long-lived TCP connections usually rely on real traffic, TCP keep-alive, or application-level pings to keep middle state alive. TCP keep-alive was covered in the previous subchapter; here it belongs as a path fact: a connection can die because middle state disappears while both endpoint processes still have socket objects.

Firewalls add a different kind of ambiguity. A reject policy sends a response that the client stack can turn into a quick error. A drop policy produces silence, so the client waits until its timeout or TCP retransmission policy gives up. Both policies can protect the same port. The client error timing tells you which behavior is more likely.

Proxy boundaries break endpoint assumptions. The backend server sees the proxy's TCP connection. The original client may be represented only inside protocol metadata, and that metadata has to be trusted according to the deployment boundary. Raw TCP has no standard field for "original client." Some proxy protocols add one before the application bytes. HTTP uses headers in many deployments. Those belong later. The network-level conclusion is already enough: `socket.remoteAddress` is the immediate TCP peer.

Load balancer boundaries can hide backend absence. A client can connect to the balancer while no healthy backend is available. The client-side TCP connection may succeed, then the balancer may close, reset, or hold the connection depending on product behavior and protocol mode. From the backend Node process, no connection event fires because the connection never reached it. From the client, the remote endpoint was reachable. The failure sits at the balancer-to-backend boundary.

Middleboxes can also change MTU behavior, reorder routes, or apply idle policies. Those details get platform-specific fast. Keep the debug question smaller: identify the TCP peer your process actually connected to, then identify the boundary that could have changed the tuple before it arrived.

## Placing Errors on the Path

Error codes are more useful when they sit on a stage.

DNS stage:

```js
net.connect(80, 'missing.invalid')
  .on('error', err => console.error(err.code));
```

`ENOTFOUND` means the name did not resolve to a usable answer. `EAI_AGAIN` points at a temporary resolver failure. Both happen before a TCP socket connects to the target service. Fixing server listen code will not fix these.

Bind stage:

```js
net.createServer().listen(3000);

net.createServer()
  .on('error', err => console.error(err.code))
  .listen(3000);
```

`EADDRINUSE` means the local bind conflicted with existing socket state. `EADDRNOTAVAIL` means the requested local address is not available for binding in that host or namespace. These errors belong to server startup or explicit local client binding.

Connect stage:

```js
net.connect(65000, '127.0.0.1')
  .on('error', err => console.error(err.code));
```

`ECONNREFUSED` means the remote stack rejected the connection for that address and port. Common local repro: connect to a port with no listener. `ETIMEDOUT` means the connect path did not complete before the timeout policy fired. The cause can be routing, firewall behavior, packet loss, or an unresponsive endpoint.

Accept pressure:

There is no neat JavaScript error for "the accept queue was full for a moment." Clients may see timeouts, resets, or slow connects. Server logs may show fewer `connection` callbacks than incoming attempts. Local socket-table tools can show queue depths or many half-open states, depending on OS and permissions. The backlog chapter owns the queue details; the placement is enough here.

Read and write stage:

`ECONNRESET` usually lands during read, write, or idle handling after a connection existed. `EPIPE` usually lands when writing to a socket whose peer side has already gone away far enough for the local stack to reject the write. Timing matters. A reset can arrive while your code is doing unrelated work, then surface on the next read or write.

Close stage:

`'end'`, `'close'`, and `'error'` are separate signals. A clean peer FIN can produce readable end and then close. A reset can produce error and close. A local destroy can produce close with local intent. Treat close logs without endpoint addresses and socket state as weak evidence.

Timeout stage:

```js
socket.setTimeout(5_000, () => {
  socket.destroy(new Error('idle socket'));
});
```

`setTimeout()` on a socket is an inactivity timer at Node's socket layer. It is separate from TCP keep-alive probes and separate from a load balancer's idle timeout. When it fires, your callback decides what to do. Destroying the socket creates local teardown, which the peer may observe as an abrupt close depending on pending data and platform behavior.

The cleanest error report includes four fields: operation, local address, remote address, and stage. "connect to 203.0.113.10:443 timed out from 10.0.0.5" points at a different problem than "write to accepted socket reset after 12 minutes idle."

Here is the same placement as a compact table:

```text
stage        common signal
lookup       ENOTFOUND, EAI_AGAIN
bind         EADDRINUSE, EADDRNOTAVAIL
connect      ECONNREFUSED, ETIMEDOUT
accept       missing callback, reset, slow connect
read/write   ECONNRESET, EPIPE, unexpected close
idle         socket timeout, keep-alive failure, middlebox close
```

The table is not a taxonomy of every possible code. It is a starting position for the next command you run. Lookup errors send you to resolver configuration. Bind errors send you to local socket state. Connect errors send you to route, firewall, listener, and address-family checks. Accept pressure sends you to backlog, descriptor limits, CPU, and event-loop delay. Read/write errors send you to peer teardown and protocol state.

One code can move stages depending on timing. `ECONNRESET` during connect means the connection attempt got reset before becoming a usable stream. `ECONNRESET` during a write means a previously connected peer or middlebox reset the established connection. The code matches the packet-level reset. The operation tells you where your process observed it.

For raw `net.Socket` services, add stage context to logs close to the operation:

```js
socket.on('error', err => {
  console.error('socket error', {
    stage: socket.connecting ? 'connect' : 'connected',
    code: err.code,
  });
});
```

The tiny distinction prevents a lot of false leads. A connect-stage reset points at reachability or listener behavior. A connected-stage reset points at session lifetime, peer process behavior, or middle boundary teardown.

## Making the Path Visible

The fastest useful trace starts inside Node.

```js
const server = net.createServer(socket => {
  console.log('local', socket.localAddress, socket.localPort);
  console.log('remote', socket.remoteAddress, socket.remotePort);
});

server.listen(0, '127.0.0.1', () => {
  console.log('listen', server.address());
});
```

Port `0` asks the OS to choose an available port. `server.address()` prints the bound socket address after `listen()` succeeds. The accepted socket prints the endpoint tuple visible to the server.

Client side:

```js
const socket = net.connect(server.address().port, '127.0.0.1');

socket.on('connect', () => {
  console.log('client local', socket.address());
});
```

The output shows the ephemeral local port selected for the outbound connection. It also confirms the address family and source address the OS chose for that route.

On Linux, `ss` exposes kernel socket table state:

```bash
ss -tanp
```

The flags matter less than the fields at first. Look for local address, peer address, TCP state, and process ownership when permissions permit it. A listening socket appears with local address and port. Connected sockets show both endpoints. Many sockets in `TIME-WAIT`, `SYN-SENT`, or `ESTAB` place the process at different parts of the path.

Routing is visible too:

```bash
ip route get 93.184.216.34
```

The command asks the kernel which route it would use for a destination. On Linux, the output commonly includes the selected interface and source address. Compare that source with `socket.address()` after connect. If they differ because NAT happens later, the Node value still tells you what the local kernel chose.

For DNS, log both the name and the final socket endpoint. A resolved address list without a connected endpoint leaves out address racing and fallback. A connected endpoint without the original hostname loses the resolver context.

```js
socket.on('connect', () => {
  console.log({
    host: 'example.com',
    local: socket.address(),
    remote: `${socket.remoteAddress}:${socket.remotePort}`,
  });
});
```

Those fields are often enough for local debugging. Packet capture can confirm lower packet flow, but it adds volume fast and belongs in a narrower debugging task. Start with process logs, socket table state, route lookup, and the exact error stage.

A small end-to-end local trace can be more useful than a large framework test.

```js
const server = net.createServer(socket => {
  socket.end('ok\n');
});

server.listen(0, '127.0.0.1', connectBack);
```

The server listens on a kernel-chosen port. The callback runs after the bind and listen path succeeds. At that moment, `server.address()` has real data.

```js
function connectBack() {
  const { port } = server.address();
  const socket = net.connect(port, '127.0.0.1');
  socket.on('data', chunk => console.log(String(chunk)));
}
```

The client connects through loopback. The route, source address, remote address, connect, accept, read, and close all happen on one host. If this fails, the problem is inside local process or local socket state. If this works and the remote version fails, the difference is name resolution, routing, firewall policy, middleboxes, or remote listener state.

Add endpoint logging when the minimal case works:

```js
socket.on('connect', () => {
  console.log('client', socket.address());
  console.log('server', socket.remoteAddress);
});
```

For a real remote connection, pair those logs with `ss` while the socket is established. Process output tells you what Node wrapped. Kernel output tells you what the OS owns. Route output tells you how the host chose the path. The three views should line up before you start blaming the application protocol.

Containers add another namespace boundary. A process inside a container may see a different interface list, route table, and local address than the host. `127.0.0.1` inside the container is the container's loopback context. A host port mapping or bridge can rewrite the visible path. The raw Node code is the same, but the kernel context around it differs. Always run route and socket-table commands from the same network namespace as the process when possible.

When you cannot run host tools, log what Node can see: `server.address()`, `socket.address()`, `socket.remoteAddress`, `socket.remotePort`, and error codes with stages. Those values do not reveal every network boundary, but they make wrong assumptions visible.

There is one more useful distinction in local traces: listener reachability and protocol readiness.

A listening TCP socket can accept a connection before the application is prepared to handle the protocol cleanly. A process might be starting, warming caches, loading configuration, or waiting for a dependency. The port is open. The accept path works. The higher-level service may still be unable to answer meaningful bytes.

Raw TCP tooling will report success at the socket layer:

```js
const socket = net.connect(port, host);

socket.on('connect', () => {
  console.log('tcp ok');
});
```

Here, `host` and `port` are the exact endpoint under test.

The log proves the outbound and inbound TCP paths completed. It says the client picked a local endpoint, the route worked, the server accepted, and JavaScript saw a connected socket. It says nothing about the next parser, request handler, database call, or response rule.

Server-side readiness checks often blur this line. A port check verifies listener reachability. A protocol check verifies that the service can parse and answer a valid request. A dependency check verifies more of the application graph. Those checks belong to deployment chapters later, but the TCP boundary explains why they differ. One uses the path from this chapter. The others start after it.

For a raw service, a tiny protocol check can be just enough:

```js
socket.write('ping\n');
socket.once('data', chunk => {
  console.log(String(chunk));
});
```

Now the trace crosses the byte-stream boundary. The client has sent application bytes. The server has read them, applied some protocol rule, and written bytes back. Once you add meaning to `ping`, the discussion has left pure TCP and entered application protocol territory.

## The Boundary Before HTTP

After the inbound accept path completes, Node has a connected TCP byte stream.

The networking foundation stops there.

The stream may carry an HTTP request, a PostgreSQL startup packet, a Redis command, a custom binary protocol, or arbitrary bytes. TCP does not know. `net.Socket` does not know until code above it parses the bytes. The next chapter owns HTTP wire format, request semantics, parsing, agents, pools, proxies, and streaming bodies.

One last trace keeps the boundary honest:

```text
DNS resolved
  -> TCP connected
  -> socket accepted
  -> bytes readable
  -> protocol parser runs
```

Chapter 9 owns everything through "bytes readable on a connected socket." Chapter 10 starts when those bytes have HTTP meaning.
