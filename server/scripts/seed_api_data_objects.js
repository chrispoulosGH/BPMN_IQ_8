#!/usr/bin/env node
/**
 * Generate a realistic (but ILLUSTRATIVE — not sourced) set of API data
 * objects, and link every API to its request and response object.
 *
 * Nothing in the source data described API payloads (no specs, schemas or
 * data-object columns — checked 2026-11-12), so this builds a shared business
 * vocabulary (~70 objects) for the automotive dealer/OEM landscape and assigns
 * objects to APIs from each API's own task/flow wording and HTTP method.
 *
 * Writes, in System Components:
 *   1. New data type "Data Objects" — dataBatches (source of truth) + canonicaldata.
 *      Columns: OBJECT_NAME Component, OBJECT_ID Qualifier, Description Qualifier,
 *      Business Domain Aggregate, Object Category Aggregate, Sensitivity Aggregate,
 *      Contains PII Aggregate, Field Count Qualifier, Fields Qualifier,
 *      FK_System Components[Applications].APP_ID (system of record),
 *      Generation Basis Qualifier.  Structured fields are also kept in `__fields`
 *      ("__" keys are hidden from the System Components table).
 *   2. On every API row (dataBatches + canonicaldata, in place):
 *      FK_System Components[Data Objects].OBJECT_ID (Request)
 *      FK_System Components[Data Objects].OBJECT_ID (Response)
 *      Payload Basis Qualifier — how the pair was chosen.
 *      Canonical primaryKey is recomputed (FK values are part of it).
 *
 * Assignment rules (per API):
 *   - Main object: keyword score over the task (weight 2) and flow (weight 1)
 *     names, phrase length counts, +1.5 for an object in the API's own business
 *     domain (endpoint path segment). No hit → that domain's default object.
 *   - GET:  request = none (parameters only); response = main object.
 *   - PUT:  request = main object; response = main object.
 *   - POST: request = main object; response =
 *       best-scoring "Result" object for evaluative tasks (calculate, assess…),
 *       "Transaction Acknowledgement" for System Service APIs,
 *       otherwise the main object (created resource).
 *
 * Idempotent: deletes previously generated Data Objects and re-creates them;
 * API columns are recomputed.
 *
 * Usage: node scripts/seed_api_data_objects.js [--dry-run]
 */
const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const { primaryKeyFromRow } = require('../lib/materializer');

const DRY_RUN = process.argv.includes('--dry-run');
const NEIGHBORHOOD = 'System Components';
const DATA_TYPE = 'Data Objects';
const GENERATOR = 'seed_api_data_objects.js';
const SOURCE_LABEL = `generated: ${GENERATOR}`;

const REQUEST_KEY = 'FK_System Components[Data Objects].OBJECT_ID (Request)';
const RESPONSE_KEY = 'FK_System Components[Data Objects].OBJECT_ID (Response)';
const PAYLOAD_BASIS_KEY = 'Payload Basis Qualifier';

const OBJECT_COLUMNS = [
  'OBJECT_NAME Component',
  'OBJECT_ID Qualifier',
  'Description Qualifier',
  'Business Domain Aggregate',
  'Object Category Aggregate',
  'Sensitivity Aggregate',
  'Contains PII Aggregate',
  'Field Count Qualifier',
  'Fields Qualifier',
  'FK_System Components[Applications].APP_ID',
  'Generation Basis Qualifier',
];

// Domains = the API endpoint path segment (/api/v1/<domain>/...).
const D = {
  WAR: 'warranty-protection-services',
  SAL: 'sales-distribution',
  FIN: 'finance-insurance',
  AFT: 'after-sales-service',
  MFG: 'manufacturing-supply-chain',
  ENG: 'engineering-product-development',
  MKT: 'marketing-customer-experience',
  CON: 'connected-vehicle-mobility',
  DLR: 'dealer-network-operations',
  CORP: 'corporate-functions',
  ENT: 'enterprise',
};
const DOMAIN_LABEL = {
  [D.WAR]: 'Warranty & Protection Services',
  [D.SAL]: 'Sales & Distribution',
  [D.FIN]: 'Finance & Insurance',
  [D.AFT]: 'After-Sales & Service',
  [D.MFG]: 'Manufacturing & Supply Chain',
  [D.ENG]: 'Engineering & Product Development',
  [D.MKT]: 'Marketing & Customer Experience',
  [D.CON]: 'Connected Vehicle & Mobility',
  [D.DLR]: 'Dealer Network Operations',
  [D.CORP]: 'Corporate Functions',
  [D.ENT]: 'Enterprise (shared)',
};

/*
 * Vocabulary. Field spec: "name:type[:flags]"; flags R = required,
 * P = personal data (PII), F = financial, X = restricted (e.g. SSN).
 * Category: Master | Transactional | Reference | Result | Event | Acknowledgement.
 */
