---
title: "Watching Files, Directories, and Atomic Writes"
date: "2026-02-22"
excerpt: "File watching with fs.watch, atomic write patterns, temp files, and safe file replacement strategies."
category: "File System"
tags: ["nodejs", "file-system", "fs-watch", "atomic-writes", "inotify"]
author: "Ishtmeet Singh @ishtms"
chapter: "file-system"
subchapter: "watching-atomic-writes"
published: true
toc: true
---

`fs.watch('./config.json', callback)` looks like one line of code. Under the surface, it triggers a chain of syscalls specific to whichever operating system you're running - inotify on Linux, FSEvents on macOS, ReadDirectoryChangesW on Windows. Each of these mechanisms works differently, reports events differently, and fails in different ways. And the Node documentation admits this right at the top: "The fs.watch API is not 100% consistent across platforms, and is unavailable in some situations."

That same inconsistency drives the second half of this subchapter. When editors save files, they often write to a temp file and rename it into place. Watchers see rename events, not writes. The atomic write pattern and file watching are deeply intertwined - you can't fully understand one without the other.

> [!NOTE]
> **What is an Atomic Write?**
> In computing, an "atomic" operation is one that either completes entirely or fails completely-there is no in-between state. For file systems, an atomic write ensures that any process reading the file will either see the fully intact old content or the complete new content. It will never read a partially written or corrupted file, even if the system crashes mid-operation. Since operating systems don't have a single command to "replace file contents atomically," this is typically achieved by writing the new data to a temporary file first, and then using a single `rename()` operation to swap it into place.

## fs.watch() and the OS Event Layer

The API is simple enough:

```js
const watcher = fs.watch('./config.json', (event, filename) => {
  console.log(`${event}: ${filename}`);
});
```

`event` is either `'change'` or `'rename'`. `filename` is the file that triggered the event. Sometimes `filename` is `null`, depending on the platform. The returned `FSWatcher` is an EventEmitter, so you can also listen for `'error'` events on it.

Two event types for every possible filesystem operation. That's the entire vocabulary Node gives you. A content modification fires `'change'`. A deletion, rename, or creation fires `'rename'`. And on some platforms, a modification fires both. There's no way to tell from the event alone whether the file was deleted versus renamed - it's all `'rename'`.

### How Events Map to OS Mechanisms

On Linux, `fs.watch()` uses inotify. When you watch a file, libuv calls `inotify_init1()` to get an inotify file descriptor, then `inotify_add_watch()` for each path. The kernel subscribes to events like `IN_MODIFY`, `IN_ATTRIB`, `IN_DELETE_SELF`, `IN_MOVE_SELF`, and several others. Node collapses these into `'change'` or `'rename'` based on the inotify event mask. Modify events and metadata attribute changes (`IN_ATTRIB`) map to `'change'`. Everything else maps to `'rename'`.

On macOS, FSEvents handles the watching. FSEvents operates at the directory level - it tells you "something changed in this directory or its subtree" rather than giving per-file granularity. It also coalesces rapid events. Ten modifications to the same file in quick succession might produce one or two FSEvents notifications. macOS optimizes for low overhead across massive directory trees, not per-event precision.

On Windows, ReadDirectoryChangesW watches directories and reports specific actions: `FILE_ACTION_MODIFIED`, `FILE_ACTION_ADDED`, `FILE_ACTION_REMOVED`, `FILE_ACTION_RENAMED_OLD_NAME`, `FILE_ACTION_RENAMED_NEW_NAME`. The API is buffer-based and asynchronous - if events arrive faster than you drain them, the buffer overflows and you miss events entirely. No error. Just silence. The events are gone.

Here's a concrete example of the inconsistency. You write to a file, append to it, then rename it:

```js
fs.writeFileSync('./test.txt', 'hello');
fs.appendFileSync('./test.txt', ' world');
fs.renameSync('./test.txt', './test-renamed.txt');
```

Linux (inotify) typically produces three events: `change`, `change`, `rename`. Two separate modifications, then a rename. macOS might coalesce the two writes into a single `change` event, or skip reporting the modification entirely if the rename follows closely enough. Windows reports the modifications individually but gives you the *new* filename on the rename event, while Linux gives you the old one.

The takeaway is blunt: you cannot write code that depends on exact event counts or ordering across platforms.

### Watching Directories vs. Files

Watching a directory gives you events for anything that happens inside it - files created, modified, deleted, renamed. The `filename` parameter tells you which file changed (usually). Watching a single file gives you events only for that specific inode.

But there's a gotcha with file-level watching. If you watch `config.json` and something deletes it, the inotify watch on that inode becomes invalid on Linux. A new file created at the same path has a different inode. Your watcher is now watching nothing - the old inode is gone, and the new one was never registered.

This matters more than you'd think. Text editors routinely delete and recreate files during save operations. Some tools, for example, write your changes to `config.json.tmp`, rename `config.json` to `config.json~` (backup), then rename `config.json.tmp` to `config.json`. From the watcher's perspective, the original file was renamed away. On Linux, the watch attached to the original inode might now be pointing at `config.json~`, not the new `config.json`.

Most production code watches the parent directory instead. If the file gets deleted and recreated - which is exactly what happens during atomic writes and editor safe-saves - the directory watcher catches the rename event because the directory itself still exists. File-level watchers often miss the replacement.

### The `recursive` Option

```js
fs.watch('./src', { recursive: true }, (event, filename) => {
  console.log(`Changed: ${filename}`);
});
```

On macOS, this uses FSEvents' native recursive support. One watch covers the entire tree. Cheap and efficient - FSEvents was designed for exactly this.

On Windows, ReadDirectoryChangesW supports a recursive flag natively. Similar efficiency.

