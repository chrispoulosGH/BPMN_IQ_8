/**
 * Synthetic request/response bodies built from the catalog's data-object field
 * lists. Values that identify the business transaction (customerId, vin,
 * dealerCode, contract ids ...) come from the journey context, so the same
 * customer and vehicle flow through every API of a journey and across flows.
 *
 * All data is fake. Bodies recorded on spans are redacted: PII fields are
 * masked, restricted fields (e.g. ssn) are dropped.
 */
const crypto = require('crypto');

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const int = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
const money = (min, max) => Math.round((min + Math.random() * (max - min)) * 100) / 100;
const id = (prefix, length = 8) => `${prefix}-${crypto.randomBytes(length).toString('hex').slice(0, length).toUpperCase()}`;

const FIRST = ['Avery', 'Jordan', 'Riley', 'Morgan', 'Casey', 'Taylor', 'Jamie', 'Quinn', 'Harper', 'Rowan', 'Elliot', 'Skyler'];
const LAST = ['Nakamura', 'Okafor', 'Lindqvist', 'Moreau', 'Castillo', 'Brennan', 'Haddad', 'Kowalski', 'Varga', 'Delgado'];
const MODELS = [
  { modelCode: 'SDN-200', trim: 'LX', msrp: 31450 },
  { modelCode: 'SUV-450', trim: 'Touring', msrp: 46890 },
  { modelCode: 'TRK-700', trim: 'Sport', msrp: 52300 },
  { modelCode: 'EV-300', trim: 'Long Range', msrp: 48990 },
  { modelCode: 'CRS-150', trim: 'Base', msrp: 26700 },
];
// Upsell packages: what's offered on top of the base configuration.
const PACKAGES = [
  { type: 'LEATHER_INTERIOR', code: 'PKG-LTH', price: [1450, 2900] },
  { type: 'PERFORMANCE', code: 'PKG-PRF', price: [2800, 6500] },
  { type: 'EXTERIOR_COLOR', code: 'PKG-CLR', price: [595, 1495] },
  { type: 'TECHNOLOGY', code: 'PKG-TEC', price: [1200, 3400] },
  { type: 'COLD_WEATHER', code: 'PKG-CWX', price: [450, 1100] },
  { type: 'TOWING', code: 'PKG-TOW', price: [690, 1450] },
];
const DEALERS = ['DLR-0142', 'DLR-0217', 'DLR-0388', 'DLR-0421', 'DLR-0509', 'DLR-0633'];
const VIN_CHARS = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789';

function vin() {
  let out = '1HG';
  for (let i = 0; i < 14; i += 1) out += VIN_CHARS[Math.floor(Math.random() * VIN_CHARS.length)];
  return out;
}

/** One customer + vehicle + deal, shared by all flows of a journey. */
function newJourneyContext() {
  const model = pick(MODELS);
  const price = Math.round(model.msrp * (0.94 + Math.random() * 0.06));
  const down = Math.round(price * pick([0, 0.05, 0.1, 0.15, 0.2]));
  return {
    customerId: id('CUS', 8),
    firstName: pick(FIRST),
    lastName: pick(LAST),
    dealerCode: pick(DEALERS),
    vin: vin(),
    stockNumber: id('STK', 6),
    ...model,
    salePrice: price,
    downPayment: down,
    amountFinanced: price - down,
    termMonths: pick([36, 48, 60, 72]),
    apr: money(3.9, 11.9),
    applicationId: id('CAP', 8),
    financeContractId: id('FIN', 8),
    contractId: id('SC', 8),
    contractNumber: id('VSC', 8),
    orderId: id('ORD', 8),
    quoteId: id('QTE', 8),
    offerId: id('UPS', 8),
    dealId: id('DEAL', 10),
    // Fleet orders are for many vehicles; most fleet deals are 5-40 units.
    fleetUnits: Math.max(5, Math.round(5 + Math.random() ** 2 * 55)),
    packageType: pick(PACKAGES).type,
  };
}

/** Field-name → journey-context key, for values that must stay consistent. */
const CONTEXT_FIELDS = {
  customerId: 'customerId', vin: 'vin', dealerCode: 'dealerCode', stockNumber: 'stockNumber',
  modelCode: 'modelCode', trim: 'trim', msrp: 'msrp', applicationId: 'applicationId',
  financeContractId: 'financeContractId', contractId: 'contractId', contractNumber: 'contractNumber',
  orderId: 'orderId', quoteId: 'quoteId', salePrice: 'salePrice', downPayment: 'downPayment',
  amountFinanced: 'amountFinanced', termMonths: 'termMonths', apr: 'apr', requestedAmount: 'amountFinanced',
  approvedAmount: 'amountFinanced', totalPrice: 'salePrice', configuredPrice: 'salePrice',
  offerId: 'offerId', packageType: 'packageType',
};

