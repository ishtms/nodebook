---
title: "Socket Options, Keep-Alive, Nagle, and Backlog"
date: "2026-05-11"
excerpt: "How Node exposes socket options for binding, keep-alive probes, Nagle behavior, buffer sizing, backlog pressure, and IPv4/IPv6 bind behavior."
category: "Network Fundamentals with Node.js"
tags: ["nodejs", "networking", "tcp", "sockets", "libuv"]
author: "Ishtmeet Singh @ishtms"
chapter: "networking"
subchapter: "socket-options-backlog"
published: true
toc: true
---

`EADDRINUSE` during a restart usually means the kernel rejected the bind. Node can create the server object, parse the listen options, and reach libuv successfully. 

The local address still belongs to the operating system's socket table.

```js
import net from 'node:net';

const server = net.createServer(socket => {
  socket.end('ok\n');
});

server.listen({ host: '127.0.0.1', port: 3000 });
```

Run a second copy while the first one is still listening. The second process asks the operating system for the same local socket address. The kernel socket table already has a listening TCP endpoint for `127.0.0.1:3000`, so Node emits an error with `code: 'EADDRINUSE'`.

That error comes from the bind path. Node created JavaScript state. libuv created or prepared a TCP handle. The OS made the final call when Node crossed the system call boundary. The option choices attached to that socket decide whether a bind can reuse an address, whether an IPv6 wildcard also covers IPv4, whether idle TCP probes run, how small writes are batched, and how many completed connections can wait before JavaScript accepts them.

A socket option is a setting attached to an OS socket. Some options apply before `bind()`. Some apply before `listen()`. Some apply after a TCP connection exists. The timing matters because the kernel reads different fields during different transitions.

JavaScript sees methods and options:

```js
server.listen({
  host: '::',
  port: 3000,
  backlog: 1024,
  ipv6Only: true
});
```

The OS sees a socket with protocol family, type, local address, local port, queue limits, and option bits. Node exposes a small subset because most socket options are platform-specific or too low-level for stable JavaScript APIs. The exposed subset still changes real network behavior.

For TCP servers, `server.listen()` accepts bind and listen options: `host`, `port`, `backlog`, `ipv6Only`, and, in current Node v24, `reusePort` on supported platforms. For accepted TCP sockets and outbound client sockets, `net.Socket` exposes methods such as `setKeepAlive()`, `setNoDelay()`, and `setTimeout()`. For UDP, `dgram.createSocket()` can take `reuseAddr`, `reusePort`, `ipv6Only`, `recvBufferSize`, and `sendBufferSize`, while the socket object exposes buffer setters after bind.

Those APIs sit at different layers.

`socket.setTimeout()` is Node-level inactivity notification. TCP keep-alive is transport-level probing. HTTP keep-alive is connection reuse at the HTTP client or server layer. The names overlap because they all involve idle connections, but the state lives in different owners. Chapter 10 owns HTTP keep-alive and connection pools. Here, keep the boundary lower: OS socket options and Node's direct wrappers around them.

## Where Options Attach

Socket options are state on a kernel socket object. Node reaches them through native code and libuv, usually with platform calls equivalent to `setsockopt()`. The JavaScript API rarely exposes that name because each platform has its own handles, constants, validation rules, and timing constraints.

Timing matters.

```text
create socket
  -> set pre-bind options
  -> bind local address
  -> set pre-listen options
  -> listen or connect
  -> set connected-socket options
```

Some options affect address ownership. They need to be present before `bind()`. `reuseAddr`, `reusePort`, and `ipv6Only` live in that category. If a socket already failed to bind because the option was absent, setting the option afterward leaves the failed bind decision unchanged. You create a new socket or call the API again in the sequence Node supports.

Some options affect listener queue behavior. `backlog` belongs to `listen()`, because the queue exists after the socket becomes a listening socket. Node's `server.listen()` passes the requested backlog at that transition. The OS clamps it to host limits.

Some options affect connected TCP behavior. `SO_KEEPALIVE` and `TCP_NODELAY` are meaningful for a TCP connection. A server usually sets them inside the `connection` callback because the accepted `net.Socket` exists there. A client can set them after `connect` starts, and the setting applies to the socket handle once the TCP path exists.

```js
const socket = net.connect(3000, '127.0.0.1');

socket.setNoDelay(true);
socket.setKeepAlive(true, 60_000);
```

That code is fine. The `net.Socket` object has a handle path before the `connect` event fires, so Node can apply the settings as the socket progresses. Errors still surface through the socket if the lower operation fails.

Server-side defaults can also live on `net.createServer()`:

```js
const server = net.createServer({
  noDelay: true,
  keepAlive: true,
  keepAliveInitialDelay: 60_000
}, socket => attachProtocol(socket));
```

Node applies those accepted-socket options after it receives a new incoming connection and before the listener callback runs. The callback form still fits per-connection policy: inspect the peer, then choose different timers or packet behavior for that socket.

UDP has a simpler lifecycle and stricter buffer setter timing in Node's public API. Creation options can request receive and send buffer sizes. Setter methods such as `setRecvBufferSize()` require a bound socket. That shape comes from Node's API contract, not from a universal law about every operating system.

The stable model is ownership, not method names. Bind options affect who can own a local endpoint. Listen options affect pending connection queues. Connected TCP options affect packet behavior and idle probing. Buffer options affect kernel memory attached to the socket.

Node also omits many options on purpose. TCP congestion-control selection, quick ACK behavior, corking details, packet marks, interface binding, and platform-specific flags exist below the API. Some can be reached by native addons, command-line tools, container settings, or host sysctls. Stable backend code should treat those as host policy unless the application has a measured need and a deployment contract for it.

