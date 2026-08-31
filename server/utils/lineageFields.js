// Shared mapping from a schema-factory/component-type NAME (as stored on
// Model.schemaFactories / CanonicalComponent.componentType, e.g. "Business
// Process Flow") to the lineage-snapshot FIELD name used inside a row's
// values.__lineage / values.__lineageVariants (e.g. "businessFlow").
//
// Single source of truth — used by both the search-index builder (to climb
// a row's ancestor chain via lineage matching) and the hierarchy-options /
// model-schema endpoints that power the "New Diagram" dialog's cascading
// dropdowns, so the two never drift apart.
const LINEAGE_FIELD_ALIASES = new Map([
  ['lineofbusiness', 'lineOfBusiness'],
  ['lob', 'lineOfBusiness'],
  ['channel', 'channel'],
  ['product', 'product'],
  ['domain', 'domain'],
  ['l0', 'domain'],
  ['subdomain', 'subdomain'],
  ['l1', 'subdomain'],
  ['valuestream', 'valueStream'],
  ['journey', 'journey'],
  ['businesscapability', 'businessCapability'],
  ['businessprocessflow', 'businessFlow'],
  ['businessflow', 'businessFlow'],
  ['task', 'task'],
  ['application', 'application'],
]);

function mapComponentNameToLineageField(componentName) {
  const normalized = String(componentName || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  return LINEAGE_FIELD_ALIASES.get(normalized) || null;
}

module.exports = { LINEAGE_FIELD_ALIASES, mapComponentNameToLineageField };
