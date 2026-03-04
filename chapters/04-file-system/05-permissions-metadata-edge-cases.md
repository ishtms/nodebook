---
title: "Permissions, Metadata, and Edge Cases"
date: "2026-02-22"
excerpt: "File permissions, ownership, stat metadata, symlinks, and edge cases with /dev, /proc, and sparse files."
category: "File System"
tags: ["nodejs", "file-system", "permissions", "stat", "symlinks"]
author: "Ishtmeet Singh @ishtms"
chapter: "file-system"
subchapter: "permissions-metadata-edge-cases"
published: true
toc: true
---

`ls -l` shows you something like `-rw-r-r-`. Nine characters encoding who can do what. Most developers glance at this output, maybe google "chmod 755," and move on. But those nine bits sit between your Node.js process and every file operation it attempts. The kernel checks them on every `open()` call. Get them wrong, and your app crashes in production with `EPERM` at 3am.

Permissions are just one slice of metadata, though. The operating system tracks a lot of information about each file - size, timestamps, ownership, type, inode number, block allocation. All of it stored separately from the file's content, typically in a data structure that's around 256 bytes on ext4. All of it accessible through `fs.stat()`. And some of it will surprise you, especially when you leave the comfortable world of regular files and start encountering device files, virtual filesystems, and sparse files.

## The Unix Permission Model

Every file on a Unix system carries nine permission bits organized into three groups of three:

- **Owner (user):** the person who created the file
- **Group:** users belonging to the file's assigned group
- **Others:** everyone else

Each group gets three bits: **read** (r), **write** (w), **execute** (x). That's the entire model. Three categories, three operations, nine bits total.

The bits map to octal digits. Each digit is the sum of: 4 for read, 2 for write, 1 for execute. So `rwx` = 7, `rw-` = 6, `r-x` = 5, `r-` = 4. Three digits make a complete permission set. When you see permissions displayed as `-rw-r-r-`, the first character is the file type (`-` for regular, `d` for directory, `l` for symlink), and the remaining nine characters map directly to the three octal digits: `rw-` = 6, `r-` = 4, `r-` = 4. That's `0o644`.

```js
const fs = require('fs');
const stats = fs.statSync('./package.json');
const perms = stats.mode & 0o777;
console.log(perms.toString(8)); // "644"
```

The `mode` field is an integer. High bits encode the file type (regular file, directory, symlink, device). Low 9 bits encode permissions. Masking with `0o777` extracts just the permission bits, stripping the file type information.

If you stat a file and see a raw mode like `33188`, that's `0o100644` in octal. The `0o100` part means "regular file." The `644` part is the permission bits. You almost never need to decode the file type from mode manually - that's what `stats.isFile()`, `stats.isDirectory()`, and friends are for.

Common permission sets you'll see constantly:

- `0o644` - owner reads/writes, everyone else reads. Default for most files.
- `0o755` - owner reads/writes/executes, everyone else reads/executes. Standard for executables and directories.
- `0o600` - owner reads/writes, nobody else has access. Private keys, credentials.
- `0o777` - everyone can do everything. Almost never appropriate.

For directories, the execute bit means something different. It controls whether you can traverse into the directory - access files inside it, `cd` into it. A directory with read but no execute lets you list its contents, but you can't open anything inside. A directory with execute but no read lets you access files if you know their names, but you can't list what's there. Directories usually get `0o755`.

That's a subtlety most developers miss. They see a directory with `0o744` and think "owner full access, everyone can read." But without execute on a directory, "read" only means you can list the filenames. You can't actually open any of them. You can't `cd` in. The execute bit on directories is the gatekeeper.

### How Default Permissions Work

When your Node process creates a file, it doesn't get `0o666` (read/write for everyone). The OS applies a mask first. The **umask** is a process-level bitmask that turns off specific permission bits on newly created files.

On most systems, the default umask is `0o022`. The math:

```
0o666  (default for files)
& ~0o022  (invert the umask, then AND)
= 0o644  (rw-r-r-)
```

That's why `fs.writeFile()` creates files with `0o644` by default. The umask stripped write permission from group and others. For directories, the starting point is `0o777` instead of `0o666`, so a `0o022` umask produces `0o755` - the standard directory permission.

You can override default permissions explicitly when creating files:

```js
fs.writeFileSync('./secret.key', keyData, { mode: 0o600 });
```

Now only the file owner can read or write it. The explicit `mode` option takes precedence over the umask - it tells the OS exactly what permissions to set, and the umask is applied on top. Well, technically the umask still applies. If your umask is `0o077` and you specify `mode: 0o644`, the resulting permissions are `0o600`. The umask always wins. To guarantee exact permissions, call `fs.chmod()` after creation.

