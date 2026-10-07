const crypto = require('crypto');
const net = require('net');
const tls = require('tls');

const INCOMPLETE = Symbol('incomplete');

const encodeCommand = (args) => {
  const chunks = [`*${args.length}\r\n`];
  for (const value of args) {
    const text = String(value);
    const bytes = Buffer.byteLength(text);
    chunks.push(`$${bytes}\r\n${text}\r\n`);
  }
  return chunks.join('');
};

const findLineEnd = (buffer, offset) => {
  for (let index = offset; index < buffer.length - 1; index += 1) {
    if (buffer[index] === 13 && buffer[index + 1] === 10) return index;
  }
  return -1;
};

const parseResp = (buffer, offset = 0) => {
  if (offset >= buffer.length) return INCOMPLETE;
  const prefix = String.fromCharCode(buffer[offset]);
  const lineEnd = findLineEnd(buffer, offset + 1);
  if (lineEnd < 0) return INCOMPLETE;
  const line = buffer.subarray(offset + 1, lineEnd).toString('utf8');
  const next = lineEnd + 2;

  if (prefix === '+') return { value: line, offset: next };
  if (prefix === '-') return { value: Object.assign(new Error(line), { redis: true }), offset: next };
  if (prefix === ':') return { value: Number(line), offset: next };
  if (prefix === '$') {
    const length = Number(line);
    if (length === -1) return { value: null, offset: next };
    const end = next + length;
    if (buffer.length < end + 2) return INCOMPLETE;
    return { value: buffer.subarray(next, end).toString('utf8'), offset: end + 2 };
  }
  if (prefix === '*') {
    const length = Number(line);
    if (length === -1) return { value: null, offset: next };
    const values = [];
    let cursor = next;
    for (let index = 0; index < length; index += 1) {
      const parsed = parseResp(buffer, cursor);
      if (parsed === INCOMPLETE) return INCOMPLETE;
      values.push(parsed.value);
      cursor = parsed.offset;
    }
    return { value: values, offset: cursor };
  }

  throw new Error(`Unsupported Redis RESP prefix: ${prefix}`);
};

class RedisConnection {
  constructor(url, { commandTimeoutMs = 2000 } = {}) {
    this.url = new URL(url);
    if (!['redis:', 'rediss:'].includes(this.url.protocol)) {
      throw new Error('RATE_LIMIT_REDIS_URL must use redis:// or rediss://.');
    }
    this.commandTimeoutMs = commandTimeoutMs;
    this.socket = null;
    this.connecting = null;
    this.buffer = Buffer.alloc(0);
    this.current = null;
    this.tail = Promise.resolve();
  }

  async connect() {
    if (this.socket && !this.socket.destroyed) return;
    if (this.connecting) return this.connecting;

    this.connecting = new Promise((resolve, reject) => {
      const options = {
        host: this.url.hostname,
        port: Number(this.url.port || 6379),
      };
      const socket = this.url.protocol === 'rediss:'
        ? tls.connect({ ...options, servername: this.url.hostname })
        : net.createConnection(options);

      const onConnect = () => {
        cleanup();
        socket.setNoDelay(true);
        this.socket = socket;
        this.buffer = Buffer.alloc(0);
        socket.on('data', (chunk) => this.onData(chunk));
        socket.on('error', (error) => this.onSocketFailure(error));
        socket.on('close', () => this.onSocketFailure(new Error('Redis connection closed.')));
        resolve();
      };
      const onError = (error) => {
        cleanup();
        socket.destroy();
        reject(error);
      };
      const cleanup = () => {
        socket.off('connect', onConnect);
        socket.off('secureConnect', onConnect);
        socket.off('error', onError);
      };

      if (this.url.protocol === 'rediss:') socket.once('secureConnect', onConnect);
      else socket.once('connect', onConnect);
      socket.once('error', onError);
    }).finally(() => {
      this.connecting = null;
    });

    return this.connecting;
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (!this.current) return;

    let parsed;
    try {
      parsed = parseResp(this.buffer);
    } catch (error) {
      this.finishCurrent(error);
      return;
    }
    if (parsed === INCOMPLETE) return;

    this.buffer = this.buffer.subarray(parsed.offset);
    if (parsed.value instanceof Error) this.finishCurrent(parsed.value);
    else this.finishCurrent(null, parsed.value);
  }

