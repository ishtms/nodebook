// Create an ArrayBuffer with some initial data
const arrayBuffer = new ArrayBuffer(16);
const uint8View = new Uint8Array(arrayBuffer);
uint8View.set([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"

// Buffer.from(arrayBuffer) creates a Buffer that SHARES the same memory
const bufferView = Buffer.from(arrayBuffer);
console.log(bufferView.toString("utf8", 0, 5)); // "Hello"

// Now, if ANYTHING modifies the underlying ArrayBuffer memory...
// (like another TypedArray view, WebAssembly, or an async operation)
const uint32View = new Uint32Array(arrayBuffer);
uint32View[0] = 0x21212121; // Overwrites first 4 bytes

// The Buffer is automatically affected because it's just a view!
console.log(bufferView.toString("utf8", 0, 5)); // "!!!!" (corrupted)
console.log(bufferView[0]); // 0x21, not 0x48 anymore

// Real-world scenario - File upload with concurrent processing
async function dangerousFileProcessing(arrayBuffer) {
  // Multiple parts of your app receive the same ArrayBuffer

  // You create a Buffer to check file headers
  const headerBuffer = Buffer.from(arrayBuffer);
  const fileType = detectFileType(headerBuffer.slice(0, 4));

  // Meanwhile, another async function sanitizes the file
  setTimeout(() => {
    const dataView = new DataView(arrayBuffer);
    // Sanitizer overwrites suspicious byte patterns
    if (dataView.getUint32(0) === 0x89504e47) {
      // PNG magic number
      dataView.setUint32(0, 0x00000000); // "Sanitize" it
    }
  }, 0);

  // Later, you try to process based on detected file type
  await someAsyncOperation();

  // headerBuffer is now corrupted! It no longer contains the original data
  if (fileType === "PNG") {
    processPNG(headerBuffer); // FAILS - data has been modified
  }
}

// THE SAFE APPROACH - Create an independent copy
function safeFileProcessing(arrayBuffer) {
  // Create a truly independent buffer with its own memory
  const bufferCopy = Buffer.alloc(arrayBuffer.byteLength);
  const tempView = Buffer.from(arrayBuffer);
  tempView.copy(bufferCopy);

  // Or more concisely -
  // const bufferCopy = Buffer.from(Buffer.from(arrayBuffer));

  // Now bufferCopy is completely independent
  // Modifications to arrayBuffer won't affect bufferCopy
  const uint8View = new Uint8Array(arrayBuffer);
  uint8View[0] = 0xff; // Modify original

  console.log(bufferCopy[0]); // Still the original value, not 0xFF

  return bufferCopy; // Safe to use anywhere
}

const ab = new ArrayBuffer(8);
const buf = Buffer.from(ab);
const arr = new Uint8Array(ab);

arr[0] = 42;
console.log(buf[0]); // 42 - proves memory is shared

buf[1] = 100;
console.log(arr[1]); // 100 - bidirectional sharing