On Linux, `recursive: true` was historically ignored - silently, with no warning. Recent Node versions (v20.12.0+, backported to v18.20.0+) added support by internally walking the directory tree and setting up individual inotify watches on every subdirectory. That's considerably more expensive than macOS or Windows native recursive watching. Each subdirectory consumes one of your inotify watch slots, and Node needs to detect newly created subdirectories and add watches for those too.

The inotify watch limit matters here. Linux defaults to 8192 watches per user on many distributions (some set it to 65536). Check with `cat /proc/sys/fs/inotify/max_user_watches`. A project with 10,000 directories exhausts the lower limit immediately. You'll get `ENOSPC` errors, which confusingly have nothing to do with disk space - it's the inotify watch table that's full. Increase it with:

```bash
echo 524288 | sudo tee /proc/sys/fs/inotify/max_user_watches
```

This is one of the first things that breaks when people deploy Node.js file-watching tools (dev servers, build watchers) to Linux servers. Works on their Mac. Fails on the server with a cryptic "no space" error.

### The `persistent` Option and Keeping the Process Alive

By default, an active watcher keeps the Node process alive. The event loop sees a live handle and won't exit. Set `persistent: false` if you want the watcher to be passive - it fires while the process is alive for other reasons, but won't keep it running on its own.

```js
fs.watch('./file.txt', { persistent: false }, (event) => {
  console.log('Changed');
});
```

Common source of confusion in scripts that should exit after watching for one change: the process hangs forever because the watcher holds the event loop open. If your script watches a file, processes one change, and should terminate, either close the watcher in the callback or use `persistent: false`.

### Watcher Errors

The `FSWatcher` emits `'error'` events. Always listen for them:

```js
watcher.on('error', (err) => {
  console.error('Watch failed:', err.message);
});
```

Common error scenarios: watching a path that doesn't exist (`ENOENT`), hitting the inotify limit on Linux (`ENOSPC`), losing access to the watched file (permissions changed), or the watched directory being deleted. Without an error listener, these errors crash your process with an unhandled exception.

### Closing Watchers

```js
watcher.close();
```

Releases the OS-level watch handle. On Linux, that's the inotify watch descriptor. On macOS, the FSEvents stream. Same cleanup principle as closing file descriptors - the OS has finite resources, and leaking watchers in a long-running process eventually hits limits.

If watchers are created dynamically - say, one per user session or one per uploaded file - track them in a Map and close them when the associated resource is cleaned up. Leaking 10 watchers a minute adds up to 14,000 leaked watchers per day. You'll hit the inotify limit within hours.

## fs.watchFile() and Stat Polling

`fs.watchFile()` ignores OS event mechanisms entirely. It polls the file's metadata with `fs.stat()` at a fixed interval and fires a callback when anything changes.

```js
fs.watchFile('./config.json', { interval: 2000 }, (curr, prev) => {
  console.log(`mtime: ${prev.mtime} -> ${curr.mtime}`);
  console.log(`size: ${prev.size} -> ${curr.size}`);
});
```

The callback gets two Stats objects: current and previous. You can see exactly what changed - mtime, ctime, size, permission bits, link count, anything the Stats object exposes. The comparison happens internally: Node caches the previous Stats and compares all fields on every poll. If any field differs, the callback fires.

### How Polling Works Internally

Node maintains an internal map of all files being watched with `fs.watchFile()`. There's a timer running at the specified interval. On each tick, Node issues an `fs.stat()` call for every watched file. Each stat call goes through the libuv thread pool - it's a real syscall hitting the filesystem. The results come back asynchronously, are compared to the cached stats, and if anything changed, the callback is invoked with both old and new stats.

The cost scales linearly. Watching 100 files at a 1-second interval means 100 stat calls per second, each consuming a thread pool slot. The default thread pool has 4 slots. If you're also doing DNS lookups, file reads, or crypto operations that use the thread pool, the stat calls compete for slots, adding latency to everything.

### Why the Default Interval Is 5007ms

Not 5000. The odd number avoids resonance with other timers in the system. If ten different subsystems all poll at exactly 5000ms, they all hit the disk at the same instant, creating load spikes. Staggering by 7ms spreads the I/O across time. A small detail, but it shows up in the Node source code comments.

You can set any interval you want:

```js
fs.watchFile('./config.json', { interval: 1000 }, (curr, prev) => {
  if (curr.mtimeMs !== prev.mtimeMs) {
    console.log('Content changed');
  }
});
```

Shorter intervals give faster detection at higher cost. For config files that change once a deploy, 10 or 30 seconds is fine. For a dev server, 1 second might be acceptable. But if you need sub-second detection, polling is the wrong tool - use `fs.watch()`.

### When Polling Beats Events

Polling works on network filesystems. NFS, CIFS, SMB - these don't propagate inotify events because the writes happen on a remote server. The local kernel never sees the modification, so inotify never fires. `fs.watch()` is useless here. `fs.watchFile()` calls stat, which queries the remote filesystem's metadata directly. Slow, but functional.

Polling also works in situations where `fs.watch()` breaks: after file deletion and recreation on Linux, on platforms with unreliable event delivery, in containers where the filesystem overlay driver doesn't support inotify, or on filesystems that simply don't implement the notification API. Docker volumes with certain storage drivers are a common example - `fs.watch()` produces no events, but polling catches changes just fine.

### Stopping a Stat Watcher

```js
fs.unwatchFile('./config.json');
```

`fs.watchFile()` returns nothing, so there's no object to call `.close()` on. You pass the same filename to `fs.unwatchFile()`. If you registered multiple listeners for the same file, passing just the filename removes all of them. Pass a specific listener function as the second argument to remove only that one.

### mtime Precision Limits

