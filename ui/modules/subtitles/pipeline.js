'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const { getProjectRoot, resolveCoordPath } = require('../../config');
const baseLogger = require('../logger');
const log = typeof baseLogger.scope === 'function' ? baseLogger.scope('SubtitlePipeline') : baseLogger;
const { DEFAULT_OLLAMA_BASE_URL, fetchJson } = require('../local-model-capabilities');

const execFileAsync = promisify(execFile);
const DEFAULT_TRANSLATION_MODEL = 'exaone3.5:32b';
const DEFAULT_ASR_MODEL = 'small';
const DEFAULT_SOURCE_LANGUAGE = 'en';
const DEFAULT_TARGET_LANGUAGE = 'ko';
const DEFAULT_OLLAMA_TIMEOUT_MS = 120_000;
const DEFAULT_CPS_TARGET = 15;
const DEFAULT_LINE_LIMIT = 18;
const DEFAULT_MAX_LINES = 2;
const DEFAULT_MIN_DURATION = 1.0;
const DEFAULT_MAX_DURATION = 7.0;
const DEFAULT_MIN_GAP = 0.1;
const DEFAULT_LEAD_IN = 0.12;
const DEFAULT_TAIL_OUT = 0.18;
const DEFAULT_MERGE_GAP_THRESHOLD = 0.35;
const DEFAULT_RUNTIME_ROOT = resolveCoordPath(path.join('runtime', 'subtitles'), { forWrite: true });
const PYTHON_LAUNCHER = 'py';
const PYTHON_VERSION = '-3.12';
const CUDA_PYTORCH_INDEX_URL = 'https://download.pytorch.org/whl/cu128';
const CUDA_PYTORCH_PACKAGES = ['torch', 'torchaudio'];
const CUDA_CTRANSLATE2_SPEC = 'ctranslate2>=4.7.0,<5';
const PYTHON_ENV_BOOTSTRAP_VERSION = 'subtitle-pipeline-v2';

function toText(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  return filePath;
}

function fileExists(targetPath) {
  try {
    fs.accessSync(targetPath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'subtitle-job';
}

function parseArgs(argv = []) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const flags = {};
  const positionals = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i] || '');
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next && !String(next).startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return { flags, positionals };
}

function resolveVideoPath(inputPath) {
  const projectRoot = getProjectRoot();
  const resolved = path.resolve(projectRoot, String(inputPath || ''));
  if (!fileExists(resolved)) {
    throw new Error(`video_not_found:${resolved}`);
  }
  return resolved;
}

function formatTimestamp(seconds) {
  const totalMs = Math.max(0, Math.round(toNumber(seconds, 0) * 1000));
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const secs = Math.floor((totalMs % 60_000) / 1000);
  const millis = totalMs % 1000;
  return [
    String(hours).padStart(2, '0'),
    String(minutes).padStart(2, '0'),
    String(secs).padStart(2, '0'),
  ].join(':') + `,${String(millis).padStart(3, '0')}`;
}

function resolveWingetFFmpegBinary(binaryName = 'ffmpeg.exe') {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return null;
  const packagesDir = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages');
  if (!fileExists(packagesDir)) return null;
  const packageDirs = fs.readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.toLowerCase().includes('ffmpeg'))
    .map((entry) => path.join(packagesDir, entry.name));
  for (const packageDir of packageDirs) {
    const directCandidate = path.join(packageDir, 'bin', binaryName);
    if (fileExists(directCandidate)) return directCandidate;
    const nested = fs.readdirSync(packageDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(packageDir, entry.name, 'bin', binaryName))
      .find((candidate) => fileExists(candidate));
    if (nested) return nested;
  }
  return null;
}

function resolveBinary(binaryName, envVarName) {
  const explicit = toText(process.env[envVarName]);
  if (explicit && fileExists(explicit)) return explicit;
  const fromWinget = resolveWingetFFmpegBinary(`${binaryName}.exe`);
  if (fromWinget) return fromWinget;
  return binaryName;
}

