# Exogenous Trigger System (Self-Activation)

## Overview
The Exogenous Trigger system provides true autonomy to SquidRun agents by allowing them to "wake up" based on shifts in the environment, rather than waiting for a user prompt or a scheduled polling cycle. It shifts the paradigm from "instruction-following" to "situation-response."

## Core Components

1.  **The Trigger Registry (`.squidrun/state/triggers.json`)**
    A central, persistent registry where any agent can register a trigger. 
    *   **id**: Unique identifier for the trigger.
    *   **author**: The agent that registered the trigger (e.g., 'oracle', 'builder').
    *   **condition**: A machine-readable expression defining the state that triggers activation (e.g., `vix > 25`, `failed_tests > 0`, `eth_price_drop_pct_1h > 5`).
    *   **data_source**: The stream or file to monitor (e.g., `market_feed`, `test_results.json`).
    *   **action_payload**: The structured data to inject into the agent's context when the trigger fires.
    *   **status**: active / dormant.

2.  **The Trigger Daemon (`ui/scripts/hm-trigger-daemon.js`)**
    A lightweight background process that runs continuously alongside the main IPC broker.
    *   It tails designated data sources or polls them at high frequency.
    *   It evaluates the data against the active conditions in the registry.
    *   When a condition evaluates to `true`, it initiates the Activation Sequence.

3.  **The Activation Sequence (`ui/scripts/hm-activate.js`)**
    The mechanism that forces an agent into a processing loop.
    *   If the target agent is currently idle, it injects the `action_payload` directly into the agent's input stream as a priority interrupt.
    *   If the target agent is busy, it queues the trigger in a high-priority "Immediate Action" buffer that is processed before the next user prompt or ledger task.

## Example Flow (Market Volatility)

1.  **Registration:** The Oracle registers a trigger: "If BTC drops > 3% in 15 minutes, wake me up with the market snapshot."
2.  **Monitoring:** The Trigger Daemon monitors the incoming market data stream.
3.  **Evaluation:** A sudden dump occurs. The Daemon evaluates `btc_drop_pct_15m > 3` as `true`.
4.  **Activation:** The Daemon fires `hm-activate.js oracle --payload [market_data]`. 
5.  **Response:** The Oracle wakes up independently of James or the Architect, analyzes the data, and sends an urgent `hm-send.js` message to the Architect advising a position change.

## Implementation Steps

1.  Draft the JSON schema for `.squidrun/state/triggers.json`.
2.  Build the CLI tool `hm-trigger.js` allowing agents to `register`, `list`, and `remove` triggers.
3.  Write the `hm-trigger-daemon.js` to parse the registry and mock a basic evaluation loop against static data sources.
4.  Wire the daemon into the `squidrun` startup lifecycle so it boots alongside the main application broker.