`fs.watchFile()` depends on mtime changes to detect modifications. Modern filesystems (ext4, APFS, NTFS, ZFS) store mtime with nanosecond or 100-nanosecond precision guarantees. However, older filesystems (like FAT32) or certain network mounts might only store mtime with 1-second or 1-millisecond precision. On those older filesystems, if a file is modified twice within the same tick of the mtime clock, the second modification doesn't update mtime, and the poller misses it. Rare in practice today, but possible with rapid automated writes on legacy mounts.

Also worth noting: mtime updates when the file is closed after writing, not during the write. If a process opens a file, writes 10MB, and keeps the handle open for minutes, mtime doesn't change until the fd is closed. The poller won't see the modification during that window.

## Choosing Between fs.watch() and fs.watchFile()

`fs.watch()` is fast - events fire within milliseconds on Linux, sometimes with more latency on macOS. Efficient - no polling, just kernel event delivery. But inconsistent across platforms. It can miss events, fire duplicate events, or break entirely after file deletions. The event vocabulary is too coarse (just `'change'` and `'rename'`) to distinguish between many distinct filesystem operations.

`fs.watchFile()` is slow - detection lag equals your polling interval, minimum ~1 second in practice. Expensive - stat calls on every tick, consuming thread pool slots. But it works the same way everywhere. Every platform, every filesystem, every edge case. If the file's metadata changes between polls, you'll see it. Guaranteed.

In production, most code uses neither directly.

### Why chokidar Exists

chokidar is a file-watching library that wraps both APIs, normalizing behavior across platforms. It handles the things you'd otherwise have to build yourself:

**Recursive watching on Linux.** chokidar walks the directory tree, sets up inotify watches for each subdirectory, and dynamically adds/removes watches as directories are created or deleted. It tracks the inotify count and warns when you're approaching the limit.

**Event normalization.** Instead of `'change'` and `'rename'`, chokidar emits `'add'`, `'change'`, `'unlink'`, `'addDir'`, `'unlinkDir'`. Semantic events that map to what actually happened to the filesystem.

**Editor safe-write detection.** When an editor writes to a temp file and renames it over the target, chokidar consolidates the delete-then-create sequence into a single `'change'` event instead of flooding you with `'unlink'` and `'add'`.

**Automatic polling fallback.** If `fs.watch()` fails on a given path - network filesystem, broken overlay driver, platform limitation - chokidar falls back to stat polling automatically. You don't have to detect or handle the failure yourself.

**Initial scan.** When you start watching a directory, chokidar can emit `'add'` events for all existing files, so your code can initialize state based on what's already there.

```js
const chokidar = require('chokidar');
const watcher = chokidar.watch('./src', {
  ignored: /node_modules/,
  persistent: true,
});
watcher.on('change', path => console.log(`Changed: ${path}`));
watcher.on('add', path => console.log(`Added: ${path}`));
```

Build tools (webpack, Vite, Parcel), test runners (Jest in watch mode), and framework dev servers all use chokidar or something equivalent internally. For watching a single known file on a known platform, raw `fs.watch()` is fine. For anything cross-platform or recursive, reach for a library.

## File Watching in Practice

Before getting into debouncing, here are patterns you'll actually use in production.

### Config File Hot Reload

You load config on startup. You want changes to take effect without restarting the server.

```js
let config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

const reloadConfig = debounce(() => {
  try {
    const raw = fs.readFileSync('./config.json', 'utf8');
    config = JSON.parse(raw);
    console.log('Config reloaded');
  } catch (err) {
    console.error('Bad config, keeping old:', err.message);
  }
}, 500);

fs.watch('./config.json', reloadConfig);
```

The `try/catch` is load-bearing. If the new config is invalid JSON, you keep the old config instead of crashing. The debounce handles editors that save in multiple steps. And you're reading the file synchronously inside the callback because the callback already runs asynchronously (triggered by the watcher), so the synchronous read blocks a negligible amount of time while guaranteeing you read a consistent snapshot.

### Watching a Directory for New Files

Processing uploaded files, incoming data drops, or queued work items:

```js
const processed = new Set();

fs.watch('./uploads', (event, filename) => {
  if (!filename || processed.has(filename)) return;
  const fullPath = path.join('./uploads', filename);

  fs.access(fullPath, fs.constants.F_OK, (err) => {
    if (err) return;
    processed.add(filename);
    processFile(fullPath);
  });
});
```

A `'rename'` event fires for both creation and deletion. The `fs.access()` check distinguishes them - if the file exists, it was created or renamed in. The `processed` Set prevents reprocessing when duplicate events fire for the same file.

### Log Rotation Detection

Your app writes to `app.log`. An external tool renames it to `app.log.1` and expects your app to start writing to a fresh `app.log`.

```js
let logStream = fs.createWriteStream('./app.log', { flags: 'a' });
let watcher;

function watchLog() {
  watcher = fs.watch('./app.log', (event) => {
    if (event === 'rename') {
      watcher.close();
      logStream.end(() => {
        logStream = fs.createWriteStream('./app.log', { flags: 'a' });
        watchLog();
      });
    }
  });
}
watchLog();
```

When log rotation renames the file, the `'rename'` event fires. You close the old stream (which is now writing to `app.log.1` via its open fd) and open a new stream to the newly created `app.log`. You also must restart the watcher itself - because on Linux, `fs.watch` tracks the inode, which was just renamed to `app.log.1`. Without this, your application keeps writing to the rotated file through its existing file descriptor, and the new `app.log` stays empty and unwatched.

### Watching Network Filesystems

`fs.watch()` relies on the local kernel's event infrastructure. When files live on NFS, SMB, or CIFS mounts, the writes happen on a remote machine. The local kernel has no visibility into those writes and produces no inotify/FSEvents/ReadDirectoryChangesW events.