function buildWorkerEnv() {
  const env = { ...process.env };
  const ffmpegPath = resolveBinary('ffmpeg', 'SQUIDRUN_FFMPEG_PATH');
  if (ffmpegPath && ffmpegPath !== 'ffmpeg' && fileExists(ffmpegPath)) {
    env.SQUIDRUN_FFMPEG_PATH = ffmpegPath;
    env.PATH = `${path.dirname(ffmpegPath)}${path.delimiter}${env.PATH || ''}`;
  }
  return env;
}

function resolveJobContext(videoPath, options = {}) {
  const runtimeRoot = options.runtimeRoot || DEFAULT_RUNTIME_ROOT;
  const baseName = path.parse(videoPath).name;
  const jobId = `${slugify(baseName)}-${crypto.randomBytes(3).toString('hex')}`;
  const jobRoot = ensureDir(path.join(runtimeRoot, 'jobs', jobId));
  return {
    jobId,
    jobRoot,
    audioPath: path.join(jobRoot, `${baseName}.wav`),
    transcriptPath: path.join(jobRoot, `${baseName}.transcript.json`),
    translatedPath: path.join(jobRoot, `${baseName}.translated.json`),
    srtPath: options.outputPath || path.join(path.dirname(videoPath), `${baseName}.ko.srt`),
  };
}

async function ensurePythonEnv(options = {}) {
  const envRoot = options.pythonEnvRoot || ensureDir(path.join(DEFAULT_RUNTIME_ROOT, 'venv'));
  const pythonPath = path.join(envRoot, 'Scripts', 'python.exe');
  const requirementsPath = path.join(getProjectRoot(), 'tools', 'subtitles', 'requirements.txt');
  const stampPath = path.join(envRoot, '.requirements.stamp');
  const requirementsText = fs.readFileSync(requirementsPath, 'utf8');
  const requirementsHash = crypto.createHash('sha256')
    .update(requirementsText)
    .update(`\n${PYTHON_ENV_BOOTSTRAP_VERSION}\n`)
    .digest('hex');

  if (!fileExists(pythonPath)) {
    log.info(`Creating Python 3.12 venv at ${envRoot}`);
    await execFileAsync(PYTHON_LAUNCHER, [PYTHON_VERSION, '-m', 'venv', envRoot], {
      cwd: getProjectRoot(),
      env: buildWorkerEnv(),
      windowsHide: true,
      timeout: 300_000,
    });
  }

  const currentStamp = fileExists(stampPath) ? fs.readFileSync(stampPath, 'utf8').trim() : '';
  if (currentStamp !== requirementsHash || options.forceBootstrap === true) {
    log.info('Installing subtitle worker Python dependencies');
    await execFileAsync(pythonPath, ['-m', 'pip', 'install', '--upgrade', 'pip'], {
      cwd: getProjectRoot(),
      env: buildWorkerEnv(),
      windowsHide: true,
      timeout: 600_000,
    });
    await execFileAsync(pythonPath, ['-m', 'pip', 'install', '-r', requirementsPath], {
      cwd: getProjectRoot(),
      env: buildWorkerEnv(),
      windowsHide: true,
      timeout: 1_800_000,
    });
    if (await hasNvidiaGpu()) {
      try {
        await installCudaAccelerationPackages(pythonPath);
      } catch (error) {
        log.warn(`CUDA subtitle bootstrap failed, keeping CPU fallback: ${error.message}`);
      }
    }
    fs.writeFileSync(stampPath, `${requirementsHash}\n`);
  }

  return {
    envRoot,
    pythonPath,
  };
}

async function hasNvidiaGpu() {
  try {
    const { stdout } = await execFileAsync('nvidia-smi', ['-L'], {
      cwd: getProjectRoot(),
      windowsHide: true,
      timeout: 15_000,
    });
    return /\bGPU\b/i.test(stdout || '');
  } catch {
    return false;
  }
}

