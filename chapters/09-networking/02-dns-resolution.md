---
title: "DNS Resolution End to End"
date: "2026-05-11"
excerpt: "How Node turns hostnames into addresses through the OS resolver, c-ares, recursive DNS, records, TTLs, caches, and address-family ordering."
category: "Network Fundamentals with Node.js"
tags: ["nodejs", "networking", "dns", "resolver", "c-ares"]
author: "Ishtmeet Singh @ishtms"
chapter: "networking"
subchapter: "dns-resolution"
published: true
toc: true
---

A hostname is still text when your code calls `net.connect()`. The connect path needs a numeric socket address. Node has to resolve the name, choose a candidate address, and only then ask the operating system to start the socket work.

```js
import net from 'node:net';

const socket = net.connect(443, 'example.com');

socket.on('connect', () => {
  console.log(socket.remoteAddress, socket.remotePort);
});
```

That call names a host and a port. Chapter 9.1 covered the lower socket path after the address is numeric. Here the input is different. `example.com` is text. The kernel connect path needs a socket address: address family, IP address, and port.

DNS is the naming system that maps domain names to records. For backend Node work, the most visible records are address records. A name such as `example.com` can produce IPv4 addresses, IPv6 addresses, aliases, mail routing records, text records, service records, and reverse-lookup records. The connection path only needs an address record, but production debugging often needs the other ones too.

A domain name is a structured DNS name made of labels. `api.example.com` has the labels `api`, `example`, and `com`. DNS treats the full name as a position inside its naming tree, with the rightmost labels closer to the top of the hierarchy. A hostname is a domain name used to identify a host for connection purposes. In application code, the two words get mixed constantly. The useful distinction is narrower: a hostname is the name you pass when you want an address for a network endpoint.

The port stays outside DNS.

```js
net.connect({ host: 'api.example.com', port: 5432 });
```

The resolver turns `api.example.com` into one or more candidate addresses. Node then combines each candidate address with `5432` and hands that socket address to the connection code. The port comes from the caller. TCP opens later. HTTPS certificate checks happen later.

That separation matters when an error surfaces. A DNS failure means the name-to-record step failed. A TCP failure means an address existed and the connection step failed. Higher client libraries often wrap both under one request error, so logging the lower code matters.

```js
socket.on('error', err => {
  console.error(err.code, err.hostname, err.address, err.port);
});
```

The fields depend on where the error surfaced. A DNS path may give you a hostname and no numeric address. A socket path may give you a numeric address and port. Keep those apart. It saves time.

Numeric addresses skip the name step.

```js
net.connect({ host: '192.0.2.10', port: 5432 });
```

With a numeric IPv4 address, Node can build an IPv4 socket address immediately. With a numeric IPv6 address, it can build an IPv6 socket address immediately. The OS still performs routing, local-address selection, and TCP connection work after that. DNS simply left the path because the caller already supplied the address.

That is a useful debugging split. Replace the hostname with one returned address. If the numeric connection fails the same way, you are below DNS. If the numeric connection works while the hostname fails, stay in resolver behavior. If one returned address works and another returned address fails, you have an address-family, route, listener, firewall, or later transport issue.

```js
const socket = net.connect({ host: '2001:db8::10', port: 443 });
socket.on('error', err => console.error(err.code));
```

That code skips DNS lookup. It can still fail because IPv6 routing is absent, the remote endpoint is closed, a firewall blocks it, or TCP connection setup fails. DNS answers are inputs to the socket layer. The next layer still has to use them.

Most high-level client code hides this boundary. `fetch('https://example.com')` parses a URL, extracts a host, resolves it, opens a connection, negotiates TLS for HTTPS, writes HTTP, and reads a response. Chapter 10 and Chapter 11 own those higher pieces. Here, keep only the first handoff: host string in, candidate addresses out.

Node lets some client APIs override that handoff with a custom lookup function.

```js
import http from 'node:http';

http.get({
  host: 'example.com',
  lookup(name, opts, cb) {
    const found = { address: '104.20.23.154', family: 4 };
    cb(null, opts.all ? [found] : found.address, found.family);
  }
});
```

That override changes the address source for the client. Global DNS behavior stays the same. Modern client paths may ask the hook for every candidate address with `opts.all`, so the callback has to return the array shape in that case. Libraries use this hook for tests, custom service routing, metrics, caching, and special resolver policy. It also creates another place where production behavior can drift from `dns.lookup()` in a small reproduction script.

## The Resolver Boundary

A resolver is the code path that answers DNS questions for a program. Sometimes that code path lives in the operating system's name-service stack. Sometimes it lives in a library that sends DNS packets itself. Node uses both paths, and the distinction drives most of the weird behavior in `node:dns`.

The OS resolver is the host's configured name-resolution path. On Unix-like systems it commonly includes `/etc/hosts`, resolver configuration, search domains, name-service switch rules, and one or more configured DNS servers. On Windows it uses Windows resolver configuration and policy. The exact path is host dependent.

`dns.lookup()` uses that OS path through `getaddrinfo()`.

```js
import dns from 'node:dns';

dns.lookup('localhost', { all: true }, (err, addresses) => {
  console.log(err ?? addresses);
});
```

`localhost` often resolves before any DNS packet leaves the host because the hosts file or OS policy owns that name. A hosts file is a local static name-to-address mapping file. On Unix-like systems it is usually `/etc/hosts`. On Windows it lives under the system drivers directory. The exact location matters less than the behavior: the OS resolver can answer from local configuration before reaching DNS.

