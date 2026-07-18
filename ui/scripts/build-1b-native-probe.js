'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { createRequire } = require('module');
const os = require('os');
const path = require('path');

function toText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function parseArgs(argv = []) {
  const options = {
    expectCommit: null,
    output: null,
    resourcesPath: null,
    timeoutMs: 15_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--expect-commit') {
      options.expectCommit = toText(argv[index + 1]);
      index += 1;
    } else if (token === '--output') {
      options.output = toText(argv[index + 1]);
      index += 1;
    } else if (token === '--resources-path') {
      options.resourcesPath = toText(argv[index + 1]);
      index += 1;
    } else if (token === '--timeout-ms') {
      options.timeoutMs = Number(argv[index + 1]);
      index += 1;
    } else if (token === '--help' || token === '-h') {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${token}`);
    }
  }
  if (options.expectCommit && !/^[0-9a-f]{7,40}$/i.test(options.expectCommit)) {
    throw new Error('--expect-commit must be a 7-40 character git object id');
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1_000 || options.timeoutMs > 120_000) {
    throw new Error('--timeout-ms must be between 1000 and 120000');
  }
  return options;
}

function usage() {
  console.log([
    'Usage (PowerShell):',
    '  $env:ELECTRON_RUN_AS_NODE=\'1\'',
    '  .\\SquidRun.exe -e "require(\'./resources/app.asar/scripts/build-1b-native-probe\').runCli(process.argv.slice(1))" -- [options]',
    '',
    'Run with ELECTRON_RUN_AS_NODE=1 against an unpacked packaged application.',
    '',
    'Options:',
    '  --expect-commit <sha>  Required checkout/package provenance label',
    '  --output <path>        Required JSON receipt output path',
    '  --resources-path <dir> Target packaged resources directory (for signed Electron seam)',
    '  --timeout-ms <ms>      PTY timeout (default 15000)',
  ].join('\n'));
}

function serializeError(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error),
    stack: error?.stack || null,
  };
}

async function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

function isNativeArtifact(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/').toLowerCase();
  return normalized.endsWith('.node') || normalized.endsWith('/vec0.dll');
}

function inventoryNativeArtifacts(rootPath) {
  if (!rootPath || !fs.existsSync(rootPath)) return [];
  const found = [];
  const pending = [path.resolve(rootPath)];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
      } else if (entry.isFile() && isNativeArtifact(fullPath)) {
        found.push({
          relativePath: path.relative(rootPath, fullPath).replace(/\\/g, '/'),
          bytes: fs.statSync(fullPath).size,
        });
      }
    }
  }
  return found.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function probePty(timeoutMs, packageRequire) {
  try {
    const pty = packageRequire('node-pty');
    const shell = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
    const marker = `BUILD_1B_PTY_${process.pid}_${Date.now()}`;
    const output = await new Promise((resolve, reject) => {
      let settled = false;
      let text = '';
      const terminal = pty.spawn(shell, ['/d', '/s', '/c', `echo ${marker}`], {
        name: 'xterm-color',
        cols: 80,
        rows: 24,
        cwd: os.tmpdir(),
        env: { ...process.env },
      });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { terminal.kill(); } catch {}
        reject(new Error(`node-pty timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      terminal.onData((chunk) => { text += chunk; });
      terminal.onExit(({ exitCode, signal }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ text, exitCode, signal });
      });
    });
    return {
      ok: output.exitCode === 0 && output.text.includes(marker),
      shell,
      markerObserved: output.text.includes(marker),
      exitCode: output.exitCode,
      signal: output.signal,
      output: output.text,
    };
  } catch (error) {
    return { ok: false, error: serializeError(error) };
  }
}

function probeBaseSqlite(packageRequire) {
  let db = null;
  try {
    const sqliteCompat = packageRequire('./modules/sqlite-compat');
    db = sqliteCompat.openDatabase(':memory:', { allowExtension: true });
    const row = db.prepare('select 40 + 2 as answer').get();
    return {
      ok: row?.answer === 42,
      backend: sqliteCompat.getBackend(),
      answer: row?.answer ?? null,
    };
  } catch (error) {
    return { ok: false, error: serializeError(error) };
  } finally {
    try { db?.close(); } catch {}
  }
}

