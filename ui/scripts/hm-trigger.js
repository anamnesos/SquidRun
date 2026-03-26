const fs = require('fs');
const path = require('path');
const yargs = require('yargs');

const TRIGGERS_FILE = path.join(__dirname, '../../.squidrun/state/triggers.json');

function loadTriggers() {
    if (!fs.existsSync(TRIGGERS_FILE)) {
        return [];
    }
    try {
        return JSON.parse(fs.readFileSync(TRIGGERS_FILE, 'utf8'));
    } catch (e) {
        console.error("Error reading triggers:", e.message);
        return [];
    }
}

function saveTriggers(triggers) {
    const dir = path.dirname(TRIGGERS_FILE);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(TRIGGERS_FILE, JSON.stringify(triggers, null, 2));
}

yargs.scriptName("hm-trigger")
  .command('register <id> <condition> <dataSource> <payload>', 'Register a new exogenous trigger', (yargs) => {
    yargs.positional('id', {
      type: 'string',
      describe: 'Unique identifier for the trigger (e.g. oracle-vix-spike)'
    })
    .positional('condition', {
      type: 'string',
      describe: 'The evaluation logic string (e.g. "vix > 25")'
    })
    .positional('dataSource', {
      type: 'string',
      describe: 'The data stream or file to monitor'
    })
    .positional('payload', {
      type: 'string',
      describe: 'The context to inject into the agent upon activation'
    })
    .option('target', {
      type: 'string',
      description: 'The target agent to wake up (defaults to the authoring agent)',
      default: ''
    });
  }, function (argv) {
      const triggers = loadTriggers();

      const role = process.env.SQUIDRUN_ROLE ? process.env.SQUIDRUN_ROLE.toLowerCase() : 'unknown';
      if (role === 'unknown') {
          console.error("Error: SQUIDRUN_ROLE environment variable is not set. Cannot register trigger without author context.");
          process.exit(1);
      }

      const existingIndex = triggers.findIndex(t => t.id === argv.id);

      const targetAgent = argv.target || role;

      const newTrigger = {
          id: argv.id,
          author: role,
          target: targetAgent,
          condition: argv.condition,
          data_source: argv.dataSource,
          action_payload: argv.payload,
          status: 'active',
          created_at: new Date().toISOString()
      };

      if (existingIndex >= 0) {
          // Allow agents to overwrite their own triggers
          if (triggers[existingIndex].author !== role) {
              console.error(`Error: Cannot overwrite trigger ${argv.id} authored by ${triggers[existingIndex].author}.`);
              process.exit(1);
          }
          triggers[existingIndex] = newTrigger;
          console.log(`Updated trigger: ${argv.id}`);
      } else {
          triggers.push(newTrigger);
          console.log(`Registered new trigger: ${argv.id}`);
      }

      saveTriggers(triggers);
  })
  .command('list', 'List all active triggers', () => {}, (argv) => {
      const triggers = loadTriggers();
      if (triggers.length === 0) {
          console.log("No active triggers.");
          return;
      }
      console.log("\n=== EXOGENOUS TRIGGERS ===");
      triggers.forEach(t => {
          console.log(`[${t.id}] Status: ${t.status} | Author: ${t.author} | Target: ${t.target || t.author}`);
          console.log(`  Condition : ${t.condition}`);
          console.log(`  Source    : ${t.data_source}`);
          console.log(`  Payload   : ${t.action_payload.substring(0,50)}...`);
          console.log("");
      });
  })  .command('remove <id>', 'Remove a specific trigger', (yargs) => {
      yargs.positional('id', { type: 'string' });
  }, (argv) => {
      let triggers = loadTriggers();
      const role = process.env.SQUIDRUN_ROLE ? process.env.SQUIDRUN_ROLE.toLowerCase() : 'unknown';
      
      const targetIndex = triggers.findIndex(t => t.id === argv.id);
      if (targetIndex === -1) {
          console.error(`Error: Trigger ${argv.id} not found.`);
          process.exit(1);
      }

      if (triggers[targetIndex].author !== role) {
          console.error(`Error: Cannot remove trigger ${argv.id} authored by ${triggers[targetIndex].author}. Only the author can remove it.`);
          process.exit(1);
      }

      triggers = triggers.filter(t => t.id !== argv.id);
      saveTriggers(triggers);
      console.log(`Successfully removed trigger: ${argv.id}`);
  })
  .help()
  .argv;