That local answer can surprise you. `dns.lookup('localhost')` may return `::1`, `127.0.0.1`, or both with `all: true`, depending on host policy and Node ordering. A server bound only to `127.0.0.1` is an IPv4 listener. A client that picks `::1` targets IPv6 loopback. Chapter 9.1 already covered why those are different socket addresses.

There is another resolver path in Node. `dns.resolve4()`, `dns.resolve6()`, `dns.resolveMx()`, and the other `resolve*()` calls use c-ares. c-ares is a C library that performs asynchronous DNS protocol queries. In Node, it backs the DNS-query APIs that ask configured nameservers for specific record types.

```js
dns.resolve4('example.com', (err, addresses) => {
  console.log(err ?? addresses);
});
```

That call asks for A records. It uses DNS protocol behavior. It follows the c-ares query path rather than the host-name-service path used by `dns.lookup()`. It also avoids the libuv thread-pool work for `getaddrinfo()` because c-ares integrates with libuv through socket readiness. The result is still asynchronous JavaScript, but the lower owner changed.

One module. Two paths.

The difference shows up with short names too.

```js
dns.lookup('db', { all: true }, console.log);
dns.resolve4('db', console.log);
```

On a corporate network or inside a cluster, the OS resolver may apply search suffixes. The bare name `db` can be expanded into something configured on the host. The c-ares `resolve4()` path asks the DNS question for the name you passed through its resolver configuration. Depending on config, those two calls can disagree without any bug in Node.

The difference also shows up with name types. `lookup()` is for address selection. `resolve*()` is for DNS record queries. Asking `lookup()` for MX or TXT records uses the wrong tool; `getaddrinfo()` returns address information for connection setup. Asking `resolveMx()` before opening a TCP connection gives you mail-routing DNS data instead of the address list a normal HTTP client would use.

That sounds small until you debug a library. A database client may call `dns.lookup()` because it wants a socket. A configuration validator may call `dns.resolveSrv()` because it wants SRV records. A platform health check may call `resolve4()` because it wants to query a specific resolver. Those are all "DNS" in casual logs. They are different resolver paths in the process.

## The Recursive DNS Path

Most application processes usually ask a resolver close to them, and that resolver may already know the answer.

The usual full path looks like this:

```text
Node process
  -> local resolver path
  -> recursive resolver
  -> root nameserver
  -> TLD nameserver
  -> authoritative nameserver
  -> answer records
```

A recursive resolver accepts a DNS question from a client and does the follow-up work needed to produce an answer. Your laptop may use a router, ISP resolver, corporate resolver, cloud VPC resolver, or public resolver. A container may inherit resolver settings from the host or runtime. A Kubernetes pod may use cluster DNS first. The application usually sees a configured server IP and sends questions there.

Root nameservers are the top-level DNS servers that know where to send questions for top-level domains. A top-level domain nameserver owns delegation information for a suffix such as `com`, `org`, or `io`. An authoritative nameserver owns the DNS data for a zone and can answer for names inside that zone.

For `api.example.com`, the uncached path is roughly:

```text
recursive resolver asks root for api.example.com
root answers: ask .com servers
recursive resolver asks .com for api.example.com
.com answers: ask example.com authoritative servers
recursive resolver asks authoritative for api.example.com
authoritative answers: records for api.example.com
```

The exact packet exchange includes DNS message fields, response codes, additional records, glue records, EDNS options, UDP or TCP transport choices, and retry behavior. Backend Node code rarely needs every field. The core behavior is enough: each step either supplies the answer, supplies a delegation, or reports failure.

The recursive resolver then returns an answer to the client and usually caches it. Future clients asking the same resolver for the same record can receive the cached answer until the record's TTL runs out.

TTL means Time To Live. In DNS, a TTL is the number of seconds a resolver may cache a record answer before treating it as expired. Authoritative nameservers attach TTLs to records. Recursive resolvers count them down. Clients may see the remaining TTL or only the record data, depending on the API.

That cache layer explains why two machines can disagree for a while after a DNS change. One resolver has a cached old answer. Another resolver missed the old answer and fetched the new one. A third resolver may clamp TTL values based on local policy. The authoritative zone can be updated correctly while clients keep seeing older cached data.

Negative answers can be cached too. A resolver can cache the fact that a name or record type had no answer for a period controlled by DNS response metadata and resolver policy. That is why a name created moments after a failed lookup may still fail from the same network path. The resolver remembered the absence.

DNSSEC and DNS over HTTPS add other resolver behaviors. Keep them shallow here. DNSSEC adds cryptographic validation for DNS data. DNS over HTTPS sends DNS queries over HTTPS instead of the usual resolver transport path. Node's ordinary `dns.lookup()` and `dns.resolve*()` APIs still leave you dealing with the configured resolver behavior visible from the process.

The DNS message itself is small enough to understand at a working level. A query has a name, a type, and a class. The class is almost always Internet class for Node backend work. The type is the record kind: A, AAAA, MX, TXT, and so on. The name is encoded as labels rather than a URL string. A query for `api.example.com` type A means "give me IPv4 address records attached to this DNS name."

The response can carry several sections. The answer section contains records that answer the question. The authority section can point at nameservers that are authoritative for the next part of the name. The additional section can carry extra records that help the resolver continue, such as addresses for nameservers named in a delegation. Backend code usually sees the final parsed answer, but the recursive resolver uses those sections while walking delegation.

Delegation is the mechanism that lets different nameservers own different parts of the DNS tree. The root zone delegates `com` to TLD nameservers. The `com` zone delegates `example.com` to that domain's authoritative nameservers. The authoritative zone for `example.com` can then answer for `api.example.com`, or it can delegate a subdomain lower down. The resolver follows those delegations until it reaches an answer or a failure.

