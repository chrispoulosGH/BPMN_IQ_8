'use strict';

// Seeds the soxcontrols collection with SOX §404 (ICFR) controls scoped the
// way an external auditor would scope a real-world audit of this landscape,
// generated against the real Application / API / Server / Software
// (CanonicalData) and business-flow (Diagram) records:
//
//   1. IT General Controls (ITGCs) on every financially significant
//      application — access, program change, computer operations, program
//      development — tiered by how directly the app feeds the general ledger.
//      Infrastructure-layer controls carry the app's real servers / database
//      software in scope, and their observations come from those records
//      (patching status, backup cadence, open CVEs, OS end-of-life).
//   2. Business process controls on the tasks inside financially significant
//      business flows where a misstatement could enter the books (approvals,
//      three-way match, cash application, reconciliations, estimates...),
//      plus one management review control per in-scope flow. Segregation-of-
//      duties conflicts are detected from the real task→actor assignments.
//   3. Interface controls on the cross-application APIs that feed those
//      controlled tasks.
//
// Control IDs (unique, see models/SoxControl.js):
//   SOX-ITGC-<domain><nn>-<APP>   SOX-<cycle>-<nnn>   SOX-ITAC-IF-<API_ID>
//
// Also stamps `soxControlIds` onto the attached components (Diagram,
// CanonicalData Applications/APIs/Servers/Software) so each component
// carries its control numbers directly.
//
// Clears and regenerates by default (the collection has no other writer).
//
// Usage:
//   node scripts/seed_sox_controls.js [--dry-run]

const mongoose = require('mongoose');
const path = require('path');
const dotenv = require('dotenv');
const crypto = require('crypto');
const CanonicalData = require('../models/CanonicalData');
const Diagram = require('../models/Diagram');
const SoxControl = require('../models/SoxControl');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/bpmn_iq';
const NEIGHBORHOOD = 'System Components';
const dryRun = process.argv.slice(2).includes('--dry-run');
const BATCH_ID = `sox-${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(3).toString('hex')}`;

const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const TODAY_SERIAL = Math.floor((Date.now() - EXCEL_EPOCH_MS) / 86400000);
const excelSerialToIso = (serial) => (Number.isFinite(Number(serial)) && Number(serial) > 0
  ? new Date(EXCEL_EPOCH_MS + Number(serial) * 86400000).toISOString().slice(0, 10)
  : null);

const norm = (value) => String(value || '').trim().toLowerCase();
const decodeEntities = (value) => String(value || '').replace(/&amp;/g, '&').replace(/&#38;/g, '&');
const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);

// ─── Scoping: financially significant applications ─────────────────────────
// Tier 1 = key financial system (system of record for a financial statement
// balance); Tier 2 = financially significant feeder (originates transactions
// or estimates that flow to the GL); Tier 3 = ITGC-supporting / financial
// reporting infrastructure. `cataloged: false` entries are applications the
// in-scope flows really use but which are absent from the application catalog
// — kept in scope (an auditor can't ignore them) and flagged as a gap.
const IN_SCOPE_APPS = {
  'FINANCE-HUB': { tier: 1, accounts: ['General Ledger', 'Accounts Payable', 'Accounts Receivable', 'Cash', 'Fixed Assets', 'Income Taxes'], rationale: 'System of record for the general ledger and AP/AR subledgers — every journal that reaches the financial statements posts here.' },
  'ORDER-MGMT': { tier: 1, accounts: ['Revenue', 'Accounts Receivable', 'Deferred Revenue'], rationale: 'Vehicle orders, allocation and delivery confirmations drive ASC 606 revenue recognition and cut-off.' },
  'INVENTORY-MGR': { tier: 1, accounts: ['Inventory', 'Cost of Sales'], rationale: 'Perpetual vehicle inventory record; quantities and status feed inventory valuation and cost of sales.' },
  'SUPPLYLINK': { tier: 1, accounts: ['Accounts Payable', 'Inventory', 'Accrued Liabilities'], rationale: 'Purchase orders, supplier invoices and contracts originate the procure-to-pay liability.' },
  'DEALER-FINANCE': { tier: 1, accounts: ['Finance Receivables (Floor Plan)', 'Interest Income', 'Allowance for Credit Losses'], rationale: 'Floor plan balances and interest charges are financial assets and income on the balance sheet / P&L.' },
  'LEASE-ADMIN': { tier: 1, accounts: ['Operating Lease Assets', 'Lease Revenue', 'Residual Value Reserve'], rationale: 'ASC 842 lease portfolio — residual value estimates are a significant, judgmental accounting estimate.' },
  'WARRANTY-360': { tier: 1, accounts: ['Product Warranty Reserve', 'Warranty Expense'], rationale: 'Warranty claims experience drives the product warranty reserve, typically one of an OEM\'s largest estimates.' },
  'VSC-ADMIN': { tier: 1, accounts: ['Deferred Revenue (Service Contracts)', 'Claims Reserves'], rationale: 'Vehicle service contract reserves, loss ratios and deferred revenue are recorded from this system.' },
  'PRICING-ENGINE': { tier: 1, accounts: ['Revenue', 'Sales Incentive Accrual (Variable Consideration)'], rationale: 'MSRP, invoice pricing and incentive programs determine the transaction price and variable consideration under ASC 606.' },
  'HR-CORE': { tier: 1, accounts: ['Payroll Expense', 'Accrued Compensation', 'Benefit Liabilities'], rationale: 'Payroll and benefits processing; also the authoritative joiner/leaver feed for ITGC access controls.' },
  'CREDIT-DECIDE': { tier: 1, accounts: ['Finance Receivables', 'Allowance for Credit Losses (CECL)'], rationale: 'Underwriting decisions and risk scores originate finance receivables and inform the CECL allowance.' },
  'COLLECTIONS-SYS': { tier: 2, accounts: ['Allowance for Credit Losses', 'Charge-offs'], rationale: 'Delinquency status, payment plans and repossessions drive charge-offs and the allowance.' },
  'WARRANTY-SALES': { tier: 2, accounts: ['Revenue', 'Deferred Revenue (Service Contracts)'], rationale: 'Extended warranty / protection product sales originate service-contract revenue that must be deferred.' },
  'PREPAID-MAINT': { tier: 2, accounts: ['Deferred Revenue'], rationale: 'Prepaid maintenance plans are deferred and recognized as services are redeemed (GAAP deferred revenue).' },
  'CPO-WARRANTY': { tier: 2, accounts: ['Product Warranty Reserve', 'Deferred Revenue'], rationale: 'CPO warranty coverage creates warranty obligations recorded against used-vehicle sales.' },
  'DEALER-NET': { tier: 2, accounts: ['Revenue', 'Sales Incentive Accrual', 'Accounts Receivable'], rationale: 'Dealer sales transactions and incentive payments feed revenue and incentive accruals.' },
  'PARTS-PRO': { tier: 2, accounts: ['Inventory (Parts)', 'Revenue (Parts Wholesale)'], rationale: 'Parts inventory, pricing and wholesale accounts feed parts revenue and inventory valuation.' },
  'MES-PRO': { tier: 2, accounts: ['Work-in-Process Inventory', 'Cost of Sales'], rationale: 'Production and build history drive WIP / finished-goods relief and standard cost absorption.' },
  'LOGISTICS-HUB': { tier: 2, accounts: ['Freight Accruals', 'Revenue (cut-off)'], rationale: 'Shipment and delivery events determine transfer of control (cut-off) and freight cost accruals.' },
  'RECALL-MGR': { tier: 2, accounts: ['Recall Accrual'], rationale: 'Affected-VIN populations and repair completions drive the recall campaign accrual.' },
  'REMARKETING-SYS': { tier: 2, accounts: ['Used Vehicle Inventory (NRV)', 'Gain/Loss on Disposal', 'Residual Value Reserve'], rationale: 'Auction results and market values inform residual value impairment and gain/loss on off-lease disposal.' },
  'FLEET-PORTAL': { tier: 2, accounts: ['Revenue', 'Sales Incentive Accrual'], rationale: 'Fleet contracts and volume pricing establish the transaction price for fleet revenue.' },
  'LOYALTY-REWARDS': { tier: 2, accounts: ['Deferred Revenue (Loyalty Points)'], rationale: 'Points earned are a material right — the outstanding points liability is deferred revenue.' },
  'CONNECTED-CAR': { tier: 2, accounts: ['Deferred Revenue (Subscriptions)', 'Revenue'], rationale: 'Connected-service subscriptions and trials are recognized ratably; activation dates drive deferral.' },
  'DIGITAL-RETAIL': { tier: 2, accounts: ['Revenue', 'Accounts Receivable'], rationale: 'Online deals, e-contracts and payments originate retail vehicle sales.' },
  'CHARGE-NET': { tier: 2, accounts: ['Revenue (Charging Services)'], rationale: 'Charging session billing data originates charging-services revenue.' },
  'EXEC-DASHBOARD': { tier: 2, accounts: ['Financial Reporting (IPE)'], rationale: 'Financial KPIs and metrics used in management review controls — report logic is information produced by the entity (IPE).' },
  'IT-SERVICE': { tier: 3, accounts: ['ITGC evidence repository'], rationale: 'System of record for change tickets and access requests — the evidence auditors sample for program change and access ITGCs.' },
  'CYBER-SEC': { tier: 3, accounts: ['ITGC supporting (logging/monitoring)'], rationale: 'Security event monitoring over privileged activity on in-scope systems.' },
  'RISK-MGR': { tier: 3, accounts: ['Entity-level controls'], rationale: 'Risk register and control library supporting the COSO risk assessment component.' },
  'DATA-LAKE': { tier: 3, accounts: ['Financial Reporting (IPE)'], rationale: 'Enterprise data platform sourcing financial reports — data lineage and transformation logic must be reliable.' },
  'ANALYTICS-HUB': { tier: 3, accounts: ['Financial Reporting (IPE)'], rationale: 'Analytical models and reports used as evidence in review controls (budget vs. actual, historical analysis).' },
  'LEGAL-DOCS': { tier: 3, accounts: ['Contingencies (ASC 450)', 'Disclosures'], rationale: 'Litigation files and legal holds feed the loss-contingency assessment and disclosures.' },
  // Used by in-scope flows but missing from the application catalog:
  'PARTS-INVENTORY': { tier: 1, cataloged: false, accounts: ['Inventory (Parts)', 'Accounts Payable (GRNI)'], rationale: 'Goods receipt and parts quantities used in the AP three-way match and parts inventory.' },
  'SUPPLIER-MGT': { tier: 1, cataloged: false, accounts: ['Accounts Payable', 'Purchase Commitments'], rationale: 'Creates purchase orders and holds supplier contracts used in procure-to-pay.' },
  'HR-CENTRAL': { tier: 2, cataloged: false, accounts: ['Payroll Expense', 'ITGC (joiner/leaver feed)'], rationale: 'New-hire records and system-access setup in the onboarding flow — payroll master data and access provisioning.' },
  'PARTS-ORDER': { tier: 2, cataloged: false, accounts: ['Accounts Payable', 'Revenue (Parts)'], rationale: 'Parts purchase orders and dealer parts orders.' },
  'PRICE-MASTER': { tier: 2, cataloged: false, accounts: ['Revenue'], rationale: 'Custom fleet pricing — establishes transaction price for fleet deals.' },
  'PARTS-CATALOG': { tier: 2, cataloged: false, accounts: ['Revenue (Parts)'], rationale: 'Parts price quotes used in counter sales.' },
  'RECALL-COMMAND': { tier: 2, cataloged: false, accounts: ['Recall Accrual'], rationale: 'Identifies affected vehicles — the population basis for the recall accrual.' },
};

