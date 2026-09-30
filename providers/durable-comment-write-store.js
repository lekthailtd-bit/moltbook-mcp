import { randomUUID } from 'crypto';
import {
  mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync,
  openSync, closeSync, unlinkSync, statSync, chmodSync,
} from 'fs';
import { join } from 'path';

const DEFAULT_DIR = join(process.env.HOME || '/tmp', '.config', 'moltbook', 'comment-writes');
const LOCK_STALE_MS = 5 * 60 * 1000;

/**
 * Durable store for logical comment-write intents.
 *
 * Intents are intentionally never auto-pruned. Removing an old ambiguous OR
 * published intent would make the same logical write recreatable on a later
 * heartbeat, defeating retry idempotency. Any future cleanup must be explicit
 * and reconciliation-aware.
 */
export function createDurableCommentWriteStore(baseDir = process.env.MOLTBOOK_COMMENT_WRITE_DIR || DEFAULT_DIR) {
  const intentsDir = join(baseDir, 'intents');
  const locksDir = join(baseDir, 'locks');

  function ensure() {
    mkdirSync(intentsDir, { recursive: true, mode: 0o700 });
    mkdirSync(locksDir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(baseDir, 0o700);
      chmodSync(intentsDir, 0o700);
      chmodSync(locksDir, 0o700);
    } catch {}
  }

  function file(key) {
    return join(intentsDir, `${key}.json`);
  }

  function load(key) {
    ensure();
    try { return JSON.parse(readFileSync(file(key), 'utf8')); }
    catch { return null; }
  }

  function save(intent) {
    ensure();
    const dest = file(intent.key);
    const tmp = `${dest}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(intent, null, 2), { mode: 0o600 });
    renameSync(tmp, dest);
    try { chmodSync(dest, 0o600); } catch {}
  }

  function list() {
    ensure();
    return readdirSync(intentsDir)
      .filter(name => name.endsWith('.json'))
      .map(name => {
        try { return JSON.parse(readFileSync(join(intentsDir, name), 'utf8')); }
        catch { return null; }
      })
      .filter(Boolean);
  }

  function findByVerificationCode(code) {
    return list().find(intent => intent.verification_code === code) || null;
  }

  function acquire(key) {
    ensure();
    const lockPath = join(locksDir, `${key}.lock`);
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      writeFileSync(fd, `${process.pid}\n${Date.now()}\n`);
      return () => {
        try { closeSync(fd); } catch {}
        try { unlinkSync(lockPath); } catch {}
      };
    } catch (err) {
      if (err?.code !== 'EEXIST') return null;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lockPath);
          return acquire(key);
        }
      } catch {}
      return null;
    }
  }

  return { load, save, list, findByVerificationCode, acquire };
}
