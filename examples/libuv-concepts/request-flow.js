/**
 * request-flow.js
 * 
 * The Million Dollar Question: "Is this operation using the thread pool?"
 * 
 * This example demonstrates which Node.js operations use libuv's thread pool
 * versus native OS async mechanisms. Understanding this distinction is crucial
 * for performance optimization and debugging.
 * 
 * THREAD POOL Operations (Default: 4 threads via UV_THREADPOOL_SIZE):
 * - File system operations (with some exceptions like FSWatcher)
 * - DNS lookup() (but not resolve())
 * - Crypto operations (CPU-intensive ones)
 * - Some user-specific operations via C++ addons
 * 
 * OS-NATIVE ASYNC Operations (epoll/kqueue/IOCP):
 * - TCP/UDP networking
 * - Pipes
 * - TTY operations
 * - DNS resolve() functions
 * - Child processes
 * - Signals
 * 
 * Run this and watch the completion order - it's enlightening!
 */

const fs = require('fs');
const dns = require('dns');
const net = require('net');
const crypto = require('crypto');

console.log('='.repeat(70));
console.log('ASYNC OPERATION FLOW DEMONSTRATION');
console.log('Thread Pool Size:', process.env.UV_THREADPOOL_SIZE || '4 (default)');
console.log('='.repeat(70));

const startTime = Date.now();
const log = (msg) => console.log(`[${String(Date.now() - startTime).padStart(4)}ms] ${msg}`);

// =============================================================================
// SECTION 1: THREAD POOL OPERATIONS
// =============================================================================
log('Initiating THREAD POOL operations...\n');

// -----------------------------------------------------------------------------
// 1A. FILE SYSTEM READ
// -----------------------------------------------------------------------------
// When you call fs.readFile, here's what happens internally:
// 1. Node.js creates a uv_fs_t request structure
// 2. libuv sees this is a blocking operation (file I/O can block)
// 3. libuv calls uv_queue_work() to submit this to the thread pool
// 4. One of the 4 worker threads picks up this task
// 5. The thread performs the actual read() system call (BLOCKING!)
// 6. Once complete, the result is queued back to the main thread
// 7. In the next event loop iteration, your callback is called

fs.readFile(__filename, 'utf8', (err, data) => {
  if (err) throw err;
  log(`✓ FS.READFILE completed (Thread Pool)`);
  log(`  → Used one of ${process.env.UV_THREADPOOL_SIZE || 4} threads`);
  log(`  → File size: ${data.length} bytes`);
});

// -----------------------------------------------------------------------------
// 1B. DNS LOOKUP (getaddrinfo)
// -----------------------------------------------------------------------------
// DNS is tricky! There are two ways to do DNS in Node.js:
// 
// dns.lookup() - Uses getaddrinfo() system call:
//   - Can read /etc/hosts, respect system configuration
//   - But getaddrinfo() is BLOCKING on most systems!
//   - So libuv puts it in the thread pool
// 
// dns.resolve() - Uses c-ares library:
//   - Pure network operation, truly async
//   - Doesn't use thread pool (see section 2)

dns.lookup('example.com', (err, address) => {
  if (err) {
    log(`✗ DNS.LOOKUP failed: ${err.message}`);
  } else {
    log(`✓ DNS.LOOKUP completed (Thread Pool)`);
    log(`  → Resolved to: ${address}`);
    log(`  → Used getaddrinfo() in a worker thread`);
  }
});

// -----------------------------------------------------------------------------
// 1C. CPU-INTENSIVE CRYPTO
// -----------------------------------------------------------------------------
// Crypto operations are CPU-intensive and would block the event loop.
// PBKDF2 (Password-Based Key Derivation Function) is intentionally slow.
// 
// Here's the flow:
// 1. Node.js sees you want to run pbkdf2
// 2. It creates a uv_work_t request
// 3. Packages your parameters and the C++ function to run
// 4. Calls uv_queue_work() to submit to thread pool
// 5. A worker thread runs the actual computation
// 6. Result is posted back to main thread

crypto.pbkdf2('mysecretpassword', 'salt', 100000, 64, 'sha512', (err, derivedKey) => {
  if (err) throw err;
  log(`✓ CRYPTO.PBKDF2 completed (Thread Pool)`);
  log(`  → Generated ${derivedKey.length}-byte key`);
  log(`  → 100,000 iterations performed in worker thread`);
  log(`  → Main thread stayed responsive during computation`);
});

// Let's also do a simpler crypto operation for comparison
crypto.randomBytes(256, (err, buffer) => {
  if (err) throw err;
  log(`✓ CRYPTO.RANDOMBYTES completed (Thread Pool)`);
  log(`  → Generated ${buffer.length} random bytes`);
});

// =============================================================================
// SECTION 2: OS-NATIVE ASYNC OPERATIONS
// =============================================================================
log('\nInitiating OS-NATIVE ASYNC operations...\n');