const ENUMS = {
  status: ['ACTIVE', 'PENDING', 'COMPLETED'],
  decision: ['APPROVED', 'APPROVED', 'APPROVED', 'CONDITIONAL', 'DECLINED'],
  method: ['ACH', 'CARD', 'FINANCED'],
  signatureMethod: ['E_SIGNATURE', 'WET_INK'],
  fundingStatus: ['PENDING', 'FUNDED'],
  retentionClass: ['SEVEN_YEARS', 'PERMANENT'],
  offerStatus: ['PRESENTED', 'PRESENTED', 'ACCEPTED'],
};

function valueFor(field, ctx) {
  const key = CONTEXT_FIELDS[field.name];
  if (key && ctx[key] !== undefined) return ctx[key];
  const name = field.name.toLowerCase();
  switch (field.type) {
    case 'integer': return name.includes('day') ? int(1, 120) : int(1, 24);
    case 'decimal':
      if (name.includes('apr')) return ctx.apr;
      if (name === 'packageprice') {
        const pkg = PACKAGES.find((p) => p.type === ctx.packageType) || PACKAGES[0];
        return money(pkg.price[0], pkg.price[1]);
      }
      if (name.includes('propensity')) return Math.round(Math.random() * 1000) / 1000;
      if (name.includes('paymentdelta')) return money(18, 140);
      if (name.includes('incentiveamount')) return money(250, 1500);
      if (name.includes('income')) return money(42000, 185000);
      if (name.includes('monthly')) return Math.round((ctx.amountFinanced * (1 + ctx.apr / 100)) / ctx.termMonths * 100) / 100;
      if (name.includes('discount') || name.includes('allowance') || name.includes('fee') || name.includes('tax')) return money(250, 4200);
      return money(500, 4800);
    case 'boolean': return Math.random() < 0.92;
    case 'date': {
      // Start-type dates are near today; end-type dates are months/years out.
      const days = /expir|until|end|maturity/.test(name) ? int(365, 365 * 5) : /birth/.test(name) ? -int(365 * 22, 365 * 70) : int(0, 30);
      return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
    }
    case 'datetime': return new Date().toISOString();
    case 'enum': return pick(ENUMS[field.name] || ['ACTIVE', 'PENDING']);
    case 'string[]': return Array.from({ length: int(1, 3) }, () => id(field.name.replace(/s$/, '').slice(0, 3).toUpperCase(), 4));
    case 'DocumentRef[]': return [{ documentId: id('DOC', 8), documentType: 'RETAIL_INSTALLMENT_CONTRACT' }];
    default:
      if (name === 'ssn') return `${int(100, 899)}-${int(10, 99)}-${int(1000, 9999)}`;
      if (name.includes('email')) return `${ctx.firstName}.${ctx.lastName}@example.com`.toLowerCase();
      if (name.includes('employer')) return pick(['Northwind Logistics', 'Contoso Health', 'Fabrikam Tools', 'Tailspin Air']);
      if (name.includes('signedby') || name.includes('deliveredby')) return `${ctx.firstName} ${ctx.lastName}`;
      if (name.includes('currency')) return 'USD';
      if (name.includes('token')) return `tok_${crypto.randomBytes(8).toString('hex')}`;
      if (name.includes('uri')) return `s3://dealer-docs/${ctx.dealerCode}/${id('DOC', 8)}.pdf`;
      if (name === 'packagecode') return (PACKAGES.find((p) => p.type === ctx.packageType) || PACKAGES[0]).code;
      if (name === 'incentivecode') return pick(['INC-LOYALTY-500', 'INC-PKG-BUNDLE', 'INC-QUARTER-END', 'INC-CONQUEST']);
      if (name.endsWith('id') || name.includes('number') || name.includes('code')) return id(field.name.slice(0, 3).toUpperCase(), 8);
      return `${field.name}-${int(100, 999)}`;
  }
}

/** A body for a data object, or null when the API carries none. */
function buildBody(dataObject, ctx) {
  if (!dataObject) return null;
  const body = {};
  for (const field of dataObject.fields || []) {
    if (!field.required && Math.random() < 0.1) continue; // optional fields are sometimes omitted
    body[field.name] = valueFor(field, ctx);
  }
  return body;
}

/** Copy safe to put on a span: PII masked, restricted fields dropped. */
function redact(body, dataObject) {
  if (!body || !dataObject) return body;
  const out = {};
  for (const field of dataObject.fields || []) {
    if (!(field.name in body)) continue;
    if (field.restricted) continue;
    out[field.name] = field.pii ? '[REDACTED]' : body[field.name];
  }
  return out;
}

/** Validation the provider applies: required fields must be present. */
function missingRequired(body, dataObject) {
  if (!dataObject) return [];
  return (dataObject.fields || []).filter((f) => f.required && (body == null || body[f.name] === undefined)).map((f) => f.name);
}

module.exports = { newJourneyContext, buildBody, redact, missingRequired };