Authoritative nameservers can return several useful response shapes:

```text
answer records exist
name exists, requested type has no data
name is an alias through CNAME
name is absent
server failed to answer correctly
```

Those shapes later become Node error codes, empty-looking results, or record arrays. The mapping varies because OS resolver APIs and c-ares expose different errors. Still, the response shape tells you where to look. A missing AAAA record is a record-type issue. A missing name is a naming issue. A server failure points at the resolver path or authoritative server behavior.

CNAME handling is another detail worth keeping in view. If `api.example.com` is a CNAME to `edge.example.net`, an A query for `api.example.com` can return the alias record plus address records for the target name. Resolvers may cache pieces of that chain separately according to each record's TTL. After a change, one resolver can hold the old alias while another resolver has already fetched the new target. The visible symptom is a name that points at different address sets from different networks.

DNS mostly uses UDP for ordinary queries because one request and one response usually fit. Larger responses, truncation, zone-transfer cases, and some resolver policies can use TCP. Node application code using `resolve*()` usually leaves that per-query transport choice to c-ares and resolver behavior. Keep the fact narrow: DNS has its own transport work before your TCP connection to the application server even begins.

Recursive resolvers also apply policy. They can block names, rewrite internal zones, synthesize answers, prefer local replicas, clamp TTLs, or forward different domains to different upstreams. Corporate networks, cloud VPCs, and clusters use this heavily. From Node, it still looks like "the resolver answered." From an operations view, the answer may have passed through policy before it reached the process.

That policy is why comparing only against a public resolver can mislead you. If production uses an internal resolver that knows `db.service.internal`, a public resolver returning `ENOTFOUND` proves almost nothing about production. Match the resolver path before comparing answers.

Recursive resolution also has bailouts. A resolver can stop after too many CNAME hops. It can reject malformed responses. It can retry another authoritative server when one fails. It can fall back to TCP after a truncated UDP answer. It can return a cached failure when upstream servers are unreachable and local policy permits serving that state. Those behaviors sit outside Node, but they shape the error and latency profile your process sees.

Latency stacks up across this path. A cold recursive lookup can require several network round trips before Node gets a single address candidate. A warm resolver cache can answer in one local round trip. A hosts-file answer through `dns.lookup()` can complete without DNS network traffic. When an outbound request is slow only on the first call after process start, DNS cache warmth is one candidate. Connection pool warmup and TCP/TLS setup are other candidates, so keep timings labeled by phase.

The DNS hierarchy also explains partial outages. If an authoritative nameserver set for `example.com` is unhealthy, names below that zone can fail while unrelated domains work. If a TLD nameserver path has trouble from one resolver network, domains under that suffix can look broken from that resolver and fine elsewhere. If only one record type is misconfigured, A can work while AAAA fails. The error belongs to the smallest failing question you can identify.

## Records Node Developers Actually Touch

A DNS record is a typed piece of DNS data attached to a name. The type tells the resolver how to interpret the record data.

Address records show up first.

```js
dns.resolve4('example.com', (err, records) => {
  console.log(records);
});
```

An A record maps a name to an IPv4 address. An AAAA record maps a name to an IPv6 address. The name can have several records of the same type, and the returned order can vary by resolver, authoritative server behavior, load-balancing setup, and client-side ordering rules.

```js
dns.resolve6('example.com', (err, records) => {
  console.log(records);
});
```

An address family is the protocol family for an address. In Node's networking APIs you mostly see `4` for IPv4 and `6` for IPv6, or string forms such as `IPv4` and `IPv6` in `os.networkInterfaces()`. The family is part of the socket address. `127.0.0.1:3000` and `::1:3000` target different families.

A CNAME record says one DNS name is an alias for another DNS name. Resolvers follow the alias and return the final records requested by the client, subject to normal DNS rules and cache behavior.

```js
dns.resolveCname('www.iana.org', (err, names) => {
  console.log(err?.code ?? names);
});
```

CNAMEs matter because the visible hostname in configuration may be an alias. The address records may live on the target name. Debugging only the first name can miss the actual owner of the address answer.

CNAMEs also affect ownership boundaries. A team may own `api.company.test`, while a platform provider owns the target name and its address records. A DNS check against the visible name may show a short TTL on the CNAME and a different TTL on the target address records. Resolvers cache each record according to its own TTL. Change timing follows the slowest relevant cached piece along the path being observed.

MX records define mail exchangers for a domain. Node backend services touch them when validating mail routing or building mail infrastructure checks.

```js
dns.resolveMx('example.com', (err, records) => {
  console.log(records);
});
```

TXT records attach text values to a DNS name. They show up in ownership verification, SPF, DKIM, DMARC, and assorted platform verification flows. The DNS layer sees text chunks. The application or external service gives those chunks meaning.

```js
dns.resolveTxt('example.com', (err, records) => {
  console.log(records);
});
```

SRV records describe service endpoints with priority, weight, port, and target name. Some systems use them for locating protocol endpoints without hard-coding a host and port in application config.

```js
dns.resolveSrv('_sip._udp.sip2sip.info', (err, records) => {
  console.log(err?.code ?? records);
});
```

Service discovery as an architecture topic belongs much later. At this level, an SRV record is just a typed DNS record whose data includes a port and target name. The socket remains unopened.

SRV records are one of the few common DNS records that carry a port. Code that understands SRV semantics has to read that port. `net.connect('service.example.com')` performs ordinary address lookup semantics for the host it receives. If a protocol expects SRV, the client library must implement that DNS lookup path.

