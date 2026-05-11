---
title: "TCP/IP Stack and OS Networking Primitives"
date: "2026-05-11"
excerpt: "How bytes leave a Node process through libuv, OS sockets, addresses, ports, routing, link-layer resolution, and packet boundaries."
category: "Network Fundamentals with Node.js"
tags: ["nodejs", "networking", "tcp-ip", "sockets", "libuv"]
author: "Ishtmeet Singh @ishtms"
chapter: "networking"
subchapter: "tcpip-os-networking"
published: true
toc: true
---

A listening Node server has two visible pieces of state - the JavaScript object and the OS socket under it.

The change happens at `listen()`. Before that call, Node has a server object and a callback. After it succeeds, the kernel has a bound listening endpoint tied to the process.

```js
import net from 'node:net';

const server = net.createServer(socket => {
  socket.end('hi\n');
});

server.listen(3000, '127.0.0.1');
```

`net.createServer()` creates JavaScript state. It stores the connection callback. It prepares a server object with stream and event behavior the earlier chapters already covered.

`listen()` is where the boundary moves. Node asks libuv to create a TCP handle. libuv asks the operating system for a socket. The OS creates kernel socket state, assigns a file descriptor to the process, binds the socket to the socket address `127.0.0.1:3000`, then marks it as a listening endpoint.

One line. Several owners.

The process now has JavaScript objects in V8, native objects in Node and libuv, and socket state in the kernel. Those pieces stay linked by handles and file descriptors. JavaScript sees a `net.Server`. libuv watches readiness. The kernel owns the network object that receives connection attempts.

```js
server.on('listening', () => {
  console.log(server.address());
});
```

The printed address is the part Node can expose cleanly: host, port, and address family. The rest lives below the JavaScript object. You can close the server object. You can remove listeners. You can keep references around. The kernel socket table still has the decisive state while the descriptor remains open.

A kernel socket table is the operating system's bookkeeping for sockets within the active host or container network context. It tracks listening endpoints, connected endpoints, local and remote addresses, protocol state, buffers, and descriptor ownership. Node reads and mutates that state through system calls.

A system call boundary is the transition where user-space code asks the kernel to perform an operation. JavaScript reaches the kernel socket table through native Node code and libuv. Native Node code and libuv cross into the kernel with calls such as `socket()`, `bind()`, `listen()`, `accept()`, `connect()`, `read()`, `write()`, and `close()`, with platform-specific APIs underneath those names.

That boundary explains the rest of the chapter. Node exposes a JavaScript object. The OS owns the primitive.

## The Boundary Below `listen()`

On Unix-like systems, a socket consumes a file descriptor. Chapter 4 already covered file descriptors for files, and the same process-level idea applies here: the descriptor is a small integer handle owned by the process. The target object is different. Instead of an open file, the descriptor points to a kernel socket object.

The call path for the server above looks roughly like this:

```text
net.Server.listen()
  -> Node TCP binding
  -> libuv TCP handle
  -> OS socket
  -> bind 127.0.0.1:3000
  -> listen
```

Names differ across platforms, but the ownership shape holds. JavaScript keeps a server object. Node's native layer keeps a wrapper that can talk to libuv. libuv keeps a handle that integrates with the event loop. The operating system keeps the socket state and reports readiness back to libuv when something changes.

The event loop was explained back in Chapter 1, so keep the local version narrow: network I/O reaches JavaScript after the kernel reports a socket state change, libuv observes it, and Node turns that readiness into callbacks and stream events.

For a listening TCP server, the kernel can hold completed incoming connections until the process accepts them. Node does the accept work from its native path, wraps each accepted socket in a JavaScript `net.Socket`, and emits the connection event. By the time your callback runs, the kernel has already created the connected socket object. JavaScript receives the accepted result.

```js
const server = net.createServer(socket => {
  console.log(socket.remoteAddress, socket.remotePort);
});

server.listen(3000, '127.0.0.1');
```

The `socket` passed to the callback is a JavaScript wrapper around a connected OS socket. `remoteAddress` and `remotePort` came from the peer side of the connection. `localAddress` and `localPort` describe the address tuple on your side.

Descriptors make network bugs feel familiar. A process can run out of descriptors. A socket can remain open because some JavaScript object or native handle still owns it. A server can fail to bind because another process already has an endpoint in the kernel socket table. The failure is reported through Node, but the decision belongs to the OS.

```js
import net from 'node:net';

net.createServer().listen(3000);
net.createServer().listen(3000).on('error', err => {
  console.error(err.code);
});
```

The second bind usually reports `EADDRINUSE`. The OS rejected the bind because the requested local socket address conflicted with existing socket state. Socket option details belong later in this chapter, but the practical boundary is here: bind errors are kernel answers surfaced through Node errors.

The native path has a few state transitions worth keeping visible:

```text
created socket
  -> bound local address
  -> listening socket
  -> accepted connected socket
```

The created socket has a protocol family and type. For our server, that means an IPv4 or IPv6 TCP socket. Before binding, it has no local port attached to it. After `bind`, the kernel has attached a local socket address. After `listen`, the socket accepts connection attempts for that address. After `accept`, the kernel returns a new connected socket descriptor while the original listening socket keeps listening.

That split matters in Node because `net.Server` and `net.Socket` wrap different kernel objects. The server object wraps the listening socket. The socket passed to the connection callback wraps an accepted connected socket. Closing an accepted socket ends that connection. Closing the server stops accepting new ones. Existing accepted sockets can remain alive unless your code closes them too.