`process.umask()` reads or sets the process umask, but changing it affects every file your process creates afterward. It's a global setting - there's no per-operation umask. Prefer setting `mode` explicitly per-file instead. And if you do read the umask with `process.umask()`, be aware that calling it with no arguments is actually thread-unsafe. Internally, Node calls the C `umask(0)` to read the value (which temporarily sets the mask to 0), then immediately restores it. That tiny window where the mask is 0 can race with file-creation operations on worker threads, producing files with unexpected permissions. This is why Node.js deprecated the no-argument form (DEP0139).

### Changing Permissions

```js
fs.chmodSync('./deploy.sh', 0o755);
```

After this, `deploy.sh` has `rwxr-xr-x`. Owner can read, write, execute. Everyone else can read and execute. On Unix, execute permission is what makes a script runnable - there's no `.exe` convention like Windows. You write a script, you `chmod +x` it, and the kernel lets you run it.

Only the file's owner (or root) can change permissions. If your Node process doesn't own the file, `fs.chmod()` throws `EPERM`. This is a hard kernel restriction, not something Node enforces.

```js
fs.chmod('./config.json', 0o644, (err) => {
  if (err && err.code === 'EPERM') {
    console.error('Cannot change permissions - not the owner');
  }
});
```

`fs.fchmod()` does the same thing but takes an open file descriptor instead of a path. Useful when you already have an fd and don't want to pass paths around. There's also the promise variant through `fileHandle.chmod()` if you're working with the `fs.promises` API.

One detail: `chmod()` updates the file's `ctime` (change time) but leaves `mtime` alone. You changed metadata, not content. This distinction matters for build tools that check mtime to decide what to rebuild - a permission change won't trigger a rebuild.

A practical pattern you'll see in deployment scripts: after extracting a tarball or cloning a repo, scan for shell scripts and ensure they have execute permissions:

```js
const entries = fs.readdirSync('./bin');
for (const entry of entries) {
  if (entry.endsWith('.sh')) {
    fs.chmodSync(`./bin/${entry}`, 0o755);
  }
}
```

Another common use: creating private files for secrets. SSH refuses to use a private key if it's group-readable or world-readable. Your application might have similar requirements:

```js
function checkKeyPermissions(keyPath) {
  const stats = fs.statSync(keyPath);
  const perms = stats.mode & 0o777;
  if (perms & 0o077) {
    throw new Error(`${keyPath} has permissions ${perms.toString(8)}, expected 0600`);
  }
}
```

The bitmask `0o077` checks whether group or others have any access at all. If any of those bits are set, the key file is too permissive.

### File Ownership and fs.chown()

Every file has a numeric owner (uid) and group (gid). When your process opens a file, the kernel checks these in order: does the process uid match the file's uid? If yes, apply owner permissions. If no, does the process gid match the file's gid? If yes, apply group permissions. Otherwise, apply others permissions.

The check is ordered. If you're the owner but your owner permissions are more restrictive than the group permissions, you get the owner permissions. The kernel uses the first match, not the most permissive match.

```js
const stats = fs.statSync('./app.log');
console.log(`uid: ${stats.uid}, gid: ${stats.gid}`);
```

You can find your own process's uid with `process.getuid()` on Unix. Mapping numeric uids to usernames requires system calls that Node exposes through `os.userInfo()`:

```js
const os = require('os');
const info = os.userInfo();
console.log(`Running as: ${info.username} (uid=${info.uid})`);
```

`fs.chown()` changes ownership, but on Unix only root can do it. Regular users can't transfer file ownership - a security measure against quota circumvention and impersonation. Some systems let you change the group to another group you belong to, but changing the uid always requires root.

```js
fs.chownSync('./app.log', 33, 33); // www-data on Debian/Ubuntu
```

This is primarily useful in deployment scripts running as root, inside Docker containers during image builds, or in setup scripts that create files owned by a service account. A container build might create log directories as root and then `chown` them to the app user before dropping privileges.

There's also `fs.lchown()` for changing ownership of a symlink itself (rather than following it to the target). Rarely needed, but it exists.

### fs.access(), Effective UIDs, and the TOCTOU Problem

`fs.access()` checks whether the calling process can read, write, or execute a file:

```js
const { constants } = require('fs');
fs.accessSync('./config.json', constants.R_OK | constants.W_OK);
```

If the check fails, it throws. But if it succeeds, you *still* might not be able to open the file.

The first reason is a quirk of Unix user IDs. `access()` checks permissions using the process's **real** user ID (UID) and group ID (GID). However, actual file operations like `open()` use the process's **effective** IDs (EUID/EGID). If your process is running with elevated privileges (like setuid) or has dropped privileges temporarily, `fs.access()` might report success based on the real ID, but `fs.open()` immediately throws `EACCES` because the effective ID lacks permission.

The second reason is the TOCTOU (Time of Check, Time of Use) race condition. Between your `access()` check and the actual `open()` call, permissions could change. Another process might `chmod` the file. The directory might get renamed. The file might get deleted.

