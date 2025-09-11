/**
 * platform-differences.js
 * 
 * "Write once, run anywhere" - but HOW?
 * 
 * This example demonstrates libuv's incredible platform abstraction layer.
 * The same innocent JavaScript code becomes completely different system calls
 * depending on your operating system. This is the magic that lets Node.js
 * work identically across Linux, macOS, Windows, and other platforms.
 * 
 * Run this on different operating systems to see the abstraction in action!
 */

const http = require('http');
const os = require('os');
const { spawn } = require('child_process');

// Let's gather some platform information first
console.log('='.repeat(70));
console.log('PLATFORM ABSTRACTION DEMONSTRATION');
console.log('='.repeat(70));
console.log(`Operating System: ${os.type()} (${os.platform()})`);
console.log(`Architecture: ${os.arch()}`);
console.log(`Node.js Version: ${process.version}`);
console.log(`libuv Version: ${process.versions.uv}`);
console.log('='.repeat(70) + '\n');

// =============================================================================
// THE SIMPLE SERVER - Same JS Code, Different OS Magic
// =============================================================================

const server = http.createServer((req, res) => {
  res.writeHead(200, { 
    'Content-Type': 'text/plain',
    'X-Platform': process.platform 
  });
  res.end(`Hello from ${process.platform}!\n`);
});

// This simple listen() call triggers a cascade of platform-specific magic...
server.listen(8080, '127.0.0.1', () => {
  console.log('🚀 Server started on http://127.0.0.1:8080\n');
  
  // ==========================================================================
  // HERE'S WHAT JUST HAPPENED UNDER THE HOOD
  // ==========================================================================
  
  console.log('PLATFORM-SPECIFIC IMPLEMENTATION:');
  console.log('-'.repeat(50));
  
  switch(process.platform) {
    case 'linux':
      console.log(`
🐧 LINUX (epoll-based implementation):

Your innocent server.listen() became:
  
1. SOCKET CREATION:
   → socket(AF_INET, SOCK_STREAM, 0)
   → Creates a TCP socket file descriptor
   
2. SOCKET CONFIGURATION:
   → setsockopt(SO_REUSEADDR) - Allow address reuse
   → bind() - Bind to 127.0.0.1:8080
   → listen() - Start accepting connections
   
3. ASYNC I/O SETUP (epoll):
   → epoll_create1() - Create an epoll instance
   → epoll_ctl(EPOLL_CTL_ADD) - Register the socket
   → The socket is now monitored by epoll
   
4. EVENT LOOP INTEGRATION:
   → epoll_wait() is called in each loop iteration
   → When a connection arrives, epoll_wait() returns
   → libuv processes the event and calls your callback

LINUX-SPECIFIC FEATURES:
• Edge-triggered epoll for efficiency (EPOLLET)
• SO_REUSEPORT for load balancing across processes
• TCP_NODELAY for latency optimization
• SO_KEEPALIVE with custom intervals
      `);
      break;
      
    case 'darwin':
      console.log(`
🍎 MACOS (kqueue-based implementation):

Your innocent server.listen() became:

1. SOCKET CREATION:
   → socket(AF_INET, SOCK_STREAM, 0)
   → Creates a TCP socket file descriptor
   
2. SOCKET CONFIGURATION:
   → setsockopt(SO_REUSEADDR) - Allow address reuse
   → bind() - Bind to 127.0.0.1:8080
   → listen() - Start accepting connections
   
3. ASYNC I/O SETUP (kqueue):
   → kqueue() - Create a kernel event queue
   → kevent() with EV_ADD - Register the socket
   → The socket is now monitored by kqueue
   
4. EVENT LOOP INTEGRATION:
   → kevent() is called to wait for events
   → When a connection arrives, kevent() returns
   → libuv processes the event and calls your callback

MACOS-SPECIFIC FEATURES:
• Kernel event queue for scalability
• EV_CLEAR for edge-triggered behavior
• NOTE_LOWAT for write buffer management
• Integration with FSEvents for file watching
      `);
      break;
      
    case 'win32':
      console.log(`
🪟 WINDOWS (IOCP-based implementation):

Your innocent server.listen() became:

1. SOCKET CREATION:
   → WSASocket() - Create a Windows socket
   → Uses Winsock 2 API (not POSIX sockets!)
   
2. SOCKET CONFIGURATION:
   → setsockopt(SO_REUSEADDR) - Allow address reuse
   → bind() - Bind to 127.0.0.1:8080
   → listen() - Start accepting connections
   
3. ASYNC I/O SETUP (IOCP):
   → CreateIoCompletionPort() - Create/associate with IOCP
   → AcceptEx() - Post async accept operation
   → The socket is now managed by IOCP
   
4. EVENT LOOP INTEGRATION:
   → GetQueuedCompletionStatus() waits for events
   → When a connection arrives, completion packet is queued
   → libuv processes the packet and calls your callback

WINDOWS-SPECIFIC FEATURES:
• True async I/O (not just notifications like epoll/kqueue)
• Overlapped I/O for all operations
• Thread pool integration for IOCP workers
• TransmitFile() for zero-copy file sending
      `);
      break;
      
    default:
      console.log(`
📦 OTHER PLATFORM (${process.platform}):

libuv supports many platforms:
• FreeBSD, OpenBSD, NetBSD (kqueue-based)
• Solaris, AIX (event ports / pollset)
• Android (epoll-based like Linux)

Each has its own optimal async I/O mechanism,
all hidden behind libuv's unified API!
      `);
  }
  
  console.log('-'.repeat(50) + '\n');
  
  // ==========================================================================
  // DEMONSTRATION: Platform-specific Process Monitoring
  // ==========================================================================
  
  console.log('WATCHING THE MAGIC IN ACTION:');
  console.log('-'.repeat(50));
  
  // Let's try to show the actual system calls being made
  // This is platform-specific too!
  
  if (process.platform === 'linux') {
    console.log(`
To see epoll in action, run in another terminal:
  $ strace -e epoll_wait,epoll_ctl,accept4 -p ${process.pid}
  
Or see the epoll file descriptor:
  $ ls -la /proc/${process.pid}/fd/ | grep eventpoll
    `);
  } else if (process.platform === 'darwin') {
    console.log(`
To see kqueue in action, run in another terminal:
  $ sudo dtruss -p ${process.pid} | grep -E 'kevent|accept'
  
Or use Instruments.app to trace system calls.
    `);
  } else if (process.platform === 'win32') {
    console.log(`
To see IOCP in action, use:
  • Process Monitor (ProcMon) from SysInternals
  • Windows Performance Toolkit (WPA)
  • Or enable ETW tracing for detailed analysis
    `);
  }
  
  // ==========================================================================
  // CROSS-PLATFORM FILE WATCHING EXAMPLE
  // ==========================================================================
  
  console.log('\nBONUS: File Watching Platform Differences:');
  console.log('-'.repeat(50));
  
  const fs = require('fs');
  const filename = __filename;
  
  // This simple watch() call uses completely different mechanisms!
  const watcher = fs.watch(filename, (eventType, filename) => {
    console.log(`File changed: ${eventType} on ${filename}`);
  });
  
  const watchMechanisms = {
    'linux': 'inotify (efficient kernel notification)',
    'darwin': 'FSEvents (macOS file system events) or kqueue',
    'win32': 'ReadDirectoryChangesW (Windows API)',
    'freebsd': 'kqueue with NOTE_WRITE',
    'sunos': 'event ports'
  };
  
  console.log(`fs.watch() is using: ${watchMechanisms[process.platform] || 'platform-specific mechanism'}`);
  console.log('(File watching will stop when server closes)\n');
  
  // Clean up the watcher when we're done
  server.on('close', () => watcher.close());
});

