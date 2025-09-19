console.log("--- Demonstrating Uninitialized Memory Leak ---");

function handleSensitiveRequest() {
  const userSession = {
    userId: "usr_abc123",
    apiKey: "sk_live_verySecretApiKeyHere",
    expires: Date.now() + 3600000,
  };
  const secretBuffer = Buffer.from(JSON.stringify(userSession));
  // In a real app, this buffer would be used, then go out of scope.
  // We'll just log its length to "use" it.
  console.log(`Secret buffer of length ${secretBuffer.length} was created and used.`);
}

// Another function, perhaps handling a different request,
// makes the mistake of using allocUnsafe.
function handleUnsafeOperation() {
  // A developer thought they were optimizing.
  // The size is chosen to be similar to the secret buffer's size.
  const unsafeBuffer = Buffer.allocUnsafe(150);

  console.log("\n--- Contents of unsafeBuffer ---");
  console.log("As Hex:");
  console.log(unsafeBuffer.toString("hex"));
  console.log("\nAs UTF-8 (might contain garbage or secrets):");
  // We only print the part of the string that is valid UTF-8
  // to avoid terminal clutter from invalid byte sequences.
  console.log(unsafeBuffer.toString("utf8").replace(/\u0000/g, " "));
  console.log("------------------------------");
}

// Run the scenario
handleSensitiveRequest();

// We call the unsafe operation immediately after. In a real server,
// this could happen across different requests that are handled milliseconds apart,
// making the memory from the first request available in the pool for the second.
handleUnsafeOperation();

console.log("\nLook closely at the output. You will likely see fragments of the apiKey or userId.");
