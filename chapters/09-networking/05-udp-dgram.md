---
title: "UDP and the dgram Module"
date: "2026-05-11"
excerpt: "How UDP datagrams move through Node's dgram API, libuv UDP handles, OS socket state, broadcast, multicast, connected UDP, and failure paths."
category: "Network Fundamentals with Node.js"
tags: ["nodejs", "networking", "udp", "dgram", "sockets"]
author: "Ishtmeet Singh @ishtms"
chapter: "networking"
subchapter: "udp-dgram"
published: true
toc: true
---

UDP starts with message boundaries. Each receive event carries one datagram payload. TCP stream reads follow a separate byte-stream contract.

One send produces one datagram payload. If the kernel delivers it to the socket, Node emits one `message` event with that payload and the sender metadata.

```js
import dgram from 'node:dgram';

const socket = dgram.createSocket('udp4');

socket.on('message', (msg, rinfo) => {
  console.log(msg.toString(), rinfo.address, rinfo.port);
});

socket.bind(41234, '127.0.0.1');
```

Run that process, then send one payload at it:

```js
import dgram from 'node:dgram';

const socket = dgram.createSocket('udp4');
socket.send('ping', 41234, '127.0.0.1', err => {
  if (err) throw err;
  socket.close();
});
```

The receiver sees one `Buffer` containing `ping`. It gets the sender's address and port in `rinfo`. The receive API is message-oriented. The event name is `message`, and each event corresponds to one datagram payload delivered by the kernel.

That one-message shape is the whole topic.

UDP is a transport protocol for individual datagrams. Each datagram carries one application payload plus UDP header fields: source port, destination port, length, and checksum. The IP layer carries that datagram inside an IP packet, using the address and routing machinery from Chapter 9.1. Node's `node:dgram` module exposes those datagrams directly enough that the transport contract leaks into application design.

TCP gives Node a connected byte stream. UDP gives Node individual messages. A UDP send creates one UDP payload. A UDP receive delivers one UDP payload when it arrives and passes kernel filtering. The protocol omits connection state, ordering state, ACK state, and retransmission state. Applications that need those properties build them above UDP or use a protocol that already owns them.

That framing matters. UDP has its own transport contract and a smaller boundary than TCP.

## Datagram Semantics

A UDP message boundary is the edge around one UDP payload. If one process sends 12 bytes in one `socket.send()`, the receiver gets those 12 bytes as one message when the datagram arrives. If the sender sends two 6-byte datagrams, the receiver gets two messages when both arrive. Arrival can be delayed. Arrival order can differ from send order. Some datagrams can disappear. A duplicate can arrive too.

The message boundary is preserved by the UDP socket API. That is the big distinction from a TCP byte stream, where application writes and read events have independent boundaries.

```js
socket.send('one', 41234, '127.0.0.1');
socket.send('two', 41234, '127.0.0.1');
```

Those are two UDP datagrams. A receiver can see `one` and `two`, `two` and `one`, only one of them, or the same payload more than once if the network duplicates a packet. On loopback you will usually see both in order because the path is local and quiet. That local result is a property of the test path, not the UDP contract.

Packet loss means a datagram sent by one endpoint never reaches the receiving application. It can be dropped by the sender's kernel, a local firewall, a router, a remote firewall, the receiver's kernel, or a full receive buffer. UDP has no protocol-level recovery step that asks for the missing payload again.

Packet reordering means datagrams arrive in a different order from the send order. IP routing, host scheduling, interface queues, and receive processing can all change timing. UDP carries no sequence field for application messages, so the receiver can only detect reordering when the payload includes its own sequence data.

Packet duplication means the receiver observes more than one copy of a datagram payload. It is less common than loss, but it is part of the contract. UDP has no duplicate suppression state. If duplicates matter, the payload needs an identifier and the application needs a memory window for recently processed messages.

Those three words shape every UDP service: loss, reordering, duplication.

```js
const seen = new Set();

socket.on('message', msg => {
  const id = msg.subarray(0, 8).toString('hex');
  if (seen.has(id)) return;
  seen.add(id);
});
```

That snippet only handles one tiny duplicate-suppression decision. The receiver needs application data that makes duplicate detection possible. The transport layer supplies only a datagram and remote address data.

The UDP header is small enough to name in full: source port, destination port, length, checksum. The length covers the UDP header plus payload. The checksum gives the receiver a way to reject corrupted transport data when checksum validation applies. IPv4 permits a zero UDP checksum in normal UDP. IPv6 requires UDP checksum coverage for regular UDP. Node does not expose checksum decisions in `message`; datagrams that fail checksum validation are dropped before JavaScript sees them.

That invisible drop matters when debugging corrupted or malformed traffic. Your handler receives payloads the kernel accepted for delivery to the socket. It does not receive rejected packets plus an error object. Packet capture may show traffic on an interface while Node remains quiet because filtering, checksum validation, address matching, or socket buffer pressure happened below Node.

The source port field is also worth keeping local. Many UDP protocols use a fixed destination port for servers and an ephemeral source port for clients. The server replies to the source address and source port in `rinfo`. If a client sends one datagram and closes the socket immediately, a later reply has nowhere in that process to land.

```js
socket.on('message', (msg, rinfo) => {
  console.log(`${rinfo.address}:${rinfo.port}`, msg.length);
});
```

That remote tuple is metadata from the received datagram. It is not a session. If the same peer sends again from a different source port, Node reports a different tuple. If a NAT device rewrites the source port, Node reports the rewritten value because that is what reached the local host.

Application protocols often put their own message type near the beginning of the payload. That lets the receiver route the datagram without guessing from source address alone.

```js
socket.on('message', msg => {
  if (msg.length < 1) return;
  if (msg[0] === 1) handleHeartbeat(msg);
  if (msg[0] === 2) handleMeasurement(msg);
});
```

Length checks come first. UDP makes it easy to receive a short payload, an empty payload, or bytes from a sender that uses a different protocol on the same port. The kernel checks transport fields. It does not validate your application framing.