function probeSqliteVec(resourcesPath, packageRequire) {
  let db = null;
  try {
    const sqliteCompat = packageRequire('./modules/sqlite-compat');
    const vec = packageRequire('sqlite-vec');
    db = sqliteCompat.openDatabase(':memory:', { allowExtension: true });
    const resolvedPath = vec.getLoadablePath();
    const physicalPath = path.join(
      resourcesPath,
      'app.asar.unpacked',
      'node_modules',
      'sqlite-vec-windows-x64',
      'vec0.dll',
    );
    try {
      vec.load(db);
      const row = db.prepare('select vec_version() as version').get();
      return {
        ok: Boolean(row?.version),
        version: row?.version || null,
        resolvedPath,
        resolvedPathExists: fs.existsSync(resolvedPath),
        physicalPath,
        physicalPathExists: fs.existsSync(physicalPath),
      };
    } catch (error) {
      return {
        ok: false,
        resolvedPath,
        resolvedPathExists: fs.existsSync(resolvedPath),
        physicalPath,
        physicalPathExists: fs.existsSync(physicalPath),
        error: serializeError(error),
      };
    }
  } catch (error) {
    return { ok: false, error: serializeError(error) };
  } finally {
    try { db?.close(); } catch {}
  }
}

async function probeSharp(packageRequire) {
  try {
    const sharp = packageRequire('sharp');
    const output = await sharp({
      create: {
        width: 1,
        height: 1,
        channels: 4,
        background: { r: 12, g: 34, b: 56, alpha: 1 },
      },
    }).png().toBuffer();
    const metadata = await sharp(output).metadata();
    return {
      ok: output.length > 0 && metadata.width === 1 && metadata.height === 1,
      bytes: output.length,
      width: metadata.width,
      height: metadata.height,
      format: metadata.format,
    };
  } catch (error) {
    return { ok: false, error: serializeError(error) };
  }
}

function probeOnnx(packageRequire) {
  try {
    const ort = packageRequire('onnxruntime-node');
    const tensor = new ort.Tensor('float32', Float32Array.from([1, 2, 3, 4]), [2, 2]);
    return {
      ok: tensor.type === 'float32'
        && tensor.dims.join('x') === '2x2'
        && Array.from(tensor.data).join(',') === '1,2,3,4',
      type: tensor.type,
      dims: tensor.dims,
      data: Array.from(tensor.data),
    };
  } catch (error) {
    return { ok: false, error: serializeError(error) };
  }
}

async function runProbe(options) {
  if (!options.expectCommit) throw new Error('--expect-commit is required');
  if (!options.output) throw new Error('--output is required');
  const hostExecutablePath = process.execPath;
  const resourcesPath = options.resourcesPath
    ? path.resolve(options.resourcesPath)
    : (process.resourcesPath || path.join(path.dirname(hostExecutablePath), 'resources'));
  const packageRoot = path.dirname(resourcesPath);
  const targetExecutablePath = path.join(packageRoot, 'SquidRun.exe');
  const asarPath = path.join(resourcesPath, 'app.asar');
  const unpackedPath = path.join(resourcesPath, 'app.asar.unpacked');
  const packageModuleBase = path.join(asarPath, 'package.json');
  const packageRequire = createRequire(packageModuleBase);
  const probes = {
    pty: await probePty(options.timeoutMs, packageRequire),
    sqlite: probeBaseSqlite(packageRequire),
    sqliteVec: probeSqliteVec(resourcesPath, packageRequire),
    sharp: await probeSharp(packageRequire),
    onnx: probeOnnx(packageRequire),
  };
  const receipt = {
    schema: 'squidrun.build1b.native_probe.v0',
    capturedAt: new Date().toISOString(),
    expectedCommit: options.expectCommit,
    runtime: {
      hostExecPath: hostExecutablePath,
      resourcesPath,
      cwd: process.cwd(),
      platform: process.platform,
      arch: process.arch,
      versions: process.versions,
    },
    package: {
      root: packageRoot,
      targetExecutablePath,
      targetExecutableSha256: await hashFile(targetExecutablePath),
      hostExecutableSha256: await hashFile(hostExecutablePath),
      asarPath,
      asarSha256: await hashFile(asarPath),
      moduleBase: packageModuleBase,
      unpackedPath,
      nativeInventory: inventoryNativeArtifacts(unpackedPath),
    },
    probes,
    ok: Object.values(probes).every((probe) => probe.ok === true),
  };
  const outputPath = path.resolve(options.output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  return { ...receipt, outputPath };
}

async function runCli(argv = []) {
  const options = parseArgs(argv);
  if (options.help) {
    usage();
    return;
  }
  const result = await runProbe(options);
  console.log(JSON.stringify({
    ok: result.ok,
    outputPath: result.outputPath,
    expectedCommit: result.expectedCommit,
    probes: Object.fromEntries(
      Object.entries(result.probes).map(([name, probe]) => [name, probe.ok]),
    ),
  }, null, 2));
  if (!result.ok) process.exitCode = 1;
}

async function main() {
  return runCli(process.argv.slice(2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[build-1b-native-probe] ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  hashFile,
  inventoryNativeArtifacts,
  isNativeArtifact,
  parseArgs,
  runCli,
  runProbe,
  serializeError,
};