Inherited sockets change the history. A process manager, systemd socket activation, a parent process, or a cluster primary can create a socket before your code sees it. In that setup, options may already be fixed. Calling `server.listen(handle)` starts from a handle that has existing kernel state. Your JavaScript still gets a `net.Server`, but the earliest option decisions happened outside the current call site.

That explains a class of bugs where the same code behaves differently under a supervisor than it does when run with `node server.js`. The process did not create the same socket path. Same JavaScript object. Different owner history below it.

The listen path is a compact example because several options have to land in a specific order.

```text
net.createServer()
  -> JavaScript server object
  -> server.listen(options)
  -> native TCP handle
  -> socket()
  -> setsockopt()
  -> bind()
  -> listen()
```

`net.createServer()` creates JavaScript state and stores the connection listener. The lower socket does not need to exist yet. When `listen()` runs, Node validates the options object, resolves the host path as needed, and enters the native networking path. libuv creates the TCP handle and asks the OS for a socket in the chosen family.

Pre-bind options are applied before the local endpoint is claimed. `ipv6Only` changes how an IPv6 wildcard bind behaves. `reusePort` changes whether this socket can join a group of sockets bound to the same endpoint. Node's default TCP `SO_REUSEADDR` handling also belongs in the setup path. The point is sequencing: the kernel's bind conflict check reads the option state that already exists on the socket.

`bind()` attaches the local address. The socket goes from "created TCP socket" to "TCP socket bound to this local endpoint." For `127.0.0.1:3000`, the endpoint is concrete IPv4 loopback. For `0.0.0.0:3000`, the endpoint is IPv4 wildcard. For `:::3000`, the endpoint is IPv6 wildcard, with dual-stack behavior controlled by platform defaults and `ipv6Only`.

`listen()` changes the bound TCP socket into a listening socket. That transition creates or configures the kernel state used for incoming handshakes and completed-connection queueing. The backlog argument lands here. The socket can now receive incoming SYN packets for that local endpoint.

Only after the OS accepts the listen transition does Node emit `'listening'`.

```js
server.on('listening', () => {
  console.log(server.address());
});
```

That callback means the lower listener exists. It does not mean the first client has connected. It also does not mean the advertised endpoint is reachable from another host. Reachability still depends on routing, firewalls, namespace boundaries, and external network policy.

The accept path runs later. libuv registers interest in readiness for the listening socket. When the OS reports completed connections waiting, Node accepts them, wraps each connected descriptor, creates a `net.Socket`, and emits `'connection'`.

```text
listening descriptor ready
  -> accept()
  -> connected descriptor
  -> net.Socket wrapper
  -> connection listener
```

Every accepted descriptor has its own socket options. Some inherit listener defaults by OS behavior; others need explicit per-connection calls. In Node code, assume accepted sockets need their own `setNoDelay()` and `setKeepAlive()` calls when those choices matter. The listener's bind options and the connected socket's packet options belong to different socket objects.

## Bind Reuse

`EADDRINUSE` names an address conflict. For TCP servers, the conflict usually means another listening socket already owns the requested local address and port in the same address family, or a wildcard bind already covers the address you requested.

```js
const a = net.createServer();
const b = net.createServer();

a.listen(3000, '127.0.0.1');
b.listen(3000, '127.0.0.1');
```

The second server fails because both listeners ask for the same IPv4 loopback socket address. The failure can occur even inside one process. The kernel compares bind requests against active socket state, not your deployment plan.

`EADDRNOTAVAIL` means the requested local address is unavailable on the host. That usually means the address is absent from all local interfaces in the active network namespace, or the address family and host string do not match usable local state.

```js
net.createServer().listen({
  host: '192.0.2.44',
  port: 3000
});
```

`192.0.2.44` is documentation address space. On a normal machine, the OS has no local interface with that address. The bind fails with an address-not-available style error. Node does not claim the address for you; it asks the OS to bind a socket to local state that must already exist.

Restart bugs get more confusing because TCP has teardown state. Chapter 9.3 covered `TIME_WAIT`; use that vocabulary here. A process may exit, the listening descriptor may close, and TCP connection state may still remain for recently closed connections. Address reuse options control which leftover state blocks a new bind.

`SO_REUSEADDR` is a socket option that permits some forms of local address reuse. On Node TCP sockets, Node sets `SO_REUSEADDR` for `net.Socket` handles. The practical result is that normal server restarts are less likely to be blocked by stale teardown state from earlier connections.

That does not mean two independent TCP servers can both receive the same address and port. An active listener still owns the endpoint. `SO_REUSEADDR` helps with reuse around closed or closing state under OS rules. It is restart plumbing, not a multi-process load distribution feature.

The deeper distinction matters on Linux because `SO_REUSEADDR` and `SO_REUSEPORT` solve different problems. `SO_REUSEADDR` relaxes address reuse checks. `SO_REUSEPORT` permits multiple sockets to bind the same address and port and lets the OS distribute incoming connections or datagrams across them.

Node exposes `reusePort` on `server.listen()` options for TCP servers in Node v24 when the platform supports it:

```js
server.listen({
  host: '0.0.0.0',
  port: 3000,
  reusePort: true
});
```

`SO_REUSEPORT` is the underlying socket option. With it enabled on each participating listener, several processes can bind the same TCP address and port. The OS chooses which listener receives each incoming connection. The distribution policy belongs to the OS.

Unsupported platforms raise an error when Node tries to use `reusePort`. Treat it as a platform capability. It is available on several Unix-like systems, including modern Linux and recent BSD variants, and absent or different elsewhere. Code that depends on it needs a startup check, not a comment saying every host works.