async function installCudaAccelerationPackages(pythonPath) {
  log.info('Configuring CUDA-enabled subtitle worker packages');
  await execFileAsync(pythonPath, [
    '-m', 'pip', 'install',
    '--upgrade',
    '--force-reinstall',
    ...CUDA_PYTORCH_PACKAGES,
    '--index-url', CUDA_PYTORCH_INDEX_URL,
  ], {
    cwd: getProjectRoot(),
    env: buildWorkerEnv(),
    windowsHide: true,
    timeout: 1_800_000,
  });
  await execFileAsync(pythonPath, [
    '-m', 'pip', 'install',
    '--upgrade',
    CUDA_CTRANSLATE2_SPEC,
  ], {
    cwd: getProjectRoot(),
    env: buildWorkerEnv(),
    windowsHide: true,
    timeout: 600_000,
  });
}

async function extractAudio(videoPath, audioPath, options = {}) {
  const ffmpegPath = resolveBinary('ffmpeg', 'SQUIDRUN_FFMPEG_PATH');
  ensureDir(path.dirname(audioPath));
  await execFileAsync(ffmpegPath, [
    '-y',
    '-i', videoPath,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-c:a', 'pcm_s16le',
    audioPath,
  ], {
    cwd: getProjectRoot(),
    windowsHide: true,
    timeout: Math.max(60_000, toNumber(options.timeoutMs, 600_000)),
  });
  return audioPath;
}

async function transcribeAudio(audioPath, transcriptPath, options = {}) {
  const workerPath = path.join(getProjectRoot(), 'tools', 'subtitles', 'subtitle_worker.py');
  const python = options.pythonPath;
  if (!python) {
    throw new Error('python_path_required');
  }
  await execFileAsync(python, [
    workerPath,
    'transcribe',
    '--audio-path', audioPath,
    '--output-path', transcriptPath,
    '--model', options.asrModel || DEFAULT_ASR_MODEL,
    '--language', options.sourceLanguage || DEFAULT_SOURCE_LANGUAGE,
    '--align',
  ], {
    cwd: getProjectRoot(),
    env: buildWorkerEnv(),
    windowsHide: true,
    timeout: Math.max(120_000, toNumber(options.timeoutMs, 1_800_000)),
  });
  return readJson(transcriptPath);
}

function chunkSegments(segments = [], options = {}) {
  const maxSegments = Math.max(1, toNumber(options.maxSegments, 12));
  const maxChars = Math.max(400, toNumber(options.maxChars, 2_400));
  const chunks = [];
  let current = [];
  let charCount = 0;

  for (const segment of segments) {
    const segmentText = toText(segment.text);
    if (!segmentText) continue;
    const projected = charCount + segmentText.length;
    if (current.length >= maxSegments || projected > maxChars) {
      chunks.push(current);
      current = [];
      charCount = 0;
    }
    current.push(segment);
    charCount += segmentText.length;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    const firstBrace = String(text || '').indexOf('{');
    const lastBrace = String(text || '').lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return JSON.parse(String(text).slice(firstBrace, lastBrace + 1));
    }
    throw new Error('invalid_json_response');
  }
}

async function runOllamaJson(prompt, options = {}) {
  const baseUrl = toText(options.baseUrl, DEFAULT_OLLAMA_BASE_URL);
  const model = toText(options.model, DEFAULT_TRANSLATION_MODEL);
  const timeoutMs = Math.max(30_000, toNumber(options.timeoutMs, DEFAULT_OLLAMA_TIMEOUT_MS));
  const response = await fetchJson(`${baseUrl}/api/generate`, {
    timeoutMs,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      stream: false,
      format: 'json',
      prompt,
    }),
  });
  return safeJsonParse(response?.response || response);
}

