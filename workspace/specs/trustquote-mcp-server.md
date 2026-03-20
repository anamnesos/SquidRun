# TrustQuote MCP Server — SquidRun Integration Spec

## Origin

Session 242. James wants SquidRun agents to operate TrustQuote directly — invoicing, payments, customers, scheduling — without going through TrustQuote's Telegram bot separately.

## Goal

Expose TrustQuote's business operations as an MCP server that any SquidRun agent can call natively. When James says "send John an invoice for $250 for the water heater install," the Architect routes it and it happens.

## Architecture

```
SquidRun Agent (any pane)
  -> MCP tool call (e.g. trustquote_send_invoice)
  -> TrustQuote MCP Server (stdio, runs locally)
  -> Firebase Admin SDK -> Firestore
  -> Side effects: email via Resend, SMS via business SMS, PDF generation
```

The MCP server runs as a local stdio process, same as GitHub and Playwright MCP servers already configured in `.mcp.json`.

## Tools to Expose (from TrustQuote lib/telegram/tools.ts)

### Already implemented in TrustQuote — wrap as MCP tools:

1. **trustquote_send_invoice** — Create invoice + deliver via email/SMS with PDF
2. **trustquote_book_job** — Create customer + job draft
3. **trustquote_check_payments** — List unpaid/partial invoices with balances
4. **trustquote_business_summary** — N-day performance summary (jobs, revenue, outstanding)
5. **trustquote_send_reminder** — Payment reminder via SMS/email
6. **trustquote_list_customers** — Search/list customers
7. **trustquote_team_status** — Team roster with roles
8. **trustquote_send_approval** — Email approval request for invoice

### Not yet implemented — add later:

9. **trustquote_schedule_job** — Create calendar event for a job
10. **trustquote_list_schedule** — Show upcoming calendar events
11. **trustquote_record_payment** — Record a payment against an invoice

## Implementation Approach

### Option A: Reuse TrustQuote's tool handlers directly
- The MCP server imports from `D:/projects/TrustQuote/lib/telegram/tools.ts`
- Requires TrustQuote's node_modules and Firebase Admin SDK to be accessible
- Fastest path, no code duplication
- Risk: tight coupling to TrustQuote's internal structure

### Option B: HTTP API layer
- TrustQuote exposes a local API (or use its existing Next.js API routes)
- MCP server calls HTTP endpoints
- Cleaner separation, but requires TrustQuote dev server running

### Recommendation: Option A for now
- James runs both projects locally on VIGIL
- Direct import is simplest and fastest
- Can migrate to Option B if TrustQuote gets deployed for other users

## Config

Add to `.mcp.json`:
```json
{
  "trustquote": {
    "type": "stdio",
    "command": "node",
    "args": ["ui/scripts/mcp-trustquote.js"],
    "env": {
      "TRUSTQUOTE_PROJECT_PATH": "D:/projects/TrustQuote",
      "GOOGLE_APPLICATION_CREDENTIALS": "${TRUSTQUOTE_FIREBASE_CREDENTIALS}",
      "RESEND_API_KEY": "${RESEND_API_KEY}"
    }
  }
}
```

## Dependencies

- Firebase Admin SDK credentials (service account JSON)
- Resend API key (for email delivery)
- TrustQuote project accessible at `D:/projects/TrustQuote`
- Business ID (can auto-resolve from single-tenant setup)

## Security

- MCP server runs locally, no network exposure
- Firebase Admin SDK has full Firestore access — same trust model as the Telegram bot
- James has explicitly authorized full access (session 213)

## Validation

- Agent can call `trustquote_business_summary` and get real data back
- Agent can call `trustquote_send_invoice` and invoice appears in TrustQuote web app
- Agent can call `trustquote_check_payments` and see accurate outstanding balances