`reusePort` also differs from Node cluster's shared-handle model. Cluster can share one underlying handle between workers. `reusePort` creates several separate listening sockets. Chapter 14 owns cluster. For this chapter, the thing to keep visible is socket ownership: one shared kernel listener versus several kernel listeners with a reuse-port policy.

UDP has a related surface, and it is easier to get wrong because UDP has no accept step.

```js
import dgram from 'node:dgram';

const socket = dgram.createSocket({
  type: 'udp4',
  reuseAddr: true
});

socket.bind(41234);
```

For `node:dgram`, `reuseAddr: true` sets address reuse behavior for the bind. In Node v24 docs, `reuseAddr` permits binding even when another process already bound that address, but only one socket receives a given datagram. `reusePort: true` permits port reuse with OS distribution of incoming datagrams on supported platforms.

Multicast code often uses `reuseAddr` because several receivers may need to bind the same multicast port. The multicast group membership decides which traffic is relevant. Chapter 9.5 owns the group behavior. The option point here is narrow: address reuse does not create a user-space fanout contract. It changes the kernel bind rules.

Binding failures also depend on wildcard addresses. A listener on `0.0.0.0:3000` covers all suitable IPv4 local addresses. A second listener on `127.0.0.1:3000` may conflict because loopback is already included in the wildcard listener. The exact combination rules vary by OS and option state, especially around IPv6 dual-stack sockets.

Use exact bind logs.

```js
server.on('listening', () => {
  console.log(server.address());
});

server.on('error', err => {
  console.error(err.code, err.message);
});
```

The address printed after listening is the address the OS accepted. The error code printed on failure is the OS answer carried into JavaScript. For bind bugs, those two outputs beat guesses about which process "has the port."

On Linux, `ss -ltnp` shows TCP listeners. `ss -lunp` shows UDP sockets. The `Local Address:Port` column is the kernel view Node must satisfy. If the column shows `*:3000` or `[::]:3000`, that listener may cover more concrete addresses than the application log suggests.

Bind inputs combine quickly, but the useful checks are small.

```text
protocol: TCP or UDP
family: IPv4 or IPv6
local address: concrete or wildcard
local port: requested or ephemeral
reuse option: default, reuseAddr, or reusePort
```

Change any one field and the kernel may make a different decision. TCP and UDP have separate port spaces. IPv4 and IPv6 may be separate or coupled by dual-stack behavior. A wildcard address covers many concrete local addresses. Port `0` asks the OS to choose an unused port. `reusePort` changes multi-listener ownership where supported.

For TCP restarts, `TIME_WAIT` usually belongs to accepted connections rather than the listening socket itself. The old listener closed. Accepted connections may still have teardown state. `SO_REUSEADDR` lets the new listener bind in common restart cases because the conflict check can tolerate that leftover state. An active listener remains different; it has an open listening descriptor and receives new connection attempts.

For UDP, there is no accepted connected socket per peer by default. The bound datagram socket itself receives messages. That makes reuse semantics more visible. Two UDP sockets can bind the same address under reuse settings, but the OS still needs a delivery rule for each incoming datagram. `reuseAddr` and `reusePort` produce different delivery contracts in Node v24.

The startup handler should keep those cases separate:

```js
server.on('error', err => {
  if (err.code === 'EADDRINUSE') process.exitCode = 1;
  else throw err;
});
```

Retrying blindly can turn a configuration error into a slow boot loop. A retry may be reasonable during controlled restarts, when the previous process is still closing. A retry can obscure a real conflict when another service owns the port. Production process managers and deployment chapters own the policy. At socket level, `EADDRINUSE` says the local endpoint request lost.

`EADDRNOTAVAIL` deserves a different reaction. Retrying the same absent address rarely helps unless network interfaces are still coming up. Check the interface list available to the process. In containers, check inside the container namespace. The host's address list may be irrelevant to the process's namespace.

## Keep-Alive Probes

TCP keep-alive is a transport-level liveness probe for an idle TCP connection. It uses TCP packets generated by the OS after a connection has seen no traffic for a configured interval. The peer's TCP stack answers if the connection still exists. After enough unanswered probes, the local stack can mark the connection dead and surface an error or close.

`SO_KEEPALIVE` is the socket option that enables that machinery. In Node, `socket.setKeepAlive(true, initialDelay)` enables it for a `net.Socket`.

```js
server.on('connection', socket => {
  socket.setKeepAlive(true, 30_000);
});
```

The second argument is the initial idle delay in milliseconds before the first keep-alive probe. A value of `0` leaves the existing OS default or previous value in place. In Node v24, enabling keep-alive also asks the platform for Node's configured probe count and interval values where supported.

A keep-alive probe is a TCP-level packet sent on an idle connection to elicit an acknowledgment from the peer stack. It carries no application request. It does not ask your service whether the database works. It does not prove the next HTTP request will succeed. It proves only that the local TCP stack got enough lower-level response to keep treating the connection as alive.

That separation matters during idle network failures. A process can hold a TCP socket whose peer disappeared without a FIN or RST. Power loss, NAT state expiry, firewall drops, mobile network changes, and virtual network rewrites can all remove the path while leaving the local socket open. The local OS learns about the failure only after it tries to send data, receives an error signal, or runs a keep-alive sequence to failure.

TCP keep-alive is slow by default on many systems. Historical defaults often wait hours before the first probe. Node's `initialDelay` changes the first idle delay for the socket, but platform behavior still controls the full probe sequence. The number of probes, interval, and exact error timing depend on OS support and sysctl-style settings.

