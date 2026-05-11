---
title: "TCP Connections, Flow Control, and Failure Modes"
date: "2026-05-11"
excerpt: "How TCP connections move through handshake, ordered delivery, flow control, shutdown, and the error codes Node reports when the transport breaks."
category: "Network Fundamentals with Node.js"
tags: ["nodejs", "networking", "tcp", "sockets", "flow-control"]
author: "Ishtmeet Singh @ishtms"
chapter: "networking"
subchapter: "tcp-flow-failure"
published: true
toc: true
---

`ECONNRESET` is a JavaScript error report for lower TCP state. The stack trace points at Node because Node is where the error reaches your code. The transport decision already happened in the socket layer.

```text
Error: read ECONNRESET
    at TCP.onStreamRead (node:internal/stream_base_commons:216:20)
```

A peer sent a reset. Or a local write hit socket state that had already moved into reset. Node read the kernel result, wrapped it as a system error, and emitted it through the `net.Socket`.

The same shape applies to `ECONNREFUSED`, `ETIMEDOUT`, and `EPIPE`. The JavaScript error is the report. The TCP connection state is the source.

Chapter 9.1 set up the OS socket boundary. Chapter 9.2 covered names becoming addresses. After that address exists, TCP takes over. It creates a connection, numbers bytes, resends missing data, applies flow control, tears down both directions, and reports failure when the state machine reaches a broken edge.

## A TCP Connection Is Kernel State

A TCP connection is the operating system's transport state for one ordered byte stream between two socket addresses. The connection is identified by protocol plus local IP, local port, remote IP, and remote port. Both endpoints keep their own state for that same connection.

Node wraps one endpoint.

```js
import net from 'node:net';

const socket = net.connect(5432, '127.0.0.1');

socket.on('connect', () => {
  console.log(socket.localPort);
});
```

`net.connect()` asks the OS to create a TCP socket and connect it to the remote socket address. The printed local port is selected by the OS unless the program supplied one. The JavaScript object becomes useful after the kernel connection reaches established state and Node emits `connect`.

Connection state is the current TCP lifecycle position for one endpoint. It includes setup, established transfer, shutdown, reset, and waiting states. The names vary by tool output and platform, but the common states are familiar if you've used `ss` or `netstat`: `SYN-SENT`, `SYN-RECEIVED`, `ESTABLISHED`, `FIN-WAIT`, `CLOSE-WAIT`, `LAST-ACK`, `TIME-WAIT`, and `CLOSED`.

Node exposes a smaller surface. `connect` means the local endpoint reached an established connection. `data` means bytes were read from the socket receive path. `end` means the peer sent an orderly end of its write side. `error` means the socket operation failed. `close` means the JavaScript wrapper has finished closing.

Those events compress a lot of state.

```text
JavaScript net.Socket
  -> Node native TCP wrapper
  -> libuv TCP handle
  -> OS TCP socket
  -> peer OS TCP socket
  -> peer program
```

TCP presents an ordered byte stream. It preserves byte order across the connection. It delivers bytes to the application in sequence. It tracks missing ranges and retransmits. It also hides TCP segment boundaries from the application. A peer reading from Node sees chunks created by its own receive path, buffer state, and stream reads.

```js
socket.write('abc');
socket.write('def');
```

The peer can receive `'abcdef'` in one `data` event, `'abc'` and `'def'` in two events, or smaller chunks. TCP kept the byte order. It presented a continuous byte sequence rather than application write boundaries.

That fact shapes every protocol built on top. HTTP, Redis, Postgres, and your own binary protocol all need their own framing rules above TCP. Chapter 10 owns HTTP framing. Here the transport rule is enough: TCP carries ordered bytes.

## The Handshake Creates the Connection

The three-way handshake is the TCP setup exchange that creates synchronized state on both endpoints before application bytes move. It uses three control messages:

```text
client -> server: SYN
server -> client: SYN-ACK
client -> server: ACK
```

`SYN` asks to start a connection and carries the sender's initial sequence number. `SYN-ACK` accepts that start and carries the server's initial sequence number while acknowledging the client's `SYN`. `ACK` acknowledges the server's start. After that, both sides have enough sequence state to send ordered bytes.

For an outbound Node client, the path is roughly:

```text
net.connect()
  -> local socket created
  -> SYN sent
  -> SYN-ACK received
  -> ACK sent
  -> 'connect' emitted
```

The JavaScript callback runs after the kernel handshake succeeds. If the peer rejects the attempt, the callback never reaches `connect`.

```js
import net from 'node:net';

const socket = net.connect(1, '127.0.0.1');

socket.on('error', err => {
  console.error(err.code);
});
```

On a typical machine with no listener on port `1`, this prints `ECONNREFUSED`. The destination host answered the TCP attempt with a refusal, commonly a reset, because no listening socket accepted that address and port. The exact path depends on OS policy and firewall rules, but the meaning for Node is narrow: the remote endpoint actively rejected the connect attempt.

For an inbound server, the lower path starts before JavaScript sees a socket:

```text
listening socket
  -> SYN received
  -> SYN-ACK sent
  -> ACK received
  -> connected socket queued
  -> Node accepts
  -> 'connection' emitted
```

The backlog and accept queue belong to Chapter 9.6. The handshake still matters here because `net.createServer()` runs your connection callback after the OS has enough connection state to return an accepted connected socket.

A refused connection happens before a connected `net.Socket` exists. A reset can happen after connection. A timeout can happen while the local OS keeps trying to complete setup. Those differences matter in logs because they point at different state transitions.

## Refusal Happens Before the Socket Becomes Useful

`ECONNREFUSED` is a setup failure. The client picked a local endpoint, targeted a remote socket address, sent a connection attempt, and got an active rejection. The socket object in JavaScript exists, but the connection never reached the established transfer state.