// ─── Scoping: financially significant business flows → process cycle ──────
const CYCLE_NAMES = {
  P2P: 'Procure-to-Pay',
  O2C: 'Order-to-Cash',
  R2R: 'Record-to-Report',
  FIN: 'Finance Receivables & Leasing',
  WAR: 'Warranty & Service Contracts',
  INV: 'Inventory & Cost Accounting',
  H2R: 'Hire-to-Retire',
  INC: 'Incentives & Customer Liabilities',
  ITG: 'IT Governance',
};
const FLOW_CYCLES = {
  'Accounts Payable Processing': 'P2P', 'Supplier Parts Ordering': 'P2P', 'Vendor Contract Management': 'P2P', 'Parts Reorder Process': 'P2P',
  'Accounts Receivable Collection': 'O2C', 'Customer Payment Collection': 'O2C', 'Sales Contract Finalization': 'O2C', 'Deal Pricing & Structuring': 'O2C',
  'Fleet Order Fulfillment': 'O2C', 'Fleet Proposal Generation': 'O2C', 'Fleet Customer Sales Process': 'O2C', 'Custom Vehicle Build Order': 'O2C',
  'Dealer Parts Order Processing': 'O2C', 'Parts Counter Sale': 'O2C', 'New Vehicle Delivery Experience': 'O2C', 'Wholesale Vehicle Disposition': 'O2C',
  'Connected Subscription Renewal': 'O2C', 'In-Vehicle Commerce Transaction': 'O2C', 'Vehicle Subscription Service': 'O2C', 'Digital Retailing Journey': 'O2C',
  'Monthly Financial Close': 'R2R', 'Annual Budget Planning': 'R2R', 'Annual Budget Planning Process': 'R2R', 'Regulatory Compliance Reporting': 'R2R',
  'Legal Case Management': 'R2R', 'Enterprise Risk Assessment': 'R2R',
  'Customer Credit Application': 'FIN', 'Finance Contract Funding': 'FIN', 'Special Finance Processing': 'FIN', 'Past Due Account Management': 'FIN',
  'GAP Insurance Sale': 'FIN', 'Vehicle Lease Structuring': 'FIN', 'Lease Return & Disposition': 'FIN',
  'Warranty Claim Submission': 'WAR', 'Goodwill Repair Authorization': 'WAR', 'Recall Campaign Execution': 'WAR', 'Warranty Contract Execution': 'WAR',
  'Warranty Pricing & Quote Generation': 'WAR', 'Warranty Customer Onboarding & Documentation': 'WAR',
  'Warehouse Inventory Management': 'INV', 'Vehicle Assembly Line Execution': 'INV', 'Vehicle Outbound Logistics': 'INV', 'CPO Vehicle Certification Process': 'INV',
  'Production Defect Containment': 'INV',
  'Employee Onboarding Process': 'H2R', 'Employee Performance Review': 'H2R',
  'Dealer Incentive Program Management': 'INC', 'Customer Loyalty Program': 'INC',
  'IT Change Request Process': 'ITG', 'IT Service Request Fulfillment': 'ITG',
};

// One management review control per in-scope flow, by cycle.
const FLOW_MRC = {
  P2P: { title: 'Monthly review of open purchase commitments, GRNI and AP accruals', activity: 'The {owner} reviews the monthly goods-received-not-invoiced (GRNI) and unmatched-invoice reports generated for {flow}, investigates items aged over 60 days and items above the review threshold, and approves the AP accrual true-up before the period is closed.', freq: 'Monthly', assertions: ['Completeness', 'Cut-off', 'Accuracy'], owner: 'AP Manager' },
  O2C: { title: 'Monthly revenue analytic review and deferred revenue roll-forward', activity: 'The {owner} performs a price × volume revenue analytic for {flow} against expectations (prior period, budget), investigates variances above threshold, and reviews the deferred revenue roll-forward and post-period-end cut-off listing before sign-off.', freq: 'Monthly', assertions: ['Occurrence', 'Cut-off', 'Accuracy', 'Presentation & Disclosure'], owner: 'Revenue Accounting Manager' },
  R2R: { title: 'Monthly controller flux analysis and close checklist sign-off', activity: 'The {owner} reviews period-over-period fluctuations of financial statement line items affected by {flow} against defined thresholds, obtains explanations for all variances above threshold, and signs off the close checklist.', freq: 'Monthly', assertions: ['Completeness', 'Accuracy', 'Valuation & Allocation', 'Presentation & Disclosure'], owner: 'Corporate Controller' },
  FIN: { title: 'Monthly portfolio performance and allowance for credit losses review', activity: 'The {owner} reviews delinquency, loss and residual-value performance for portfolios originated through {flow}, challenges the CECL / residual model inputs and qualitative adjustments, and approves the allowance and reserve balances.', freq: 'Monthly', assertions: ['Valuation & Allocation', 'Completeness'], owner: 'Finance Risk Controller' },
  WAR: { title: 'Quarterly warranty / service-contract reserve adequacy review', activity: 'The {owner} compares claims experience generated through {flow} (frequency, severity, lag) to the actuarial reserve assumptions, reviews the reserve roll-forward (provisions, payments, changes in estimate) and approves the reserve recorded.', freq: 'Quarterly', assertions: ['Valuation & Allocation', 'Completeness', 'Accuracy'], owner: 'Warranty Accounting Manager' },
  INV: { title: 'Monthly inventory valuation, reserve and cut-off review', activity: 'The {owner} reviews inventory movements recorded through {flow}, the excess & obsolete / net-realizable-value reserve calculation, and in-transit cut-off at period end, and approves the inventory adjustments.', freq: 'Monthly', assertions: ['Existence', 'Valuation & Allocation', 'Cut-off'], owner: 'Plant / Inventory Controller' },
  H2R: { title: 'Per-cycle payroll register review and headcount reconciliation', activity: 'The {owner} reviews the payroll register for changes originating from {flow} (new hires, rating-driven pay changes) against approved HR records, reconciles headcount to HR master data, and approves the payroll before release.', freq: 'Per payroll cycle', assertions: ['Occurrence', 'Accuracy'], owner: 'Payroll Manager' },
  INC: { title: 'Quarterly incentive / customer-liability accrual true-up', activity: 'The {owner} reconciles program liabilities created through {flow} (incentive payouts earned, loyalty points outstanding) to the general ledger accrual, reviews breakage / attainment assumptions, and approves the true-up.', freq: 'Quarterly', assertions: ['Completeness', 'Valuation & Allocation', 'Accuracy'], owner: 'Sales Accounting Manager' },
  ITG: { title: 'Quarterly review of IT change and access fulfilment activity', activity: 'The {owner} reviews a system-generated listing of changes / access requests processed through {flow} in the quarter, verifies each production change and access grant traces to an approved ticket, and follows up on exceptions.', freq: 'Quarterly', assertions: ['Occurrence (of authorized changes / access only)'], owner: 'IT Compliance Manager' },
};