PTR records support reverse lookups. They map an address-derived DNS name back to a domain name. Node exposes this through `dns.reverse()`.

```js
dns.reverse('8.8.8.8', (err, hostnames) => {
  console.log(err ?? hostnames);
});
```

Reverse DNS is operational data. It can help with logs, mail systems, and diagnostics. Treat it as a DNS answer rather than identity proof. Certificate validation, HTTP host routing, proxy headers, and application identity all live at higher layers.

NS and SOA records are useful around debugging even when application code rarely consumes them. NS records name the authoritative nameservers for a zone or delegation. SOA records carry zone metadata, including values that influence negative caching. Node exposes `resolveNs()` and `resolveSoa()` for these. Use them when the question is "which nameserver owns this answer" or "why is absence cached for this long."

`dns.resolve()` can request a type by string:

```js
dns.resolve('example.com', 'MX', (err, records) => {
  console.log(records);
});
```

Most code is clearer with the typed helpers because the return shape differs by record type. `resolve4()` returns address strings by default. `resolveMx()` returns objects with exchange and priority fields. `resolveTxt()` returns arrays of string chunks because TXT data can be split into multiple character strings inside one record.

Record type matters for errors. A name can answer for A and fail for MX. A name can answer for TXT and have no address records. A name can be delegated correctly and still lack the type your code asked for. When logs include only the name, they throw away half the DNS question. Log the type too.

```js
async function readTxt(name) {
  try {
    return await dns.resolveTxt(name);
  } catch (err) {
    console.error({ name, type: 'TXT', code: err.code });
    throw err;
  }
}
```

That tiny wrapper records the actual DNS question. During debugging, it beats "lookup failed" because the resolver path, name, and type are visible.

## TTLs, Caches, and Stale Answers

DNS bugs often look inconsistent because caches sit at several points.

The authoritative nameserver has current zone data. A recursive resolver has cached answers. The operating system may cache names. A runtime, library, or connection pool may keep resolved addresses or open sockets. A cloud load balancer may update DNS before every client has dropped old connections. Those are separate pieces of state.

Small TTLs reduce the maximum normal cache lifetime at resolvers that honor them. They also increase query volume. Large TTLs reduce query volume and make planned changes slower to appear. There is no Node setting that makes the entire Internet forget a cached answer.

`dns.resolve4()` can ask Node to include TTL values:

```js
dns.resolve4('example.com', { ttl: true }, (err, records) => {
  console.log(records);
});
```

The records come back as objects with `address` and `ttl`. That TTL is the resolver's reported remaining TTL for the answer. Another client using another recursive resolver can see a different number or a different answer.

`dns.lookup()` has a different shape. It asks the OS for address information through `getaddrinfo()`. The OS resolver may use DNS, hosts files, mDNS, enterprise name services, or local cache policy. The result carries address info rather than raw DNS response records, so DNS TTL values stay out of the JavaScript return shape.

```js
dns.lookup('api.example.com', { all: true }, (err, addresses) => {
  console.log(addresses);
});
```

When a deployment updates `api.example.com`, repeated calls can produce mixed answers for a while. One process may use a cached old address. Another process may ask a resolver that already fetched the new answer. A long-lived HTTP client may keep an existing TCP connection to the old address and perform no lookup for the next request. DNS changed; the connection pool kept using a socket it already had.

Hosts-file overrides make this more local.

```text
127.0.0.1 api.example.test
```

After that entry exists in the host resolver path, `dns.lookup('api.example.test')` can return `127.0.0.1`. `dns.resolve4('api.example.test')` asks DNS servers for A records and can fail because the hosts file belongs to the OS resolver path. That split is one of the fastest ways to prove which Node API a dependency is using.

Negative caching has the same shape. If `new-api.example.com` returns no answer at 10:00 and the record is created at 10:01, some resolvers may keep reporting the earlier failure until their negative cache entry expires. A retry loop inside Node cannot force that resolver to refetch early through ordinary DNS APIs.

Container and VM environments add another cache layer through generated resolver config. A container may point at an internal DNS forwarder. That forwarder may point at the host or cluster resolver. The recursive resolver seen by the process may be several hops away from the authoritative nameserver. The Node API still reports one asynchronous result.

The practical debugging move is to pin the question.

```text
name: api.example.com
type: A or AAAA
resolver path: OS lookup or DNS query
resolver server: which IP, if known
observed answer: addresses and TTL, if available
time: when the answer was observed
```

Without those fields, "DNS is wrong" means too many things. The name may be wrong. The record type may be missing. The recursive resolver may be stale. The OS resolver may be using a hosts file. The application may be reusing an old connection and doing no lookup at all.

Node's own DNS module is an API over lower resolver behavior. Application-level answer caching belongs to your code or a library. Ordinary `dns.resolve*()` calls ask through c-ares and the configured resolver path. Ordinary `dns.lookup()` calls ask the OS resolver path. Caching may happen below Node. If your service needs a process-local cache with custom expiration, that cache needs to honor TTLs intentionally.

Long-lived clients create a separate "cache" by avoiding lookups. An HTTP agent can keep a socket open. A database pool can keep connections open. A gRPC channel can hold subchannels. While those connections stay alive, the client can keep talking to old addresses after DNS has changed. That behavior is connection reuse rather than DNS caching. It still looks like stale DNS from the outside because new lookups would choose different addresses.

Rolling changes need both timelines: answer lifetime and connection lifetime.