The local loopback case is the cleanest way to see it:

```text
client: SYN to 127.0.0.1:65000
kernel: no matching listener
kernel: reject attempt
Node: emit error ECONNREFUSED
```

The phrase "matching listener" means same protocol, address family, local address binding rules, and port. A server listening on `127.0.0.1:3000` accepts IPv4 loopback traffic for that port. A client connecting to `::1:3000` targets IPv6 loopback. The port number matches, but the address family targets different socket state. Chapter 9.1 covered that address-family split; TCP connection setup uses it directly.

Remote refusal is the same connection-stage category with more network in the path. The SYN reaches the target host or a device acting for that target. Something sends back a reject signal. Node receives a failed connect result. Your `connect` handler stays silent because the socket never became established.

Firewalls change the shape. A firewall can reject, which gives the client a fast failure. It can also drop, which gives the client silence. Silence leads to retransmitted SYNs and then a timeout path. Both look like "connect failed" in the application, but they describe different lower behavior.

That split is why connection logs should include elapsed time. A refusal often returns quickly on reachable hosts. A timeout usually takes longer because the local TCP stack retries before giving up. Exact durations come from OS settings, routing, firewall behavior, and Node-level deadlines.

```js
import net from 'node:net';

const started = Date.now();
const s = net.connect(65000, '127.0.0.1');

s.on('error', err => {
  console.error(err.code, Date.now() - started);
});
```

The elapsed time is crude, but it separates fast rejection from long silence. For local loopback, refusal is usually immediate. For filtered remote paths, the delay can be much longer. That distinction changes the next debugging move: inspect the listener for fast refusal, inspect route and filtering for silence.

## Sequence Numbers Make Bytes Recoverable

A sequence number is TCP's byte position marker. Each endpoint numbers its outgoing byte stream. ACKs report which bytes the receiver has accepted in order. TCP can then detect gaps, keep later data until missing data arrives, and retransmit missing ranges.

The useful model is byte ranges rather than application writes.

```text
client sends bytes 1000..1499
server ACKs 1500
client sends bytes 1500..1999
server ACKs 2000
```

An ACK says the receiver has accepted every byte before the acknowledged number. `ACK 1500` means bytes through `1499` arrived in order. If bytes `1500..1999` disappear in the network, the sender still has enough state to send that range again.

Retransmission is TCP sending a byte range again after the sender believes the previous transmission failed. The trigger can be a timeout, duplicate ACK behavior, or other implementation details. The kernel's TCP implementation owns that work.

Packet loss usually appears in Node as delay. The application sees no exception when one TCP segment disappears and the kernel later recovers by retransmission. The read just arrives later. The write callback can still fire because the local stack accepted the bytes. The peer's application can still process the data once the missing range is repaired.

Round-trip time, or RTT, is the measured time for data to travel to the peer and for an acknowledgment to come back. TCP uses RTT estimates to set retransmission timers and adjust sending behavior. High RTT stretches the time between sending data and learning what the peer received. Variable RTT makes timeout decisions harder for the kernel.

```text
write accepted locally
  -> segment sent
  -> ACK delayed or lost
  -> retransmission timer adjusted
  -> missing bytes sent again
  -> peer delivers ordered bytes
```

Node sees the upper edge of that process. A `data` event arrives late. A request appears slow. A socket stays open. No error fires because the connection still works according to TCP.

Sequence numbers also explain why TCP can receive data out of order internally while the application still reads ordered bytes. The kernel can receive byte range `2000..2499` before `1500..1999`, keep the later range in receive state, and wait for the missing range. JavaScript receives bytes after the hole is filled.

That behavior is useful, and it hides pain. A production service can have packet loss, retransmissions, and poor throughput while Node reports a healthy connected socket. Transport recovery is happening below the application. You need OS counters, packet captures, or timing data to see it clearly.

ACKs are transport state. They report byte positions at the TCP layer. They carry zero information about whether the remote application parsed the bytes, stored them, committed a transaction, or sent a response.

That boundary matters for every write-heavy client:

```js
socket.write(payload, err => {
  if (err) throw err;
  markSent(payload.id);
});
```

`markSent()` is a dangerous name there. The callback can mean the local write path finished its part. A better name would say what the program knows: the bytes were accepted locally or the write failed locally. Application delivery still needs a protocol response from the peer.

TCP acknowledgments can arrive before the peer application sees the bytes. The peer kernel can accept bytes into its receive buffer and ACK them. The peer process may run later. If that process crashes after the ACK and before application handling, the sender has no TCP-level reason to resend those bytes. The transport did its job. The protocol above TCP must handle semantic confirmation.

Sequence space also includes control signals. `SYN` and `FIN` consume sequence positions in TCP's accounting. You rarely need that detail in Node code, but it explains why handshake and shutdown participate in the same ordered state machine as data transfer. The endpoints are not only exchanging payload bytes; they are synchronizing a byte stream plus control transitions.

Retransmission also creates duplicate arrivals below the application. The receiving TCP stack uses sequence numbers to discard duplicate byte ranges it has already accepted. JavaScript usually never sees those duplicates. If a packet was lost after the receiver ACKed it, the sender might retransmit because the ACK got lost. The receiver can recognize the repeated sequence range and keep the byte stream clean for the application.

Here is the shape:

```text
receiver gets bytes 1000..1499
receiver sends ACK 1500
ACK disappears
sender retransmits 1000..1499
receiver discards duplicate range
```

The application reads one copy. TCP carried duplicate protocol traffic to recover from uncertainty, and the receive side suppressed duplicate bytes before Node saw them.