// ─── Task-level control library ────────────────────────────────────────────
// First matching rule wins. {task} {flow} {actor} {apps} placeholders.
// `estimate: true` marks judgmental accounting estimates (higher audit risk).
// `duty` feeds segregation-of-duties detection.
const TASK_RULES = [
  { key: 'three_way_match', re: /match to purchase order/i, duty: 'record', title: 'Automated three-way match (PO / receipt / invoice)', nature: 'Automated', type: 'Preventive', assertions: ['Occurrence', 'Accuracy'], accounts: ['Accounts Payable', 'Inventory / Expense'], objective: 'Only invoices for goods actually ordered and received, at the agreed price, are recorded as liabilities.', risk: 'Invoices are paid for goods not ordered or not received, or at prices other than the PO price, overstating AP and expense.', activity: '{apps} automatically matches each vendor invoice in "{task}" to the purchase order and goods receipt; quantity or price variances outside the configured tolerance block the invoice for payment until resolved by the {actor}.' },
  { key: 'contract_match', re: /match to supplier contracts|validate against proposal/i, duty: 'record', title: 'Automated validation of order terms to approved contract / proposal', nature: 'Automated', type: 'Preventive', assertions: ['Accuracy', 'Occurrence'], accounts: ['Revenue / Accounts Payable'], objective: 'Orders are created only at pricing and terms in an approved contract or proposal.', risk: 'Orders are processed at unapproved prices or terms, misstating revenue / purchases.', activity: 'During "{task}", {apps} validates order lines (item, price, quantity, terms) against the approved contract / proposal and rejects mismatches for review.' },
  { key: 'goods_receipt', re: /verify receipt of goods|receive goods at plant|receive inbound shipment|receive parts shipment|dealer receives shipment|scan & verify contents/i, duty: 'custody', title: 'Goods receipt recorded against an open purchase order', nature: 'IT-Dependent Manual', type: 'Preventive', assertions: ['Existence', 'Completeness', 'Cut-off'], accounts: ['Inventory', 'Accounts Payable (GRNI)'], objective: 'Receipts are recorded completely, accurately and in the correct period against an open PO.', risk: 'Receipts are unrecorded or recorded in the wrong period, misstating inventory and the GRNI liability at period end.', activity: 'The {actor} records the receipt in {apps} during "{task}" only against an open PO; the system rejects receipts without a PO and timestamps the receipt for cut-off.' },
  { key: 'payment_approval', re: /approve for payment|approve payout amounts/i, duty: 'authorize', title: 'Payment approval within delegation of authority', nature: 'IT-Dependent Manual', type: 'Preventive', assertions: ['Occurrence', 'Accuracy'], accounts: ['Accounts Payable', 'Cash', 'Sales Incentive Accrual'], objective: 'Disbursements are authorized by an appropriate approver within delegation-of-authority limits.', risk: 'Unauthorized or erroneous payments are released.', activity: 'The {actor} reviews supporting documentation and approves "{task}" in {apps}; workflow routes amounts above the approver\'s DOA limit to the next level and prevents the preparer from self-approving.' },
  { key: 'payment_release', re: /execute payment|process incentive payments/i, duty: 'custody', title: 'Payment run restricted to approved items with secured bank file', nature: 'Automated', type: 'Preventive', assertions: ['Occurrence', 'Accuracy'], accounts: ['Cash', 'Accounts Payable'], objective: 'Only approved, unaltered payments are transmitted to the bank.', risk: 'Payment files are altered or include unapproved items, resulting in misappropriation of cash.', activity: '{apps} selects only fully approved items for the payment run in "{task}"; the bank file is generated and transmitted through an encrypted channel with control totals reconciled to the approved payment proposal.' },
  { key: 'pricing_approval', re: /approve final price|approve or reject discount|director review & approval|review deal profitability/i, duty: 'authorize', title: 'Pricing / discount exception approval', nature: 'IT-Dependent Manual', type: 'Preventive', assertions: ['Accuracy', 'Valuation & Allocation'], accounts: ['Revenue', 'Sales Incentive Accrual'], objective: 'Prices and discounts outside standard pricing are approved by an authorized manager before the deal is finalized.', risk: 'Unauthorized discounts reduce revenue or create unrecorded variable consideration.', activity: 'Deals priced below the system floor or with discounts above threshold are routed to the {actor} for "{task}" in {apps}; the deal cannot be finalized without the recorded approval.' },
  { key: 'contract_approval', re: /manager final review & approval|execute contract$|execute lease contract/i, duty: 'authorize', title: 'Contract review and authorized execution', nature: 'Manual', type: 'Preventive', assertions: ['Rights & Obligations', 'Occurrence', 'Accuracy'], accounts: ['Revenue', 'Deferred Revenue', 'Commitments'], objective: 'Contracts are complete, accurate and executed only by authorized signatories before being recorded.', risk: 'Contracts with errors or unauthorized terms are recorded, misstating revenue, deferrals or commitments.', activity: 'The {actor} reviews the contract package for completeness and agreement to approved terms during "{task}" and evidences approval in {apps}; only authorized signatories can execute.' },
  { key: 'goodwill_approval', re: /oem approves/i, duty: 'authorize', title: 'Goodwill / policy-adjustment authorization limits', nature: 'IT-Dependent Manual', type: 'Preventive', assertions: ['Occurrence', 'Valuation & Allocation'], accounts: ['Warranty Expense', 'Product Warranty Reserve'], objective: 'Goodwill repairs outside warranty are authorized within approved limits.', risk: 'Unauthorized goodwill concessions understate warranty expense accruals.', activity: 'Goodwill requests are approved by the {actor} in {apps} during "{task}" within tiered authorization limits by amount and vehicle age/mileage.' },
  { key: 'cab_approval', re: /approve\/reject change/i, duty: 'authorize', cat: 'IT General Control', domain: 'Program Change', title: 'Change Advisory Board approval prior to production', nature: 'IT-Dependent Manual', type: 'Preventive', assertions: ['Occurrence (of authorized changes only)'], accounts: ['All accounts supported by changed systems'], objective: 'Only authorized, tested changes are migrated to production for financially significant systems.', risk: 'Unauthorized or untested changes alter financial processing logic.', activity: 'The {actor} approves or rejects each change in {apps} during "{task}" after reviewing impact assessment, test evidence and back-out plan; emergency changes are retro-approved within 2 business days.' },
  { key: 'change_migration', re: /implement change/i, duty: 'record', cat: 'IT General Control', domain: 'Program Change', title: 'Segregation of developers from production migration', nature: 'IT-Dependent Manual', type: 'Preventive', assertions: ['Occurrence (of authorized changes only)'], accounts: ['All accounts supported by changed systems'], objective: 'Changes are migrated by personnel independent of development, only after approval.', risk: 'Developers migrate their own unapproved code to production.', activity: 'The {actor} migrates the approved change during "{task}"; deployment tooling restricts production migration to a release group independent of developers and requires an approved {apps} ticket ID.' },
  { key: 'change_verify', re: /verify change success/i, duty: 'review', cat: 'IT General Control', domain: 'Program Change', keyControl: false, title: 'Post-implementation review of production changes', nature: 'Manual', type: 'Detective', assertions: ['Occurrence (of authorized changes only)'], accounts: ['All accounts supported by changed systems'], objective: 'Production changes operate as intended and match what was approved.', risk: 'Changes are implemented differently from what was approved and tested.', activity: 'The {actor} verifies each implemented change against its approved scope during "{task}" and closes the ticket in {apps} with evidence.' },
  { key: 'access_provisioning', re: /set up system access|resolve service request/i, duty: 'record', cat: 'IT General Control', domain: 'Access to Programs & Data', title: 'User access provisioned only on approved request', nature: 'IT-Dependent Manual', type: 'Preventive', assertions: ['Occurrence', 'Rights & Obligations'], accounts: ['All accounts supported by provisioned systems'], objective: 'Access to financially significant systems is granted only on approved request, consistent with job role.', risk: 'Users obtain inappropriate access enabling unauthorized transactions.', activity: 'During "{task}" the {actor} grants access only against a ticket approved by the user\'s manager and the application owner, using role-based access templates.' },
  { key: 'hr_master', re: /create new hire record|document final rating/i, duty: 'record', title: 'HR master data / compensation changes authorized before payroll', nature: 'IT-Dependent Manual', type: 'Preventive', assertions: ['Occurrence', 'Accuracy'], accounts: ['Payroll Expense', 'Accrued Compensation'], objective: 'Only authorized employees and approved compensation changes are paid.', risk: 'Fictitious employees or unapproved pay changes result in payroll overstatement.', activity: 'Records created during "{task}" in {apps} require HR and manager approval in workflow before becoming effective in payroll; changes are logged.' },
  { key: 'cash_receipt_manual', re: /receive customer payment|process down payment|process sale transaction|process payment transaction/i, duty: 'custody', title: 'Daily cash receipts reconciliation', nature: 'Manual', type: 'Detective', assertions: ['Completeness', 'Existence', 'Accuracy'], accounts: ['Cash', 'Accounts Receivable', 'Revenue'], objective: 'All cash received is completely and accurately recorded and deposited.', risk: 'Cash received is not recorded or is misappropriated.', activity: 'Payments taken by the {actor} during "{task}" are reconciled daily — {apps} receipts to the cash drawer / card settlement report and bank deposit — by someone other than the person handling cash; differences are investigated same day.' },
  { key: 'cash_application', re: /apply payment to account|record payment|process renewal payment|process payment setup|process complete transaction|^process payment$|receive payment$|receive funding confirmation/i, duty: 'record', title: 'Automated cash application to customer accounts', nature: 'Automated', type: 'Preventive', assertions: ['Accuracy', 'Completeness', 'Existence'], accounts: ['Cash', 'Accounts Receivable', 'Finance Receivables'], objective: 'Receipts are applied to the correct customer account and invoice.', risk: 'Payments are misapplied or left unapplied, misstating receivables and the allowance.', activity: '{apps} automatically applies receipts in "{task}" using remittance matching rules; unmatched receipts are routed to a suspense queue that is worked and cleared daily.' },
  { key: 'gl_interface', re: /record in gl|post to dealer accounting|submit to accounting/i, duty: 'record', title: 'Automated subledger-to-GL posting interface', nature: 'Automated', type: 'Preventive', assertions: ['Completeness', 'Accuracy'], accounts: ['General Ledger'], objective: 'Subledger transactions post completely and accurately to the correct GL accounts.', risk: 'Transactions fail to post, post twice, or post to incorrect accounts.', activity: 'On "{task}", {apps} posts journal entries using configured account determination; record counts and amount control totals are compared between source and GL and interface errors are routed to an exception queue.' },
  { key: 'manual_je', re: /process journal entries/i, duty: 'record', title: 'Manual journal entry review and approval', nature: 'IT-Dependent Manual', type: 'Preventive', assertions: ['Occurrence', 'Accuracy', 'Valuation & Allocation'], accounts: ['General Ledger'], objective: 'Manual journal entries are supported, accurate and approved by someone other than the preparer.', risk: 'Erroneous or fraudulent manual entries (management override) misstate the financial statements.', activity: 'Manual entries prepared by the {actor} during "{task}" are parked in {apps} and posted only after review and approval of supporting documentation by an independent approver; the system prevents self-approval.' },
  { key: 'reconciliation', re: /reconcile/i, duty: 'review', title: 'Account reconciliation with independent review', nature: 'IT-Dependent Manual', type: 'Detective', assertions: ['Existence', 'Completeness', 'Accuracy'], accounts: ['Balance sheet accounts'], objective: 'Account balances agree to supporting detail and reconciling items are resolved timely.', risk: 'Errors or unsupported balances remain undetected.', activity: 'The {actor} reconciles the balance to supporting detail during "{task}" (reports from {apps}), investigates reconciling items, and the reconciliation is independently reviewed and signed off within the close calendar.' },
  { key: 'subledger_close', re: /close sub-ledgers/i, duty: 'record', title: 'Subledger close and subledger-to-GL tie-out', nature: 'IT-Dependent Manual', type: 'Detective', assertions: ['Completeness', 'Cut-off'], accounts: ['General Ledger', 'Subledgers'], objective: 'Subledgers are closed for the period and agree to the GL control accounts.', risk: 'Transactions are posted to a closed period or subledgers do not agree to the GL.', activity: 'The {actor} closes the period in each subledger in {apps} and ties out subledger totals to GL control accounts during "{task}"; differences are investigated before the GL is closed.' },
  { key: 'intercompany', re: /review intercompany/i, duty: 'review', title: 'Intercompany reconciliation and elimination review', nature: 'IT-Dependent Manual', type: 'Detective', assertions: ['Existence', 'Accuracy', 'Presentation & Disclosure'], accounts: ['Intercompany Receivables/Payables', 'Consolidation'], objective: 'Intercompany balances agree between counterparties and eliminate fully on consolidation.', risk: 'Unreconciled intercompany differences misstate consolidated results.', activity: 'The {actor} reviews intercompany balance confirmations and elimination entries in {apps} during "{task}"; differences above threshold are resolved before consolidation.' },
  { key: 'fs_generation', re: /generate financial statements/i, duty: 'record', cat: 'IT Application Control', title: 'Financial statement report logic (IPE) validation', nature: 'Automated', type: 'Detective', assertions: ['Presentation & Disclosure', 'Completeness'], accounts: ['All financial statement line items'], objective: 'Financial statements are generated from complete GL data with correct FS-line mapping.', risk: 'Report logic or account mapping errors misstate financial statement presentation.', activity: '{apps} generates the financial statements in "{task}" from the closed trial balance using a controlled FS-line mapping; mapping changes follow program change controls and trial-balance-to-FS totals are agreed.' },
  { key: 'controller_review', re: /controller review/i, duty: 'review', title: 'Controller review of financial statements', nature: 'Manual', type: 'Detective', assertions: ['Presentation & Disclosure', 'Valuation & Allocation', 'Accuracy'], accounts: ['All financial statement line items'], objective: 'Financial statements are reviewed for accuracy and reasonableness before release.', risk: 'Material misstatements are not detected prior to issuance.', activity: 'The {actor} reviews the draft financial statements and supporting flux analysis during "{task}", evidences the review with sign-off and documented follow-up of significant variances.' },
  { key: 'invoicing', re: /invoice dealer account|generate fleet invoice|generate deal worksheet/i, duty: 'record', title: 'Billing accuracy and completeness (shipped-not-billed review)', nature: 'Automated', type: 'Preventive', assertions: ['Occurrence', 'Completeness', 'Accuracy', 'Cut-off'], accounts: ['Revenue', 'Accounts Receivable'], objective: 'Every fulfilled order is billed once, at approved prices, in the correct period.', risk: 'Shipments are unbilled, double-billed or billed at incorrect prices.', activity: '{apps} generates the invoice in "{task}" from the fulfilment event using master-data pricing; a daily shipped-not-billed exception report is reviewed and cleared.' },
  { key: 'incentive_calc', re: /apply incentives & rebates|calculate incentive payouts/i, duty: 'record', cat: 'IT Application Control', estimate: true, title: 'Automated incentive / rebate calculation', nature: 'Automated', type: 'Preventive', assertions: ['Accuracy', 'Valuation & Allocation', 'Completeness'], accounts: ['Sales Incentive Accrual (Variable Consideration)', 'Revenue'], objective: 'Incentives are calculated in line with approved program rules and accrued as variable consideration.', risk: 'Incorrect program configuration misstates incentive accruals and net revenue.', activity: '{apps} calculates incentives in "{task}" from approved program rules (eligibility, rates, effective dates); program setup requires dual approval and changes follow program change controls.' },
  { key: 'price_master', re: /retrieve vehicle msrp|calculate invoice price|calculate volume pricing|retrieve base warranty pricing|calculate total price|develop custom pricing|calculate taxes & fees/i, duty: 'record', cat: 'IT Application Control', title: 'Price / tax master data maintenance and automated calculation', nature: 'Automated', type: 'Preventive', assertions: ['Accuracy'], accounts: ['Revenue', 'Sales Tax Payable'], objective: 'Transactions are priced from approved, current price and tax master data.', risk: 'Unauthorized or outdated pricing/tax rates misstate revenue and tax liabilities.', activity: '{apps} derives the amount in "{task}" from controlled master data; price and tax table changes require approval by Pricing / Tax and are logged and reviewed monthly.' },
  { key: 'residual_estimate', re: /calculate residual value|apply lease money factor|calculate wholesale market value|calculate disposition fees/i, duty: 'record', cat: 'IT Application Control', estimate: true, title: 'Residual / market value estimate inputs and model governance', nature: 'Automated', type: 'Preventive', assertions: ['Valuation & Allocation'], accounts: ['Operating Lease Assets', 'Residual Value Reserve', 'Used Vehicle Inventory (NRV)'], objective: 'Valuation inputs (residual curves, money factors, market values) are approved and applied consistently.', risk: 'Inappropriate valuation assumptions misstate lease assets, residual reserves and gain/loss on disposal.', activity: '{apps} applies the approved residual curve / market-value source in "{task}"; assumption tables are approved quarterly by the Residual Value Committee and back-tested against auction results.' },
  { key: 'risk_adjustment', re: /apply vehicle-specific risk adjustment|calculate claim amount/i, duty: 'record', cat: 'IT Application Control', estimate: true, title: 'Automated claim / risk-rating calculation', nature: 'Automated', type: 'Preventive', assertions: ['Accuracy', 'Valuation & Allocation'], accounts: ['Warranty Expense', 'Deferred Revenue (Service Contracts)', 'Claims Reserves'], objective: 'Claim amounts and risk ratings are calculated from approved labor-time / rate tables.', risk: 'Incorrect rate tables misstate warranty expense, claim payables or service-contract pricing.', activity: '{apps} computes the amount in "{task}" from approved labor-time standards, parts prices and risk-rating tables; table changes are approved by Warranty / Actuarial and follow program change controls.' },
  { key: 'credit_decision', re: /calculate credit score|review approval conditions|receive instant credit decision/i, duty: 'authorize', estimate: true, title: 'Credit decision within approved underwriting policy', nature: 'IT-Dependent Manual', type: 'Preventive', assertions: ['Valuation & Allocation', 'Existence'], accounts: ['Finance Receivables', 'Allowance for Credit Losses (CECL)'], objective: 'Credit is extended only within approved underwriting policy and scorecard cut-offs.', risk: 'Credit extended outside policy increases expected losses not reflected in the allowance.', activity: '{apps} applies the approved scorecard and cut-offs in "{task}"; policy exceptions require documented approval by a credit officer with exception authority, and exception rates are reported monthly.' },
  { key: 'contract_docs', re: /generate (loan|lease|warranty contract|contract) doc|generate lease agreement|generate contract documents|verify contract completeness|verify all documents complete/i, duty: 'record', title: 'Contract document completeness and agreement to approved deal', nature: 'IT-Dependent Manual', type: 'Preventive', assertions: ['Rights & Obligations', 'Accuracy', 'Existence'], accounts: ['Finance Receivables', 'Revenue', 'Deferred Revenue'], objective: 'Contract documents agree to the approved deal terms and are complete before booking.', risk: 'Booked contracts differ from approved terms or are unenforceable.', activity: 'Documents produced in "{task}" are generated by {apps} from the approved deal record; a completeness checklist is evidenced by the {actor} and booking is blocked until required documents are present.' },
  { key: 'deferral_setup', re: /register gap coverage|submit contract to vsc administrator|apply cpo warranty coverage|link warranty to vehicle vin|add to finance contract/i, duty: 'record', title: 'Service-contract / coverage registration drives revenue deferral', nature: 'Automated', type: 'Preventive', assertions: ['Completeness', 'Cut-off', 'Valuation & Allocation'], accounts: ['Deferred Revenue (Service Contracts)', 'Revenue', 'Claims Reserves'], objective: 'Every sold contract is registered with the correct term so revenue is deferred and recognized over the coverage period.', risk: 'Unregistered or mis-dated contracts misstate deferred revenue and the related reserve.', activity: 'On "{task}", {apps} registers the contract with sale date, term and price; a weekly reconciliation of contracts sold (dealer sales records) to contracts registered is reviewed and exceptions cleared.' },
  { key: 'coverage_check', re: /verify warranty coverage/i, duty: 'record', cat: 'IT Application Control', title: 'Automated warranty eligibility validation', nature: 'Automated', type: 'Preventive', assertions: ['Occurrence', 'Valuation & Allocation'], accounts: ['Warranty Expense', 'Product Warranty Reserve'], objective: 'Only claims within coverage (time, mileage, component) are accepted.', risk: 'Out-of-coverage claims are paid, misstating warranty expense and the reserve experience data.', activity: '{apps} validates VIN, in-service date, mileage and covered component in "{task}"; ineligible claims are rejected or routed for goodwill review.' },
  { key: 'transfer_of_control', re: /sign delivery confirmation|complete fleet delivery|complete wholesale sale|confirm delivery condition|deliver vehicle|ship to dealer|process turn-in or purchase/i, duty: 'record', title: 'Revenue recognized on transfer of control (cut-off)', nature: 'IT-Dependent Manual', type: 'Preventive', assertions: ['Cut-off', 'Occurrence'], accounts: ['Revenue', 'Cost of Sales', 'Inventory'], objective: 'Revenue and cost of sales are recorded in the period control transfers to the customer.', risk: 'Revenue is recognized before delivery / acceptance, or in the wrong period.', activity: 'The delivery / acceptance event captured in "{task}" ({apps}) is the system trigger for revenue recognition; period-end in-transit and bill-and-hold items are reviewed for cut-off.' },
  { key: 'cycle_count', re: /perform cycle counts/i, duty: 'custody', title: 'Inventory cycle counts with independent recount', nature: 'Manual', type: 'Detective', assertions: ['Existence', 'Completeness'], accounts: ['Inventory'], objective: 'Perpetual inventory quantities agree to physical quantities.', risk: 'Inventory records are overstated or understated.', activity: 'The {actor} performs ABC-stratified cycle counts during "{task}" using count sheets that hide system quantity; variances above tolerance are recounted by an independent counter before adjustment.' },
  { key: 'inventory_record', re: /update (system|inventory) records|update inventory (status|location|levels)|update inventory if returned|record build data|add to cpo inventory listing/i, duty: 'record', title: 'Automated perpetual inventory update', nature: 'Automated', type: 'Preventive', assertions: ['Existence', 'Accuracy', 'Cut-off'], accounts: ['Inventory', 'Cost of Sales'], objective: 'Inventory movements are recorded completely and accurately when they occur.', risk: 'Inventory movements are not recorded or recorded in the wrong period.', activity: '{apps} updates the perpetual record automatically in "{task}" from the triggering transaction; failed updates are logged to an error queue reviewed daily.' },
  { key: 'inventory_reserve', re: /quarantine affected units|estimate reconditioning cost/i, duty: 'record', estimate: true, title: 'Inventory valuation adjustment for quarantined / reconditioned units', nature: 'IT-Dependent Manual', type: 'Detective', assertions: ['Valuation & Allocation'], accounts: ['Inventory', 'Inventory Reserve (NRV)'], objective: 'Units with quality holds or reconditioning costs are carried at the lower of cost and NRV.', risk: 'Impaired units are carried above net realizable value.', activity: 'Units flagged in "{task}" are held in a restricted status in {apps}; the inventory controller reviews the held-unit / recon-cost report monthly and records valuation adjustments.' },
  { key: 'aging_ipe', re: /generate ar aging report|identify delinquent accounts|identify past due accounts/i, duty: 'record', cat: 'IT Application Control', estimate: true, title: 'Aging / delinquency report accuracy (IPE)', nature: 'Automated', type: 'Detective', assertions: ['Valuation & Allocation', 'Completeness'], accounts: ['Accounts Receivable', 'Allowance for Credit Losses'], objective: 'Aging buckets used in the allowance are complete and correctly calculated.', risk: 'Report logic errors misstate the aging used to estimate the allowance.', activity: 'The aging produced in "{task}" by {apps} is a standard report under change control; each period, report totals are agreed to the GL and a sample of items is re-aged.' },
  { key: 'term_modification', re: /negotiate payment (terms|plan)|structure deal to requirements/i, duty: 'authorize', estimate: true, title: 'Payment-term modification approval', nature: 'IT-Dependent Manual', type: 'Preventive', assertions: ['Valuation & Allocation'], accounts: ['Accounts Receivable', 'Finance Receivables', 'Allowance for Credit Losses'], objective: 'Modifications to payment terms are approved and reflected in loss estimates.', risk: 'Unapproved modifications mask delinquency and understate the allowance.', activity: 'Term modifications agreed by the {actor} in "{task}" are recorded in {apps} and require supervisor approval above defined limits; modified accounts are flagged for allowance modeling.' },
  { key: 'po_authorization', re: /create purchase orders|submit purchase order|submit factory order|submit bulk production order|finalize fleet order/i, duty: 'record', title: 'Order authorization and approval workflow', nature: 'IT-Dependent Manual', type: 'Preventive', assertions: ['Occurrence', 'Rights & Obligations'], accounts: ['Purchase Commitments / Accounts Payable', 'Revenue'], objective: 'Orders are created only by authorized users and approved within limits.', risk: 'Unauthorized orders create unrecorded obligations or fictitious sales.', activity: 'Orders raised in "{task}" in {apps} require an approved requisition / customer agreement and route for approval based on value; the system prevents the requester from approving.' },
  { key: 'vendor_invoice', re: /receive vendor invoice|process supplier invoice/i, duty: 'record', title: 'Vendor invoice entry with duplicate-invoice check', nature: 'IT-Dependent Manual', type: 'Preventive', assertions: ['Occurrence', 'Accuracy'], accounts: ['Accounts Payable'], objective: 'Each valid vendor invoice is entered once, accurately, against a valid vendor.', risk: 'Duplicate or fictitious invoices are recorded and paid.', activity: 'The {actor} enters invoices in "{task}" in {apps}; the system blocks duplicates (vendor + invoice number + amount) and invoices to inactive / unapproved vendors.' },
  { key: 'loyalty_liability', re: /accumulate loyalty points|process redemption/i, duty: 'record', estimate: true, title: 'Loyalty points liability (material right) recording', nature: 'Automated', type: 'Preventive', assertions: ['Completeness', 'Valuation & Allocation'], accounts: ['Deferred Revenue (Loyalty Points)', 'Revenue'], objective: 'Points earned and redeemed are recorded so the outstanding liability is complete.', risk: 'Points liability is understated or breakage is misestimated.', activity: '{apps} records points earned/redeemed in "{task}" and produces a monthly points roll-forward reconciled to the GL deferred revenue balance.' },
  { key: 'subscription_activation', re: /activate renewed services|activate subscription|fulfill digital service|activate trial services/i, duty: 'record', title: 'Subscription activation drives ratable revenue recognition', nature: 'Automated', type: 'Preventive', assertions: ['Cut-off', 'Occurrence', 'Valuation & Allocation'], accounts: ['Deferred Revenue (Subscriptions)', 'Revenue'], objective: 'Subscription revenue begins only on activation and is recognized ratably over the service term.', risk: 'Revenue is recognized up-front or before service activation.', activity: 'Activation in "{task}" ({apps}) passes the service start date and term to billing; deferred revenue schedules are generated automatically and the deferral roll-forward is reviewed monthly.' },
  { key: 'title_transfer', re: /process title transfer/i, duty: 'record', title: 'Title transfer and lien release on vehicle disposal', nature: 'IT-Dependent Manual', type: 'Preventive', assertions: ['Rights & Obligations', 'Cut-off'], accounts: ['Inventory', 'Gain/Loss on Disposal'], objective: 'Vehicles are derecognized only when title transfers, with liens released.', risk: 'Vehicles are derecognized before legal transfer or liens remain recorded.', activity: 'Title transfer in "{task}" via {apps} is matched to the completed sale record before the unit is relieved from inventory; open titles over 30 days are reviewed.' },
  { key: 'recall_population', re: /identify affected vehicles/i, duty: 'record', estimate: true, title: 'Recall population completeness for accrual', nature: 'Automated', type: 'Detective', assertions: ['Completeness', 'Valuation & Allocation'], accounts: ['Recall Accrual'], objective: 'The affected-VIN population used for the recall accrual is complete.', risk: 'An incomplete VIN population understates the recall accrual.', activity: '{apps} derives affected VINs in "{task}" from the build records for the affected component and date range; the VIN count is reconciled to production records before the accrual is booked.' },
  { key: 'recall_claims', re: /report completion to oem/i, duty: 'record', title: 'Recall repair completion claims validation', nature: 'Automated', type: 'Preventive', assertions: ['Occurrence', 'Accuracy'], accounts: ['Recall Accrual', 'Dealer Payables'], objective: 'Only completed recall repairs on affected VINs are reimbursed and relieved from the accrual.', risk: 'Invalid recall claims are paid or relieved from the accrual.', activity: 'Completion reports in "{task}" are validated by {apps} against the affected-VIN list and labor-op codes before claim payment.' },
  { key: 'contingency', re: /assess liability/i, duty: 'review', estimate: true, title: 'ASC 450 loss-contingency assessment', nature: 'Manual', type: 'Detective', assertions: ['Completeness', 'Valuation & Allocation', 'Presentation & Disclosure'], accounts: ['Accrued Liabilities (Litigation)', 'Contingency Disclosures'], objective: 'Probable and estimable losses are accrued and reasonably possible losses are disclosed.', risk: 'Litigation losses are not accrued or disclosed.', activity: 'The {actor} assesses probability and estimability for each matter during "{task}"; the quarterly legal matters schedule from {apps} is reviewed with the Controller and General Counsel, and accruals / disclosures are approved.' },
  { key: 'risk_committee', re: /present to risk committee/i, duty: 'review', title: 'Fraud and financial-reporting risk assessment (entity level)', nature: 'Manual', type: 'Detective', keyControl: false, assertions: ['All assertions (entity level)'], accounts: ['Entity-level'], objective: 'Risks to reliable financial reporting, including fraud risk, are identified and responded to.', risk: 'Significant new risks are not reflected in the control environment.', activity: 'The {actor} presents the risk assessment, including fraud risk factors, during "{task}"; the committee approves responses and changes to the control library are tracked in {apps}.' },
  { key: 'disclosure_review', re: /review for accuracy/i, duty: 'review', title: 'Disclosure review of regulatory filings', nature: 'Manual', type: 'Detective', assertions: ['Presentation & Disclosure', 'Accuracy'], accounts: ['Disclosures'], objective: 'Regulatory filings are accurate and consistent with the financial statements.', risk: 'Filings contain errors or are inconsistent with reported results.', activity: 'The {actor} tie-outs figures in the draft filing to source reports from {apps} during "{task}" and evidences review before submission.' },
  { key: 'budget_approval', re: /finalize approved budget|finalize budget/i, duty: 'authorize', keyControl: false, title: 'Approved budget as basis for management review precision', nature: 'Manual', type: 'Detective', assertions: ['Valuation & Allocation (supports MRCs)'], accounts: ['Entity-level'], objective: 'An approved budget exists as the expectation used in budget-vs-actual review controls.', risk: 'Review controls rely on an unapproved or outdated expectation, reducing their precision.', activity: 'The {actor} approves the final budget during "{task}"; the approved version is locked in {apps} and used as the baseline for monthly variance reviews.' },
];

