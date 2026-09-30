// Suite-wide Preload Guard for Isolated Stack
// Ensures ZERO connections to production PostgreSQL (5432) or production Redis (6379)

import net from 'node:net';

function enforceIsolation() {
  const allowedPgPort = 5433;
  const allowedRedisPort = 6380;
  const forbiddenPorts = [5432, 6379];

  // 1. Check environment variables
  const pgUrls = [process.env.POSTGRES_URL, process.env.DISPOSABLE_POSTGRES_URL].filter(Boolean);
  for (const raw of pgUrls) {
    try {
      const u = new URL(raw);
      const port = Number(u.port) || 5432;
      if (port === 5432 || forbiddenPorts.includes(port) || port !== allowedPgPort) {
        console.error(`\n[FATAL SUITE-WIDE GUARD] Aborting: Forbidden PostgreSQL target port ${port} detected in environment (${u.hostname}:${port}${u.pathname})!`);
        process.exit(1);
      }
    } catch (e) {
      if (e.message?.includes('FATAL')) throw e;
    }
  }

  const redisUrls = [process.env.REDIS_URL, process.env.DISPOSABLE_REDIS_URL].filter(Boolean);
  for (const raw of redisUrls) {
    try {
      const u = new URL(raw);
      const port = Number(u.port) || 6379;
      if (port === 6379 || forbiddenPorts.includes(port) || port !== allowedRedisPort) {
        console.error(`\n[FATAL SUITE-WIDE GUARD] Aborting: Forbidden Redis target port ${port} detected in environment (${u.hostname}:${port})!`);
        process.exit(1);
      }
    } catch (e) {
      if (e.message?.includes('FATAL')) throw e;
    }
  }

  // 2. Intercept low-level net.Socket.prototype.connect to physically block sockets to 5432 and 6379
  const origConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    let port = 0;
    let host = '';

    if (typeof args[0] === 'object' && args[0] !== null) {
      port = Number(args[0].port) || 0;
      host = String(args[0].host || args[0].hostname || '');
    } else if (typeof args[0] === 'number') {
      port = args[0];
      if (typeof args[1] === 'string') host = args[1];
    }

    if (forbiddenPorts.includes(port)) {
      const err = new Error(`[FATAL SUITE-WIDE GUARD] Refusing low-level TCP connection to forbidden production port ${port} (${host || 'localhost'})!`);
      console.error(err.message);
      this.destroy(err);
      process.exit(1);
    }

    return origConnect.apply(this, args);
  };
}

enforceIsolation();