Delayed delivery is the normal application symptom. The kernel can wait for missing bytes, reorder internal ranges, retransmit, and then expose clean ordered data. A Node program reading the socket sees a late chunk. It usually cannot tell whether the delay came from retransmission, peer scheduling, receiver backpressure, or the application above the peer's socket.

That is the right abstraction for most code. It becomes a problem when logs treat late data as proof of a slow peer application. The peer application might be fast while the path is losing segments. Or the path might be fine while the peer process is blocked before it reads. TCP hides both behind the same byte stream.

## One Write Becomes Several TCP Decisions

Take one write from a connected Node client:

```js
socket.write(Buffer.alloc(32 * 1024));
```

The call gives Node 32 KiB of application bytes. The stream layer accepts the chunk or queues it. Native code submits write work through libuv. The OS socket path accepts some or all of the bytes into the TCP send buffer. TCP then decides how to place those bytes into segments.

Several limits apply below the JavaScript call. The path MTU limits packet size. The peer receive window limits how far the sender can advance without overflowing the receiver. Congestion control limits how much data the sender places into the network before ACK feedback arrives. The sender's own buffer space limits how much the OS can hold.

The lower trace might look like this:

```text
app bytes 0..32767 accepted locally
TCP sends 0..1447
TCP sends 1448..2895
peer ACKs 2896
TCP sends more ranges
```

Those byte ranges are illustrative. Actual segment sizes depend on MSS, offload, path behavior, and platform settings. The visible Node fact remains smaller: your one write entered the socket path. TCP may emit many segments, receive many ACKs, retransmit some ranges, and only later free send-buffer space.

The peer reads a byte stream:

```text
peer kernel receives ranges
peer TCP orders them
peer receive buffer stores bytes
peer Node process reads chunks
```

The peer's `data` event might contain 32 KiB, 16 KiB, 1 KiB, or any other chunking produced by its receive path. TCP's sequence state protects order. Node's stream machinery decides chunk delivery to JavaScript.

ACK timing can also interact with application writes. Suppose the sender writes 32 KiB, then immediately writes another 32 KiB. The local stream can accept both chunks while the kernel is still waiting for ACKs from the first ranges. The second write can sit in Node's queue, libuv state, or the kernel send buffer depending on timing. When the peer window opens, the lower layers continue. JavaScript sees `drain` only after the Node-side queue falls under its threshold.

That trace explains a common production log:

```text
write returned false
drain after 240ms
response after 900ms
```

The first line is local stream pressure. The second line means local production can resume. The third line is application protocol progress. Treating all three as "network was slow" throws away the useful separation.

## Flow Control Crosses Into Node Backpressure

Flow control is TCP's receiver-driven limit on how much data the sender may have in flight for a connection. The receiver advertises available receive space. The sender keeps its outstanding bytes within that advertised limit.

The advertised limit is the receive window. It is based on the receiving endpoint's buffer space and TCP state. When the application reads quickly, the receive buffer drains and the window can stay open. When the application stops reading, the receive buffer fills and the window shrinks. A zero or tiny window tells the peer to slow down at the TCP layer.

```text
peer application writes bytes
  -> peer kernel send buffer
  -> network
  -> local kernel receive buffer
  -> Node reads into stream
  -> JavaScript consumes chunks
```

A receive buffer is kernel memory holding bytes that arrived for a socket and are waiting for the application to read them. A send buffer is kernel memory holding bytes accepted from the application and waiting for transmission, acknowledgment, or retransmission.

Node stream backpressure, covered in Chapter 3, sits above those buffers. The stream has its own queue and `highWaterMark`. The kernel has send and receive buffers. TCP has a receive window. These are separate signals that can influence one another.

```js
const server = net.createServer(socket => {
  socket.pause();
});
```

That handler accepts a connection and then stops reading from the JavaScript stream. Bytes can still arrive for a while. The kernel receive buffer can fill. Node may also have already pulled some bytes into stream buffers before `pause()` takes effect. Once lower buffers tighten, TCP advertises less receive space to the peer.

The sender sees pressure through its own write path.

```js
import net from 'node:net';
const server = net.createServer(s => s.pause());
server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  const c = net.connect(port, '127.0.0.1', () => {
    while (c.write(Buffer.alloc(64 * 1024))) {}
    console.log('write pressure'); c.destroy(); server.close();
  });
});
```

That loop writes until Node's writable side says to stop. The `false` return is a stream-level signal. It means only that the local writable queue crossed its threshold. The peer application and peer kernel have separate state. The producer should wait for `drain` before continuing.

Below that signal, the local kernel send buffer also has finite capacity. Node may hand bytes to the OS until the OS accepts less, accepts none for now, or reports an error. libuv integrates that with non-blocking writes. JavaScript gets callbacks and `drain` later when the upper queue has moved enough data downward.

Flow control is the remote receive side pushing back through TCP state. Stream backpressure is Node pushing back through JavaScript APIs. Both can appear during the same slowdown, but they are owned by different layers.

The layers line up like this:

```text
JavaScript producer
  -> Writable stream queue
  -> Node/libuv write request
  -> kernel send buffer
  -> TCP flight governed by peer receive window
  -> peer kernel receive buffer
  -> peer JavaScript consumer
```

A successful `socket.write()` means Node accepted the chunk into its write path. A `true` return means the stream buffer is still under its threshold. A write callback means the chunk was flushed from Node's user-space write tracking into the local system path. None of those signals prove the peer application processed the bytes.

The peer can be slow in several places. Its JavaScript code can be busy and delay reads. Its process can be paused. Its kernel receive buffer can fill. Its TCP receive window can shrink. The network path can be lossy. Your local send buffer can accumulate data. Node's stream queue can cross `highWaterMark`.

The visible symptom might be only this:

```js
if (!socket.write(chunk)) {
  await once(socket, 'drain');
}
```

