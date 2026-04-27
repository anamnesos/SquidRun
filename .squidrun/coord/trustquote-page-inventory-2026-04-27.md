# TrustQuote Page Inventory - 2026-04-27

Read-only screen catalog for `D:/projects/TrustQuote/app/`.

Scope:
- Plain-English route/page inventory only.
- Not a feature audit.
- Not a code review.
- Stripe-related paths were skipped.

## Main Work Screens

- Create Invoice / Landing (`/`) - `app/page.tsx`
  - Purpose: This is the front door. Logged-in users land on the invoice/quote builder; trial users can try the builder; logged-out users see the marketing landing page.
  - Works: The route cleanly switches between landing page, trial mode, and invoice form.
  - Rough: It is doing several jobs at once, so "home page" and "create invoice page" are the same screen.

- Dashboard (`/dashboard`) - `app/dashboard/page.tsx`
  - Purpose: Main daily work view for invoices, quotes, searching, filtering, totals, and revenue chart.
  - Works: This is the real command center and has the strongest "run the business" feel.
  - Rough: The dashboard data hook is large and historically performance-sensitive.

- Calendar (`/calendar`) - `app/calendar/page.tsx`
  - Purpose: Schedule jobs, view days/months, drag jobs around, edit events, and manage day notes/materials.
  - Works: The page is functional and has both desktop and mobile-specific behavior.
  - Rough: Historically brittle. Mobile layout, drag/drop, modal state, and materials sync have all needed repeated fixes.

- Customers (`/customers`) - `app/customers/page.tsx`
  - Purpose: Customer list, customer search/filtering, customer stats, customer editing, and the business directory tab.
  - Works: It is a broad customer hub, not just a names list.
  - Rough: The page pulls customer stats and related job data in a way that can get heavy for large accounts.

- Services (`/services`) - `app/services/page.tsx`
  - Purpose: Manage the service menu: service names, pricing, categories, descriptions, and active/inactive services.
  - Works: Clear catalog management for repeat work.
  - Rough: It overlaps conceptually with the newer pricebook screen, so users may not know which one is the "real" pricing home.

- Pricebook (`/pricebook`) - `app/pricebook/page.tsx`
  - Purpose: Organize services into pricebook sections with drag/drop ordering.
  - Works: More structured and modern than a flat services list.
  - Rough: Drag/drop and section organization add moving parts; the screen depends on heavier UI code.

- Finances (`/finances`) - `app/finances/page.tsx`
  - Purpose: Track expenses, revenue, taxes, quarterly due date, charts, and job profitability.
  - Works: Useful owner-facing money view.
  - Rough: Current data shape reads broad finance/job history client-side, which will age poorly with heavy usage.

- Business Settings (`/business`) - `app/business/page.tsx`
  - Purpose: Business profile, logo, company info, team/admin management, data export, and account deletion controls.
  - Works: Central place for setup and owner-level business controls.
  - Rough: It is a large, sensitive page with many responsibilities.

- Trash (`/trash`) - `app/trash/page.tsx`
  - Purpose: Review deleted jobs/quotes, restore them, or permanently delete them.
  - Works: Gives a recovery path instead of making deletes instantly final.
  - Rough: Permanent delete flow is necessarily scary and should remain carefully guarded.

## Invoice / Customer-Facing Screens

- Invoice Preview (`/invoice/[id]/preview`) - `app/invoice/[id]/preview/page.tsx`
  - Purpose: View an invoice or quote, download PDF, send it, edit it, request approval, and add payment.
  - Works: Strong operational screen; it connects document review to next actions.
  - Rough: Preview loading still has special handling for logos/PDFs and can be sensitive to document shape.

- Customer Approval (`/approve/[token]`) - `app/approve/[token]/page.tsx`
  - Purpose: External customer page for reviewing and electronically approving a proposal/invoice.
  - Works: Purpose-built, simple, and does not require the customer to log into the app.
  - Rough: It carries legal/SMS consent text inline, so changes need extra care.