// ─── ITGC library (application level) ──────────────────────────────────────
const ITGC = {
  AC01: { domain: 'Access to Programs & Data', title: 'User access provisioning on approved request', type: 'Preventive', nature: 'IT-Dependent Manual', freq: 'Per request', objective: 'Access to {app} is granted only on approved request and consistent with job responsibilities.', risk: 'Users obtain access to {app} that enables unauthorized creation or changes to financial transactions.', activity: 'New or changed access to {app} is granted by IT ({itOwner}) only against an IT-SERVICE ticket approved by the user\'s manager and the application owner ({appOwner}), using predefined role templates.', test: 'Obtain the system-generated list of users added to {app} during the period; select a sample and inspect each for a manager- and owner-approved request dated before the access was granted, and agree the role granted to the role requested.', evidence: 'Approved IT-SERVICE access tickets; {app} user-creation audit log.', fw: ['COBIT 2019 DSS05.04', 'COSO 2013 Principle 11'] },
  AC02: { domain: 'Access to Programs & Data', title: 'Periodic user access recertification', type: 'Detective', nature: 'IT-Dependent Manual', freq: 'Quarterly', objective: 'Access to {app} remains appropriate over time.', risk: 'Inappropriate or excessive access to {app} persists undetected after role changes.', activity: 'The application owner ({appOwner}) reviews a complete, system-generated listing of {app} users and roles each {freqLower}, certifies appropriateness, and IT removes flagged access within 5 business days.', test: 'Inspect evidence of each review in the period; validate completeness and accuracy of the user listing (IPE) against the system; for revoked users, verify removal occurred timely.', evidence: 'Signed recertification workbook; user listing with extraction parameters; removal tickets.', fw: ['COBIT 2019 DSS05.04', 'COSO 2013 Principle 11'] },
  AC03: { domain: 'Access to Programs & Data', title: 'Privileged, database and OS administrator access restricted', type: 'Preventive', nature: 'IT-Dependent Manual', freq: 'Continuous / quarterly review', objective: 'Superuser access to {app}, its databases and servers is limited to appropriate IT personnel and its use is monitored.', risk: 'Privileged users make unauthorized direct changes to {app} data or configuration, bypassing application controls.', activity: 'Administrator, DBA and OS root/admin access to {app} infrastructure is restricted to named IT personnel via privileged-access management, generic accounts are vaulted, and privileged activity logs are reviewed by {itOwner} quarterly.', test: 'Obtain listings of privileged accounts at the application, database and OS layers for in-scope servers; inspect for appropriateness with IT management; inspect evidence of privileged activity log review.', evidence: 'Privileged account listings per layer; PAM vault configuration; log review sign-off.', fw: ['COBIT 2019 DSS05.04', 'DSS05.05', 'COSO 2013 Principle 11'] },
  AC04: { domain: 'Access to Programs & Data', title: 'Timely removal of access for terminated users', type: 'Preventive', nature: 'IT-Dependent Manual', freq: 'Per termination', objective: 'Access of terminated employees and contractors to {app} is removed timely.', risk: 'Former employees retain access to {app} and process unauthorized transactions.', activity: 'Terminations recorded in HR-CORE trigger automated deprovisioning of {app} accounts via identity management; IT reconciles the HR termination report to active {app} users weekly.', test: 'Obtain the HR termination listing for the period and compare to {app} active users and last-logon dates; for a sample, verify access was removed within the policy window (e.g., 1 business day).', evidence: 'HR termination report; deprovisioning tickets; {app} user list with last-logon.', fw: ['COBIT 2019 DSS05.04', 'COSO 2013 Principle 11'] },
  AC05: { domain: 'Access to Programs & Data', title: 'Segregation-of-duties ruleset enforced in role design', type: 'Preventive', nature: 'Automated', freq: 'Continuous', objective: 'No single {app} user can perform conflicting duties (e.g., create vendor and approve payment).', risk: 'Users with conflicting access commit and conceal errors or fraud.', activity: '{app} roles are designed against a documented SoD ruleset; a GRC tool analyzes user-role assignments monthly and conflicts are either removed or approved with a documented mitigating control.', test: 'Re-perform the SoD analysis on the user-role extract at period end; inspect approvals and mitigating controls for remaining conflicts.', evidence: 'SoD ruleset; GRC conflict report; mitigating control approvals.', fw: ['COBIT 2019 DSS05.04', 'COSO 2013 Principle 10'] },
  CM01: { domain: 'Program Change', title: 'Changes authorized, tested and approved before production', type: 'Preventive', nature: 'IT-Dependent Manual', freq: 'Per change', objective: 'Only authorized, tested and approved changes to {app} programs and configuration reach production.', risk: 'Unauthorized or untested changes alter {app} financial processing logic or automated controls.', activity: 'All changes to {app} (code, configuration, interfaces, reports) are logged in IT-SERVICE, tested by users independent of development, and approved by the Change Advisory Board before migration.', test: 'Obtain a system-generated list of production changes to {app} (from the change log / deployment tool, not the ticketing system alone); for a sample, inspect testing evidence and CAB approval dated before deployment.', evidence: 'IT-SERVICE change tickets; UAT sign-offs; deployment logs.', fw: ['COBIT 2019 BAI06.01', 'COSO 2013 Principle 11'] },
  CM02: { domain: 'Program Change', title: 'Developer access to production restricted', type: 'Preventive', nature: 'IT-Dependent Manual', freq: 'Continuous', objective: 'Developers cannot migrate changes to, or directly modify, {app} production.', risk: 'Developers introduce unapproved code into {app} production.', activity: 'Production migration rights for {app} are restricted to a release-management group independent of development; developer accounts have read-only production access.', test: 'Inspect the list of users with migration rights and production write access; agree to job roles to confirm no developers.', evidence: 'Deployment tool permission listing; HR job titles.', fw: ['COBIT 2019 BAI06.01', 'BAI07', 'COSO 2013 Principle 11'] },
  OP01: { domain: 'Computer Operations', title: 'Batch job and interface monitoring', type: 'Detective', nature: 'IT-Dependent Manual', freq: 'Daily', objective: 'Scheduled jobs and interfaces feeding or fed by {app} complete successfully and failures are resolved.', risk: 'Failed jobs or interfaces cause incomplete processing of financial transactions.', activity: 'IT operations monitors {app} batch jobs and inbound/outbound interfaces daily through the scheduler / integration console; failures generate incidents in IT-SERVICE that are tracked to resolution and reprocessing.', test: 'Inspect the job schedule and interface inventory; for a sample of days, inspect monitoring evidence and, for failures, the incident and reprocessing evidence.', evidence: 'Job scheduler logs; integration console; IT-SERVICE incidents.', fw: ['COBIT 2019 DSS01.01', 'COSO 2013 Principle 11'] },
  OP02: { domain: 'Computer Operations', title: 'Backup and recoverability of financial data', type: 'Preventive', nature: 'IT-Dependent Manual', freq: 'Daily backups / annual restore test', objective: '{app} financial data is backed up and can be restored completely and accurately.', risk: 'Financial data in {app} is lost or cannot be restored after an incident.', activity: '{app} production databases and servers are backed up per schedule; backup failures are investigated, and a restore test is performed at least annually.', test: 'Inspect backup configuration for in-scope servers; for a sample of days, inspect job success/failure resolution; inspect the most recent restore test.', evidence: 'Backup tool job history; restore test report.', fw: ['COBIT 2019 DSS04.07', 'COSO 2013 Principle 11'] },
  OP03: { domain: 'Computer Operations', title: 'Infrastructure patch and vulnerability management', type: 'Preventive', nature: 'IT-Dependent Manual', freq: 'Monthly', objective: 'Servers hosting {app} are patched and vulnerabilities remediated within policy timeframes.', risk: 'Unpatched vulnerabilities allow unauthorized access to {app} data or bypass of logical access controls.', activity: 'Servers supporting {app} are scanned monthly; critical and high vulnerabilities are remediated within 15 / 30 days and exceptions approved by the CISO.', test: 'Obtain scan results and patch compliance reports for in-scope servers; inspect remediation timeliness and approved exceptions.', evidence: 'Vulnerability scan reports; patch compliance dashboard; exception register.', fw: ['COBIT 2019 DSS05.01', 'DSS05.03', 'COSO 2013 Principle 11'] },
  PD01: { domain: 'Program Development', title: 'Data conversion and go-live approval for system upgrade', type: 'Preventive', nature: 'Manual', freq: 'Per project', objective: 'The planned {app} upgrade ({upgrade}) is tested and data is converted completely and accurately.', risk: 'Data is lost or altered during conversion, or the upgraded system processes transactions incorrectly.', activity: 'For the {upgrade} upgrade, data conversion is reconciled (record counts, control totals of balances) between legacy and upgraded {app}, UAT is signed off by the business, and go-live is approved by the steering committee.', test: 'Inspect the conversion reconciliation, UAT sign-off and go-live approval; re-perform tie-out of key balances.', evidence: 'Conversion reconciliation; UAT and go-live sign-offs.', fw: ['COBIT 2019 BAI03', 'BAI07', 'COSO 2013 Principle 11'] },
};
const ITGC_BY_TIER = {
  1: ['AC01', 'AC02', 'AC03', 'AC04', 'AC05', 'CM01', 'CM02', 'OP01', 'OP02', 'OP03', 'PD01'],
  2: ['AC01', 'AC02', 'AC03', 'AC04', 'CM01', 'OP01', 'OP02', 'PD01'],
  3: ['AC02', 'AC03', 'CM01'],
};
const UNCATALOGED_ITGCS = ['AC01', 'AC02', 'CM01'];