That pattern remains the right JavaScript behavior. It respects Node's stream contract. It also keeps memory bounded while the lower transport negotiates buffer space. Treat `drain` as permission to resume local production, not as confirmation that the peer made semantic progress.

Receive pressure works the other direction. When your Node program reads from a socket and then writes into a slower destination, `stream.pipeline()` can connect the pressure between streams. At the TCP layer, slowing reads can eventually reduce the advertised window. The peer might keep the connection open while sending far less data. No exception is required. The connection is obeying flow control.

That can feel strange during debugging. A request hangs, CPU is low, and there is no error. The socket may be waiting because a buffer below JavaScript has no useful space, or because the peer's receive window is small, or because retransmission and congestion behavior are reducing progress. Node only reports an error when TCP state fails, not when TCP is waiting legally.

The buffer chain has three owners on the sending side:

```text
Node stream buffer
libuv write requests
kernel TCP send buffer
```

The stream buffer is JavaScript-facing. It drives the `write()` return value and `drain`. libuv write requests are native operation records waiting for the OS path to accept or complete work. The kernel send buffer is TCP-facing. It holds byte ranges that may be unsent, sent but unacknowledged, or waiting for retransmission.

Those owners move at different speeds. Node can accept many chunks from JavaScript, then feed them into libuv writes. The OS can accept some bytes into the send buffer and leave the rest pending. TCP can send some byte ranges while holding others because the peer receive window or congestion state limits progress.

The receive side has its own chain:

```text
kernel TCP receive buffer
Node native read path
Readable stream buffer
JavaScript consumer
```

The kernel receive buffer is filled by TCP after sequence checks. Node reads from it when libuv reports readability. The Readable stream buffer stores chunks until JavaScript consumes them. If the JavaScript consumer stops, Node can stop pulling from the kernel. The kernel receive buffer then fills, and the advertised receive window shrinks.

Backpressure can therefore begin in JavaScript and become transport behavior. A slow parser, a blocked transform, or an application choosing to pause a socket can eventually reduce the receive window. The peer sees that as limited TCP receive space. It does not know your parser is busy. It only sees the window and ACK pattern.

The reverse is also true. Transport pressure can become JavaScript backpressure. If the peer's receive window is tiny, your local kernel send buffer drains slowly. Node write requests complete slowly. The Writable stream queue stays high longer. `write()` returns `false` more often. JavaScript sees a local stream signal caused by remote receive pressure.

That is why backpressure-aware code helps even though it cannot see every layer.

```js
import { once } from 'node:events';

async function send(socket, chunks) {
  for (const chunk of chunks) {
    if (!socket.write(chunk)) await once(socket, 'drain');
  }
}
```

The loop obeys the stream signal. It keeps application memory from growing without bound while the lower layers work through TCP limits. It makes no claim about remote processing. It just avoids making the local queue worse.

The wrong code is usually a tight producer that ignores the return value:

```js
for (const chunk of chunks) {
  socket.write(chunk);
}
```

That code can queue huge amounts of data in user space if the connection slows. The kernel may be applying valid flow control. The remote process may be alive. Your process can still create memory pressure because it treats a TCP socket as an infinite sink.

## Congestion Makes Working Connections Slow

Congestion control is TCP's sender-side behavior for limiting how aggressively it puts data into the network. Flow control protects the receiver's buffers. Congestion control protects the path between endpoints from being overloaded by that connection's sender.

The kernel owns congestion control. Linux, macOS, Windows, and container hosts may use different defaults and tuning. Chapter 9.6 mentions socket options; kernel congestion algorithms stay outside this book's normal Node API path.

For backend debugging, the working model is enough: the sender maintains a sending limit based on acknowledgments, packet loss, RTT, and algorithm state. When loss or delay suggests congestion, the sender reduces how much data it sends before receiving more ACKs. Throughput drops while the connection stays open.

```text
ACKs arrive steadily
  -> sender grows usable sending rate
loss or delay appears
  -> sender retransmits
  -> sender reduces sending rate
```

A slow upload over TCP may be a perfectly connected socket doing congestion control and retransmission. Node writes. The kernel accepts some data. Progress continues, but at a lower rate. Application timeouts may fire above the transport if your code sets them. TCP itself can keep trying as long as the OS considers the connection viable.

RTT changes the shape of the delay. With low RTT, a sender learns about delivered bytes quickly. With high RTT, every feedback loop stretches. A connection with the same packet loss rate can feel much worse across a longer path because acknowledgments and retransmission signals take longer to return.

The sharp edge is silence. TCP recovery is often quiet at the JavaScript layer. You get late `data`, delayed `drain`, or a request deadline from your own code. The socket can remain established the whole time.

When a log shows "socket connected" and then nothing for thirty seconds, separate three cases:

```text
peer application is slow
peer receive path is backed up
network transport is recovering or constrained
```

Those cases produce similar Node symptoms. They need different evidence. Application logs show handler progress. Socket buffer and TCP counters show transport pressure. Packet captures show retransmissions and ACK behavior. The Node object alone cannot tell you which owner is currently limiting progress.

## Orderly Shutdown Uses FIN

FIN is TCP's orderly end-of-data signal for one direction of a connection. When an endpoint sends `FIN`, it says its write side has ended. The peer can still send bytes in the other direction until it also closes its write side.

The common close path looks like this:

```text
local app ends writes
  -> local TCP sends FIN
  -> peer receives end-of-stream
  -> peer sends its own FIN later
  -> both FINs are ACKed
  -> connection closes
```

Node maps the peer's FIN to stream end behavior. On a `net.Socket`, the readable side can emit `end` when the peer has finished sending. The socket can still have write state depending on timing and API options. Chapter 9.4 owns the exact `net.Socket` methods and `allowHalfOpen`; the transport idea belongs here.

