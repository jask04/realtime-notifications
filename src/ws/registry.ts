/**
 * In-memory map of userId → set of connected socket ids.
 *
 * One user can have many concurrent connections (laptop + phone + a second
 * browser tab), so the value side is a Set, not a single id.
 *
 * Limited to this process: with multiple API replicas, each only knows
 * about the sockets it's hosting. The Socket.io Redis adapter handles
 * cross-node fan-out for `io.emit`, but presence checks like "is this
 * user online anywhere?" would need a Redis-backed registry. Single-replica
 * deploys are unaffected.
 */
const userToSockets = new Map<string, Set<string>>();
const socketToUser = new Map<string, string>();

export function add(userId: string, socketId: string): void {
  let sockets = userToSockets.get(userId);
  if (!sockets) {
    sockets = new Set();
    userToSockets.set(userId, sockets);
  }
  sockets.add(socketId);
  socketToUser.set(socketId, userId);
}

export function remove(socketId: string): void {
  const userId = socketToUser.get(socketId);
  if (!userId) return;
  socketToUser.delete(socketId);

  const sockets = userToSockets.get(userId);
  if (!sockets) return;
  sockets.delete(socketId);
  if (sockets.size === 0) {
    userToSockets.delete(userId);
  }
}

export function getSockets(userId: string): string[] {
  const sockets = userToSockets.get(userId);
  return sockets ? Array.from(sockets) : [];
}

export function isOnline(userId: string): boolean {
  const sockets = userToSockets.get(userId);
  return sockets !== undefined && sockets.size > 0;
}

/**
 * Test-only escape hatch: drop all connections without going through the
 * usual disconnect flow. Useful for `beforeEach` in integration tests.
 */
export function clear(): void {
  userToSockets.clear();
  socketToUser.clear();
}

export function size(): { users: number; sockets: number } {
  return { users: userToSockets.size, sockets: socketToUser.size };
}