```js
const sockets = new Set();

const server = net.createServer(socket => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});
```

That is ordinary JavaScript ownership around lower state. The set tracks accepted socket wrappers. The kernel tracks connected socket objects. During shutdown, code often closes the server first, then closes or drains accepted sockets. Those are different operations because they target different descriptors.

The listening socket also has queue state below JavaScript. When connection attempts complete at the TCP layer, the OS can hold accepted connections until the process accepts them. Node's native accept loop pulls from that kernel state when libuv reports readiness. The backlog and accept-queue details belong to Chapter 9.6, but the ownership point belongs here: a `connection` event means a kernel socket already exists for that peer.

The JavaScript callback runs after that lower work. By then, the remote endpoint is known, the local endpoint is known, and the connected descriptor is open. The callback can decide to read, write, pause, destroy, or hand the socket to another part of the program. It cannot rewind the accept decision.

Network writes cross the same line.

```js
socket.write(Buffer.from('hello\n'));
```

`socket.write()` accepts bytes from JavaScript. The stream layer may buffer before native code receives them. Node hands the bytes down to libuv. libuv asks the OS to send them on the socket. The kernel may copy bytes into a send buffer and return before they reach the peer. Later, the TCP/IP stack breaks those bytes into protocol units and sends them through an interface when routing and link-layer state permit it.

That last sentence hides the networking stack. Time to name the pieces.

## The Stack Shape Node Depends On

The TCP/IP stack is the operating system's network implementation for Internet protocols. It owns transport protocol state, IP addressing, route selection, packet construction, link-layer handoff, receive processing, and the socket interface exposed to processes.

For Node backend work, the useful stack view is compact:

```text
JavaScript bytes
  -> TCP segment or UDP datagram
  -> IP packet
  -> Ethernet frame or another link-layer frame
  -> network interface
```

Application bytes are the data your code writes: a string, a `Buffer`, a serialized request, a response body, or any other byte sequence.

A packet is a bounded unit of data handled by the network stack. Developers often use the word loosely. Here we need the specific units because debugging output names them differently.

A TCP segment is a TCP protocol unit. It carries TCP header fields plus a slice of application bytes. TCP owns connection state, ordering, retransmission, and flow-control machinery. Chapter 9.3 owns that lifecycle. For now, keep the shape: when a Node TCP socket sends bytes, those bytes eventually become one or more TCP segments.

A UDP datagram is a UDP protocol unit. It carries a UDP header and one message payload. UDP behavior belongs to Chapter 9.5, but the name matters now because it sits at the same transport layer as TCP segments.

An IP packet is an IP header plus transport payload. For TCP, the payload is a TCP segment. For UDP, the payload is a UDP datagram. The IP header carries source and destination IP addresses and enough metadata for hosts and routers to move the packet toward the destination.

An Ethernet frame is a link-layer unit used on Ethernet networks. It wraps an IP packet with link-layer headers and a trailer for delivery on that local link. Wi-Fi and other links have their own frame formats, but Ethernet names show up constantly in packet captures, MTU discussions, and Linux tooling.

IPv4 and IPv6 packets carry different header formats. The role is the same for this chapter: source address, destination address, protocol metadata, and payload. IPv4 headers include fields related to fragmentation. IPv6 moved fragmentation behavior into extension-header rules and path behavior. You do not need those fields memorized to read Node networking code, but you do need the family distinction because addresses, socket structures, route tables, and packet headers differ.

TCP receives bytes from the socket send path and presents a byte stream to the peer. The segment boundary is transport plumbing. Your application does not get a callback per TCP segment. A single `socket.write()` can become many segments. Several writes can be observed by the peer as one `data` chunk. The peer's `data` event boundaries are produced by Node stream reads from the receive buffer, not by your write calls.

UDP keeps message boundaries at the socket API. A send call creates one datagram payload at the UDP layer, subject to size limits and IP behavior. The full UDP chapter owns the consequences. The contrast is useful here because the packet terms are otherwise easy to blur: TCP segments carry a byte stream; UDP datagrams carry individual messages.

IP routing treats both as payload. The IP layer does not care whether Node wrote an HTTP request, a Redis command, a custom binary protocol, or an empty payload. It sees a transport protocol number, source and destination IP addresses, and bytes to carry toward the next hop.

Layer names can get academic fast. Keep the backend path in view. Node hands bytes to a socket. The socket has a transport protocol. The transport protocol uses IP for host addressing. IP uses a network interface and a next-hop decision to leave the machine. A local link format carries the IP packet across the immediate network segment.

For a TCP write, the path is roughly:

```text
socket.write(Buffer)
  -> Node stream/native write queue
  -> kernel TCP send buffer
  -> TCP segment
  -> IP packet
  -> interface transmit queue
  -> link-layer frame
```

Backpressure from Chapter 3 appears here again. A Node writable stream can signal that its own queue crossed `highWaterMark`. The kernel socket can also have a send buffer with finite space. TCP can also apply flow control based on the peer's receive window. Those are different pressure points. They interact, but they live in different owners.

JavaScript sees `socket.write()` return `false` when the Node stream layer wants you to wait for `drain`. That signal says Node's writable-side buffering has crossed its local threshold. The peer may still have received nothing. The packet may still be waiting inside the local stack. The JavaScript-facing stream wants the producer to slow down.

The kernel's TCP send buffer sits lower. Node can hand bytes to the OS and get a successful write because the kernel accepted them into that buffer. The bytes may still be waiting for segmentation, congestion window space, link availability, or retransmission. Later chapters own those TCP details. The useful habit starts now: a successful write into a socket means the local stack accepted bytes for transmission.