A half-open connection is a TCP connection where one direction has closed while the other direction remains open. At the transport level, one side has sent or received `FIN`, and the other side can still send data. Half-open state is normal during orderly shutdown. It becomes a bug when an application assumes both directions ended together.

```text
peer -> local: FIN
local readable side ends
local write side may still send
```

Some protocols use that shape deliberately. Many app protocols treat it as connection termination. Node gives you enough events to decide, but TCP itself treats the two directions separately.

TIME_WAIT is a TCP state kept after active close so late packets from the old connection can expire and final acknowledgments can be handled. The endpoint that performs the active close commonly enters `TIME_WAIT`. Duration and reuse rules depend on the OS.

TIME_WAIT often appears during local tests that create many short connections. The process closed its sockets, yet the OS still has connection state. That state can consume local ephemeral ports for a while. The application is gone from the code path, but the kernel is still protecting the old connection identity.

```text
ESTABLISHED
  -> FIN-WAIT-1
  -> FIN-WAIT-2
  -> TIME-WAIT
  -> CLOSED
```

Tool output can show many `TIME-WAIT` sockets after a load test. That state belongs to TCP teardown. It becomes operational pressure when ephemeral ports or socket-table capacity become constrained.

Orderly shutdown still has application risk. A peer can send `FIN` after sending a partial application message. TCP delivered ordered bytes and an end-of-stream. Your protocol parser must decide whether the message was complete. TCP can tell you the byte stream ended. It cannot tell you the application frame was complete.

The active closer usually pays the `TIME_WAIT` cost. "Usually" matters because simultaneous close and platform details can shift the exact state path, but the common client-server shape is easy to recognize. A client opens many short outbound connections, sends requests, actively closes, and then accumulates many `TIME-WAIT` entries using local ephemeral ports.

```text
client local port 50100 -> server 443
client closes
client keeps TIME-WAIT for that tuple
client opens more short connections
ephemeral range gets pressured
```

Connection pooling avoids part of that pressure by reusing established TCP connections for multiple application requests. HTTP agents and database pools own those choices later in the book. At the TCP level, the reason is simple: fewer connection teardowns means fewer recently closed tuples waiting in the kernel.

Servers can accumulate close states too. If the peer sends `FIN`, the local TCP endpoint can move into `CLOSE-WAIT` until the local application closes its side. A pile of `CLOSE-WAIT` sockets usually means the application received peer close and failed to close its own socket. Node code might have an event handler path that stops before `end()` or `destroy()`. The kernel is waiting for the local process to finish the close.

```text
peer sends FIN
local TCP enters CLOSE-WAIT
Node emits end
application leaves socket open
CLOSE-WAIT remains
```

That state is different from `TIME-WAIT`. `TIME-WAIT` is a completed active-close waiting period owned by TCP. `CLOSE-WAIT` means the peer ended its write side and the local application still owns a socket that needs closure. One is normal teardown residue. The other often points at application cleanup.

Node event order can expose the distinction:

```js
socket.on('end', () => console.log('peer ended'));
socket.on('close', () => console.log('closed'));
```

An `end` without a later `close` in your expected time window deserves inspection. Maybe the protocol allows half-open behavior. Maybe the code forgot to close. Maybe a pending write is still flushing. Chapter 9.4 covers the API switches; the transport state here explains the symptom.

FIN also interacts with buffered writes. If your program calls `socket.end('bye')`, Node queues the bytes and then ends the write side. The local TCP stack sends the data before the FIN in the ordered byte stream. The peer reads the bytes, then sees end-of-stream. If the connection resets before those bytes are sent or acknowledged, the orderly model stops and error handling takes over.

## Abrupt Shutdown Uses RST

RST is TCP's reset signal. It aborts connection state instead of performing orderly end-of-stream shutdown. A reset tells the peer to discard the connection state. Node often reports that as `ECONNRESET`.

Resets happen for several reasons:

```text
write reaches a peer that has reset state
peer process destroys socket abruptly
middlebox rejects existing flow
local OS receives data for a closed connection
```

The middle item can happen with Node code. When the point is a TCP reset in Node v24, use the reset-specific API:

```js
socket.resetAndDestroy();
```

`resetAndDestroy()` closes the TCP connection by sending `RST`, then destroys the stream state. `destroy()` still tears down the JavaScript socket path, but it is the general stream teardown API. The exact packets for `destroy()` depend on timing and platform state. Chapter 9.4 covers both APIs in detail. At the TCP level, the peer loses the connection state and later operations can fail.

Here is a small client-side shape:

```js
const c = net.connect(port, '127.0.0.1', () => {
  c.write('hello');
});

c.on('error', err => {
  console.error(err.code);
});
```

If the server resets immediately, the client may see `ECONNRESET`. Timing changes the exact operation that reports it. A read may fail. A later write may fail. The reset can be received between JavaScript turns and surface on the next socket operation.

That timing explains a common debugging trap: the line that logs `ECONNRESET` is often downstream of the cause. The cause may be the peer closing abruptly earlier, a protocol violation that made the peer reject the connection, an idle timeout in the path, or local code destroying the socket because an upper layer gave up.

`EPIPE` is the broken-pipe style error reported when writing to a connection whose peer or local state can no longer accept writes. On Unix-like systems, the name comes from pipe behavior, but Node can expose it for sockets too. The practical reading is direct: the write side is broken at the OS boundary.

```text
peer has closed or reset
local code writes anyway
OS rejects the write
Node reports EPIPE or ECONNRESET by timing and platform
```