```text
DNS TTL controls cached answers
connection pooling controls old sockets
retry policy controls when new addresses are tried
```

If a service moves from one address to another, lowering TTL shortly before the move helps only for clients that perform new lookups after the lower TTL has propagated through caches. Clients holding existing sockets keep using those sockets until they close, fail, or are retired by pool policy. That is why infrastructure changes often require connection-drain behavior as well as DNS changes.

The hosts file bypass creates another class of stale answer. A developer can add a local override during testing and forget it. `dns.lookup()` follows the OS resolver path and keeps returning the override. `dns.resolve4()` may return the real DNS answer. The application seems broken only on that machine. The right debug step is to compare lookup path against DNS-query path and then inspect local resolver config.

Search domains can create silent suffixes. A bare name such as `api` may resolve to `api.corp.example` through OS policy. Another machine with a different search suffix reports failure. Code that relies on bare names is relying on resolver configuration. That can be fine inside a controlled network, but the dependency belongs in deployment config rather than a vague assumption about DNS.

TTL zero deserves exact language. Some records use TTL `0` to ask resolvers to avoid caching or cache only briefly. Resolver implementations and intermediate systems can still apply local policy. Treat TTL `0` as a request carried in DNS data, then verify the resolvers your process actually uses.

Application-level retries interact badly with stale resolver state. Retrying the same name through the same resolver can repeat the same cached answer until TTL expiration. Switching to a numeric address skips the resolver and tests the next layer. Switching to another resolver tests resolver-specific cache and policy. Those are different experiments; run the one that matches the failure.

There is also a time-of-check problem. A process can resolve a name, wait, then connect later. The answer may expire in DNS during that wait, but the process still has the string address it already received. DNS TTLs govern cache freshness at resolvers. Once application code stores an address, that storage owns its own staleness.

```js
const addresses = await dns.resolve4('api.example.com');
setTimeout(() => connectTo(addresses[0]), 60_000);
```

That code keeps the address for a minute regardless of the DNS TTL. Maybe that is fine. Maybe it is a bug. The resolver has no way to pull the value back out of your variable.

## Node's Two DNS Paths

The `node:dns` module exposes one namespace over two lower mechanisms.

`dns.lookup()` is the address lookup API used by many Node networking calls. `net.connect()`, `http.request()`, `https.request()`, and higher clients commonly use lookup semantics before opening a socket, unless they provide a custom lookup function or already have a numeric address.

```js
dns.lookup('example.com', (err, address, family) => {
  console.log(address, family);
});
```

Under the covers, Node calls `getaddrinfo()` through libuv. `getaddrinfo()` is the system API that converts a node name and service hints into address structures. For Node's use here, the output is candidate IP addresses and address-family data. The OS resolver owns the policy: hosts file, search suffixes, address-family availability, local cache, and platform-specific name services.

`getaddrinfo()` can block at the C API level while the OS resolver does its work. Node keeps the JavaScript thread free by running that work through the libuv thread pool. Chapter 1 covered the thread pool, so the local point is small: many concurrent `dns.lookup()` calls can occupy worker threads that other thread-pool work also needs.

The rough call path looks like this:

```text
JavaScript dns.lookup()
  -> Node dns binding
  -> libuv uv_getaddrinfo request
  -> libuv thread pool
  -> OS getaddrinfo()
  -> callback on the event loop
```

`uv_getaddrinfo` is libuv's wrapper around the platform address-lookup API. Node creates a request, attaches the JavaScript callback state, and asks libuv to run the lookup off the main JavaScript thread. When the worker finishes, libuv posts completion back to the event loop. Node converts the native address structures into JavaScript strings and family numbers.

That completion path keeps slow resolver work away from JavaScript execution. Timers can fire. Existing sockets can read. Promises can settle. The lookup callback arrives later. At the same time, thread-pool capacity is finite. A burst of slow OS lookups can sit beside file-system and crypto work in the same pool.

```js
for (const host of hosts) {
  dns.lookup(host, err => {
    if (err) console.error(host, err.code);
  });
}
```

That loop lets JavaScript continue while callbacks are pending. It can still create lower pressure. If the OS resolver is slow, those lookup jobs sit in the pool. File-system work, crypto work, and other pool users may feel the contention depending on the process and `UV_THREADPOOL_SIZE`.

The pool interaction is one reason high-throughput clients sometimes add a lookup cache or a custom resolver strategy. That decision has a cost. Once the application caches DNS answers, it owns expiration, negative caching behavior, address-family ordering, and failure retry policy. A sloppy cache can keep dead addresses longer than the recursive resolver would have. A cache that ignores failed lookups can hammer a resolver during an outage.

Node networking APIs often expose the lookup hook because the runtime cannot know every deployment policy. The hook shape follows `dns.lookup()` semantics: hostname, options, callback with address and family.

```js
function lookup(host, options, callback) {
  dns.lookup(host, { ...options, all: false }, callback);
}
```

Real custom lookup functions usually do more than wrap `dns.lookup()`. They might record timing, cache answers, prefer private addresses, or read from a service registry. The contract is still narrow. The caller expects a usable address and family for a socket attempt. Returning an address without a correct family creates lower socket failures that look unrelated to DNS.

With `all: true`, the custom lookup contract changes shape for clients that request all addresses. `net.connect()` and `http.request()` can set that option when address-family autoselection is active.

```js
function lookup(host, options, callback) {
  callback(null, [{ address: '127.0.0.1', family: 4 }]);
}
```