An idle timeout is a local timer that fires after no activity for some period. Node's `socket.setTimeout()` creates a Node-level idle notification. TCP keep-alive creates OS-level probes. They can be used together, but they answer different questions.

```js
socket.setTimeout(45_000);
socket.on('timeout', () => {
  socket.destroy();
});
```

The timeout event fires because Node observed inactivity for the configured period. Node does not close the socket automatically. Your handler chooses whether to `end()`, `destroy()`, or keep waiting. That makes `setTimeout()` good for application policy and poor as a statement about lower TCP state.

TCP keep-alive runs below JavaScript:

```js
socket.setKeepAlive(true, 45_000);
```

After the socket sits idle for the requested initial delay, the OS can send probes. If the peer stack answers, JavaScript may see nothing. Silence is the normal success path. If the probes fail according to the platform's rules, Node eventually receives an error or close path from the socket.

HTTP keep-alive lives higher. It means the HTTP layer keeps a TCP connection open for more than one request-response exchange. HTTP agents and connection pools decide when to reuse or retire those connections. A TCP socket can have `SO_KEEPALIVE` enabled while an HTTP agent also manages HTTP keep-alive. Separate layers. Separate timers.

The common production bug is mismatched idle policy. Your Node socket may wait minutes before TCP probes. A proxy or load balancer may drop idle flows sooner. A client may keep a pooled HTTP connection and write a new request into a path the network already forgot. Chapter 10 and later platform chapters own the pool and infrastructure policy. At the raw socket level, the fix starts by naming the timers: Node inactivity timeout, TCP keep-alive probe delay, and any external idle timeout.

Keep-alive also has cost. Every idle connection with probes enabled can generate periodic packets and kernel timer work. On a small service, that cost is small. On a server holding hundreds of thousands of mostly idle sockets, probe settings become capacity settings. Lower probe delays detect dead peers sooner and spend more network and CPU budget doing it.

Use keep-alive for stale TCP path detection. Use application messages for application health. A custom protocol that needs to know whether the remote application loop is responsive should send protocol-level heartbeats or deadlines. TCP keep-alive sees only the peer TCP stack.

There is also a failure timing gap between the last successful byte and the final error. Suppose a connection sits idle for 60 seconds. The local keep-alive delay expires. The OS sends a probe. A network device has already forgotten the flow and drops it. The OS sends more probes according to its configured count and interval. Only after the probe sequence fails does the socket transition into an error or close path visible to Node.

JavaScript sees the end, not every probe.

```js
socket.on('error', err => {
  console.error(err.code);
});

socket.on('close', hadError => {
  console.log({ hadError });
});
```

Depending on platform and timing, the code may be `ETIMEDOUT`, `ECONNRESET`, or another socket error. A close can also arrive with limited detail. Treat keep-alive failure as transport liveness failure, then reconnect or tear down according to the protocol policy.

Outbound clients often need keep-alive more than servers. A server can accept a fresh client later. A client holding a long-lived connection to a broker, database proxy, or custom TCP service may sit idle for long periods and then write into a dead path. TCP keep-alive helps the client discover stale paths before the next application write, though the detection still depends on timers.

Accepted server sockets need their own settings. Setting keep-alive on the listening server object is the wrong operation; the accepted `net.Socket` is the connected TCP socket.

```js
const server = net.createServer(socket => {
  socket.setKeepAlive(true, 120_000);
});
```

Each accepted connection gets its own OS socket. Each one needs its own keep-alive state. If the server handles long-lived idle clients, set it as part of connection initialization alongside protocol parser setup and timeout policy.

For one policy across every accepted TCP socket, the server factory can carry the defaults:

```js
const server = net.createServer({
  keepAlive: true,
  keepAliveInitialDelay: 120_000
}, socket => attachProtocol(socket));
```

That keeps common keep-alive setup near server construction. Connection callbacks still own protocol-specific deadlines, authentication state, and per-client overrides.

## Nagle and Small Writes

Small writes expose a throughput and latency tradeoff.

```js
socket.write('A');
socket.write('B');
socket.write('C');
```

JavaScript made three writes. TCP sends a byte stream. The kernel can combine bytes, delay transmission, or split them according to TCP state, buffer state, and socket options. The peer may receive one `data` event, several `data` events, or a chunk boundary unrelated to your write calls.

Nagle's algorithm is TCP send-side batching for small writes. When enabled, it tries to avoid sending many tiny TCP segments while earlier small data is still unacknowledged. It can hold new small data briefly so more bytes can be sent together after an ACK arrives or enough data accumulates.

`TCP_NODELAY` is the socket option that disables Nagle's algorithm. Node exposes it through `socket.setNoDelay()`.

```js
server.on('connection', socket => {
  socket.setNoDelay(true);
});
```

The method name is inverted because it names the option, not the algorithm. `setNoDelay(true)` disables Nagle. `setNoDelay(false)` enables Nagle. With no argument, Node uses `true`.

When a TCP connection is created, the underlying TCP stack starts with Nagle enabled. Node applications commonly call `setNoDelay(true)` for interactive protocols and HTTP paths where request or response latency matters more than tiny-segment reduction. Many Node internals and higher-level modules make that choice for you. Raw `net.Socket` code should make the choice explicit when small writes are part of the protocol.

Delayed ACK is the receive-side behavior that can wait briefly before sending an ACK, usually to combine acknowledgment with outbound data or reduce ACK traffic. It is a TCP stack policy, not a Node API. The exact timer is platform-specific.

Nagle and delayed ACK can interact badly. One side sends a small segment and waits for an ACK before sending more small data. The peer delays the ACK because it is waiting briefly to see whether it can combine acknowledgment with data. Latency appears even though both processes are alive, the network works, and no Node error fires.