function buildFaithfulTranslationPrompt(segments = [], options = {}) {
  return [
    'You translate subtitle segments from English to Korean.',
    'Return JSON only.',
    'Return an object with one key: segments.',
    'Each segment must have exactly: id, translatedText.',
    'Keep meaning faithful.',
    'Do not merge or drop segments.',
    'Use natural Korean, but do not aggressively rewrite yet.',
    'Do not transliterate English words when a natural Korean translation exists.',
    'Keep personal names as names, but translate greetings and common phrases naturally.',
    `Target language: ${options.targetLanguage || DEFAULT_TARGET_LANGUAGE}`,
    JSON.stringify({
      segments: segments.map((segment) => ({
        id: segment.id,
        text: segment.text,
        start: segment.start,
        end: segment.end,
      })),
    }),
  ].join('\n');
}

function buildSubtitleRewritePrompt(segments = [], options = {}) {
  return [
    'You rewrite Korean subtitle draft segments for subtitle readability.',
    'Return JSON only.',
    'Return an object with one key: segments.',
    'Each segment must have exactly: id, subtitleText.',
    'Rules:',
    '- Keep the same segment ids.',
    '- Preserve meaning.',
    '- Prefer natural Korean subtitle phrasing.',
    '- Choose a consistent informal/plain spoken tone unless the source clearly demands honorific speech.',
    '- Do not repeat the same sentence twice.',
    '- Do not pad or explain.',
    `- Keep subtitles concise and suitable for about ${options.cpsTarget || DEFAULT_CPS_TARGET} characters per second.`,
    `- Prefer at most 2 lines and about ${options.lineLimit || DEFAULT_LINE_LIMIT} characters per line when possible.`,
    '- Insert line breaks with \\n when helpful.',
    JSON.stringify({
      segments: segments.map((segment) => ({
        id: segment.id,
        sourceText: segment.text,
        koreanDraft: segment.translatedText,
        start: segment.start,
        end: segment.end,
      })),
    }),
  ].join('\n');
}

function mapSegmentsById(items = [], keyName) {
  return new Map(
    items
      .map((item) => ({
        id: toNumber(item?.id, -1),
        value: toText(item?.[keyName]),
      }))
      .filter((item) => item.id >= 0 && item.value)
      .map((item) => [item.id, item.value])
  );
}

function splitLongToken(token, lineLimit) {
  const parts = [];
  let cursor = toText(token);
  while (cursor.length > lineLimit) {
    parts.push(cursor.slice(0, lineLimit));
    cursor = cursor.slice(lineLimit);
  }
  if (cursor) parts.push(cursor);
  return parts;
}