Use the code as a clue, then inspect the order of events. The socket may have emitted `end` before your write. Your own timeout may have called `destroy()`. The peer may have sent a protocol-level error and closed. An upstream proxy may have cut an idle connection. The TCP error names the failed operation, not the full story.

RST is also how TCP rejects data that arrives for state it cannot accept. A host may receive a segment for a connection tuple that no longer exists. It can send a reset to tell the peer to stop using that tuple. From the sender's view, the connection was alive in its local state until the reset arrived. From the receiver's view, the tuple was already invalid.

That asymmetry shows up after process crashes, restarts, and fast reconnects. A server process can exit and lose its sockets. The client still has an established connection locally for a short time. The next client write reaches a host that has no matching connection state, or a new listener with no knowledge of the old tuple. The client then sees reset or broken-pipe behavior.

```text
client thinks ESTABLISHED
server process exits
server TCP state disappears or resets
client writes again
client observes reset or write failure
```

The phrase "the server restarted" often hides this lower sequence. A new process listening on the same port handles new connections. It does not inherit the old established TCP state unless a supervisor performed specialized descriptor handoff for listeners, and even then existing connected sockets need explicit ownership. Ordinary restarts break existing connections.

Reset timing also affects protocol retries. If a client sends a request and gets `ECONNRESET` before any response bytes, the request may or may not have reached the peer application. TCP cannot answer that. The reset only says the transport state ended abruptly. Safe retry decisions depend on the application protocol, idempotency, and request semantics. Chapter 27 owns those policies.

## Refused, Reset, Timed Out, Broken Pipe

`ECONNREFUSED` means a connection attempt reached a host that actively rejected the target socket address. The common local case is a closed port.

```js
import net from 'node:net';

const s = net.connect(65000, '127.0.0.1');

s.on('error', err => {
  console.error(err.code);
});
```

If no process listens there, the local host usually refuses quickly. A firewall can change the symptom by dropping traffic instead of rejecting it. Dropped packets usually lead to waiting and eventual timeout rather than a fast refusal.

`ETIMEDOUT` means the operation exceeded the OS or Node timeout path without completing. For connect attempts, it often means the local TCP stack sent `SYN` packets and never received a usable response. Firewalls, routing problems, dead hosts, and filtered ports can all produce that shape.

```text
SYN sent
  -> no SYN-ACK
  -> retransmit SYN
  -> still no response
  -> timeout reported
```

Node can also have application-level socket timeouts through APIs covered later. Keep the source separate. A TCP connect timeout comes from connection establishment failing to complete. A `socket.setTimeout()` event is a JavaScript timer around inactivity. An HTTP client deadline belongs above TCP.

`ECONNRESET` means established connection state was aborted. A peer reset, a local reset, or a path device can cause it. The socket was connected enough for reset semantics to matter. The failure often appears on read or write after the reset arrives.

`EPIPE` means a write hit a closed or broken write path. The peer may have already closed. The local socket may already know writes are invalid. The application attempted to send anyway.

A compact log-reading table helps:

| Code | Usual TCP position | Practical reading |
| --- | --- | --- |
| `ECONNREFUSED` | during connect | target actively rejected the socket address |
| `ETIMEDOUT` | during connect or OS-level send/keepalive timeout | an operation waited too long for transport progress |
| `ECONNRESET` | after connection exists | connection state was aborted |
| `EPIPE` | during write | write side was already broken |

Those are system errors. Node exposes OS-level `code` strings on error objects. The same application bug can produce different codes across platforms or timing windows. Treat the code as a state clue, then line it up with endpoint addresses, recent socket events, and upper-layer protocol logs.

Timeouts deserve their own stack because several layers use the same word.

```text
TCP retransmission timeout
TCP connect timeout
Node socket inactivity timeout
HTTP request deadline
application cancellation
```

A TCP retransmission timeout is internal to the kernel. It decides when a missing ACK has taken too long and a byte range or SYN should be sent again. Your Node code usually sees the consequence as delay.

A TCP connect timeout is the endpoint setup failing to complete in time. The OS sends SYNs, waits, retries according to its policy, and eventually reports failure. Node surfaces that as a connect error if no higher deadline acted first.

A Node socket inactivity timeout is created by JavaScript API calls. It watches for inactivity on the socket and emits a timeout event. The socket remains open until your code closes or destroys it. That event is a timer signal, not a TCP packet.

```js
socket.setTimeout(5000);
socket.on('timeout', () => {
  socket.destroy(new Error('idle socket'));
});
```

The code chooses to destroy the socket when inactivity crosses five seconds. The eventual peer symptom may be reset-like because local code aborted the connection. The source was an application timer.

An HTTP request deadline sits higher. It can close a TCP socket because an HTTP response took too long, even while TCP remained healthy. The resulting TCP error on the peer can look transport-level. The reason was protocol policy above TCP.

Cancellation has the same shape. An `AbortSignal` tied to a client operation can destroy a socket that TCP would otherwise keep using. The remote side might report `ECONNRESET` while the local side records "user aborted." Both are true at their layer.

Good timeout logs name the layer:

```text
connect timeout to 203.0.113.10:443
socket idle timeout after connect
HTTP response deadline exceeded
operation aborted by caller
```

Those messages save time because they identify who acted first. The TCP stack, Node socket timer, protocol client, and caller cancellation all produce connection teardown. Only one of them started the teardown.

Timeout ownership also affects cleanup. A connect timeout usually leaves you with a socket that never emitted `connect`. An idle timeout after establishment leaves you with a connected socket that your code chose to destroy. A request deadline can destroy a pooled connection that another part of the client hoped to reuse. The TCP error seen by the peer can be identical across those cases, while the local cause sits in a different layer.

That is why timeout metrics should be split by phase: connect, TLS later, request write, response headers, response body, and idle pool lifetime. This subchapter owns only the TCP pieces, but the habit starts here. Name the phase, then close the socket state you actually own.