// -----------------------------------------------------------------------------
// 2A. TCP NETWORKING
// -----------------------------------------------------------------------------
// Network operations use the OS's native async mechanisms:
// - Linux: epoll
// - macOS/BSD: kqueue  
// - Windows: IOCP (I/O Completion Ports)
// 
// NO THREAD POOL NEEDED! The OS handles the async nature.
// 
// Here's what happens:
// 1. Node.js creates a uv_tcp_t handle
// 2. Calls uv_tcp_connect() to initiate connection
// 3. libuv registers this socket with epoll/kqueue/IOCP
// 4. The OS will notify libuv when the connection is ready
// 5. No threads are blocked waiting!

const client = net.connect({ 
  port: 80, 
  host: 'example.com',
  timeout: 5000 
}, () => {
  log(`✓ NET.CONNECT completed (OS-Native Async)`);
  log(`  → Used ${process.platform === 'linux' ? 'epoll' : 
              process.platform === 'darwin' ? 'kqueue' : 
              process.platform === 'win32' ? 'IOCP' : 'platform async'}`);
  log(`  → No thread pool threads were used`);
  client.end();
});

client.on('error', (err) => {
  log(`✗ NET.CONNECT error: ${err.message}`);
});

client.on('timeout', () => {
  log(`✗ NET.CONNECT timeout after 5 seconds`);
  client.destroy();
});

// -----------------------------------------------------------------------------
// 2B. DNS RESOLVE (c-ares)
// -----------------------------------------------------------------------------
// Unlike dns.lookup(), dns.resolve() uses the c-ares library
// which performs DNS queries using pure network operations.
// This means it's truly async and doesn't need the thread pool!

dns.resolve4('example.com', (err, addresses) => {
  if (err) {
    log(`✗ DNS.RESOLVE4 failed: ${err.message}`);
  } else {
    log(`✓ DNS.RESOLVE4 completed (OS-Native Async)`);
    log(`  → Resolved to: ${addresses.join(', ')}`);
    log(`  → Used c-ares library (network-based, no thread pool)`);
  }
});

// -----------------------------------------------------------------------------
// 2C. TIMERS
// -----------------------------------------------------------------------------
// Timers are special - they don't use the thread pool OR traditional I/O polling.
// They're managed by libuv's internal timer heap, a min-heap data structure.
// 
// When the event loop runs, it:
// 1. Checks the timer heap for expired timers
// 2. Executes callbacks for any expired timers
// 3. No threads or system calls needed (except for getting current time)

setTimeout(() => {
  log(`✓ SETTIMEOUT completed (libuv timer heap)`);
  log(`  → Managed by libuv's internal data structures`);
  log(`  → No thread pool or OS async needed`);
}, 100);

// -----------------------------------------------------------------------------
// 2D. IMMEDIATE
// -----------------------------------------------------------------------------
// setImmediate is even simpler - it's just a queue!
// Callbacks are executed in the "check" phase of the event loop.

setImmediate(() => {
  log(`✓ SETIMMEDIATE completed (check phase queue)`);
  log(`  → Simple queue, processed every event loop iteration`);
});

// =============================================================================
// SECTION 3: MIXED OPERATIONS FOR COMPARISON
// =============================================================================
log('\nStarting mixed operations to show timing differences...\n');

// Let's do multiple file reads to saturate the thread pool
for (let i = 1; i <= 5; i++) {
  fs.readFile(__filename, (err) => {
    if (err) throw err;
    log(`✓ FS.READFILE #${i} completed`);
  });
}

// The 5th file read will have to wait for one of the first 4 to complete
// (assuming default thread pool size of 4)

// Meanwhile, network operations don't compete for threads
for (let i = 1; i <= 5; i++) {
  // Create a simple TCP connection attempt
  const socket = new net.Socket();
  socket.setTimeout(1000);
  
  socket.on('timeout', () => {
    log(`✓ SOCKET #${i} timeout (OS-native, no thread needed)`);
    socket.destroy();
  });
  
  socket.on('error', () => {
    // Ignore errors for this demo
  });
  
  // Try to connect to a non-existent local port (will fail/timeout)
  socket.connect(50000 + i, '127.0.0.1');
}

// =============================================================================
// MONITORING THE COMPLETION
// =============================================================================

// Let's see the final summary after everything completes
setTimeout(() => {
  console.log('\n' + '='.repeat(70));
  console.log('SUMMARY: Thread Pool vs OS-Native Async');
  console.log('='.repeat(70));
  console.log(`
Thread Pool Operations (limited by UV_THREADPOOL_SIZE):
  • File system operations (fs.readFile, fs.writeFile, etc.)
  • DNS lookup() - uses blocking getaddrinfo()
  • CPU-intensive crypto (pbkdf2, randomBytes, etc.)
  • Some user native addons

OS-Native Async Operations (unlimited parallelism):
  • All TCP/UDP networking
  • DNS resolve() functions - uses c-ares
  • Child processes
  • Signals
  • FSWatcher (uses inotify/FSEvents/etc.)

Performance Tips:
  • Increase UV_THREADPOOL_SIZE for I/O-heavy workloads
  • Use dns.resolve() instead of dns.lookup() when possible
  • Be aware that 4 slow file operations can block all file I/O
  • Network operations scale much better than file operations
  `);
  
  // Allow time for any pending operations
  setTimeout(() => process.exit(0), 1000);
}, 3000);