Receives move upward through the same owners in reverse. A network interface receives a frame. The link-layer code extracts the IP packet. The IP layer checks destination addressing and protocol. TCP or UDP receives the transport unit. A matching socket gets data or state. The kernel reports readability. libuv sees the readiness. Node reads bytes and pushes them into a JavaScript stream.

```text
interface receive
  -> link-layer frame
  -> IP packet
  -> TCP segment
  -> socket receive buffer
  -> libuv readiness
  -> net.Socket data
```

Node starts at the top of that path. Many bugs start lower.

## Interfaces and Local Addresses

A network interface is the host-side network endpoint the operating system can use to send and receive packets. It can be physical hardware, a virtual device, a tunnel, a bridge, a container interface, or the loopback interface. The OS attaches addresses and link-layer properties to interfaces.

Node exposes interface data through `node:os`:

```js
import os from 'node:os';

for (const [name, entries] of Object.entries(os.networkInterfaces())) {
  console.log(name, entries.map(e => `${e.address}/${e.family}`));
}
```

The output is platform and machine dependent. You will usually see a loopback interface and one or more non-loopback interfaces. Laptops have Wi-Fi. Servers may have several NICs. Containers may see virtual interfaces. VPNs add tunnel interfaces. Cloud hosts add names that reflect the guest OS, not the provider's product page.

An IP address is the network-layer address assigned to an interface or used as a destination. It identifies an endpoint at the IP layer, within the routing rules active on the host and network. Node code usually treats it as a string, but the OS treats it as structured address data with an address family.

One interface can have several addresses. One host can have several interfaces. One address family can be enabled on one interface and absent from another. That is normal host state, and Node inherits it.

`os.networkInterfaces()` may return entries shaped like this:

```js
{
  address: '127.0.0.1',
  netmask: '255.0.0.0',
  family: 'IPv4',
  internal: true,
  cidr: '127.0.0.1/8'
}
```

The `cidr` and `netmask` fields describe the local address range attached to the interface. Subnet design belongs outside this chapter, but the direct effect matters: the OS can tell whether a destination is on a directly connected network by comparing it against interface routes derived from these address ranges.

On a normal workstation, your Wi-Fi interface might have an IPv4 address such as `192.168.1.25/24`. A destination such as `192.168.1.40` likely matches the same local network route. A destination such as `203.0.113.10` likely goes through the default route. The Node code only names the destination; the OS applies the address and route state.

IPv4 is the 32-bit IP address family written in dotted decimal form, such as `127.0.0.1` or `192.0.2.10`. IPv6 is the 128-bit IP address family written in hexadecimal groups, such as `::1` or `2001:db8::10`. Both can exist on the same host at the same time.

The loopback interface is the host-local network interface. Traffic sent to loopback addresses stays inside the local host's network stack. The common IPv4 loopback address is `127.0.0.1`. The IPv6 loopback address is `::1`.

```js
server.listen(3000, '127.0.0.1');
```

Binding to `127.0.0.1` exposes the server on IPv4 loopback. Other machines cannot reach that address on your host because loopback is host-local. Another process on the same host can connect to it.

```js
server.listen(3000, '0.0.0.0');
```

`0.0.0.0` is the IPv4 wildcard bind address. It tells the OS to accept connections for that port on all suitable IPv4 local addresses. The server's actual incoming local address depends on which interface address the peer used.

Wildcard bind confusion causes a lot of local-only bugs. A process bound to `127.0.0.1` can pass every local test and still be unreachable from a browser running outside a container, from another VM, or from another host. A process bound to `0.0.0.0` may be reachable through every IPv4 address assigned to the host, subject to firewall and routing policy.

IPv6 adds another common surprise:

```js
server.listen(3000, '::1');
```

`::1` is IPv6 loopback. It is a different address family from `127.0.0.1`. A client that connects to IPv4 loopback reaches sockets bound for IPv4. A client that connects to IPv6 loopback reaches sockets bound for IPv6. Dual-stack behavior and IPv6-only options belong to the socket-options subchapter. For now, treat the address family as part of the endpoint.

`localhost` adds name resolution. On many machines it resolves to both `::1` and `127.0.0.1`, with ordering controlled by OS and runtime policy. DNS and lookup ordering belong to Chapter 9.2. For Chapter 9.1, use numeric addresses when you want to observe the socket boundary without name-resolution noise.

Address family selection also changes error shape. A server bound to `127.0.0.1` has an IPv4 listener. A client trying `::1` targets IPv6 loopback. The port number can match and the connection can still fail because the address family points at a different socket table entry. When a bug report says "port 3000 is open," ask which address family and which local address.

Interfaces matter for outgoing connections too. Code usually provides a remote address and port:

```js
import net from 'node:net';

const socket = net.connect(80, '93.184.216.34');

socket.on('connect', () => {
  console.log(socket.localAddress, socket.localPort);
});
```

The OS chooses a local address and local port unless you provide them. The chosen local address usually comes from the outbound interface selected by route lookup. The chosen local port is usually ephemeral. Those two fields form the local endpoint for the connection.

Binding and connecting are separate decisions. A server bind chooses where the process will receive traffic. A client connect chooses a remote endpoint, then the OS chooses a local endpoint that can reach it.

## Ports and Socket Addresses

A port is a 16-bit transport-layer number used by TCP and UDP to identify a local endpoint within an IP address and protocol. Ports range from `0` through `65535`. Operating systems usually reserve low ports for privileged use or policy-controlled binding. The exact rule depends on the OS and configuration.