## A Slow Reader Looks Different From a Broken Peer

Slow peers and broken peers both make writes uncomfortable. The difference is state.

With a slow reader, TCP still has a valid connection. The receiver advertises limited window space. The sender queues bytes, waits for ACKs and window updates, and progresses when room appears. Node may return `false` from `write()` and later emit `drain`.

```text
write returns false
  -> local queue drains slowly
  -> drain fires
  -> connection remains established
```

With a broken peer, the connection state has ended or reset. Writes fail. Reads may error or end. `drain` may never be the signal that matters because the underlying socket has moved to teardown.

```text
peer resets
  -> local socket records error
  -> next read or write reports ECONNRESET
  -> close follows
```

Logs should record state transitions in order:

```js
for (const name of ['connect', 'end', 'error', 'close', 'drain']) {
  socket.on(name, arg => console.log(name, arg?.code));
}
```

That snippet is intentionally crude. It shows event order. During real debugging, include endpoint fields too: `localAddress`, `localPort`, `remoteAddress`, `remotePort`, and the operation your code was doing when the event fired.

Timing matters because TCP state changes below JavaScript. A reset can arrive while your code is preparing the next write. A FIN can arrive after you queued data. A timeout can destroy a socket while a Promise chain still holds a reference. By the time the callback runs, the kernel state may already be ahead of your mental model.

## Reads, Writes, and What Success Means

`socket.write()` success is local acceptance. It says the data entered Node's writable path. It can also mean the data has already moved into the kernel path by the time a callback fires. Peer application reads require separate protocol evidence.

```js
socket.write('COMMIT\n', err => {
  if (err) console.error(err.code);
});
```

The callback reports the local write operation. For an application-level commit, you still need an application-level response. TCP can deliver bytes. The remote program decides what those bytes mean.

Reads have the matching boundary. A `data` event means Node pulled bytes from the socket receive path. Full application messages require the parser above TCP to assemble chunks according to that protocol's framing.

```js
socket.on('data', chunk => {
  parser.push(chunk);
});
```

The parser owns message boundaries. TCP owns byte order and delivery attempts. Node streams move chunks between those layers.

During shutdown, success gets more conditional. A peer can accept bytes into its kernel receive buffer and then crash before its application processes them. A local write can complete before a later reset tells you the peer rejected the connection. TCP cannot report remote application processing. It reports transport state.

That boundary is why request-response protocols wait for responses. A database driver, HTTP client, or queue producer treats the protocol response as the meaningful acknowledgment. The TCP write callback is plumbing progress.

## The Small Local Demos Lie in Useful Ways

Loopback demos remove route noise, DNS noise, and external packet loss. They still exercise TCP state. That makes them useful for learning event order, and limited for production diagnosis.

The refused demo is clean:

```js
import net from 'node:net';

const s = net.connect(65000, '127.0.0.1');

s.on('connect', () => console.log('connected'));
s.on('error', err => console.error(err.code));
```

With no listener, `error` fires and `connect` stays absent. The local host rejected setup. A remote firewall that drops SYNs produces a different timeline: no fast rejection, repeated SYN attempts, then a timeout path or your own deadline.

The reset demo is timing-sensitive:

```js
import net from 'node:net';
const server = net.createServer(s => s.resetAndDestroy());
server.listen(0, '127.0.0.1', () => {
  const c = net.connect(server.address().port, '127.0.0.1');
  c.on('error', err => console.error(err.code));
  c.on('close', () => server.close());
});
```

The server accepts and sends a reset. The client may report `ECONNRESET`, or it may close quickly depending on when the reset is observed and which side had pending operations. A demo that produces different event order across runs is teaching the real point: reset is asynchronous relative to JavaScript.

The slow-reader demo is also local but still useful:

```js
import net from 'node:net';
const server = net.createServer(s => s.pause());
server.listen(0, '127.0.0.1', () => {
  const c = net.connect(server.address().port, '127.0.0.1');
  c.on('connect', () => {
    console.log(c.write(Buffer.alloc(1e6)));
    c.destroy(); server.close();
  });
});
```

Depending on buffer sizes, the first large write may return `false`. If it returns `true`, write more chunks. The server is alive and connected. It simply stops consuming. Pressure builds from the receiving application outward into Node buffers and TCP receive-window behavior.

Local demos also hide congestion. Loopback has tiny RTT and huge effective bandwidth compared with remote paths. Retransmission and congestion behavior barely show up unless you use OS traffic shaping tools. The API events remain the same categories, but the timing profile changes completely on real networks.

## Host TCP State Gives the Other Half

Node events tell you what reached JavaScript. Host TCP state tells you what the kernel currently owns. On Linux, `ss` is the usual first tool:

```bash
ss -tan
```

The output shows local and peer addresses plus TCP state. During a local demo you might see `ESTAB`, `TIME-WAIT`, `CLOSE-WAIT`, or sockets in setup states if you catch them quickly. The exact abbreviations depend on the tool and platform.

Use it with endpoint tuples. If Node logs `local 127.0.0.1:50100 remote 127.0.0.1:3000`, search for those ports in `ss` output. A matching `ESTAB` entry means the kernel still considers the connection established. `TIME-WAIT` means teardown completed through the active-close path and the kernel is holding the tuple for a while. `CLOSE-WAIT` means the peer sent FIN and the local process still has close work to do.

The process view and the socket view can disagree for a short time. JavaScript may have emitted `close` while `TIME-WAIT` remains in the kernel table. That is expected because the JavaScript wrapper is finished and TCP cleanup state remains. JavaScript may still hold a `net.Socket` object while the kernel has already recorded a reset. The next read or write will surface that state.