Code that implements this hook should honor the `options` object it receives. If the client asks for `family: 6`, returning IPv4 breaks the caller's policy. If the client asks for all addresses, returning only one address can disable fallback behavior. The hook is small, but it sits on a sensitive boundary.

`dns.resolve*()` uses c-ares for DNS protocol queries. c-ares creates sockets, sends DNS messages to configured nameservers, and integrates completion with the event loop. It asks for DNS records by type. It bypasses most OS name-service policy, including hosts-file answers.

```js
dns.resolve6('example.com', (err, addresses) => {
  console.log(err ?? addresses);
});
```

That call asks configured DNS servers for AAAA records. If the hosts file contains an IPv6 mapping for `example.com`, `resolve6()` still asks DNS. If DNS has no AAAA record, the call reports a DNS answer state for that record type.

The c-ares path has a different shape:

```text
JavaScript dns.resolve4()
  -> Node dns binding
  -> c-ares channel
  -> DNS query socket
  -> configured nameserver
  -> callback on the event loop
```

c-ares owns the DNS query state. It tracks outstanding queries, server choices, retries, timeouts, and response parsing. libuv watches the sockets that c-ares wants to read or write. When a DNS response arrives, c-ares parses it and Node converts the record data into JavaScript return shapes.

No `getaddrinfo()` call sits in that path. No OS hosts-file lookup sits in that path. The configured nameservers still commonly come from OS resolver configuration at startup or reinitialization points, but the query behavior is c-ares behavior once Node is running the call.

That last sentence is where many bugs live. The c-ares path can use the same configured nameserver IPs as the OS resolver and still produce different behavior because it skipped name-service switch rules, search handling differences, local caches, or enterprise plugins. Same resolver address. Different client behavior.

c-ares also means DNS query load can be visible as UDP or TCP traffic from the process to resolver servers. In locked-down environments, egress rules may permit the OS resolver service path and block direct DNS traffic from application containers. In that setup, `dns.lookup()` can succeed while `dns.resolve4()` times out or gets refused. The failure belongs to network policy around the DNS query path rather than the target service.

The reverse can happen too. A container image may have a broken hosts file or resolver policy for OS lookup, while direct c-ares queries to a known server work. Comparing both paths tells you whether to inspect local name-service configuration or DNS server behavior.

`dns.setServers()` belongs to the c-ares path.

```js
dns.setServers(['1.1.1.1', '8.8.8.8']);

dns.resolve4('example.com', (err, addresses) => {
  console.log(addresses);
});
```

That changes servers used by `resolve*()` calls in the current process context. The OS resolver used by `dns.lookup()` keeps its own configuration. `/etc/resolv.conf`, Windows resolver settings, and other process-wide host policy outside Node's c-ares resolver state stay as they were.

For isolated resolver settings, use a `Resolver` instance.

```js
const resolver = new dns.Resolver();
resolver.setServers(['8.8.8.8']);

resolver.resolve4('example.com', (err, addresses) => {
  console.log(addresses);
});
```

That instance keeps its own server list for c-ares queries. It remains separate from `dns.lookup()` and from the global resolver's server list.

Per-instance resolvers are handy for diagnostics because they make the resolver server explicit without changing the rest of the process.

```js
const corp = new dns.Resolver();
const pub = new dns.Resolver();

corp.setServers(['10.0.0.53']);
pub.setServers(['1.1.1.1']);
```

Ask both for the same record type. If only the corporate resolver answers, the name is internal. If both answer but disagree, compare TTLs and authority. If both fail while `lookup()` succeeds, inspect hosts files, search domains, and OS name services.

The `Resolver` instance is also useful for test isolation. A test can point one resolver at a local DNS server without changing global c-ares servers for unrelated tests running in the same process. It still uses real DNS protocol behavior. For pure unit tests, a custom lookup function or direct dependency injection is usually cleaner than depending on live DNS.

The promise API mirrors the callback API.

```js
import { promises as dns } from 'node:dns';

const records = await dns.resolve4('example.com');
console.log(records);
```

Promises change the JavaScript consumption style only. `dns.promises.lookup()` still uses lookup semantics. `dns.promises.resolve4()` still uses c-ares query semantics.

Choose based on the job.

Use `dns.lookup()` when you want the same address-selection behavior Node would use for a connection on that host. It respects local host policy. It can see hosts-file entries. It gives you address-family data ready for a socket.

Use `dns.resolve*()` when you need DNS records as DNS records. MX checks, TXT verification, SRV reads, TTL inspection, and "what does this resolver say for AAAA" all belong there.

The trap is testing a connection path with the wrong API. A production client may use `dns.lookup()` through `http.request()`. A debugging script may use `dns.resolve4()` and get a different answer. Both results can be correct because they asked different systems different questions.

There is a second trap: `dns.lookup()` with `all: false` hides alternate candidates.

```js
dns.lookup('example.com', (err, address, family) => {
  console.log(address, family);
});
```

That callback receives one selected address. If the name has ten address records across two families, the callback still shows one address. For debugging, use `all: true` and record the whole candidate list. For connection setup, one selected address may be enough if the client has fallback behavior elsewhere.

`lookupService()` goes the other direction. It maps a numeric address and port to a hostname and service name through the OS path.

```js
dns.lookupService('127.0.0.1', 80, (err, host, service) => {
  console.log(host, service);
});
```

That is reverse lookup plus service-name mapping through system facilities. It is useful for diagnostics. Peer validation and application authentication live elsewhere.

`lookup()` also applies address-family and ordering options.

```js
dns.lookup('example.com', { family: 6 }, (err, address) => {
  console.log(address);
});
```