The symptom in a raw protocol is a tiny request or partial response that seems to pause for tens or hundreds of milliseconds. Packet capture may show small segments and delayed acknowledgments. Application logs show gaps between writes and reads. CPU stays low. Backpressure may be absent because the amount of data is tiny.

One answer is `setNoDelay(true)`. Another is batching application writes yourself.

```js
socket.write('AUTH user\r\n');
socket.write('PASS secret\r\n');
socket.write('PING\r\n');
```

Those calls hand three small chunks to the socket path. With Nagle enabled, the kernel may batch. With Nagle disabled, the kernel can send sooner, subject to other TCP constraints.

```js
socket.write(
  'AUTH user\r\n' +
  'PASS secret\r\n' +
  'PING\r\n'
);
```

Now JavaScript hands one larger chunk to Node. You avoid some write-path overhead and reduce the chance of tiny-segment behavior without relying only on `TCP_NODELAY`. For a protocol parser, batching complete frames or commands is usually cleaner than issuing byte-sized writes.

There is no universal fastest setting. Disabling Nagle often helps latency-sensitive small messages. Keeping Nagle enabled can reduce packet count for chatty code that emits many tiny writes and tolerates a little delay. The right choice depends on protocol shape, RTT, message size, peer behavior, and whether the application already batches writes.

Backpressure remains separate. `setNoDelay(true)` changes small-write send timing. It does not give the peer more receive buffer space. It does not make a slow remote application read faster. Large writes and sustained throughput still hit Node stream buffering, kernel send buffers, TCP flow control, and congestion control.

One practical rule holds for raw TCP protocols: decide at connection setup, then measure with the real message pattern. Toggling `TCP_NODELAY` in the middle of a connection is legal, but it makes packet behavior harder to reason about. A server should usually set it once when accepting the socket and keep application batching rules visible in code.

`socket.cork()` and `socket.uncork()` may show up in nearby discussions because writable streams expose them. They are stream-level batching tools. They control how Node buffers writes before flushing them to the underlying resource. `TCP_NODELAY` controls TCP's Nagle behavior below that. The two can be used together, but they operate at different owners.

```js
socket.cork();
socket.write('header\r\n');
socket.write('body\r\n');
socket.uncork();
```

That code asks Node's writable stream machinery to group writes before sending them down. Once bytes reach the TCP stack, Nagle and `TCP_NODELAY` still affect small-segment behavior. Application batching should happen where the protocol knows frame boundaries; TCP batching happens where the kernel sees bytes and ACK state.

The bad version is accidental byte-by-byte writes from a parser or serializer:

```js
for (const byte of payload) {
  socket.write(Buffer.of(byte));
}
```

Even with Nagle disabled, that shape creates unnecessary JavaScript calls, stream operations, native transitions, and possible tiny packets. `setNoDelay(true)` can reduce waiting, but it cannot erase bad write granularity. Build the buffer or string for the protocol unit, then write it.

## Backlog and Accept Pressure

A TCP server has work below the `connection` event.

```js
server.listen({
  host: '0.0.0.0',
  port: 3000,
  backlog: 1024
});
```

The `backlog` value asks the OS to set a limit for pending connections. Node passes it into the listen path. The OS applies its own caps and internal queue rules. On Linux, settings such as `somaxconn` and `tcp_max_syn_backlog` can bound the result. Node's default backlog is 511 when you omit it.

Listen backlog is the requested maximum queue length for connections waiting below application accept. That phrase covers two different queues on common TCP stacks, so keep the path explicit.

```text
client SYN
  -> SYN backlog
  -> handshake completes
  -> accept queue
  -> libuv accept
  -> Node connection event
```

The SYN backlog holds half-open connection attempts. A SYN arrived. The server stack replied with SYN-ACK. The final ACK from the client has not completed the handshake path yet, or the kernel is still tracking the partially established attempt. The exact representation varies by OS, especially with SYN cookies and flood protection, but the role is the same: track handshake progress before a completed connection exists.

The accept queue holds completed TCP connections that the application has not accepted yet. The handshake is done. The kernel has enough state to create the connected socket. JavaScript has not received the `connection` event for that connection yet.

Node sits after both queues. libuv watches the listening socket for readiness. When the OS says the listener has completed connections available, Node's native path calls accept, gets connected socket descriptors, wraps them, and emits `connection` events with `net.Socket` objects.

That means a connection can be fully established before any JavaScript callback runs.

Under a connection spike, the queues absorb timing differences between network arrival and application accept. If handshakes arrive faster than the OS can complete or track them, the SYN backlog becomes pressure. If completed connections arrive faster than the process accepts them, the accept queue becomes pressure. If JavaScript accepts sockets and then stalls during per-connection setup, application memory and descriptor counts become pressure.

The `backlog` argument mostly concerns pending completed connections from the application point of view, but OS documentation and implementation details often blur the name across the listen path. Linux has distinct knobs for SYN backlog and accept queue behavior. Other platforms expose different limits. Node gives you one portable argument and leaves the rest to the host.

Queue overflow behavior is platform-specific. A TCP client may see connection timeout, connection reset, slower handshake completion, or success after retransmission. The server process may see nothing for dropped or incomplete attempts because no accepted socket reached JavaScript. Logs that start at the `connection` callback miss the lower queue behavior.

The accept path has a descriptor cost too. Every accepted TCP connection consumes a file descriptor in the Node process. A large backlog can let more completed connections wait below JavaScript, but it does not raise the process descriptor limit. If the process cannot accept because it is out of descriptors, increasing backlog only changes where pressure accumulates.

