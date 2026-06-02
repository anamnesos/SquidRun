# TrustQuote Field Workflow
Canonical rule for James/Drain Brains field work:

## Appointment Is Not Invoice
- `calendar-events` are appointments/jobs on the schedule.
- The TrustQuote dashboard invoice list is driven by invoice/job documents, primarily `jobs` for invoices and `quotes` for proposals.
- Completing a `calendar-events` appointment, adding `completionNotes`, or sending a plain completion email does not create a dashboard invoice.
- If James says "fill field", "send invoice", "charge", "paid", or asks why something is not on the dashboard, verify whether a linked `jobs` document exists.

## Correct Completion Flow
1. Identify the TrustQuote appointment/customer first.
2. If no linked job exists, create a `jobs` invoice record and link it back to the appointment:
   - `calendar-events/{eventId}.jobId`
   - `calendar-events/{eventId}.invoiceId`
   - `jobs/{jobId}.sourceEventId`
3. Put customer-facing work performed in the invoice/job fields, not only the appointment:
   - diagnosis/problem
   - solution/work performed
   - jobTypes line item
   - warranty
   - customerNotes
4. Put the price in the `jobs` invoice record:
   - `jobTypes[].price`
   - `jobTypes[].total`
   - `subtotal`
   - `total`
   - `balanceDue`
   - `paymentStatus`
5. If paid, record payment on the `jobs` invoice:
   - `paymentDates[]`
   - `totalPaid`
   - `balanceDue: 0`
   - `paymentStatus: paid`
   - `lastPaymentDate`
   - add a `payments` collection record when using admin/direct repair.
6. Send invoice email only after the `jobs` record exists and contains the final amount/payment state.

## Safety Rules
- Do not invent a price. If missing, create at most a clearly marked draft/placeholder and ask for or wait for the amount.
- Do not put private staffing/worker conflict notes in customer-facing TrustQuote records.
- Do not send accusations or employment/customer-sensitive content unless James explicitly asks.
- If a repair is done manually through Firestore/Admin SDK, report plainly what was touched.

## Example From 2026-05-04
- Appointment: Orie & Jason, 3063 Adams Way, clogged shower drain.
- Correct invoice outcome:
  - `jobs/cPtmiCEC8pCtTsYk6uPU`
  - invoice `#479`
  - $250 shower drain cleaning
  - work: snaked shower drain, removed hair blockage, tested drain
  - warranty: 30 days
  - payment: paid, $250, balance $0