A socket address is an IP address plus a port, with an address family. In Node, you usually see it as `{ address, port, family }`, or as separate host and port arguments. At the OS boundary, it is structured binary data passed into calls such as `bind()` and `connect()`.

```js
server.listen({ host: '127.0.0.1', port: 3000 }, () => {
  console.log(server.address());
});
```

The local socket address is `127.0.0.1:3000` in the IPv4 family. For a listening server, that address is where the OS accepts incoming connection attempts. For a connected socket, there are two endpoint addresses: local and remote.

The full TCP connection identity is commonly described as a tuple:

```text
protocol
local IP
local port
remote IP
remote port
```

The protocol matters because TCP and UDP are separate transport spaces. The local and remote sides matter because one server port can have many connected TCP sockets at the same time. A web server can listen on local `0.0.0.0:443`, then accept many connections whose remote IP and remote port differ. Each accepted connected socket has its own tuple.

```js
socket.on('connect', () => {
  console.log(socket.localAddress, socket.localPort);
  console.log(socket.remoteAddress, socket.remotePort);
});
```

The local endpoint identifies your side. The remote endpoint identifies the peer side. TCP uses the endpoint tuple to distinguish connections. A single Node process can have many outbound connections to the same remote server because each connection gets its own local ephemeral port.

An ephemeral port is a temporary local port selected by the operating system for an outbound connection or for a bind to port `0`. The OS picks from a configured ephemeral range and tracks active use in the socket table.

```js
const server = net.createServer();

server.listen(0, '127.0.0.1', () => {
  console.log(server.address());
});
```

Port `0` asks the OS to choose an available port. Test code uses this a lot because it avoids hard-coding `3000` across parallel runs. The selected port still belongs to the kernel socket table. You must read it after the server is listening and pass that exact value to clients.

Ephemeral ports also show up on the client side:

```js
const socket = net.connect(3000, '127.0.0.1');

socket.on('connect', () => {
  console.log(socket.localPort);
});
```

The printed local port came from the OS. If a test suite creates thousands of short-lived outbound connections quickly, it can pressure the ephemeral port range. TCP state after close can keep ports unavailable for reuse for a while. Chapter 9.3 owns `TIME_WAIT` and connection teardown, but the first symptom often appears here: local tests fail with address or connect errors even though the remote server is fine.

Port ownership is per protocol and address family. A TCP listener and a UDP socket use different transport protocols. IPv4 and IPv6 can have separate bind behavior depending on socket options and platform defaults. A wildcard bind can conflict with specific-address binds because the OS has to decide which socket would receive traffic for the same address and port.

Use exact addresses while debugging binds. `127.0.0.1:3000`, `::1:3000`, and `0.0.0.0:3000` describe different local binding requests. `localhost:3000` describes a name plus a port, and the name may resolve to more than one address.

Privileged ports are another host policy detail. On Unix-like systems, binding ports below 1024 has traditionally required elevated privileges, though capabilities and container settings can alter that. Node does not grant extra privilege. It calls into the OS and reports the result. A bind to `80` can fail because of permission policy even when no process owns the port.

Port `0` has one special bind meaning: ask the OS to allocate. Port `0` is not a reachable service port for normal client traffic. After the bind succeeds, the socket has a real port from the OS, and `server.address().port` is the value to publish inside the process or test.

## The Kernel Path for One Write

One write gives the simplest trace.

```js
socket.write('GET / HTTP/1.0\r\n\r\n');
```

The string becomes bytes using the stream's encoding rules. Node accepts those bytes into the writable side of `net.Socket`. If the write can proceed, Node creates or extends native write state and asks libuv to submit the operation. libuv uses the OS socket descriptor. The system call boundary is crossed. The kernel receives a pointer to user-space memory and a byte length, then copies or otherwise stages those bytes according to the platform path.

After the system call returns, JavaScript continues. The write callback, when supplied, reports that the data was handled by the local write path. It is a local completion signal. The remote process has its own receive path, buffers, scheduling, and application code.

The kernel socket object tracks protocol, local endpoint, remote endpoint when connected, send buffer, receive buffer, error state, and protocol-specific fields. For TCP, connected state also includes sequence tracking, retransmission state, timers, congestion state, and peer window information. Those TCP fields matter later. Chapter 9.1 needs the ownership boundary: Node owns the JavaScript object and native wrapper; the kernel owns transmission state.

Segmentation happens below Node. Your `socket.write()` call can pass 20 bytes or 200 KiB. TCP chooses how to segment that byte stream under its current constraints. The IP layer wraps each segment in an IP packet. The link layer frames the packet for the chosen interface. The network interface driver queues it for transmission.

The routing decision is already involved before a packet leaves. For a connected TCP socket, the OS has selected a route to the remote address. That selection affects the source address, outbound interface, and next hop. If the remote address is loopback, the path stays inside the host. If the remote address is on a directly attached network, the packet goes out through that interface to the peer's link-layer address. If the remote address is elsewhere, the packet goes to a gateway chosen by the routing table.

The receive side has the same separation. Node can read only after the kernel has accepted data into the socket receive buffer and reported readiness. If JavaScript stops reading, data can accumulate in Node stream buffers and kernel receive buffers. TCP may reduce the advertised receive window, which slows the peer. That is backpressure crossing layers, but each layer speaks its own signal.

Errors cross upward too. A failed route lookup can produce a connection error. A peer reset can surface as a socket error. A write after teardown can report a broken pipe style error. The exact code depends on platform and timing. Node carries those errors into JavaScript with `code` values, but the origin is often a kernel socket transition that happened before the callback ran.