`server.maxConnections` is a Node-level connection count limit. It is higher than accept because Node must accept a connection before it can count it as a `net.Socket`. The server's `'drop'` event can report dropped connections when `maxConnections` is reached in modern Node. That is a Node server policy above the kernel queues. It should be read alongside backlog, not as a replacement.

Backlog also interacts with CPU scheduling. If JavaScript blocks the event loop during a burst, libuv cannot run the accept path. Completed connections can sit in the accept queue. The kernel may complete handshakes while Node is busy. When the event loop returns, Node accepts what remains. Some clients may already have timed out.

Here is the useful trace for one accepted connection:

```text
SYN received
SYN-ACK sent
ACK received
connected socket queued
accept returns descriptor
net.Socket created
connection event emitted
```

The `connection` event is near the end. Anything that happens before "accept returns descriptor" is OS state. Application metrics that count only `connection` events observe accepted work, not attempted work.

Practical backlog selection is more limited than tuning guides make it sound. For local development and ordinary services, the default is usually fine. For servers that receive bursts of short connections, a larger backlog can reduce refused or delayed handshakes when the process is temporarily busy. The host limits still cap it. Deployment chapters own host-level tuning because the right value depends on process count, load balancer behavior, descriptor limits, SYN flood settings, and admission policy.

Use backlog to describe accept pressure, not total capacity. A server can accept thousands of connections and still be slow. A server can have a large backlog and still reject clients if descriptors, CPU, memory, or upstream policy fail first. Backlog is a queue limit at one boundary.

The accept queue also explains one misleading benchmark pattern. A load generator opens many connections at once. The server reports a burst of `connection` events later. The benchmark treats all of them as immediately accepted at the start time. In reality, some connections completed the TCP handshake and waited in the accept queue while JavaScript was busy. Measuring only from the callback omits queue time.

You can make the queue visible indirectly:

```js
server.on('connection', socket => {
  console.log(Date.now(), socket.remotePort);
});
```

That timestamp records JavaScript acceptance, not handshake completion. Compare it with client-side connect timing when diagnosing spikes. A client can report "connected" before the server application logs the socket, because the OS completed the handshake and queued the connection before Node accepted it.

Slow connection handlers make the problem worse.

```js
net.createServer(socket => {
  JSON.parse(expensiveConfigBlob);
  socket.end('ready\n');
});
```

The synchronous parse blocks the event loop during accept handling. While it runs, libuv cannot keep draining the accept queue. New completed connections can pile up below JavaScript. Move heavyweight setup out of the connection path, cache parsed state, or hand work off after the socket is accepted and bounded by application admission rules.

Backlog tuning also interacts with load balancers, but only as a mention here. A load balancer may retry another backend when one refuses or delays a connection. It may also hold its own connection pool and hide client spikes from Node. Those policies belong later. The raw socket boundary still matters because every backend process has its own listener queues and descriptor limits.

## Buffer Sizes

Socket buffers hold bytes below JavaScript. Chapter 9.3 introduced send buffers and receive buffers for TCP flow control. Here, the option names matter.

`SO_SNDBUF` is the socket send buffer size option. `SO_RCVBUF` is the socket receive buffer size option. They set or request maximum buffer sizes for the OS socket. The OS may round, double for bookkeeping, cap, or autotune the actual value depending on platform.

For UDP, Node exposes the options directly:

```js
const socket = dgram.createSocket({
  type: 'udp4',
  recvBufferSize: 1 << 20,
  sendBufferSize: 1 << 20
});
```

Those creation options set `SO_RCVBUF` and `SO_SNDBUF` during socket setup. `dgram.Socket` also exposes setters after bind:

```js
socket.bind(41234, () => {
  socket.setRecvBufferSize(1 << 20);
  socket.setSendBufferSize(1 << 20);
});
```

Node's UDP docs require a bound socket for these setters. Calling them too early throws a socket-buffer-size error. That is another timing rule: some options can be set during creation, while setter methods require an open, bound OS socket.

For TCP through `node:net`, Node does not expose general-purpose `setRecvBufferSize()` or `setSendBufferSize()` methods on `net.Socket`. You mostly observe pressure through stream behavior and OS tools. Native addons or platform-specific setup can change more, but that leaves the stable Node API path.

Larger receive buffers can absorb bursts before the application reads. For UDP, that can reduce packet drops when JavaScript falls behind briefly. It also increases per-socket memory that the kernel may reserve or grow toward. With many sockets, that becomes real memory pressure.

Larger send buffers can let the local process hand more bytes to the kernel before backpressure reaches JavaScript. That can improve throughput on high-latency paths when the transport can keep enough data in flight. It can also hide downstream slowness longer. More bytes sit below your application, and cancellation or failure has more queued data to discard.

Backpressure crosses layers with translations, not one shared flag.

```js
const ok = socket.write(Buffer.alloc(64 * 1024));

if (!ok) {
  socket.once('drain', resumeWork);
}
```

The boolean return is Node writable stream pressure. The kernel send buffer has its own capacity. TCP flow control has the peer's receive window. Congestion control has its own sending limit. Those states influence each other, but JavaScript sees the stream abstraction.

UDP has a different failure shape. A full receive buffer can drop datagrams before Node emits a `message` event. UDP preserves message boundaries only for datagrams that reach the socket receive path and fit. If the kernel drops a datagram due to buffer pressure, JavaScript usually receives no event for that datagram. That is normal UDP behavior.

TCP receive buffer pressure feeds the peer through the advertised receive window. If your process stops reading a TCP socket, the kernel receive buffer fills, the receive window shrinks, and the peer slows or stalls. That can look healthy from JavaScript for a while because no error fires. The connection is applying flow control.