The better approach: just try the operation and handle the error. Don't check then act - act then handle failure. The Node.js docs explicitly recommend against using `fs.access()` before `open()`, `readFile()`, or `writeFile()`. Use it only when you need to report whether a file is accessible without actually reading it - like a health check or status display.

### Windows - A Different World

Windows doesn't use Unix-style permission bits. It uses Access Control Lists (ACLs) - a more granular model where each file can have a list of entries specifying exactly which users or groups have which permissions. An ACL can express things Unix permissions can't, like "user A can read but not write, user B can write but not delete, group C can do everything except change permissions."

> [!NOTE]
> **What are ACLs?**
> Access Control Lists (ACLs) are data structures used by Windows (and advanced Unix filesystems) to manage object permissions. Instead of unix's rigid owner/group/other triad, an ACL consists of multiple Access Control Entries (ACEs). Each ACE explicitly grants or denies specific rights (like read, write, execute, or delete) to a specific user or group. This allows for highly complex and fine-grained permission models, such as granting a specific user read-only access while denying another user specifically inside the same group.

Node.js tries to bridge the gap. Setting `0o444` on Windows sets the read-only attribute. Setting `0o666` clears it. But execute permission is meaningless on Windows - executability comes from file extensions (`.exe`, `.bat`, `.cmd`), not permission bits. The execute bit is silently ignored.

`fs.chown()` on Windows exists for API compatibility but rarely does anything useful. Windows ownership is tied to Security Identifiers (SIDs), which are complex structures - not simple numeric uids. If you're writing cross-platform code, focus on `fs.chmod()` for basic read-only toggling, and handle platform-specific permission needs outside of Node.

```js
if (process.platform !== 'win32') {
  fs.chmodSync('./script.sh', 0o755);
}
```

### Special Permission Bits

Beyond the 9 basic bits, there are three special bits occupying a fourth octal digit:

- **Setuid (4):** When set on an executable, it runs with the file owner's privileges regardless of who runs it. This is how `passwd` changes `/etc/shadow` (owned by root) when run by a regular user.
- **Setgid (2):** On executables, runs with the file group's privileges. On directories, new files created inside inherit the directory's group rather than the creator's primary group. Useful for shared project directories.
- **Sticky bit (1):** On directories like `/tmp`, prevents users from deleting files they don't own, even if they have write access to the directory.

You'll see these in modes like `0o1755` (sticky + standard executable) or `0o4755` (setuid). Application code rarely sets them - they're system administration concerns. But you might encounter them when reading `stats.mode` and wondering why the first digit isn't 0.

## Metadata and the Stats Object

`fs.stat()` makes a single syscall to retrieve everything the OS knows about a file - everything except its content. It's fast precisely because it doesn't touch the data. You can stat a 100GB file in microseconds.

```js
const stats = fs.statSync('./data.json');
console.log(stats.size);       // bytes
console.log(stats.mtimeMs);    // last modification (ms)
console.log(stats.mode);       // type + permissions
```

The Stats object contains a lot of fields. Here's what each one actually means:

- **size** - Content length in bytes. This is the logical size. For regular files, it matches the byte count. For symlinks (via lstat), it's the length of the target path string. For directories, it's the size of the directory data structure on disk. For device files, it's 0.
- **mode** - File type (high bits) + permissions (low 9 bits). Decode with `stats.isFile()` and friends, or mask with `0o777` for raw permissions.
- **uid, gid** - Numeric owner and group. Map to usernames via `os.userInfo()` or system tools.
- **nlink** - Hard link count. How many directory entries point to this inode. Regular files start at 1. Directories start at 2 (the entry in the parent directory plus the `.` entry inside the directory itself).
- **ino** - The inode number. Combined with `dev`, this uniquely identifies the file across the entire system.
- **dev** - Device ID of the filesystem containing this file. Two files on different mounts have different `dev` values.
- **rdev** - If this is a device file, the device ID it represents. For regular files, 0.
- **blksize** - Preferred I/O block size. Usually 4096. The filesystem's hint for optimal read/write chunk sizes.
- **blocks** - Number of 512-byte blocks actually allocated on disk. This can be less than `size / 512` for sparse files, or slightly more than expected due to filesystem block alignment.

### Timestamps

Four timestamps track different events in a file's lifecycle. Understanding which one updates when is the difference between a build tool that works and one that rebuilds everything every time.

**mtime** (modification time) updates when file content changes. Any write to the file bumps mtime. This is the timestamp you care about most. Build tools compare source mtime against output mtime to decide what needs recompiling. Cache invalidation strategies store mtime alongside cached results. File sync tools compare mtimes to detect changes.