That asks for an IPv6 result. With `{ all: true }`, it returns all addresses selected by the OS lookup path and Node ordering rules:

```js
dns.lookup('example.com', { all: true }, (err, addresses) => {
  console.log(addresses);
});
```

The objects look like `{ address: '...', family: 4 }` or `{ address: '...', family: 6 }`. That shape is close to what later connection attempts need.

`resolve4()` and `resolve6()` split the family by record type:

```js
const [v4, v6] = await Promise.all([
  dns.resolve4('example.com'),
  dns.resolve6('example.com')
]);
```

That code asks two DNS questions. Socket attempt order is a later connection-policy decision. Fallback policy, local routing, and Happy Eyeballs behavior belong later. For this chapter, stop at address candidates.

## Address Family and Lookup Ordering

Lookup ordering decides which candidate address appears first when a name has several usable answers.

In Node v24, `dns.getDefaultResultOrder()` reports the process default order. On a stock Node v24 build, it commonly reports `verbatim`, which means Node preserves the order returned by the resolver path rather than forcing IPv4 first.

```js
console.log(dns.getDefaultResultOrder());
```

The process default can be changed:

```js
dns.setDefaultResultOrder('ipv4first');
```

Valid order values include `verbatim`, `ipv4first`, and `ipv6first` in current Node. The setting affects `dns.lookup()` result ordering. Code can also pass an order for a specific lookup:

```js
dns.lookup('localhost', { all: true, order: 'ipv4first' }, (err, out) => {
  console.log(out);
});
```

Ordering is observable because clients often try the first address before later candidates. If `localhost` returns `::1` first and a server listens only on `127.0.0.1`, the first connection attempt targets the IPv6 loopback socket address. Some client paths then try IPv4. Some surface the first failure. Higher-level clients have their own behavior.

`dns.lookup()` also accepts `family`.

```js
dns.lookup('localhost', { family: 4 }, (err, address) => {
  console.log(address);
});
```

That constrains the answer to IPv4. `family: 6` constrains it to IPv6. `family: 0` means either family. Address-family filtering happens before the connection attempt. The later socket path receives the selected family.

There are resolver hints too, such as `dns.ADDRCONFIG` and `dns.V4MAPPED`. They map to `getaddrinfo()` hint behavior where the platform supports it. `ADDRCONFIG` asks the OS to consider configured local address families. `V4MAPPED` can request IPv4-mapped IPv6 addresses in contexts where that makes sense. Platform behavior varies, so use these only when you have a concrete reason and tests on the target hosts.

Avoid using lookup ordering as a hidden compatibility layer for bad binds. If a server must support both loopback families, bind and test both families under the intended platform policy. If a client must prefer IPv4 or IPv6 for a reason, make that policy explicit at the lookup or connection layer and record it in configuration.

The `all: true` option is the debugging friend.

```js
dns.lookup('api.example.com', { all: true }, (err, addresses) => {
  console.table(addresses);
});
```

Seeing every candidate makes the next failure easier to place. A missing IPv6 answer is a DNS record problem or resolver policy issue. A present IPv6 answer followed by connect failure is a route, listener, firewall, or transport problem. A present IPv4 answer ignored by the client is an ordering or fallback issue.

Ordering is process state, and worker boundaries can matter. Code that changes the default result order should do it during bootstrap, close to other runtime configuration. Libraries should usually prefer per-call options over changing global DNS behavior for the whole process. A package that calls `dns.setDefaultResultOrder()` during import can alter unrelated clients in the same process.

Use the narrowest control that fits:

```js
dns.lookup(host, { all: true, order: 'ipv6first' }, cb);
```

That call states its own policy. The rest of the process keeps its default. For tests, this is also easier to reason about because the ordering dependency sits next to the assertion.

Happy Eyeballs, the connection strategy that races or staggers address-family attempts, belongs to the full request-path subchapter. The DNS part ends at candidate addresses and order. The socket part decides what to try and when.

## Failure Codes and Debugging

DNS errors are easier to read when you keep the API path attached to the code.

`ENOTFOUND` means the chosen resolver path failed to resolve the requested name. For `dns.lookup()`, it usually means the OS resolver path produced no address for that hostname. For `dns.resolve*()`, it usually maps to a DNS name error or a no-such-name style result from the DNS query path.

```js
dns.lookup('missing.example.invalid', err => {
  console.error(err.code);
});
```

`EAI_AGAIN` means a temporary resolver failure. The name might work later. Common causes include DNS server timeout, transient resolver failure, network loss between the host and resolver, or local resolver trouble. Treat it differently from a stable "name is absent" answer.

`ENODATA` means the name exists in the DNS path, but the requested record type has no data in the observed answer path. A name can have A records and no MX records. A name can have A records and no AAAA records. That differs from the whole name being absent.

```js
dns.resolveMx('example.com', err => {
  if (err) console.error(err.code);
});
```

The exact code can differ by API, platform, resolver, and timing. Keep logs concrete:

```js
function logDnsError(name, type, err) {
  console.error({ name, type, code: err.code, errno: err.errno });
}
```

For connection-heavy code, log the lookup result and the connect error separately.

```js
dns.lookup(host, { all: true }, (err, addresses) => {
  if (err) return console.error('lookup', err.code);
  console.log('lookup', addresses);
});
```

Then test the numeric address path. Chapter 9.1 gave the socket boundary; use it. If a numeric connect to the returned address fails, DNS did its part and the transport path failed. If lookup fails before any address appears, the socket path is still pending.

