# NodeBook

![NodeBook Cover](/public/nodebook_cover.jpg)

> [!TIP]
> For better experience, I'd recommend reading it on the [NodeBook Website](https://thenodebook.com) or if you prefer getting the slides and reading an e-book version (ePUB and PDF - both dark/light) you can download the digital bundle here: [NodeBook Digital Bundle](https://thenodebook.com/get)

NodeBook is my my way of explaining everything about Server side developement using Node.js, it's internals and the parts that matter when apps misbehave.

I started writing it because most Node material stops too early. You learn routes, middleware, promises, maybe some streams, then the hard parts get left as "go read the docs" or "profile it". Memory leaks, slow requests, blocked event loop, file descriptor limits, weird DNS behavior, broken backpressure, GC pauses, module loading issues. That is where Node starts getting interesting.

This repo has the public chapters. Some are finished, some are still being edited, and some parts will probably move around.

If you're brand new to JavaScript, this may be a bit much. You can still read it, but it assumes you know the basics and have written some Node before.

# Why

You don't need V8 internals to ship a small app.

Run Node in prod long enough and the internals stop feeling optional. The event loop, libuv, buffers, syscalls, TCP, thread pools, GC, module resolution, process signals, they all show up in bugs.

Node is also easy to poke at. Write a small script, run it, profile it, break it, change one thing, run it again.

# What is inside

[NodeBook](https://www.thenodebook.com) is planned as four volumes, 38 topics, and around 200+ sub-chapters.

You don't have to read it from page one. Pick the part you're dealing with. Streams, files, modules, networking, async behavior, perf, prod work, whatever.

# Structure

**Volume I** covers the runtime basics. What Node is, V8, libuv, event loop phases, microtasks, process lifecycle, buffers, streams, files, modules, and async patterns.

**Volume II** is about building with Node. Worker threads, child processes, clustering, crypto, HTTP, TLS, databases, queues, and the places where small choices get expensive later.

**Volume III** is performance and debugging. V8 optimization, hidden classes, inline caches, deopts, garbage collection, heap snapshots, flamegraphs, event loop delay, and memory leaks.

**Volume IV** is prod Node. Deploys, logs, metrics, security, scaling, incidents, and keeping services understandable after they've been running for a while.

# Status

Volume I is completely done. The rest is being written and reviewed.

There are runnable examples and small labs where they make sense. If something is wrong or unclear, open an issue or PR.

# Links

Read the book at [thenodebook.com](https://www.thenodebook.com).

Main repo: [github.com/ishtms/nodebook](https://github.com/ishtms/nodebook)

# Complete Chapter Index

## 01. Node.js Architecture

- [01. What Node.js Actually Is](chapters/01-node-arch/01-what-is-nodejs.mdx)
- [02. Inside the v8 engine](chapters/01-node-arch/02-v8-engine-intro.mdx)
- [03. The Node.js Event Loop](chapters/01-node-arch/03-event-loop-intro.mdx)
- [04. Node.js Process Lifecycle](chapters/01-node-arch/04-node-process-lifecycle.mdx)

## 02. Buffers & Binary Data

- [01. What is a Buffer?](chapters/02-buffers/01-what-is-buffer.mdx)
- [02. Buffer Allocation Patterns](chapters/02-buffers/02-allocation-patterns.mdx)
- [03. Working with buffers](chapters/02-buffers/03-working-with-buffers.mdx)
- [04. Memory Fragmentation and Exercises](chapters/02-buffers/04-fragmentation-and-challenges.mdx)

## 03. Streams

- [01. Foundation of Streams](chapters/03-streams/01-foundation-of-streams.mdx)
- [02. Readable Streams](chapters/03-streams/02-readable-streams.mdx)
- [03. Writable Streams](chapters/03-streams/03-writable-streams.mdx)
- [04. Transform Streams](chapters/03-streams/04-transform-streams.mdx)
- [05. Modern Async Pipelines and Error Handling](chapters/03-streams/05-modern-pipelines-error-handling.mdx)
- [06. Zero-Copy, Scatter/Gather I/O](chapters/03-streams/06-zero-copy-scatter-gather.mdx)

## 04. File System

- [01. File Descriptors & Handles](chapters/04-file-system/01-file-descriptors-and-handles.md)
- [02. Reading & Writing Files](chapters/04-file-system/02-reading-writing-files.md)
- [03. fs.promises & FileHandle](chapters/04-file-system/03-fs-promises-filehandle.md)
- [04. Watching & Atomic Writes](chapters/04-file-system/04-watching-atomic-writes.md)
- [05. Permissions, Metadata & Edge Cases](chapters/04-file-system/05-permissions-metadata-edge-cases.md)

## 05. Process & OS

- [01. The Process Object](chapters/05-process-os/01-process-object.md)
- [02. Signals & Exit Codes](chapters/05-process-os/02-signals-exit-codes.md)
- [03. The os Module](chapters/05-process-os/03-os-module.md)
- [04. Standard I/O](chapters/05-process-os/04-standard-io.md)

## 06. The Module System

- [01. CJS require() Internals](chapters/06-modules/01-cjs-require.md)
- [02. Module Resolution Algorithm](chapters/06-modules/02-resolution-algorithm.md)
- [03. ES Modules import/export](chapters/06-modules/03-esm-import-export.md)
- [04. CJS/ESM Interop & Dual Packages](chapters/06-modules/04-cjs-esm-interop.md)
- [05. import.meta, Caching & Circular Deps](chapters/06-modules/05-import-meta-caching.md)

## 07. Async Patterns

- [01. Callback Patterns and Error-First Convention](chapters/07-async-patterns/01-callback-patterns.md)
- [02. Promises and Microtask Scheduling](chapters/07-async-patterns/02-promises-microtasks.md)
- [03. Async/Await Under the Hood](chapters/07-async-patterns/03-async-await.md)
- [04. EventEmitter Internals](chapters/07-async-patterns/04-eventemitter-internals.md)
- [05. Async Iterators and for-await-of](chapters/07-async-patterns/05-async-iterators.md)
- [06. Promise Combinators and Advanced Patterns](chapters/07-async-patterns/06-promise-combinators.md)

## 08. Runtime Platform APIs & Tooling

- [01. CLI Flags and Runtime Configuration](chapters/08-runtime-platform/01-cli-runtime-configuration.md)
- [02. Environment Files and Configuration Loading](chapters/08-runtime-platform/02-env-files-configuration.md)
- [03. Built-In Web Platform APIs](chapters/08-runtime-platform/03-web-platform-apis.md)
- [04. TypeScript Execution and Compile Cache](chapters/08-runtime-platform/04-typescript-compile-cache.md)
- [05. REPL, Inspector, Watch Mode, and Single Executables](chapters/08-runtime-platform/05-repl-inspector-watch-sea.md)

## 09. Network Fundamentals with Node.js

- [01. TCP/IP Stack and OS Networking Primitives](chapters/09-networking/01-tcpip-os-networking.md)
- [02. DNS Resolution End to End](chapters/09-networking/02-dns-resolution.md)
- [03. TCP Connections, Flow Control, and Failure Modes](chapters/09-networking/03-tcp-flow-failure.md)
- [04. Sockets and the net Module](chapters/09-networking/04-sockets-net-module.md)
- [05. UDP and the dgram Module](chapters/09-networking/05-udp-dgram.md)
- [06. Socket Options, Keep-Alive, Nagle, and Backlog](chapters/09-networking/06-socket-options-backlog.md)
- [07. Full Request Path from Client to Process](chapters/09-networking/07-request-path-client-process.md)
