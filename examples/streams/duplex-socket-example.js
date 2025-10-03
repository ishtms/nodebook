/**
 * Duplex Stream - TCP Socket Example
 *
 * A duplex stream is both readable AND writable.
 * The two sides operate independently - what you write isn't what you read.
 *
 * Classic example: TCP socket
 * - Write to socket = send data to other computer
 * - Read from socket = receive data from other computer
 * - Same object, two independent channels
 *
 * To test:
 * 1. Run this file: node duplex-socket-example.js
 * 2. In another terminal: telnet localhost 8000
 * 3. Type anything in telnet - it'll be logged here
 */

import net from "node:net";

// Create a TCP server
const server = net.createServer((socket) => {
  console.log("✓ Client connected.");

  // Socket is a Duplex stream
  // READABLE side: receive data from client
  socket.on("data", (chunk) => {
    console.log(`Server received: "${chunk.toString()}"`);
  });

  // WRITABLE side: send data to client
  socket.write("Hello from the server!\n");
  socket.write("Type something and press enter...\n");

  // Handle client disconnection
  socket.on("end", () => {
    console.log("✗ Client disconnected.");
  });

  socket.on("error", (err) => {
    console.log(`Socket error: ${err.message}`);
  });
});

server.listen(8000, () => {
  console.log("Server listening on port 8000");
  console.log("Connect with: telnet localhost 8000");
});