## Login / Setup / Auth Support Screens

- Login / Signup (`/login`) - `app/login/page.tsx`
  - Purpose: Sign in, create a business account, join an existing business, upload logo, and complete setup.
  - Works: Handles both owner signup and worker invite flow.
  - Rough: A lot happens in one page: login, signup, company setup, tech setup, logo upload, and invite validation.

- Forgot Password (`/login/forgot`) - `app/login/forgot/page.tsx`
  - Purpose: Send a password reset email.
  - Works: Simple and privacy-safe; it does not reveal whether an email exists.
  - Rough: Minimal screen, no major issue spotted in this inventory pass.

- Worker Setup (`/worker-setup`) - `app/worker-setup/page.tsx`
  - Purpose: Let a worker add their name and phone number so they can receive job assignments/SMS reminders.
  - Works: Focused setup flow after authentication.
  - Rough: Older setup path; it may overlap with the newer worker join flow inside `/login`.

- Fix Claims (`/fix-claims`) - `app/fix-claims/page.tsx`
  - Purpose: Repair a user's auth claims so storage/business access works correctly.
  - Works: Useful emergency repair page.
  - Rough: This is an internal/debug-style page exposed as a route; not normal customer-facing product.

- Debug Auth (`/debug-auth`) - `app/debug-auth/page.tsx`
  - Purpose: Show signed-in user details, auth claims, and related business/user data for troubleshooting.
  - Works: Helpful for diagnosing login/permission problems.
  - Rough: Debug-only page; should be treated as internal tooling.

## Admin / Support Screens

- Admin Dashboard (`/admin`) - `app/admin/page.tsx`
  - Purpose: Platform admin view with overview, users, support conversations, and error reports.
  - Works: Has useful tabs for operator visibility.
  - Rough: Data loading is broad and heavy; should stay limited to trusted admin users.

## Legal / Trust / Compliance Pages

- Terms of Service (`/terms`) - `app/terms/page.tsx`
  - Purpose: Legal terms for using TrustQuote.
  - Works: Covers scheduling, invoicing, SMS, customer data, and related terms.
  - Rough: Static legal copy needs a real review process when product behavior changes.

- Privacy Policy (`/privacy`) - `app/privacy/page.tsx`
  - Purpose: Explain what data TrustQuote collects and how it is used/shared.
  - Works: Includes customer data, SMS, third-party services, rights, and security notes.
  - Rough: Static policy must stay synced with actual integrations and data flows.

- Security & Trust (`/security`) - `app/security/page.tsx`
  - Purpose: Explain security posture, access control, backups/export, incident handling, and third-party services.
  - Works: Good trust-building page for buyers who worry about business data.
  - Rough: Some statements are broad; they should stay tied to verified current practice.

- SMS Disclosure (`/sms-disclosure`) - `app/sms-disclosure/page.tsx`
  - Purpose: Explain SMS usage for workers and customers, consent, frequency, opt-out, and help language.
  - Works: Clear customer-facing compliance page for messaging.
  - Rough: SMS wording must stay aligned with actual Twilio/assistant behavior.

- Disclaimer (`/disclaimer`) - `app/disclaimer/page.tsx`
  - Purpose: Legal disclaimers around estimates, professional responsibility, payments, and service outcomes.
  - Works: Clear static legal/supporting page.
  - Rough: Static copy should be reviewed when product positioning changes.

## Route Count

22 UI pages found under `app/`:

1. `/`
2. `/admin`
3. `/approve/[token]`
4. `/business`
5. `/calendar`
6. `/customers`
7. `/dashboard`
8. `/debug-auth`
9. `/disclaimer`
10. `/finances`
11. `/fix-claims`
12. `/invoice/[id]/preview`
13. `/login`
14. `/login/forgot`
15. `/pricebook`
16. `/privacy`
17. `/security`
18. `/services`
19. `/sms-disclosure`
20. `/terms`
21. `/trash`
22. `/worker-setup`