On a busy server, state counts matter more than single rows:

```bash
ss -tan state time-wait
ss -tan state close-wait
```

Many `TIME-WAIT` sockets after outbound load often means lots of short-lived connections. Many `CLOSE-WAIT` sockets often points at application code that received peer close and kept descriptors open. Many `SYN-SENT` entries can point at slow or filtered outbound connect attempts. Many `SYN-RECEIVED` entries touch backlog and SYN handling, which Chapter 9.6 owns.

Node cannot expose all of that through `net.Socket` because the state belongs to the OS. The right debugging move is to combine both views: Node event order for what your process observed, kernel TCP state for what the host is still tracking, and protocol logs for what the application thought it completed.

## Failure Usually Belongs To a Side

TCP errors make more sense when you assign the operation to one side.

Outbound connect failure:

```text
local endpoint picked
remote socket address targeted
handshake fails
Node emits error before connect
```

Established read failure:

```text
connection established
peer or path resets
local read observes reset
Node emits ECONNRESET
```

Established write failure:

```text
connection established
peer closes or resets
local code writes later
OS rejects write
Node emits EPIPE or ECONNRESET
```

Orderly peer close:

```text
peer sends FIN
local readable side sees end
local code decides whether to write or close
close completes after teardown
```

A single timeline can include several of these. A client connects, writes a request, receives a partial response, then the peer resets. The log might show `data`, then `error ECONNRESET`, then `close`. That means TCP delivered some ordered bytes and later aborted state. Your protocol parser decides whether the partial response is usable. Most request-response protocols discard it.

The endpoint tuple from Chapter 9.1 still matters. Two connections to the same server port are different connections if their local ephemeral ports differ. One can reset while the other stays established. A server log that records only the remote IP throws away the remote port, and with it the connection identity.

```js
socket.on('error', err => {
  console.error({
    code: err.code,
    local: `${socket.localAddress}:${socket.localPort}`,
    remote: `${socket.remoteAddress}:${socket.remotePort}`
  });
});
```

Those fields may be undefined before connection or after teardown, depending on timing. When present, they attach the error to the concrete TCP endpoint pair.

## The State Machine Under a Node Socket

The deep part is the state mismatch between JavaScript and TCP. Node gives you an object with methods. TCP runs a kernel state machine with timers, sequence numbers, buffers, windows, and teardown states. Those two views line up most of the time. Bugs live in the gaps.

During `connect`, JavaScript has a `net.Socket` immediately. The OS may still be in `SYN-SENT`. Code can attach listeners, set options, or even queue writes before the `connect` event. Node stores that intent and flushes it when the native connection path succeeds. If the handshake fails, queued work is discarded through error handling. The JavaScript object existed the whole time, but the TCP connection reached established state only after the handshake completed.

During transfer, JavaScript writes chunks. Node's stream layer counts queued bytes. libuv tracks write requests. The kernel send buffer tracks bytes that may need transmission, acknowledgment, or retransmission. TCP sequence state tracks which byte ranges are outstanding. The peer's receive window limits how far ahead the sender can get. Congestion control limits how much the sender should put into the path. A single `write()` in JavaScript can touch all of that without exposing the intermediate states.

Reads have their own separation. The kernel can receive TCP segments, acknowledge bytes, store them in the receive buffer, and report readability. libuv observes readiness and Node pulls bytes into stream machinery. JavaScript sees `data` chunks according to stream state. If the application pauses the stream, Node can stop reading for a while. Kernel receive space then becomes the limiting resource, and the advertised receive window can shrink. The peer sees that as transport-level pressure, not as a JavaScript event.

Shutdown adds more timing. `socket.end()` means the application is done writing. Node flushes pending writes and then asks the lower layer to close the write side. TCP sends `FIN` only after queued bytes are handled according to the local stack's rules. The peer may still send data. Your local socket can receive after ending its write side. If the peer sends `FIN`, Node may emit `end` before `close`. If either side sends `RST`, the orderly path is cut short and errors can surface on operations already queued in JavaScript.

Timeouts sit beside the state machine. TCP has retransmission timers. Node sockets can have inactivity timers. Higher protocols can have request deadlines. A user can abort an operation. Any one of those can destroy the socket. The final error code reflects the layer that took action or the OS result that Node observed. Two runs of the same code can differ if packet timing changes which side acts first.

That is why "connected" is a temporary fact. It means the connection reached established state at one point. After that, every read and write races current TCP state. A peer FIN, peer RST, local timeout, process exit, route loss, or retransmission failure can move the kernel state while JavaScript still holds a socket reference.

Readable logs follow the state machine. Record when connect started, when it completed, when each side ended, when your code destroyed the socket, which write was in progress, and which endpoint tuple was involved. Without that order, `ECONNRESET` is just a label for "some lower state changed before this operation finished."

## Keeping Protocols Above TCP Honest

TCP gives reliable ordered delivery at the byte-stream level while the connection remains viable. Application message boundaries, remote processing confirmation, retry policy, and deadline policy live above it.

The transport can deliver half a protocol frame and then end cleanly with `FIN`. It can accept a local write and later report reset. It can stall because the peer's receive window is closed. It can retransmit for a while and then time out. All of those are valid TCP outcomes, and Node reports them through stream events and system errors.

That leaves backend code with a simple discipline: treat TCP as the byte transport, then make the application protocol prove completion. Frame your messages. Wait for protocol acknowledgments. Respect `write()` backpressure. Log endpoint tuples and event order. Keep retries and circuit breakers in their own layer, because retrying a broken transport operation safely depends on what the application protocol already committed.

The next subchapter moves up one API level into `node:net`. The same state remains underneath. The methods get friendlier names, but the socket still belongs to TCP before it belongs to JavaScript.