const SAMPLE_SIZES = {
  Annual: '1', Quarterly: '2', Monthly: '2–5', Weekly: '5–15', Daily: '20–40',
  'Per transaction': '25–60', 'Per request': '25–40', 'Per termination': '25–40', 'Per change': '25–40',
  'Per payroll cycle': '2–5', 'Per project': '1',
};
function sampleSizeFor(nature, freq) {
  if (nature === 'Automated') return '1 (test of one), relying on effective ITGCs over the application';
  const key = Object.keys(SAMPLE_SIZES).find((k) => String(freq).startsWith(k));
  return key ? `${SAMPLE_SIZES[key]} (${freq.toLowerCase()} control)` : 'Per auditor judgment';
}
function riskFromScore(score) {
  if (score >= 3) return 'High';
  if (score === 2) return 'Medium';
  return 'Low';
}
const fill = (tpl, vars) => String(tpl).replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined && vars[k] !== null && vars[k] !== '' ? vars[k] : `{${k}}`));

// Same $getField approach as routes/dashboard.js — the FK key contains a
// literal "." and is spelled "Component"/"Components" inconsistently.
const fkAppIdFieldExpr = () => ({
  $ifNull: [
    { $getField: { field: 'FK_System Component[Applications].APP_ID', input: '$values' } },
    { $getField: { field: 'FK_System Components[Applications].APP_ID', input: '$values' } },
  ],
});

