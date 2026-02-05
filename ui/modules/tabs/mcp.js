/**
 * MCP Status Module
 * Handles MCP connection status for all agents
 */

const { ipcRenderer } = require('electron');

const mcpStatus = {
  '1': 'disconnected',
  '2': 'disconnected',
  '3': 'disconnected',
  '4': 'disconnected',
  '5': 'disconnected',
  '6': 'disconnected'
};

const MCP_AGENT_NAMES = {
  '1': 'Architect',
  '2': 'Orchestrator',
  '3': 'Implementer A',
  '4': 'Implementer B',
  '5': 'Investigator',
  '6': 'Reviewer'
};

function updateMCPAgentStatus(paneId, status) {
  // status: 'connected', 'disconnected', 'connecting', 'error'
  mcpStatus[paneId] = status;

  const dot = document.getElementById(`mcpDot${paneId}`);
  if (dot) {
    dot.className = `mcp-agent-dot ${status}`;
    const agentName = MCP_AGENT_NAMES[paneId] || `Pane ${paneId}`;
    dot.title = `${agentName}: ${status.charAt(0).toUpperCase() + status.slice(1)}`;
  }
}

function setupMCPStatus() {
  // Listen for MCP status events from backend
  ipcRenderer.on('mcp-status-changed', (event, data) => {
    if (data && data.paneId) {
      updateMCPAgentStatus(data.paneId, data.status);
    }
  });

  // Initial load
  ipcRenderer.invoke('get-all-mcp-status').then(result => {
    if (result && result.status) {
      Object.entries(result.status).forEach(([paneId, status]) => {
        updateMCPAgentStatus(paneId, status);
      });
    }
  }).catch(() => {});
}

module.exports = {
  setupMCPStatus,
  updateMCPAgentStatus
};
