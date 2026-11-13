export interface DiagramMeta {
  _id: string;
  name: string;
  description: string;
  tags: string[];
  version: number;
  fileName: string | null;
  capabilities: CapabilityMatch[];
  tasks: DiagramTask[];
  lineOfBusiness?: string | null;
  channel?: string | null;
  domain?: string | null;
  subdomain?: string | null;
  product?: string | null;
  businessCapability?: string | null;
  valueStream?: string | null;
  journey?: string | null;
  businessFlow?: string | null;
  status?: string | null;
  sourcedFrom?: string | null;
  owner?: string | null;
  createdBy?: string | null;
  updatedBy?: string | null;
  neighborhoodName?: string | null;
  createdAt: string;
  updatedAt: string;
}

// One entry in a sticky note's audit trail — who changed what, and when.
// Append-only: created fresh on note creation, then one entry per
// text/color/position edit (see BpmnEditor.tsx's appendNoteHistory).
export interface DiagramNoteHistoryEntry {
  userId: string;
  date: string;
  change: string;
}

// A sticky note pinned onto a diagram's canvas (Diagrams tab). dx/dy are
// stored relative to the diagram's own content anchor (the same top-left
// point its canvas-anchored title banner uses), not absolute canvas
// coordinates — see server/models/Diagram.js.
export interface DiagramNote {
  id: string;
  text: string;
  color: string;
  dx: number;
  dy: number;
  createdBy?: string | null;
  createdAt?: string;
  updatedBy?: string | null;
  updatedAt?: string;
  history?: DiagramNoteHistoryEntry[];
}

// One SOX (ICFR) control from the soxcontrols collection — see
// server/models/SoxControl.js for field semantics and
// server/scripts/seed_sox_controls.js for how controls are scoped.
export interface SoxControl {
  _id?: string;
  controlId: string;
  title: string;
  description: string;
  controlObjective: string;
  riskStatement: string;
  category: 'IT General Control' | 'Business Process Control' | 'IT Application Control' | 'Interface Control';
  itgcDomain: string | null;
  processCycle: string | null;
  processCycleName: string | null;
  controlType: 'Preventive' | 'Detective';
  controlNature: 'Manual' | 'Automated' | 'IT-Dependent Manual';
  frequency: string;
  keyControl: boolean;
  assertions: string[];
  financialStatementAccounts: string[];
  controlOwner: string;
  performedBy: string;
  evidence: string;
  testingProcedure: string;
  sampleSize: string;
  auditRisk: 'High' | 'Medium' | 'Low';
  auditRiskRationale: string;
  observations: string[];
  frameworkRefs: string[];
  relatedControlIds: string[];
  status: string;
  // Attached by the server routes (soxdeviations), newest first.
  deviations?: SoxDeviation[];
  scope: {
    level: 'application' | 'businessFlow' | 'task' | 'api';
    applications: Array<{ name: string; appId: string | null; appName: string; businessCriticality: string | null; dataClassification: string | null }>;
    businessFlows: Array<{ diagramId: string; name: string; domain: string; subdomain: string }>;
    tasks: Array<{ diagramId: string; flowName: string; taskName: string; actor: string; applications: string[] }>;
    apis: Array<{ apiId: string; name: string; endpoint: string; method: string; apiType: string; interactionScope: string }>;
    servers: Array<{ serverId: string; name: string; role: string; networkZone: string; patchingStatus: string; complianceStatus: string; backupStatus: string; encryptionStatus: string; criticalVulns: number }>;
    databases: Array<{ softwareId: string; name: string; version: string; serverId: string | null; function: string }>;
  };
}