Size is part of the boundary too. A UDP datagram has one payload, and the practical payload size is constrained by IP packet size and the path MTU covered in Chapter 9.1. A payload that fits the theoretical UDP limit can still be a bad network message because IP fragmentation may be needed below it. Fragment loss drops the whole UDP payload from the receiver's point of view.

Keep local protocols small unless the protocol has a specific reason to send larger datagrams.

For ordinary IPv4 UDP, the maximum UDP payload is 65,507 bytes: 65,535 bytes of IPv4 packet size, minus a 20-byte IPv4 header and an 8-byte UDP header. IPv6 has different header math and path rules. Real applications usually choose payloads far below those limits because Ethernet-sized paths, tunnels, VPNs, and cloud overlays reduce the safe size.

Node will let you try a large send. The OS may reject it.

```js
const payload = Buffer.alloc(70_000);

socket.send(payload, 41234, '127.0.0.1', err => {
  console.error(err?.code);
  socket.close();
});
```

On many systems that prints `EMSGSIZE`. The exact error depends on address family, platform, interface, and route state. A send callback reports local completion or local failure. It does not report peer receipt.

That callback timing catches people. `socket.send()` completion says Node and the OS finished handling the local send request. It can include DNS failure, invalid arguments, a closed socket, or a local kernel error. It cannot mean the remote process handled the message, because UDP has no peer acknowledgment in the transport protocol.

UDP payload sizing is one of those places where local tests lie. Loopback can carry large datagrams because the local stack has generous path behavior. A real path may include Ethernet, Wi-Fi, VPN encapsulation, cloud overlay headers, or a tunnel. Each extra header consumes space below the application payload. If the final IP packet exceeds the path MTU, fragmentation or rejection becomes possible. With UDP, losing one fragment loses the whole payload at the receiver.

Many production UDP protocols stay under roughly 1,200 bytes per payload when they need to cross unknown Internet paths. That number is protocol-specific guidance, not a Node rule. For a private LAN with known MTU, you may choose differently. The Node rule is simpler: `socket.send()` takes bytes, and the network path decides whether those bytes are practical as one datagram.

## The `node:dgram` Surface

`node:dgram` is Node's built-in UDP module. It creates datagram sockets, sends datagrams, receives datagrams, joins multicast groups, and exposes a small set of socket controls. The API is lower-level than `node:http` and narrower than `node:net` because UDP itself has a smaller transport contract.

```js
import dgram from 'node:dgram';

const udp4 = dgram.createSocket('udp4');
const udp6 = dgram.createSocket('udp6');
```

The type picks the address family. `udp4` creates an IPv4 UDP socket. `udp6` creates an IPv6 UDP socket. The family controls address parsing, wildcard binds, multicast behavior, and the default address used by connected UDP when you omit one.

A `dgram.Socket` is the JavaScript object Node gives you for a UDP socket. It extends `EventEmitter`, so events such as `message`, `listening`, `error`, and `close` follow the listener behavior from Chapter 7.4. It wraps lower native state. The JavaScript object is not the whole socket. The kernel owns the local port, receive queue, send queue, address filters, and multicast membership state.

`dgram.createSocket()` accepts either a type string or an options object:

```js
const socket = dgram.createSocket({
  type: 'udp4',
  reuseAddr: true
});
```

`reuseAddr` asks Node to set address-reuse behavior for the underlying socket. It matters for multicast receivers and for some local restart workflows. Socket option details move to Chapter 9.6, so keep the local rule compact: choose it deliberately, and expect platform behavior around address reuse to have edge cases.

The options object can also carry receive and send buffer size requests in modern Node, plus IPv6-only behavior for `udp6` sockets. Those values still pass through OS policy. The kernel may clamp them, reject them, or round them. Node exposes the request through JavaScript, but the socket option lives below the process boundary.

```js
const socket = dgram.createSocket({
  type: 'udp6',
  ipv6Only: true
});
```

`ipv6Only` belongs to the address-family boundary. A UDP socket created for IPv6 can have platform-dependent behavior around IPv4-mapped addresses unless the IPv6-only option is set. The full dual-stack discussion belongs with socket options in Chapter 9.6. For UDP debugging, the practical move is to make the address family explicit and keep numeric addresses during the first test.

A datagram socket is a socket whose read and write operations preserve datagram message boundaries. It can receive from many remote endpoints on one local port. It can send to different endpoints from the same local socket. Binding chooses the local address and local port. Sending chooses the remote address and remote port unless the socket has a connected UDP peer configured.

The common lifecycle is short:

```text
create socket
  -> bind local address and port
  -> receive message events
  -> send datagrams
  -> close
```

There is no accept step. A UDP server has one socket that receives datagrams from whichever peers the kernel admits through local filtering. Node reports each peer through `rinfo`.

```js
socket.on('message', (msg, rinfo) => {
  console.log(rinfo);
});
```

`rinfo` includes the remote address, remote port, address family, and message size. That remote port often comes from the sender's ephemeral port. It is the address you send a reply to when building an echo-style protocol.

`dgram.Socket` also supports the same reference-control shape as other Node handles through `ref()` and `unref()`. That term was covered earlier, so the UDP-specific note is narrow: a socket with an active native handle can keep the process alive while it can receive work. Calling `unref()` lets the process exit when the UDP socket is the only remaining active handle. Timers and other handles can still keep the process alive.

```js
const socket = dgram.createSocket('udp4');

socket.unref();
socket.bind(41234);
```

That pattern appears in telemetry emitters and discovery helpers that should run while the process has other work. It is easy to misuse in servers because the process can exit while the UDP socket is still bound. Use it when process lifetime is intentionally owned elsewhere.

The `close` event means Node closed the socket handle. After close, the JavaScript object remains an object, but its native socket is gone. Later sends or binds on the same object fail through Node's dgram state checks. Create a new socket for a new lifetime.

## Binding and Receiving