```js
function needsRebuild(src, out) {
  try {
    const srcStat = fs.statSync(src);
    const outStat = fs.statSync(out);
    return srcStat.mtimeMs > outStat.mtimeMs;
  } catch { return true; }
}
```

The `catch` handles two common failure cases cleanly: if the output doesn't exist yet, `stat(out)` throws `ENOENT` and we definitely need to build. And if the source file doesn't exist, `stat(src)` throws first, returning true and pushing the failure downstream to the actual build step (which will surface the missing file error better than a timestamp check could).

**atime** (access time) tracks when the file was last read. In theory. In practice, many Linux systems mount filesystems with `relatime` or `noatime`, which throttle atime updates for performance. Updating atime on every read would mean a metadata write for every read operation - a significant overhead. With `relatime` (the common default), atime only updates if the current atime is older than mtime or ctime, or if more than 24 hours have passed. With `noatime`, atime never updates. Don't rely on atime being precise. It's a rough signal at best.

**ctime** (change time) updates when metadata or content changes. Rename the file, `chmod` it, `chown` it, write to it - ctime updates for all of these. And here's the thing you can't do: set ctime directly. There's no API for it. The kernel manages ctime exclusively. This makes ctime useful for detecting tampering - an attacker can fake mtime with `fs.utimes()`, but ctime still reflects when the file was actually last touched.

Ctime is often confused with "creation time." It's change time, not creation time. The name comes from the POSIX specification, where "c" stands for "change" (referring to the inode's change status). Prior to Node v0.12, things were confusing because Node mapped the Windows creation time to `ctime`, leading developers to assume `ctime` meant creation globally. Today, Node maps the Windows "ChangeTime" attribute to `ctime` for consistency with Unix, keeping true creation time strictly in `birthtime`.

**birthtime** (creation time) records when the file was first created. Supported on macOS (APFS, HFS+) and recent Linux kernels with ext4/XFS. On older Linux kernels or filesystems that don't track creation time, Node returns the Unix epoch (January 1, 1970) or falls back to ctime. You can detect this: if `birthtime` equals the epoch or equals `ctime`, the filesystem probably doesn't support it.

Each timestamp exists in two forms: `mtime` (Date object) and `mtimeMs` (millisecond number). Use the `Ms` variants for comparisons - comparing numbers is faster and avoids Date coercion quirks:

```js
if (stats.mtimeMs > cachedMtimeMs) {
  console.log('file changed since last check');
}
```

`fs.utimes()` lets you set atime and mtime:

```js
const now = new Date();
fs.utimesSync('./file.txt', now, now);
```

