# TrustQuote MCP Server

## Purpose

Expose TrustQuote's existing Telegram business tools to SquidRun agents through a lightweight stdio MCP server without adding an MCP SDK dependency.

## Files

- `D:/projects/TrustQuote/scripts/mcp-server.ts`
- `D:/projects/squidrun/.mcp.json`

## Run

From `D:/projects/TrustQuote`:

```powershell
npx tsx scripts/mcp-server.ts
```

For a quick protocol smoke test:

```powershell
@(
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}',
  '{"jsonrpc":"2.0","method":"notifications/initialized"}',
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
) | npx tsx scripts/mcp-server.ts
```

## Behavior

- Loads TrustQuote env values from `.env.local` and `.env` before importing app code.
- Redirects normal `console.log/info/warn` output to `stderr` so `stdout` stays clean for newline-delimited JSON-RPC.
- Exposes the existing TrustQuote Telegram handlers as MCP tools with a `trustquote_` prefix.
- Skips `link_business` because MCP uses synthetic context instead of Telegram chat linking.
- Resolves `businessId` from `TRUSTQUOTE_BUSINESS_ID` first, then falls back to `resolveBusinessIdForChat('mcp-server')`.

## Current Tool Surface

The MCP server currently exposes 8 tools:

- `trustquote_send_invoice`
- `trustquote_book_job`
- `trustquote_check_payments`
- `trustquote_business_summary`
- `trustquote_send_reminder`
- `trustquote_list_customers`
- `trustquote_team_status`
- `trustquote_send_approval`