The trace is less clean for UDP because message boundaries are different, and Chapter 9.5 owns that path. The stack shape still applies: Node hands bytes to a datagram socket, the OS creates UDP datagrams, IP packets carry them, and an interface sends frames.

## Routing Decides the Interface

A routing table is the host's ordered set of rules for choosing where an IP packet goes next. It maps destination address ranges to local delivery, an interface, or a next-hop gateway. The kernel consults it for outbound packets.

On Linux, `ip route` shows the IPv4 table:

```bash
ip route
```

Typical output includes a default route plus local network routes. The default route is the route used when no more specific route matches the destination. It usually points at a gateway through one interface.

The exact output depends on the host, but the shape often looks like this:

```text
default via 192.0.2.1 dev wlan0
192.0.2.0/24 dev wlan0 proto kernel src 192.0.2.10
```

The second line says the host can reach `192.0.2.0/24` directly through `wlan0`, using `192.0.2.10` as the preferred source address for that route. The default line says other IPv4 destinations go to `192.0.2.1` through `wlan0`.

Route lookup prefers the most specific matching route. A loopback destination matches a local loopback route. A local subnet destination matches the directly connected network route. A public remote address likely matches the default route on a small host. Servers, containers, VPNs, and policy routing can add more rules, but the local model stays the same: destination address in, route result out.

Linux can show the route result for one destination:

```bash
ip route get 93.184.216.34
```

That command often prints the selected interface, source address, gateway, and cache-related fields. It exposes the same decision the kernel makes during connect: destination address in, selected path out.

IPv6 has its own route table:

```bash
ip -6 route
```

Dual-stack hosts can have an IPv4 route that works and an IPv6 route that fails, or the reverse. Node sees both as network operations. The address family picked before routing decides which table matters.

The kernel chooses the outbound interface for a normal `net.connect()` call. Node asks to connect to a remote socket address. The OS picks a source address and route based on the destination and optional local bind settings.

```js
const socket = net.connect({
  host: '93.184.216.34',
  port: 80,
  localAddress: '192.0.2.10'
});
```

`localAddress` constrains the source address. The OS still validates that the address exists on the host and can be used for that route. If the local address is absent, the connect fails. If the address exists but policy blocks the route, the connect still fails.

Loopback routing is special because it stays inside the host stack:

```js
net.connect(3000, '127.0.0.1');
```

The destination matches loopback. The packet path uses host-local delivery instead of a physical NIC. The socket still uses TCP. The kernel still tracks endpoints. But link-layer resolution and external network devices are skipped because the destination is local to the host.

Container networking makes this boundary visible. Inside a container, `127.0.0.1` means the container's own network namespace. A service bound to loopback inside one container is local to that namespace. Reaching another container or the host requires an address and route that cross that namespace boundary. Kubernetes details belong later, but this one rule saves time: loopback is scoped to the network namespace doing the lookup.

Wildcard binds interact with routing from the receive side. A server bound to `0.0.0.0:3000` can accept connections addressed to any local IPv4 address on suitable interfaces. The incoming packet's destination address picks the local address for that accepted connection. `server.address()` on the listening server may print `0.0.0.0`, but each accepted socket has a concrete `localAddress`.

```js
net.createServer(socket => {
  console.log(socket.localAddress, socket.localPort);
}).listen(3000, '0.0.0.0');
```

That callback prints the address the client reached. On a host with several interfaces, different clients can produce different local addresses on the same listening server.

Routing failures often show up as timeouts, unreachable errors, or connections that never reach the server you expected. Use the destination address, not the URL string, when checking route behavior. Name resolution can choose one address family, then routing decides how that address moves. Chapter 9.2 takes the name-resolution half.

Route lookup also explains source-address surprises on hosts with several active interfaces. A process can run with Wi-Fi, Ethernet, VPN, and container interfaces at the same time. The destination address chooses a route. The route chooses a preferred source address. When application logs record only the remote URL, that lower choice disappears. Recording `socket.localAddress` during connection setup can make the chosen route visible without requiring packet capture.

Local delivery is a route result too. If the destination is one of the host's own addresses, the kernel can deliver internally. That can happen beyond `127.0.0.1`; connecting to the machine's own non-loopback address from the same machine may still stay inside local delivery paths depending on OS behavior. The socket endpoints still show the chosen addresses, so inspecting local and remote fields beats guessing from interface names.

## ARP, Neighbor Discovery, and MTU

Routing chooses an interface and maybe a next hop. The link layer still needs a delivery target on the local link.

ARP, the Address Resolution Protocol, maps an IPv4 address on the local link to a link-layer address such as a MAC address. If the route says an IPv4 packet should go directly to a peer or gateway on an Ethernet-like link, the host needs the link-layer address for that next hop. ARP supplies it and caches the result for later use.

Neighbor Discovery is the IPv6 mechanism that covers neighbor address resolution and related local-link tasks. For Chapter 9.1, the relevant job is parallel to ARP's debugging role: IPv6 local delivery needs neighbor information before frames can be sent on the link.

Node usually sees ARP and Neighbor Discovery through symptoms. A connect call may hang while the OS tries to resolve the next hop. A packet capture may show ARP requests before TCP packets. A route can be correct while the next-hop neighbor is unreachable. JavaScript just sees delayed connection progress or an error after the OS gives up.

MTU means Maximum Transmission Unit. It is the largest packet payload size a link can carry at that layer without fragmentation. Ethernet commonly has an MTU of 1500 bytes for IP packets, though many environments use different values.

