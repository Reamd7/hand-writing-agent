/**
 * FileMutationQueue: serialize concurrent writes to the same file.
 *
 * When an agent runs multiple tool calls in parallel, two edit operations
 * may target the same file simultaneously. Without serialization this causes
 * lost-update bugs (read-modify-write race). The queue chains operations
 * targeting the same resolved path while letting operations on different
 * files run fully in parallel.
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";

// ── Queue state ──────────────────────────────────────────────────────

/**
 * Map from canonical file path to the tail of the promise chain.
 * Each entry represents the "last pending operation" for that file.
 */
const fileMutationQueues = new Map<string, Promise<void>>();

// ── Path canonicalization ────────────────────────────────────────────

/**
 * Resolve a file path to a canonical key for the queue map.
 *
 * 1. `resolve()` turns relative paths into absolute.
 * 2. `realpathSync.native()` resolves symlinks to the true on-disk path,
 *    so `./link-to-file` and `./real-file` share the same queue.
 * 3. If the file doesn't exist yet (write creating a new file),
 *    `realpathSync` throws -- fall back to the resolved path.
 */
function getMutationQueueKey(filePath: string): string {
  const resolvedPath = resolve(filePath);
  try {
    return realpathSync.native(resolvedPath);
  } catch {
    return resolvedPath;
  }
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Run `fn` with exclusive access to `filePath`.
 *
 * Operations targeting different files run in parallel.
 * Operations targeting the same file run sequentially in FIFO order.
 *
 * Implementation: each call appends a new link to a per-file promise chain.
 *
 * ```
 * caller A                        caller B (same file, arrives during A)
 * --------                        --------
 * currentQueue = resolved         currentQueue = chainedQueueA (pending)
 * await currentQueue  (instant)   await currentQueue  (blocks until A done)
 * fn() runs ...                   ...waiting...
 * releaseA()                      fn() runs ...
 *                                 releaseB()
 * ```
 */
export async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const key = getMutationQueueKey(filePath);

  // Get the current tail of the queue (or an already-resolved promise).
  const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();

  // Create a new promise that we control. This becomes the new tail.
  let releaseNext!: () => void;
  const nextQueue = new Promise<void>((resolveQueue) => {
    releaseNext = resolveQueue;
  });

  // Chain: the new tail resolves only after currentQueue AND our nextQueue.
  const chainedQueue = currentQueue.then(() => nextQueue);
  fileMutationQueues.set(key, chainedQueue);

  // Wait for all operations ahead of us to finish.
  await currentQueue;

  try {
    return await fn();
  } finally {
    // Signal the next waiter (if any) that we're done.
    releaseNext();

    // If nobody else has appended after us, clean up the map entry.
    if (fileMutationQueues.get(key) === chainedQueue) {
      fileMutationQueues.delete(key);
    }
  }
}
