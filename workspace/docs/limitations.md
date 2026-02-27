# Limitations & Scope

SquidRun is currently in **Technical Preview (Alpha)**. Before integrating it into your daily workflow, please understand its constraints.

## Alpha Constraints

- **High Setup Friction:** While we provide a setup wizard, mapping out the multi-model `.env` configuration (Relay secrets, Telegram tokens) and getting your PATH configured correctly across operating systems can be fragile.
- **Network Sensitivity:** The cross-device websocket bridge may struggle behind restrictive corporate firewalls or complex VPN setups.
- **Node.js Quirks:** Depending on your Node version, you will likely see cosmetic `node:sqlite` experimental warnings in the terminal output.

## Non-Goals

- **Not for non-technical users:** SquidRun relies on CLI workflows, reading terminal logs, and managing underlying AI CLI installations. We are not building a consumer-friendly GUI abstraction over code.
- **Not a hosted SaaS:** We will not offer a cloud-hosted version where we pay for your API tokens. SquidRun's core design relies on bringing your own local CLI subscriptions.
- **Not a Multi-Human Team Tool:** SquidRun is strictly designed for **one human** orchestrating multiple AI models. 

## What's Not Production-Ready

- **Running untrusted code:** The agents have access to your local filesystem and run shell commands in your user space. You should only use SquidRun on codebases you trust, as the agents can be directed to execute arbitrary commands.
- **SMS Integration:** SMS fallback communication is currently disabled/untested and should be treated as a planned feature only. Use Telegram for remote communication.
- **UI Polish:** The Electron desktop wrapper provides essential orchestration and settings panels, but it prioritizes functional debugging and reliability over visual polish. Expect a utilitarian interface.