MTU matters because Node writes byte streams, while the network sends bounded units. A large `socket.write()` does not become one giant packet. The stack splits bytes into pieces that fit transport, IP, and link constraints. If a packet is too large for some path segment, it may need fragmentation or it may be dropped with an error signal, depending on protocol, flags, and network behavior.

Backend developers usually meet MTU through production symptoms: small requests work, larger payloads stall, VPN paths behave differently, or packet captures show retransmissions around a size boundary. Node sees the result as slow writes, stalled reads, connection resets, or timeouts. The fix may sit below Node in interface MTU, tunnel settings, firewall policy, or path MTU discovery behavior.

The application-level payload size and the packet size can diverge by a lot:

```js
socket.write(Buffer.alloc(64 * 1024));
```

That write submits 65,536 bytes to the socket path. Ethernet with a 1500-byte MTU cannot carry that as one IP packet. TCP segmentation and offload features may shape what packet capture sees, and the interface driver may perform some work late in the transmit path. The JavaScript byte count remains the application byte count.

Packet capture tools can confuse this further because modern NICs and kernels use offloads. A capture taken before segmentation offload may display large pseudo-packets that exceed the physical MTU. A capture taken elsewhere may show smaller on-wire frames. Treat captures as observations from a specific point in the stack.

Keep packet-capture vocabulary precise when you debug this layer:

```text
Ethernet frame
  -> IP packet
  -> TCP segment
  -> application bytes
```

If someone says "the packet is 1514 bytes on the wire," they may include Ethernet framing. If someone says "MTU 1500," they usually mean the IP packet size on Ethernet. If someone says "TCP payload," they mean application bytes inside the TCP segment after TCP and IP headers. The numbers differ because each layer has headers.

Node's `Buffer` length is application byte count. It is not a packet size. A 64 KiB `Buffer` may become many TCP segments. Several small writes may also be coalesced lower down depending on buffering and TCP behavior. Nagle, delayed ACK, and socket options belong later. The current layer only needs the separation: application byte boundaries and packet boundaries are owned by different code.

ARP and Neighbor Discovery also have caches. A host usually resolves a next hop once, stores the result, and reuses it until the cache entry expires or changes. That means the first connection attempt to a peer can pay resolution cost while later attempts avoid it. It also means stale neighbor state can create failures that clear after cache expiration or interface changes. Node has no special API for that cache in `net`; use OS tooling when the symptom points below IP routing.

## Observing the Host From Node

`os.networkInterfaces()` gives a JavaScript view of interface addresses. It does not show the full routing table, neighbor cache, or socket table. It is still the first good check because it shows which addresses this process's host currently exposes to Node.

```js
import os from 'node:os';

console.dir(os.networkInterfaces(), { depth: null });
```

Each entry includes fields such as `address`, `netmask`, `family`, `mac`, `internal`, and CIDR information where available. `internal: true` marks loopback-style addresses. The `family` value tells you whether the address is IPv4 or IPv6.

That data helps explain bind behavior:

```js
import net from 'node:net';

const host = process.argv[2] || '127.0.0.1';
net.createServer().listen(3000, host, () => {
  console.log(`listening on ${host}:3000`);
});
```

Run it with `127.0.0.1`, then with an actual interface address from `os.networkInterfaces()`, then with `0.0.0.0`. The server code barely changes. The kernel bind request changes completely.

Port conflicts need a socket-table view. On Linux, `ss` can show listening TCP sockets:

```bash
ss -ltnp
```

The output names local addresses and ports. With permissions, it can also show process information. That is the view you want when Node reports a bind error. Start with the socket address already present in the kernel table, then trace which process owns it.

Node can show its own chosen address after binding:

```js
const server = net.createServer();

server.listen(0, '127.0.0.1', () => {
  console.log(server.address());
});
```

That pattern is better for parallel tests than fixed ports. Let the OS choose. Read the selected port. Pass it to the client. Close the server when the test ends. Fixed ports make tests depend on global host state.

Remote connections expose route-selected local state:

```js
const socket = net.connect(80, '93.184.216.34');

socket.on('connect', () => {
  console.log(socket.localAddress, socket.localPort);
  socket.end();
});
```

The local address came from route selection. The local port came from ephemeral allocation. If you run the same snippet on Wi-Fi, a VPN, a container, and a CI runner, the values can differ because the host's interface and routing state differ.

Accepted sockets show both sides of inbound state:

```js
net.createServer(socket => {
  console.log({
    local: `${socket.localAddress}:${socket.localPort}`,
    remote: `${socket.remoteAddress}:${socket.remotePort}`
  });
}).listen(3000, '0.0.0.0');
```

That log is often better than a generic "client connected" line. It records which local address received the connection and which remote endpoint the kernel reported. In environments with proxies, NAT, or port publishing, those fields may reflect the immediate peer at this layer. Later chapters handle proxy headers and higher-level identity.

Errors deserve the same boundary discipline:

```js
server.on('error', err => {
  console.error(err.code, err.address, err.port);
});
```

Bind errors often include the attempted address and port. Log them. A service that says only "failed to start" throws away the exact socket address the OS rejected.

A few local errors can be read as socket-boundary clues:

```text
bind failed
  -> local address absent, busy, or blocked by policy
connect failed
  -> remote path, peer state, or local route problem
write failed
  -> connected socket state changed below JavaScript
```