For network-mounted files, your options are stat polling via `fs.watchFile()`, or better yet, a different notification mechanism entirely - HTTP webhooks, message queues, or a database trigger that signals when the remote data changes.

### Watcher Resource Leaks

Every watcher holds OS resources. On Linux, each `fs.watch()` call consumes an inotify watch descriptor. On macOS, an FSEvents stream. On all platforms, the watcher keeps at least one file descriptor or handle open.

If your application creates watchers dynamically - one per user session, one per uploaded file, one per API request - and never closes them, resources accumulate. A leak of 10 watchers per minute becomes 14,400 per day. On Linux, you'll hit the inotify limit or the fd limit. The symptoms are confusing: new watchers start failing with `ENOSPC` or `EMFILE`, or the process starts running out of memory from the accumulated JavaScript watcher objects and their callbacks.

The fix: always pair watcher creation with cleanup. Use a Map to track watchers by key (user ID, file path, session), and explicitly close them when the associated resource is released.

```js
const watchers = new Map();

function startWatching(key, filePath) {
  if (watchers.has(key)) return;
  const w = fs.watch(filePath, () => handleChange(key));
  watchers.set(key, w);
}

function stopWatching(key) {
  const w = watchers.get(key);
  if (w) { w.close(); watchers.delete(key); }
}
```

In tests, close all watchers in `afterEach` hooks. Leaked watchers keep the event loop alive and cause test processes to hang indefinitely - one of those issues that wastes an hour of debugging time when you don't know to look for it.

### Assuming Events Are Immediate

Even `fs.watch()` - the event-based approach - has latency. On Linux, inotify events arrive within a few milliseconds, usually. On macOS, FSEvents might batch events and deliver them after a delay, sometimes 100ms or more, sometimes a full second if the system is under load. On Windows, ReadDirectoryChangesW has similar variability.

If you have hard real-time requirements (detect a change within 10ms), file watching alone might not be reliable enough. You'd need a more direct signaling mechanism - the writer explicitly notifying the reader via IPC, a Unix domain socket, or a shared memory flag.

## Debouncing File Watch Events

A single logical change - you hit save in your editor - can produce two, three, or more events. The editor might write to a temp file, delete the original, rename the temp file. Or the OS fires separate events for the write operation and the subsequent metadata update when the file is closed. Multiple events for one save.

If your event handler rebuilds a project, reloads a config, or uploads a file, running it three times is wasteful and potentially harmful (imagine reloading a config three times in 50ms). Debouncing delays the action until events stop arriving for a specified duration.

The implementation is small:

```js
function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}
```

Each event resets the timer. Only after `delay` milliseconds of silence does the function actually run. Wrap your watcher callback:

```js
const onChange = debounce((event, filename) => {
  console.log('File settled, reloading...');
}, 300);
fs.watch('./config.json', onChange);
```

The delay depends on context. 100-300ms works for development tools - short enough that devs don't notice, long enough to catch multi-event bursts from editor saves. Config reloading in production might use 500ms or 1 second. You want to be sure the deploy script is completely done writing before you reload. Log directory scanning might skip debouncing entirely because you want to process new files the moment they appear.

### Stat-Based Deduplication

A complementary approach: ignore events where the file hasn't actually changed. When an event fires, stat the file and compare mtime to what you saw last time.

```js
let lastMtime = null;
fs.watch('./config.json', async () => {
  const stats = await fs.promises.stat('./config.json');
  if (lastMtime && stats.mtimeMs === lastMtime) return;
  lastMtime = stats.mtimeMs;
  console.log('Config actually changed');
});
```

Catches OS-level duplicate events and spurious metadata-only notifications. If inotify fires `IN_MODIFY` twice for the same write (which happens when applications make multiple small `write()` syscalls before closing), the later events see the same mtime and get suppressed.

Combine both techniques for the most reliable behavior. Stat-check first to suppress duplicates, then debounce to wait for the burst of events to settle before acting.

### Editor Safe-Write Patterns

Text editors don't just open-write-close your file. Many use a "safe write" pattern to avoid leaving a corrupt file if the editor crashes mid-save. Vim, VS Code, Sublime Text, JetBrains IDEs, and others all do variations of this. The irony: editors use atomic writes internally, and those atomic writes break naive file watchers.

Some command line tools (like `sed -i`) or atomic-write libraries write to `config.json.tmp`, rename `config.json` to `config.json~` (backup), then rename `config.json.tmp` to `config.json`. Three filesystem operations producing three separate events. Vim's actual default behavior is slightly different (renaming the original to a backup, then writing directly to a newly created file), but the result on watchers is similarly chaotic. VS Code writes to a randomly named temp file in the same directory, then renames it over the target - two operations. Some editors go further, creating the temp file in a completely different directory and moving it in, which might cross filesystem boundaries on certain setups.

From a file watcher's perspective, this sequence is chaotic. If you're watching `config.json` at the file level on Linux, you see a `'rename'` event when the original is renamed to the backup. Your inotify watch is now attached to an inode that points to `config.json~`, because inotify follows inodes, not names. The new `config.json` (created by renaming the temp file) has a completely different inode. Your watcher never sees the new content arrive. From your watcher's perspective, the file was renamed away and nothing else happened.

On macOS, FSEvents handles this somewhat better because it watches at the directory level by default and coalesces the rapid sequence into fewer events. But the timing is unpredictable - you might get one event, two events, or three, depending on how fast the tools perform the rename dance.

Watching the parent directory instead of the file itself is the standard workaround. You see rename events for all the shuffling, filter by filename to find the ones you care about, and debounce to wait until the active writing is done. The directory watcher stays valid through the entire sequence because the directory's inode never changes.