  onSocketFailure(error) {
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    if (this.current) this.finishCurrent(error);
  }

  finishCurrent(error, value) {
    const pending = this.current;
    if (!pending) return;
    this.current = null;
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve(value);
  }

  command(args) {
    const task = this.tail.then(async () => {
      await this.connect();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const error = new Error('Redis rate-limit command timed out.');
          this.socket?.destroy(error);
          if (this.current) this.finishCurrent(error);
        }, this.commandTimeoutMs);
        timer.unref?.();

        this.current = { resolve, reject, timer };
        this.socket.write(encodeCommand(args), (error) => {
          if (error && this.current) this.finishCurrent(error);
        });
      });
    });

    this.tail = task.catch(() => {});
    return task;
  }

  async ping() {
    return this.command(['PING']);
  }

  close() {
    this.socket?.destroy();
    this.socket = null;
  }
}

const RATE_LIMIT_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {current, ttl}
`;

const hashKey = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

const createRedisRateLimitStore = ({ url, connection } = {}) => {
  const redisUrl = String(url || '').trim();
  if (!connection && !redisUrl) throw new Error('RATE_LIMIT_REDIS_URL is required.');
  const client = connection || new RedisConnection(redisUrl);

  return {
    kind: 'redis',
    async consume(key, windowMs) {
      const redisKey = `rate-limit:${hashKey(key)}`;
      const result = await client.command([
        'EVAL',
        RATE_LIMIT_SCRIPT,
        '1',
        redisKey,
        String(Math.max(1, Math.trunc(windowMs))),
      ]);
      if (!Array.isArray(result) || result.length < 2) {
        throw new Error('Unexpected Redis rate-limit response.');
      }
      const count = Number(result[0]);
      const ttlMs = Math.max(1, Number(result[1]));
      if (!Number.isFinite(count) || !Number.isFinite(ttlMs)) {
        throw new Error('Invalid Redis rate-limit response.');
      }
      return { count, resetAt: Date.now() + ttlMs };
    },
    async ping() {
      return client.ping();
    },
    close() {
      client.close();
    },
  };
};

const createMemoryRateLimitStore = () => {
  const buckets = new Map();
  let operations = 0;

  return {
    kind: 'memory',
    async consume(key, windowMs) {
      const now = Date.now();
      operations += 1;
      if (operations % 250 === 0) {
        for (const [bucketKey, bucket] of buckets.entries()) {
          if (bucket.resetAt <= now) buckets.delete(bucketKey);
        }
      }

      let bucket = buckets.get(key);
      if (!bucket || bucket.resetAt <= now) {
        bucket = { count: 0, resetAt: now + windowMs };
        buckets.set(key, bucket);
      }
      bucket.count += 1;
      return { count: bucket.count, resetAt: bucket.resetAt };
    },
    async ping() {
      return 'PONG';
    },
    close() {},
  };
};

let sharedStore;

const getRateLimitStore = () => {
  if (sharedStore) return sharedStore;
  const url = String(process.env.RATE_LIMIT_REDIS_URL || '').trim();
  const required = String(process.env.RATE_LIMIT_REDIS_REQUIRED || '').toLowerCase() === 'true';

  if (url) {
    sharedStore = createRedisRateLimitStore({ url });
    return sharedStore;
  }
  if (required) {
    throw new Error('RATE_LIMIT_REDIS_URL is required when RATE_LIMIT_REDIS_REQUIRED=true.');
  }

  sharedStore = createMemoryRateLimitStore();
  return sharedStore;
};

const warmRateLimitStore = async () => {
  const store = getRateLimitStore();
  const pong = await store.ping();
  return { kind: store.kind, pong };
};

const resetRateLimitStoreForTests = () => {
  sharedStore?.close?.();
  sharedStore = null;
};

module.exports = {
  RedisConnection,
  createRedisRateLimitStore,
  createMemoryRateLimitStore,
  getRateLimitStore,
  warmRateLimitStore,
  resetRateLimitStoreForTests,
  parseResp,
  encodeCommand,
};