async function main() {
  await mongoose.connect(MONGO_URI);
  console.log(`[sox] connected; batch ${BATCH_ID}${dryRun ? ' (dry run)' : ''}`);

  // ── Load applications ──
  const appRows = await CanonicalData.find({ neighborhoodName: NEIGHBORHOOD, componentType: 'Applications' }).lean();
  const appByAcronym = new Map();
  const acronymByAppId = new Map();
  for (const row of appRows) {
    const v = row.values || {};
    const acronym = String(v['APP_ACRONYM Component'] || row.primaryKey).trim();
    appByAcronym.set(acronym, { row, v, acronym, appId: v['APP_ID Qualifier'] || null });
    if (v['APP_ID Qualifier']) acronymByAppId.set(String(v['APP_ID Qualifier']), acronym);
  }
  const inScopeAppIds = Object.keys(IN_SCOPE_APPS).map((a) => appByAcronym.get(a)?.appId).filter(Boolean);
  console.log(`[sox] ${appRows.length} applications, ${inScopeAppIds.length} cataloged in-scope`);

  // ── Load servers + database/IAM software for in-scope apps only ──
  const servers = await CanonicalData.aggregate([
    { $match: { neighborhoodName: NEIGHBORHOOD, componentType: 'Servers' } },
    { $addFields: { _appId: fkAppIdFieldExpr() } },
    { $match: { _appId: { $in: inScopeAppIds } } },
    { $project: {
      _appId: 1, primaryKey: 1,
      name: '$values.SERVER_NAME Component', serverId: '$values.SERVER_ID Qualifier', role: '$values.SERVER_ROLE Aggregate',
      networkZone: '$values.NETWORK_ZONE Aggregate', patchingStatus: '$values.PATCHING_STATUS Qualifier', complianceStatus: '$values.COMPLIANCE_STATUS Aggregate',
      backupStatus: '$values.BACKUP_STATUS Qualifier', encryptionStatus: '$values.ENCRYPTION_STATUS Qualifier', criticalVulns: '$values.CRITICAL_VULNS Qualifier',
      osName: '$values.OS_NAME Aggregate', osEol: '$values.OS_EOL_DATE Qualifier',
    } },
  ]);
  const software = await CanonicalData.aggregate([
    { $match: { neighborhoodName: NEIGHBORHOOD, componentType: 'Software', 'values.SOFTWARE_FUNCTION Aggregate': { $in: ['Database', 'DB Management', 'NoSQL', 'IAM'] } } },
    { $addFields: { _appId: fkAppIdFieldExpr() } },
    { $match: { _appId: { $in: inScopeAppIds } } },
    { $project: {
      _appId: 1, primaryKey: 1,
      name: '$values.SOFTWARE_NAME Component', softwareId: '$values.SOFTWARE_ID Qualifier', version: '$values.VERSION Qualifier',
      fn: '$values.SOFTWARE_FUNCTION Aggregate', knownIssues: '$values.KNOWN_SECURITY_ISSUES Qualifier', endOfSupport: '$values.END_OF_SUPPORT_DATE Qualifier',
      serverId: { $getField: { field: 'FK_System Components[Servers].SERVER_ID', input: '$values' } },
    } },
  ]);
  const serversByAppId = new Map();
  for (const s of servers) { if (!serversByAppId.has(s._appId)) serversByAppId.set(s._appId, []); serversByAppId.get(s._appId).push(s); }
  const softwareByAppId = new Map();
  for (const s of software) { if (!softwareByAppId.has(s._appId)) softwareByAppId.set(s._appId, []); softwareByAppId.get(s._appId).push(s); }
  console.log(`[sox] ${servers.length} in-scope servers, ${software.length} database/IAM software rows`);

  // ── Load APIs ──
  const apiRows = await CanonicalData.find({ neighborhoodName: NEIGHBORHOOD, componentType: 'APIs' }).lean();
  const apis = apiRows.map((row) => {
    const v = row.values || {};
    const name = String(v['API Name Component'] || '');
    const parts = name.split(' — ');
    const appId = String(v['FK_System Component[Applications].APP_ID'] || v['FK_System Components[Applications].APP_ID'] || '');
    return {
      primaryKey: row.primaryKey,
      apiId: v['API ID Qualifier'] || row.primaryKey,
      name,
      flowKey: parts.length > 1 ? norm(decodeEntities(parts[0])) : '',
      taskKey: parts.length > 1 ? norm(decodeEntities(parts.slice(1).join(' — ').replace(/\s+API$/i, ''))) : '',
      endpoint: v['Endpoint Qualifier'] || '',
      method: v['HTTP Method Aggregate'] || '',
      apiType: v['API Type Aggregate'] || '',
      interactionScope: v['Interaction Scope Aggregate'] || '',
      lifecycle: v['Lifecycle Status Aggregate'] || '',
      description: v['Description Qualifier'] || '',
      appId,
      appAcronym: acronymByAppId.get(appId) || null,
    };
  });
  const apisByFlowTask = new Map();
  for (const api of apis) {
    if (!api.flowKey) continue;
    const key = `${api.flowKey}|${api.taskKey}`;
    if (!apisByFlowTask.has(key)) apisByFlowTask.set(key, []);
    apisByFlowTask.get(key).push(api);
  }

  // ── Load diagrams ──
  const diagrams = await Diagram.find({}, { name: 1, domain: 1, subdomain: 1, businessFlow: 1, tasks: 1 }).lean();
  console.log(`[sox] ${apis.length} APIs, ${diagrams.length} diagrams`);

  const controls = [];
  const appItgcIds = new Map(); // acronym -> [controlId]
  const appInfraRisk = new Map(); // acronym -> short string, for task-control observations

  // ═══ 1. IT General Controls per in-scope application ═══
  for (const [acronym, scopeDef] of Object.entries(IN_SCOPE_APPS)) {
    const catalogApp = appByAcronym.get(acronym);
    const cataloged = scopeDef.cataloged !== false && Boolean(catalogApp);
    const v = catalogApp?.v || {};
    const appId = catalogApp?.appId || null;
    const appName = v['APP_NAME Qualifier'] || acronym;
    const appOwner = v['APPLICATION_OWNER Qualifier'] || 'the application owner';
    const itOwner = v['IT_OWNER Qualifier'] || 'the IT owner';
    const appServers = appId ? (serversByAppId.get(appId) || []) : [];
    const appSoftware = appId ? (softwareByAppId.get(appId) || []) : [];
    const dbServers = appServers.filter((s) => /database/i.test(s.role || ''));
    const dbSoftware = appSoftware.filter((s) => s.fn !== 'IAM');
    const iamSoftware = appSoftware.filter((s) => s.fn === 'IAM');
    const internetFacing = /^(yes|true|y)$/i.test(String(v['INTERNET_FACING Qualifier'] || ''));
    const pii = /pii|sensitive/i.test(String(v['DATA_CLASSIFICATION Aggregator'] || ''));
    const hosting = String(v['HOSTING_MODEL Aggregator'] || '');
    const saas = /public cloud|saas/i.test(hosting);
    const upgrade = String(v['NEXT_MAJOR_UPGRADE Qualifier'] || '');
    const upgradeYear = Number((upgrade.match(/(20\d\d)/) || [])[1] || 0);
    const upgradeInWindow = upgradeYear >= 2026 && upgradeYear <= 2027;
    const userBase = Number(v['USER_BASE_SIZE Qualifier'] || 0);

    const scopeApp = { name: acronym, appId, appName, businessCriticality: v['BUSINESS_CRITICALITY Aggregator'] || null, dataClassification: v['DATA_CLASSIFICATION Aggregator'] || null };
    const toScopeServer = (s) => ({ serverId: s.serverId || s.primaryKey, name: s.name, role: s.role, networkZone: s.networkZone, patchingStatus: s.patchingStatus, complianceStatus: s.complianceStatus, backupStatus: s.backupStatus, encryptionStatus: s.encryptionStatus, criticalVulns: Number(s.criticalVulns || 0) });
    const toScopeDb = (s) => ({ softwareId: s.softwareId || s.primaryKey, name: s.name, version: String(s.version ?? ''), serverId: s.serverId || null, function: s.fn });

    // Infrastructure facts
    const behind = appServers.filter((s) => s.patchingStatus && s.patchingStatus !== 'Current');
    const critical = appServers.filter((s) => s.patchingStatus === 'Critical');
    const nonCompliant = appServers.filter((s) => s.complianceStatus === 'Non-Compliant');
    const critVulns = appServers.reduce((sum, s) => sum + Number(s.criticalVulns || 0), 0);
    const osEol = appServers.filter((s) => Number(s.osEol) > 0 && Number(s.osEol) < TODAY_SERIAL);
    const weeklyDbBackups = dbServers.filter((s) => s.backupStatus === 'Weekly');
    const dbWithIssues = dbSoftware.filter((s) => s.knownIssues && !/^none$/i.test(String(s.knownIssues)));
    const dbEos = dbSoftware.filter((s) => Number(s.endOfSupport) > 0 && Number(s.endOfSupport) < TODAY_SERIAL);
    if (appServers.length) {
      appInfraRisk.set(acronym, `${critical.length}/${appServers.length} servers patching status Critical, ${nonCompliant.length} Non-Compliant`);
    }

    const codes = cataloged ? ITGC_BY_TIER[scopeDef.tier] : UNCATALOGED_ITGCS;
    const ids = [];
    let nn = 0;
    for (const code of codes) {
      if (code === 'PD01' && !upgradeInWindow) continue;
      const t = ITGC[code];
      nn += 1;
      const freq = code === 'AC02' ? (scopeDef.tier === 1 ? 'Quarterly' : 'Semi-annual') : t.freq;
      const vars = { app: acronym, appOwner, itOwner, upgrade, freqLower: freq === 'Quarterly' ? 'quarter' : 'six months' };
      const controlId = `SOX-ITGC-${code}-${acronym}`;
      const observations = [];
      let score = scopeDef.tier === 1 ? 2 : scopeDef.tier === 2 ? 1 : 0;
      const scope = { level: 'application', applications: [scopeApp], businessFlows: [], tasks: [], apis: [], servers: [], databases: [] };

      if (!cataloged) {
        observations.push(`${acronym} is used by in-scope business flows but is not in the application catalog — no owner, server or database inventory exists to evidence this control. Scoping gap: the IT-dependent controls that rely on ${acronym} cannot be supported by ITGC testing until it is inventoried.`);
        score += 2;
      }
      if (code.startsWith('AC')) {
        if (internetFacing) { observations.push(`${acronym} is internet-facing — external attack surface increases the importance of strong authentication and access controls.`); score += 1; }
        if (pii) observations.push(`Data classification is ${v['DATA_CLASSIFICATION Aggregator']} (${v['DATA_ENTITIES Qualifier'] || 'customer data'}).`);
        if (userBase >= 5000 && (code === 'AC01' || code === 'AC02')) { observations.push(`User base of ${userBase.toLocaleString('en-US')} — large population; recertification completeness (IPE over the user listing) is a common audit exception.`); score += 1; }
      }
      if (code === 'AC03' && cataloged) {
        scope.servers = dbServers.map(toScopeServer);
        scope.databases = dbSoftware.map(toScopeDb);
        observations.push(`${dbServers.length} database server(s) and ${dbSoftware.length} database / DB-management software installation(s) in scope (${[...new Set(dbSoftware.map((s) => s.name))].join(', ') || 'none inventoried'}).`);
        if (dbWithIssues.length) { observations.push(`${dbWithIssues.length} database software installation(s) carry known security issues (${[...new Set(dbWithIssues.map((s) => s.knownIssues))].slice(0, 3).join(', ')}).`); score += 1; }
        if (dbEos.length) { observations.push(`${dbEos.length} database software installation(s) are past vendor end-of-support.`); score += 1; }
        if (iamSoftware.length) observations.push(`Centralized IAM component inventoried (${[...new Set(iamSoftware.map((s) => s.name))].join(', ')}) on ${iamSoftware.length} server(s).`);
        else observations.push('No IAM / privileged-access component is inventoried for this application — confirm how privileged access is managed.');
        if (!dbServers.length && !dbSoftware.length) observations.push('No database tier inventoried — confirm where financial data is persisted (vendor-hosted?).');
      }
      if (code === 'AC04' && acronym === 'HR-CORE') observations.push('HR-CORE is itself the authoritative termination feed for all other applications\' deprovisioning — its completeness is relied upon enterprise-wide.');
      if (code.startsWith('CM')) {
        if (saas) observations.push(`Hosting model is "${hosting}" — vendor-managed releases are carved out; obtain the vendor SOC 1 Type II report and test complementary user entity controls (CUECs).`);
        if (upgrade) observations.push(`Next major upgrade planned: ${upgrade}.`);
      }
      if (code === 'OP01' && appId) {
        const appApis = apis.filter((a) => a.appId === appId && a.interactionScope === 'Cross-application');
        scope.apis = appApis.map((a) => ({ apiId: a.apiId, name: a.name, endpoint: a.endpoint, method: a.method, apiType: a.apiType, interactionScope: a.interactionScope }));
        observations.push(`${appApis.length} cross-application API(s) owned by ${acronym} in the interface inventory.`);
        const unmapped = apis.filter((a) => a.appId === appId && /mapping required/i.test(a.lifecycle));
        if (unmapped.length) { observations.push(`${unmapped.length} API(s) flagged "application mapping required" — interface ownership undefined, so failures may go unmonitored.`); score += 1; }
      }
      if (code === 'OP02') {
        scope.servers = appServers.map(toScopeServer);
        const byStatus = appServers.reduce((acc, s) => { acc[s.backupStatus || 'Unknown'] = (acc[s.backupStatus || 'Unknown'] || 0) + 1; return acc; }, {});
        observations.push(`${appServers.length} server(s) in scope; backup cadence: ${Object.entries(byStatus).map(([k, c]) => `${k} ${c}`).join(', ') || 'none recorded'}.`);
        if (weeklyDbBackups.length) { observations.push(`${weeklyDbBackups.length} database server(s) are backed up only weekly — RPO (${v['RPO_HOURS Qualifier'] ?? '?'}h) may not be achievable for financial data.`); score += 1; }
      }
      if (code === 'OP03') {
        scope.servers = appServers.map(toScopeServer);
        observations.push(`${behind.length} of ${appServers.length} server(s) not patching-current (${critical.length} Critical); ${nonCompliant.length} Non-Compliant; ${critVulns} open critical vulnerabilities.`);
        if (osEol.length) observations.push(`${osEol.length} server(s) run an operating system past end-of-life.`);
        if (pct(critical.length, appServers.length) >= 20 || nonCompliant.length >= 5 || critVulns >= 10) score += 1;
      }
      if (code === 'PD01') { observations.push(`Upgrade window ${upgrade} overlaps the audit period — conversion controls are in scope for the year of go-live.`); score += 1; }

      const auditRisk = riskFromScore(score);
      controls.push({
        controlId,
        title: `${t.title} — ${acronym}`,
        description: fill(t.activity, vars),
        controlObjective: fill(t.objective, vars),
        riskStatement: fill(t.risk, vars),
        category: 'IT General Control',
        itgcDomain: t.domain,
        processCycle: 'ITG',
        processCycleName: CYCLE_NAMES.ITG,
        controlType: t.type,
        controlNature: t.nature,
        frequency: freq,
        keyControl: scopeDef.tier !== 3 || code === 'CM01' || code === 'AC03',
        assertions: ['Supports all assertions for accounts processed by ' + acronym],
        financialStatementAccounts: scopeDef.accounts,
        controlOwner: code === 'AC02' ? appOwner : itOwner,
        performedBy: code === 'AC02' ? `${appOwner} (application owner)` : `${itOwner} (IT owner)`,
        evidence: fill(t.evidence, vars),
        testingProcedure: fill(t.test, vars),
        sampleSize: sampleSizeFor(t.nature, freq),
        auditRisk,
        auditRiskRationale: `Tier ${scopeDef.tier} application (${scopeDef.rationale})${observations.length ? ' Data-driven risk factors are listed under observations.' : ''}`,
        observations,
        frameworkRefs: ['PCAOB AS 2201', ...t.fw],
        scope,
        anchors: { diagramIds: [], taskKeys: [], applicationKeys: [norm(acronym)] },
      });
      ids.push(controlId);
    }
    appItgcIds.set(acronym, ids);
  }

  // ═══ 2. Business process controls (+ 3. interface controls) per flow ═══
  const inScopeDiagrams = diagrams
    .map((d) => ({ ...d, cleanName: decodeEntities(d.name) }))
    .filter((d) => FLOW_CYCLES[d.cleanName])
    .sort((a, b) => a.cleanName.localeCompare(b.cleanName));
  const cycleCounters = {};
  const nextId = (cycle) => { cycleCounters[cycle] = (cycleCounters[cycle] || 0) + 1; return `SOX-${cycle}-${String(cycleCounters[cycle]).padStart(3, '0')}`; };
  const apiControlById = new Map();

  for (const d of inScopeDiagrams) {
    const cycle = FLOW_CYCLES[d.cleanName];
    const diagramId = String(d._id);
    const flowScope = { diagramId, name: d.cleanName, domain: decodeEntities(d.domain), subdomain: decodeEntities(d.subdomain) };
    const tasks = d.tasks || [];
    const flowApps = [...new Set(tasks.flatMap((t) => (t.applications || []).map((a) => a.name)).filter(Boolean))];
    const scopeAppsFor = (names) => names.map((name) => {
      const c = appByAcronym.get(name);
      return { name, appId: c?.appId || null, appName: c?.v['APP_NAME Qualifier'] || name, businessCriticality: c?.v['BUSINESS_CRITICALITY Aggregator'] || null, dataClassification: c?.v['DATA_CLASSIFICATION Aggregator'] || null };
    });

    // Match tasks to rules first so SoD can be evaluated across the flow.
    const matched = tasks.map((task) => ({ task, rule: TASK_RULES.find((r) => r.re.test(task.name || '')) || null }));
    const dutiesByActor = new Map();
    for (const { task, rule } of matched) {
      const actor = String(task.actor || '').trim();
      if (!rule || !actor || /^(system|customer|null)$/i.test(actor)) continue;
      if (!dutiesByActor.has(actor)) dutiesByActor.set(actor, new Map());
      const duties = dutiesByActor.get(actor);
      if (!duties.has(rule.duty)) duties.set(rule.duty, []);
      duties.get(rule.duty).push(task.name);
    }
    const sodConflicts = [];
    for (const [actor, duties] of dutiesByActor) {
      const kinds = [...duties.keys()].filter((k) => k !== 'review');
      const conflicting = (kinds.includes('authorize') && kinds.length > 1) || (kinds.includes('custody') && kinds.includes('record'));
      if (conflicting) {
        sodConflicts.push({ actor, text: `Segregation-of-duties conflict: "${actor}" performs ${kinds.map((k) => `${k === 'custody' ? 'custody of assets' : k === 'record' ? 'recording' : 'authorization'} (${duties.get(k).join(', ')})`).join(' and ')} in this flow.`, tasks: kinds.flatMap((k) => duties.get(k)) });
      }
    }

    const flowControlIds = [];
    // Flow-level management review control
    {
      const mrc = FLOW_MRC[cycle];
      const controlId = nextId(cycle);
      const observations = [];
      sodConflicts.forEach((c) => observations.push(c.text));
      const uncataloged = flowApps.filter((a) => !appByAcronym.has(a));
      if (uncataloged.length) observations.push(`Applications used in this flow but missing from the application catalog: ${uncataloged.join(', ')}.`);
      const score = 1 + (sodConflicts.length ? 2 : 0) + (uncataloged.length ? 1 : 0);
      controls.push({
        controlId,
        title: `${mrc.title} — ${d.cleanName}`,
        description: fill(mrc.activity, { owner: mrc.owner, flow: d.cleanName }),
        controlObjective: `Errors in transactions processed through "${d.cleanName}" are detected at a level of precision that would prevent a material misstatement.`,
        riskStatement: `Errors or irregularities arising in "${d.cleanName}" go undetected and misstate ${[...new Set(flowApps.flatMap((a) => IN_SCOPE_APPS[a]?.accounts || []))].slice(0, 4).join(', ') || 'the related accounts'}.`,
        category: 'Business Process Control',
        itgcDomain: null,
        processCycle: cycle,
        processCycleName: CYCLE_NAMES[cycle],
        controlType: 'Detective',
        controlNature: 'IT-Dependent Manual',
        frequency: mrc.freq,
        keyControl: true,
        assertions: mrc.assertions,
        financialStatementAccounts: [...new Set(flowApps.flatMap((a) => IN_SCOPE_APPS[a]?.accounts || []))].slice(0, 6),
        controlOwner: mrc.owner,
        performedBy: mrc.owner,
        evidence: 'Signed review package with variance explanations, thresholds used, and follow-up of items investigated.',
        testingProcedure: 'Inspect the review for selected periods; assess precision (thresholds, level of disaggregation), evaluate whether investigated items were resolved appropriately, and test the completeness and accuracy of the reports (IPE) used in the review.',
        sampleSize: sampleSizeFor('Manual', mrc.freq),
        auditRisk: riskFromScore(score),
        auditRiskRationale: 'Management review controls are a frequent source of PCAOB inspection findings (precision and IPE).' + (sodConflicts.length ? ' Segregation-of-duties conflicts in the flow increase reliance on this detective control.' : ''),
        observations,
        frameworkRefs: ['PCAOB AS 2201', 'COSO 2013 Principle 10', 'PCAOB Staff Audit Practice Alert No. 11 (MRCs)'],
        scope: { level: 'businessFlow', applications: scopeAppsFor(flowApps), businessFlows: [flowScope], tasks: [], apis: [], servers: [], databases: [] },
        anchors: { diagramIds: [diagramId], taskKeys: [], applicationKeys: [] },
        relatedControlIds: [],
      });
      flowControlIds.push(controlId);
    }

    // Task-level controls
    const seenRuleInFlow = new Set();
    for (const { task, rule } of matched) {
      if (!rule) continue;
      const taskName = String(task.name || '').trim();
      const ruleFlowKey = `${rule.key}|${norm(taskName)}`;
      if (seenRuleInFlow.has(ruleFlowKey)) continue;
      seenRuleInFlow.add(ruleFlowKey);
      const taskApps = (task.applications || []).map((a) => a.name).filter(Boolean);
      const actor = String(task.actor || '').trim() && !/^null$/i.test(String(task.actor)) ? String(task.actor).trim() : 'process owner';
      const isSystem = /^system$/i.test(actor);
      const nature = rule.nature === 'Automated' || isSystem ? 'Automated' : rule.nature;
      const category = rule.cat || (nature === 'Automated' && !rule.cat ? 'IT Application Control' : 'Business Process Control');
      const vars = { task: taskName, flow: d.cleanName, actor: isSystem ? 'system' : actor, apps: taskApps.join(' / ') || 'the supporting application' };
      const controlId = rule.cat === 'IT General Control' ? nextId('ITG') : nextId(cycle);
      const observations = [];
      let score = 0;
      if (rule.estimate) { score += 2; observations.push('Supports a significant accounting estimate — auditors test the inputs, assumptions and model logic, not just approval.'); }
      if (nature !== 'Automated') score += 1;
      if (rule.duty === 'custody') { score += 1; observations.push('Custody of cash or assets — fraud (misappropriation) risk is presumed for this activity.'); }
      if (taskApps.some((a) => IN_SCOPE_APPS[a]?.tier === 1)) score += 1;
      const sod = sodConflicts.find((c) => c.tasks.includes(task.name));
      if (sod) { score += 2; observations.push(sod.text); }
      const uncataloged = taskApps.filter((a) => !appByAcronym.has(a));
      if (uncataloged.length) { score += 1; observations.push(`Relies on ${uncataloged.join(', ')}, which is not in the application catalog — ITGC reliance for this ${nature === 'Automated' ? 'automated' : 'IT-dependent'} control cannot be established.`); }
      for (const a of taskApps) {
        if (appInfraRisk.has(a) && IN_SCOPE_APPS[a]) observations.push(`Underlying ${a} infrastructure: ${appInfraRisk.get(a)}.`);
      }
      if (nature === 'Automated') observations.push('Automated control — a test of one is sufficient only if the ITGCs over the supporting application are effective for the full period (see related controls).');
      const relatedControlIds = [...new Set(taskApps.flatMap((a) => (appItgcIds.get(a) || []).filter((id) => /-(AC0[12]|CM01)-/.test(id))))];

      // Interface controls for the cross-application APIs supporting this task
      const taskApis = (apisByFlowTask.get(`${norm(d.cleanName)}|${norm(taskName)}`) || []).filter((a) => a.interactionScope === 'Cross-application');
      for (const api of taskApis) {
        const ifId = `SOX-ITAC-IF-${String(api.apiId).replace(/[^A-Za-z0-9]/g, '')}`;
        relatedControlIds.push(ifId);
        if (apiControlById.has(ifId)) {
          const existing = apiControlById.get(ifId);
          existing.anchors.taskKeys.push(`${diagramId}|${norm(taskName)}`);
          if (!existing.anchors.diagramIds.includes(diagramId)) existing.anchors.diagramIds.push(diagramId);
          continue;
        }
        const ifObs = [];
        let ifScore = 1 + (rule.estimate ? 1 : 0);
        if (/mapping required/i.test(api.lifecycle)) { ifObs.push('API lifecycle status is "Proposed — application mapping required": the owning application is not confirmed, so no one may be monitoring interface failures.'); ifScore += 1; }
        else if (/proposed/i.test(api.lifecycle)) ifObs.push(`API lifecycle status is "${api.lifecycle}" — confirm it is in production use and under change control.`);
        if (!api.appAcronym) { ifObs.push('Owning application could not be resolved from the API\'s application foreign key.'); ifScore += 1; }
        const ifControl = {
          controlId: ifId,
          title: `Interface completeness & accuracy — ${api.apiId} (${taskName})`,
          description: `Data exchanged by ${api.method} ${api.endpoint} in support of "${taskName}" (${d.cleanName}) is validated for completeness and accuracy: the receiving system rejects malformed messages, record counts and amount control totals are reconciled between sender and receiver, and rejected / failed messages are logged to an error queue that is reviewed and reprocessed daily.`,
          controlObjective: `Transactions passed through ${api.apiId} are transferred completely, accurately and only once.`,
          riskStatement: `Messages are lost, duplicated or altered in transit between ${api.appAcronym || 'the source application'} and the downstream system, misstating the transactions recorded in "${taskName}".`,
          category: 'Interface Control',
          itgcDomain: null,
          processCycle: cycle,
          processCycleName: CYCLE_NAMES[cycle],
          controlType: 'Detective',
          controlNature: 'Automated',
          frequency: 'Continuous (per message) / daily error-queue review',
          keyControl: rule.keyControl !== false,
          assertions: ['Completeness', 'Accuracy'],
          financialStatementAccounts: rule.accounts,
          controlOwner: appByAcronym.get(api.appAcronym)?.v['IT_OWNER Qualifier'] || 'Integration Services',
          performedBy: 'System (integration layer) with IT operations review of error queue',
          evidence: 'Interface configuration (validation rules), reconciliation reports, error-queue logs and reprocessing tickets.',
          testingProcedure: 'Inspect interface configuration for validation and control-total checks; re-perform the reconciliation for a sample of days; inspect error-queue monitoring and reprocessing of failures. Rely on OP01 / CM01 ITGCs for the full period.',
          sampleSize: '1 (configuration) + 2–5 days of reconciliation and error-queue evidence',
          auditRisk: riskFromScore(ifScore),
          auditRiskRationale: 'Cross-application interfaces feeding financially significant tasks are a common source of completeness errors.',
          observations: [api.description ? `API description: ${api.description}` : null, ...ifObs].filter(Boolean),
          frameworkRefs: ['PCAOB AS 2201', 'COSO 2013 Principle 11', 'COBIT 2019 BAI03 / DSS06'],
          scope: { level: 'api', applications: scopeAppsFor([api.appAcronym].filter(Boolean)), businessFlows: [flowScope], tasks: [{ diagramId, flowName: d.cleanName, taskName, actor, applications: taskApps }], apis: [{ apiId: api.apiId, name: api.name, endpoint: api.endpoint, method: api.method, apiType: api.apiType, interactionScope: api.interactionScope }], servers: [], databases: [] },
          anchors: { diagramIds: [diagramId], taskKeys: [`${diagramId}|${norm(taskName)}`], applicationKeys: [] },
          relatedControlIds: [controlId, ...((appItgcIds.get(api.appAcronym) || []).filter((id) => /-(OP01|CM01)-/.test(id)))],
          _apiPrimaryKey: api.primaryKey,
        };
        apiControlById.set(ifId, ifControl);
      }
      if (taskApis.length) observations.push(`${taskApis.length} cross-application API(s) support this task — see interface control(s).`);

      controls.push({
        controlId,
        title: rule.title,
        description: fill(rule.activity, vars),
        controlObjective: rule.objective,
        riskStatement: rule.risk,
        category,
        itgcDomain: rule.domain || null,
        processCycle: rule.cat === 'IT General Control' ? 'ITG' : cycle,
        processCycleName: rule.cat === 'IT General Control' ? CYCLE_NAMES.ITG : CYCLE_NAMES[cycle],
        controlType: rule.type,
        controlNature: nature,
        frequency: nature === 'Automated' ? 'Continuous (automated)' : 'Per transaction',
        keyControl: rule.keyControl !== false,
        assertions: rule.assertions,
        financialStatementAccounts: rule.accounts,
        controlOwner: isSystem ? (appByAcronym.get(taskApps[0])?.v['APPLICATION_OWNER Qualifier'] || `${taskApps[0] || 'Application'} owner`) : actor,
        performedBy: isSystem ? `System (${taskApps.join(', ') || 'application'})` : actor,
        evidence: nature === 'Automated'
          ? `System configuration of ${taskApps.join(', ') || 'the application'} and walkthrough evidence of the control operating.`
          : `Approval / review evidence recorded in ${taskApps.join(', ') || 'the application'} (approver ID, timestamp) and supporting documentation.`,
        testingProcedure: nature === 'Automated'
          ? `Inspect the configuration that enforces "${taskName}" in ${taskApps.join(', ') || 'the application'} and perform a test of one (positive and negative case); confirm ITGCs over the application are effective for the period.`
          : `Select a sample of "${taskName}" transactions from a complete population (system extract, IPE validated); inspect evidence the control was performed timely by an appropriate person and that exceptions were resolved.`,
        sampleSize: sampleSizeFor(nature, nature === 'Automated' ? 'Continuous' : 'Per transaction'),
        auditRisk: riskFromScore(score),
        auditRiskRationale: [rule.estimate ? 'judgmental estimate' : null, nature !== 'Automated' ? 'manual performance' : null, taskApps.some((a) => IN_SCOPE_APPS[a]?.tier === 1) ? 'tier-1 financial system' : null, sod ? 'SoD conflict' : null, uncataloged.length ? 'uncataloged application' : null].filter(Boolean).join(', ') || 'standard transaction-level control',
        observations,
        frameworkRefs: rule.cat === 'IT General Control' ? ['PCAOB AS 2201', 'COSO 2013 Principle 11', 'COBIT 2019 BAI06 / DSS05'] : ['PCAOB AS 2201', 'COSO 2013 Principle 10'],
        scope: { level: 'task', applications: scopeAppsFor(taskApps), businessFlows: [flowScope], tasks: [{ diagramId, flowName: d.cleanName, taskName, actor, applications: taskApps }], apis: taskApis.map((a) => ({ apiId: a.apiId, name: a.name, endpoint: a.endpoint, method: a.method, apiType: a.apiType, interactionScope: a.interactionScope })), servers: [], databases: [] },
        anchors: { diagramIds: [diagramId], taskKeys: [`${diagramId}|${norm(taskName)}`], applicationKeys: [] },
        relatedControlIds: [...new Set(relatedControlIds)],
      });
      flowControlIds.push(controlId);
    }
    // Flow MRC relates to every task-level control in the flow
    const mrcDoc = controls.find((c) => c.controlId === flowControlIds[0]);
    mrcDoc.relatedControlIds = flowControlIds.slice(1);
  }
  controls.push(...apiControlById.values());

  // ── Summary ──
  const byCategory = controls.reduce((acc, c) => { acc[c.category] = (acc[c.category] || 0) + 1; return acc; }, {});
  const byRisk = controls.reduce((acc, c) => { acc[c.auditRisk] = (acc[c.auditRisk] || 0) + 1; return acc; }, {});
  const dupIds = controls.map((c) => c.controlId).filter((id, i, all) => all.indexOf(id) !== i);
  console.log(`[sox] ${controls.length} controls across ${inScopeDiagrams.length} flows and ${Object.keys(IN_SCOPE_APPS).length} applications`);
  console.log('[sox] by category:', byCategory);
  console.log('[sox] by audit risk:', byRisk);
  console.log('[sox] by cycle:', cycleCounters);
  if (dupIds.length) throw new Error(`Duplicate control ids: ${dupIds.join(', ')}`);

  if (dryRun) {
    console.log(JSON.stringify(controls.find((c) => c.controlId.startsWith('SOX-P2P')), null, 2));
    await mongoose.disconnect();
    return;
  }

  // ── Write controls ──
  await SoxControl.deleteMany({});
  await SoxControl.insertMany(controls.map(({ _apiPrimaryKey, ...c }) => ({ ...c, batchId: BATCH_ID, generatedAt: new Date() })));
  console.log(`[sox] inserted ${controls.length} controls`);

  // ── Attach control ids to components ──
  await Diagram.collection.updateMany({ soxControlIds: { $exists: true } }, { $unset: { soxControlIds: '' } });
  await CanonicalData.collection.updateMany({ soxControlIds: { $exists: true } }, { $unset: { soxControlIds: '' } });

  const diagramIds = new Map();
  const appIds = new Map(); // acronym -> Set
  const apiIds = new Map(); // primaryKey -> Set
  const serverIds = new Map(); // serverId -> Set
  const softwareIds = new Map(); // softwareId -> Set
  const add = (map, key, id) => { if (!key) return; if (!map.has(key)) map.set(key, new Set()); map.get(key).add(id); };
  for (const c of controls) {
    c.anchors.diagramIds.forEach((id) => add(diagramIds, id, c.controlId));
    c.scope.applications.forEach((a) => add(appIds, a.name, c.controlId));
    c.scope.servers.forEach((s) => add(serverIds, s.serverId, c.controlId));
    c.scope.databases.forEach((s) => add(softwareIds, s.softwareId, c.controlId));
    if (c._apiPrimaryKey) add(apiIds, c._apiPrimaryKey, c.controlId);
  }
  const bulk = async (model, entries, filterFor) => {
    const ops = [...entries].map(([key, set]) => ({ updateOne: { filter: filterFor(key), update: { $set: { soxControlIds: [...set].sort() } } } }));
    for (let i = 0; i < ops.length; i += 500) await model.collection.bulkWrite(ops.slice(i, i + 500), { ordered: false });
    return ops.length;
  };
  const nd = await bulk(Diagram, diagramIds, (id) => ({ _id: new mongoose.Types.ObjectId(id) }));
  const na = await bulk(CanonicalData, appIds, (acronym) => ({ neighborhoodName: NEIGHBORHOOD, componentType: 'Applications', primaryKey: acronym }));
  const np = await bulk(CanonicalData, apiIds, (pk) => ({ neighborhoodName: NEIGHBORHOOD, componentType: 'APIs', primaryKey: pk }));
  const ns = await bulk(CanonicalData, serverIds, (id) => ({ neighborhoodName: NEIGHBORHOOD, componentType: 'Servers', 'values.SERVER_ID Qualifier': id }));
  const nw = await bulk(CanonicalData, softwareIds, (id) => ({ neighborhoodName: NEIGHBORHOOD, componentType: 'Software', 'values.SOFTWARE_ID Qualifier': id }));
  console.log(`[sox] attached control ids to ${nd} diagrams, ${na} applications, ${np} APIs, ${ns} servers, ${nw} software rows`);

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('[sox] failed:', err);
  try { await mongoose.disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