This interaction between editor save patterns and file watchers is one of the reasons chokidar exists. Detecting and consolidating these multi-step saves into a single "file changed" event requires tracking the sequence of events and recognizing the pattern. It's doable but tedious to implement from scratch.

## How inotify and FSEvents Work - the Kernel Internals

The platform differences in file watching stem from fundamentally different designs in the kernel subsystems underneath. Understanding these internals explains why `fs.watch()` behaves the way it does, and why no cross-platform wrapper fully masks the differences.

### inotify on Linux

inotify has three syscalls: `inotify_init1()`, `inotify_add_watch()`, and `read()`.

`inotify_init1()` creates an inotify instance and returns a file descriptor. This fd represents a queue of events. Like any fd, it participates in the event loop - libuv adds it to its epoll interest set and gets notified when events are available to read.

`inotify_add_watch(fd, pathname, mask)` registers a watch on a specific path. The `mask` parameter specifies which events you care about: `IN_MODIFY` (content changed), `IN_ATTRIB` (metadata changed), `IN_CREATE` (file created in a watched directory), `IN_DELETE` (file deleted from a watched directory), `IN_MOVED_FROM` / `IN_MOVED_TO` (rename source/destination), and others. The kernel returns a watch descriptor - an integer identifying this specific watch within the inotify instance.

When a matching event occurs, the kernel writes an `inotify_event` struct into the inotify fd's internal buffer. The struct contains the watch descriptor, an event mask, an optional cookie (linking paired rename events so you can match `MOVED_FROM` with `MOVED_TO`), a length field, and the filename. Your process reads these structs with `read()` on the inotify fd, just like reading from a regular file or pipe.

libuv wraps all of this in its `uv_fs_event` handle type. When you call `fs.watch()` in Node, it creates a `uv_fs_event_t` handle, which calls `inotify_init1()` (once per event loop - libuv shares a single inotify instance across all watches to minimize fd usage) and `inotify_add_watch()` for the target path. The inotify fd gets registered with epoll. When the kernel delivers events, the epoll wakeup triggers libuv's I/O callback, which reads the `inotify_event` structs from the fd, maps watch descriptors back to their registered paths, translates the event mask into Node's `'change'`/`'rename'` vocabulary, and fires your JavaScript callback on the next event loop iteration.

inotify watches individual inodes. When you watch a directory, inotify gives you events for files *in* that directory - but only that directory, not subdirectories. To watch recursively, you need a separate `inotify_add_watch()` for every subdirectory in the tree. Each watch consumes a slot in the per-user inotify watch table, which has a configurable maximum (`/proc/sys/fs/inotify/max_user_watches`). A large project with thousands of nested directories can exhaust this limit, producing `ENOSPC` errors.

inotify is event-granular. Each filesystem operation produces a distinct event with a distinct mask. No coalescing, no batching, no artificial delays. If you modify a file three times in one millisecond, you get three `IN_MODIFY` events. They're queued in the kernel's inotify buffer and delivered to your process in chronological order. If your process is slow to read them, the buffer grows, but the kernel doesn't drop events unless the buffer hits its maximum size (controlled by `/proc/sys/fs/inotify/max_queued_events`, default 16384).

### FSEvents on macOS

