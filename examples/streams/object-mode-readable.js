/**
 * Object Mode Streams Example
 *
 * By default, streams work with Buffers/strings.
 * Object mode lets streams work with any JavaScript object.
 *
 * Perfect for data processing pipelines:
 * - Pull records from DB as objects
 * - Transform/filter objects
 * - Save results
 *
 * Enable with: { objectMode: true } in constructor
 *
 * Key difference: highWaterMark is measured in number of objects, not bytes.
 * Default: 16 objects (vs 16KB for regular streams)
 */

import { Readable, Transform, Writable } from "node:stream";

// Readable stream that emits user objects
class UserStream extends Readable {
  constructor(options) {
    super({ objectMode: true, ...options });
    this.users = [
      { id: 1, name: "Alice", role: "admin" },
      { id: 2, name: "Bob", role: "user" },
      { id: 3, name: "Charlie", role: "user" },
      { id: 4, name: "Diana", role: "admin" },
    ];
    this.index = 0;
  }

  _read(size) {
    if (this.index >= this.users.length) {
      this.push(null); // Done
      return;
    }

    const userObject = this.users[this.index];
    console.log(`[UserStream] Pushing user:`, userObject);
    this.push(userObject); // Push object, not string
    this.index++;
  }
}

// Transform to filter admin users only
class AdminFilterTransform extends Transform {
  constructor(options) {
    super({ objectMode: true, ...options });
  }

  _transform(user, encoding, callback) {
    // 'user' is an object, not a Buffer
    if (user.role === "admin") {
      console.log(`[AdminFilter] Admin found, passing through:`, user.name);
      this.push(user);
    } else {
      console.log(`[AdminFilter] Filtering out:`, user.name);
      // Don't push = filter out
    }
    callback();
  }
}

// Writable to "save" users
class UserProcessor extends Writable {
  constructor(options) {
    super({ objectMode: true, ...options });
  }

  _write(user, encoding, callback) {
    console.log(`[UserProcessor] Saving to DB:`, user);
    // Simulate async DB save
    setTimeout(callback, 200);
  }
}

// Build pipeline
const userSource = new UserStream();
const adminFilter = new AdminFilterTransform();
const dbSaver = new UserProcessor();

console.log("--- User Processing Pipeline ---");
userSource.pipe(adminFilter).pipe(dbSaver);

dbSaver.on("finish", () => {
  console.log("--- Pipeline Complete ---");
});