const OBJECTS = [
  // ── Sales & customer ──
  ['Customer Profile', 'Master', D.MKT, 'LLM-005', 'customer~|contact|profile|customer profile|walk-in|engagement|needs|identify customer', 'The customer of record: identity, contact details and consent.',
    'customerId:string:R firstName:string:RP lastName:string:RP email:string:P phone:string:P postalAddress:Address:P preferredContactMethod:enum marketingConsent:boolean customerSince:date'],
  ['Sales Lead', 'Transactional', D.SAL, 'LLM-054', 'lead|prospect|qualification|qualify|interest|inquiry|lost sales|recovery|capture', 'A prospective purchase opportunity and its qualification state.',
    'leadId:string:R customerId:string source:enum vehicleOfInterest:string leadScore:integer assignedSalespersonId:string status:enum:R createdAt:datetime:R'],
  ['Vehicle', 'Master', D.SAL, 'LLM-001', 'vehicle~|vin|vehicles~|vehicle details', 'Vehicle master record keyed by VIN: build specification and identity.',
    'vin:string:R modelCode:string:R modelYear:integer:R trim:string exteriorColor:string interiorColor:string powertrain:enum odometerMiles:integer buildDate:date plantCode:string'],
  ['Vehicle Inventory Unit', 'Transactional', D.SAL, 'LLM-013', 'inventory|locate|stock|search|allocation|lot|availability', 'A vehicle held in dealer or OEM stock, with status and pricing.',
    'stockNumber:string:R vin:string:R dealerCode:string:R status:enum:R daysInStock:integer msrp:decimal:F invoicePrice:decimal:F location:string'],
  ['Vehicle Configuration', 'Transactional', D.SAL, 'LLM-011', 'configure|configuration|options|custom|build order|upfit|accessory|accessories|option package', 'A configured vehicle: model, trim, options, packages and accessories.',
    'configurationId:string:R modelCode:string:R trim:string selectedOptions:string[] packageCodes:string[] accessoryCodes:string[] configuredPrice:decimal:F'],
  ['Vehicle Order', 'Transactional', D.SAL, 'LLM-012', 'order|fleet order|fulfillment|fulfil|allocation|build order', 'An order for one or more vehicles placed by a dealer or fleet customer.',
    'orderId:string:R dealerCode:string:R customerId:string configurationId:string orderType:enum:R quantity:integer requestedDeliveryDate:date status:enum:R'],
  ['Price Quote', 'Result', D.SAL, 'LLM-096', 'price|pricing|quote|deal|structuring|offer|negotiate|present pricing|value|risk adjustment|surcharge', 'A priced offer for a vehicle, including discounts, incentives, trade-in and fees.',
    'quoteId:string:R vin:string msrp:decimal:F discounts:decimal:F incentivesApplied:string[] tradeInAllowance:decimal:F taxesAndFees:decimal:F totalPrice:decimal:RF validUntil:date'],
  ['Trade-In Appraisal', 'Result', D.SAL, 'LLM-057', 'trade|trade-in|appraisal|appraise|valuation|wholesale|disposition', 'The appraised value of a customer trade-in or wholesale vehicle.',
    'appraisalId:string:R vin:string:R mileage:integer conditionGrade:enum appraisedValue:decimal:RF payoffAmount:decimal:F appraiserId:string appraisedAt:datetime'],
  ['Test Drive Booking', 'Transactional', D.SAL, 'LLM-058', 'test drive|drive', 'A scheduled test drive, including driver licence verification.',
    'bookingId:string:R customerId:string:R vin:string scheduledAt:datetime:R dealerCode:string driverLicenseNumber:string:P licenseVerified:boolean'],
  ['Sales Contract', 'Transactional', D.SAL, 'LLM-004', 'contract|finalization|finalize|sign|signature|signs|agreement|purchase agreement|deal', 'The executed vehicle purchase agreement.',
    'contractId:string:R customerId:string:R vin:string:R salePrice:decimal:RF downPayment:decimal:F financeContractId:string signedAt:datetime signatureMethod:enum documents:DocumentRef[]'],
  ['Delivery Record', 'Transactional', D.SAL, 'LLM-004', 'delivery|handover|deliver|delivered', 'Hand-over of a sold vehicle to its customer, with the pre-delivery checklist.',
    'deliveryId:string:R vin:string:R customerId:string:R deliveredAt:datetime pdiCompleted:boolean deliveryChecklist:string[] deliveredBy:string'],
  ['Fleet Proposal', 'Result', D.SAL, 'LLM-014', 'fleet|proposal|fleet customer|volume', 'A priced multi-vehicle proposal for a fleet account.',
    'proposalId:string:R fleetAccountId:string:R vehicleMix:LineItem[] volumeDiscountPct:decimal:F totalValue:decimal:F validUntil:date'],
  ['CPO Inspection', 'Result', D.SAL, 'LLM-051', 'cpo|certified pre-owned|pre-owned|reconditioning|reconditioning cost|cpo certification', 'Certified Pre-Owned multi-point inspection and certification outcome.',
    'inspectionId:string:R vin:string:R checklistResults:InspectionItem[] reconditioningCost:decimal:F certified:boolean:R certifiedAt:datetime'],

  // ── Finance & insurance ──
  ['Credit Application', 'Transactional', D.FIN, 'LLM-015', 'credit|credit application|special finance|applicant|apply for credit', 'A consumer credit application for vehicle financing.',
    'applicationId:string:R customerId:string:R ssn:string:RX dateOfBirth:date:P annualIncome:decimal:PF employer:string:P requestedAmount:decimal:RF termMonths:integer'],
  ['Credit Decision', 'Result', D.FIN, 'LLM-015', 'decision|credit decision|underwrite|underwriting|tier|stipulation|lender approval', 'The lender decision on a credit application.',
    'decisionId:string:R applicationId:string:R decision:enum:R creditTier:string approvedAmount:decimal:F apr:decimal:F stipulations:string[] decidedAt:datetime'],
  ['Finance Contract', 'Transactional', D.FIN, 'LLM-007', 'finance|funding|fund|loan|installment|lender', 'A retail installment (loan) contract and its funding status.',
    'financeContractId:string:R customerId:string:R amountFinanced:decimal:RF apr:decimal:F termMonths:integer monthlyPayment:decimal:F lenderId:string fundingStatus:enum fundedAt:datetime'],
  ['Lease Agreement', 'Transactional', D.FIN, 'LLM-016', 'lease|residual|lease return|maturity|lessee|lessor|lease term', 'A vehicle lease and its residual, money factor and mileage terms.',
    'leaseId:string:R customerId:string:R vin:string:R capitalizedCost:decimal:F residualValue:decimal:F moneyFactor:decimal:F termMonths:integer annualMileageAllowance:integer maturityDate:date'],
  ['Payment', 'Transactional', D.FIN, 'LLM-007', 'payment|collect|pay|deposit|payment method|charge customer|process payment|payment transaction|down payment', 'A payment taken against an account, contract or order.',
    'paymentId:string:R accountId:string:R amount:decimal:RF currency:string:R method:enum cardToken:string:F paidAt:datetime status:enum'],
  ['Customer Account', 'Transactional', D.FIN, 'LLM-018', 'past due|delinquent|collection|collections|arrears|overdue|receivable|account~', 'A customer finance account with balance and delinquency state.',
    'accountId:string:R customerId:string:R balanceDue:decimal:RF daysPastDue:integer lastPaymentDate:date collectionStage:enum promiseToPayDate:date'],
  ['Protection Product Enrollment', 'Transactional', D.FIN, 'LLM-094', 'gap|insurance|protection product|enroll', 'Enrollment in a F&I protection product such as GAP insurance.',
    'enrollmentId:string:R productCode:string:R customerId:string:R vin:string premium:decimal:F coverageTermMonths:integer effectiveDate:date'],
  ['Invoice', 'Transactional', D.CORP, 'LLM-007', 'invoice|payable|payables|billing|bill|accounts payable', 'A supplier or vendor invoice for payment.',
    'invoiceId:string:R vendorId:string:R invoiceDate:date lineItems:LineItem[] subtotal:decimal:F tax:decimal:F total:decimal:RF dueDate:date status:enum'],
  ['Journal Entry', 'Transactional', D.CORP, 'LLM-007', 'close|ledger|journal|reconcile|reconciliation|accrual|financial close|post', 'A general-ledger journal entry for a fiscal period.',
    'entryId:string:R period:string:R accountCode:string:R debit:decimal:F credit:decimal:F costCenter:string postedAt:datetime'],
  ['Budget Plan', 'Transactional', D.CORP, 'LLM-042', 'budget|forecast|planning~|strategic|allocate|spend|competitive|strategy', 'An annual budget or plan line for a cost center.',
    'budgetId:string:R fiscalYear:integer:R costCenter:string category:string plannedAmount:decimal:F approvedAmount:decimal:F owner:string status:enum'],

  // ── Warranty ──
  ['Warranty Product', 'Reference', D.WAR, 'LLM-071', 'warranty product|protection|product recommendation|recommend coverage|presentation|present~|coverage options|plans|product~', 'A sellable extended warranty / protection plan and its terms.',
    'productCode:string:R name:string:R coverageLevel:enum termMonths:integer mileageLimit:integer deductible:decimal:F retailPrice:decimal:F'],
  ['Service Contract', 'Transactional', D.WAR, 'LLM-072', 'warranty contract|service contract|vsc|administrator|extended warranty|contract execution|registration', 'A sold vehicle service contract (extended warranty).',
    'contractNumber:string:R productCode:string:R vin:string:R customerId:string:R purchasePrice:decimal:F effectiveDate:date expirationDate:date status:enum'],
  ['Warranty Claim', 'Transactional', D.AFT, 'LLM-008', 'claim|warranty claim|goodwill|reimbursement|reimburse', 'A dealer claim for warranty or goodwill repair reimbursement.',
    'claimId:string:R vin:string:R repairOrderId:string laborOperationCodes:string[] partsCost:decimal:F laborCost:decimal:F claimAmount:decimal:RF status:enum submittedAt:datetime'],
  ['Coverage Eligibility', 'Result', D.WAR, 'LLM-008', 'eligibility|eligible|coverage|verify coverage|entitlement', 'Whether a vehicle is covered for a given repair or product.',
    'vin:string:R coverageType:enum eligible:boolean:R remainingMonths:integer remainingMiles:integer exclusions:string[]'],

  // ── Service & after-sales ──
  ['Service Appointment', 'Transactional', D.AFT, 'LLM-064', 'appointment|schedule~|booking|scheduling|express|mobile service|time slot', 'A booked service visit, at the dealer or mobile.',
    'appointmentId:string:R customerId:string:R vin:string:R dealerCode:string requestedServices:string[] scheduledAt:datetime:R advisorId:string transportOption:enum'],
  ['Repair Order', 'Transactional', D.AFT, 'LLM-063', 'repair|repair order|check-in|technician|labor|work|completion|tire|battery|replacement|service lane', 'A repair order: concerns, labor and parts lines, and totals.',
    'repairOrderId:string:R vin:string:R customerId:string mileageIn:integer concerns:string[] laborLines:LaborLine[] partsLines:LineItem[] status:enum:R totalAmount:decimal:F'],
  ['Vehicle Diagnostic Report', 'Event', D.CON, 'LLM-067', 'diagnostic|diagnostics|diagnose|dtc|fault|health|remote|telemetry', 'A diagnostic snapshot from the vehicle or a dealer scan tool.',
    'reportId:string:R vin:string:R capturedAt:datetime:R odometer:integer dtcCodes:string[] batteryStateOfHealthPct:decimal location:GeoPoint:P severity:enum'],
  ['Parts Order', 'Transactional', D.AFT, 'LLM-030', 'parts|reorder|counter|part|dealer parts|parts order', 'An order for parts from a dealer or warehouse.',
    'partsOrderId:string:R dealerCode:string lineItems:LineItem[] orderType:enum requestedBy:string status:enum totalCost:decimal:F'],
  ['Part', 'Reference', D.AFT, 'LLM-030', 'part number|catalog|supersession|lookup part|parts catalog|part availability|parts availability|part price', 'A catalog part: number, description, price and supersession.',
    'partNumber:string:R description:string category:string listPrice:decimal:F supersededBy:string unitOfMeasure:string'],
  ['Roadside Assistance Case', 'Transactional', D.AFT, 'LLM-050', 'roadside|tow|emergency|breakdown|assistance|dispatch|calls for help', 'A roadside assistance request and its dispatch.',
    'caseId:string:R customerId:string:R vin:string incidentLocation:GeoPoint:RP issueType:enum dispatchedProvider:string eta:datetime status:enum'],
  ['Recall Campaign', 'Reference', D.AFT, 'LLM-032', 'recall|remedy|safety recall|recall campaign', 'A safety recall campaign and its remedy.',
    'campaignId:string:R nhtsaCampaignNumber:string component:string remedyDescription:string affectedVinCount:integer launchDate:date status:enum'],
  ['Customer Notification', 'Event', D.ENT, 'LLM-098', 'notify|notification|notice|alert|communicate|send~|owner letter|reminder', 'An outbound message to a customer (recall notice, alert, reminder) and its delivery status.',
    'notificationId:string:R customerId:string:R vin:string templateCode:string:R channel:enum:R relatedObjectId:string sentAt:datetime deliveryStatus:enum'],
  ['Customer Case', 'Transactional', D.MKT, 'LLM-076', 'complaint|case~|resolution|resolve|escalation|escalate|issue~|follow up', 'A customer complaint or care case through to resolution.',
    'caseId:string:R customerId:string:R vin:string category:enum description:string priority:enum assignedTo:string resolution:string status:enum:R'],
  ['Survey Response', 'Event', D.MKT, 'LLM-073', 'survey|satisfaction|feedback|nps|csat|review~|social|customer response|sentiment', 'A customer satisfaction survey response.',
    'responseId:string:R surveyId:string:R customerId:string touchpoint:enum npsScore:integer comments:string:P submittedAt:datetime'],

  // ── Manufacturing & supply chain ──
  ['Production Schedule', 'Transactional', D.MFG, 'LLM-002', 'production|schedule~|planning~|line~|changeover|sequence|daily|shift|capacity', 'A plant/line production plan for a shift or day.',
    'scheduleId:string:R plantCode:string:R lineId:string shiftDate:date:R plannedUnits:integer modelMix:LineItem[] status:enum'],
  ['Work Order', 'Event', D.MFG, 'LLM-002', 'assembly|station|work order|build|install|torque|operator', 'An assembly-line operation performed on a vehicle at a station.',
    'workOrderId:string:R vin:string stationId:string operation:string startedAt:datetime completedAt:datetime operatorId:string result:enum'],
  ['Quality Inspection Result', 'Result', D.MFG, 'LLM-006', 'quality|inspection|inspect|end-of-line|audit|check~|conformance|supplier audit|quality audit', 'The result of a quality inspection checkpoint.',
    'inspectionId:string:R subjectId:string:R checkpoint:string result:enum:R defects:Defect[] inspectorId:string inspectedAt:datetime'],
  ['Defect Report', 'Event', D.MFG, 'LLM-006', 'defect|nonconformance|containment|root cause|corrective', 'A recorded defect with containment and root cause.',
    'defectId:string:R partNumber:string supplierId:string severity:enum:R description:string containmentAction:string rootCause:string status:enum'],
  ['Purchase Order', 'Transactional', D.MFG, 'LLM-003', 'purchase order|supplier parts|procurement|purchase|sourcing|requisition|receive goods|goods receipt|goods', 'A purchase order placed with a supplier.',
    'poNumber:string:R supplierId:string:R lineItems:LineItem[] currency:string totalValue:decimal:F requiredDate:date status:enum'],
  ['Supplier', 'Master', D.MFG, 'LLM-023', 'supplier|vendor|supplier quality|scorecard', 'A supplier of record with quality rating and certifications.',
    'supplierId:string:R legalName:string:R taxId:string:RF qualityRating:decimal certifications:string[] primaryContact:Contact:P'],
  ['Shipment', 'Transactional', D.MFG, 'LLM-028', 'shipment|logistics|outbound|carrier|transport|ship|tracking|track shipment', 'A vehicle or parts shipment and its tracking.',
    'shipmentId:string:R carrierCode:string origin:string destination:string vins:string[] plannedDeparture:datetime eta:datetime status:enum trackingNumber:string'],
  ['Stock Level', 'Transactional', D.MFG, 'LLM-003', 'warehouse|bin|cycle count|inventory levels|stock level|replenish|inventory records|parts inventory', 'On-hand and reserved quantity of a part at a location.',
    'locationId:string:R partNumber:string:R onHandQty:integer:R reservedQty:integer reorderPoint:integer lastCountedAt:datetime'],
  ['Maintenance Work Order', 'Transactional', D.MFG, 'LLM-027', 'equipment|maintenance|preventive|downtime|asset|work order', 'Maintenance work on plant equipment.',
    'workOrderId:string:R assetId:string:R maintenanceType:enum scheduledAt:datetime technicianId:string downtimeMinutes:integer status:enum'],

  // ── Engineering ──
  ['Engineering Change Order', 'Transactional', D.ENG, 'LLM-022', 'change order|engineering change|eco|ecn|change~|impact', 'A proposed engineering change and its approval.',
    'ecoNumber:string:R title:string affectedParts:string[] reason:string impactAssessment:string approvalStatus:enum:R effectiveDate:date'],
  ['Product Requirement', 'Transactional', D.ENG, 'LLM-001', 'requirements|requirement|program~|development|milestone|design|model development|concept|define', 'A product/program requirement and its verification method.',
    'requirementId:string:R programCode:string:R title:string category:string priority:enum verificationMethod:string status:enum'],
  ['Prototype Build', 'Transactional', D.ENG, 'LLM-039', 'prototype|build|pilot', 'A prototype vehicle build for a development program.',
    'prototypeId:string:R programCode:string:R buildPhase:enum vin:string buildStartedAt:datetime completedAt:datetime status:enum'],
  ['Test Result', 'Result', D.ENG, 'LLM-021', 'test|validation|validate|testing|homologation|compliance certification|safety certification', 'The outcome of a vehicle or component test.',
    'testId:string:R programCode:string testType:string subjectId:string result:enum:R measurements:Measurement[] testedAt:datetime engineerId:string'],
  ['Software Release Package', 'Transactional', D.ENG, 'LLM-010', 'software|release|ota|over-the-air|update|firmware|deploy|rollout', 'A vehicle software release and its rollout targets.',
    'releaseId:string:R ecuTarget:string version:string:R releaseNotes:string checksum:string targetVins:string[] rolloutPct:integer'],
  ['Security Incident', 'Event', D.CON, 'LLM-044', 'cybersecurity|incident|threat|vulnerability|security|breach', 'A detected security incident and its containment.',
    'incidentId:string:R detectedAt:datetime:R severity:enum:R affectedSystems:string[] affectedVins:string[] description:string containmentStatus:enum'],

  // ── Connected vehicle & mobility ──
  ['Connected Subscription', 'Transactional', D.CON, 'LLM-010', 'subscription|connected services|activation|renewal|renew|trial|subscription plan|signs up|sign up|selects plan|select plan|renewal options', 'A connected-services or vehicle subscription.',
    'subscriptionId:string:R vin:string:R customerId:string:R planCode:string:R startDate:date renewalDate:date autoRenew:boolean price:decimal:F status:enum'],
  ['Charging Session', 'Event', D.CON, 'LLM-038', 'charging|charge|ev|station|charger|energy', 'An EV charging session at a network station.',
    'sessionId:string:R stationId:string:R vin:string customerId:string startedAt:datetime endedAt:datetime energyKwh:decimal cost:decimal:F paymentToken:string:F'],
  ['Telemetry Batch', 'Event', D.CON, 'LLM-046', 'data~|analytics|signals|usage|collect data|insight', 'A batch of vehicle telemetry signals for analytics.',
    'batchId:string:R vin:string:R capturedFrom:datetime capturedTo:datetime signalCount:integer location:GeoPoint:P payloadUri:string'],
  ['In-Vehicle Order', 'Transactional', D.CON, 'LLM-010', 'commerce|in-vehicle|marketplace|transaction|initiates purchase|in-vehicle purchase', 'A purchase made from the vehicle head unit.',
    'orderId:string:R vin:string:R customerId:string:R sku:string:R amount:decimal:F paymentToken:string:F purchasedAt:datetime'],

  // ── Marketing ──
  ['Marketing Campaign', 'Transactional', D.MKT, 'LLM-047', 'campaign|marketing|launch|promotion|advertising|ads|brand|partnership|creative|media', 'A marketing campaign: channel, audience, budget and KPIs.',
    'campaignId:string:R name:string:R channel:enum audienceSegmentId:string budget:decimal:F startDate:date endDate:date kpis:string[] status:enum'],
  ['Audience Segment', 'Reference', D.MKT, 'LLM-005', 'segment|audience|targeting|retention|target', 'A defined audience used for targeting.',
    'segmentId:string:R name:string:R criteria:string memberCount:integer refreshedAt:datetime'],
  ['Loyalty Account', 'Transactional', D.MKT, 'LLM-070', 'loyalty|rewards|points|member|redeem', 'A customer loyalty membership and points balance.',
    'memberId:string:R customerId:string:R tier:enum pointsBalance:integer lifetimePoints:integer enrolledAt:date'],
  ['Event Registration', 'Transactional', D.MKT, 'LLM-047', 'event|auto show|attendee|booth|exhibit', 'A registration for a marketing event or auto show.',
    'registrationId:string:R eventId:string:R customerId:string attendeeName:string:P email:string:P interests:string[] checkedIn:boolean'],

  // ── Dealer network ──
  ['Dealer', 'Master', D.DLR, 'LLM-093', 'dealer|dealership|franchise|onboard dealer|standards', 'A franchised dealer of record.',
    'dealerCode:string:R legalName:string:R address:Address region:string franchiseBrands:string[] principalContact:Contact:P status:enum'],
  ['Dealer Scorecard', 'Result', D.DLR, 'LLM-093', 'performance~|scorecard|review~|metrics|kpi|compliance audit|audit|dealer performance', 'A dealer performance or compliance scorecard for a period.',
    'dealerCode:string:R period:string:R salesUnits:integer csiScore:decimal serviceAbsorptionPct:decimal ranking:integer findings:string[]'],
  ['Training Enrollment', 'Transactional', D.DLR, 'LLM-092', 'training|course|learning|staff|curriculum|certification status', 'A staff enrollment in a training course.',
    'enrollmentId:string:R employeeId:string:R courseCode:string:R dueDate:date completedAt:datetime score:decimal'],
  ['Incentive Program', 'Transactional', D.DLR, 'LLM-094', 'incentive|rebate|bonus|program~|payout', 'A dealer incentive program and its payout.',
    'programId:string:R dealerCode:string eligibilityRules:string payoutAmount:decimal:F period:string status:enum'],

  // ── Corporate ──
  ['Employee', 'Master', D.CORP, 'LLM-034', 'employee|onboarding|hire|new hire|staff|personnel', 'An employee of record.',
    'employeeId:string:R firstName:string:RP lastName:string:RP workEmail:string:P jobTitle:string department:string managerId:string hireDate:date'],
  ['Performance Review', 'Transactional', D.CORP, 'LLM-034', 'performance review|goals|rating|evaluation|calibration|self-assessment', 'An employee performance review.',
    'reviewId:string:R employeeId:string:R period:string rating:enum goals:string[] managerComments:string:P'],
  ['IT Service Ticket', 'Transactional', D.CORP, 'LLM-045', 'it service|ticket|service request|change request|access|fulfillment', 'An IT service request, incident or change ticket.',
    'ticketId:string:R requesterId:string:R category:enum priority:enum description:string assignedGroup:string status:enum slaDueAt:datetime'],
  ['Vendor Contract', 'Transactional', D.CORP, 'LLM-041', 'vendor contract|vendor|contract management|terms|renewal', 'A contract with a vendor, its value and renewal terms.',
    'contractId:string:R vendorId:string:R contractValue:decimal:F startDate:date endDate:date renewalTerms:string owner:string status:enum'],
  ['Legal Matter', 'Transactional', D.CORP, 'LLM-041', 'legal|case|litigation|counsel|matter', 'A legal case or matter.',
    'caseId:string:R matterType:enum parties:string[] counselAssigned:string filingDate:date status:enum privileged:boolean'],
  ['Risk Register Entry', 'Transactional', D.CORP, 'LLM-043', 'risk|assessment|mitigation|control|risk assessment', 'An enterprise risk with likelihood, impact and mitigation.',
    'riskId:string:R title:string:R category:string likelihood:integer impact:integer owner:string mitigationPlan:string status:enum'],
  ['Regulatory Filing', 'Transactional', D.CORP, 'LLM-009', 'regulatory|compliance reporting|filing|emissions|report|submission', 'A filing or report submitted to a regulator.',
    'filingId:string:R regulator:string:R reportType:string period:string submittedAt:datetime status:enum attachments:DocumentRef[]'],
  ['Vehicle Registration', 'Transactional', D.SAL, 'LLM-077', 'registration|title|licensing|plate|dmv', 'State registration and title for a vehicle.',
    'registrationId:string:R vin:string:R ownerId:string:R state:string plateNumber:string titleNumber:string registeredAt:date expiresAt:date'],
  ['Document', 'Reference', D.ENT, 'LLM-041', 'document~|documentation|upload|e-sign|paperwork|forms|welcome package|welcome kit|archive', 'A stored document and its signature/retention metadata.',
    'documentId:string:R documentType:string:R fileName:string storageUri:string signedBy:string signedAt:datetime retentionClass:enum'],

  // ── Shared ──
  ['Transaction Acknowledgement', 'Acknowledgement', D.ENT, '', '', 'Standard response confirming receipt/processing of a command.',
    'correlationId:string:R status:enum:R receivedAt:datetime:R messages:string[] resourceId:string'],
];

