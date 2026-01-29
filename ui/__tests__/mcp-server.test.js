/**
 * Tests for mcp-server.js tool handlers
 */

const path = require('path');
const { WORKSPACE_PATH } = require('../config');

let serverInstance;

const mockFileStore = new Map();
const mockDirStore = new Set();

jest.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: class MockServer {
    constructor() {
      this.handlers = new Map();
      serverInstance = this;
    }
    setRequestHandler(schema, handler) {
      this.handlers.set(schema, handler);
    }
    connect() {
      return Promise.resolve();
    }
  },
}));

jest.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class MockTransport {},
}));

jest.mock('@modelcontextprotocol/sdk/types.js', () => ({
  CallToolRequestSchema: 'call',
  ListToolsRequestSchema: 'list',
}));

jest.mock('fs', () => ({
  existsSync: jest.fn((p) => mockFileStore.has(p) || mockDirStore.has(p)),
  readFileSync: jest.fn((p) => {
    if (!mockFileStore.has(p)) {
      throw new Error('ENOENT');
    }
    return mockFileStore.get(p);
  }),
  writeFileSync: jest.fn((p, data) => {
    mockFileStore.set(p, data);
  }),
  appendFileSync: jest.fn((p, data) => {
    const prev = mockFileStore.get(p) || '';
    mockFileStore.set(p, prev + data);
  }),
  renameSync: jest.fn((from, to) => {
    mockFileStore.set(to, mockFileStore.get(from));
    mockFileStore.delete(from);
  }),
  mkdirSync: jest.fn((p) => {
    mockDirStore.add(p);
  }),
}));

describe('mcp-server tool handlers', () => {
  const originalArgv = process.argv;
  const originalExit = process.exit;

  beforeEach(() => {
    mockFileStore.clear();
    mockDirStore.clear();
    serverInstance = null;
    process.argv = ['node', 'mcp-server.js', '--agent', 'implementer-b'];
    process.exit = jest.fn();

    jest.resetModules();
    jest.isolateModules(() => {
      require('../mcp-server');
    });
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exit = originalExit;
  });

  test('list tools exposes core MCP tools', async () => {
    const listHandler = serverInstance.handlers.get('list');
    const result = await listHandler();

    const toolNames = result.tools.map(tool => tool.name);
    expect(toolNames).toContain('send_message');
    expect(toolNames).toContain('get_messages');
    expect(toolNames).toContain('trigger_agent');
  });

  test('send_message writes to target queue', async () => {
    const callHandler = serverInstance.handlers.get('call');
    const result = await callHandler({
      params: {
        name: 'send_message',
        arguments: { to: 'implementer-a', content: 'Hello' },
      },
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);

    const queuePath = path.join(WORKSPACE_PATH, 'messages', 'queue-3.json');
    expect(mockFileStore.has(queuePath)).toBe(true);
    const messages = JSON.parse(mockFileStore.get(queuePath));
    expect(messages[0].content).toBe('Hello');
  });

  test('get_messages returns undelivered queue entries', async () => {
    const queuePath = path.join(WORKSPACE_PATH, 'messages', 'queue-4.json');
    const mockMessage = {
      id: 'msg-1',
      from: '1',
      fromRole: 'Architect',
      to: '4',
      toRole: 'Implementer B',
      content: 'Ping',
      timestamp: new Date().toISOString(),
      delivered: false,
    };
    mockFileStore.set(queuePath, JSON.stringify([mockMessage]));

    const callHandler = serverInstance.handlers.get('call');
    const result = await callHandler({
      params: {
        name: 'get_messages',
        arguments: { undelivered_only: true },
      },
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.count).toBe(1);
    expect(payload.messages[0].content).toBe('Ping');
  });

  test('trigger_agent writes trigger file', async () => {
    const callHandler = serverInstance.handlers.get('call');
    await callHandler({
      params: {
        name: 'trigger_agent',
        arguments: { agent: 'reviewer', context: 'Check status' },
      },
    });

    const triggerPath = path.join(WORKSPACE_PATH, 'triggers', 'reviewer.txt');
    expect(mockFileStore.has(triggerPath)).toBe(true);
    expect(mockFileStore.get(triggerPath)).toMatch(/IMPLEMENTER-B/);
  });
});