// A deviation (deficiency) raised against a SOX control — see
// server/models/SoxDeviation.js and scripts/seed_sox_deviations.js.
export interface SoxDeviation {
  deviationId: string;
  controlId: string;
  controlTitle: string;
  controlCategory: string;
  category: 'Control Not Sufficient' | 'Issue Found During Audit' | 'Missing Control' | 'Insufficient Evidence';
  severity: 'Low' | 'Medium' | 'High';
  deficiencyClassification: 'Control Deficiency' | 'Significant Deficiency' | 'Potential Material Weakness';
  deficiencyType: string;
  title: string;
  condition: string;
  criteria: string;
  cause: string;
  effect: string;
  recommendation: string;
  managementResponse: string;
  testing: { population: string; sampleSize: number | null; exceptions: number | null };
  source: string;
  audit: { auditId: string; auditName: string; auditorOrganization: string; auditor: string; auditDate: string; periodStart: string; periodEnd: string };
  affected: {
    process: string;
    businessFlows: Array<{ diagramId: string; name: string; domain: string }>;
    tasks: Array<{ diagramId: string; flowName: string; taskName: string; actor: string }>;
    applications: Array<{ name: string; appId: string | null; appName: string }>;
    databases: Array<{ softwareId: string; name: string; version: string; serverId: string | null }>;
    servers: Array<{ serverId: string; name: string; role: string; patchingStatus: string; backupStatus: string }>;
    apis: Array<{ apiId: string; name: string; endpoint: string; method: string }>;
  };
  remediation: { owner: string; targetDate: string; status: 'Open' | 'In Remediation' | 'Remediated — Pending Validation' | 'Closed'; repeatFinding: boolean };
}

// GET /api/sox-controls/for-diagram/:id — controls grouped by where their
// icon goes on the canvas. Task/application keys are lower-cased, trimmed
// names (same normalization as BpmnEditor's normalizeImpactName).
export interface DiagramSoxControls {
  diagramId: string;
  diagramControls: SoxControl[];
  byTaskName: Record<string, SoxControl[]>;
  byApplicationName: Record<string, SoxControl[]>;
}

export interface DiagramTaskApplication {
  name: string;
  correlationId?: string | null;
  acronym?: string | null;
}

export interface DiagramTask {
  name: string;
  source: string | null;
  target: string | null;
  applications: DiagramTaskApplication[];
}

export interface Diagram extends DiagramMeta {
  xml: string;
}

export interface DiagramCreatePayload {
  name: string;
  description?: string;
  xml: string;
  tags?: string[];
  lineOfBusiness?: string | null;
  channel?: string | null;
  domain?: string | null;
  subdomain?: string | null;
  product?: string | null;
  valueStream?: string | null;
  journey?: string | null;
  businessCapability?: string | null;
  businessFlow?: string | null;
  capabilities?: CapabilityMatch[];
  status?: string;
  sourcedFrom?: string;
  createdBy?: string;
  // Ignore the supplied `xml` and build a fresh, properly-formatted skeleton
  // instead (lane, left-justified layout, title breadcrumb) — matches what
  // the load/generation pipeline produces. Used by the "New Diagram" dialog.
  generateSkeleton?: boolean;
}

export interface DiagramUpdatePayload {
  name?: string;
  description?: string;
  xml?: string;
  tags?: string[];
  lineOfBusiness?: string | null;
  channel?: string | null;
  domain?: string | null;
  subdomain?: string | null;
  product?: string | null;
  valueStream?: string | null;
  journey?: string | null;
  businessCapability?: string | null;
  businessFlow?: string | null;
  capabilities?: CapabilityMatch[];
  changeNote?: { userId: string; note: string };
  status?: string;
  sourcedFrom?: string;
  updatedBy?: string;
}

export interface DiagramValidationRequest {
  id?: string;
  xml?: string;
  name?: string;
  businessFlow?: string;
  capabilities?: CapabilityMatch[];
  neighborhoodName?: string;
}

export interface DiagramValidationReport {
  isValid: boolean;
  neighborhoodName: string;
  diagramName: string | null;
  businessFlow: string | null;
  summary: {
    hasBusinessFlowReference: boolean;
    hasCapabilities: boolean;
    metadataInvalidFieldCount: number;
    invalidTaskCount: number;
    invalidApplicationCount: number;
    invalidActorCount: number;
  };
  reasons: string[];
  details: {
    metadataInvalidFields: Array<{ fieldName: string; label: string; value: string }>;
    invalidTasks: string[];
    invalidApplications: string[];
    invalidActors: string[];
  };
}