// Per-domain fallback when no keyword matches.
const DOMAIN_DEFAULT = {
  [D.WAR]: 'Service Contract',
  [D.SAL]: 'Vehicle',
  [D.FIN]: 'Finance Contract',
  [D.AFT]: 'Repair Order',
  [D.MFG]: 'Production Schedule',
  [D.ENG]: 'Product Requirement',
  [D.MKT]: 'Customer Profile',
  [D.CON]: 'Connected Subscription',
  [D.DLR]: 'Dealer',
  [D.CORP]: 'Document',
};

// Tasks whose POST returns a computed result rather than the input object.
const EVALUATIVE_VERBS = /^(calculate|generate|assess|analy[sz]e|evaluate|check|verify|validate|identify|determine|estimate|appraise|price|review|score|decide|approve|test|inspect|qualify|recommend|present|search|locate|run)\b/i;

const FLAG_LABEL = { R: 'required', P: 'PII', F: 'financial', X: 'restricted' };

function parseFields(spec) {
  return spec.split(/\s+/).filter(Boolean).map((token) => {
    const [name, type, flags = ''] = token.split(':');
    return {
      name,
      type,
      required: flags.includes('R'),
      pii: flags.includes('P') || flags.includes('X'),
      financial: flags.includes('F'),
      restricted: flags.includes('X'),
    };
  });
}