Buffer sizing has latency consequences. A large buffer can smooth bursts, but it can also let old bytes wait longer before the application notices overload. For request-response protocols, a smaller and well-managed queue can fail earlier and keep latency bounded. For streaming transfers, larger buffers may improve throughput. The workload decides.

The useful debugging move is to locate the queue. Node stream buffer. Kernel socket receive buffer. Kernel socket send buffer. TCP sender state. UDP datagram loss. Once you know where bytes are waiting or disappearing, option changes become targeted instead of guesswork.

Receive buffering has one more consequence for UDP services. A large `SO_RCVBUF` can make short bursts survivable, but it cannot recover datagrams already dropped before reaching the socket. If packets arrive faster than the process can drain the receive buffer for long enough, the kernel discards excess datagrams. JavaScript sees a gap only if the protocol has sequence numbers or counters.

```js
socket.on('message', msg => {
  const seq = msg.readUInt32BE(0);
  checkSequence(seq);
});
```

That sequence check is application-level detection. UDP itself reports no missing-message event. Buffer sizing reduces one local drop source; it does not add delivery accounting.

Send buffering has a different failure mode. A large send buffer can make a producer look healthy because `socket.write()` or `socket.send()` accepts work quickly. The peer or network may still be slow. Data waits in the kernel, and application latency grows somewhere the JavaScript heap profiler will not show. For TCP, `drain` eventually gives a stream signal. For UDP, send callbacks report local send completion timing, not peer receipt.

Memory accounting varies by OS. Requested socket buffer sizes may be doubled internally to account for metadata. Autotuning can grow TCP buffers based on path behavior. Container memory limits may count kernel socket memory in ways that surprise application dashboards. Keep the chapter-level conclusion small: increasing buffers spends memory to absorb bursts or fill high-latency paths, and the cost sits below V8 heap.

## IPv4, IPv6, and Dual Stack

Binding to `::` can create one of the more surprising port conflicts in Node.

```js
net.createServer().listen(3000, '::');
net.createServer().listen(3000, '0.0.0.0');
```

On many systems, the first listener may cover both IPv6 wildcard and IPv4 wildcard traffic. The second bind then fails with `EADDRINUSE`. On systems or configurations where IPv6-only behavior is active, the two listeners may coexist. Platform defaults decide the starting point.

A dual-stack socket is an IPv6 socket that also accepts IPv4 traffic through IPv4-mapped IPv6 addresses when bound to the IPv6 wildcard address. In Node terms, a server bound to `::` may also cover `0.0.0.0` unless IPv6-only behavior is enabled.

An IPv6-only socket accepts IPv6 traffic for its bound address family and leaves IPv4 binding separate. Node exposes that with `ipv6Only: true` for TCP servers and UDP sockets.

```js
server.listen({
  host: '::',
  port: 3000,
  ipv6Only: true
});
```

With `ipv6Only: true`, binding to `::` does not also bind `0.0.0.0`. You can run a separate IPv4 listener on the same port if the OS permits the exact bind combination.

```js
net.createServer().listen(3000, '::');
```

When `host` is omitted, Node listens on the unspecified IPv6 address `::` when IPv6 is available, or on `0.0.0.0` otherwise. That default can surprise code that assumes an omitted host means IPv4 only. It can also surprise code that starts one listener with no host and another with `0.0.0.0`.

Address family remains part of the socket address. `127.0.0.1:3000` and `::1:3000` are different local endpoints. A dual-stack wildcard listener can cover both families for wildcard traffic, but loopback-specific binds and wildcard binds still follow OS conflict rules.

UDP has the same option shape:

```js
const socket = dgram.createSocket({
  type: 'udp6',
  ipv6Only: true
});

socket.bind(41234, '::');
```

That socket binds IPv6 wildcard for UDP port `41234` and leaves IPv4 wildcard separate. Without `ipv6Only`, a UDP IPv6 wildcard socket may also cover IPv4 wildcard on platforms with dual-stack enabled.

Use numeric hosts when debugging address-family conflicts. `localhost` can resolve to `::1`, `127.0.0.1`, or both, with ordering controlled by OS and Node lookup behavior. If the bind or connect result matters, write the address you mean.

`EADDRNOTAVAIL` can also show up here. Binding `::1` requires IPv6 loopback to exist. Binding an IPv6 address on a host with IPv6 disabled or unavailable fails. Binding an IPv4 address through an IPv6-only socket path fails. The message varies, but the cause is local address-family state.

Containers add another layer of scope. The available addresses are the addresses inside the process's network namespace. A host may have IPv6 enabled while a container namespace has only IPv4, or the reverse. Node reports the namespace it runs in.

The least surprising production bind is explicit:

```js
server.listen({
  host: process.env.HOST ?? '0.0.0.0',
  port: Number(process.env.PORT ?? 3000)
});
```

For IPv6 service, be just as explicit:

```js
server.listen({
  host: '::',
  port: 3000,
  ipv6Only: false
});
```

That says the process intentionally wants dual-stack behavior where the platform supports it. If you need separate IPv4 and IPv6 listeners, use `ipv6Only: true` on the IPv6 listener and bind the IPv4 listener separately.

Dual-stack behavior also affects client logs. A server may print `::` as its listening address, while IPv4 clients connect successfully. Accepted sockets may then show IPv4-mapped IPv6 addresses on some platforms, or ordinary IPv4 addresses depending on the path Node receives from the OS.

```js
server.on('connection', socket => {
  console.log(socket.remoteAddress, socket.remoteFamily);
});
```