export interface FileSaveResult {
  message: string;
  filename: string;
}

export interface CapabilityMatch {
  capabilityId: number;
  capabilityName: string;
  confidence: number;
  justification: string;
}

export interface CapabilityMatchResult {
  processSummary: string;
  extractedKeywords: {
    lanes: string[];
    tasks: string[];
    subProcesses: string[];
    titleAnnotation: string | null;
  };
  matches: CapabilityMatch[];
}

// ─── Task Factory ────────────────────────────────────────────

/** Data bundle passed when navigating to "Add to Task Factory" from the diagram */
export interface TaskAddData {
  name: string;
  applications?: string[];
  actor?: string;
  businessFlow?: string;
  product?: string;
  channel?: string;
  domain?: string;
  subdomain?: string;
}

/** Metadata parsed from the BPMNDiagram name attribute */
export interface DiagramMetadata {
  lineOfBusiness?: string;
  channel?: string;
  domain?: string;
  subdomain?: string;
  product?: string;
  businessCapability?: string;
  valueStream?: string;
  journey?: string;
  businessFlow?: string;
}

export interface TaskRecord {
  _id: string;
  name: string;
  businessFlow: string;
  product: string;
  domain?: string;
  subdomain?: string;
  channel?: string;
  actor?: string;
  applications: string[];
  sequence?: number;
  owner?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface TaskCreatePayload {
  name: string;
  businessFlow: string;
  product: string;
  domain?: string;
  subdomain?: string;
  channel?: string;
  actor?: string;
  applications?: string[];
  sequence?: number;
  owner?: string;
}

export interface ReferenceData {
  businessFlows: { _id: string; name: string }[];
  products: { _id: string; name: string }[];
  applications: ApplicationItem[];
  actors: { _id: string; name: string }[];
  channels: { _id: string; name: string }[];
  domains: { _id: string; name: string }[];
  subdomains: { _id: string; name: string }[];
}

// ─── Reference Factory ───────────────────────────────────────
export interface RefItem {
  _id: string;
  name: string;
  owner?: string;
  createdAt?: string;
  updatedAt?: string;
  state?: string;
}

export interface ApplicationItem extends RefItem {
  correlationId?: string;
  shortDescription?: string;
  applicationType?: string;
  businessCriticality?: string;
  discoverySource?: string;
  installType?: string;
  cpniIndicator?: string;
  customerFacing?: string;
  handleSpi?: string;
  internetFacing?: string;
  pciData?: string;
  soxFsa?: string;
  storeSpi?: string;
  acronym?: string;
  applPurpose?: string;
  lifecycle?: string;
  lifecycleStatus?: string;
  businessPurpose?: string;
  pciDataStored?: string;
  userInterface?: string;
}

export interface ServerLinkedApplication {
  correlationId?: string | null;
  name?: string | null;
  acronym?: string | null;
  apmNumber?: string | null;
  relationType?: string | null;
  relationSystemId?: string | null;
}

export interface ServerHealthNote {
  label: string;
  severity?: 'info' | 'low' | 'medium' | 'high' | 'critical';
  note: string;
  rationale?: string | null;
  decisionFactors?: string[];
  vulnerabilities?: string[];
  sourceUrl?: string | null;
}

export interface ServerItem {
  _id: string;
  sourceKey: string;
  name: string;
  serverSystemId?: string | null;
  objectId?: string | null;
  assetId?: string | null;
  assetTag?: string | null;
  hostName?: string | null;
  fqdn?: string | null;
  ipAddress?: string | null;
  macAddress?: string | null;
  environment?: string | null;
  installStatus?: string | null;
  operationalStatus?: string | null;
  lifecycleStage?: string | null;
  lifecycleStatus?: string | null;
  usedFor?: string | null;
  os?: string | null;
  osVersion?: string | null;
  osDomain?: string | null;
  osServicePack?: string | null;
  normalizedOs?: string | null;
  normalizedOsVersion?: string | null;
  normalizedOsServicePack?: string | null;
  vendorName?: string | null;
  manufacturer?: string | null;
  modelNumber?: string | null;
  serialNumber?: string | null;
  cpuCount?: number | null;
  cpuName?: string | null;
  cpuSpeed?: string | null;
  ram?: number | null;
  location?: string | null;
  supportGroup?: string | null;
  supportedBy?: string | null;
  managedByGroup?: string | null;
  cloudAccountId?: string | null;
  internetFacing?: string | null;
  virtualized?: boolean | null;
  className?: string | null;
  relationTypes?: string[];
  relationPorts?: string[];
  linkedApplications?: ServerLinkedApplication[];
  healthNotes?: ServerHealthNote[];
  createdAt?: string;
  updatedAt?: string;
}

export interface DatabaseLinkedApplication {
  correlationId?: string | null;
  name?: string | null;
  acronym?: string | null;
  apmNumber?: string | null;
  serviceName?: string | null;
}

export interface DatabaseHealthNote {
  label: string;
  severity?: 'info' | 'low' | 'medium' | 'high' | 'critical';
  note: string;
  rationale?: string | null;
  decisionFactors?: string[];
  vulnerabilities?: string[];
  sourceUrl?: string | null;
}

export interface FactoryNeighborhoodSummary {
  name: string;
  owner?: string;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
  factoryCount: number;
}

export interface ModelCatalogRow {
  values: Record<string, unknown>;
}

export interface ModelCatalog {
  name: string;
  columns: string[];
  rowCount: number;
  unfilteredRowCount?: number;
  rows: ModelCatalogRow[];
  sourceFileName?: string;
  createdAt?: string;
  updatedAt?: string;
  pagination?: {
    currentPage: number;
    limit: number;
    totalPages: number;
    hasMore: boolean;
    totalCount?: number;
  };
}

export interface CatalogTreeNode {
  key: string;
  name: string;
  typeName: string;
  depth: number;
  isLeaf: boolean;
  children?: CatalogTreeNode[];
}

export interface CatalogTreeResponse {
  mode: 'full' | 'lazy';
  tupleColumns: string[];
  nodeCount?: number;
  roots: CatalogTreeNode[];
}

export interface CatalogTreeChildrenResponse {
  path: string[];
  children: CatalogTreeNode[];
}

export interface CatalogTreeSearchPathNode {
  name: string;
  typeName: string;
  depth: number;
}

export interface CatalogTreeSearchResponse {
  term: string;
  tupleColumns: string[];
  paths: CatalogTreeSearchPathNode[][];
  truncated: boolean;
}

export interface CustomFactoryQualifierColumn {
  name: string;
  sourceColumnName: string;
  fieldName: string;
}

export interface CustomFactoryRow {
  _id: string;
  values: Record<string, unknown>;
  owner?: string;
  state: string;
  sourcedFrom?: string;
  createdBy?: string;
  updatedBy?: string;
  parentFactoryName?: string;
  parentName?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface CustomFactory {
  _id: string;
  neighborhoodName: string;
  name: string;
  sourceColumnName?: string;
  shortDescription?: string;
  applicationType?: string;
  businessCriticality?: string;
  parentFactoryName?: string;
  componentType?: string;
  dataType?: string;
  loadDomain?: string;
  columns: string[];
  qualifierColumns?: CustomFactoryQualifierColumn[];
  foreignKeyColumns?: Array<{
    name: string;
    sourceColumnName: string;
    fieldName: string;
    targetReference?: string;
    targetGroup?: string;
    targetScope?: string;
    targetColumnName?: string;
    targetColumnNameBase?: string;
  }>;
  owner?: string;
  createdBy?: string;
  sourceFileName?: string;
  createdAt?: string;
  updatedAt?: string;
  rowCount: number;
  rows: CustomFactoryRow[];
}

export interface DatabaseItem {
  _id: string;
  sourceKey: string;
  apmNumber?: string | null;
  applicationCorrelationId?: string | null;
  applicationAcronym?: string | null;
  applicationName?: string | null;
  applicationInstallStatus?: string | null;
  serviceName?: string | null;
  instanceName: string;
  name: string;
  databaseClassName?: string | null;
  applicationOwner?: string | null;
  lowestLevelOwner?: string | null;
  lowestLevelOwnerUserName?: string | null;
  version?: string | null;
  vendor?: string | null;
  ownedBy?: string | null;
  location?: string | null;
  lifecycleStageStatus?: string | null;
  normalizedVendor?: string | null;
  linkedApplications?: DatabaseLinkedApplication[];
  healthNotes?: DatabaseHealthNote[];
  createdAt?: string;
  updatedAt?: string;
}

// Component Search Index hierarchy types
export interface ComponentHierarchy {
  componentName: string;
  rowName: string;
  rowId?: string;
  componentId?: string;
  qualifiers?: Record<string, string>;
}

export interface HierarchyPath {
  pathKey: string;
  nodes: ComponentHierarchy[];
  pathStr: string;
  fieldValues: Record<string, unknown>;
  rowId?: string;
  componentId?: string;
}

export interface HierarchiesResponse {
  totalPaths: number;
  uniqueCount: number;
  paths: HierarchyPath[];
}

// ─── Capabilities Factory ────────────────────────────────────
export interface CapabilityItem {
  _id: string;
  capabilityId?: number;
  name: string;
  domainName?: string;
  aspect?: string;
  briefDescription?: string;
  tmfVersion?: string;
  owner?: string;
  createdAt?: string;
  updatedAt?: string;
  state?: string;
}

// ─── Process Change Radar ───────────────────────────────────────────────
// A Jira issue that names one of our three custom fields (Business Process
// Flow/Application/API) and isn't Done/Closed yet — see
// server/services/jiraClient.js for how these are built. Business Process
// Flow names a diagram directly (matched server-side against
// Diagram.businessFlow/name, so the issue shows up in that diagram's
// `issues` below) — it has no task-level anchor. `source`/`matchedValue` are
// only set once the server fans an issue out into issuesByApplicationName
// (one issue can appear under more than one name, and more than once per
// name-map, if it names several apps/APIs).
export interface JiraImpactIssue {
  key: string;
  url: string;
  summary: string;
  status: string;
  statusCategory: string;
  issueType: string | null;
  priority: string | null;
  assignee: string | null;
  updated: string | null;
  dueDate: string | null;
  isOverdue: boolean;
  storyPoints: number;
  devDays: number;
  businessFlowNames: string[];
  applicationNames: string[];
  apiNames: string[];
  source?: 'businessFlow' | 'application' | 'api';
  matchedValue?: string;
}

// One point for the "impacted applications" 3D map (see
// ApplicationImpact3DChart.tsx): an application named by at least one of
// this diagram's matched issues, with its issue count, nearest due date, and
// business criticality (from System Components reference data — null when
// that data isn't loaded for the app, which the chart buckets as "Unknown").
export interface JiraApplicationImpact {
  name: string;
  issueCount: number;
  nearestDueDate: string | null;
  businessCriticality: string | null;
}

export interface ProcessChangeRadarDiagramSummary {
  diagramId: string;
  name: string;
  neighborhoodName?: string | null;
  status?: string | null;
  domain?: string | null;
  issueCount: number;
  atRiskCount: number;
  totalDevDays: number;
  // Every issue matched to this diagram (Business Process Flow match, plus
  // any Application/API match via one of its tasks), deduped by issue key.
  issues: JiraImpactIssue[];
  applicationImpact: JiraApplicationImpact[];
}

export interface ProcessChangeRadarResponse {
  configured: boolean;
  generatedAt: string;
  diagrams: ProcessChangeRadarDiagramSummary[];
  // Keyed by normalized (trim + lowercase) application name.
  issuesByApplicationName: Record<string, JiraImpactIssue[]>;
}

// Result of running server/services/processOptimizerAgent.js against one
// business flow — see server/models/ProcessOptimizationProposal.js. Never a
// direct diagram edit; a proposal is advisory until a human accepts it.
export interface ProcessOptimizerTaskDiffEntry {
  op: 'add' | 'remove' | 'retarget_application' | 'rename';
  taskId?: string;
  taskName?: string;
  actor?: string;
  detail?: Record<string, unknown>;
  reason: string;
}

export interface ProcessOptimizerProjectedImpact {
  costDeltaUsd?: number;
  securityRiskDelta?: number;
  defectRiskDelta?: number;
  jiraActivityDelta?: number;
}

export interface ProcessOptimizerToolCall {
  tool: string;
  args: Record<string, unknown>;
  resultSummary: string;
}

export interface ProcessOptimizationProposal {
  _id: string;
  diagramId: string;
  diagramName?: string;
  businessFlow?: string;
  summary: string;
  rationale: string[];
  taskDiff: ProcessOptimizerTaskDiffEntry[];
  projectedImpact: ProcessOptimizerProjectedImpact;
  confidence?: number;
  status: 'proposed' | 'accepted' | 'rejected';
  generatedBy: string;
  model?: string;
  toolCallLog?: ProcessOptimizerToolCall[];
  createdAt: string;
  updatedAt: string;
}

// One day's Process Change Heat Map rollup, for the trend chart above it —
// see server/models/ProcessChangeSnapshot.js. Posted by the heat map itself
// every time it loads (upserted by `date`, so same-day re-visits update
// rather than duplicate) and read back for the history line.
export interface ProcessChangeDomainSnapshot {
  domain: string;
  totalFlows: number;
  redCount: number;
  amberCount: number;
  greenCount: number;
}

export interface ProcessChangeSnapshot {
  date: string; // YYYY-MM-DD (UTC)
  generatedAt: string;
  totalFlows: number;
  redCount: number;
  amberCount: number;
  greenCount: number;
  totalIssues: number;
  totalPoints: number;
  overduePoints: number;
  dueSoon7Points: number;
  // Added after the aggregate-only version shipped — a history row from
  // before this existed simply has no byDomain (undefined), not [].
  byDomain?: ProcessChangeDomainSnapshot[];
}

export interface ActorItem {
  _id: string;
  name: string;
  role?: string;
  description?: string;
  owner?: string;
  createdAt?: string;
  updatedAt?: string;
  state?: string;
}

// GET /api/dashboard/flow-scorecards — one per business process flow
// diagram, for the Dashboard tab's per-flow tiles (see
// server/routes/dashboard.js). Change exposure is merged in client-side from
// the Process Change Radar response.
export interface FlowScorecard {
  diagramId: string;
  name: string;
  businessFlow: string | null;
  domain: string;
  subdomain: string | null;
  status: string | null;
  neighborhoodName: string | null;
  applications: string[];
  security: { probability: number; severity: string; atRiskAssets: number; assets: number } | null;
  defect: { probability: number; criticality: string; atRiskAssets: number; assets: number } | null;
  sox: {
    inScope: boolean;
    flowInScope: boolean;
    controlCount: number;
    keyControlCount: number;
    controlsWithDeviations: number;
    compliancePct: number | null;
    openDeviations: number;
    bySeverity: { High: number; Medium: number; Low: number };
    overdueDeviations: number;
  };
  tco: {
    year: number | null;
    total: number;
    run: number;
    application: number;
    infrastructure: number;
    software: number;
    development: number;
    developmentPriorYear: number;
    priorYearTotal: number;
    uncostedApplications: number;
  };
}

export interface FlowScorecardsResponse {
  generatedAt: string;
  tcoYear: number | null;
  scorecards: FlowScorecard[];
}

// ── Integration Map (GET /api/integration-map) ───────────────────────────────
export interface IntegrationMapApp {
  id: string;
  acronym: string;
  name: string;
  domain: string;
  criticality: string;
  providedApiCount: number;
  consumedApiCount: number;
  internalApiCount: number;
}

export interface IntegrationMapApi {
  id: string;
  name: string;
  businessFlow: string;
  task: string;
  method: string;
  type: string;
  lifecycle: string;
  endpoint: string;
  /** Derived host server id (see IntegrationMapResponse.hostAssignmentNote). */
  host: string;
  /** Generated data object ids (see IntegrationMapResponse.dataObjectNote); '' = no request body. */
  requestObject: string;
  responseObject: string;
}

export interface IntegrationMapDataObjectField {
  name: string;
  type: string;
  required: boolean;
  pii: boolean;
  financial: boolean;
  restricted: boolean;
}

export interface IntegrationMapDataObject {
  id: string;
  name: string;
  category: string;
  domain: string;
  sensitivity: string;
  containsPii: boolean;
  /** System-of-record app id. */
  systemOfRecord: string;
  fields: IntegrationMapDataObjectField[];
}

export interface IntegrationMapLink {
  /** Provider app id. */
  source: string;
  /** Consumer app id. */
  target: string;
  count: number;
  businessFlows: string[];
  /** Data objects carried (request or response, acknowledgements excluded), most frequent first. */
  dataObjects: Array<{ id: string; count: number }>;
  apis: IntegrationMapApi[];
}

export interface IntegrationMapHost {
  id: string;
  name: string;
  role: string;
  city: string;
  datacenter: string;
  environment: string;
}

export interface IntegrationMapResponse {
  generatedAt: string;
  apps: IntegrationMapApp[];
  links: IntegrationMapLink[];
  hosts: Record<string, IntegrationMapHost>;
  dataObjects: Record<string, IntegrationMapDataObject>;
  dataObjectNote: string;
  hostAssignmentNote: string;
  internalApiCount: number;
  unlinkedApiCount: number;
}

// ── API sequence for one business flow (GET /api/integration-map/sequence/:diagramId) ──
export interface ApiSequenceParticipant {
  id: string;
  acronym: string;
  name: string;
  domain: string;
  criticality: string;
  unassigned?: boolean;
}

export interface ApiSequenceCall {
  number: number;
  id: string;
  name: string;
  method: string;
  type: string;
  lifecycle: string;
  endpoint: string;
  provider: string;
  consumer: string;
  host: string;
  requestObject: string;
  responseObject: string;
  /** Participant ids: provider → consumer (the direction the data moves). */
  from: string;
  to: string;
  internal: boolean;
}

export interface ApiSequenceStep {
  taskId: string;
  taskName: string;
  taskType: string;
  lane: string;
  calls: ApiSequenceCall[];
}

export interface ApiSequenceFragment {
  type: 'alt' | 'par' | 'opt';
  gatewayType: string;
  label: string;
  branches: Array<{ label: string; steps: ApiSequenceStep[] }>;
}

export type ApiSequenceItem =
  | { kind: 'step'; step: ApiSequenceStep }
  | { kind: 'fragment'; fragment: ApiSequenceFragment };

export interface ApiSequenceResponse {
  diagramId: string;
  diagramName: string;
  businessFlow: string;
  domain: string;
  subdomain: string;
  lanes: string[];
  participants: ApiSequenceParticipant[];
  items: ApiSequenceItem[];
  callCount: number;
  taskCount: number;
  tasksWithoutApi: number;
  fragmentCount: number;
  dataObjects: Record<string, IntegrationMapDataObject>;
  hosts: Record<string, IntegrationMapHost>;
  directionNote: string;
  dataObjectNote: string;
}

// ── Discovered processes (GET /api/discovered-processes) ─────────────────────
export interface DiscoveredProcessTask {
  id: string;
  name: string;
  lane: string;
  applications: string[];
  apis: Array<{ id: string; method: string; route: string; provider: string; count: number }>;
  observedCount: number;
  medianDurationMs: number;
}

export interface DiscoveredProcess {
  name: string;
  processId: string;
  domain: string;
  subdomain: string;
  instancesAnalyzed: number;
  outcomes: Record<string, number>;
  completionRate: number;
  firstSeen: string | null;
  lastSeen: string | null;
  lanes: Array<{ id: string; name: string }>;
  tasks: DiscoveredProcessTask[];
  applications: string[];
  sequenceFlowCount: number;
  /** BPMN 2.0 XML rebuilt from the traces. */
  xml: string;
}

export interface DiscoveredProcessesResponse {
  generatedAt: string;
  source: string;
  tempoUrl: string;
  lookbackHours: number;
  observedFlows: string[];
  documentedFlowsObserved: string[];
  discovered: DiscoveredProcess[];
  note: string;
}
