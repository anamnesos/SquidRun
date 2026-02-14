/**
 * Knowledge Graph IPC Handlers Tests
 * Target: Full coverage of modules/ipc/knowledge-graph-handlers.js
 */

const { registerKnowledgeGraphHandlers } = require('../modules/ipc/knowledge-graph-handlers');

// Mock the graph service module
jest.mock('../modules/knowledge/knowledge-graph-service', () => ({
  initialize: jest.fn(),
  queryGraph: jest.fn(),
  getGraphVisualization: jest.fn(),
  getGraphStats: jest.fn(),
  getRelatedNodes: jest.fn(),
  recordConcept: jest.fn(),
  saveGraph: jest.fn(),
  getNodesByType: jest.fn(),
}));

describe('Knowledge Graph IPC Handlers', () => {
  let mockIpcMain;
  let handlers;
  let mockGraphService;

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset module cache to test lazy loading
    jest.resetModules();

    handlers = {};
    mockIpcMain = {
      handle: jest.fn((channel, handler) => {
        handlers[channel] = handler;
      }),
    };

    // Re-require to get fresh mock
    mockGraphService = require('../modules/knowledge/knowledge-graph-service');
  });

  describe('registerKnowledgeGraphHandlers', () => {
    test('returns early if ipcMain is missing', () => {
      registerKnowledgeGraphHandlers({ WORKSPACE_PATH: '/test' });

      expect(mockIpcMain.handle).not.toHaveBeenCalled();
    });

    test('returns early if WORKSPACE_PATH is missing', () => {
      registerKnowledgeGraphHandlers({ ipcMain: mockIpcMain });

      expect(mockIpcMain.handle).not.toHaveBeenCalled();
    });

    test('throws if ctx is null', () => {
      expect(() => registerKnowledgeGraphHandlers(null)).toThrow();
    });

    test('registers all expected handlers', () => {
      registerKnowledgeGraphHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH: '/test' });

      expect(mockIpcMain.handle).toHaveBeenCalledWith('graph-query', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('graph-visualize', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('graph-stats', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('graph-related', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('graph-record-concept', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('graph-save', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('graph-nodes-by-type', expect.any(Function));
    });
  });

  describe('graph-query', () => {
    beforeEach(() => {
      registerKnowledgeGraphHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH: '/test' });
    });

    test('queries graph with default options', async () => {
      mockGraphService.queryGraph.mockReturnValue([{ id: 'node1', name: 'test' }]);

      const result = await handlers['graph-query']({}, {});

      expect(result.success).toBe(true);
      expect(result.results).toEqual([{ id: 'node1', name: 'test' }]);
      expect(mockGraphService.queryGraph).toHaveBeenCalledWith('', {
        maxDepth: 2,
        maxResults: 50,
        includeTypes: null,
      });
    });

    test('queries graph with custom options', async () => {
      mockGraphService.queryGraph.mockReturnValue([{ id: 'node2' }]);

      const result = await handlers['graph-query']({}, {
        query: 'trigger delivery',
        maxDepth: 3,
        maxResults: 100,
        includeTypes: ['concept', 'bug'],
      });

      expect(result.success).toBe(true);
      expect(mockGraphService.queryGraph).toHaveBeenCalledWith('trigger delivery', {
        maxDepth: 3,
        maxResults: 100,
        includeTypes: ['concept', 'bug'],
      });
    });

    test('handles query errors', async () => {
      mockGraphService.queryGraph.mockImplementation(() => {
        throw new Error('Query failed');
      });

      const result = await handlers['graph-query']({}, { query: 'test' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Query failed');
    });

    test('initializes graph service on first call', async () => {
      mockGraphService.queryGraph.mockReturnValue([]);

      await handlers['graph-query']({}, {});

      expect(mockGraphService.initialize).toHaveBeenCalledWith('/test');
    });
  });

  describe('graph-visualize', () => {
    beforeEach(() => {
      registerKnowledgeGraphHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH: '/test' });
    });

    test('returns visualization data with default filter', async () => {
      const vizData = { nodes: [], edges: [] };
      mockGraphService.getGraphVisualization.mockReturnValue(vizData);

      const result = await handlers['graph-visualize']({}, {});

      expect(result.success).toBe(true);
      expect(result.data).toEqual(vizData);
      expect(mockGraphService.getGraphVisualization).toHaveBeenCalledWith({});
    });

    test('returns visualization data with custom filter', async () => {
      const vizData = { nodes: [{ id: '1' }], edges: [] };
      mockGraphService.getGraphVisualization.mockReturnValue(vizData);

      const result = await handlers['graph-visualize']({}, { filter: { type: 'concept' } });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(vizData);
      expect(mockGraphService.getGraphVisualization).toHaveBeenCalledWith({ type: 'concept' });
    });

    test('handles visualization errors', async () => {
      mockGraphService.getGraphVisualization.mockImplementation(() => {
        throw new Error('Visualization failed');
      });

      const result = await handlers['graph-visualize']({}, {});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Visualization failed');
    });
  });

  describe('graph-stats', () => {
    beforeEach(() => {
      registerKnowledgeGraphHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH: '/test' });
    });

    test('returns graph statistics', async () => {
      const stats = { nodeCount: 100, edgeCount: 250, conceptCount: 50 };
      mockGraphService.getGraphStats.mockReturnValue(stats);

      const result = await handlers['graph-stats']({});

      expect(result.success).toBe(true);
      expect(result.stats).toEqual(stats);
      expect(mockGraphService.getGraphStats).toHaveBeenCalled();
    });

    test('handles stats errors', async () => {
      mockGraphService.getGraphStats.mockImplementation(() => {
        throw new Error('Stats unavailable');
      });

      const result = await handlers['graph-stats']({});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Stats unavailable');
    });
  });

  describe('graph-related', () => {
    beforeEach(() => {
      registerKnowledgeGraphHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH: '/test' });
    });

    test('returns error when nodeId is missing', async () => {
      const result = await handlers['graph-related']({}, {});

      expect(result.success).toBe(false);
      expect(result.error).toBe('nodeId required');
    });

    test('returns error when nodeId is null', async () => {
      const result = await handlers['graph-related']({}, { nodeId: null });

      expect(result.success).toBe(false);
      expect(result.error).toBe('nodeId required');
    });

    test('returns related nodes with default depth', async () => {
      const relatedNodes = [{ id: 'related1' }, { id: 'related2' }];
      mockGraphService.getRelatedNodes.mockReturnValue(relatedNodes);

      const result = await handlers['graph-related']({}, { nodeId: 'node1' });

      expect(result.success).toBe(true);
      expect(result.results).toEqual(relatedNodes);
      expect(mockGraphService.getRelatedNodes).toHaveBeenCalledWith('node1', 2);
    });

    test('returns related nodes with custom depth', async () => {
      mockGraphService.getRelatedNodes.mockReturnValue([]);

      const result = await handlers['graph-related']({}, { nodeId: 'node1', depth: 5 });

      expect(result.success).toBe(true);
      expect(mockGraphService.getRelatedNodes).toHaveBeenCalledWith('node1', 5);
    });

    test('handles related errors', async () => {
      mockGraphService.getRelatedNodes.mockImplementation(() => {
        throw new Error('Node not found');
      });

      const result = await handlers['graph-related']({}, { nodeId: 'invalid' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Node not found');
    });
  });

  describe('graph-record-concept', () => {
    beforeEach(() => {
      registerKnowledgeGraphHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH: '/test' });
    });

    test('returns error when name is missing', async () => {
      const result = await handlers['graph-record-concept']({}, {});

      expect(result.success).toBe(false);
      expect(result.error).toBe('name required');
    });

    test('returns error when name is null', async () => {
      const result = await handlers['graph-record-concept']({}, { name: null });

      expect(result.success).toBe(false);
      expect(result.error).toBe('name required');
    });

    test('returns error when name is empty string', async () => {
      const result = await handlers['graph-record-concept']({}, { name: '' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('name required');
    });

    test('records concept with defaults', async () => {
      mockGraphService.recordConcept.mockReturnValue('concept-123');

      const result = await handlers['graph-record-concept']({}, { name: 'Trigger System' });

      expect(result.success).toBe(true);
      expect(result.nodeId).toBe('concept-123');
      expect(mockGraphService.recordConcept).toHaveBeenCalledWith('Trigger System', '', []);
    });

    test('records concept with description and relations', async () => {
      mockGraphService.recordConcept.mockReturnValue('concept-456');

      const result = await handlers['graph-record-concept']({}, {
        name: 'Message Delivery',
        description: 'Handles delivering messages between agents',
        relatedTo: ['trigger-system', 'ipc-handlers'],
      });

      expect(result.success).toBe(true);
      expect(result.nodeId).toBe('concept-456');
      expect(mockGraphService.recordConcept).toHaveBeenCalledWith(
        'Message Delivery',
        'Handles delivering messages between agents',
        ['trigger-system', 'ipc-handlers']
      );
    });

    test('handles record errors', async () => {
      mockGraphService.recordConcept.mockImplementation(() => {
        throw new Error('Duplicate concept');
      });

      const result = await handlers['graph-record-concept']({}, { name: 'Existing' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Duplicate concept');
    });
  });

  describe('graph-save', () => {
    beforeEach(() => {
      registerKnowledgeGraphHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH: '/test' });
    });

    test('saves graph successfully', async () => {
      const result = await handlers['graph-save']({});

      expect(result.success).toBe(true);
      expect(mockGraphService.saveGraph).toHaveBeenCalled();
    });

    test('handles save errors', async () => {
      mockGraphService.saveGraph.mockImplementation(() => {
        throw new Error('Write permission denied');
      });

      const result = await handlers['graph-save']({});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Write permission denied');
    });
  });

  describe('graph-nodes-by-type', () => {
    beforeEach(() => {
      registerKnowledgeGraphHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH: '/test' });
    });

    test('returns error when type is missing', async () => {
      const result = await handlers['graph-nodes-by-type']({}, {});

      expect(result.success).toBe(false);
      expect(result.error).toBe('type required');
    });

    test('returns error when type is null', async () => {
      const result = await handlers['graph-nodes-by-type']({}, { type: null });

      expect(result.success).toBe(false);
      expect(result.error).toBe('type required');
    });

    test('returns error when type is empty string', async () => {
      const result = await handlers['graph-nodes-by-type']({}, { type: '' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('type required');
    });

    test('returns nodes of specified type', async () => {
      const nodes = [{ id: 'bug1', type: 'bug' }, { id: 'bug2', type: 'bug' }];
      mockGraphService.getNodesByType.mockReturnValue(nodes);

      const result = await handlers['graph-nodes-by-type']({}, { type: 'bug' });

      expect(result.success).toBe(true);
      expect(result.nodes).toEqual(nodes);
      expect(mockGraphService.getNodesByType).toHaveBeenCalledWith('bug');
    });

    test('returns empty array when no nodes of type exist', async () => {
      mockGraphService.getNodesByType.mockReturnValue([]);

      const result = await handlers['graph-nodes-by-type']({}, { type: 'nonexistent' });

      expect(result.success).toBe(true);
      expect(result.nodes).toEqual([]);
    });

    test('handles nodes-by-type errors', async () => {
      mockGraphService.getNodesByType.mockImplementation(() => {
        throw new Error('Invalid type');
      });

      const result = await handlers['graph-nodes-by-type']({}, { type: 'invalid' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid type');
    });
  });

  describe('lazy loading behavior', () => {
    test('only initializes graph service once across multiple handlers', async () => {
      registerKnowledgeGraphHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH: '/test' });

      mockGraphService.queryGraph.mockReturnValue([]);
      mockGraphService.getGraphStats.mockReturnValue({});
      mockGraphService.getGraphVisualization.mockReturnValue({});

      // Call multiple handlers
      await handlers['graph-query']({}, {});
      await handlers['graph-stats']({});
      await handlers['graph-visualize']({}, {});

      // Memory should only be initialized once
      expect(mockGraphService.initialize).toHaveBeenCalledTimes(1);
    });
  });
});
