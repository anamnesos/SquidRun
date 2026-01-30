/**
 * Local Embedder Tests
 * Target: Full coverage of modules/local-embedder.js
 */

const EventEmitter = require('events');

// Create mock streams
function createMockStream() {
  const stream = new EventEmitter();
  stream.write = jest.fn((data, callback) => {
    if (callback) callback();
    return true;
  });
  return stream;
}

// Mock spawn to return controllable process
let mockProcess;
jest.mock('child_process', () => ({
  spawn: jest.fn(() => mockProcess),
}));

// Mock logger
jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { spawn } = require('child_process');
const log = require('../modules/logger');
const { createLocalEmbedder } = require('../modules/local-embedder');

describe('Local Embedder', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Setup mock process with event emitters
    mockProcess = {
      stdout: createMockStream(),
      stderr: createMockStream(),
      stdin: createMockStream(),
      kill: jest.fn(),
      on: jest.fn(),
    };

    // Setup process.on to capture exit handler
    mockProcess.on.mockImplementation((event, handler) => {
      if (event === 'exit') {
        mockProcess._exitHandler = handler;
      }
    });

    spawn.mockReturnValue(mockProcess);
  });

  describe('createLocalEmbedder', () => {
    test('creates embedder with default options', () => {
      const embedder = createLocalEmbedder();

      expect(embedder.model).toBe('all-MiniLM-L6-v2');
      expect(embedder.dim).toBe(384);
      expect(typeof embedder.embed).toBe('function');
      expect(typeof embedder.shutdown).toBe('function');
    });

    test('creates embedder with custom model', () => {
      const embedder = createLocalEmbedder({ model: 'custom-model' });

      expect(embedder.model).toBe('custom-model');
    });

    test('creates embedder with custom dimension', () => {
      const embedder = createLocalEmbedder({ dim: 768 });

      expect(embedder.dim).toBe(768);
    });

    test('creates embedder with custom python command', async () => {
      const embedder = createLocalEmbedder({ python: 'python3' });

      const embedPromise = embedder.embed('test');

      expect(spawn).toHaveBeenCalledWith(
        'python3',
        expect.any(Array),
        expect.any(Object)
      );

      // Cleanup - simulate success
      const response = JSON.stringify({ id: '1', vectors: [[0.1, 0.2]] }) + '\n';
      mockProcess.stdout.emit('data', response);
      await embedPromise;
    });

    test('creates embedder with custom script path', async () => {
      const embedder = createLocalEmbedder({ scriptPath: '/custom/path/embedder.py' });

      const embedPromise = embedder.embed('test');

      expect(spawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['/custom/path/embedder.py']),
        expect.any(Object)
      );

      // Cleanup
      const response = JSON.stringify({ id: '1', vectors: [[0.1, 0.2]] }) + '\n';
      mockProcess.stdout.emit('data', response);
      await embedPromise;
    });
  });

  describe('embed', () => {
    test('returns embedding vector for text', async () => {
      const embedder = createLocalEmbedder();
      const embedPromise = embedder.embed('hello world');

      // Process responds with embedding
      const response = JSON.stringify({ id: '1', vectors: [[0.1, 0.2, 0.3]] }) + '\n';
      mockProcess.stdout.emit('data', response);

      const result = await embedPromise;
      expect(result).toEqual([0.1, 0.2, 0.3]);
    });

    test('spawns process on first embed call', async () => {
      const embedder = createLocalEmbedder();

      expect(spawn).not.toHaveBeenCalled();

      const embedPromise = embedder.embed('test');

      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['--model', 'all-MiniLM-L6-v2']),
        expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] })
      );

      // Cleanup
      const response = JSON.stringify({ id: '1', vectors: [[0.1]] }) + '\n';
      mockProcess.stdout.emit('data', response);
      await embedPromise;
    });

    test('writes request to stdin', async () => {
      const embedder = createLocalEmbedder();
      const embedPromise = embedder.embed('test text');

      expect(mockProcess.stdin.write).toHaveBeenCalledWith(
        expect.stringContaining('"texts":["test text"]'),
        expect.any(Function)
      );

      // Cleanup
      const response = JSON.stringify({ id: '1', vectors: [[0.1]] }) + '\n';
      mockProcess.stdout.emit('data', response);
      await embedPromise;
    });

    test('handles multiple concurrent embed calls', async () => {
      const embedder = createLocalEmbedder();

      const promise1 = embedder.embed('text1');
      const promise2 = embedder.embed('text2');

      // Process responds to both
      mockProcess.stdout.emit('data', JSON.stringify({ id: '1', vectors: [[0.1]] }) + '\n');
      mockProcess.stdout.emit('data', JSON.stringify({ id: '2', vectors: [[0.2]] }) + '\n');

      const [result1, result2] = await Promise.all([promise1, promise2]);
      expect(result1).toEqual([0.1]);
      expect(result2).toEqual([0.2]);
    });

    test('handles response with error', async () => {
      const embedder = createLocalEmbedder();
      const embedPromise = embedder.embed('test');

      // Process responds with error
      mockProcess.stdout.emit('data', JSON.stringify({ id: '1', error: 'Model not found' }) + '\n');

      await expect(embedPromise).rejects.toThrow('Model not found');
    });

    test('updates dimension from response', async () => {
      const embedder = createLocalEmbedder();
      expect(embedder.dim).toBe(384);

      const embedPromise = embedder.embed('test');

      // Response includes new dimension
      mockProcess.stdout.emit('data', JSON.stringify({ id: '1', dim: 512, vectors: [[0.1]] }) + '\n');
      await embedPromise;

      expect(embedder.dim).toBe(512);
    });

    test('returns empty array when no vectors', async () => {
      const embedder = createLocalEmbedder();
      const embedPromise = embedder.embed('test');

      mockProcess.stdout.emit('data', JSON.stringify({ id: '1', vectors: [] }) + '\n');

      const result = await embedPromise;
      expect(result).toEqual([]);
    });

    test('returns empty array when vectors undefined', async () => {
      const embedder = createLocalEmbedder();
      const embedPromise = embedder.embed('test');

      mockProcess.stdout.emit('data', JSON.stringify({ id: '1' }) + '\n');

      const result = await embedPromise;
      expect(result).toEqual([]);
    });

    test('handles stdin write error', async () => {
      mockProcess.stdin.write.mockImplementation((data, callback) => {
        callback(new Error('Write failed'));
      });

      const embedder = createLocalEmbedder();
      const embedPromise = embedder.embed('test');

      await expect(embedPromise).rejects.toThrow('Write failed');
    });

    test('throws when embedder failed to start', async () => {
      spawn.mockImplementation(() => {
        throw new Error('Python not found');
      });

      const embedder = createLocalEmbedder();

      await expect(embedder.embed('test')).rejects.toThrow('Embedder process not started');
      expect(log.error).toHaveBeenCalledWith('Embeddings', 'Failed to spawn python embedder', expect.any(Error));
    });

    test('throws when embedder marked as failed', async () => {
      // First call causes failure
      spawn.mockImplementation(() => {
        throw new Error('Python not found');
      });

      const embedder = createLocalEmbedder();
      await expect(embedder.embed('test')).rejects.toThrow();

      // Reset spawn to work, but embedder should still refuse
      spawn.mockReturnValue(mockProcess);
      await expect(embedder.embed('second')).rejects.toThrow('Local embedder unavailable');
    });
  });

  describe('stdout parsing', () => {
    test('handles partial JSON responses', async () => {
      const embedder = createLocalEmbedder();
      const embedPromise = embedder.embed('test');

      // Send response in parts
      mockProcess.stdout.emit('data', '{"id":');
      mockProcess.stdout.emit('data', '"1","vectors":[[0.5');
      mockProcess.stdout.emit('data', ']]}\n');

      const result = await embedPromise;
      expect(result).toEqual([0.5]);
    });

    test('handles multiple responses in one data event', async () => {
      const embedder = createLocalEmbedder();

      const promise1 = embedder.embed('text1');
      const promise2 = embedder.embed('text2');

      // Both responses in one data event
      mockProcess.stdout.emit('data',
        JSON.stringify({ id: '1', vectors: [[0.1]] }) + '\n' +
        JSON.stringify({ id: '2', vectors: [[0.2]] }) + '\n'
      );

      const [result1, result2] = await Promise.all([promise1, promise2]);
      expect(result1).toEqual([0.1]);
      expect(result2).toEqual([0.2]);
    });

    test('skips empty lines', async () => {
      const embedder = createLocalEmbedder();
      const embedPromise = embedder.embed('test');

      mockProcess.stdout.emit('data', '\n\n' + JSON.stringify({ id: '1', vectors: [[0.1]] }) + '\n\n');

      const result = await embedPromise;
      expect(result).toEqual([0.1]);
    });

    test('handles malformed JSON gracefully', async () => {
      const embedder = createLocalEmbedder();
      const embedPromise = embedder.embed('test');

      // Send malformed JSON followed by valid
      mockProcess.stdout.emit('data', 'not json\n');
      expect(log.warn).toHaveBeenCalledWith('Embeddings', 'Failed to parse embedder response', expect.any(String));

      // Then send valid response
      mockProcess.stdout.emit('data', JSON.stringify({ id: '1', vectors: [[0.1]] }) + '\n');

      const result = await embedPromise;
      expect(result).toEqual([0.1]);
    });

    test('ignores responses for unknown ids', async () => {
      const embedder = createLocalEmbedder();
      const embedPromise = embedder.embed('test');

      // Response for unknown id
      mockProcess.stdout.emit('data', JSON.stringify({ id: '999', vectors: [[0.9]] }) + '\n');
      // Then correct response
      mockProcess.stdout.emit('data', JSON.stringify({ id: '1', vectors: [[0.1]] }) + '\n');

      const result = await embedPromise;
      expect(result).toEqual([0.1]);
    });
  });

  describe('stderr handling', () => {
    test('logs stderr output as warning', async () => {
      const embedder = createLocalEmbedder();
      embedder.embed('test'); // Start process

      mockProcess.stderr.emit('data', 'Warning: GPU not available\n');

      expect(log.warn).toHaveBeenCalledWith('Embeddings', 'Warning: GPU not available');
    });
  });

  describe('process exit handling', () => {
    test('handles clean exit (code 0)', async () => {
      const embedder = createLocalEmbedder();
      embedder.embed('test'); // Start process

      // Simulate clean exit
      mockProcess._exitHandler(0);

      // Next embed should restart process
      spawn.mockClear();
      const embedPromise = embedder.embed('test2');

      expect(spawn).toHaveBeenCalledTimes(1);

      // Cleanup
      mockProcess.stdout.emit('data', JSON.stringify({ id: '2', vectors: [[0.1]] }) + '\n');
      await embedPromise;
    });

    test('handles error exit and rejects pending', async () => {
      const embedder = createLocalEmbedder();
      const embedPromise = embedder.embed('test');

      // Simulate error exit
      mockProcess._exitHandler(1);

      await expect(embedPromise).rejects.toThrow('Embedder exited with code 1');
    });

    test('marks embedder as failed on error exit', async () => {
      const embedder = createLocalEmbedder();
      const embedPromise = embedder.embed('test');

      mockProcess._exitHandler(1);
      await expect(embedPromise).rejects.toThrow();

      // Subsequent calls should fail immediately
      await expect(embedder.embed('test2')).rejects.toThrow('Local embedder unavailable');
    });

    test('rejects all pending requests on error exit', async () => {
      const embedder = createLocalEmbedder();
      const promise1 = embedder.embed('text1');
      const promise2 = embedder.embed('text2');

      mockProcess._exitHandler(1);

      await expect(promise1).rejects.toThrow('Embedder exited with code 1');
      await expect(promise2).rejects.toThrow('Embedder exited with code 1');
    });
  });

  describe('shutdown', () => {
    test('kills process if running', () => {
      const embedder = createLocalEmbedder();
      embedder.embed('test'); // Start process

      embedder.shutdown();

      expect(mockProcess.kill).toHaveBeenCalled();
    });

    test('handles shutdown when no process running', () => {
      const embedder = createLocalEmbedder();

      // Should not throw
      expect(() => embedder.shutdown()).not.toThrow();
    });

    test('can be called multiple times', () => {
      const embedder = createLocalEmbedder();
      embedder.embed('test'); // Start process

      embedder.shutdown();
      embedder.shutdown(); // Second call

      // First call kills, second does nothing
      expect(mockProcess.kill).toHaveBeenCalledTimes(1);
    });
  });

  describe('environment variable handling', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    test('uses HIVEMIND_PYTHON env var', async () => {
      process.env.HIVEMIND_PYTHON = '/custom/python3.11';

      const embedder = createLocalEmbedder();
      const embedPromise = embedder.embed('test');

      expect(spawn).toHaveBeenCalledWith(
        '/custom/python3.11',
        expect.any(Array),
        expect.any(Object)
      );

      // Cleanup
      mockProcess.stdout.emit('data', JSON.stringify({ id: '1', vectors: [[0.1]] }) + '\n');
      await embedPromise;
    });
  });
});