`socket.bind()` attaches the UDP socket to a local port and, optionally, a local address. A bound socket can receive datagrams addressed to that local socket address. Binding crosses into the same kernel socket table concept from Chapter 9.1, but the state is UDP state rather than TCP listen state.

```js
const socket = dgram.createSocket('udp4');

socket.on('listening', () => {
  console.log(socket.address());
});

socket.bind(41234, '0.0.0.0');
```

The `listening` event fires after the bind completes. For UDP, "listening" means the socket is bound and ready to receive datagrams. The TCP accept queue and peer-connection state from earlier subchapters are absent from this path.

When the address is omitted, the OS binds to the wildcard address for the socket family. For `udp4`, that is the IPv4 wildcard path. For `udp6`, that is the IPv6 wildcard path, with platform and socket-option behavior deciding dual-stack details. Chapter 9.6 owns the IPv6-only switch.

When the port is omitted or set to `0`, the OS chooses an ephemeral port.

```js
socket.bind(0, '127.0.0.1', () => {
  console.log(socket.address().port);
});
```

That pattern is useful for tests and temporary clients that need a stable local socket while still avoiding hard-coded ports. The bound port belongs to the local process until the socket closes.

Bind can fail. Common errors include `EADDRINUSE` when another socket owns the same local address and port combination, `EADDRNOTAVAIL` when the address is absent from the host, and `EACCES` for permission-sensitive ports or platform policy. Node emits `error` for asynchronous socket errors, and some invalid API calls throw synchronously before the native operation starts.

Binding to a specific address narrows receive eligibility. Binding to `127.0.0.1` receives datagrams addressed to loopback. Binding to a LAN address receives datagrams addressed to that interface address. Binding to the wildcard address lets the kernel deliver datagrams addressed to suitable local addresses for that family.

```js
socket.bind({ port: 41234, address: '127.0.0.1' });
```

The object form is easier to read once you add options such as `exclusive`. In ordinary single-process UDP code, the positional form and object form reach the same kind of kernel bind. In clustered or shared-handle setups, ownership becomes more subtle and belongs outside this UDP foundation chapter.

A bound UDP socket can receive from many peers without any per-peer setup:

```js
const peers = new Map();

socket.on('message', (msg, rinfo) => {
  const key = `${rinfo.address}:${rinfo.port}`;
  peers.set(key, Date.now());
});
```

That map is application state. The kernel does not create one connected socket per peer for you. If a peer goes quiet, UDP sends no close notification. Your code decides how long a remembered peer remains meaningful.

The `rinfo.size` field is the received payload size in bytes. It should match `msg.length` for the delivered buffer. Prefer `msg.length` when parsing and `rinfo` when logging remote metadata. Parsing from `rinfo.size` makes code harder to read because the actual bytes live in `msg`.

```js
socket.on('error', err => {
  console.error(err.code);
  socket.close();
});
```

Add the error listener before binding in examples and in small tools. A UDP process with an unhandled `error` event can exit the same way any EventEmitter can.

Receiving has one main event:

```js
socket.on('message', (msg, rinfo) => {
  socket.send(msg, rinfo.port, rinfo.address);
});
```

That is a UDP echo server. It replies to the address and port from the incoming datagram. The reply is a new datagram. There is no per-client socket. There is no connection object to hold state for that peer unless your application creates one in JavaScript.

The `msg` argument is a `Buffer`. It contains the payload bytes from exactly one datagram. If your protocol is text, decode it. If your protocol is binary, parse fields from the buffer. Chapter 2 already covered Buffer mechanics; here the extra rule is that the buffer boundary is a protocol boundary.

```js
socket.on('message', msg => {
  const type = msg.readUInt8(0);
  const value = msg.readUInt32BE(1);
  console.log(type, value);
});
```

The parser can trust that `msg` belongs to one datagram. It still has to validate length before reading fields. A short, malformed, or hostile payload can reach the handler.

`socket.close()` closes the underlying socket and stops new receive events. A close callback attaches to the `close` event.

```js
socket.close(() => {
  console.log('closed');
});
```

Closing a UDP socket discards local receive state. In-flight datagrams can still exist in the network or in queues below the application, but the closed JavaScript socket will not deliver new `message` events.

Payload handling deserves a little care because UDP hands your parser a complete message with no higher-level schema. A text payload can be invalid UTF-8. A binary payload can be shorter than the fields your parser expects. A sender can use the right port with the wrong protocol. UDP has no content negotiation at the transport layer.

```js
socket.on('message', msg => {
  if (msg.length !== 6) return;
  const type = msg.readUInt16BE(0);
  const value = msg.readUInt32BE(2);
  handle(type, value);
});
```

That parser accepts one exact six-byte shape. The early length check matters because `readUInt32BE(2)` needs four bytes starting at offset two. Without the check, malformed input becomes a JavaScript exception in the receive path. Exceptions in `message` handlers follow ordinary EventEmitter listener behavior; they can take down the process when they escape.

For text protocols, decode only after length and type checks when the message has binary framing:

```js
socket.on('message', msg => {
  if (msg[0] !== 1) return;
  const name = msg.subarray(1).toString('utf8');
  handleName(name);
});
```

The `subarray()` call creates a view over the same underlying memory. Chapter 2 already covered Buffer views. The UDP-specific point is ownership duration: once your handler returns, keep a copy if later code needs bytes that should be isolated from any larger backing allocation. In most small UDP handlers, passing the `Buffer` through synchronously is fine. Long-lived caches should store parsed values or copied buffers deliberately.

Zero-length datagrams are valid UDP payloads. Node can deliver an empty `Buffer` in `message`.

```js
socket.on('message', msg => {
  if (msg.length === 0) handleEmptyProbe();
});
```

Some discovery protocols use empty or tiny probes because the address and port metadata carry most of the signal. Your parser should decide whether empty payloads are valid for the protocol instead of treating them as impossible.

