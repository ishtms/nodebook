/**
 * handle-lifecycle.js
 * 
 * This example demonstrates the complete lifecycle of a libuv handle,
 * using a TCP server as our guinea pig. In libuv terminology, a "handle"
 * is a long-lived object that can be repeatedly used for I/O operations.
 * 
 * Think of handles like employees at a company:
 * - They're hired (initialized)
 * - They do work repeatedly (handle events)
 * - Eventually they retire (get closed)
 * 
 * Run this example and watch the console output to see each lifecycle stage.
 */

const net = require('net');

// =============================================================================
// PHASE 1: INITIALIZATION
// =============================================================================
// When createServer() is called, Node.js asks libuv to create a new TCP handle.
// Behind the scenes, libuv:
// 1. Allocates memory for a uv_tcp_t structure
// 2. Initializes it with uv_tcp_init()
// 3. Adds it to the loop's handle queue
//
// At this point, the handle exists but isn't doing anything yet.
// It's like having a security guard who's been hired but hasn't started their shift.

console.log('[Main] Creating server handle...');
const server = net.createServer((socket) => {
  // Each incoming connection gets its own handle!
  // This is a uv_tcp_t handle too, but it represents the client connection.
  // The lifecycle for each client handle is independent of the server handle.
  console.log('[Connection] New client connected - new socket handle created');
  
  // Let's be a polite server
  socket.write('Welcome! Your connection is handled by its own libuv handle.\r\n');
  socket.write('Type something and hit enter to see it echoed back.\r\n');
  
  // Echo server functionality - demonstrates the handle doing repeated work
  socket.on('data', (data) => {
    console.log(`[Connection] Handle processing data: ${data.toString().trim()}`);
    socket.write(`Echo: ${data}`);
  });
  
  socket.on('end', () => {
    console.log('[Connection] Client disconnected - socket handle will be closed');
    // When the client disconnects, Node.js will call uv_close() on this handle.
    // The handle doesn't disappear immediately! It goes through a cleanup process:
    // 1. Stop watching for events
    // 2. Cancel any pending operations
    // 3. Wait for the "close callbacks" phase to actually free memory
  });
  
  socket.on('error', (err) => {
    console.error('[Connection] Socket error:', err.message);
  });
});

// Error handling for the server handle itself
server.on('error', (err) => {
  console.error('[Server] Fatal server error:', err);
  throw err;
});

// =============================================================================
// PHASE 2: ACTIVATION (Starting Operations)
// =============================================================================
// The listen() call is where the magic happens. This tells libuv to:
// 1. Bind the handle to port 8080 (uv_tcp_bind)
// 2. Start listening for connections (uv_listen)
// 3. Register with the OS's event notification system (epoll/kqueue/IOCP)
// 
// From this point on, the handle is "active" - it's watching for events and
// will keep the event loop running. The server handle will now repeatedly
// accept new connections until we explicitly close it.

server.listen(8080, '127.0.0.1', () => {
  console.log('[Server] Handle activated - listening on 127.0.0.1:8080');
  console.log('[Server] The handle is now registered with the OS event system');
  console.log('[Server] Try connecting with: telnet 127.0.0.1 8080');
  console.log('[Server] Server will auto-close in 10 seconds...\n');
});

// Let's also track how many handles are keeping our process alive
setInterval(() => {
  // process._getActiveHandles() shows all active handles
  // This is unofficial API but useful for learning
  const handles = process._getActiveHandles ? process._getActiveHandles() : [];
  console.log(`[Monitor] Active handles in process: ${handles.length}`);
}, 3000);

// =============================================================================
// PHASE 3: CLOSING (Cleanup)
// =============================================================================
// Handles don't close immediately when you call close(). Here's what happens:
// 1. uv_close() is called, marking the handle for closure
// 2. The handle stops accepting new connections immediately
// 3. Existing connections continue until they close
// 4. In the "close callbacks" phase, the handle is finally freed
//
// This is why the close() method accepts a callback - it runs after cleanup.

setTimeout(() => {
  console.log('\n[Server] Initiating server shutdown...');
  console.log('[Server] Calling server.close() - this calls uv_close() internally');
  
  server.close(() => {
    // This callback runs in the "close callbacks" phase of the event loop
    // By the time we get here:
    // - The server has stopped accepting new connections
    // - All existing connections have been closed
    // - The handle's memory has been freed
    // - The handle has been removed from the loop's handle queue
    console.log('[Server] Handle fully closed and memory freed');
    console.log('[Server] This callback ran in the "close callbacks" event loop phase');
    
    // Clear our monitoring interval
    clearInterval();
  });
  
  // Note: After calling close(), the server immediately stops accepting
  // new connections, but existing connections continue to work
  console.log('[Server] No new connections will be accepted from this point');
  
}, 10000);

// =============================================================================
// EDUCATIONAL NOTES
// =============================================================================
// 
// Key Concepts Demonstrated:
// 
// 1. HANDLE vs REQUEST:
//    - Our TCP server is a HANDLE (long-lived, can be used many times)
//    - Each write() operation creates a REQUEST (short-lived, one-time use)
// 
// 2. HANDLE REFERENCES:
//    - Active handles keep the event loop (and your process) running
//    - That's why Node.js doesn't exit while the server is listening
//    - Calling close() removes this reference, allowing the process to exit
// 
// 3. THE CLOSE CALLBACKS PHASE:
//    - Handles aren't freed immediately when closed
//    - They wait for a specific phase in the event loop
//    - This ensures safe cleanup without race conditions
// 
// Try This:
// - Connect multiple clients and see multiple handles being created
// - Kill the process without calling close() and see handles leak (in theory)
// - Comment out the server.close() call and watch the process run forever