function wrapSubtitleLine(text, lineLimit = DEFAULT_LINE_LIMIT, maxLines = DEFAULT_MAX_LINES) {
  const raw = toText(text).replace(/\r/g, '').trim();
  if (!raw) return '';
  const sourceLines = raw.split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (
    sourceLines.length > 1
    && sourceLines.length <= maxLines
    && sourceLines.every((line) => line.length <= lineLimit)
  ) {
    return sourceLines.join('\n');
  }
  const tokens = [];
  for (const sourceLine of sourceLines.length ? sourceLines : [raw]) {
    const words = sourceLine.split(' ').filter(Boolean);
    if (words.length === 0) continue;
    for (const word of words) {
      if (word.length > lineLimit) {
        tokens.push(...splitLongToken(word, lineLimit));
      } else {
        tokens.push(word);
      }
    }
  }
  const lines = [];
  let current = '';
  for (const token of tokens) {
    const candidate = current ? `${current} ${token}` : token;
    if (candidate.length > lineLimit && current) {
      lines.push(current);
      current = token;
      if (lines.length >= maxLines - 1) break;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines
    .slice(0, maxLines)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

function sanitizeSubtitleText(candidate, fallback = '') {
  const normalized = toText(candidate).replace(/\r/g, '').trim();
  const fallbackText = toText(fallback).replace(/\r/g, '').trim();
  if (!normalized) return fallbackText;
  if (!fallbackText) return normalized;

  const compact = normalized.replace(/\s+/g, ' ');
  const compactFallback = fallbackText.replace(/\s+/g, ' ');
  if (compact === compactFallback) return normalized;
  if (compact.includes(compactFallback) && compact.length > (compactFallback.length + 12)) {
    return fallbackText;
  }
  if (normalized.split('\n').length > 2) {
    return fallbackText;
  }
  if (normalized.length > Math.max(48, Math.round(compactFallback.length * 1.6))) {
    return fallbackText;
  }
  return normalized;
}

function countReadingChars(text = '') {
  return toText(text).replace(/\s+/g, '').length;
}

function measureSubtitleText(text = '') {
  const normalized = toText(text).replace(/\r/g, '').trim();
  const lines = normalized
    ? normalized.split('\n').map((line) => line.trim()).filter(Boolean)
    : [];
  return {
    lines,
    lineCount: lines.length,
    maxLineChars: lines.reduce((max, line) => Math.max(max, line.length), 0),
    readingChars: countReadingChars(normalized),
  };
}

function mergeSubtitleTexts(left, right) {
  const first = toText(left).replace(/\s+/g, ' ').trim();
  const second = toText(right).replace(/\s+/g, ' ').trim();
  if (!first) return second;
  if (!second) return first;
  return `${first} ${second}`.replace(/\s+/g, ' ').trim();
}

function optimizeSubtitleSegments(segments = [], options = {}) {
  const lineLimit = Math.max(10, toNumber(options.lineLimit, DEFAULT_LINE_LIMIT));
  const cpsTarget = Math.max(8, toNumber(options.cpsTarget, DEFAULT_CPS_TARGET));
  const maxLines = Math.max(1, toNumber(options.maxLines, DEFAULT_MAX_LINES));
  const minDuration = Math.max(0.5, toNumber(options.minDuration, DEFAULT_MIN_DURATION));
  const maxDuration = Math.max(minDuration, toNumber(options.maxDuration, DEFAULT_MAX_DURATION));
  const minGap = Math.max(0, toNumber(options.minGap, DEFAULT_MIN_GAP));
  const leadIn = Math.max(0, toNumber(options.leadIn, DEFAULT_LEAD_IN));
  const tailOut = Math.max(0, toNumber(options.tailOut, DEFAULT_TAIL_OUT));
  const mergeGapThreshold = Math.max(minGap, toNumber(options.mergeGapThreshold, DEFAULT_MERGE_GAP_THRESHOLD));

  const prepared = segments
    .map((segment, index) => {
      const rawText = toText(segment.subtitleText || segment.translatedText || segment.text);
      const body = wrapSubtitleLine(rawText, lineLimit, maxLines);
      const metrics = measureSubtitleText(body);
      return {
        ...segment,
        id: toNumber(segment.id, index),
        subtitleText: body,
        rawText,
        speechStart: toNumber(segment.start, 0),
        speechEnd: Math.max(toNumber(segment.end, 0), toNumber(segment.start, 0)),
        readingChars: metrics.readingChars,
        lineCount: metrics.lineCount,
        maxLineChars: metrics.maxLineChars,
      };
    })
    .filter((segment) => segment.subtitleText);

  const merged = [];
  for (const segment of prepared) {
    const previous = merged[merged.length - 1];
    if (!previous) {
      merged.push({ ...segment });
      continue;
    }

    const gap = Math.max(0, segment.speechStart - previous.speechEnd);
    const previousDuration = Math.max(0.001, previous.speechEnd - previous.speechStart);
    const currentDuration = Math.max(0.001, segment.speechEnd - segment.speechStart);
    const combinedText = mergeSubtitleTexts(previous.rawText, segment.rawText);
    const combinedBody = wrapSubtitleLine(combinedText, lineLimit, maxLines);
    const combinedMetrics = measureSubtitleText(combinedBody);
    const shouldMerge = gap <= mergeGapThreshold
      && combinedMetrics.lineCount <= maxLines
      && combinedMetrics.maxLineChars <= lineLimit
      && Math.max(minDuration, combinedMetrics.readingChars / cpsTarget) <= maxDuration
      && (
        previousDuration < minDuration
        || currentDuration < minDuration
        || (previous.readingChars / previousDuration) > (cpsTarget * 1.1)
        || (segment.readingChars / currentDuration) > (cpsTarget * 1.1)
      );

    if (!shouldMerge) {
      merged.push({ ...segment });
      continue;
    }

    previous.speechEnd = Math.max(previous.speechEnd, segment.speechEnd);
    previous.rawText = combinedText;
    previous.subtitleText = combinedBody;
    previous.readingChars = combinedMetrics.readingChars;
    previous.lineCount = combinedMetrics.lineCount;
    previous.maxLineChars = combinedMetrics.maxLineChars;
  }

  let previousEnd = 0;
  return merged.map((segment, index) => {
    const next = merged[index + 1];
    const earliestStart = index === 0
      ? Math.max(0, segment.speechStart - leadIn)
      : Math.max(previousEnd + minGap, segment.speechStart - leadIn);
    const targetDuration = Math.min(
      maxDuration,
      Math.max(minDuration, segment.readingChars / cpsTarget)
    );
    const idealEnd = Math.max(segment.speechEnd + tailOut, earliestStart + minDuration);
    const latestEnd = next
      ? Math.max(earliestStart + minGap, next.speechStart - minGap)
      : Math.max(idealEnd, earliestStart + maxDuration);

    let start = earliestStart;
    let end = Math.max(idealEnd, start + targetDuration);

    if (end > latestEnd) {
      const overflow = end - latestEnd;
      start = Math.max(index === 0 ? 0 : previousEnd + minGap, start - overflow);
      end = Math.max(segment.speechEnd + tailOut, start + targetDuration);
    }

    end = Math.min(end, latestEnd);
    if ((end - start) < minDuration) {
      end = Math.min(latestEnd, Math.max(end, start + minDuration));
      if ((end - start) < minDuration) {
        start = Math.max(index === 0 ? 0 : previousEnd + minGap, end - minDuration);
      }
    }

    if ((end - start) > maxDuration) {
      end = start + maxDuration;
    }

    const tuned = {
      ...segment,
      start: Number(start.toFixed(3)),
      end: Number(Math.max(start + 0.001, end).toFixed(3)),
      duration: Number(Math.max(0, end - start).toFixed(3)),
      targetDuration: Number(targetDuration.toFixed(3)),
      readingCps: Number((segment.readingChars / Math.max(0.001, end - start)).toFixed(2)),
    };
    previousEnd = tuned.end;
    return tuned;
  });
}

function formatSrt(segments = [], options = {}) {
  const lineLimit = Math.max(10, toNumber(options.lineLimit, DEFAULT_LINE_LIMIT));
  return segments
    .filter((segment) => toText(segment.subtitleText || segment.translatedText || segment.text))
    .map((segment, index) => {
      const body = wrapSubtitleLine(
        segment.subtitleText || segment.translatedText || segment.text,
        lineLimit,
        Math.max(1, toNumber(options.maxLines, DEFAULT_MAX_LINES))
      );
      return [
        String(index + 1),
        `${formatTimestamp(segment.start)} --> ${formatTimestamp(segment.end)}`,
        body,
        '',
      ].join('\n');
    })
    .join('\n');
}

async function translateSegments(segments = [], options = {}) {
  const chunks = chunkSegments(segments, options);
  const translated = [];

  for (const chunk of chunks) {
    const pass1 = await runOllamaJson(buildFaithfulTranslationPrompt(chunk, options), {
      model: options.translationModel || DEFAULT_TRANSLATION_MODEL,
      baseUrl: options.ollamaBaseUrl || DEFAULT_OLLAMA_BASE_URL,
      timeoutMs: options.translationTimeoutMs || DEFAULT_OLLAMA_TIMEOUT_MS,
    });
    const pass1Map = mapSegmentsById(pass1?.segments || [], 'translatedText');
    const pass1Segments = chunk.map((segment) => ({
      ...segment,
      translatedText: pass1Map.get(segment.id) || segment.text,
    }));

    const pass2 = await runOllamaJson(buildSubtitleRewritePrompt(pass1Segments, options), {
      model: options.translationModel || DEFAULT_TRANSLATION_MODEL,
      baseUrl: options.ollamaBaseUrl || DEFAULT_OLLAMA_BASE_URL,
      timeoutMs: options.translationTimeoutMs || DEFAULT_OLLAMA_TIMEOUT_MS,
    });
    const pass2Map = mapSegmentsById(pass2?.segments || [], 'subtitleText');

    translated.push(...pass1Segments.map((segment) => ({
      ...segment,
      subtitleText: sanitizeSubtitleText(
        pass2Map.get(segment.id) || segment.translatedText,
        segment.translatedText
      ),
    })));
  }

  return translated;
}

async function runSubtitlePipeline(options = {}) {
  const videoPath = resolveVideoPath(options.videoPath);
  const job = resolveJobContext(videoPath, options);
  const pythonEnv = await ensurePythonEnv(options);

  log.info(`Starting subtitle job ${job.jobId} for ${videoPath}`);
  await extractAudio(videoPath, job.audioPath, options);
  const transcript = await transcribeAudio(job.audioPath, job.transcriptPath, {
    ...options,
    pythonPath: pythonEnv.pythonPath,
  });
  const translatedSegments = await translateSegments(transcript.segments || [], options);
  const subtitleSegments = optimizeSubtitleSegments(translatedSegments, options);
  writeJson(job.translatedPath, {
    ...transcript,
    translatedSegments,
    subtitleSegments,
    translationModel: options.translationModel || DEFAULT_TRANSLATION_MODEL,
  });
  const srt = formatSrt(subtitleSegments, options);
  ensureDir(path.dirname(job.srtPath));
  fs.writeFileSync(job.srtPath, srt, 'utf8');

  const result = {
    jobId: job.jobId,
    videoPath,
    audioPath: job.audioPath,
    transcriptPath: job.transcriptPath,
    translatedPath: job.translatedPath,
    outputPath: job.srtPath,
    segments: subtitleSegments.length,
    sourceSegments: translatedSegments.length,
    translationModel: options.translationModel || DEFAULT_TRANSLATION_MODEL,
    asrModel: options.asrModel || DEFAULT_ASR_MODEL,
    alignmentUsed: transcript.alignmentUsed === true,
  };
  writeJson(path.join(job.jobRoot, 'result.json'), result);
  log.info(`Subtitle job ${job.jobId} complete -> ${job.srtPath}`);
  return result;
}

module.exports = {
  DEFAULT_ASR_MODEL,
  DEFAULT_CPS_TARGET,
  DEFAULT_LINE_LIMIT,
  DEFAULT_MAX_DURATION,
  DEFAULT_MAX_LINES,
  DEFAULT_MIN_DURATION,
  DEFAULT_MIN_GAP,
  DEFAULT_SOURCE_LANGUAGE,
  DEFAULT_TARGET_LANGUAGE,
  DEFAULT_TRANSLATION_MODEL,
  chunkSegments,
  ensurePythonEnv,
  formatSrt,
  formatTimestamp,
  measureSubtitleText,
  optimizeSubtitleSegments,
  parseArgs,
  resolveBinary,
  resolveJobContext,
  resolveVideoPath,
  runSubtitlePipeline,
  sanitizeSubtitleText,
  translateSegments,
  wrapSubtitleLine,
};