Source address validation is also application logic. `rinfo.address` and `rinfo.port` say where the datagram came from according to the received packet. UDP has no peer identity. Local networks, NAT, and spoofing rules decide how trustworthy that tuple is. For a private health probe, the tuple may be enough. For anything security-sensitive, later security chapters own the authentication story.

One `dgram.Socket` can handle several logical peers, but the handler still runs on the JavaScript thread. A slow parser delays every other peer sharing that socket. That is fine for low-rate control traffic. It becomes painful for high-rate telemetry or realtime data. The receive queue below Node does not know which peer your application cares about most; it drops when the queue is full.

Keep the receive handler boring. Validate length. Parse the minimal header. Move expensive work out of the immediate event path. Count accepted, rejected, and malformed messages separately. Those counters will never be perfect under UDP loss, but they make local parser behavior visible.

Version fields pay for themselves quickly. A one-byte version at the front of the payload gives the receiver a cheap way to reject old senders, new senders, and random traffic on the same port.

```js
socket.on('message', msg => {
  if (msg.length < 2) return;
  if (msg[0] !== 1) return;
  dispatch(msg[1], msg.subarray(2));
});
```

That is still a tiny protocol, but it has two useful properties: the receiver can reject unknown versions before parsing the body, and the message type is explicit. UDP will not give you a schema boundary. A few bytes of header usually make logs, captures, and compatibility checks much less ambiguous.

For binary messages, reserve fields intentionally. A spare flag byte or reserved integer gives later versions room to evolve without changing the whole datagram shape. The receiver can require reserved fields to be zero today and reject messages that set them early. That keeps accidental future traffic from being parsed as current traffic, especially during rolling deploys where old and new processes share a port for a while.

Small headers beat guesswork. They also make packet captures readable when every other signal is silent. Use bytes deliberately.

## The Path Through Node and libuv

The weird part lives below the JavaScript object.

`dgram.createSocket('udp4')` creates a JavaScript `dgram.Socket`, sets up EventEmitter state, records the family, and prepares native binding state. Node's internal names shift across releases, but in v24 the shape is stable enough to reason about: JavaScript calls into Node's native UDP binding, which uses libuv's UDP handle type to talk to the operating system socket API.

The libuv handle is the event-loop-facing object. For UDP, libuv exposes `uv_udp_t` for socket state and `uv_udp_send_t` for individual send requests. Node does not ask V8 to receive packets. V8 runs the JavaScript callback after Node has already crossed native code, libuv, and kernel readiness.

A bind call moves the socket into kernel-owned local address state:

```text
dgram.Socket.bind()
  -> Node UDP binding
  -> libuv UDP handle
  -> OS UDP socket
  -> bind local address and port
```

After bind, Node starts receiving on that handle. Underneath, libuv registers interest in readability for the UDP socket with the platform event backend. On Linux that path usually goes through epoll. On macOS and BSD systems it usually goes through kqueue. On Windows it uses IOCP-oriented machinery. The exact backend differs. The contract at the Node boundary is the same: when the OS reports that a UDP socket has receive work, libuv calls back into Node, and Node emits `message`.

UDP receive work is message-oriented at the kernel socket boundary. The kernel stores received datagrams in socket receive queue state. Each queued datagram has payload bytes plus peer address metadata. When Node reads one, the OS copies that payload into a buffer supplied by the native path. Node wraps or copies that memory into a JavaScript `Buffer` according to its internal receive path, then emits `message` with `msg` and `rinfo`.

There is a useful consequence here. Backpressure from streams does not apply to `dgram.Socket` receive events. A `dgram.Socket` is an EventEmitter, not a Readable stream. If JavaScript spends too long in CPU work, the event loop stops draining receive callbacks. The kernel receive queue can fill. Once that queue is full, later UDP datagrams are dropped. The sender receives no normal UDP signal for that drop.

Receive buffers exist below Node and can be queried or set through `getRecvBufferSize()` and `setRecvBufferSize()`, subject to OS limits. Chapter 9.6 owns buffer tuning, but the operational fact belongs here: a larger receive buffer can absorb a burst, and it cannot turn UDP into a reliable transport. It only changes how much queued data the local kernel can hold before dropping.

Sends have their own local request path:

```text
socket.send(Buffer)
  -> validate target or connected peer
  -> optional DNS lookup for hostnames
  -> libuv UDP send request
  -> OS send path
  -> callback or error
```

When the target address is a hostname, Node has to resolve it before the UDP send request has a numeric address. That lookup can delay the send at least one tick and can fail with DNS errors from Chapter 9.2. When the target is already numeric, Node can skip name resolution and hand the address down sooner.

The send callback belongs to the local send request. For a buffer payload, the callback is the point where it is safe to reuse or mutate memory whose contents were needed for the send. With small examples this usually does not matter. With high-rate UDP code that reuses buffers, it matters a lot.

```js
const buf = Buffer.from('stats');

socket.send(buf, 41234, '127.0.0.1', err => {
  if (err) console.error(err.code);
});
```

The callback can report local errors such as DNS failure, invalid address family, oversized datagram, closed socket state, or platform send failure. It cannot report application-level handling by the peer. The receiver may be absent. A firewall may drop the packet. The remote process may be overloaded. The local callback can still fire with `null`.

Send buffering also differs from TCP streams. TCP can hold a byte stream in a send buffer and apply flow control against the peer's receive window. UDP sends are individual datagram requests. The OS may queue them briefly, but there is no per-peer receive-window negotiation and no stream drain signal. Node v24 exposes send queue inspection methods for dgram sockets, but those only describe local queued send requests. They do not describe remote delivery.

The event loop connects both directions. Receive readiness enters from libuv into JavaScript as `message`. Send completion enters from libuv into JavaScript as the send callback. Errors enter as callbacks, thrown exceptions, or `error` events depending on where they occur. Argument validation can fail before native code. Bind and send failures can surface asynchronously. ICMP errors, when the platform reports them to the socket, can surface later and sometimes only for connected UDP sockets.

