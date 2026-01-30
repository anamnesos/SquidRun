/**
 * Local embeddings via Python sentence-transformers subprocess.
 * Shared utility for RAG + memory systems.
 */

const path = require('path');
const { spawn } = require('child_process');
const log = require('./logger');

const DEFAULT_MODEL = 'all-MiniLM-L6-v2';
const DEFAULT_DIM = 384;

function createLocalEmbedder(options = {}) {
  const model = options.model || DEFAULT_MODEL;
  const pythonCmd = options.python || process.env.HIVEMIND_PYTHON || 'python';
  const scriptPath = options.scriptPath || path.join(__dirname, '..', 'scripts', 'local_embedder.py');
  let dim = options.dim || DEFAULT_DIM;

  let proc = null;
  let buffer = '';
  let nextId = 1;
  let failed = false;
  const pending = new Map();

  function start() {
    if (proc || failed) return;
    try {
      proc = spawn(pythonCmd, [scriptPath, '--model', model], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      failed = true;
      log.error('Embeddings', 'Failed to spawn python embedder', err);
      return;
    }

    proc.stdout.on('data', (data) => {
      buffer += data.toString();
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          const req = pending.get(msg.id);
          if (!req) continue;
          pending.delete(msg.id);
          if (msg.error) {
            req.reject(new Error(msg.error));
            continue;
          }
          if (msg.dim) dim = msg.dim;
          const vectors = msg.vectors || [];
          req.resolve(vectors[0] || []);
        } catch (err) {
          log.warn('Embeddings', 'Failed to parse embedder response', err.message);
        }
      }
    });

    proc.stderr.on('data', (data) => {
      log.warn('Embeddings', data.toString().trim());
    });

    proc.on('exit', (code) => {
      proc = null;
      if (code !== 0) {
        failed = true;
        const err = new Error(`Embedder exited with code ${code}`);
        for (const req of pending.values()) {
          req.reject(err);
        }
        pending.clear();
      }
    });
  }

  async function embed(text) {
    if (failed) {
      throw new Error('Local embedder unavailable');
    }
    if (!proc) start();
    if (!proc) {
      throw new Error('Embedder process not started');
    }

    const id = String(nextId++);
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      const payload = JSON.stringify({ id, texts: [text] });
      proc.stdin.write(payload + '\n', (err) => {
        if (err) {
          pending.delete(id);
          reject(err);
        }
      });
    });
  }

  function shutdown() {
    if (proc) {
      proc.kill();
      proc = null;
    }
  }

  return {
    embed,
    shutdown,
    get dim() { return dim; },
    model,
  };
}

module.exports = { createLocalEmbedder };