This is the programmatic equivalent of `touch`. Useful for forcing a rebuild (bump mtime so the build tool sees a "change"), preserving timestamps during file copies (copy the content, then set the copy's mtime to match the original), or testing time-dependent code.

You can set atime and mtime to anything - past, present, future. You cannot set ctime or birthtime. ctime always reflects the real last modification of metadata, and birthtime is immutable after creation.

A practical use of `fs.utimes()` in a backup tool:

```js
fs.copyFileSync(src, dest);
const srcStats = fs.statSync(src);
fs.utimesSync(dest, srcStats.atime, srcStats.mtime);
```

The copy now has the same timestamps as the original. Without this step, the copy would have the current time as both atime and mtime, which would confuse incremental backup tools into thinking the file is "new."

### BigIntStats

By default, timestamps have millisecond precision. If you need nanosecond precision (rare, but relevant for high-frequency build tools or forensic analysis), pass `{ bigint: true }` to `stat()`:

```js
const stats = fs.statSync('./file.txt', { bigint: true });
console.log(stats.mtimeNs); // 1678901234567890123n
```

All numeric fields become BigInts. Timestamps gain `Ns` variants with nanosecond resolution. Size, ino, blocks - all BigInts. The tradeoff: BigInt arithmetic is slower than regular number arithmetic, and BigInts can't be mixed with regular numbers without explicit conversion. Use this only when you specifically need the extra precision.

### stat vs lstat vs fstat

Three variants serve different purposes:

- `fs.stat(path)` - follows symlinks. If the path is a symlink, returns the target's metadata.
- `fs.lstat(path)` - does not follow symlinks. Returns the symlink's own metadata.
- `fs.fstat(fd)` - operates on an open file descriptor instead of a path.

The `lstat` distinction matters when you're working with symlinks and need to inspect the link itself rather than its target. With `stat()`, a symlink to a 1MB file reports `size: 1048576`. With `lstat()`, that same symlink reports `size: 12` (the length of the path string stored in the symlink). And only `lstat()` makes `isSymbolicLink()` return true.

`fstat()` is useful when you've already opened a file and want metadata without resolving the path again. The file descriptor points directly to the inode, so `fstat()` skips the path resolution entirely. Slightly faster, and avoids any race conditions where the path might change between `open()` and `stat()`.

### Type-Checking Methods

The Stats object has methods to identify what kind of file you're looking at:

```js
stats.isFile()            // regular file
stats.isDirectory()       // directory
stats.isSymbolicLink()    // symlink (only true via lstat)
stats.isCharacterDevice() // e.g., /dev/null, /dev/urandom
stats.isBlockDevice()     // e.g., /dev/sda
stats.isFIFO()            // named pipe
stats.isSocket()          // Unix domain socket
```

These decode the type bits from `mode`. Internally, they mask `mode` with `S_IFMT` (file type mask) and compare against constants like `S_IFREG` (regular file), `S_IFDIR` (directory), `S_IFLNK` (symlink). You could do this yourself with bitwise operations, but the methods are clearer and handle cross-platform differences.

You'll use them to guard file operations. Before calling `readFile()` on an arbitrary path, check `isFile()`. Before recursing into a directory entry, check `isDirectory()`. Before anything at all, check that you're not about to open a character device that produces infinite data.

A common pattern for directory traversal:

```js
const entries = fs.readdirSync(dir, { withFileTypes: true });
for (const entry of entries) {
  if (entry.isFile()) processFile(path.join(dir, entry.name));
  if (entry.isDirectory()) recurse(path.join(dir, entry.name));
}
```

The `{ withFileTypes: true }` option returns Dirent objects instead of strings. Each Dirent has the same type-checking methods as Stats, but without needing a separate `stat()` call. On Linux, this information comes from the `readdir` syscall itself (via `d_type`), so it's free - no extra system call needed.

## Links and Inodes

A file's path is just a name. Its real identity is the **inode** - a data structure the filesystem maintains containing all metadata (permissions, timestamps, size, block pointers) plus a unique number. The inode stores everything about the file except two things: its name and its content. Names live in directories (which are themselves files containing name-to-inode mappings). Content lives in data blocks that the inode points to.

This separation is important. When you open `/home/user/file.txt`, the kernel walks the path component by component: look up the root inode, find `home` in the root directory, load the `home` inode, find `user` in that directory, load the `user` inode, find `file.txt`, load its inode. The path is a lookup chain. The inode is the destination.

And because the name is separate from the file, you can have multiple names pointing to the same file.

### Hard Links

A hard link is another directory entry pointing to the same inode. Both names are equal. There's no "original" and "copy." They share content, metadata, everything - because they are the same file.

```js
fs.writeFileSync('a.txt', 'hello');
fs.linkSync('a.txt', 'b.txt');
console.log(fs.statSync('a.txt').ino === fs.statSync('b.txt').ino); // true
```

Modify through one name, the other sees the change. `appendFileSync('b.txt', ' world')` and `readFileSync('a.txt')` returns `'hello world'`. There's one inode underneath, one set of data blocks. The two names are just two directory entries referencing that inode.

The inode tracks how many names point to it in the `nlink` field. A fresh file has `nlink` of 1. Create a hard link, `nlink` becomes 2. `fs.unlink()` removes one directory entry and decrements `nlink`. The file's data is only freed when `nlink` hits 0 **and** no open file descriptors reference the inode.

That last part is subtle. You can unlink a file (remove all its names), but if a process still has it open via a file descriptor, the inode survives. The data stays on disk. The file has no name, no path, but the fd still works. When the last fd closes, the kernel finally reclaims the inode and data blocks. Unix programs exploit this for temporary storage: create a file, open it, immediately unlink it. The file exists only through the fd. When the process exits, the file vanishes automatically. No leftover temp files.

This is why `fs.unlink()` is called "unlink" and not "delete." You're removing a link. The file might persist under other names or through open fds.

Hard links have constraints: they can't cross filesystem boundaries (inode numbers are local to a filesystem, so `EXDEV` means cross-device link), and you can't hard link directories (would create cycles in the directory tree, producing `EPERM`).

Backup tools use hard links heavily. If a file hasn't changed between today's backup and yesterday's, the tool creates a hard link in today's snapshot pointing to yesterday's copy. One set of data blocks serves both snapshots. A 10-backup rotation where most files don't change might use barely more disk space than a single backup.

### Symbolic Links

A symlink is a separate file whose content is a path string. When you access it, the filesystem reads that stored path and redirects the operation to the target. The symlink has its own inode, separate from the target's inode.

```js
fs.symlinkSync('target.txt', 'link.txt');
console.log(fs.readlinkSync('link.txt')); // 'target.txt'
```

`fs.readlink()` returns the raw path stored inside the symlink without following it. `fs.readFile('link.txt')` follows the symlink and reads the target. `fs.lstat('link.txt')` inspects the symlink's own metadata; `fs.stat('link.txt')` follows through to the target's metadata.

Symlinks can cross filesystems - they store a path, not an inode number. They can point to directories. They can point to nonexistent paths, creating a **dangling symlink** that exists as a file but leads nowhere (following it throws `ENOENT`). They can point to other symlinks, forming chains that the kernel resolves recursively up to a limit (usually 40 on Linux). Circular chains produce `ELOOP`.

```js
fs.symlinkSync('b.txt', 'a.txt');
fs.symlinkSync('a.txt', 'b.txt'); // circular
fs.readFileSync('a.txt'); // throws ELOOP
```

Symlinks can be relative or absolute. A relative symlink stores something like `../data/file.txt`, resolved from the symlink's directory. Move the symlink elsewhere, and the relative path breaks. An absolute symlink stores `/home/user/data/file.txt` - stable across moves but not portable across machines.

Delete the target of a symlink, and the symlink becomes dangling. Delete a hard link's name, and the file might persist under other names. That's the core tradeoff: hard links share the inode and survive name removal; symlinks store a path and break when the target moves.

Most operations follow symlinks transparently: `stat`, `readFile`, `writeFile`, `chmod`, `chown`. A few don't: `lstat` inspects the link itself, `unlink` removes the link (not the target), `readlink` reads the stored path, and `rename` renames the link itself.

`fs.realpath()` resolves all symlinks in a path and returns the final absolute target. Useful for canonical path comparisons when two different symlinks might point to the same underlying file.

Deployment tools rely on symlinks for atomic version switching. You deploy v2 to a new directory, create a symlink `current -> releases/v2`, and atomically swap it by creating a temp symlink and `rename()`-ing it over the old one. Processes see either v1 or v2, never a half-state.

### Detecting Same-File Relationships

Two paths might refer to the same file via hard links or symlinks. To check:

```js
function sameFile(p1, p2) {
  const s1 = fs.statSync(p1);
  const s2 = fs.statSync(p2);
  return s1.dev === s2.dev && s1.ino === s2.ino;
}
```

Both `dev` and `ino` must match. Inode numbers are only unique within a filesystem, so `dev` disambiguates across mount points. Two files on different filesystems can share an inode number by coincidence - only the combination is globally unique.

## When Files Aren't Files

Unix's "everything is a file" design means your code might encounter paths that look like files but behave nothing like them. Knowing how to detect and handle them prevents hangs, resource exhaustion, and corrupted output.

### Device Files

Files in `/dev` represent kernel interfaces, backed by driver code rather than disk storage. The important ones:

**`/dev/null`** discards all writes and returns EOF immediately on reads. Safe with any operation. `fs.readFile('/dev/null')` returns an empty buffer. Writes succeed instantly and the data goes nowhere. Commonly used as a data sink in shell pipelines.

**`/dev/urandom`** produces an infinite stream of cryptographically random bytes from the kernel's CSPRNG (Cryptographically Secure Pseudo-Random Number Generator). The stream never ends. There's no EOF. So `fs.readFile('/dev/urandom')` keeps reading, allocating more memory for each chunk, until your process runs out of heap and crashes. This is one of the most common gotchas when building tools that process arbitrary file paths.

You must use fixed-size reads:

```js
const handle = await fs.promises.open('/dev/urandom', 'r');
const buf = Buffer.alloc(32);
await handle.read(buf, 0, 32, null);
await handle.close();
```

Or better, use `crypto.randomBytes(32)`, which handles the platform interaction internally and works cross-platform. Under the hood, it calls OpenSSL's `RAND_bytes()`, which sources entropy from the OS - `/dev/urandom` on Linux, `BCryptGenRandom` on modern Windows.

**`/dev/zero`** produces infinite zero bytes. Same hang potential as `/dev/urandom` with `readFile()`. Occasionally used for performance benchmarks or creating zero-filled files, but always with explicit byte limits.

Character devices like these report `stats.size` of 0 and `stats.isCharacterDevice()` as true. Block devices (`/dev/sda`, `/dev/nvme0n1`) represent raw disk storage. They're seekable and have finite size, but reading them returns raw disk sectors, requires root, and is never what a file-processing tool expects.

Detect and reject:

```js
if (stats.isCharacterDevice() || stats.isBlockDevice()) {
  throw new Error(`Cannot process device file: ${filePath}`);
}
```

### The /proc Filesystem

`/proc` is a virtual filesystem on Linux. Its "files" don't exist on disk - the kernel generates their content on the fly when you `read()` them. `/proc/cpuinfo` exposes CPU information, `/proc/meminfo` shows memory statistics, `/proc/[pid]/status` reveals per-process details.

The catch: `stat()` reports `size` as 0 for most `/proc` files. The kernel doesn't know how much text it'll generate until you actually read - the content is produced by a callback function that formats current kernel data structures into human-readable text. So code that pre-allocates buffers based on `stats.size` gets nothing:

```js
const stats = fs.statSync('/proc/cpuinfo');
console.log(stats.size); // 0 - but the file has content
```

`fs.readFile()` handles this fine - it reads in chunks until EOF without trusting the reported size. But low-level code using `fs.read()` with a buffer sized to `stats.size` would allocate 0 bytes and read nothing.

Content is dynamic. Read `/proc/meminfo` twice with a 100ms gap and you'll get different numbers. Each read produces a fresh snapshot of kernel state. These aren't cached values - the kernel runs the formatting function every time.

`/proc/self` is a symlink to `/proc/[your-pid]/`, convenient for introspection. `/proc/[pid]/cmdline` gives you a process's command-line arguments (null-separated bytes). `/proc/[pid]/fd/` is a directory of symlinks - each one points to the file that file descriptor number has open. Useful for debugging leaked fds.

`/proc` exists only on Linux. macOS uses `sysctl` for similar system info. Windows has nothing equivalent in the filesystem namespace. Guard your code:

```js
if (process.platform === 'linux' && somePath.startsWith('/proc/')) {
  return fs.readFileSync(somePath, 'utf8');
}
```

### Named Pipes (FIFOs) and Unix Sockets

Named pipes are inter-process communication channels that appear as files in the filesystem. When one process opens a named pipe for reading, it blocks until another process opens the pipe for writing (and vice versa). If your file-processing tool encounters a named pipe, it hangs waiting for the other end to connect.

Unix domain sockets are local IPC endpoints used by Docker (`/var/run/docker.sock`), PostgreSQL, MySQL, and many system daemons. They show up in `stat()` results and look like files, but they aren't readable with `readFile()` or `createReadStream()`. They're connection endpoints that speak specific protocols.

Check for both:

```js
if (stats.isFIFO() || stats.isSocket()) {
  throw new Error('Cannot process IPC endpoint');
}
```

### Sparse Files

> [!NOTE]
> **What is a Sparse File?**
> A sparse file is a type of computer file that attempts to use file system space more efficiently when the file itself is mostly empty. This is achieved by writing brief information (metadata) representing the empty blocks to disk instead of the actual "empty" space which makes up the block. The file system only allocates actual disk blocks when data is written to the file. When reading regions of the file that have no allocated blocks, the file system simply returns zero bytes to the application.

A sparse file has "holes" - regions that are logically zero but don't consume disk space. The filesystem keeps track of where the holes are and returns zeros when you read those regions, but no actual disk blocks are allocated for the zero data.

```js
const stats = fs.statSync('disk-image.qcow2');
const logicalSize = stats.size;          // 50GB
const actualBytes = stats.blocks * 512;  // 2GB
```

The file reports 50GB but only uses 2GB on disk. The other 48GB is holes - logical zeros that cost no storage.

Sparse files behave identically to regular files for reading. You read from a hole, you get zeros. The problem is copying: `fs.readFileSync()` followed by `fs.writeFileSync()` reads all those zeros from holes and writes them as real data. Your 2GB-on-disk file balloons to 50GB in the copy. The destination file has no holes - every zero byte is backed by real storage.

For sparse-aware copies on Linux, use the system's `cp` command:

```js
const { execSync } = require('child_process');
execSync(`cp -sparse=always "${src}" "${dest}"`);
```

The `-sparse=always` flag tells `cp` to detect runs of zeros and create holes in the destination instead of writing them.

Detect sparse files by comparing logical size to actual disk usage:

```js
function isSparse(stats) {
  return stats.blocks * 512 < stats.size;
}
```

`stats.blocks` counts 512-byte blocks regardless of the filesystem's actual block size. Multiplying by 512 gives you the real bytes allocated on disk. If that's less than `stats.size`, there are holes.

Sparse files are common with VM disk images (QCOW2, VMDK), database files (some engines preallocate large files), and container overlay filesystems. If your tool copies or processes arbitrary files, consider whether sparse-awareness matters.

### A Safe File Type Guard

Combining all these checks:

```js
async function ensureRegularFile(filePath) {
  const stats = await fs.promises.stat(filePath);
  if (stats.isDirectory()) throw new Error('Is a directory');
  if (stats.isCharacterDevice()) throw new Error('Character device');
  if (stats.isBlockDevice()) throw new Error('Block device');
  if (stats.isFIFO()) throw new Error('Named pipe');
  if (stats.isSocket()) throw new Error('Unix socket');
  if (!stats.isFile()) throw new Error('Unknown file type');
  return stats;
}
```

Call this before any file operation that expects regular files. Prevents hangs on `/dev/urandom`, blocking on named pipes, errors on directories - the full spectrum of special file type surprises.

## The VFS Layer and How stat() Actually Works

When you call `fs.stat('./file.txt')`, your JavaScript triggers a chain that crosses four boundaries: JavaScript -> C++ binding -> libuv -> the kernel. Understanding that chain explains why some files report size 0, why `stat()` is fast, and why different filesystems can all expose the same Stats interface.

Node's `fs.stat()` calls into its C++ binding layer, which calls `uv_fs_stat()` in libuv. Libuv posts the work to the thread pool (since stat is a blocking filesystem operation), and the thread pool worker issues the actual `stat()` system call. On Linux, libuv tries the newer `statx(2)` first and falls back to `stat(2)` on older kernels. On macOS, `stat64`. On Windows, a combination of `GetFileAttributesExW` and `GetFileInformationByHandle`.

> [!NOTE]
> **What is the VFS?**
> The Virtual File System (VFS) is a kernel abstraction layer that provides a uniform interface to the various different physical filesystems that might be mounted on a system. Without VFS, user-space applications (like Node) would need specific code to talk to ext4 for the root drive, specific code to talk to NFS for a network mount, and specific code to talk to tmpfs for the `/tmp` directory. Instead, Node calls a standard POSIX function, and VFS routes that call to the appropriate filesystem driver under the hood.

The system call enters the kernel and hits the **VFS (Virtual File System)** layer. VFS is the kernel's abstraction that provides a uniform interface to every mounted filesystem. ext4, XFS, Btrfs, NFS, procfs, devtmpfs, tmpfs - they all present the same operations to code above VFS. This layer defines a standard set of function pointers: `lookup`, `getattr`, `read`, `write`, `open`, `mkdir`, `unlink`, and dozens more. Each filesystem driver registers its own implementations.

> [!NOTE]
> **What is the Dentry cache?**
> The directory entry cache (dcache or dentry cache) is an in-memory kernel structure that speeds up path resolution. When you try to access `/home/user/app/config.json`, the kernel must translate that text string into an inode number by reading directories off the disk. This is slow. The dentry cache stores the results of these string-to-inode lookups in RAM. Subsequent accesses to the same path (or any part of it) hit the cache instead of the disk, making file operations dramatically faster.

When `stat()` arrives at VFS, the kernel first resolves the path. It walks through the **dentry cache** (directory entry cache), a hash table mapping (parent-directory, name) pairs to inodes in memory. If the dentry is cached - and for frequently accessed paths it usually is - resolution is a series of hash lookups with no disk I/O at all. If a dentry is missing from the cache, VFS calls the filesystem's `lookup` operation, which reads the directory data from disk (or from another cache layer) to find the inode number, then loads the inode.

Once VFS has the inode, it calls the filesystem's `getattr` operation. For ext4, this reads a 256-byte inode structure from the inode table on disk - or, more commonly, from the kernel's inode cache in memory. For XFS, the inode structure is 512 bytes. For NFS, a network RPC request goes to the remote server. For procfs, there is no disk at all.

And that's why `/proc` files report size 0. Procfs doesn't have real inodes with stored sizes. When VFS calls procfs's `getattr`, the procfs code returns a synthetic inode with `size = 0` because the actual content doesn't exist yet. The content gets generated by a registered callback function only when you actually `read()` the file. The kernel invokes that callback, the callback formats current kernel data structures into human-readable text, writes that text into a kernel buffer, and returns it to your process. The text exists only for the duration of the read. Before the read, the "content" is a function pointer. After the file handle closes, the buffer is freed.

Devtmpfs (which backs `/dev`) works similarly in some respects. `/dev/null` and `/dev/urandom` are character devices backed by kernel driver functions. When you `stat()` them, the kernel returns real inode metadata (character devices do have persistent inodes on devtmpfs), but the `size` field is 0 because character devices have no stored content. Their data is generated on demand by the driver's `read` function.

The VFS abstraction is what makes Node's `fs.stat()` work uniformly across all these backends. Whether the file lives on a local ext4 partition, an NFS mount, a procfs virtual entry, or a devtmpfs device node, the Stats object looks the same. VFS normalizes everything into the same inode/dentry model. The behavioral differences only surface during actual I/O: regular files have stable sizes, `/proc` files report size 0 but yield content, character devices may produce infinite data.

One performance note: stat is fast because it reads only metadata. The kernel maintains both the dentry cache and the inode cache in memory. For hot paths - files your process accesses regularly - `stat()` often completes without any disk I/O. Everything comes from kernel caches. That's why calling `stat()` on a 10GB file takes the same time as a 10-byte file. You're reading roughly 256 bytes of cached inode data, never the file content.

The return trip: VFS fills a `struct stat` in kernel space, the kernel copies it to user space (a context switch boundary), libuv's thread pool worker receives it and packs the fields into a `uv_stat_t` struct, the worker signals the event loop that the operation completed, Node's C++ binding reads that struct on the main thread and constructs a JavaScript Stats object with properties matching the C struct fields. By the time your callback fires, the kernel metadata has crossed four abstraction layers and landed as `stats.size`, `stats.mtimeMs`, `stats.mode` in your JavaScript.