That delayed error shape is normal for UDP. The protocol has no setup phase where the peer confirms readiness. The first sign of a bad remote port might be a later ICMP message. Or nothing.

## Sending Datagrams

`socket.send()` sends one UDP datagram payload. For an unconnected UDP socket, you pass the message, destination port, and destination address.

```js
const socket = dgram.createSocket('udp4');

socket.send('hello', 41234, '127.0.0.1', err => {
  if (err) console.error(err.code);
  socket.close();
});
```

The message can be a string, `Buffer`, `TypedArray`, `DataView`, or an array of supported binary chunks. Strings are encoded as UTF-8 bytes. Binary payloads keep you closer to the actual datagram size, which matters because size limits are byte limits.

`socket.send()` also has offset and length parameters for sending a slice of a buffer:

```js
const buf = Buffer.from('xxpayloadxx');

socket.send(buf, 2, 7, 41234, '127.0.0.1', err => {
  if (err) console.error(err.code);
});
```

That sends `payload`. Offsets and lengths are byte offsets. Multi-byte text characters do not change that rule after the data is already in a `Buffer`.

An unbound socket can send. Node will bind it implicitly to a wildcard local address and an ephemeral port before sending. That is convenient for one-shot clients.

```js
const socket = dgram.createSocket('udp4');

socket.send('probe', 41234, '127.0.0.1', () => {
  console.log(socket.address());
  socket.close();
});
```

The printed address shows the local port the OS assigned. The remote receiver sees that source port in `rinfo.port`. If the receiver sends a reply, it sends back to that port.

For request-response UDP code, keeping the socket open matters because the reply targets the source address and port from the original datagram. Closing immediately after `send()` gives the OS permission to release that local port before a reply can be delivered to the process.

```js
const socket = dgram.createSocket('udp4');

socket.on('message', msg => {
  console.log('reply:', msg.toString());
  socket.close();
});

socket.send('hello', 41234, '127.0.0.1');
```

There is still no connection. The client is just keeping its local UDP socket alive long enough to receive a datagram addressed back to its local port.

Hostnames work too:

```js
socket.send('hello', 41234, 'localhost', err => {
  if (err) console.error(err.code);
});
```

That send includes name resolution. `localhost` may resolve to IPv4, IPv6, or both depending on OS and Node lookup behavior. A `udp4` socket needs an IPv4 destination. A `udp6` socket needs an IPv6 destination unless the platform supports a mapped-address path and the socket options line up. Numeric addresses remove that ambiguity when debugging.

The send target has three pieces: remote address, remote port, and address family. The local endpoint has its own address and port. With UDP, a single local endpoint can send to many remote endpoints:

```js
for (const port of [41234, 41235, 41236]) {
  socket.send('tick', port, '127.0.0.1');
}
```

Every call creates a separate datagram. The same local socket can receive replies from all three peers. Your protocol has to match replies to requests if that matters. UDP gives you the remote socket address and the bytes. Correlation belongs in the payload or in application state.

Datagram sends are atomic at the UDP API boundary. One send request describes one payload. If the OS accepts it, the receiver gets that payload as one datagram or gets nothing. The receiver never gets the first half as one `message` event and the second half as another `message` event because Node chose to split it. Fragmentation below IP can happen, but reassembly finishes before UDP delivery to the socket. Failed reassembly means no delivered datagram.

Arrays of buffers are useful when your protocol has a small header and a payload you already have in another buffer:

```js
const header = Buffer.alloc(3);
header[0] = 2;
header.writeUInt16BE(payload.length, 1);

socket.send([header, payload], 41234, '127.0.0.1');
```

The header uses one type byte and a two-byte big-endian payload length. Node treats that as one UDP datagram payload made from the chunks. The OS still receives one send request for one datagram. The chunks do not create several datagrams, and the receiver sees one `message` event containing the combined bytes.

That feature can reduce avoidable copying in application code, but it also makes length accounting easier to get wrong. Count bytes after encoding. A string's character count and a datagram's byte count can differ.

```js
const text = 'snowman: \u2603';
const bytes = Buffer.byteLength(text);

socket.send(text, 41234, '127.0.0.1');
console.log(bytes);
```

The send size is the UTF-8 byte length, not the number of JavaScript string code units. Binary protocols should usually build a `Buffer` explicitly before sending so the byte layout is visible.

Send callbacks are optional, but skipping them hides local errors. For fire-and-forget telemetry, that may be a conscious tradeoff. For tools, tests, and service protocols, log the error code at least while building the path.

```js
socket.send(payload, port, host, err => {
  if (err) console.error('udp send failed', err.code);
});
```

That callback still belongs to the local send. It is useful because it distinguishes "the local path rejected my datagram" from "the remote path may have dropped it." It cannot collapse those two cases into a delivery answer.

Sending too fast can create local queue pressure. UDP has no TCP-style backpressure signal from a peer, but Node and the OS still have finite queues. Node v24 exposes `getSendQueueSize()` and `getSendQueueCount()` on dgram sockets. Those values describe queued send work in Node/libuv, not remote delivery.

```js
console.log(socket.getSendQueueCount());
console.log(socket.getSendQueueSize());
```

If those numbers grow during a burst, JavaScript is producing send requests faster than the local runtime can hand them down. That is a local pacing signal. It still says nothing about receiver health.

One more edge: `socket.send()` can bind implicitly. That convenience can hide the local address and port selection. In code that needs predictable replies, explicit `bind()` is clearer because the `listening` callback gives you the local address before the first send.

```js
socket.bind(0, '0.0.0.0', () => {
  socket.send('hello', 41234, '192.0.2.20');
});
```

The local port is chosen once for that socket. Every later send from the same socket uses that local port unless the socket closes and a new one is created.

## Connected UDP

A connected UDP socket has a default remote address and port stored in kernel socket state. It also filters inbound datagrams so the socket receives messages from that remote peer.

```js
const socket = dgram.createSocket('udp4');

socket.connect(41234, '127.0.0.1', () => {
  socket.send('ping');
});
```