The exact `code` value belongs to the operation and platform. `EADDRINUSE` on bind points at an address already occupied in the socket table or made unavailable by socket state and options. `EADDRNOTAVAIL` points at a local address the host cannot use for that bind or connect request. `ECONNREFUSED` on connect means the destination host actively rejected the connection attempt at the transport layer, commonly because no listener accepted that endpoint. Later subchapters give these errors their full TCP and socket-option context. At this level, they all carry one message: the OS rejected or changed the socket operation below JavaScript.

That is why error handlers should print the fields Node gives you:

```js
socket.on('error', err => {
  console.error({
    code: err.code,
    address: err.address,
    port: err.port
  });
});
```

The fields are sometimes absent because the error surfaced after the operation moved beyond the original address arguments. When they exist, they tell you which endpoint request failed. Log the endpoint, then inspect the host state that owns it.

Loopback gives a cleaner local trace:

```js
const server = net.createServer(s => s.end('ok\n'));

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  const client = net.connect(port, '127.0.0.1');
  client.on('close', () => server.close());
  client.pipe(process.stdout);
});
```

No remote network is needed. The server binds to IPv4 loopback on an ephemeral port. The client connects to that exact socket address. TCP still runs. The accepted socket still has local and remote endpoints. Routing selects loopback. Link-layer resolution stays out of the path.

IPv6 loopback needs its own address:

```js
const server = net.createServer(s => s.end('ok\n'));

server.listen(0, '::1', () => {
  const { port } = server.address();
  const client = net.connect(port, '::1');
  client.on('close', () => server.close());
  client.pipe(process.stdout);
});
```

If this fails on a machine, inspect IPv6 availability and local policy before blaming Node. `::1` and `127.0.0.1` are different socket addresses. `localhost` may choose either one after lookup.

The shortest debugging path at this layer is usually mechanical:

```text
numeric destination address
  -> address family
  -> local bind address, if any
  -> route result
  -> socket table entry
  -> interface and neighbor state
```

Stay numeric until the route and bind behavior make sense. Add names later. DNS adds another moving piece, and Chapter 9.2 gives it its own path.

## Wildcards, Localhost, and Other Sharp Edges

Wildcard bind addresses are receive-side instructions.

`0.0.0.0` means all suitable IPv4 local addresses for that port. `::` means the IPv6 unspecified address. Depending on platform and socket options, an IPv6 wildcard socket may or may not also accept IPv4-mapped connections. Treat that as platform and option dependent; Chapter 9.6 owns dual-stack behavior.

The listening server's address can look less concrete than the actual traffic:

```js
const server = net.createServer(socket => {
  console.log('accepted on', socket.localAddress);
});

server.listen(3000, '0.0.0.0');
```

`server.address()` reports the listening bind address. `socket.localAddress` on each accepted socket reports the concrete local address for that connection. Use the accepted socket when you need to know which interface address the client reached.

`localhost` is a local hostname that resolves to one or more addresses. It usually resolves through host files and resolver policy, and it may produce IPv6 and IPv4 answers. If your server binds only to `127.0.0.1` and your client tries `localhost`, the client may try `::1` first and fail before trying IPv4, depending on lookup behavior and client policy. That belongs to the next subchapter, but the bind-side fix is already visible: match the address family you intend to use, or bind in a way that supports both families under your platform policy.

Ephemeral port exhaustion is another local-state bug. It appears when a process or test suite creates outbound connections faster than the OS can recycle local ports. The remote service can be healthy. The local machine can be the limiting side. Symptoms vary by OS and timing, but the root is the same: the local endpoint tuple needs a unique ephemeral port, and the kernel socket table still has too much active or recently closed state.

Tests that bind servers to port `0` avoid fixed listen-port conflicts, but they can still create many outbound client sockets. Closing the server is not the same as draining all client connections. A test that starts and tears down hundreds of local TCP connections should close accepted sockets, await close events, and avoid assuming a port becomes reusable the instant JavaScript drops a reference.

Containers add address scope issues. A service inside a container bound to `127.0.0.1` listens inside that container's namespace. Publishing a port through a container runtime cannot make a loopback-only service inside the container listen on every container interface unless the runtime or proxy creates a separate forwarding path. Binding to `0.0.0.0` inside the container exposes the service on the container's IPv4 interfaces, then host publishing rules decide what reaches it from outside.

VPNs and multiple interfaces add route surprises. A destination that worked yesterday may take a tunnel route today. The Node code did not change. The routing table did. `socket.localAddress` is often the first clue because it shows the source address selected for the connection. If that address belongs to a VPN or container interface, route lookup is already steering traffic away from the interface you expected.

Packet size bugs rarely announce themselves as MTU bugs. They look like partial progress. Small payloads succeed. Larger payloads hang or reset. TLS and HTTP can make the symptom look higher-level, but the underlying path may be a link MTU or fragmentation issue. Keep MTU in the candidate set when size boundaries are suspicious, especially across tunnels.

## Three Paths From the Same Code

The same Node call can take three different host paths depending on the destination address.

```js
import net from 'node:net';

const socket = net.connect(3000, process.argv[2]);

socket.on('connect', () => socket.end('ping\n'));
```

Run that code with `127.0.0.1`, with another address on the same local network, and with a remote public address. The JavaScript code stays the same. The socket address changes. The kernel path changes after `connect()` crosses the system call boundary.

For IPv4 loopback, the route result is local:

```text
127.0.0.1:random -> 127.0.0.1:3000
  -> loopback route
  -> local TCP processing
  -> peer socket in the same host
```

No ARP. No gateway. No physical interface transmission. The packet still moves through IP and TCP logic, but the host delivers it internally. That path is why loopback tests are fast and stable compared with remote tests. It is also why loopback success proves less than people want. It proves the process can bind, route locally, and speak through the local TCP stack.

