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
  businessFlow?: string | null;
  capabilities?: CapabilityMatch[];
  status?: string;
  sourcedFrom?: string;
  createdBy?: string;
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