`connect()` here is UDP connect, not the TCP handshake from Chapter 9.3. There is no SYN. There is no accepted socket on the other side. The local kernel records a remote socket address for this UDP socket. Node emits `connect` when that local association completes or calls the callback.

After `connect()`, `socket.send()` uses the associated remote endpoint, so the target arguments are omitted. `socket.remoteAddress()` returns that associated endpoint.

```js
socket.on('connect', () => {
  console.log(socket.remoteAddress());
});
```

Connected UDP is useful when one socket talks to one peer. It cuts repeated target arguments, and it lets the kernel drop inbound datagrams from other remote addresses before JavaScript sees them. That filter is local socket behavior. It is not peer authentication.

```js
socket.on('message', (msg, rinfo) => {
  console.log('from connected peer:', rinfo.port);
});
```

For a connected UDP socket, random datagrams from other ports will not reach that handler on typical platforms. The kernel checks the remote tuple before delivery to that socket.

That filter can make measurements cleaner. Suppose a local process sends periodic datagrams to one collector and only expects replies from that collector. A connected UDP socket keeps unrelated packets on the same local port away from JavaScript. The kernel still has to receive and classify the packet, but the `message` handler only sees the associated peer.

Connected UDP also fixes the default destination for `send()`:

```js
socket.connect(41234, '127.0.0.1', () => {
  socket.send(Buffer.from([1]));
  socket.send(Buffer.from([2]));
});
```

Both sends target the same remote socket address. The local source port also stays stable for the socket. That combination is useful for request IDs, counters, and peer-local state in small protocols.

The local bind can still be explicit:

```js
socket.bind(0, '127.0.0.1', () => {
  socket.connect(41234, '127.0.0.1');
});
```

Here the OS chooses the local ephemeral port during bind, then records the connected UDP peer. Explicit bind helps when the local address matters, such as a host with several interfaces or a test that needs to print the source port before sending.

Changing peers means disconnecting first or creating another socket. Creating another socket is often clearer because each JavaScript object then has one peer association and one error stream. Reusing a single socket for several connected peers can work, but the timing around in-flight sends and later ICMP errors gets harder to read.

`disconnect()` removes the associated remote endpoint:

```js
socket.disconnect();
socket.send('next', 41235, '127.0.0.1');
```

After disconnecting, the socket can send to explicit targets again. Calling `disconnect()` on a socket that is already disconnected raises a Node error.

Connected UDP also changes some error visibility. If the remote host replies with ICMP Port Unreachable, some platforms report an error to the connected UDP socket. Node can surface that as an `error` event or send callback error depending on timing and platform behavior. Linux commonly reports `ECONNREFUSED` for connected UDP after an ICMP port-unreachable response. Other systems differ, and firewalls often drop traffic without sending ICMP.

ICMP Port Unreachable is an ICMP error message saying a host received traffic for a UDP port with no receiver. It is advisory network feedback, not a UDP-level response. UDP itself has no response packet for "closed port."

That difference affects debugging. A connected UDP send to a closed local port may produce `ECONNREFUSED` on one platform. The same code across a network may report nothing because an intermediate firewall dropped either the UDP datagram or the ICMP error. Treat ICMP visibility as a useful signal when present, not a delivery contract.

The port-unreachable path also has timing weirdness. The send callback can fire first because the local send completed. The ICMP error can arrive later and surface through the socket. Code that assumes "callback success means peer port exists" will misread connected UDP. A better local invariant is narrower: callback success means the local send request completed.

## Unicast, Broadcast, and Multicast

Unicast sends one datagram to one destination socket address. Most examples so far used unicast: `127.0.0.1:41234`, one destination address and one destination port.

Broadcast sends one IPv4 datagram to a broadcast address so hosts on the addressed local network can receive it, subject to interface, router, firewall, and socket policy. Node requires broadcast mode on the socket before sending to an IPv4 broadcast address.

```js
const socket = dgram.createSocket('udp4');

socket.setBroadcast(true);
socket.send('who is there?', 41234, '255.255.255.255');
```

`255.255.255.255` is the limited IPv4 broadcast address. Directed broadcast addresses such as `192.168.1.255` depend on the local network prefix and network policy. Many routed networks block broadcast forwarding. Local development often succeeds on one interface and fails on another because the route and interface choice changed.

Broadcast receivers are ordinary bound UDP sockets:

```js
const socket = dgram.createSocket('udp4');

socket.on('message', (msg, rinfo) => {
  console.log(msg.toString(), rinfo.address);
});

socket.bind(41234, '0.0.0.0');
```

Binding to the wildcard address gives the OS room to deliver datagrams received on suitable local IPv4 addresses. Binding to loopback will keep the socket in loopback-only behavior. Interface choice still belongs to the OS routing table and socket options.

Broadcast uses IPv4. IPv6 uses multicast for the neighboring and group-delivery cases where IPv4 code might reach for broadcast. That difference shows up immediately in Node because `setBroadcast()` is an IPv4 socket behavior. A `udp6` socket has multicast methods, not an IPv6 broadcast equivalent.

Directed broadcast needs the network prefix. On a `192.168.1.25/24` interface, the directed broadcast address is commonly `192.168.1.255`. On another prefix, the address changes. The OS route table and interface mask decide where a directed broadcast send goes. Routers often block directed broadcasts because they can amplify traffic.

Broadcast packets are also easy to lose inside virtualized setups. Docker bridge networks, VM host-only adapters, corporate Wi-Fi isolation, and VPN clients can each change broadcast reachability. A Node process that sends correctly can still reach zero receivers because the local network policy drops the frame or prevents peer isolation.

Multicast sends one datagram to an IP multicast group address. A multicast group is an IP address range value that receivers join through the kernel. Senders target the group address. Receivers ask the kernel to deliver datagrams for that group on one or more interfaces.

```js
const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

socket.on('message', msg => {
  console.log(msg.toString());
});

socket.bind(41234, () => {
  socket.addMembership('239.255.0.1');
});
```