// =============================================================================
// TESTING THE ABSTRACTION
// =============================================================================

console.log('TEST THE SERVER:');
console.log('-'.repeat(50));
console.log('1. Use curl or browser: http://127.0.0.1:8080');
console.log('2. Watch how the same JS code works on any OS');
console.log('3. Server will auto-close in 30 seconds\n');

// Make a test request after a short delay
setTimeout(() => {
  console.log('Making test request to demonstrate platform abstraction...');
  
  http.get('http://127.0.0.1:8080', (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      console.log('✓ Test request successful!');
      console.log(`  Response: ${data.trim()}`);
      console.log(`  Platform header: ${res.headers['x-platform']}\n`);
    });
  }).on('error', (err) => {
    console.error('Test request failed:', err.message);
  });
}, 1000);

// Auto-cleanup
setTimeout(() => {
  console.log('\n' + '='.repeat(70));
  console.log('ABSTRACTION LAYER SUMMARY');
  console.log('='.repeat(70));
  console.log(`
The Beauty of libuv's Abstraction:

Your JavaScript:  server.listen(8080)

Becomes on Linux:  epoll_create() → epoll_ctl() → epoll_wait()
Becomes on macOS:  kqueue() → kevent(EV_ADD) → kevent()
Becomes on Windows: CreateIoCompletionPort() → AcceptEx() → GetQueuedCompletionStatus()

You write once, libuv handles the rest!

Key Abstractions:
• uv_tcp_t      → TCP sockets (different on each OS)
• uv_loop_t     → Event loop (epoll/kqueue/IOCP)
• uv_fs_t       → File operations (POSIX vs Windows)
• uv_process_t  → Child processes (fork vs CreateProcess)
• uv_signal_t   → Signals (UNIX signals vs Windows events)
  `);
  
  console.log('Shutting down server...');
  server.close(() => {
    console.log('✓ Server closed cleanly');
    process.exit(0);
  });
}, 30000);