FSEvents is architecturally different. It was designed for Spotlight (macOS's search indexer) and Time Machine, where the goal is monitoring enormous directory trees - your entire home directory, sometimes the whole disk - with minimal CPU overhead. The design priorities are different from inotify: tree-level monitoring and low resource cost, rather than event-granular precision.

FSEvents watches directory paths, not individual files or inodes. When you register a path, you get notifications for that directory and everything below it - recursive by default. There's no equivalent of inotify's per-file watch, and no need to set up watches on every subdirectory. One registration covers the entire subtree. On a machine with 500,000 files, a single FSEvents stream handles the whole thing.

The kernel maintains an event stream per watched path. Events flow through a coalescing layer that batches rapid changes. If a file is modified ten times in 100ms, FSEvents might report one notification or two. The notification identifies which path was affected, but the event count depends on timing and the kernel's internal batching logic. FSEvents prioritizes "something changed here" over "here are all N individual changes that happened." For Spotlight indexing, this is ideal - you just need to re-index the file. For a file watcher that needs to count events or detect every intermediate state, it's a source of endless confusion.

FSEvents reports events asynchronously, sometimes with latency. When creating the stream, you configure a "latency" parameter - a minimum interval between event deliveries. The default in most implementations is around 1 second. libuv passes 0 for this parameter, requesting immediate delivery, but the kernel still coalesces when events arrive in bursts. There's no way to force truly synchronous, per-event delivery.

libuv's `uv_fs_event` on macOS creates an `FSEventStream` with the `kFSEventStreamCreateFlagFileEvents` flag, which requests per-file granularity (introduced in macOS 10.7). Without this flag, you only get directory-level notifications - "something changed in /src/components" with no indication of which file. Even with the flag, the coalescing behavior still applies: you get per-file paths, but rapid changes to the same file are merged into fewer events.

The practical consequence: your `fs.watch()` callback fires fewer times on macOS than on Linux for the same filesystem operations. Event counts differ. Timing differs. The `filename` parameter is more reliably populated on macOS (FSEvents always knows which path was affected), but the event semantics are fuzzier - you might miss intermediate states that inotify would have reported individually.

### ReadDirectoryChangesW on Windows

Windows takes a third approach. `ReadDirectoryChangesW()` is a Win32 API that watches a directory handle for changes. You pass it a buffer, and Windows fills that buffer with change records as they arrive. Each record contains the action type (`FILE_ACTION_MODIFIED`, `FILE_ACTION_ADDED`, `FILE_ACTION_REMOVED`, `FILE_ACTION_RENAMED_OLD_NAME`, `FILE_ACTION_RENAMED_NEW_NAME`) and the relative filename.

The API supports recursive watching natively via a flag parameter. Windows internally handles subdirectory monitoring. Rename events come as pairs - old name first, new name second - which is more useful than inotify's separate `MOVED_FROM`/`MOVED_TO` with a cookie linking them.

The buffer-overflow problem is the main weakness. `ReadDirectoryChangesW()` writes events into a fixed-size buffer you provide. If the buffer fills before you drain it (because many files changed rapidly, or your application was slow to process), Windows discards subsequent events. The API signals this failure by returning `ERROR_NOTIFY_ENUM_DIR`, which Node propagates as an `'error'` event on the watcher. You don't fail silently, but you do lose the specific events - your only recourse is to re-scan the directory manually to rebuild state. You can mitigate this by using a large buffer and processing events quickly, but there's no guaranteed upper bound on event volume during burst activity.

### The Practical Upshot

No wrapper library can make these two systems behave identically. inotify is a precision instrument - per-inode, per-event, in-order, no-coalescing, low-level. FSEvents is a power-efficient broadcast system - per-tree, coalesced, asynchronous, optimized for low overhead over massive directory hierarchies. ReadDirectoryChangesW on Windows sits somewhere between, with per-file events but buffer-based delivery that can overflow and silently lose events.

The best a library like chokidar can do is debounce, deduplicate, confirm changes with stat checks, and normalize the event vocabulary. It's a lot of logic to wrap what appears to be a three-line API.

## The Problem With Naive File Writes

Overwriting a file with `fs.writeFile()` opens it with the `'w'` flag by default. That flag truncates the file to zero bytes immediately, then writes the new content. Between truncation and write completion, the file is empty or partially written. If the process crashes in that window - uncaught exception, `SIGKILL`, power loss - you lose both old data and new data. The file is either empty or contains a fragment of the new content.

Even without a crash, writes can be partial. Node internally writes data in chunks via the `write()` syscall. If the disk fills up after 60% of the data is written, you get `ENOSPC`, and the file contains 60% of the new content with none of the old content. Corrupt. Your application might not even notice - the error gets thrown, your handler logs it, but the damage to the file is done.

Readers see whatever bytes are on disk at the moment they open the file. If another process (or another part of your own process) reads the config file while you're mid-write, it gets incomplete data. For a JSON config, that means broken JSON. The parsing fails. The application that depends on that config crashes or falls back to defaults that may not be appropriate for production.

This is particularly dangerous for services that read config files on every request (not recommended, but common). A deploy script updates the config with `fs.writeFile()`. A request arrives during the write. The service reads half-old, half-new JSON. Parse error. 500 response. And the next request might work fine because the write finished. Intermittent failures that are nearly impossible to reproduce.

The `'r+'` flag avoids truncation - it opens for reading and writing at the current position. But then you'd need to manually truncate after writing if the new content is shorter. A crash between writing and truncating leaves stale bytes from the old content appended to the new content. There's no flag combination that makes in-place overwrites safe. The filesystem simply doesn't offer "atomically replace file contents" as a primitive. Open, write, and close are separate syscalls, and a failure between any of them corrupts the file.

## The Temp-File-and-Rename Pattern

The fix: write to a temporary file, then rename the temp file over the target. The `rename()` syscall on POSIX is atomic when source and destination are on the same filesystem. It swaps the directory entry's inode pointer in a single operation. Readers see either the old file (if they opened it before the rename) or the new file (if they opened it after). A half-written state is impossible.

```js
const crypto = require('crypto');
const suffix = crypto.randomBytes(6).toString('hex');
const tempPath = `./config.json.tmp-${suffix}`;
await fs.promises.writeFile(tempPath, data, { flag: 'wx' });
await fs.promises.rename(tempPath, './config.json');
```

The `'wx'` flag means "write exclusively" - fail if the file already exists. Underneath, that's `O_WRONLY | O_CREAT | O_EXCL` at the syscall level. The `O_EXCL` flag makes the check-and-create atomic in the kernel. If two processes generate the same random suffix (astronomically unlikely with 6 random bytes, but theoretically possible), only one succeeds. The other gets `EEXIST` and can retry with a different name.

### Why rename() Is Atomic on POSIX

On POSIX, `rename()` updates directory entries. A directory is a mapping from names to inode numbers. When you rename file A to file B (same directory, same filesystem), the kernel updates B's directory entry to point to A's inode and removes A's entry. Both operations happen within a single filesystem transaction. The POSIX spec requires atomicity: rename either fully completes or fully fails. No intermediate state is visible to other processes.

If B already exists, its old inode is dereferenced (link count decremented). Processes that already had B's old inode open via a file descriptor can still read from it - the data isn't deleted until the last fd is closed and the link count reaches zero. But any process opening B after the rename gets the new inode. Clean switchover.

### Why Same-Filesystem Matters

`rename()` is atomic only when both paths resolve to the same mounted filesystem. If the temp file is on `/tmp` and the target is on `/var/app`, the kernel can't atomically update two different filesystems' directory entries. On Linux, you get an `EXDEV` error ("cross-device link") - the rename fails outright. Always create temp files in the same directory as the target.

This trips people up in Docker environments where `/tmp` might be a different mount from your application's data directory, or in systems where `os.tmpdir()` returns a path on a tmpfs ramdisk while your data lives on a persistent volume.

### Permissions After Rename

After rename, the target inherits the temp file's inode - including its permissions and ownership. If the original config file was `0644` owned by `www-data`, and your temp file is `0600` owned by `deploy`, the renamed file keeps the temp file's metadata. Your application running as `www-data` can no longer read its own config.

To preserve the original's permissions:

```js
const original = await fs.promises.stat(targetPath).catch(() => null);
await fs.promises.writeFile(tempPath, data, { flag: 'wx' });
if (original) await fs.promises.chmod(tempPath, original.mode);
await fs.promises.rename(tempPath, targetPath);
```

`chown()` requires root or matching ownership, so it's not always possible in non-root deployments. Copying the permission mode with `chmod()` is the more portable approach.

### Windows Differences

Windows file locking interacts forcefully with `rename()`. On POSIX, atomicity allows replacing an open file seamlessly (the old inode is unlinked from the directory but persists until its last file descriptor closes). On Windows, if the target file is currently open by another process, the system denies access to preserve concurrency controls, and the rename fails with `EPERM` or `EACCES` because Windows locks open files by default. The atomic operation aborted cleanly, but the replacement was blocked. POSIX doesn't have this restriction.

The workaround is retry-with-backoff:

```js
for (let i = 0; i < 5; i++) {
  try {
    await fs.promises.rename(tempPath, targetPath);
    break;
  } catch (err) {
    if (err.code !== 'EPERM' && err.code !== 'EACCES') throw err;
    await new Promise(r => setTimeout(r, 50 * (i + 1)));
  }
}
```

Eventually the other process closes its handle, and the rename succeeds. Windows also provides the `ReplaceFile()` Win32 API, which handles atomic replacement even with open handles, but Node doesn't expose it through `fs.rename()`.

## Creating Temporary Files and Directories

### fs.mkdtemp() for Temp Directories

```js
const os = require('os');
const path = require('path');
const dir = await fs.promises.mkdtemp(
  path.join(os.tmpdir(), 'myapp-')
);
```

Generates something like `/tmp/myapp-a7F3kL` and creates the directory atomically with a random suffix. `os.tmpdir()` returns the system's designated temp location - `/tmp` on Linux, a per-user `/var/folders/...` on macOS, `%LOCALAPPDATA%\Temp` on Windows.

But for atomic writes, don't put temp files in `os.tmpdir()`. Put them in the same directory as the target file so the rename stays on the same filesystem.

`fs.mkdtemp()` is for scratch work - staging multiple files before moving them, running isolated build steps, creating workspace directories for batch operations. For single-file atomic writes, create a temp file directly in the target directory with a random name and `O_EXCL`.

### TOCTOU and Why O_EXCL Matters

TOCTOU - time-of-check-time-of-use - is a race condition class specific to filesystem operations. You check if a file exists, then based on the result, create it. Between check and create, another process sneaks in.

```js
// Vulnerable to TOCTOU:
const exists = await fs.promises.access(tempPath)
  .then(() => true, () => false);
if (!exists) {
  await fs.promises.writeFile(tempPath, data);
}
```

Between `access()` and `writeFile()`, another process (or an attacker on a shared system) could create a file at `tempPath`, or even plant a symlink there redirecting your writes to an arbitrary location. `writeFile()` with the default `'w'` flag will happily follow the symlink and overwrite whatever it points to.

`O_EXCL` (the `'wx'` flag) eliminates the race. The check and the create happen in a single atomic syscall inside the kernel. Either the file doesn't exist and you create it, or it already exists and you get `EEXIST`. No gap between checking and creating. No window for an attacker or a competing process to exploit.

TOCTOU vulnerabilities are well-documented in security literature. They're particularly concerning on multi-user systems, CI environments, and shared development machines - anywhere multiple processes or users operate in the same directories. Even on single-user production servers, concurrent processes (multiple instances of your application, cron jobs, deploy scripts) can trigger TOCTOU races if you use check-then-create patterns instead of `O_EXCL`.

### Cleaning Up Temp Files

Temp files accumulate when processes crash between creating the temp file and renaming it. A few strategies handle this.

Include timestamps in temp file names: `.tmp-1708538400000-a1b2c3`. On startup, scan the directory for temp files older than a threshold and delete them. Easy to implement, and you can always tell at a glance how old an orphan is.

Track active temp files in a Set during the process lifetime. Delete them in `finally` blocks after each atomic write. Register a `process.on('exit')` handler that synchronously cleans any remaining tracked files:

```js
const tracked = new Set();
process.on('exit', () => {
  for (const p of tracked) {
    try { require('fs').unlinkSync(p); } catch {}
  }
});
```

Exit handlers don't run on `SIGKILL` or segfaults, so they're a best-effort mechanism. Startup cleanup is the backstop for those cases. Accept that some orphaned temp files will exist occasionally and design your system to tolerate a few stale `.tmp-*` files in the data directory.

For long-running servers, consider a periodic cleanup routine that scans for temp files older than a threshold:

```js
async function cleanStaleTemps(dir, maxAgeMs = 3600000) {
  const files = await fs.promises.readdir(dir);
  const now = Date.now();
  for (const f of files) {
    if (!f.startsWith('.tmp-')) continue;
    const match = f.match(/^\.tmp-(\d+)-/);
    if (!match) continue;
    if (now - parseInt(match[1]) > maxAgeMs) {
      await fs.promises.unlink(path.join(dir, f)).catch(() => {});
    }
  }
}
```

Run this on startup and optionally on a timer. It extracts the timestamp from the temp file name and deletes anything older than the threshold (1 hour by default). The `.catch(() => {})` handles the case where the file was already deleted by another process or the rename completed between the readdir and the unlink.

## Atomic Writes and File Watching Together

The rename in an atomic write fires a `'rename'` event on watchers. If you're watching a config file and a deploy script atomically replaces it, the watcher sees a rename, not a content change. Code that only handles `'change'` events misses the update entirely.

The reliable approach: ignore the event type and just re-read the file on any event.

```js
const reload = debounce(async () => {
  try {
    const raw = await fs.promises.readFile('./config.json', 'utf8');
    config = JSON.parse(raw);
  } catch {}
}, 500);

fs.watch('./config.json', reload);
```

Any event triggers a reload attempt. The debounce handles the burst of events that rename operations produce (the old file disappearing, the new file appearing). The `try/catch` handles the brief moment where the file might not exist between the old file's deletion and the new file's rename - during that gap, `readFile` would throw `ENOENT`.

Watching the parent directory is even more reliable:

```js
fs.watch('./', (event, filename) => {
  if (filename === 'config.json') reload();
});
```

Directory-level watching survives file deletion and recreation. The directory inode still exists, so the watch stays valid. If the config file is atomically replaced (old inode unlinked from the directory entry, new inode linked in via rename), the directory watcher sees both operations. A file-level watcher would break after the unlink on Linux because the watched inode is gone.

## A Complete Atomic Write Implementation

Putting the pieces together:

```js
async function atomicWrite(targetPath, data, options = {}) {
  const dir = path.dirname(targetPath);
  const suffix = crypto.randomBytes(6).toString('hex');
  const tempPath = path.join(dir, `.tmp-${Date.now()}-${suffix}`);

  let originalMode;
  try {
    originalMode = (await fs.promises.stat(targetPath)).mode;
  } catch {}

  await fs.promises.writeFile(tempPath, data, {
    flag: 'wx',
    mode: originalMode || 0o666,
    ...options,
  });

  try {
    await fs.promises.rename(tempPath, targetPath);
  } catch (err) {
    await fs.promises.unlink(tempPath).catch(() => {});
    throw err;
  }
}
```

Creates a temp file with a timestamped random name and `O_EXCL` exclusivity. Preserves the original file's permission mode if it exists. Renames atomically. Cleans up the temp file if the rename fails for any reason. Callers never see partial content at the target path.

For cross-platform use, wrap the rename in a retry loop for Windows `EPERM`/`EACCES` errors. For strict durability guarantees - surviving power loss, not just process crashes - call `fsync()` on the temp file's fd before closing it, and `fsync()` on the directory fd after the rename. Most applications don't need that level of durability, but databases and transaction logs do.

The overhead is one extra write (to the temp file) and one rename syscall. For small config files and JSON state, negligible. For large data files, the temp file doubles your write I/O - you write the data once to the temp file, then the rename is nearly instant (it's just a directory entry update, not a data copy). When atomicity doesn't matter - append-only logs, ephemeral scratch files, data you can regenerate - skip the pattern and write directly.

### When to Use Atomic Writes

Configuration files. Always. A corrupt config file means your application can't start, and manual recovery (SSH in, restore from backup, restart) is expensive. The atomic write pattern costs almost nothing for a few KB of JSON.

Application state files - caches, session stores, feature flags persisted to disk. If your application reads these on startup, corruption means data loss or broken behavior. Atomic writes guarantee the file is always valid.

PID files. A truncated PID file might cause your process manager to think the service isn't running and spawn a second instance. Writing the PID atomically avoids this.

Where you don't need it: append-only logs (each `appendFile()` call is already safe for small writes below the filesystem block size), temp files that are themselves ephemeral, and files generated by build tools that can be regenerated from source.

### Multi-File Atomic Updates with Symlink Swaps

The temp-file-and-rename pattern makes individual file updates atomic. But sometimes you need to update multiple files together - a deploy pushing new static assets, a build tool producing several output files, a migration updating both a data file and its index.

Individual atomic renames don't help here. If you rename file A successfully but crash before renaming file B, a reader might see the new A with the old B. Inconsistent.

The symlink swap pattern solves this. Write all files into a new versioned directory, then atomically swap a symlink that points to the "current" version:

```js
const newDir = `./data/v-${Date.now()}`;
await fs.promises.mkdir(newDir, { recursive: true });
await fs.promises.writeFile(`${newDir}/config.json`, configData);
await fs.promises.writeFile(`${newDir}/index.dat`, indexData);
```

Both files written. Now swap the symlink:

```js
const tmpLink = `./data/.current-tmp-${Date.now()}`;
await fs.promises.symlink(newDir, tmpLink);
await fs.promises.rename(tmpLink, './data/current');
```

The `rename()` on the symlink is atomic. Before the rename, `./data/current` points to the old version directory. After, it points to the new one. All files switch at once. Readers following the `current` symlink always see a consistent set of files - either all old or all new, never a mix.

The old version directory sticks around until you clean it up. You can keep a few old versions for rollback, or delete them after a grace period.

### Durability vs. Consistency

The atomic write pattern gives you consistency - readers never see partial content. But consistency and durability are different guarantees. Consistency means the file is always in a valid state. Durability means data survives a power failure or kernel crash.

`fs.writeFile()` writes to the kernel's page cache, not directly to disk. The kernel flushes dirty pages to physical storage on its own schedule, usually within 30 seconds. If power fails before the flush, your "written" data is lost. The file either contains stale content or nothing - depends on what was physically on disk.

For durability, you need `fsync()`. Call it on the temp file's fd after writing but before the rename:

```js
const handle = await fs.promises.open(tempPath, 'wx');
await handle.writeFile(data);
await handle.sync();
await handle.close();
await fs.promises.rename(tempPath, targetPath);
```

`handle.sync()` forces the kernel to flush the file's data and metadata to physical storage. After it returns, the data is on disk (assuming the disk isn't lying about having flushed - some drives have write caches that complicate this, but that's a hardware problem, not a software one).

For maximum paranoia, also fsync the directory after the rename. The rename updates the directory's data (it changes a name-to-inode mapping), and that update also sits in the page cache until flushed. If power fails between the rename and the directory fsync, the rename might not persist. Databases like SQLite and PostgreSQL do this. Most applications don't need to - the window for data loss is tiny, and the performance cost of syncing the directory on every write is high.