`239.255.0.1` is in the administratively scoped IPv4 multicast range. The exact group address should belong to the protocol or environment you control. Random multicast groups can collide with other software on the same network.

`addMembership()` tells the kernel to join the multicast group. When you pass only the group address, the OS chooses eligible interfaces. Passing an interface address makes the membership more explicit.

```js
socket.bind(41234, () => {
  socket.addMembership('239.255.0.1', '192.168.1.25');
});
```

That second argument is a local interface address for IPv4. IPv6 multicast interface selection uses IPv6 rules and may require a scoped interface name in some calls. Platform behavior is detailed enough that production multicast code usually needs environment-specific tests.

Leaving a group is explicit:

```js
socket.dropMembership('239.255.0.1');
```

Closing the socket also releases membership state for that socket, but explicit leave calls make long-running processes easier to reason about when subscriptions change at runtime. A process that joins several groups should track which socket joined which group on which interface.

Sending multicast uses the same call shape as a normal UDP send to the group address:

```js
const socket = dgram.createSocket('udp4');

socket.setMulticastTTL(1);
socket.send('announce', 41234, '239.255.0.1');
```

`setMulticastTTL()` controls how far multicast packets can travel in hop-count terms. A value of `1` keeps the packet on the local network segment in common setups. Higher values enter routing policy that many networks restrict or disable. Multicast routing protocols sit outside this chapter.

`setMulticastLoopback(false)` controls whether the sender can receive its own multicast datagrams on the same host. Default behavior can surprise local tests because a process may observe its own announcements.

`reuseAddr` matters with multicast because multiple receivers on one host may need to bind the same port to receive the same group traffic. On Unix-like systems this maps to address reuse behavior with platform-specific details. On Windows, semantics differ in places. Chapter 9.6 owns the socket-option layer; here, the useful rule is simple: multicast examples commonly create sockets with `{ reuseAddr: true }` because several listeners may share the multicast port.

Broadcast and multicast have a security boundary too. They are local-network mechanisms more than Internet mechanisms. Containers, VM networks, cloud VPCs, host firewalls, Wi-Fi isolation, and VPN routes can all change whether packets leave, arrive, or loop back. Node exposes the socket calls. The network decides the reachability.

Multicast also has a port dimension. Joining a group controls which group traffic the kernel can deliver. Binding controls which local UDP port the socket receives. Senders usually target the group address plus the shared protocol port. A receiver that joins the right group on the wrong port will stay quiet.

```js
socket.bind(9999, () => {
  socket.addMembership('239.255.0.1');
});
```

That receives datagrams sent to group `239.255.0.1` on port `9999`, subject to interface and network policy. A sender using port `41234` is a different UDP socket address.

## Failure Shapes

UDP failures are often silent.

A TCP connection attempt can fail during establishment. A TCP write can later fail because connection state changed. UDP has no connection establishment. An unconnected UDP send to a valid-looking address can complete locally while the datagram disappears before any receiver sees it.

The first debugging split is local failure versus remote absence.

Local failures happen while Node or the OS handles your socket operation. Bad arguments throw. Bind conflicts produce errors. DNS lookup can fail before send. Oversized datagrams can produce `EMSGSIZE`. Sending after close can fail through Node's socket state. Those failures are visible because they occur on the local path.

Remote absence is different. A process may be listening on the wrong port. A host firewall may drop inbound UDP. A NAT rule may omit the mapping. A receiver may drop packets because its socket receive buffer is full. An intermediate device may drop fragments. Your send callback can still report success because the local kernel accepted the datagram for transmission.

The third category is local success with remote rejection feedback. ICMP Port Unreachable sits there. A remote host or local host can report that a UDP port is closed. The report is separate from the original UDP datagram. It may arrive late. It may be filtered. It may be delivered to the socket in platform-specific ways. Connected UDP gives the kernel a clearer socket association, so errors are more likely to reach Node.

Classifying failures by where they surface keeps the logs readable:

```text
argument or state error
  -> Node throws or calls back with error
bind/send kernel error
  -> error event or callback error
remote/path drop
  -> no Node event
ICMP feedback
  -> platform-dependent socket error
```

The absence of an event is data only after the local path has been checked. Before that, silence could mean the process is bound to the wrong address, the sender used another family, DNS resolved differently, the datagram exceeded local size limits, or the receiver's handler never ran because the process exited.

Use the smallest local test first:

```js
socket.on('message', (msg, rinfo) => {
  console.log(msg.length, rinfo.address, rinfo.port);
});

socket.bind(41234, '127.0.0.1');
```

Loopback removes interface routing, Wi-Fi policy, and remote firewall behavior. It still exercises Node, libuv, the kernel UDP socket path, port binding, and message event delivery. After loopback works, bind to a real interface address or wildcard address and test from another process on the same host. Then move to another host on the same network. Each step adds one layer of possible loss.

Two local processes are better than one process pretending to be both sides. A single process can accidentally share variables, exit too early, or hide ordering problems because all callbacks run through one event loop. Separate processes force the reply path through real socket state.

Receiver:

```js
const socket = dgram.createSocket('udp4');

socket.on('message', (msg, rinfo) => {
  console.log(msg.toString(), rinfo);
});

socket.bind(41234, '127.0.0.1');
```

Sender:

```js
const socket = dgram.createSocket('udp4');

socket.send('probe', 41234, '127.0.0.1', err => {
  if (err) console.error(err.code);
  socket.close();
});
```

After that works, keep the receiver unchanged and move the sender to another terminal. Then change only the bind address. Then change only the target host. That kind of test progression sounds dull because it is dull. It also keeps DNS, routing, binding, and parser bugs from collapsing into one silent UDP failure.

When a test crosses hosts, log both endpoints. On the receiver, log `rinfo`. On the sender, log `socket.address()` after bind or after the first send callback. The two logs should form a pair: sender local address and port on one side, receiver `rinfo` on the other. NAT, containers, and wildcard binds can make those values differ from what you expected.