function describeField(field) {
  const tags = [field.type];
  if (field.required) tags.push(FLAG_LABEL.R);
  if (field.restricted) tags.push(FLAG_LABEL.X);
  else if (field.pii) tags.push(FLAG_LABEL.P);
  if (field.financial) tags.push(FLAG_LABEL.F);
  return `${field.name} (${tags.join(', ')})`;
}

function sensitivityOf(fields, category) {
  if (fields.some((f) => f.restricted)) return 'Restricted';
  if (fields.some((f) => f.pii || f.financial)) return 'Confidential';
  if (category === 'Reference') return 'Public';
  return 'Internal';
}

function decodeEntities(text) {
  return String(text || '').replace(/&amp;/g, '&');
}

function normalizeText(text) {
  return ` ${decodeEntities(text).toLowerCase().replace(/[^a-z0-9-]+/g, ' ')} `;
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/bpmn_iq');
  const db = mongoose.connection.db;
  const canonical = db.collection('canonicaldata');

  // ── Build the object catalog ──
  const knownAppIds = new Set();
  for (const batch of await db.collection('dataBatches').find({ neighborhoodName: NEIGHBORHOOD, dataType: 'Applications' }, { projection: { rows: 1 } }).toArray()) {
    for (const row of batch.rows || []) knownAppIds.add(String(row.values?.['APP_ID Qualifier'] || '').trim());
  }

  const objects = OBJECTS.map(([name, category, domain, sorAppId, keywords, description, fieldSpec], index) => {
    if (sorAppId && !knownAppIds.has(sorAppId)) throw new Error(`System of record ${sorAppId} for "${name}" is not in the application catalog`);
    const fields = parseFields(fieldSpec);
    return {
      id: `DO-${String(index + 1).padStart(3, '0')}`,
      name, category, domain, sorAppId, description, fields,
      // "word~" = weak keyword (generic word, half weight).
      keywords: keywords.split('|').map((k) => k.trim().toLowerCase()).filter(Boolean).map((k) => ({
        text: k.replace(/~$/, ''),
        weight: k.endsWith('~') ? 0.5 : 1,
      })),
    };
  });
  const objectByName = new Map(objects.map((o) => [o.name, o]));
  for (const [domain, name] of Object.entries(DOMAIN_DEFAULT)) if (!objectByName.has(name)) throw new Error(`Default for ${domain} "${name}" not defined`);
  const ACK = objectByName.get('Transaction Acknowledgement');

  // ── Assign request/response per API ──
  function scoreObjects(taskText, flowText, domain) {
    return objects
      .filter((o) => o.keywords.length)
      .map((o) => {
        let score = 0;
        let taskHit = false;
        for (const keyword of o.keywords) {
          const needle = ` ${keyword.text} `;
          const words = keyword.text.split(/\s+/).length;
          // Phrases outrank their single words: "performance review" (3) > "review" (1).
          const strength = keyword.weight * (words > 1 ? words + 1 : 1);
          const plural = ` ${keyword.text}s `;
          if (taskText.includes(needle) || taskText.includes(plural)) { score += 2 * strength; taskHit = true; }
          if (flowText.includes(needle) || flowText.includes(plural)) score += 0.5 * strength; // flow = context only
        }
        // Domain only breaks ties between task-level matches; it must not let a
        // flow-only hit outrank what the task itself says.
        if (taskHit && o.domain === domain) score += 1.5;
        return { object: o, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || a.object.id.localeCompare(b.object.id));
  }

  const usage = new Map(objects.map((o) => [o.id, { request: 0, response: 0 }]));
  const stats = { apis: 0, byRule: {} };

  function assign(values) {
    const name = decodeEntities(values['API Name Component']);
    const parts = name.split(' — ');
    const flow = parts.length > 1 ? parts[0] : '';
    const task = parts.length > 1 ? parts.slice(1).join(' — ').replace(/\s+API$/i, '') : name;
    const domain = String(values['Endpoint Qualifier'] || '').split('/')[3] || '';
    const method = String(values['HTTP Method Aggregate'] || '').toUpperCase();
    const isSystemService = /system service/i.test(String(values['API Type Aggregate'] || ''));

    const scored = scoreObjects(normalizeText(task), normalizeText(flow), domain);
    const main = scored[0]?.object || objectByName.get(DOMAIN_DEFAULT[domain]) || ACK;
    const mainBasis = scored[0] ? `"${main.name}" matched task/flow wording` : `no keyword match; "${main.name}" is the ${DOMAIN_LABEL[domain] || domain} default`;

    let request = null;
    let response = main;
    let rule;
    if (method === 'GET') {
      rule = 'GET: no request body; returns the object';
    } else if (method === 'PUT') {
      request = main;
      rule = 'PUT: updates and returns the object';
    } else {
      request = main;
      const result = EVALUATIVE_VERBS.test(task) ? scored.find((s) => s.object.category === 'Result' && s.object !== main)?.object : null;
      if (main.category === 'Result') {
        response = main;
        rule = 'POST: evaluative task returns the result object';
      } else if (result) {
        response = result;
        rule = `POST: evaluative task returns "${result.name}"`;
      } else if (isSystemService) {
        response = ACK;
        rule = 'POST: system service returns an acknowledgement';
      } else {
        response = main;
        rule = 'POST: returns the created/updated object';
      }
    }

    stats.apis += 1;
    stats.byRule[rule.replace(/".*"/, '"…"')] = (stats.byRule[rule.replace(/".*"/, '"…"')] || 0) + 1;
    if (request) usage.get(request.id).request += 1;
    usage.get(response.id).response += 1;

    return {
      ...values,
      [REQUEST_KEY]: request ? request.id : '',
      [RESPONSE_KEY]: response.id,
      [PAYLOAD_BASIS_KEY]: `Generated: ${mainBasis}. ${rule}.`,
    };
  }

  const apiBatches = await db.collection('dataBatches').find({ neighborhoodName: NEIGHBORHOOD, dataType: 'APIs' }).toArray();
  const apiBatchOps = apiBatches.map((batch) => {
    const rows = (batch.rows || []).map((row) => ({ ...row, values: assign(row.values || {}) }));
    const columns = [...(batch.columns || [])];
    for (const column of [REQUEST_KEY, RESPONSE_KEY, PAYLOAD_BASIS_KEY]) if (!columns.includes(column)) columns.push(column);
    return { updateOne: { filter: { _id: batch._id }, update: { $set: { rows, columns } } } };
  });
  const usageFromBatches = new Map([...usage.entries()].map(([id, u]) => [id, { ...u }]));

  const apiDocs = await canonical.find({ neighborhoodName: NEIGHBORHOOD, componentType: 'APIs' }, { projection: { values: 1 } }).toArray();
  const apiCanonicalOps = apiDocs.map((doc) => {
    const values = assign(doc.values || {});
    return { updateOne: { filter: { _id: doc._id }, update: { $set: { values, primaryKey: primaryKeyFromRow({ values }) } } } };
  });

  // ── Data Objects rows ──
  const now = new Date();
  const objectRows = objects.map((o) => {
    const u = usageFromBatches.get(o.id);
    return {
      values: {
        'OBJECT_NAME Component': o.name,
        'OBJECT_ID Qualifier': o.id,
        'Description Qualifier': o.description,
        'Business Domain Aggregate': DOMAIN_LABEL[o.domain] || o.domain,
        'Object Category Aggregate': o.category,
        'Sensitivity Aggregate': sensitivityOf(o.fields, o.category),
        'Contains PII Aggregate': o.fields.some((f) => f.pii) ? 'Yes' : 'No',
        'Field Count Qualifier': o.fields.length,
        'Fields Qualifier': o.fields.map(describeField).join('; '),
        'FK_System Components[Applications].APP_ID': o.sorAppId,
        'Generation Basis Qualifier': `Generated by ${GENERATOR}: illustrative vocabulary, not sourced from API specs. Used as request by ${u.request} and response by ${u.response} API rows.`,
        __fields: o.fields,
      },
      owner: 'Super User',
      state: 'staged',
      sourcedFrom: SOURCE_LABEL,
      createdBy: GENERATOR,
      updatedBy: GENERATOR,
    };
  });

  const batchId = `${Date.now()}dataobjects`;
  const objectBatch = {
    neighborhoodName: NEIGHBORHOOD,
    name: DATA_TYPE,
    sourceColumnName: DATA_TYPE,
    parentFactoryName: '',
    componentType: DATA_TYPE,
    qualifierColumns: [],
    foreignKeyColumns: [],
    columns: OBJECT_COLUMNS,
    owner: 'Super User',
    createdBy: GENERATOR,
    sourceFileName: SOURCE_LABEL,
    modelName: '',
    loadDomain: 'data',
    dataType: DATA_TYPE,
    batchId,
    uploadedAt: now,
    rows: objectRows,
  };

  // ── Report ──
  const unused = objects.filter((o) => { const u = usageFromBatches.get(o.id); return !u.request && !u.response; });
  const sens = {};
  for (const row of objectRows) sens[row.values['Sensitivity Aggregate']] = (sens[row.values['Sensitivity Aggregate']] || 0) + 1;
  console.log(`[data-objects] ${objects.length} objects (${objectRows.reduce((s, r) => s + r.values['Field Count Qualifier'], 0)} fields); sensitivity`, sens);
  console.log(`[data-objects] ${apiBatches.length} API batches, ${apiDocs.length} canonical APIs; rule counts (batch + canonical passes):`, stats.byRule);
  const top = [...usageFromBatches.entries()].map(([id, u]) => [objects.find((o) => o.id === id).name, u.request + u.response]).sort((a, b) => b[1] - a[1]);
  console.log('[data-objects] most used:', top.slice(0, 10).map(([n, c]) => `${n} ${c}`).join(', '));
  console.log('[data-objects] unused:', unused.map((o) => o.name).join(', ') || 'none');
  const sample = apiBatchOps[0]?.updateOne.update.$set.rows.slice(0, 4).map((r) => ({
    api: r.values['API Name Component'], method: r.values['HTTP Method Aggregate'],
    request: objects.find((o) => o.id === r.values[REQUEST_KEY])?.name || '—',
    response: objects.find((o) => o.id === r.values[RESPONSE_KEY])?.name,
  }));
  console.log('[data-objects] sample:', JSON.stringify(sample, null, 1));
  if (process.env.SAMPLE) {
    const all = apiBatchOps.flatMap((op) => op.updateOne.update.$set.rows);
    for (let i = 0; i < Number(process.env.SAMPLE); i++) {
      const r = all[(i * 7919) % all.length].values;
      console.log(`  ${r['HTTP Method Aggregate'].padEnd(4)} ${decodeEntities(r['API Name Component']).slice(0, 95).padEnd(95)} | ${objects.find((o) => o.id === r[REQUEST_KEY])?.name || '—'} -> ${objects.find((o) => o.id === r[RESPONSE_KEY])?.name}`);
    }
  }

  if (DRY_RUN) {
    console.log('[data-objects] --dry-run: nothing written.');
    await mongoose.disconnect();
    return;
  }

  // ── Write ──
  const oldBatches = await db.collection('dataBatches').deleteMany({ neighborhoodName: NEIGHBORHOOD, dataType: DATA_TYPE });
  const oldCanonical = await canonical.deleteMany({ neighborhoodName: NEIGHBORHOOD, componentType: DATA_TYPE });
  const inserted = await db.collection('dataBatches').insertOne(objectBatch);
  await canonical.insertMany(objectRows.map((row, rowIndex) => ({
    primaryKey: primaryKeyFromRow(row),
    componentType: DATA_TYPE,
    neighborhoodName: NEIGHBORHOOD,
    dataType: DATA_TYPE,
    values: row.values,
    sourceBatches: [{ batchId: String(inserted.insertedId), rowIndex, batchCollectionName: 'dataBatches' }],
    parentKeys: [], parentRefs: [], childrenRefs: [],
    createdAt: now, updatedAt: now,
  })));
  await db.collection('dataBatches').bulkWrite(apiBatchOps, { ordered: true });
  for (let i = 0; i < apiCanonicalOps.length; i += 500) await canonical.bulkWrite(apiCanonicalOps.slice(i, i + 500), { ordered: false });
  console.log(`[data-objects] replaced ${oldBatches.deletedCount} old batch(es) / ${oldCanonical.deletedCount} old canonical object(s); wrote ${objects.length} objects, ${apiBatchOps.length} API batches, ${apiCanonicalOps.length} canonical APIs.`);
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error('[data-objects] failed:', error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