For a destination on the same local network, route lookup usually selects a directly connected interface:

```text
192.0.2.10:random -> 192.0.2.40:3000
  -> route matches local subnet
  -> ARP for 192.0.2.40
  -> frame leaves wlan0 or eth0
```

The source address likely comes from the same interface. ARP resolves the peer's link-layer address, assuming the cache lacks a usable entry. The frame leaves the host through the selected interface. The peer's kernel receives it and matches it to a listening or connected socket.

For a remote destination, route lookup usually selects a gateway:

```text
192.0.2.10:random -> 203.0.113.20:3000
  -> default route via 192.0.2.1
  -> ARP for the gateway
  -> frame leaves toward the gateway
```

The link-layer target is the gateway, while the IP destination remains the remote address. That distinction matters in packet captures. The Ethernet frame goes to the next hop. The IP packet is addressed to the final destination for this leg of the path. Routers along the path repeat their own forwarding decisions until the packet reaches the destination network or fails.

Node sees none of that directly. It sees connection progress, errors, and readable or writable socket state. A timeout can mean the remote host never answered, a gateway dropped packets, a firewall blocked the path, a route sent traffic into a tunnel, neighbor resolution failed, or TCP state moved into a retry path. The JavaScript error arrives late and often lacks the lower detail.

Logging the endpoint tuple gives you a concrete starting point:

```js
socket.on('connect', () => {
  console.log(socket.localAddress, socket.localPort);
  console.log(socket.remoteAddress, socket.remotePort);
});
```

The local address tells you which source address the kernel selected. The remote fields tell you which numeric peer the socket reached after any lookup step. Pair that with `ip route get` for the remote address and `ss` for local socket state, and the host path becomes inspectable without changing application logic.

Inbound traffic has the same split. A server bound to `0.0.0.0:3000` can receive a loopback connection, a same-LAN connection, or a routed connection through a gateway or port-forwarding boundary. JavaScript gets the same connection callback shape each time. The accepted socket fields carry the local and remote endpoints for that specific path.

```js
net.createServer(socket => {
  console.log(socket.localAddress);
  console.log(socket.remoteAddress);
  socket.end();
}).listen(3000, '0.0.0.0');
```

Connect from the same host through `127.0.0.1`, then from the same host through its non-loopback address, then from another host. The printed addresses show different routing and delivery decisions under the same server object. That is the point of exposing per-socket address fields. The listening socket's wildcard address is only the receive policy. The connected socket records the concrete path.

## What Node APIs Hide on Purpose

Node's networking APIs expose enough state for application code. They hide enough kernel detail to keep the API portable.

`net.Socket` exposes the resulting local and remote addresses. OS tools expose the route table entry chosen for the connection. `os.networkInterfaces()` exposes interface addresses. OS tools expose neighbor cache state. `server.listen()` reports success or an error and gives you the bound address. Platform tooling exposes the socket options and kernel state behind that result.

That shape is deliberate API design. Node runs on Linux, macOS, Windows, BSD variants, containers, and assorted managed environments. The socket API has common concepts across them, but route tables, neighbor caches, interface names, privilege models, and dual-stack defaults differ. Node keeps the JavaScript surface centered on stable cross-platform operations: bind, connect, read, write, close, and inspect endpoint addresses.

The missing fields still exist. Use OS tools for them.

```text
Node API                 Host detail
os.networkInterfaces()   interface addresses
ss -ltnp                 listening TCP sockets
ip route get ADDRESS     route decision
ip neigh                 neighbor cache
```

That division keeps debugging honest. Use Node to inspect what the process asked for and what endpoint it received. Use the OS to inspect how the host decided to move packets. Use packet capture when the question has reached frames, packets, segments, and retransmission. Keep each tool attached to the layer that owns the state.

There is also a timing issue. Node can read a socket address after bind or connect. Route and neighbor state can change after that. Interfaces can go down. VPN routes can appear. A gateway can stop responding. DNS can later return a different address. A socket that connected successfully can still fail on a later write because lower state changed after setup.

Long-lived services need that mindset. Startup checks prove startup state only. The OS keeps making route, neighbor, buffer, and interface decisions for every packet after your server logs "listening."

## Where Node Ends

Node's low-level networking APIs give you objects, events, streams, buffers, addresses, ports, and errors. They sit above the host networking stack. The kernel socket table decides whether a bind is valid. The routing table decides the outbound interface. ARP or Neighbor Discovery resolves the next hop on local links. MTU constrains packet size. The interface sends and receives frames.

That division is good engineering pressure. Keep application code honest about what it owns.

If the bug is "the server never emits `connection`," inspect the listening address and socket table before changing application logic. If the bug is "the client connects from the wrong source address," inspect route selection before changing retry code. If the bug is "localhost works but the container cannot reach it," inspect loopback scope and bind address before touching HTTP. If the bug is "large writes stall," inspect buffering, backpressure, and MTU before blaming serialization.

Higher protocols sit on top of these primitives. DNS will turn names into candidate addresses. TCP will add connection lifecycle, flow control, retransmission, and teardown. `node:net` will expose socket APIs with stream semantics. UDP will expose message-oriented datagrams. HTTP and TLS will add their own state above transport.

The base path stays the same. JavaScript hands bytes to Node. Node crosses through libuv and native bindings. The kernel owns sockets, addresses, routes, packetization, and interfaces. Your process gets control again when the lower layers report a result it can turn into a callback, event, stream chunk, or error.