`ENOTFOUND` from an HTTP client can hide the lower DNS operation. Get the original error when possible. Node errors often carry `code`, `errno`, `syscall`, and `hostname`. Some client libraries wrap those fields; good wrappers preserve them. Losing `hostname` and `code` turns a resolver failure into a generic request failure.

`EAI_AGAIN` deserves retry care. Retrying immediately from thousands of requests can amplify resolver trouble. Use bounded retries and jitter at the caller layer if retrying name resolution is part of the client policy. Keep the retry budget separate from TCP retry or HTTP retry budgets, because they fail at different layers.

`ENODATA` deserves a record-type check. If `resolve6()` returns `ENODATA` while `resolve4()` returns addresses, the service may be IPv4-only. If `resolveMx()` returns `ENODATA`, the domain may receive no mail directly. The name can still exist. The requested data is absent.

Other DNS codes appear too. `ESERVFAIL` points at a server failure response. `ETIMEOUT` points at query timeout in the DNS-query path. `ECONNREFUSED` can appear when the configured DNS server rejects the query transport. Keep the resolver path, name, type, and server path attached to the error.

The c-ares path can be isolated with `Resolver`.

```js
const r = new dns.Resolver();
r.setServers(['8.8.8.8']);
r.resolve4('api.example.com', (err, records) => {
  console.log(err?.code ?? records);
});
```

Compare that with the process's normal lookup:

```js
dns.lookup('api.example.com', { all: true }, (err, out) => {
  console.log(err?.code ?? out);
});
```

Different answers tell you the split. A hosts-file override appears in `lookup()` and disappears from `resolve4()`. A custom c-ares server affects the resolver instance and leaves `lookup()` alone. A corporate resolver may answer internal names that a public resolver cannot answer. A search suffix may make a short hostname work through the OS path while a DNS protocol query for the bare name fails.

Search domains are another OS resolver feature. A host can be configured so a short name such as `db` is tried with configured suffixes. `dns.lookup('db')` may resolve through that policy. `dns.resolve4('db')` asks DNS for the name as given through the c-ares path. Internal infrastructure relies on this often enough that the difference deserves a log line during debugging.

Kubernetes makes that visible. A pod often has search domains for its namespace and cluster. A short service name can resolve through the OS lookup path because resolver config expands it. A direct c-ares query for that short name may behave differently depending on c-ares handling of that resolver config and options. For portable diagnostic scripts, query the fully qualified service name and record which API you used.

Cloud private DNS behaves the same at a higher boundary. A name can resolve inside a VPC and fail from a laptop. A public resolver can return no answer while the cloud resolver returns private addresses. That is resolver scope. Match the source network and resolver before comparing results.

Timeouts need care. A request timeout in an HTTP client may include DNS time, TCP connect time, TLS handshake time, request write time, server processing time, and response read time. A DNS timeout code from `node:dns` is narrower. It says the resolver operation failed to produce an answer in time. Keep timeout labels exact.

For local debugging, start with names that avoid external DNS.

```js
dns.lookup('localhost', { all: true }, console.log);
```

That tests the OS lookup path and local host policy. Then test a real DNS query:

```js
dns.resolve4('example.com', console.log);
```

The first can succeed with no DNS server. The second needs DNS query behavior. If the first works and the second times out, your process can use local resolver policy but cannot complete c-ares DNS queries to its configured servers. If the second works and a dependency using `lookup()` fails, inspect hosts files, search domains, OS resolver config, and thread-pool pressure.

The last debugging check is address family. Log every answer, including the one the client tried.

```js
dns.lookup(host, { all: true, order: 'verbatim' }, (err, all) => {
  console.log(all);
});
```

A name can resolve correctly and still feed the next layer an address the host cannot use. IPv6 DNS may be present while IPv6 routing is broken. IPv4 may work while an IPv6-first path fails early. DNS produced candidates. The socket path still has to prove each candidate.

A compact DNS debug script should print both paths:

```js
const host = process.argv[2];

dns.lookup(host, { all: true }, (err, out) => {
  console.log('lookup', err?.code ?? out);
});

dns.resolve4(host, (err, out) => {
  console.log('A', err?.code ?? out);
});
```

That snippet stays under the line-count limit by checking only A records. Add `resolve6()` when address-family behavior is part of the bug. Add a `Resolver` instance when the server IP matters. Add numeric `net.connect()` only after you have candidate addresses.

The fastest path through a DNS incident is usually:

```text
capture failing hostname and record type
check lookup path used by the code
print all address candidates
compare OS lookup with c-ares query
test numeric socket address
inspect caches and TTLs
```

That sequence keeps the boundary intact. It prevents a TCP failure from being mislabeled as DNS. It prevents a hosts-file override from being mistaken for authoritative DNS. It prevents an IPv6 route problem from being hidden under "hostname failed."

When the failure sits inside a larger client, add timing around the lookup boundary. A custom lookup wrapper can record start time, end time, hostname, options, and result count. Keep it temporary if the client library already has tracing hooks.

```js
const timedLookup = (host, opts, cb) => {
  const started = performance.now();
  dns.lookup(host, opts, (err, address, family) => {
    console.log(host, performance.now() - started);
    cb(err, address, family);
  });
};
```

That wrapper measures the OS lookup path only. TCP connect time sits below it. If the lookup finishes quickly and the request still stalls, move down to the socket path. If lookup consumes most of the request budget, stay with resolver config, cache state, and thread-pool pressure.

Names end at addresses. After that, the chapter hands control back to the primitives from 9.1: address family, socket address, route lookup, kernel socket state, and the eventual connection lifecycle that TCP owns.
