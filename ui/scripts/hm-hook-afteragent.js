const fs = require('fs');
const path = require('path');

// Read input from stdin
let input = '';
process.stdin.on('data', chunk => {
  input += chunk;
});

process.stdin.on('end', () => {
  try {
    const payload = JSON.parse(input);
    const logDir = path.join(process.cwd(), '.squidrun', 'logs');
    
    // Ensure log directory exists
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    
    // Write audit log
    fs.appendFileSync(
      path.join(logDir, 'agent-audit.log'),
      `${new Date().toISOString()} - Agent turn complete\n`
    );
    
    // Hooks must return a JSON object to stdout
    console.log(JSON.stringify({ status: 'success', handled: true }));
  } catch (error) {
    console.error(`Hook error: ${error.message}`);
    // Return safe empty object on error so we don't break the CLI
    console.log(JSON.stringify({ status: 'error', message: error.message }));
  }
});