const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const TRIGGERS_FILE = path.join(__dirname, '../../.squidrun/state/triggers.json');

// Extremely basic mock for evaluation
// In a real system, this would tail a live feed or query an SQLite DB.
const MOCK_DATA_FEED = {
    'vix': 26.8,
    'eth_price': 2150,
    'failed_tests': 0
};

function loadTriggers() {
    if (!fs.existsSync(TRIGGERS_FILE)) {
        return [];
    }
    try {
        return JSON.parse(fs.readFileSync(TRIGGERS_FILE, 'utf8'));
    } catch (e) {
        return [];
    }
}

function evaluateCondition(conditionStr, dataFeed) {
    // SECURITY WARNING: This is a highly simplified, insecure evaluator meant ONLY for the initial prototype.
    // Do NOT use eval() in production with untrusted strings. We will need a safe expression parser (like jsep) later.
    try {
        // Create a function context with the datafeed values
        const keys = Object.keys(dataFeed);
        const values = Object.values(dataFeed);
        const evaluator = new Function(...keys, `return ${conditionStr};`);
        return evaluator(...values);
    } catch (err) {
        console.error(`[Daemon] Error evaluating condition '${conditionStr}':`, err.message);
        return false;
    }
}

function activateAgent(trigger) {
    console.log(`[Daemon] FIRING TRIGGER: [${trigger.id}] targeting ${trigger.target}`);
    
    // Check if the trigger payload specifies an initiative proposal
    let isInitiative = false;
    let initiativeTitle = `Trigger Fired: ${trigger.id}`;
    let initiativeReason = `Auto-proposed by Daemon. Condition met: ${trigger.condition}`;
    
    try {
        const payloadObj = JSON.parse(trigger.action_payload);
        if (payloadObj.type === 'initiative') {
            isInitiative = true;
            if (payloadObj.title) initiativeTitle = payloadObj.title;
            if (payloadObj.reason) initiativeReason = payloadObj.reason;
        }
    } catch (e) {
        // Not JSON, or not an initiative type. Treat as a standard activation payload.
    }

    if (isInitiative) {
        // Execute hm-initiative.js
        const { exec } = require('child_process');
        
        // Escape quotes to prevent shell injection, though in a real system we'd use spawn with arguments array
        const safeTitle = initiativeTitle.replace(/"/g, '\\"');
        const safeReason = initiativeReason.replace(/"/g, '\\"');
        
        const cmd = `node ui/scripts/hm-initiative.js propose --role ${trigger.target} --title "${safeTitle}" --reason "${safeReason}" --priority high --scope global --tag trigger --tag exogenous`;
        
        console.log(`[Daemon] Auto-proposing initiative: ${cmd}`);
        
        exec(cmd, { cwd: path.join(__dirname, '../../') }, (error, stdout, stderr) => {
            if (error) {
                console.error(`[Daemon] Failed to propose initiative: ${error.message}`);
                return;
            }
            console.log(`[Daemon] Initiative Response: ${stdout.trim()}`);
        });

    } else {
        // Standard activation (mocked for now)
        const payload = JSON.stringify({
            source: 'trigger-daemon',
            trigger_id: trigger.id,
            reason: trigger.condition,
            payload: trigger.action_payload
        });
        console.log(`[Daemon] Executing standard activation: node ui/scripts/hm-activate.js ${trigger.target} '${payload}'`);
    }
    
    // Mark as dormant after firing to prevent infinite loops during prototype phase
    trigger.status = 'dormant';
}

// We need to initialize the Hyperliquid client asynchronously, so we wrap the daemon loop
async function startDaemon() {
    console.log("[Daemon] Exogenous Trigger Daemon started. Booting Hyperliquid connection...");
    
    let infoClient = null;
    try {
        const { HttpTransport, InfoClient } = await import('@nktkas/hyperliquid');
        const transport = new HttpTransport();
        infoClient = new InfoClient({ transport });
        console.log("[Daemon] Hyperliquid client connected.");
    } catch (e) {
        console.error("[Daemon] Failed to initialize Hyperliquid client:", e.message);
        console.log("[Daemon] Falling back to mocked data feed.");
    }

    async function tick() {
        const triggers = loadTriggers();
        let updated = false;
        
        let liveDataFeed = { ...MOCK_DATA_FEED };
        
        if (infoClient) {
            try {
                const mids = await infoClient.allMids();
                // Map the Hyperliquid mid prices into our data feed using lowercase keys (e.g. 'btc', 'eth')
                for (const [coin, priceStr] of Object.entries(mids)) {
                     liveDataFeed[coin.toLowerCase() + '_price'] = parseFloat(priceStr);
                }
            } catch (e) {
                console.error("[Daemon] Failed to fetch live prices:", e.message);
            }
        }

        triggers.forEach(trigger => {
            if (trigger.status !== 'active') return;

            let condition = trigger.condition.toLowerCase();

            const isTrue = evaluateCondition(condition, liveDataFeed);
            
            if (isTrue) {
                activateAgent(trigger);
                updated = true;
            }
        });

        if (updated) {
            fs.writeFileSync(TRIGGERS_FILE, JSON.stringify(triggers, null, 2));
        }
    }

    // Poll every 15 seconds for prototype to avoid rate limits
    setInterval(tick, 15000); 
    // Run first tick immediately
    tick();
}

startDaemon();

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log("\n[Daemon] Shutting down.");
    process.exit(0);
});