Use numeric addresses while isolating UDP. A hostname target mixes DNS behavior into the send path, and Chapter 9.2 already showed how address family and result ordering can change connection behavior. With UDP, that mix can be extra confusing because there is no connect-time failure for an absent receiver. `127.0.0.1` and `::1` are different families. A `udp4` socket sending to `localhost` may behave differently from a `udp6` socket sending to the same name.

The second split is receive path versus send path.

For receive bugs, check the bound local address and port. `socket.address()` reports what the OS assigned. A socket bound to `127.0.0.1` will receive loopback traffic, not traffic sent to the host's LAN address. A socket bound to `0.0.0.0` can receive on suitable IPv4 local addresses, subject to firewall policy.

```js
socket.on('listening', () => {
  console.log(socket.address());
});
```

Check whether another process owns the port. On Linux, `ss -lunp` shows UDP sockets with local addresses and process data when permissions allow it. `ip addr` shows interface addresses. `ip route` shows route selection. Packet capture tools can show whether the datagram reaches an interface, but capture output belongs to a debugging workflow rather than Node semantics.

For local server bugs, log from the `listening` event rather than assuming the bind succeeded:

```js
socket.on('listening', () => {
  const { address, port, family } = socket.address();
  console.log({ address, port, family });
});
```

That output anchors the process to an actual local socket address. If the address is `127.0.0.1`, remote hosts have the wrong target. If the family is IPv6, an IPv4 sender has the wrong family. If the port differs from the expected value, an implicit bind or test setup changed the endpoint.

For send bugs, log the destination address, destination port, local socket address after bind or implicit bind, and callback error. Hostnames add DNS behavior, so switch to a numeric address while isolating UDP behavior. Large messages add fragmentation or size rejection, so test with a tiny payload while isolating routing and binding.

```js
socket.send('x', 41234, '192.0.2.10', err => {
  console.error(err?.code ?? 'sent locally');
});
```

`sent locally` means the local send request completed. It says nothing about a remote handler.

For protocol bugs, add a tiny header with version and message type before adding anything more complex:

```js
const msg = Buffer.from([1, 3, 0, 0]);

socket.send(msg, 41234, '127.0.0.1');
```

Version and type fields make packet captures and logs easier to line up. They also give the receiver a cheap rejection path for old senders. Keep the point narrow: UDP gives you bytes, so the protocol has to make those bytes self-describing enough for your deployment.

Receive buffer overflow is the failure that looks most unfair during load tests. The receiver process is alive. The socket is bound. Small tests pass. Under burst traffic, messages vanish. The kernel receive queue filled while JavaScript was busy or while the process could not be scheduled fast enough. UDP drops the excess. Node emits no event for datagrams the kernel discarded before Node read them.

```js
socket.on('message', msg => {
  while (expensiveWork(msg)) break;
});
```

CPU-heavy message handlers make that bug easy to reproduce. Move expensive work off the receive path, batch carefully, or use a protocol with explicit backpressure when the sender needs feedback. Bigger receive buffers can buy time, but the receiver still has a finite queue.

Another common receive failure is handler allocation pressure. A high-rate UDP listener that allocates objects per packet, parses JSON per packet, and writes logs per packet can fall behind even when the network rate looks modest. The kernel drops datagrams before JavaScript sees them, so application-level counters undercount attempted traffic. Compare sender-side counts, receiver-side counts, and host-level UDP drop counters when the platform exposes them.

The Node process can also lose messages during startup and shutdown. A sender can transmit before the receiver has completed bind. The receiver has no socket state yet, so the datagram has no application endpoint. During shutdown, closing the socket releases the port while senders may still be sending. UDP gives no close handshake to coordinate that transition.

ICMP errors form the third split. With unconnected UDP, many platforms deliver ICMP Port Unreachable in ways Node may not associate with a specific socket operation. With connected UDP, the kernel has a peer tuple attached to the socket, so it has a better place to report the error. Even then, firewall and platform behavior decide what arrives.

```js
const socket = dgram.createSocket('udp4');

socket.on('error', err => console.error(err.code));
socket.connect(9, '127.0.0.1', () => {
  socket.send('test');
});
```

Port `9` may be closed on your machine. On Linux, that can produce `ECONNREFUSED` after the local stack receives an ICMP Port Unreachable. On another OS, or across a firewall, the same test may produce no error. The absence of an error is normal UDP behavior.

Broadcast and multicast add their own failure shapes. Broadcast send requires `setBroadcast(true)`. Multicast receive requires membership on the right group and interface. Multiple local multicast receivers often need `reuseAddr`. VM and container networks may suppress broadcast or multicast. Cloud networks commonly restrict both. A local process can be correct and still observe no packets because the network layer dropped that traffic class.

A final failure class comes from treating UDP as a stream. A receiver that expects a large logical record to arrive across several datagrams needs application framing across those datagrams. UDP will deliver each datagram separately. If one datagram is lost, the logical record has a missing piece. If datagrams reorder, the logical record needs sequence data. If duplicates arrive, the assembler needs duplicate handling. Those choices belong to the protocol above UDP.

For many backend services, the right answer is to keep UDP messages independent. Metrics packets, local discovery announcements, health probes, and some telemetry messages can tolerate missing samples. The data model accepts absence. A request that changes money, inventory, access control, or user-visible state usually needs stronger semantics than raw UDP gives by itself.

The practical debugging loop stays boring:

```text
verify bind address and port
  -> verify tiny numeric-address send
  -> verify local receive event
  -> verify interface and route
  -> verify firewall and network policy
```

UDP gives Node a precise local API and a loose delivery contract. The API can tell you when the socket bound, when one datagram arrived, when a local send request completed, and when the OS reported an error. Delivery, ordering, duplicate suppression, and peer readiness live above that API or outside the host.

That is the line to keep. `node:dgram` is a clean wrapper around datagram sockets. The hard part is remembering how little a successful UDP send proves.