Record both fields when the address family matters. String matching on addresses alone breaks easily around IPv4-mapped forms, zone IDs, and name-resolution ordering. `remoteFamily` and `localFamily` make the family decision visible.

Security policy also needs exact bind behavior. Binding `::` with dual-stack enabled may expose IPv4 traffic too. Binding `0.0.0.0` exposes all suitable IPv4 interfaces. Binding loopback exposes only the local namespace. Firewalls and security groups can still block traffic, but the process should bind only the surface it intends to serve.

## Choosing Options in Node

Raw TCP servers usually need only a few choices at startup: exact host, port, backlog when bursty accepts matter, and `reusePort` only when you intentionally want OS-level distribution across separate listeners. Let Node's default `SO_REUSEADDR` behavior handle ordinary restarts.

```js
const server = net.createServer({
  noDelay: true,
  keepAlive: true,
  keepAliveInitialDelay: 60_000
}, socket => attachProtocol(socket));

server.listen({ host: '0.0.0.0', port: 3000 });
```

That server accepts IPv4 traffic on all suitable local interfaces, disables Nagle for accepted sockets, and enables TCP keep-alive probes after one idle minute. It still needs application deadlines if the protocol has request-level timing. It still needs shutdown handling for accepted sockets. Those are higher-level policies.

When policy depends on the peer or on protocol negotiation, keep the setup in the callback:

```js
const server = net.createServer(socket => {
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 60_000);
});
```

Both forms target accepted `net.Socket` objects. The options form covers common defaults. The callback form covers decisions that need connection data.

For local development, port `0` avoids accidental conflicts:

```js
server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  console.log(port);
});
```

Tests should prefer that shape over hard-coded shared ports. `SO_REUSEADDR` can make restarts smoother, but it cannot make two test processes own the same listener. Port `0` asks the OS for a free port and then reads the actual result.

For UDP multicast or several local UDP consumers, choose between `reuseAddr` and `reusePort` with care:

```js
const socket = dgram.createSocket({
  type: 'udp4',
  reuseAddr: true
});
```

`reuseAddr` changes bind permissiveness and multicast-style receiver setups. `reusePort` creates OS distribution across sockets where supported. Those are different contracts. Use `reusePort` only when one datagram should go to one of several listeners selected by the OS.

For latency-sensitive small TCP messages, start with application batching and `setNoDelay(true)`. Batching controls your own write pattern. `TCP_NODELAY` controls the TCP small-write delay policy. Measure with real RTT and peer behavior because loopback tests hide delayed-ACK and network timing.

For long-lived mostly idle TCP connections, combine layers deliberately. `socket.setKeepAlive(true, delay)` helps the OS discover dead TCP paths eventually. `socket.setTimeout(ms)` lets your application retire idle sockets on its own schedule. Protocol heartbeats prove the remote application is still participating. Those three timers answer different questions.

For backlog, set a value only when you have a reason:

```js
server.listen({
  host: '0.0.0.0',
  port: 3000,
  backlog: 2048
});
```

Then verify host limits. If the OS caps the queue below your requested value, the JavaScript literal becomes documentation rather than capacity. On Linux, `somaxconn` and TCP-specific settings matter. Keep host tuning in deployment automation, not buried in application code comments.

For buffer sizes, prefer defaults until measurements point at socket-buffer pressure. UDP receivers that drop bursts may need larger `SO_RCVBUF`. Bulk senders on high-latency paths may benefit from more send buffering. Many request-response services get worse tail latency when queues grow without admission control.

For bind errors, separate local ownership from reachability. `EADDRINUSE` and `EADDRNOTAVAIL` happen before any remote client is involved. DNS, routing, firewalls, and load balancers can be broken while bind still succeeds. A successful bind means the local OS accepted the endpoint. It says nothing about whether another host can reach it.

For restarts, prefer clean shutdown and exact ownership over reuse assumptions. Close the listening server. Track accepted sockets. Let the process manager wait for exit or readiness according to its contract. Socket options can make restart behavior smoother, but they cannot replace knowing which process owns which endpoint.

A raw TCP service usually ends up with a small connection initializer:

```js
function configureSocket(socket) {
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 60_000);
  socket.setTimeout(120_000);
}
```

Call it from the server's connection handler when connection-specific logic exists, and from any client code that creates long-lived outbound sockets. For one server-wide accepted-socket policy, the `net.createServer()` options object can replace the server-side part. Bind policy stays near `server.listen()`. UDP bind policy stays in `dgram.createSocket()` and `socket.bind()`.

```js
const server = net.createServer(socket => {
  configureSocket(socket);
  attachProtocol(socket);
});
```

The split matters during reviews. `host`, `port`, `ipv6Only`, `reusePort`, and `backlog` are listener choices. `setNoDelay()`, `setKeepAlive()`, and `setTimeout()` are connected-socket choices. `recvBufferSize` and `sendBufferSize` are UDP socket storage choices. Mixing them together in one "network config" object can hide when each setting is applied.

For command-line services, print the accepted listener address at startup and the chosen socket policy at debug level. Avoid printing every accepted socket in normal logs; high connection rates turn that into log pressure. But during a bind or latency incident, the exact listener address, address family, backlog request, and reuse mode tell you which kernel path the process asked for.

The operating pattern is simple enough to keep in your head:

```text
bind options decide who can own an address
keep-alive decides idle TCP probing
Nagle decides small-write batching
backlog decides pending accept capacity
buffer sizes decide kernel byte storage
ipv6Only decides wildcard family coverage
```

Every item in that list changes a lower owner than JavaScript. Node gives you the switch. The kernel applies it. The observable result depends on the platform, current socket state, and the timing of packets arriving while your process is busy.
