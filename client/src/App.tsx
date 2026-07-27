import { memo, useState, useRef, useCallback, useEffect, useLayoutEffect, useMemo } from 'react';
import {
  Layout,
  Button,
  Space,
  Tooltip,
  Typography,
  Input,
  Card,
  Tabs,
  Modal,
  Select,
  App as AntApp,
  Spin,
  Empty,
  Tag,
  Form,
} from 'antd';
import {
  SaveOutlined,
  UploadOutlined,
  DownloadOutlined,
  ZoomInOutlined,
  ZoomOutOutlined,
  ExpandOutlined,
  DatabaseOutlined,
  FolderOpenOutlined,
  CloudUploadOutlined,
  SearchOutlined,
  ThunderboltOutlined,
  PartitionOutlined,
  AppstoreOutlined,
  LaptopOutlined,
  ClusterOutlined,
  DeploymentUnitOutlined,
  UserOutlined,
  ShoppingOutlined,
  BankOutlined,
  PhoneOutlined,
  GlobalOutlined,
  ApartmentOutlined,
  BranchesOutlined,
  DashboardOutlined,
  FileTextOutlined,
  CheckCircleOutlined,
  PlusOutlined,
  RightOutlined,
  LeftOutlined,
  LogoutOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import BpmnEditor, { EMPTY_DIAGRAM, type BpmnEditorHandle } from './components/BpmnEditor';
import DiagramBrowser from './components/DiagramBrowser';
import SystemComponentsImportButton from './components/SystemComponentsImportButton';
import SaveModal from './components/SaveModal';
import AppMatchModal, { computeAppMatches, type AppMatchResult } from './components/AppMatchModal';
import CapabilityMatchPanel from './components/CapabilityMatchPanel';
import TaskFactory from './components/TaskFactory';
import ReferenceFactory from './components/ReferenceFactory';
import SystemComponentSummary from './components/SystemComponentSummary';
import NeighborhoodFactory from './components/NeighborhoodFactory';
import ModelCatalog from './components/ModelCatalog';
import ComponentsViewer from './components/ComponentsViewer';
import BusinessFlowFactory from './components/BusinessFlowFactory';
import CapabilitiesFactory from './components/CapabilitiesFactory';
import ActorFactory from './components/ActorFactory';
import BpmnFactory from './components/BpmnFactory';
import Dashboard from './components/Dashboard';
import ValueStreamsMatrix, { type DomainSelection, type SubdomainSelection, type ValueStreamCapabilitySelection, type ValueStreamFlowSelection, type ValueStreamRollupSelection } from './components/ValueStreamsMatrix';
import ReportsPanel from './components/ReportsPanel';
import Login from './components/Login';
import AdminPanel from './components/AdminPanel';
import GlobalComponentSearch from './components/GlobalComponentSearch';
import ComponentSearch from './components/ComponentSearch';
import { encodeExactFactorySearch } from './utils/factorySearch';
import { api, getDiagram, getDiagrams, searchDiagrams, createDiagram, updateDiagram, deleteDiagram, saveFile, matchCapabilities, batchImportDiagrams, getTaskReferenceForNeighborhood, getApplicationReferenceForNeighborhood, getTaskNames, getTaskNamesForNeighborhood, getActorsForNeighborhood, checkSession, logout, setSessionExpiredHandler, getBusinessFlowMap, getFactoryNeighborhoods, getCustomFactories, getDataFactoryTypes, getDataFactories, getCanonicalFactories, setApiNeighborhoodScope, validateDiagramReport, deleteCustomFactory, deleteDataComponentType } from './api';
import type { CapabilityMatch, TaskAddData, DiagramMetadata, ApplicationItem, CustomFactory, FactoryNeighborhoodSummary } from './types';

const { Header, Sider, Content } = Layout;
const { Text, Title } = Typography;

interface ActiveDiagram {
  _id: string;
  name: string;
  description: string;
  tags: string[];
  status?: string | null;
  neighborhoodName?: string;
  /** 'db' = loaded from DB; 'local-match' = local file whose BF name already exists in DB */
  source?: 'db' | 'local-match';
}

interface SelectedValueStreamEntity {
  type: 'businessCapability' | 'valueStream' | 'rollup' | 'domain' | 'subdomain';
  flowMode: 'valueStream' | 'journey';
  title: string;
  neighborhoodName: string;
  domain: string;
  subdomain: string;
  valueStreamName?: string;
  capabilityName?: string;
  relationshipCount: number;
  secondaryCountLabel?: string;
  tertiaryCountLabel?: string;
  metadata: Array<{ label: string; value: string }>;
}

function normalizeLookupToken(value: unknown): string {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function isBusinessCapabilityFactory(factory: CustomFactory): boolean {
  return [factory.name, factory.componentType, factory.dataType, factory.sourceColumnName]
    .map((value) => normalizeLookupToken(value))
    .some((value) => value === 'businesscapability' || value === 'businesscapabilities');
}

function getCapabilityMetadata(factory: CustomFactory | null, capabilityName: string): Array<{ label: string; value: string }> {
  if (!factory) return [];

  const target = normalizeLookupToken(capabilityName);
  if (!target) return [];

  const preferredKeys = [factory.sourceColumnName, 'name', 'business capability', 'business_capability']
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  const findMatch = (values: Record<string, unknown>) => {
    for (const key of preferredKeys) {
      if (normalizeLookupToken(values[key]) === target) return true;
    }
    return Object.values(values || {}).some((value) => normalizeLookupToken(value) === target);
  };

  const matchingRow = factory.rows.find((row) => findMatch(row.values || {}));
  if (!matchingRow) return [];

  return Object.entries(matchingRow.values || {})
    .map(([label, value]) => ({ label, value: String(value ?? '').trim() }))
    .filter((entry) => entry.value);
}

function getFactoryMetadata(factory: CustomFactory | null, targetName: string): Array<{ label: string; value: string }> {
  if (!factory) return [];

  const target = normalizeLookupToken(targetName);
  if (!target) return [];

  const preferredKeys = [factory.sourceColumnName, 'name', factory.name]
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  const matchingRow = factory.rows.find((row) => {
    const values = row.values || {};
    for (const key of preferredKeys) {
      if (normalizeLookupToken(values[key]) === target) return true;
    }
    return Object.values(values || {}).some((value) => normalizeLookupToken(value) === target);
  });
  if (!matchingRow) return [];

  return Object.entries(matchingRow.values || {})
    .map(([label, value]) => ({ label, value: String(value ?? '').trim() }))
    .filter((entry) => entry.value);
}

function extractTaskNames(xml: string): string[] {
  const tasks: string[] = [];
  const regex = /<bpmn2?:(?:task|userTask|serviceTask|sendTask|receiveTask|manualTask|businessRuleTask|scriptTask|subProcess)[^>]*name="([^"]+)"/gi;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    tasks.push(normalizeExtractedApplicationName(match[1]));
  }
  return tasks;
}

function decodeXmlEntities(value: string): string {
  const namedEntities: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
  };

  return String(value || '')
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number(dec);
      return Number.isFinite(code) ? String.fromCharCode(code) : _;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCharCode(code) : _;
    })
    .replace(/&([a-z]+);/gi, (match, name) => namedEntities[name.toLowerCase()] ?? match);
}

function normalizeExtractedApplicationName(value: string): string {
  let next = String(value || '');
  // Handle single-encoded and double-encoded content (&amp;#10; -> &#10; -> newline)
  for (let i = 0; i < 2; i += 1) {
    const decoded = decodeXmlEntities(next);
    if (decoded === next) break;
    next = decoded;
  }
  return next.replace(/\s+/g, ' ').trim();
}

function splitExtractedApplicationNames(value: string): string[] {
  let next = String(value || '');
  // Decode before splitting so encoded separators such as &#10; become real delimiters.
  for (let i = 0; i < 2; i += 1) {
    const decoded = decodeXmlEntities(next);
    if (decoded === next) break;
    next = decoded;
  }

  return next
    .split(/[\r\n,;]+/)
    .map((token) => normalizeExtractedApplicationName(token))
    .filter(Boolean);
}

function extractApplicationsFromXml(xml: string): string[] {
  const apps: string[] = [];
  const addApp = (name: string) => {
    const candidates = splitExtractedApplicationNames(name);
    for (const candidate of candidates) {
      if (!apps.some((entry) => entry.toLowerCase() === candidate.toLowerCase())) {
        apps.push(candidate);
      }
    }
  };

  const taskBlockRegex = /<bpmn2?:(?:task|userTask|serviceTask|sendTask|receiveTask|manualTask|businessRuleTask|scriptTask|subProcess)\b[^>]*>[\s\S]*?<\/bpmn2?:(?:task|userTask|serviceTask|sendTask|receiveTask|manualTask|businessRuleTask|scriptTask|subProcess)>/gi;
  let taskMatch;
  while ((taskMatch = taskBlockRegex.exec(xml)) !== null) {
    const body = taskMatch[0];

    // Source: bpmniq:Application name="..." entries inside task extension elements
    const appAttrRegex = /<(?:bpmniq|ns\d+):(?:A|a)pplication\b[^>]*\bname="([^"]+)"/gi;
    let appMatch;
    while ((appMatch = appAttrRegex.exec(body)) !== null) {
      addApp(appMatch[1]);
    }

    // Source: bpmniq:application elements with nested bpmniq:name nodes
    const appRegex = /<(?:bpmniq|ns\d+):application\b[^>]*>[\s\S]*?<(?:bpmniq|ns\d+):name>([\s\S]*?)<\/(?:bpmniq|ns\d+):name>[\s\S]*?<\/(?:bpmniq|ns\d+):application>/gi;
    while ((appMatch = appRegex.exec(body)) !== null) {
      addApp(appMatch[1]);
    }
  }

  return apps;
}

function isApplicationAlreadyValidated(applicationName: string, referenceApplications: ApplicationItem[]): boolean {
  const target = normalizeLookupToken(applicationName);
  if (!target) return false;

  return referenceApplications.some((application) => {
    const identifiers = [application.correlationId, application.acronym, application.name]
      .map((value) => normalizeLookupToken(value));
    return identifiers.includes(target);
  });
}

function getCapabilityFocusName(rawName: string): string {
  const levels = String(rawName || '')
    .split(/[>,]/)
    .map((s) => s.trim())
    .filter(Boolean);

  let clickedName = levels[levels.length - 1] || rawName;
  let maxLevel = -1;
  for (const segment of levels) {
    const m = segment.match(/(?:^|\b)(?:l|level)\s*(\d+)(?:\b|$)/i) || segment.match(/^(\d+)(?:[.)\-\s]|$)/);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > maxLevel) {
      maxLevel = n;
      clickedName = segment;
    }
  }

  return (
    clickedName
      .replace(/^(?:l|level)\s*\d+\s*[:)\-\.]?\s*/i, '')
      .replace(/^\d+[.)\-\s]+/, '')
      .trim() || clickedName
  );
}

/** Parse metadata from `<bpmndi:BPMNDiagram ... name="...">` attribute */
function extractDiagramMetadata(xml: string): DiagramMetadata {
  const meta: DiagramMetadata = {};
  const match = /<bpmndi:BPMNDiagram[^>]+name="([^"]+)"/i.exec(xml);
  if (!match) return meta;
  const pairs = match[1].split('|').map((s) => s.trim());
  for (const pair of pairs) {
    const idx = pair.indexOf(':');
    if (idx < 0) continue;
    const key = pair.slice(0, idx).trim().toLowerCase();
    const value = pair.slice(idx + 1).trim();
    if (!value) continue;
    if (key === 'line of business') meta.lineOfBusiness = value;
    else if (key === 'channel') meta.channel = value;
    else if (key === 'domain') meta.domain = value;
    else if (key === 'subdomain') meta.subdomain = value;
    else if (key === 'product') meta.product = value;
    else if (key === 'business flow') meta.businessFlow = value;
  }
  return meta;
}

function generateChangeNote(
  savedXml: string,
  currentXml: string,
  savedCaps: CapabilityMatch[],
  selectedCaps: CapabilityMatch[],
): string {
  const changes: string[] = [];

  // Detect capability changes
  const savedCapIds = new Set(savedCaps.map((c) => c.capabilityId));
  const currentCapIds = new Set(selectedCaps.map((c) => c.capabilityId));
  const addedCaps = selectedCaps.filter((c) => !savedCapIds.has(c.capabilityId));
  const removedCaps = savedCaps.filter((c) => !currentCapIds.has(c.capabilityId));
  if (addedCaps.length) changes.push(`Added capabilities: ${addedCaps.map((c) => c.capabilityName).join(', ')}`);
  if (removedCaps.length) changes.push(`Removed capabilities: ${removedCaps.map((c) => c.capabilityName).join(', ')}`);

  // Detect task changes in XML
  const savedTasks = extractTaskNames(savedXml);
  const currentTasks = extractTaskNames(currentXml);
  const savedTaskSet = new Set(savedTasks);
  const currentTaskSet = new Set(currentTasks);
  const addedTasks = currentTasks.filter((t) => !savedTaskSet.has(t));
  const removedTasks = savedTasks.filter((t) => !currentTaskSet.has(t));
  if (addedTasks.length) changes.push(`Added tasks: ${addedTasks.join(', ')}`);
  if (removedTasks.length) changes.push(`Removed tasks: ${removedTasks.join(', ')}`);

  // Detect XML change (flow modified) if tasks are the same but XML differs
  if (!addedTasks.length && !removedTasks.length && savedXml !== currentXml && savedXml !== EMPTY_DIAGRAM) {
    changes.push('Modified diagram flow');
  }

  return changes.length ? changes.join('; ') : 'Updated diagram';
}

function reorderTabKeys(prev: string[], from: string, to: string, side: 'before' | 'after'): string[] {
  const fromIndex = prev.indexOf(from);
  const toIndex = prev.indexOf(to);
  if (fromIndex < 0 || toIndex < 0 || from === to) return prev;

  const next = [...prev];
  next.splice(fromIndex, 1);
  const targetIndex = next.indexOf(to);
  if (targetIndex < 0) return prev;
  const insertAt = side === 'before' ? targetIndex : targetIndex + 1;
  next.splice(insertAt, 0, from);
  return next;
}

interface CompositeDiagramItem {
  diagram: Awaited<ReturnType<typeof getDiagram>>;
  xml: string;
}

const STACK_GAP = 280;

function parseXmlDocument(xml: string) {
  return new DOMParser().parseFromString(xml, 'application/xml');
}

function serializeXmlDocument(doc: Document) {
  return new XMLSerializer().serializeToString(doc);
}

function namespaceDiagramXml(xml: string, prefix: string) {
  const doc = parseXmlDocument(xml);
  const idMap = new Map<string, string>();

  const elementsWithId = Array.from(doc.querySelectorAll('[id]'));
  elementsWithId.forEach((element) => {
    const oldId = element.getAttribute('id');
    if (!oldId) return;
    const nextId = `${prefix}_${oldId}`;
    idMap.set(oldId, nextId);
    element.setAttribute('id', nextId);
  });

  const referenceAttributes = ['bpmnElement', 'sourceRef', 'targetRef', 'attachedToRef', 'messageRef', 'structureRef', 'flowNodeRef'];
  Array.from(doc.querySelectorAll('*')).forEach((element) => {
    referenceAttributes.forEach((attr) => {
      const value = element.getAttribute(attr);
      if (!value) return;
      const nextValue = idMap.get(value);
      if (nextValue) {
        element.setAttribute(attr, nextValue);
      }
    });

    Array.from(element.attributes).forEach((attr) => {
      if (!attr.value || !idMap.has(attr.value)) return;
      if (referenceAttributes.includes(attr.name)) return;
      element.setAttribute(attr.name, idMap.get(attr.value) || attr.value);
    });
  });

  const textRefTags = ['flowNodeRef'];
  textRefTags.forEach((tagName) => {
    Array.from(doc.getElementsByTagName(tagName)).forEach((node) => {
      const value = node.textContent?.trim();
      if (!value) return;
      const nextValue = idMap.get(value);
      if (nextValue) node.textContent = nextValue;
    });
  });

  return serializeXmlDocument(doc);
}

function shiftDiagramXml(xml: string, offsetY: number, diagramIndex: number) {
  const doc = parseXmlDocument(xml);
  const shapes = Array.from(doc.getElementsByTagName('bpmndi:BPMNShape'));
  shapes.forEach((shape) => {
    const bounds = shape.getElementsByTagName('dc:Bounds')[0];
    if (!bounds) return;
    const y = Number(bounds.getAttribute('y') || '0');
    bounds.setAttribute('y', String(y + offsetY));
  });

  const edges = Array.from(doc.getElementsByTagName('bpmndi:BPMNEdge'));
  edges.forEach((edge) => {
    const waypoints = Array.from(edge.getElementsByTagName('di:waypoint'));
    waypoints.forEach((waypoint) => {
      const y = Number(waypoint.getAttribute('y') || '0');
      waypoint.setAttribute('y', String(y + offsetY));
    });
  });

  const annotationNode = doc.getElementsByTagName('bpmndi:BPMNDiagram')[0];
  if (annotationNode && !annotationNode.getAttribute('id')) {
    annotationNode.setAttribute('id', `BPMNDiagram_stack_${diagramIndex}`);
  }

  return serializeXmlDocument(doc);
}

function addDiagramTitle(xml: string, title: string, diagramIndex: number) {
  const doc = parseXmlDocument(xml);
  const definitions = doc.getElementsByTagName('bpmn:definitions')[0] || doc.documentElement;
  const plane = doc.getElementsByTagName('bpmndi:BPMNPlane')[0];
  const process = doc.getElementsByTagName('bpmn:process')[0];
  if (!definitions || !plane || !process) return xml;

  const shapes = Array.from(doc.getElementsByTagName('bpmndi:BPMNShape'));
  const bounds = shapes
    .map((shape) => shape.getElementsByTagName('dc:Bounds')[0])
    .filter(Boolean)
    .map((node) => ({
      x: Number(node.getAttribute('x') || '0'),
      y: Number(node.getAttribute('y') || '0'),
      width: Number(node.getAttribute('width') || '0'),
      height: Number(node.getAttribute('height') || '0'),
    }));

  if (!bounds.length) return xml;

  const minX = Math.min(...bounds.map((box) => box.x));
  const maxX = Math.max(...bounds.map((box) => box.x + box.width));
  const minY = Math.min(...bounds.map((box) => box.y));
  const titleWidth = Math.min(560, Math.max(360, (maxX - minX) - 120));
  const titleHeight = 42;
  const titleX = Math.round((minX + maxX - titleWidth) / 2);
  const titleY = Math.max(0, minY - 54);
  const titleId = `BPMNDiagramTitle_${diagramIndex}`;

  const titleAnnotation = doc.createElement('bpmn:textAnnotation');
  titleAnnotation.setAttribute('id', titleId);
  const titleText = doc.createElement('bpmn:text');
  titleText.textContent = title;
  titleAnnotation.appendChild(titleText);
  process.insertBefore(titleAnnotation, process.firstChild);

  const titleShape = doc.createElement('bpmndi:BPMNShape');
  titleShape.setAttribute('id', `${titleId}_di`);
  titleShape.setAttribute('bpmnElement', titleId);
  const titleBounds = doc.createElement('dc:Bounds');
  titleBounds.setAttribute('x', String(titleX));
  titleBounds.setAttribute('y', String(titleY));
  titleBounds.setAttribute('width', String(titleWidth));
  titleBounds.setAttribute('height', String(titleHeight));
  titleShape.appendChild(titleBounds);
  plane.insertBefore(titleShape, plane.firstChild);

  return serializeXmlDocument(doc);
}

function composeStackedDiagramXml(items: CompositeDiagramItem[]) {
  if (!items.length) return EMPTY_DIAGRAM;
  if (items.length === 1) return items[0].xml;

  const baseDoc = parseXmlDocument(items[0].xml);
  const definitions = baseDoc.getElementsByTagName('bpmn:definitions')[0] || baseDoc.documentElement;
  const process = baseDoc.getElementsByTagName('bpmn:process')[0];
  const plane = baseDoc.getElementsByTagName('bpmndi:BPMNPlane')[0];
  if (!definitions || !process || !plane) return items[0].xml;

  const importFragment = (fragmentXml: string) => {
    const fragmentDoc = parseXmlDocument(fragmentXml);
    const fragmentProcess = fragmentDoc.getElementsByTagName('bpmn:process')[0];
    const fragmentPlane = fragmentDoc.getElementsByTagName('bpmndi:BPMNPlane')[0];
    if (!fragmentProcess || !fragmentPlane) return;

    Array.from(fragmentProcess.children).forEach((node) => {
      process.appendChild(baseDoc.importNode(node, true));
    });
    Array.from(fragmentPlane.children).forEach((node) => {
      plane.appendChild(baseDoc.importNode(node, true));
    });
  };

  let offsetY = 0;
  items.forEach((item, index) => {
    const namespaced = index === 0 ? item.xml : namespaceDiagramXml(item.xml, `stack_${index}`);
    const shifted = index === 0 ? namespaced : shiftDiagramXml(namespaced, offsetY, index);
    const titled = addDiagramTitle(shifted, item.diagram.businessFlow || item.diagram.name || 'Untitled', index);
    importFragment(titled);
    const doc = parseXmlDocument(titled);
    const bounds = Array.from(doc.getElementsByTagName('dc:Bounds'))
      .map((node) => Number(node.getAttribute('y') || '0') + Number(node.getAttribute('height') || '0'));
    const maxY = bounds.length ? Math.max(...bounds) : 0;
    offsetY = maxY + STACK_GAP;
  });

  return serializeXmlDocument(baseDoc);
}

interface SystemComponentsPaneProps {
  neighborhoodName: string;
  readOnly: boolean;
  visibleDataTabsLength: number;
  activeDataTab: string;
  dataTabItems: Array<{ key: string; label: React.ReactNode; children: React.ReactNode }>;
  onActiveDataTabChange: (key: string) => void;
  onUploaded: (dataType: string) => Promise<void>;
}

const SystemComponentsPane = memo(function SystemComponentsPane({
  neighborhoodName,
  readOnly,
  visibleDataTabsLength,
  activeDataTab,
  dataTabItems,
  onActiveDataTabChange,
  onUploaded,
}: SystemComponentsPaneProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div style={{ display: 'flex', justifyContent: 'flex-start', padding: '12px 16px', borderBottom: '1px solid #dbe3ec', background: '#f8fafc' }}>
        {!readOnly && (
          <SystemComponentsImportButton
            neighborhoodName={neighborhoodName}
            onUploaded={onUploaded}
          />
        )}
      </div>
      {visibleDataTabsLength ? (
        <Tabs
          className="factory-tabs"
          activeKey={activeDataTab}
          onChange={onActiveDataTabChange}
          destroyInactiveTabPane
          items={dataTabItems}
        />
      ) : (
        <div className="flex min-h-[240px] items-center justify-center px-4">
          <Empty description="No System Components data found" />
        </div>
      )}
    </div>
  );
});

export default function App() {
  const { message } = AntApp.useApp();

  // Auth state
  const [authUser, setAuthUser] = useState<{ _id: string; userId: string; displayName: string; role?: string | null; capabilities?: { function: string; permission: string }[] } | null>(null);
  const [authChecked, setAuthChecked] = useState(false);

  // Check session on mount
  useEffect(() => {
    checkSession()
      .then((data) => {
        if (data.authenticated && data.user) setAuthUser(data.user);
      })
      .catch(() => {})
      .finally(() => setAuthChecked(true));
  }, []);

  // Register session expired handler
  useEffect(() => {
    setSessionExpiredHandler(() => {
      setAuthUser(null);
    });
  }, []);

  const handleLogin = (user: { _id: string; userId: string; displayName: string; role?: string | null; capabilities?: { function: string; permission: string }[] }) => {
    setAuthUser(user);
  };

  const handleLogout = async () => {
    await logout().catch(() => {});
    setAuthUser(null);
  };

  // Show loading while checking session
  if (!authChecked) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Spin size="large" tip="Loading..." />
      </div>
    );
  }

  // Show login when not authenticated
  if (!authUser) {
    return <Login onLogin={handleLogin} />;
  }

  return <AuthenticatedApp user={authUser} onLogout={handleLogout} />;
}

function AuthenticatedApp({ user, onLogout }: { user: { _id: string; userId: string; displayName: string; role?: string | null; capabilities?: { function: string; permission: string }[] }; onLogout: () => void }) {
  const { message, modal } = AntApp.useApp();
  const [neighborhoodTabs, setNeighborhoodTabs] = useState<FactoryNeighborhoodSummary[]>([]);
  const DEFAULT_NEIGHBORHOOD_NAME = neighborhoodTabs[0]?.name || '';
  const REFERENCE_DATA_NEIGHBORHOOD_NAME = 'System Components';
  const ALL_NEIGHBORHOODS_TOKEN = '__all__';
  const DEFAULT_NEIGHBORHOOD_FACTORY_COUNT = 13;
  const GLOBAL_MODEL_FACTORY_COUNT = 3;
  const CURRENT_USER = user.userId;
  const hasAdminAccess = user.capabilities?.some(c => c.function === 'Admin') ?? false;
  const readOnly = !(user.capabilities?.some(c => c.permission !== 'Read'));
  const canEditFactories = !readOnly;
  const [showAdmin, setShowAdmin] = useState(false);
  const [showGlobalComponentSearch, setShowGlobalComponentSearch] = useState(false);
  const [componentSearchTerms, setComponentSearchTerms] = useState<Record<string, string>>({}); // Key: ${neighborhoodName}:${componentId}
  const [activeNeighborhoodTab, setActiveNeighborhoodTab] = useState<string>('');
  const [loadingNeighborhoodTabs, setLoadingNeighborhoodTabs] = useState(false);
  const [neighborhoodTabsResolved, setNeighborhoodTabsResolved] = useState(false);
  const [neighborhoodFactories, setNeighborhoodFactories] = useState<Record<string, CustomFactory[]>>({});
  const [dataTypeSummaries, setDataTypeSummaries] = useState<Array<{ key: string; dataType: string; batchCount: number }>>([]);
  const [dataFactoriesByType, setDataFactoriesByType] = useState<Record<string, CustomFactory[]>>({});
  const [loadingDataFactoriesByType, setLoadingDataFactoriesByType] = useState<Record<string, boolean>>({});
  const [loadingNeighborhoodFactories, setLoadingNeighborhoodFactories] = useState<Record<string, boolean>>({});

  const renderScrollablePane = (child: React.ReactNode) => (
    <div className="h-full min-h-0 overflow-y-auto overflow-x-hidden">
      {child}
    </div>
  );

  // Tab state — outer app tabs, analytics/data subtabs, and factory tabs scoped per neighborhood
  const [activeOuterTab, setActiveOuterTab] = useState<string>('analytics');   // outer: analytics | valueStreams | bpmn | data | neighborhoods
  const [activeAnalyticsTab, setActiveAnalyticsTab] = useState<string>('dashboard'); // inner Analytics sub-tabs
  const [activeAnalyticsModel, setActiveAnalyticsModel] = useState<string>('');
  const [activeAnalyticsTabsByModel, setActiveAnalyticsTabsByModel] = useState<Record<string, string>>({});
  const [activeValueStreamsModel, setActiveValueStreamsModel] = useState<string>('');
  const [activeValueStreamsModeByModel, setActiveValueStreamsModeByModel] = useState<Record<string, 'valueStream' | 'journey'>>({});
  const [activeDiagramNeighborhoodName, setActiveDiagramNeighborhoodName] = useState<string | null>(null);
  const [activeDataTab, setActiveDataTab] = useState<string>('databases');
  const [deleteAllComponentsLoading, setDeleteAllComponentsLoading] = useState(false);
  const [deleteComponentTypeLoading, setDeleteComponentTypeLoading] = useState<string | null>(null);
  const getModelCatalogTabKey = useCallback((modelName: string) => `modelCatalog:${modelName}`, []);
  const getModelComponentsTabKey = useCallback((modelName: string) => `modelComponents:${modelName}`, []);
  const getModelBpmnComponentTabKey = useCallback((modelName: string) => `modelBpmnComponent:${modelName}`, []);
  const getComponentSearchTabKey = useCallback((modelName: string) => `componentSearch:${modelName}`, []);
  const getDataTypeTabKey = useCallback((dataType: string) => {
    const normalized = String(dataType || '').trim().toLowerCase();
    if (!normalized) return '';

    const aliases: Record<string, string> = {
      application: 'applications',
      applications: 'applications',
      server: 'servers',
      servers: 'servers',
      db: 'databases',
      database: 'databases',
      databases: 'databases',
      databaseinstance: 'databases',
      databaseinstances: 'databases',
    };

    return aliases[normalized] || normalized;
  }, []);
  const [activeFactoryTabs, setActiveFactoryTabs] = useState<Record<string, string>>({});
  const [activeModelComponentTabs, setActiveModelComponentTabs] = useState<Record<string, string>>({});
  const activeTab = activeFactoryTabs[activeNeighborhoodTab]
    || getModelCatalogTabKey(activeNeighborhoodTab);
  
  const setActiveTab = useCallback((tab: string) => {
    const modelCatalogTabKey = getModelCatalogTabKey(activeNeighborhoodTab);
    const modelComponentsTabKey = getModelComponentsTabKey(activeNeighborhoodTab);
    if (tab !== modelCatalogTabKey && tab !== modelComponentsTabKey) {
      setActiveModelComponentTabs((current) => ({ ...current, [activeNeighborhoodTab]: tab }));
      setActiveFactoryTabs((current) => ({ ...current, [activeNeighborhoodTab]: modelComponentsTabKey }));
      return;
    }
    setActiveFactoryTabs((current) => ({ ...current, [activeNeighborhoodTab]: tab }));
  }, [activeNeighborhoodTab, getModelCatalogTabKey, getModelComponentsTabKey]);

  const formatFactoryTabTitle = useCallback((name: string) => {
    const trimmedName = String(name || '').trim();
    if (!trimmedName) return 'Component';
    return /\bcomponents?$/i.test(trimmedName) ? trimmedName : `${trimmedName} Component`;
  }, []);

  const getReservedModelTabKey = useCallback((name: string) => {
    const normalizedName = String(name || '').trim().toLowerCase();
    if (!normalizedName) return null;

    const reservedTabEntries: Array<[string, string]> = [
      ['application', 'applications'],
      ['applications', 'applications'],
      ['actor', 'actors'],
      ['actors', 'actors'],
      ['product', 'products'],
      ['products', 'products'],
      ['server', 'servers'],
      ['servers', 'servers'],
      ['db', 'databases'],
      ['database', 'databases'],
      ['databases', 'databases'],
    ];

    return reservedTabEntries.find(([label]) => label === normalizedName)?.[1] || null;
  }, []);

  const getDataFactoryTabKey = useCallback((factory: CustomFactory) => {
    const candidate = String(factory.dataType || factory.componentType || factory.name || '').trim();
    return candidate;
  }, []);

  const getDataTypeDisplayName = useCallback((key: string) => {
    const reserved: Record<string, string> = {
      applications: 'Applications',
      actors: 'Actors',
      products: 'Products',
      servers: 'Servers',
      databases: 'Databases',
      databaseinstance: 'Databases',
      databaseinstances: 'Databases',
    };
    if (reserved[key]) return reserved[key];
    return String(key || '')
      .replace(/[_-]+/g, ' ')
      .replace(/(^|\s)\S/g, (m) => m.toUpperCase())
      .trim();
  }, []);

  const getDataTypeQueryName = useCallback((key: string) => {
    return String(key || '').trim();
  }, []);

  const getDisplayedFactoryCount = useCallback((neighborhood: FactoryNeighborhoodSummary) => {
    const modelSpecificCount = typeof neighborhood.factoryCount === 'number' ? neighborhood.factoryCount : 0;
    return modelSpecificCount + GLOBAL_MODEL_FACTORY_COUNT;
  }, [GLOBAL_MODEL_FACTORY_COUNT]);

  const getDiagramMetadataConfig = useCallback((neighborhoodName: string) => {
    if (neighborhoodName === DEFAULT_NEIGHBORHOOD_NAME) {
      return {
        lineOfBusiness: { label: 'Line of Business', tabKey: 'linesOfBusiness' },
        channel: { label: 'Channel', tabKey: 'channels' },
        domain: { label: 'Domain', tabKey: 'domains' },
        subdomain: { label: 'Subdomain', tabKey: 'subdomains' },
        product: { label: 'Product', tabKey: 'products' },
      };
    }

    const factories = neighborhoodFactories[neighborhoodName] || [];
    const rootFactory = factories.find((factory) => !String(factory.parentFactoryName || '').trim()) || null;
    const secondLevelFactory = rootFactory
      ? factories.find((factory) => String(factory.parentFactoryName || '').trim() === rootFactory.name) || null
      : factories.find((factory) => String(factory.parentFactoryName || '').trim()) || null;

    const rootLabel = rootFactory?.name && /^l0\b/i.test(rootFactory.name) ? 'Application' : (rootFactory?.name || 'Domain');
    const secondLevelLabel = secondLevelFactory?.name && /^l1\b/i.test(secondLevelFactory.name) ? secondLevelFactory.name : (secondLevelFactory?.name || 'Subdomain');

    return {
      lineOfBusiness: { label: 'Line of Business', tabKey: 'linesOfBusiness' },
      channel: { label: 'Channel', tabKey: 'channels' },
      domain: { label: rootLabel, tabKey: rootFactory?._id },
      subdomain: { label: secondLevelLabel, tabKey: secondLevelFactory?._id },
      product: { label: 'Product', tabKey: 'products' },
    };
  }, [DEFAULT_NEIGHBORHOOD_NAME, neighborhoodFactories]);

  const GLOBAL_SHARED_FACTORY_TAB_KEYS = ['actors', 'products'];

  // Factory tab drag-to-reorder
  const FACTORY_TAB_KEYS = ['diagramFactory','tasks','capabilities','actors','businessFlows','products','linesOfBusiness','channels','domains','subdomains'];
  const [factoryTabOrder, setFactoryTabOrder] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('bpmniq_factory_tab_order');
      if (saved) {
        const parsed: string[] = JSON.parse(saved);
        // Ensure all current keys are present (handles new tabs added after save)
        const merged = [...parsed.filter(k => FACTORY_TAB_KEYS.includes(k)), ...FACTORY_TAB_KEYS.filter(k => !parsed.includes(k))];
        return merged;
      }
    } catch { /* ignore */ }
    return FACTORY_TAB_KEYS;
  });

  useEffect(() => {
    try { localStorage.setItem('bpmniq_factory_tab_order', JSON.stringify(factoryTabOrder)); } catch { /* ignore */ }
  }, [factoryTabOrder]);
  const factoryDragKeyRef = useRef<string | null>(null);
  const factoryDropSideRef = useRef<'before' | 'after'>('after');
  const [factoryDropTarget, setFactoryDropTarget] = useState<{ key: string; side: 'before' | 'after' } | null>(null);

  const OUTER_TAB_KEYS = ['analytics', 'valueStreams', 'bpmn', 'data', 'neighborhoods'];
  const ANALYTICS_TAB_KEYS = ['dashboard', 'reports'];
  const DATA_TAB_KEYS = ['databases', 'applications', 'servers'];

  const [outerTabOrder, setOuterTabOrder] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('bpmniq_outer_tab_order');
      if (saved) {
        const parsed: string[] = JSON.parse(saved);
        return [...parsed.filter((k) => OUTER_TAB_KEYS.includes(k)), ...OUTER_TAB_KEYS.filter((k) => !parsed.includes(k))];
      }
    } catch { /* ignore */ }
    return OUTER_TAB_KEYS;
  });
  const [analyticsTabOrder, setAnalyticsTabOrder] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('bpmniq_analytics_tab_order');
      if (saved) {
        const parsed: string[] = JSON.parse(saved);
        return [...parsed.filter((k) => ANALYTICS_TAB_KEYS.includes(k)), ...ANALYTICS_TAB_KEYS.filter((k) => !parsed.includes(k))];
      }
    } catch { /* ignore */ }
    return ANALYTICS_TAB_KEYS;
  });
  const [dataTabOrder, setDataTabOrder] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('bpmniq_data_tab_order');
      if (saved) {
        const parsed: string[] = JSON.parse(saved);
        return [...parsed.filter((k) => DATA_TAB_KEYS.includes(k)), ...DATA_TAB_KEYS.filter((k) => !parsed.includes(k))];
      }
    } catch { /* ignore */ }
    return DATA_TAB_KEYS;
  });
  const [neighborhoodTabOrder, setNeighborhoodTabOrder] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('bpmniq_neighborhood_tab_order');
      if (saved) return JSON.parse(saved);
    } catch { /* ignore */ }
    return [];
  });

  useEffect(() => {
    try { localStorage.setItem('bpmniq_outer_tab_order', JSON.stringify(outerTabOrder)); } catch { /* ignore */ }
  }, [outerTabOrder]);
  useEffect(() => {
    try { localStorage.setItem('bpmniq_analytics_tab_order', JSON.stringify(analyticsTabOrder)); } catch { /* ignore */ }
  }, [analyticsTabOrder]);
  useEffect(() => {
    try { localStorage.setItem('bpmniq_data_tab_order', JSON.stringify(dataTabOrder)); } catch { /* ignore */ }
  }, [dataTabOrder]);
  useEffect(() => {
    try { localStorage.setItem('bpmniq_neighborhood_tab_order', JSON.stringify(neighborhoodTabOrder)); } catch { /* ignore */ }
  }, [neighborhoodTabOrder]);

  const outerDragKeyRef = useRef<string | null>(null);
  const outerDropSideRef = useRef<'before' | 'after'>('after');
  const analyticsDragKeyRef = useRef<string | null>(null);
  const analyticsDropSideRef = useRef<'before' | 'after'>('after');
  const dataDragKeyRef = useRef<string | null>(null);
  const dataDropSideRef = useRef<'before' | 'after'>('after');
  const neighborhoodDragKeyRef = useRef<string | null>(null);
  const neighborhoodDropSideRef = useRef<'before' | 'after'>('after');

  const outerTabLabel = useCallback((key: string, content: React.ReactNode): React.ReactNode => (
    <div
      draggable
      onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.effectAllowed = 'move'; outerDragKeyRef.current = key; }}
      onDragOver={(e) => {
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        outerDropSideRef.current = e.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
      }}
      onDrop={(e) => {
        e.preventDefault(); e.stopPropagation();
        const from = outerDragKeyRef.current;
        const side = outerDropSideRef.current;
        outerDragKeyRef.current = null;
        if (!from || from === key) return;
        setOuterTabOrder((prev) => reorderTabKeys(prev, from, key, side));
      }}
      onDragEnd={() => { outerDragKeyRef.current = null; }}
      style={{ cursor: 'grab', userSelect: 'none' }}
    >
      {content}
    </div>
  ), []);

  const analyticsTabLabel = useCallback((key: string, content: React.ReactNode): React.ReactNode => (
    <div
      draggable
      onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.effectAllowed = 'move'; analyticsDragKeyRef.current = key; }}
      onDragOver={(e) => {
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        analyticsDropSideRef.current = e.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
      }}
      onDrop={(e) => {
        e.preventDefault(); e.stopPropagation();
        const from = analyticsDragKeyRef.current;
        const side = analyticsDropSideRef.current;
        analyticsDragKeyRef.current = null;
        if (!from || from === key) return;
        setAnalyticsTabOrder((prev) => reorderTabKeys(prev, from, key, side));
      }}
      onDragEnd={() => { analyticsDragKeyRef.current = null; }}
      style={{ cursor: 'grab', userSelect: 'none' }}
    >
      {content}
    </div>
  ), []);

  const dataTabLabel = useCallback((key: string, content: React.ReactNode): React.ReactNode => (
    <div
      draggable
      onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.effectAllowed = 'move'; dataDragKeyRef.current = key; }}
      onDragOver={(e) => {
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        dataDropSideRef.current = e.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
      }}
      onDrop={(e) => {
        e.preventDefault(); e.stopPropagation();
        const from = dataDragKeyRef.current;
        const side = dataDropSideRef.current;
        dataDragKeyRef.current = null;
        if (!from || from === key) return;
        setDataTabOrder((prev) => reorderTabKeys(prev, from, key, side));
      }}
      onDragEnd={() => { dataDragKeyRef.current = null; }}
      style={{ cursor: 'grab', userSelect: 'none' }}
    >
      {content}
    </div>
  ), []);

  const neighborhoodTabLabel = useCallback((key: string, content: React.ReactNode): React.ReactNode => (
    <div
      draggable
      onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.effectAllowed = 'move'; neighborhoodDragKeyRef.current = key; }}
      onDragOver={(e) => {
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        neighborhoodDropSideRef.current = e.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
      }}
      onDrop={(e) => {
        e.preventDefault(); e.stopPropagation();
        const from = neighborhoodDragKeyRef.current;
        const side = neighborhoodDropSideRef.current;
        neighborhoodDragKeyRef.current = null;
        if (!from || from === key) return;
        setNeighborhoodTabOrder((prev) => reorderTabKeys(prev, from, key, side));
      }}
      onDragEnd={() => { neighborhoodDragKeyRef.current = null; }}
      style={{ cursor: 'grab', userSelect: 'none' }}
    >
      {content}
    </div>
  ), []);

  const loadNeighborhoodTabs = useCallback(async () => {
    setLoadingNeighborhoodTabs(true);
    try {
      const data = await getFactoryNeighborhoods();
      setNeighborhoodTabs(data);
      const fallbackName = data[0]?.name ?? '';
      setActiveNeighborhoodTab((current) => {
        if (current && data.some((item) => item.name === current)) return current;
        return fallbackName;
      });
      setActiveAnalyticsModel((current) => {
        if (current && data.some((item) => item.name === current)) return current;
        return fallbackName;
      });
      setActiveAnalyticsTabsByModel((current) => {
        if (!fallbackName) return current;
        if (current[fallbackName]) return current;
        return { ...current, [fallbackName]: 'dashboard' };
      });
      setActiveFactoryTabs((current) => {
        if (!fallbackName) return current;
        if (current[fallbackName]) return current;
        return { ...current, [fallbackName]: getModelCatalogTabKey(fallbackName) };
      });
    } catch (error: any) {
      message.error(error.response?.data?.error || error.message || 'Failed to load neighborhoods');
    } finally {
      setLoadingNeighborhoodTabs(false);
      setNeighborhoodTabsResolved(true);
    }
  }, [getModelCatalogTabKey, message]);

  useEffect(() => {
    loadNeighborhoodTabs();
  }, [loadNeighborhoodTabs]);

  useEffect(() => {
    if (!neighborhoodTabs.length) return;
    const modelNames = neighborhoodTabs.map((item) => item.name);
    setNeighborhoodTabOrder((prev) => {
      const merged = [...prev.filter((name) => modelNames.includes(name)), ...modelNames.filter((name) => !prev.includes(name))];
      if (merged.length === prev.length && merged.every((value, index) => value === prev[index])) return prev;
      return merged;
    });
  }, [neighborhoodTabs]);

  // Build the list of Data subtabs from the summary list, then lazily load rows per active type.
  const visibleDataTabs = useMemo(() => {
    const entries = dataTypeSummaries
      .filter((summary) => DATA_TAB_KEYS.includes(summary.key))
      .map((summary) => {
        const key = summary.key;
        const groupFactories = dataFactoriesByType[key] || [];
        const dataRows = groupFactories.flatMap((f) => f.rows || []);
        const dataColumns = Array.from(new Set(groupFactories.flatMap((f) => f.columns || []))).filter(Boolean);
        const foreignKeyColumns = groupFactories.flatMap((f) => f.foreignKeyColumns || []);
        const dataTypeValues = Array.from(
          new Set(
            groupFactories
              .map((f) => String(f.dataType || f.componentType || f.name || '').trim())
              .filter(Boolean),
          ),
        );
        return { key, label: summary.dataType, dataType: summary.dataType, batchCount: summary.batchCount, dataRows, dataColumns, foreignKeyColumns, dataTypeValues };
      })
      .filter((entry) => entry.batchCount > 0);

    entries.sort((a, b) => {
      const ia = dataTabOrder.indexOf(a.key);
      const ib = dataTabOrder.indexOf(b.key);
      if (ia === -1 && ib === -1) return a.key.localeCompare(b.key);
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
    return entries;
  }, [DATA_TAB_KEYS, dataFactoriesByType, dataTypeSummaries, dataTabOrder]);

  // Validate activeDataTab when the set of visible data tabs changes
  useEffect(() => {
    const keys = visibleDataTabs.map((t) => t.key);
    if (keys.length === 0) return;
    if (!keys.includes(activeDataTab)) {
      setActiveDataTab(keys[0]);
    }
  }, [visibleDataTabs, activeDataTab]);

  const scopedNeighborhoodName = activeOuterTab === 'data'
    ? REFERENCE_DATA_NEIGHBORHOOD_NAME
    : activeOuterTab === 'analytics'
      ? (activeAnalyticsModel || DEFAULT_NEIGHBORHOOD_NAME)
      : activeOuterTab === 'valueStreams'
        ? (activeValueStreamsModel || DEFAULT_NEIGHBORHOOD_NAME)
      : activeOuterTab === 'bpmn'
        ? (activeDiagramNeighborhoodName || activeNeighborhoodTab)
      : activeNeighborhoodTab && GLOBAL_SHARED_FACTORY_TAB_KEYS.includes(activeTab)
        ? activeNeighborhoodTab
        : activeNeighborhoodTab;

  useLayoutEffect(() => {
    // Wait until the real neighborhood list has resolved at least once before setting the
    // scope header — otherwise requests fire against the hardcoded default (which may not
    // exist in this database) and return empty results before self-correcting.
    if (!neighborhoodTabsResolved) return;
    setApiNeighborhoodScope(scopedNeighborhoodName);
  }, [scopedNeighborhoodName, neighborhoodTabsResolved]);

  const loadNeighborhoodFactoriesFor = useCallback(async (neighborhoodName: string) => {
    setLoadingNeighborhoodFactories((current) => ({ ...current, [neighborhoodName]: true }));
    try {
      // Use canonical-backed factories for large datasets (migrated source)
      let factories = await getCanonicalFactories(neighborhoodName, true, 100).catch(() => [] as CustomFactory[]);
      if (!factories.length) {
        factories = await getCustomFactories(neighborhoodName).catch(() => [] as CustomFactory[]);
      }
      const visibleFactories = factories;
      setNeighborhoodFactories((current) => ({ ...current, [neighborhoodName]: visibleFactories }));
      const firstComponentTabKey = getModelBpmnComponentTabKey(neighborhoodName);
      setActiveModelComponentTabs((current) => {
        const currentComponentTab = current[neighborhoodName];
        const isKnownCustomTab = currentComponentTab
          ? (currentComponentTab === firstComponentTabKey || visibleFactories.some((factory) => factory._id === currentComponentTab))
          : false;
        const nextComponentTab = isKnownCustomTab ? currentComponentTab : firstComponentTabKey;
        if (nextComponentTab === currentComponentTab) return current;
        const next = { ...current };
        if (nextComponentTab) {
          next[neighborhoodName] = nextComponentTab;
        } else {
          delete next[neighborhoodName];
        }
        return next;
      });
      setActiveFactoryTabs((current) => {
        const currentTab = current[neighborhoodName];
        const modelCatalogTabKey = getModelCatalogTabKey(neighborhoodName);
        const modelComponentsTabKey = getModelComponentsTabKey(neighborhoodName);
        const isTopLevelTab = currentTab === modelCatalogTabKey || currentTab === modelComponentsTabKey;
        const isLegacyComponentTab = currentTab
          ? visibleFactories.some((factory) => factory._id === currentTab)
          : false;

        if (isLegacyComponentTab) {
          setActiveModelComponentTabs((currentComponentTabs) => ({
            ...currentComponentTabs,
            [neighborhoodName]: currentTab!,
          }));
        }

        const nextTab = isTopLevelTab
          ? currentTab
          : (isLegacyComponentTab ? modelComponentsTabKey : modelCatalogTabKey);

        if (!nextTab || nextTab === currentTab) return current;
        return { ...current, [neighborhoodName]: nextTab };
      });
    } catch {
      setNeighborhoodFactories((current) => ({ ...current, [neighborhoodName]: [] }));
      setActiveModelComponentTabs((current) => {
        if (!current[neighborhoodName]) return current;
        const next = { ...current };
        delete next[neighborhoodName];
        return next;
      });
      setActiveFactoryTabs((current) => {
        if (!current[neighborhoodName]) return current;
        const next = { ...current };
        delete next[neighborhoodName];
        return next;
      });
    } finally {
      setLoadingNeighborhoodFactories((current) => ({ ...current, [neighborhoodName]: false }));
    }
  }, [getModelBpmnComponentTabKey, getModelCatalogTabKey, getModelComponentsTabKey, getComponentSearchTabKey]);

  useEffect(() => {
    loadNeighborhoodFactoriesFor(activeNeighborhoodTab);
  }, [activeNeighborhoodTab, loadNeighborhoodFactoriesFor]);

  const loadDataTypeSummaries = useCallback(async () => {
    try {
      const summarySources = [REFERENCE_DATA_NEIGHBORHOOD_NAME, activeNeighborhoodTab || DEFAULT_NEIGHBORHOOD_NAME].filter((value, index, all) => all.indexOf(value) === index);
      const merged = new Map<string, { key: string; dataType: string; batchCount: number }>();
      for (const neighborhoodName of summarySources) {
        const types = await getDataFactoryTypes(neighborhoodName);
        for (const entry of types) {
          const rawType = String(entry?.dataType || '').trim();
          if (!rawType) continue;
          const key = getDataTypeTabKey(rawType);
          const existing = merged.get(key);
          merged.set(key, {
            key,
            dataType: existing?.dataType || rawType,
            batchCount: (existing?.batchCount || 0) + Number(entry?.batchCount || 0),
          });
        }
      }
      setDataTypeSummaries(Array.from(merged.values()));
    } catch {
      setDataTypeSummaries([]);
    }
  }, [getDataTypeTabKey]);

  const loadDataFactoriesForType = useCallback(async (dataType: string) => {
    const typeKey = getDataTypeTabKey(dataType);
    if (!typeKey) return;
    if (dataFactoriesByType[typeKey] !== undefined) return;
    setLoadingDataFactoriesByType((current) => ({ ...current, [typeKey]: true }));
    try {
      const queryDataType = getDataTypeQueryName(dataType);
      const dataSources = [REFERENCE_DATA_NEIGHBORHOOD_NAME, activeNeighborhoodTab || DEFAULT_NEIGHBORHOOD_NAME].filter((value, index, all) => all.indexOf(value) === index);
      let factories: CustomFactory[] = [];
      for (const neighborhoodName of dataSources) {
        factories = await getDataFactories(neighborhoodName, queryDataType);
        if (factories.length) break;
      }
      setDataFactoriesByType((current) => ({ ...current, [typeKey]: factories }));
    } catch {
      setDataFactoriesByType((current) => ({ ...current, [typeKey]: [] }));
    } finally {
      setLoadingDataFactoriesByType((current) => ({ ...current, [typeKey]: false }));
    }
  }, [dataFactoriesByType, getDataTypeQueryName, getDataTypeTabKey]);

  const handleSystemComponentsUploaded = useCallback(async (dataType: string) => {
    await loadNeighborhoodTabs();
    await loadDataTypeSummaries();
    await loadDataFactoriesForType(dataType);
    getApplicationReferenceForNeighborhood(REFERENCE_DATA_NEIGHBORHOOD_NAME).then((applications) => {
      setAllApplications(applications || []);
      setAllAppNames((applications || []).map((a: ApplicationItem) => a.name).filter(Boolean).sort());
    }).catch(() => {
      setAllApplications([]);
      setAllAppNames([]);
    });
  }, [loadDataFactoriesForType, loadDataTypeSummaries, loadNeighborhoodTabs]);

  const handleActiveDataTabChange = useCallback((key: string) => {
    setActiveDataTab(key);
    void loadDataFactoriesForType(key);
  }, [loadDataFactoriesForType]);

  useEffect(() => {
    void loadDataTypeSummaries();
  }, [loadDataTypeSummaries]);

  useEffect(() => {
    if (!visibleDataTabs.length) return;
    const activeTabEntry = visibleDataTabs.find((tab) => tab.key === activeDataTab) || visibleDataTabs[0];
    if (!activeTabEntry) return;
    if (dataFactoriesByType[activeTabEntry.key] === undefined && !loadingDataFactoriesByType[activeTabEntry.key]) {
      void loadDataFactoriesForType(activeTabEntry.dataType || activeTabEntry.key);
    }
  }, [activeDataTab, dataFactoriesByType, loadingDataFactoriesByType, loadDataFactoriesForType, visibleDataTabs]);

  const refreshNeighborhoodModelData = useCallback(async (neighborhoodName: string) => {
    await loadNeighborhoodTabs();
    await loadNeighborhoodFactoriesFor(neighborhoodName);
    const taskNames = await getTaskNamesForNeighborhood(undefined, neighborhoodName).catch(() => [] as string[]);
    const actors = await getActorsForNeighborhood(neighborhoodName).catch(() => [] as Array<{ name: string }>);
    setAllTaskNames(taskNames);
    setAllActorNames(actors.map((actor) => actor.name));
  }, [loadNeighborhoodFactoriesFor, loadNeighborhoodTabs]);

  const fTabLabel = useCallback((key: string, content: React.ReactNode): React.ReactNode => (
    <div
      draggable
      onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.effectAllowed = 'move'; factoryDragKeyRef.current = key; }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (factoryDragKeyRef.current === key) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const side: 'before' | 'after' = e.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
        factoryDropSideRef.current = side;
        setFactoryDropTarget(prev => (prev?.key === key && prev?.side === side) ? prev : { key, side });
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setFactoryDropTarget(prev => prev?.key === key ? null : prev);
        }
      }}
      onDrop={(e) => {
        e.preventDefault(); e.stopPropagation();
        const from = factoryDragKeyRef.current;
        const side = factoryDropSideRef.current;
        setFactoryDropTarget(null);
        factoryDragKeyRef.current = null;
        if (!from || from === key) return;
        setFactoryTabOrder(prev => {
          const fi = prev.indexOf(from);
          if (fi === -1) return prev;
          const next = [...prev];
          next.splice(fi, 1);
          const ti = next.indexOf(key);
          if (ti === -1) return prev;
          next.splice(side === 'before' ? ti : ti + 1, 0, from);
          return next;
        });
      }}
      onDragEnd={() => { setFactoryDropTarget(null); factoryDragKeyRef.current = null; }}
      style={{
        display: 'flex', alignItems: 'center', gap: 4, cursor: 'grab', userSelect: 'none',
        borderLeft: factoryDropTarget?.key === key && factoryDropTarget.side === 'before' ? '3px solid #4f46e5' : '3px solid transparent',
        borderRight: factoryDropTarget?.key === key && factoryDropTarget.side === 'after' ? '3px solid #4f46e5' : '3px solid transparent',
        padding: '0 2px',
        transition: 'border-color 0.08s',
      }}
    >
      {content}
    </div>
  ), [factoryDropTarget]);

  // Editor state
  const [currentXml, setCurrentXml] = useState<string>(EMPTY_DIAGRAM);
  const [importTrigger, setImportTrigger] = useState(0);
  const [activeDiagram, setActiveDiagram] = useState<ActiveDiagram | null>(null);
  const [selectedDiagramIds, setSelectedDiagramIds] = useState<string[]>([]);
  const [selectedDiagramStack, setSelectedDiagramStack] = useState<CompositeDiagramItem[]>([]);
  const [isDirty, setIsDirty] = useState(false);
  const [activeFileName, setActiveFileName] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [canvasDiagramName, setCanvasDiagramName] = useState<string | null>(null);
  const [showNewDiagramPrompt, setShowNewDiagramPrompt] = useState(false);

  useEffect(() => {
    setActiveDiagramNeighborhoodName(activeDiagram?.neighborhoodName || null);
  }, [activeDiagram]);

  // Sidebar
  const [refreshTick, setRefreshTick] = useState(0);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [rightWidth, setRightWidth] = useState(320);
  const rightResizing = useRef(false);
  const rightStartX = useRef(0);
  const rightStartW = useRef(320);

  // Canvas diagram search
  const [canvasDiagramOptions, setCanvasDiagramOptions] = useState<{ value: string; label: string; desc?: string }[]>([]);
  const canvasSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Tab group labels — measured from DOM after render
  const tabNavWrapRef = useRef<HTMLDivElement>(null);
  const [groupLabels, setGroupLabels] = useState<{ left: number; width: number; label: string; color: string; keys: string[] }[]>([]);
  useEffect(() => {
    const measure = () => {
      const wrap = tabNavWrapRef.current;
      if (!wrap) return;
      const wr = wrap.getBoundingClientRect();
      if (!wr.width) return;
      const span = (a: string, b: string) => {
        const fa = wrap.querySelector(`[data-node-key="${a}"]`);
        const lb = wrap.querySelector(`[data-node-key="${b}"]`);
        if (!fa || !lb) return null;
        const ra = fa.getBoundingClientRect(), rb = lb.getBoundingClientRect();
        return { left: ra.left - wr.left, width: rb.right - ra.left };
      };
      const next = [
        { s: span('bpmn', 'bpmn'),                 keys: ['bpmn'],          label: 'Canvas',    color: '#0891b2' },
        { s: span('data', 'data'),                 keys: ['data'],          label: 'System Components', color: '#0f766e' },
        { s: span('neighborhoods', 'neighborhoods'), keys: ['neighborhoods'], label: 'Models', color: '#4f46e5' },
        { s: span('analytics', 'analytics'),       keys: ['analytics'],     label: 'Analytics', color: '#d97706' },
      ].filter(g => g.s).map(g => ({ ...g.s!, label: g.label, color: g.color, keys: g.keys }));
      setGroupLabels(next);
    };
    measure();
    const obs = new ResizeObserver(measure);
    if (tabNavWrapRef.current) obs.observe(tabNavWrapRef.current);
    return () => obs.disconnect();
  }, []);

  // Modals
  const [showSaveDb, setShowSaveDb] = useState(false);

  // Capability matching
  const [capMatches, setCapMatches] = useState<CapabilityMatch[]>([]);
  const [capLoading, setCapLoading] = useState(false);
  const [selectedCaps, setSelectedCaps] = useState<CapabilityMatch[]>([]);
  const [selectedCapability, setSelectedCapability] = useState<CapabilityMatch | null>(null);
  const [selectedValueStreamEntity, setSelectedValueStreamEntity] = useState<SelectedValueStreamEntity | null>(null);
  const [selectedValueStreamEntityLoading, setSelectedValueStreamEntityLoading] = useState(false);
  const [capError, setCapError] = useState<string | null>(null);
  const [savedCaps, setSavedCaps] = useState<CapabilityMatch[]>([]);
  const savedXmlRef = useRef<string>(EMPTY_DIAGRAM);
  const currentXmlRef = useRef<string>(currentXml);
  const savedCapsRef = useRef<CapabilityMatch[]>([]);
  const selectedCapsRef = useRef<CapabilityMatch[]>([]);

  // Application names for the assignment popover
  const [allAppNames, setAllAppNames] = useState<string[]>([]);
  const [allApplications, setAllApplications] = useState<ApplicationItem[]>([]);
  const [allBusinessFlowNames, setAllBusinessFlowNames] = useState<string[]>([]);
  // Task names for validity checks
  const [allTaskNames, setAllTaskNames] = useState<string[]>([]);
  // Actor names for lane validation
  const [allActorNames, setAllActorNames] = useState<string[]>([]);
  // Diagram metadata (parsed from BPMNDiagram name attribute)
  const [diagramMeta, setDiagramMeta] = useState<DiagramMetadata>({});

  // Factory navigation (from diagram links)
  const [factorySearch, setFactorySearch] = useState<Record<string, string>>({});
  const [factoryAdd, setFactoryAdd] = useState<Record<string, string | TaskAddData>>({});
  const [modelCatalogSearchRequest, setModelCatalogSearchRequest] = useState<Record<string, { text: string; column?: string; exact?: boolean; trigger: number }>>({});
  const [requestedApplicationDetail, setRequestedApplicationDetail] = useState<{ correlationId: string; nonce: number } | null>(null);
  const [diagramBrowserFilterRequest, setDiagramBrowserFilterRequest] = useState<{ frameworks?: string[]; filters?: Record<string, string[]>; nonce: number } | null>(null);
  // Selected task in diagram (for right sidebar link)
  const [selectedDiagramTask, setSelectedDiagramTask] = useState<{ name: string; id: string } | null>(null);

  // Fuzzy matching
  const [showAppMatch, setShowAppMatch] = useState(false);
  const [appMatchResults, setAppMatchResults] = useState<AppMatchResult[]>([]);
  const [showTaskMatch, setShowTaskMatch] = useState(false);
  const [taskMatchResults, setTaskMatchResults] = useState<AppMatchResult[]>([]);

  const canEditCurrentDiagramName = !readOnly && (!activeDiagram || (activeDiagram.status || '').toLowerCase() === 'draft');
  const canSaveCurrentDiagramToDb = currentXml !== EMPTY_DIAGRAM;

  const editorRef = useRef<BpmnEditorHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const modelBatchInputRef = useRef<HTMLInputElement>(null);
  const modelBatchNeighborhoodRef = useRef<string>('');

  // Keep refs in sync with state for use in callbacks/modals
  currentXmlRef.current = currentXml;
  savedCapsRef.current = savedCaps;
  selectedCapsRef.current = selectedCaps;

  const rebuildCompositeCanvas = useCallback(async (diagramIds: string[]) => {
    if (!diagramIds.length) {
      setSelectedDiagramStack([]);
      setCurrentXml(EMPTY_DIAGRAM);
      setActiveDiagram(null);
      setImportTrigger((t) => t + 1);
      setDiagramMeta({});
      setActiveFileName(null);
      setCanvasDiagramName(null);
      setIsDirty(false);
      return;
    }

    const stack = await Promise.all(diagramIds.map(async (diagramId) => ({
      diagram: await getDiagram(diagramId),
      xml: '',
    })));
    const withXml = stack.map((item) => ({ ...item, xml: item.diagram.xml }));
    const composedXml = composeStackedDiagramXml(withXml);

    setSelectedDiagramStack(withXml);
    setCurrentXml(composedXml);
    setImportTrigger((t) => t + 1);
    setActiveDiagram(withXml[withXml.length - 1].diagram ? {
      _id: withXml[withXml.length - 1].diagram._id,
      name: withXml[withXml.length - 1].diagram.name,
      description: withXml[withXml.length - 1].diagram.description,
      tags: withXml[withXml.length - 1].diagram.tags,
      status: withXml[withXml.length - 1].diagram.status,
      neighborhoodName: (withXml[withXml.length - 1].diagram as any).neighborhoodName,
      source: 'db',
    } : null);
    setDiagramMeta(extractDiagramMetadata(composedXml));
    setCanvasDiagramName(null);
    setActiveFileName(null);
    setIsDirty(false);
  }, []);

  // Detect unsaved capability changes
  const capsChanged = (() => {
    if (selectedCaps.length !== savedCaps.length) return true;
    const savedIds = new Set(savedCaps.map((c) => c.capabilityId));
    return selectedCaps.some((c) => !savedIds.has(c.capabilityId));
  })();
  const hasUnsavedChanges = isDirty || capsChanged;
  const quickSaveLabel = activeDiagram ? 'Quick save current diagram to MongoDB' : 'Save current diagram to MongoDB';
  const getBpmnRibbonGroups = () => [
    {
      key: 'file',
      title: 'File',
      actions: [
        { key: 'open', tooltip: 'Open BPMN file', icon: <UploadOutlined />, onClick: handleUploadLocal },
        { key: 'download', tooltip: 'Download BPMN file', icon: <DownloadOutlined />, onClick: handleDownloadLocal },
        { key: 'save-server', tooltip: 'Save BPMN file to server', icon: <SaveOutlined />, onClick: handleSaveToServer, disabled: readOnly },
        {
          key: 'quick-save-db',
          tooltip: quickSaveLabel,
          icon: <CloudUploadOutlined />,
          onClick: handleQuickSaveDb,
          disabled: readOnly || !canSaveCurrentDiagramToDb,
          type: hasUnsavedChanges && activeDiagram ? 'primary' : 'text',
        },
        {
          key: 'save-db',
          tooltip: 'Open save to MongoDB dialog',
          icon: <DatabaseOutlined />,
          onClick: () => setShowSaveDb(true),
          disabled: readOnly || !canSaveCurrentDiagramToDb,
        },
      ],
    },
    {
      key: 'view',
      title: 'View',
      actions: [
        { key: 'zoom-in', tooltip: 'Zoom in', icon: <ZoomInOutlined />, onClick: () => editorRef.current?.zoomIn() },
        { key: 'zoom-out', tooltip: 'Zoom out', icon: <ZoomOutOutlined />, onClick: () => editorRef.current?.zoomOut() },
        { key: 'fit', tooltip: 'Fit diagram to view', icon: <ExpandOutlined />, onClick: () => editorRef.current?.fitViewport() },
      ],
    },
    {
      key: 'resolve',
      title: 'Resolve',
      actions: [
        { key: 'validate-diagram', tooltip: 'Validate diagram and show invalid reasons', icon: <CheckCircleOutlined />, onClick: handleValidateDiagram },
        { key: 'match-apps', tooltip: 'Match applications to reference data', icon: <LaptopOutlined />, onClick: runAppFuzzyMatch },
        { key: 'match-tasks', tooltip: 'Match tasks to reference data', icon: <AppstoreOutlined />, onClick: runTaskFuzzyMatch },
      ],
    },
  ] as const;

  const refresh = useCallback(() => setRefreshTick((t) => t + 1), []);

  // Force the diagram list to refetch once the real neighborhood scope is known, so it
  // doesn't get stuck showing the empty result from the pre-resolution default scope.
  useEffect(() => {
    if (neighborhoodTabsResolved) refresh();
  }, [neighborhoodTabsResolved, refresh]);

  // Load validation reference data: tasks/actors from current model scope, applications from Data scope.
  const refreshReferenceData = useCallback((neighborhoodName: string) => {
    getApplicationReferenceForNeighborhood(REFERENCE_DATA_NEIGHBORHOOD_NAME).then((applications) => {
      setAllApplications(applications || []);
      setAllAppNames((applications || []).map((a: ApplicationItem) => a.name).filter(Boolean).sort());
    }).catch(() => {
      setAllApplications([]);
      setAllAppNames([]);
    });

    getTaskReferenceForNeighborhood(neighborhoodName).then((ref) => {
      setAllBusinessFlowNames((ref.businessFlows || []).map((flow: any) => flow.name).filter(Boolean).sort());
    }).catch(() => {
      setAllBusinessFlowNames([]);
    });

    getTaskNamesForNeighborhood(undefined, neighborhoodName).then((names) => {
      setAllTaskNames(names);
    }).catch(() => {
      setAllTaskNames([]);
    });

    getActorsForNeighborhood(neighborhoodName).then((actors) => {
      setAllActorNames(actors.map((actor) => actor.name));
    }).catch(() => {
      setAllActorNames([]);
    });
  }, [DEFAULT_NEIGHBORHOOD_NAME]);

  useEffect(() => {
    refreshReferenceData(scopedNeighborhoodName);
  }, [refreshReferenceData, scopedNeighborhoodName]);

  // Handle navigation to application from FK_ column links
  useEffect(() => {
    const handleNavigateToApplication = (event: Event) => {
      const customEvent = event as CustomEvent;
      const searchValue = customEvent.detail?.searchValue;
      const searchField = customEvent.detail?.searchField;
      const sourceColumn = customEvent.detail?.sourceColumn;
      const targetSubtab = customEvent.detail?.targetDataTab || customEvent.detail?.targetSubtab || customEvent.detail?.targetScope || 'applications';
      const targetDataTab = String(targetSubtab || '').trim() || 'applications';
      
      console.log(`[FK_EVENT_RECEIVED]`, {
        searchValue,
        searchField,
        sourceColumn,
        targetSubtab,
        targetDataTab,
        timestamp: new Date().toISOString()
      });
      
      if (searchValue && searchField) {
        // Build search query: search by specific field like Correlation_ID
        // Format: fieldName:value (e.g., "Correlation_ID:12345")
        const searchQuery = `${searchField}:${searchValue}`;
        console.log(`[FK_SEARCH_BUILD] Building search query: "${searchQuery}"`);
        
        setFactorySearch((prev) => {
          console.log(`[FK_SEARCH_UPDATE] Setting ${targetDataTab} search to encoded: "${encodeExactFactorySearch(searchQuery)}"`);
          return { ...prev, [targetDataTab]: encodeExactFactorySearch(searchQuery) };
        });
        
        console.log(`[FK_TAB_SWITCH] Switching to data outer tab and ${targetDataTab} data tab`);
        setActiveOuterTab('data');
        setActiveDataTab(targetDataTab);
        
        console.log(`[FK_NAVIGATION_COMPLETE] Navigated to ${targetDataTab} tab with field-specific search:`, {
          field: searchField,
          value: searchValue,
          query: searchQuery,
          targetDataTab,
        });
      } else {
        console.warn(`[FK_EVENT_INVALID] Event received but missing searchValue or searchField`, {
          searchValue,
          searchField
        });
      }
    };

    window.addEventListener('navigateToApplication', handleNavigateToApplication);
    console.log(`[FK_LISTENER_ATTACHED] Global navigateToApplication event listener attached`);
    
    return () => {
      window.removeEventListener('navigateToApplication', handleNavigateToApplication);
      console.log(`[FK_LISTENER_REMOVED] Global navigateToApplication event listener removed`);
    };
  }, []);

  // Navigate from diagram panel to a factory tab
  const resolveModelFactoryTabKey = useCallback(async (modelName: string, tab: string) => {
    if (tab === 'diagramFactory') return getModelBpmnComponentTabKey(modelName);

    const factories = neighborhoodFactories[modelName] || await getCanonicalFactories(modelName, true, 100).catch(() => [] as CustomFactory[]);
    const normalize = (value: string) => String(value || '').trim().toLowerCase().replace(/[_\s]+/g, '');
    const normalizedTab = normalize(tab);

    const aliases: Record<string, string[]> = {
      tasks: ['task', 'tasks', 'businesstask', 'businesstasks'],
      actors: ['actor', 'actors'],
      capabilities: ['capability', 'capabilities'],
      businessflows: ['businessflow', 'businessflows'],
      products: ['product', 'products'],
      channels: ['channel', 'channels'],
      domains: ['domain', 'domains'],
      subdomains: ['subdomain', 'subdomains'],
      linesofbusiness: ['lineofbusiness', 'lineofbusinesses', 'lob'],
    };

    const expectedNames = new Set(aliases[normalizedTab] || [normalizedTab]);
    const match = factories.find((factory) => expectedNames.has(normalize(factory.name)));
    return match?._id || tab;
  }, [getModelBpmnComponentTabKey, neighborhoodFactories]);

  const handleNavigateToFactory = useCallback((tab: string, searchTerm: string, mode: 'view' | 'add' = 'view', extra?: { applications?: string[]; actor?: string }) => {
    const targetModel = activeDiagram?.neighborhoodName || activeNeighborhoodTab || DEFAULT_NEIGHBORHOOD_NAME;

    const run = async () => {
      const resolvedTabKey = await resolveModelFactoryTabKey(targetModel, tab);

      if (mode === 'add') {
        if (tab === 'tasks') {
          // Use the current diagram name (renamed or DB name) as businessFlow, not the annotation value
          const currentBusinessFlow = activeDiagram?.name || canvasDiagramName || diagramMeta.businessFlow;
          setFactoryAdd((prev) => ({ ...prev, [resolvedTabKey]: { name: searchTerm, ...diagramMeta, ...extra, ...(currentBusinessFlow ? { businessFlow: currentBusinessFlow } : {}) } }));
        } else {
          setFactoryAdd((prev) => ({ ...prev, [resolvedTabKey]: searchTerm }));
        }
        setFactorySearch((prev) => ({ ...prev, [resolvedTabKey]: '' }));
      } else {
        setFactorySearch((prev) => ({ ...prev, [resolvedTabKey]: encodeExactFactorySearch(searchTerm) }));
        setFactoryAdd((prev) => ({ ...prev, [resolvedTabKey]: '' }));
      }

      setActiveOuterTab('neighborhoods');
      setActiveNeighborhoodTab(targetModel);
      setActiveFactoryTabs((current) => ({ ...current, [targetModel]: getModelComponentsTabKey(targetModel) }));
      setActiveModelComponentTabs((current) => ({ ...current, [targetModel]: resolvedTabKey }));
    };

    void run();
  }, [
    DEFAULT_NEIGHBORHOOD_NAME,
    activeDiagram,
    activeNeighborhoodTab,
    canvasDiagramName,
    diagramMeta,
    getModelComponentsTabKey,
    resolveModelFactoryTabKey,
  ]);

  const handleCapabilityClick = useCallback((capability: CapabilityMatch, nextSelected: CapabilityMatch[]) => {
    setSelectedCaps(nextSelected);
    setSelectedCapability(capability);
    setSelectedValueStreamEntity(null);
  }, []);

  const handleValueStreamCapabilitySelect = useCallback(async (selection: ValueStreamCapabilitySelection) => {
    const flowMode = activeValueStreamsModeByModel[selection.neighborhoodName] || 'valueStream';
    setSelectedCapability(null);
    setSelectedValueStreamEntityLoading(true);
    setSelectedValueStreamEntity({
      type: 'businessCapability',
      flowMode,
      title: selection.capabilityName,
      neighborhoodName: selection.neighborhoodName,
      domain: selection.domain,
      subdomain: selection.subdomain,
      valueStreamName: selection.valueStreamName,
      capabilityName: selection.capabilityName,
      relationshipCount: selection.relationshipCount,
      metadata: [],
    });

    try {
      const factories = await getCustomFactories(selection.neighborhoodName, selection.neighborhoodName);
      const capabilityFactory = factories.find(isBusinessCapabilityFactory) || null;
      const flowFactory = factories.find((factory) => normalizeLookupToken(factory.name) === (flowMode === 'journey' ? 'journey' : 'valuestream')) || null;
      const metadata = [
        ...getFactoryMetadata(flowFactory, selection.valueStreamName),
        ...getCapabilityMetadata(capabilityFactory, selection.capabilityName),
      ];
      setSelectedValueStreamEntity({
        type: 'businessCapability',
        flowMode,
        title: selection.capabilityName,
        neighborhoodName: selection.neighborhoodName,
        domain: selection.domain,
        subdomain: selection.subdomain,
        valueStreamName: selection.valueStreamName,
        capabilityName: selection.capabilityName,
        relationshipCount: selection.relationshipCount,
        metadata,
      });
    } catch {
      setSelectedValueStreamEntity({
        type: 'businessCapability',
        flowMode,
        title: selection.capabilityName,
        neighborhoodName: selection.neighborhoodName,
        domain: selection.domain,
        subdomain: selection.subdomain,
        valueStreamName: selection.valueStreamName,
        capabilityName: selection.capabilityName,
        relationshipCount: selection.relationshipCount,
        metadata: [],
      });
    } finally {
      setSelectedValueStreamEntityLoading(false);
    }
  }, [activeValueStreamsModeByModel]);

  const handleValueStreamRollupSelect = useCallback(async (selection: ValueStreamRollupSelection) => {
    const flowMode = activeValueStreamsModeByModel[selection.neighborhoodName] || 'valueStream';
    const flowLabel = flowMode === 'journey' ? 'journey' : 'value stream';
    setSelectedCapability(null);
    setSelectedValueStreamEntityLoading(true);
    setSelectedValueStreamEntity({
      type: 'rollup',
      flowMode,
      title: `${selection.domain} | ${selection.subdomain}`,
      neighborhoodName: selection.neighborhoodName,
      domain: selection.domain,
      subdomain: selection.subdomain,
      relationshipCount: selection.relationshipCount,
      secondaryCountLabel: `${selection.valueStreamCount} ${flowLabel}${selection.valueStreamCount === 1 ? '' : 's'}`,
      metadata: [],
    });

    try {
      const factories = await getCustomFactories(selection.neighborhoodName, selection.neighborhoodName);
      const domainFactory = factories.find((factory) => normalizeLookupToken(factory.name) === 'domain') || null;
      const subdomainFactory = factories.find((factory) => normalizeLookupToken(factory.name) === 'subdomain') || null;
      const metadata = [
        ...getFactoryMetadata(domainFactory, selection.domain),
        ...getFactoryMetadata(subdomainFactory, selection.subdomain),
      ];
      setSelectedValueStreamEntity({
        type: 'rollup',
        flowMode,
        title: `${selection.domain} | ${selection.subdomain}`,
        neighborhoodName: selection.neighborhoodName,
        domain: selection.domain,
        subdomain: selection.subdomain,
        relationshipCount: selection.relationshipCount,
        secondaryCountLabel: `${selection.valueStreamCount} ${flowLabel}${selection.valueStreamCount === 1 ? '' : 's'}`,
        metadata,
      });
    } catch {
      setSelectedValueStreamEntity({
        type: 'rollup',
        flowMode,
        title: `${selection.domain} | ${selection.subdomain}`,
        neighborhoodName: selection.neighborhoodName,
        domain: selection.domain,
        subdomain: selection.subdomain,
        relationshipCount: selection.relationshipCount,
        secondaryCountLabel: `${selection.valueStreamCount} ${flowLabel}${selection.valueStreamCount === 1 ? '' : 's'}`,
        metadata: [],
      });
    } finally {
      setSelectedValueStreamEntityLoading(false);
    }
  }, [activeValueStreamsModeByModel]);

  const handleValueStreamDomainSelect = useCallback(async (selection: DomainSelection) => {
    const flowMode = activeValueStreamsModeByModel[selection.neighborhoodName] || 'valueStream';
    setSelectedCapability(null);
    setSelectedValueStreamEntityLoading(true);
    setSelectedValueStreamEntity({
      type: 'domain',
      flowMode,
      title: selection.domain,
      neighborhoodName: selection.neighborhoodName,
      domain: selection.domain,
      subdomain: '',
      relationshipCount: selection.relationshipCount,
      secondaryCountLabel: `${selection.subdomainCount} subdomain${selection.subdomainCount === 1 ? '' : 's'}`,
      metadata: [],
    });

    try {
      const factories = await getCustomFactories(selection.neighborhoodName, selection.neighborhoodName);
      const domainFactory = factories.find((factory) => normalizeLookupToken(factory.name) === 'domain') || null;
      const metadata = getFactoryMetadata(domainFactory, selection.domain);
      setSelectedValueStreamEntity((current) => ({
        ...current,
        type: 'domain',
        flowMode,
        title: selection.domain,
        neighborhoodName: selection.neighborhoodName,
        domain: selection.domain,
        subdomain: '',
        relationshipCount: selection.relationshipCount,
        secondaryCountLabel: `${selection.subdomainCount} subdomain${selection.subdomainCount === 1 ? '' : 's'}`,
        metadata,
      }));
    } catch {
      setSelectedValueStreamEntity((current) => ({
        ...current,
        type: 'domain',
        flowMode,
        title: selection.domain,
        neighborhoodName: selection.neighborhoodName,
        domain: selection.domain,
        subdomain: '',
        relationshipCount: selection.relationshipCount,
        secondaryCountLabel: `${selection.subdomainCount} subdomain${selection.subdomainCount === 1 ? '' : 's'}`,
        metadata: [],
      }));
    } finally {
      setSelectedValueStreamEntityLoading(false);
    }
  }, [activeValueStreamsModeByModel]);

  const handleValueStreamSubdomainSelect = useCallback(async (selection: SubdomainSelection) => {
    const flowMode = activeValueStreamsModeByModel[selection.neighborhoodName] || 'valueStream';
    setSelectedCapability(null);
    setSelectedValueStreamEntityLoading(true);
    setSelectedValueStreamEntity({
      type: 'subdomain',
      flowMode,
      title: selection.subdomain,
      neighborhoodName: selection.neighborhoodName,
      domain: selection.domain,
      subdomain: selection.subdomain,
      relationshipCount: selection.relationshipCount,
      secondaryCountLabel: `${selection.businessFlowCount} business flow${selection.businessFlowCount === 1 ? '' : 's'}`,
      metadata: [],
    });

    try {
      const factories = await getCustomFactories(selection.neighborhoodName, selection.neighborhoodName);
      const subdomainFactory = factories.find((factory) => normalizeLookupToken(factory.name) === 'subdomain') || null;
      const metadata = getFactoryMetadata(subdomainFactory, selection.subdomain);
      setSelectedValueStreamEntity((current) => ({
        ...current,
        type: 'subdomain',
        flowMode,
        title: selection.subdomain,
        neighborhoodName: selection.neighborhoodName,
        domain: selection.domain,
        subdomain: selection.subdomain,
        relationshipCount: selection.relationshipCount,
        secondaryCountLabel: `${selection.businessFlowCount} business flow${selection.businessFlowCount === 1 ? '' : 's'}`,
        metadata,
      }));
    } catch {
      setSelectedValueStreamEntity((current) => ({
        ...current,
        type: 'subdomain',
        flowMode,
        title: selection.subdomain,
        neighborhoodName: selection.neighborhoodName,
        domain: selection.domain,
        subdomain: selection.subdomain,
        relationshipCount: selection.relationshipCount,
        secondaryCountLabel: `${selection.businessFlowCount} business flow${selection.businessFlowCount === 1 ? '' : 's'}`,
        metadata: [],
      }));
    } finally {
      setSelectedValueStreamEntityLoading(false);
    }
  }, [activeValueStreamsModeByModel]);

  const handleValueStreamFlowSelect = useCallback(async (selection: ValueStreamFlowSelection) => {
    const flowMode = activeValueStreamsModeByModel[selection.neighborhoodName] || 'valueStream';
    const flowLookup = flowMode === 'journey' ? 'journey' : 'valuestream';
    setSelectedCapability(null);
    setSelectedValueStreamEntityLoading(true);
    setSelectedValueStreamEntity({
      type: 'valueStream',
      flowMode,
      title: selection.valueStreamName,
      neighborhoodName: selection.neighborhoodName,
      domain: selection.domain,
      subdomain: selection.subdomain,
      valueStreamName: selection.valueStreamName,
      relationshipCount: selection.relationshipCount,
      metadata: [],
    });

    try {
      const factories = await getCustomFactories(selection.neighborhoodName, selection.neighborhoodName);
      const valueStreamFactory = factories.find((factory) => normalizeLookupToken(factory.name) === flowLookup) || null;
      const metadata = getFactoryMetadata(valueStreamFactory, selection.valueStreamName);
      setSelectedValueStreamEntity({
        type: 'valueStream',
        flowMode,
        title: selection.valueStreamName,
        neighborhoodName: selection.neighborhoodName,
        domain: selection.domain,
        subdomain: selection.subdomain,
        valueStreamName: selection.valueStreamName,
        relationshipCount: selection.relationshipCount,
        metadata,
      });
    } catch {
      setSelectedValueStreamEntity({
        type: 'valueStream',
        flowMode,
        title: selection.valueStreamName,
        neighborhoodName: selection.neighborhoodName,
        domain: selection.domain,
        subdomain: selection.subdomain,
        valueStreamName: selection.valueStreamName,
        relationshipCount: selection.relationshipCount,
        metadata: [],
      });
    } finally {
      setSelectedValueStreamEntityLoading(false);
    }
  }, [activeValueStreamsModeByModel]);

  const handleOpenCapabilityDiagrams = useCallback(() => {
    if (!selectedValueStreamEntity) return;
    const flowFilterKey = selectedValueStreamEntity.flowMode === 'journey' ? 'journey' : 'valueStream';

    setSelectedDiagramIds([]);
    void rebuildCompositeCanvas([]);
    setSelectedDiagramTask(null);

    const filters: Record<string, string[]> = {};
    const addFilter = (key: string, value?: string | null) => {
      const trimmed = String(value || '').trim();
      if (trimmed) filters[key] = [trimmed];
    };

    if (selectedValueStreamEntity.type === 'businessCapability') {
      addFilter('businessCapability', selectedValueStreamEntity.capabilityName);
      addFilter(flowFilterKey, selectedValueStreamEntity.valueStreamName);
      addFilter('domain', selectedValueStreamEntity.domain);
      addFilter('subdomain', selectedValueStreamEntity.subdomain);
    } else if (selectedValueStreamEntity.type === 'valueStream') {
      addFilter(flowFilterKey, selectedValueStreamEntity.valueStreamName);
      addFilter('domain', selectedValueStreamEntity.domain);
      addFilter('subdomain', selectedValueStreamEntity.subdomain);
    } else {
      addFilter('domain', selectedValueStreamEntity.domain);
      addFilter('subdomain', selectedValueStreamEntity.subdomain);
    }

    setDiagramBrowserFilterRequest({
      frameworks: [selectedValueStreamEntity.neighborhoodName],
      filters,
      nonce: Date.now(),
    });
    setActiveOuterTab('bpmn');
  }, [rebuildCompositeCanvas, selectedValueStreamEntity]);

  const handleOuterTabChange = useCallback((nextTab: string) => {
    if (nextTab === 'bpmn' && selectedValueStreamEntity) {
      const flowFilterKey = selectedValueStreamEntity.flowMode === 'journey' ? 'journey' : 'valueStream';
      const filters: Record<string, string[]> = {};
      const addFilter = (key: string, value?: string | null) => {
        const trimmed = String(value || '').trim();
        if (trimmed) filters[key] = [trimmed];
      };

      if (selectedValueStreamEntity.type === 'businessCapability') {
        addFilter('businessCapability', selectedValueStreamEntity.capabilityName);
        addFilter(flowFilterKey, selectedValueStreamEntity.valueStreamName);
        addFilter('domain', selectedValueStreamEntity.domain);
        addFilter('subdomain', selectedValueStreamEntity.subdomain);
      } else if (selectedValueStreamEntity.type === 'valueStream') {
        addFilter(flowFilterKey, selectedValueStreamEntity.valueStreamName);
        addFilter('domain', selectedValueStreamEntity.domain);
        addFilter('subdomain', selectedValueStreamEntity.subdomain);
      } else {
        addFilter('domain', selectedValueStreamEntity.domain);
        addFilter('subdomain', selectedValueStreamEntity.subdomain);
      }

      setSelectedDiagramIds([]);
      void rebuildCompositeCanvas([]);
      setSelectedDiagramTask(null);
      setDiagramBrowserFilterRequest({
        frameworks: [selectedValueStreamEntity.neighborhoodName],
        filters,
        nonce: Date.now(),
      });
    }

    setActiveOuterTab(nextTab);
  }, [rebuildCompositeCanvas, selectedValueStreamEntity]);

  const handleViewCapabilityInCatalog = useCallback((capability: CapabilityMatch) => {
    const clickedName = getCapabilityFocusName(capability.capabilityName);
    const targetModel = activeDiagram?.neighborhoodName || activeNeighborhoodTab || DEFAULT_NEIGHBORHOOD_NAME;

    setModelCatalogSearchRequest((current) => ({
      ...current,
      [targetModel]: {
        text: clickedName,
        column: 'name',
        exact: false,
        trigger: Date.now(),
      },
    }));

    setActiveOuterTab('neighborhoods');
    setActiveNeighborhoodTab(targetModel);
    setActiveFactoryTabs((current) => ({ ...current, [targetModel]: getModelCatalogTabKey(targetModel) }));
  }, [DEFAULT_NEIGHBORHOOD_NAME, activeDiagram, activeNeighborhoodTab, getModelCatalogTabKey]);

  const handleXmlChange = useCallback((xml: string) => {
    currentXmlRef.current = xml;
    setIsDirty(true);
  }, []);

  // Lightweight dirty signal from canvas edits (drag, property changes, etc.)
  // Does NOT export XML — avoids React re-render interfering with bpmn-js rendering
  const handleEditorDirty = useCallback(() => {
    setIsDirty(true);
  }, []);

  // ─── Fuzzy Matching ─────────────────────────────────────────

  /** Trigger fuzzy match on current diagram's applications */
  const runAppFuzzyMatch = useCallback(async () => {
    const feedbackKey = 'app-match-feedback';
    message.open({
      key: feedbackKey,
      type: 'loading',
      content: 'Matching applications to reference data...',
      duration: 0,
    });

    try {
      const xml = await editorRef.current?.getXml() || currentXmlRef.current;
      const apps = extractApplicationsFromXml(xml);
      if (!apps.length) {
        message.open({ key: feedbackKey, type: 'info', content: 'No applications found in the current diagram metadata', duration: 3 });
        return;
      }

      let referenceApplications = allApplications;
      if (!referenceApplications.length) {
        try {
          referenceApplications = await getApplicationReferenceForNeighborhood(REFERENCE_DATA_NEIGHBORHOOD_NAME);
          setAllApplications(referenceApplications);
          setAllAppNames(referenceApplications.map((app: ApplicationItem) => app.name).filter(Boolean).sort());
        } catch {
          if (!referenceApplications.length) {
            message.open({ key: feedbackKey, type: 'warning', content: 'Application reference data not loaded', duration: 4 });
            return;
          }
        }
      }

      if (!referenceApplications.length) {
        message.open({ key: feedbackKey, type: 'warning', content: 'Application reference data not loaded', duration: 4 });
        return;
      }

      const unresolvedApps = apps.filter((applicationName) => !isApplicationAlreadyValidated(applicationName, referenceApplications));
      if (!unresolvedApps.length) {
        message.open({ key: feedbackKey, type: 'success', content: `All ${apps.length} applications are already validated`, duration: 3 });
        return;
      }

      const results = computeAppMatches(unresolvedApps, referenceApplications);
      if (!results.length) {
        message.open({ key: feedbackKey, type: 'info', content: 'No application names were parsed for matching', duration: 3 });
        return;
      }

      const fuzzy = results.filter((r) => !r.exact);
      if (!fuzzy.length) {
        message.open({ key: feedbackKey, type: 'success', content: `All ${results.length} applications already match reference data`, duration: 3 });
        return;
      }

      setAppMatchResults(fuzzy);
      setShowAppMatch(true);
      message.open({ key: feedbackKey, type: 'success', content: `Found ${fuzzy.length} application names to review`, duration: 2 });
    } catch {
      message.open({ key: feedbackKey, type: 'error', content: 'Application matching failed. Please try again.', duration: 4 });
    }
  }, [allApplications, message, DEFAULT_NEIGHBORHOOD_NAME]);

  /** Handle approved application matches */
  const handleAppMatchApprove = useCallback(async (approved: AppMatchResult[]) => {
    setShowAppMatch(false);
    if (!approved.length) return;
    const replacements = new Map(approved.map((r) => [r.original.toLowerCase().trim(), r.refMatch!]));
    await editorRef.current?.replaceAppNames(replacements);
    message.success(`Replaced ${replacements.size} application name(s) with reference data`);
  }, [message]);

  /** Trigger fuzzy match on current diagram's task names */
  const runTaskFuzzyMatch = useCallback(async () => {
    const xml = await editorRef.current?.getXml() || currentXmlRef.current;
    const tasks = extractTaskNames(xml);
    if (!tasks.length) {
      message.info('No tasks found in the current diagram');
      return;
    }
    // Resolve the current business flow name to scope the reference list
    const currentFlow = activeDiagram?.name || canvasDiagramName || diagramMeta.businessFlow;
    let refNames: string[];
    if (currentFlow) {
      refNames = await getTaskNames(currentFlow);
      if (!refNames.length) {
        message.warning(`No tasks in the component view for business flow "${currentFlow}"`);
        return;
      }
    } else {
      refNames = allTaskNames;
      if (!refNames.length) {
        message.warning('Task reference data not loaded');
        return;
      }
    }
    const results = computeAppMatches(tasks, refNames);
    const fuzzy = results.filter((r) => !r.exact);
    if (!fuzzy.length) {
      message.success('All task names already match reference data');
      return;
    }
    setTaskMatchResults(fuzzy);
    setShowTaskMatch(true);
  }, [activeDiagram, canvasDiagramName, diagramMeta.businessFlow, allTaskNames, message]);

  /** Handle approved task matches */
  const handleTaskMatchApprove = useCallback(async (approved: AppMatchResult[]) => {
    setShowTaskMatch(false);
    if (!approved.length) return;
    const replacements = new Map(approved.map((r) => [r.original, r.refMatch!]));
    await editorRef.current?.replaceTaskNames(replacements);
    message.success(`Replaced ${replacements.size} task name(s) with reference data`);
  }, [message]);

  const handleValidateDiagram = useCallback(async () => {
    const xml = await editorRef.current?.getXml() || currentXmlRef.current;
    if (!xml || xml === EMPTY_DIAGRAM) {
      message.info('Load or create a diagram before running validation.');
      return;
    }

    // Always refresh on-canvas task validity colors from Model Component Task names.
    await editorRef.current?.validateTasks();

    // Step 1: use the same quick task/application checks as the Match buttons.
    const tasks = extractTaskNames(xml);
    const apps = extractApplicationsFromXml(xml);

    const currentFlow = activeDiagram?.name || canvasDiagramName || diagramMeta.businessFlow;
    let taskReferenceNames: string[] = [];
    if (tasks.length) {
      if (currentFlow) {
        taskReferenceNames = await getTaskNames(currentFlow).catch(() => [] as string[]);
      } else {
        taskReferenceNames = allTaskNames;
      }
    }

    const quickTaskResults = (tasks.length && taskReferenceNames.length)
      ? computeAppMatches(tasks, taskReferenceNames)
      : [];
    const invalidTaskNames = Array.from(new Set(quickTaskResults.filter((result) => !result.exact).map((result) => result.original)));

    let referenceApplications = allApplications;
    if (!referenceApplications.length) {
      referenceApplications = await getApplicationReferenceForNeighborhood(REFERENCE_DATA_NEIGHBORHOOD_NAME).catch(() => [] as ApplicationItem[]);
      if (referenceApplications.length) {
        setAllApplications(referenceApplications);
        setAllAppNames(referenceApplications.map((app: ApplicationItem) => app.name).filter(Boolean).sort());
      }
    }

    const invalidApplicationNames = Array.from(new Set(
      apps.filter((applicationName) => !isApplicationAlreadyValidated(applicationName, referenceApplications))
    ));

    if (invalidTaskNames.length || invalidApplicationNames.length) {
      const reasons = [
        invalidTaskNames.length ? `Invalid tasks: ${invalidTaskNames.length}` : null,
        invalidApplicationNames.length ? `Invalid applications: ${invalidApplicationNames.length}` : null,
      ].filter(Boolean) as string[];

      modal.warning({
        title: 'Diagram Validation: Task/Application Check Failed',
        width: 760,
        content: (
          <div style={{ maxHeight: 420, overflowY: 'auto' }}>
            <p><strong>Status:</strong> Invalid</p>
            <p><strong>Why Invalid:</strong></p>
            <ul style={{ paddingLeft: 18 }}>
              {reasons.map((reason) => <li key={reason}>{reason}</li>)}
            </ul>
            {!!invalidTaskNames.length && (
              <p><strong>Invalid Task Names:</strong> {invalidTaskNames.slice(0, 20).join(', ')}{invalidTaskNames.length > 20 ? ' ...' : ''}</p>
            )}
            {!!invalidApplicationNames.length && (
              <p><strong>Invalid Application Names:</strong> {invalidApplicationNames.slice(0, 20).join(', ')}{invalidApplicationNames.length > 20 ? ' ...' : ''}</p>
            )}
            <p style={{ marginTop: 8, color: '#64748b' }}>
              Resolve these first using Match Tasks / Match Applications, then run full diagram validation.
            </p>
          </div>
        ),
      });
      return;
    }

    try {
      const report = await validateDiagramReport({
        id: activeDiagram?._id,
        xml,
        name: activeDiagram?.name || canvasDiagramName || diagramMeta.businessFlow || undefined,
        businessFlow: diagramMeta.businessFlow || activeDiagram?.name || canvasDiagramName || undefined,
        capabilities: selectedCapsRef.current,
        neighborhoodName: activeDiagram?.neighborhoodName || activeNeighborhoodTab,
      });

      const detailsBlock = (
        <div style={{ maxHeight: 420, overflowY: 'auto' }}>
          <p><strong>Model:</strong> {report.neighborhoodName}</p>
          <p><strong>Diagram:</strong> {report.diagramName || 'Untitled'}</p>
          <p><strong>Status:</strong> {report.isValid ? 'Valid' : 'Invalid'}</p>
          <p><strong>Business Flow Reference:</strong> {report.summary.hasBusinessFlowReference ? 'OK' : 'Missing'}</p>
          <p><strong>Capabilities:</strong> {report.summary.hasCapabilities ? 'OK' : 'Missing'}</p>
          <p><strong>Invalid Metadata Fields:</strong> {report.summary.metadataInvalidFieldCount}</p>
          <p><strong>Invalid Tasks:</strong> {report.summary.invalidTaskCount}</p>
          <p><strong>Invalid Applications:</strong> {report.summary.invalidApplicationCount}</p>
          <p><strong>Invalid Actors:</strong> {report.summary.invalidActorCount}</p>

          {!!report.reasons.length && (
            <>
              <p style={{ marginTop: 12 }}><strong>Why Invalid:</strong></p>
              <ul style={{ paddingLeft: 18 }}>
                {report.reasons.map((reason, idx) => <li key={`${reason}-${idx}`}>{reason}</li>)}
              </ul>
            </>
          )}

          {!!report.details.invalidTasks.length && (
            <p><strong>Invalid Task Names:</strong> {report.details.invalidTasks.slice(0, 15).join(', ')}{report.details.invalidTasks.length > 15 ? ' ...' : ''}</p>
          )}
          {!!report.details.invalidApplications.length && (
            <p><strong>Invalid Application Names:</strong> {report.details.invalidApplications.slice(0, 15).join(', ')}{report.details.invalidApplications.length > 15 ? ' ...' : ''}</p>
          )}
          {!!report.details.invalidActors.length && (
            <p><strong>Invalid Actor Names:</strong> {report.details.invalidActors.slice(0, 15).join(', ')}{report.details.invalidActors.length > 15 ? ' ...' : ''}</p>
          )}
        </div>
      );

      modal.info({
        title: report.isValid ? 'Diagram Validation: Passed' : 'Diagram Validation: Failed',
        width: 760,
        content: detailsBlock,
      });
    } catch (err: any) {
      message.error(err.response?.data?.error || err.message || 'Diagram validation failed.');
    }
  }, [activeDiagram, activeNeighborhoodTab, canvasDiagramName, diagramMeta.businessFlow, message, modal]);

  // ─── Capability Matching ────────────────────────────────────
  const runCapabilityMatch = useCallback(
    async (_xml: string) => {
      setCapLoading(true);
      setCapMatches([]);
      setSelectedCaps([]);
      setCapError(null);

      // TODO: Remove hardcoded mock once OPENAI_API_KEY is configured
      const mockMatches: CapabilityMatch[] = [
        { capabilityId: 1, capabilityName: 'Service Problem Management', confidence: 95, justification: 'Process directly handles fault detection, diagnosis, and resolution of service issues reported by customers.' },
        { capabilityId: 2, capabilityName: 'Customer Interaction Management', confidence: 88, justification: 'Customer contact centre receives and manages inbound trouble reports and communicates resolution updates.' },
        { capabilityId: 3, capabilityName: 'Resource Work Order Management', confidence: 85, justification: 'Field technician dispatch and work order lifecycle for physical network resource repair.' },
        { capabilityId: 4, capabilityName: 'Service Fulfillment Management', confidence: 78, justification: 'Service restoration activities ensure contracted service levels are re-established after faults.' },
        { capabilityId: 5, capabilityName: 'Customer Assurance Management', confidence: 72, justification: 'End-to-end assurance of customer experience through proactive monitoring and SLA tracking.' },
      ];

      setTimeout(() => {
        setCapMatches(mockMatches);
        // Keep only already-saved caps selected; new matches require user click
        setSelectedCaps(savedCapsRef.current);
        setCapLoading(false);
        message.success(`Matched ${mockMatches.length} capabilities`);
      }, 800);
    },
    [message],
  );

  // ─── File System Operations ─────────────────────────────────
  const handleUploadLocal = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const importBpmnFile = useCallback(async (file: File) => {
    const xml = await file.text();
    const meta = extractDiagramMetadata(xml);

    setCurrentXml(xml);
    setImportTrigger((t) => t + 1);
    setDiagramMeta(meta);
    setActiveFileName(file.name);
    setCanvasDiagramName(null); // will use meta.businessFlow via diagramName prop
    setIsDirty(false);

    const bfName = meta.businessFlow || file.name.replace(/\.(bpmn|xml)$/i, '');
    try {
      const flowMap = await getBusinessFlowMap();
      const existingId = flowMap[bfName];
      if (existingId) {
        setActiveDiagram({ _id: existingId, name: bfName, description: '', tags: [], source: 'local-match' });
      } else {
        setActiveDiagram(null);
      }
    } catch {
      setActiveDiagram(null);
    }
    message.success(`Opened: ${file.name}`);
  }, [message]);

  const handleFileSelected = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      await importBpmnFile(file);
      e.target.value = '';
    },
    [importBpmnFile],
  );

  const handleImportModelBpmn = useCallback((neighborhoodName: string) => {
    modal.confirm({
      title: 'Confirm selected model',
      content: (
        <div>
          <p>You are about to bulk import BPMN 2.0 XML files into this model:</p>
          <Tag color="blue" style={{ marginTop: 4 }}>{neighborhoodName}</Tag>
        </div>
      ),
      okText: 'Continue',
      cancelText: 'Cancel',
      onOk: () => {
        modelBatchNeighborhoodRef.current = neighborhoodName;
        setApiNeighborhoodScope(neighborhoodName);
        modelBatchInputRef.current?.click();
      },
    });
  }, [modal]);

  const handleModelBatchFilesSelected = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const neighborhoodName = modelBatchNeighborhoodRef.current;
    const files = e.target.files;
    if (!files?.length || !neighborhoodName) {
      e.target.value = '';
      return;
    }

    const readFiles: { xml: string; fileName: string }[] = [];
    for (const file of Array.from(files)) {
      const xml = await file.text();
      readFiles.push({ xml, fileName: file.name });
    }

    e.target.value = '';
    modelBatchNeighborhoodRef.current = '';

    modal.confirm({
      title: `Batch Import ${readFiles.length} file(s) into ${neighborhoodName}`,
      content: (
        <div>
          <p>The following files will be imported with status <Tag color="orange">Staged</Tag> or <Tag color="red">Invalid</Tag> when validation fails.</p>
          <p>Each XML is validated against the selected model scope. Application components are validated against Data Applications.</p>
          <ul style={{ maxHeight: 200, overflow: 'auto', paddingLeft: 16 }}>
            {readFiles.map((file) => <li key={file.fileName}>{file.fileName}</li>)}
          </ul>
        </div>
      ),
      okText: 'Import All',
      onOk: async () => {
        try {
          const result = await batchImportDiagrams(readFiles, CURRENT_USER);
          const invalidCount = result.success.filter((item) => (item.status || '').toLowerCase() === 'invalid').length;
          if (result.failed.length) {
            message.warning(`${result.success.length} imported (${invalidCount} invalid), ${result.failed.length} failed`);
          } else {
            message.success(`Imported ${result.success.length} diagrams (${invalidCount} invalid)`);
          }
          await refreshNeighborhoodModelData(neighborhoodName);
          refresh();
        } catch (err: any) {
          message.error(err.response?.data?.error || err.message);
        }
      },
    });
  }, [CURRENT_USER, message, modal, refresh, refreshNeighborhoodModelData]);

  const handleDownloadLocal = useCallback(async () => {
    const xml = await editorRef.current?.getXml() || currentXmlRef.current;
    const blob = new Blob([xml], { type: 'application/xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = activeFileName || `${activeDiagram?.name || 'diagram'}.bpmn`;
    a.click();
    URL.revokeObjectURL(url);
    message.success('Downloaded to your computer');
  }, [activeFileName, activeDiagram, message]);

  const handleSaveToServer = useCallback(async () => {
    const filename = activeFileName || `${activeDiagram?.name || 'diagram'}.bpmn`;
    try {
      const xml = await editorRef.current?.getXml() || currentXmlRef.current;
      const result = await saveFile(filename.replace('.bpmn', ''), xml);
      message.success(`Saved to server: ${result.filename}`);
      setActiveFileName(result.filename);
      refresh();
    } catch (err: any) {
      message.error(err.message);
    }
  }, [activeFileName, activeDiagram, message, refresh]);

  // ─── MongoDB Operations ─────────────────────────────────────
  const handleSelectDiagram = useCallback(
    async (id: string) => {
      try {
        const diagram = await getDiagram(id);
        setActiveDiagram({
          _id: diagram._id,
          name: diagram.name,
          description: diagram.description,
          tags: diagram.tags,
          status: diagram.status,
          neighborhoodName: (diagram as any).neighborhoodName,
          source: 'db',
        });
        if ((diagram as any).neighborhoodName) {
          setActiveNeighborhoodTab((diagram as any).neighborhoodName);
        }
        setCurrentXml(diagram.xml);
        setImportTrigger(t => t + 1);
        setDiagramMeta(extractDiagramMetadata(diagram.xml));
        savedXmlRef.current = diagram.xml;
        setActiveFileName(null);
        setCanvasDiagramName(null);
        setIsDirty(false);
        message.success(`Loaded from DB: ${diagram.name}`);
        // Show previously assigned capabilities (not as matches)
        setCapMatches([]);
        setCapError(null);
        if (diagram.capabilities?.length) {
          setSelectedCaps(diagram.capabilities);
          setSavedCaps(diagram.capabilities);
        } else {
          setSelectedCaps([]);
          setSavedCaps([]);
        }
      } catch (err: any) {
        message.error(err?.response?.data?.error || err?.message || 'Failed to save diagram to MongoDB.');
      }
    },
    [message],
  );

  const toggleCanvasDiagram = useCallback(async (id: string, neighborhoodName?: string) => {
    setActiveOuterTab('bpmn');
    setSelectedDiagramIds((current) => {
      const shouldReplace = Boolean(
        neighborhoodName
        && activeDiagramNeighborhoodName
        && neighborhoodName !== activeDiagramNeighborhoodName
      );
      const exists = current.includes(id);
      const next = shouldReplace
        ? [id]
        : (exists ? current.filter((diagramId) => diagramId !== id) : [...current, id]);
      if (shouldReplace) {
        setActiveDiagramNeighborhoodName(neighborhoodName || null);
      }
      void rebuildCompositeCanvas(next);
      return next;
    });
  }, [activeDiagramNeighborhoodName, rebuildCompositeCanvas]);

  // Canvas tab diagram search handler
  const handleCanvasDiagramSearch = useCallback((value: string) => {
    if (canvasSearchTimer.current) clearTimeout(canvasSearchTimer.current);
    if (!value.trim()) {
      // Load all diagrams when search is empty
      getDiagrams().then((data) => {
        setCanvasDiagramOptions(data.map((d) => ({
          value: d._id,
          label: d.name,
          desc: [d.businessFlow, d.status, d.lineOfBusiness].filter(Boolean).join(' · '),
        })));
      }).catch(() => {});
      return;
    }
    canvasSearchTimer.current = setTimeout(() => {
      searchDiagrams(value.trim()).then((results) => {
        setCanvasDiagramOptions(results.map((d) => ({
          value: d._id,
          label: d.name,
          desc: [d.businessFlow, d.status, d.lineOfBusiness].filter(Boolean).join(' · '),
        })));
      }).catch(() => {});
    }, 300);
  }, []);

  const handleDeleteCapability = useCallback(
    async (capabilityId: number) => {
      const removed = selectedCaps.find((c) => c.capabilityId === capabilityId);
      const remaining = selectedCaps.filter((c) => c.capabilityId !== capabilityId);
      setSelectedCaps(remaining);
      setSavedCaps(remaining);
      if (activeDiagram?._id) {
        try {
          await updateDiagram(activeDiagram._id, {
            capabilities: remaining,
            changeNote: { userId: CURRENT_USER, note: `Removed capability: ${removed?.capabilityName || capabilityId}` },
          });
          message.success('Capability removed');
        } catch (err: any) {
          message.error(`Failed to remove: ${err.message}`);
        }
      }
    },
    [selectedCaps, activeDiagram, message],
  );

  const handleCapabilityAssignToggle = useCallback(
    async (capability: CapabilityMatch) => {
      const currentlyAssigned = selectedCaps.some((c) => c.capabilityId === capability.capabilityId);
      if (currentlyAssigned) {
        const wasSaved = savedCaps.some((c) => c.capabilityId === capability.capabilityId);
        if (wasSaved) {
          await handleDeleteCapability(capability.capabilityId);
        } else {
          setSelectedCaps((prev) => prev.filter((c) => c.capabilityId !== capability.capabilityId));
        }
        return;
      }

      setSelectedCaps((prev) => (prev.some((c) => c.capabilityId === capability.capabilityId) ? prev : [...prev, capability]));
      message.success('Capability assigned');
    },
    [handleDeleteCapability, message, savedCaps, selectedCaps],
  );

  const handleDeleteAllDataComponents = useCallback(async () => {
    Modal.confirm({
      title: 'Delete All Components in Data?',
      content: (
        <div style={{ display: 'grid', gap: 8 }}>
          <div>This will permanently delete all Application, Server, and Database components.</div>
          <div style={{ color: '#b91c1c', fontWeight: 600 }}>This action cannot be undone.</div>
        </div>
      ),
      okText: 'Delete All',
      okType: 'danger',
      centered: true,
      onOk: async () => {
        setDeleteAllComponentsLoading(true);
        try {
          const currentModel = activeNeighborhoodTab || DEFAULT_NEIGHBORHOOD_NAME;
          // Call server endpoint to delete all components + canonical + batches + search index
          await api.delete(`/custom-factories/neighborhoods/${encodeURIComponent(currentModel)}/components`);
          message.success(`Deleted all components and related data for ${currentModel}`);
          await loadNeighborhoodTabs();
        } catch (error: any) {
          message.error(error.response?.data?.error || error.message);
        } finally {
          setDeleteAllComponentsLoading(false);
        }
      },
    });
  }, [activeNeighborhoodTab, DEFAULT_NEIGHBORHOOD_NAME, message, loadNeighborhoodTabs]);

  const handleDeleteComponentType = useCallback(async (componentType: string) => {
    // Map normalized component types to display names
    const typeDisplayMap: Record<string, string> = {
      'application': 'Application',
      'server': 'Server',
      'databaseInstance': 'Database',
      'product': 'Product',
      'actor': 'Actor',
    };
    
    const displayName = typeDisplayMap[componentType] || componentType;
    
    Modal.confirm({
      title: `Delete All ${displayName} Components?`,
      content: (
        <div style={{ display: 'grid', gap: 8 }}>
          <div>This will permanently delete all {displayName} components in this model.</div>
          <div style={{ color: '#b91c1c', fontWeight: 600 }}>This action cannot be undone.</div>
        </div>
      ),
      okText: `Delete All ${displayName}`,
      okType: 'danger',
      centered: true,
      onOk: async () => {
        setDeleteComponentTypeLoading(componentType);
        try {
          const currentModel = activeNeighborhoodTab || DEFAULT_NEIGHBORHOOD_NAME;
          const factories = await getCustomFactories(currentModel);
          
          // Filter factories by their componentType field (already normalized from server)
          const toDelete = factories.filter(f => f.componentType === componentType);
          
          let deletedCount = 0;
          for (const factory of toDelete) {
            try {
              await deleteCustomFactory(factory._id);
              deletedCount++;
            } catch (err) {
              console.warn('Failed to delete component', factory._id, err);
            }
          }
          
          message.success(`Deleted ${deletedCount} ${displayName} components`);
          await loadNeighborhoodTabs();
        } catch (error: any) {
          message.error(error.response?.data?.error || error.message);
        } finally {
          setDeleteComponentTypeLoading(null);
        }
      },
    });
  }, [activeNeighborhoodTab, DEFAULT_NEIGHBORHOOD_NAME, message, loadNeighborhoodTabs]);

  // Delete a single Data type (e.g. Data[Applications]) without affecting other Data types (e.g. Data[Servers]).
  const handleDeleteDataComponentType = useCallback(async (tabKey: string, dataTypeValues: string[]) => {
    const distinct = Array.from(new Set(dataTypeValues.map((v) => String(v || '').trim()).filter(Boolean)));
    if (!distinct.length) {
      message.info('No data to delete for this type');
      return;
    }
    const displayName = distinct.length === 1 ? distinct[0] : `${distinct[0]} (+${distinct.length - 1})`;

    Modal.confirm({
      title: `Delete Data[${displayName}]?`,
      content: (
        <div style={{ display: 'grid', gap: 8 }}>
          <div>This will permanently delete all {displayName} reference data. Other Data types are not affected.</div>
          <div style={{ color: '#b91c1c', fontWeight: 600 }}>This action cannot be undone.</div>
        </div>
      ),
      okText: `Delete Data[${displayName}]`,
      okType: 'danger',
      centered: true,
      onOk: async () => {
        setDeleteComponentTypeLoading(tabKey);
        try {
          let deletedBatches = 0;
          for (const dt of distinct) {
            const res = await deleteDataComponentType(dt);
            deletedBatches += res?.deletedBatchCount || 0;
          }
          message.success(`Deleted Data[${displayName}]`);
          await loadDataTypeSummaries();
          await loadDataFactoriesForType(tabKey);
        } catch (error: any) {
          message.error(error.response?.data?.error || error.message);
        } finally {
          setDeleteComponentTypeLoading(null);
        }
      },
    });
  }, [loadDataFactoriesForType, loadDataTypeSummaries, message]);

  const handleSaveDb = useCallback(
    async ({ name, description, tags, changeNote }: { name: string; description: string; tags: string[]; changeNote?: string }) => {
      try {
        const latestXml = await editorRef.current?.getXml() || currentXmlRef.current;
        currentXmlRef.current = latestXml;
        if (activeDiagram?._id) {
          const autoNote = changeNote || generateChangeNote(savedXmlRef.current, latestXml, savedCapsRef.current, selectedCapsRef.current);
          const updated = await updateDiagram(activeDiagram._id, {
            name,
            description,
            tags,
            xml: latestXml,
            lineOfBusiness: diagramMeta.lineOfBusiness,
            channel: diagramMeta.channel,
            domain: diagramMeta.domain,
            subdomain: diagramMeta.subdomain,
            product: diagramMeta.product,
            businessFlow: diagramMeta.businessFlow,
            capabilities: selectedCapsRef.current,
            changeNote: { userId: CURRENT_USER, note: autoNote },
            updatedBy: CURRENT_USER,
          });
          setActiveDiagram({
            _id: updated._id,
            name: updated.name,
            description: updated.description,
            tags: updated.tags,
            status: updated.status,
            source: 'db',
          });
          setSavedCaps(selectedCapsRef.current);
          message.success(`Updated in DB: ${updated.name}`);
        } else {
          const created = await createDiagram({
            name,
            description,
            tags,
            xml: latestXml,
            lineOfBusiness: diagramMeta.lineOfBusiness,
            channel: diagramMeta.channel,
            domain: diagramMeta.domain,
            subdomain: diagramMeta.subdomain,
            product: diagramMeta.product,
            businessFlow: diagramMeta.businessFlow,
            capabilities: selectedCapsRef.current,
            createdBy: CURRENT_USER,
            sourcedFrom: activeFileName || undefined,
          });
          setActiveDiagram({
            _id: created._id,
            name: created.name,
            description: created.description,
            tags: created.tags,
            status: created.status,
            source: 'db',
          });
          setSavedCaps(selectedCapsRef.current);
          message.success(`Saved to DB: ${created.name}`);
        }
        setIsDirty(false);
        setCapMatches([]);
        savedXmlRef.current = latestXml;
        editorRef.current?.validateTasks();
        refresh();
        setShowSaveDb(false);
      } catch (err: any) {
        message.error(err.message);
      }
    },
    [activeDiagram, message, refresh, activeFileName],
  );

  const handleQuickSaveDb = useCallback(async () => {
    if (!activeDiagram?._id) {
      setShowSaveDb(true);
      return;
    }
    // Get latest XML from the editor
    const latestXml = await editorRef.current?.getXml() || currentXmlRef.current;
    currentXmlRef.current = latestXml;
    // Auto-generate change note from diffs (use refs for always-current values)
    let noteValue = generateChangeNote(savedXmlRef.current, latestXml, savedCapsRef.current, selectedCapsRef.current);
    Modal.confirm({
      title: 'Change Note',
      content: (
        <Input.TextArea
          rows={3}
          defaultValue={noteValue}
          onChange={(e) => { noteValue = e.target.value; }}
          placeholder="Describe what changed…"
        />
      ),
      okText: 'Save',
      onOk: () => handleSaveDb({
        name: activeDiagram.name,
        description: activeDiagram.description,
        tags: activeDiagram.tags,
        changeNote: noteValue,
      }),
    });
  }, [activeDiagram, handleSaveDb]);

  // New diagram — show name prompt
  const handleNew = useCallback(() => {
    setShowNewDiagramPrompt(true);
  }, []);

  const handleNewDiagramConfirm = useCallback((name: string) => {
    setActiveDiagram(null);
    setActiveFileName(null);
    setCanvasDiagramName(name);
    setCurrentXml(EMPTY_DIAGRAM);
    setImportTrigger(t => t + 1);
    setDiagramMeta({});
    setIsDirty(false);
    setCapMatches([]);
    setSelectedCaps([]);
    setShowNewDiagramPrompt(false);
  }, []);

  // Rename diagram
  const handleRenameDiagram = useCallback(async (newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed) { setEditingName(false); return; }
    if (activeDiagram?._id && (activeDiagram.status || '').toLowerCase() !== 'draft') {
      message.warning('Set the diagram status to Draft before renaming it.');
      setEditingName(false);
      return;
    }
    if (activeDiagram?._id) {
      try {
        await updateDiagram(activeDiagram._id, { name: trimmed });
        setActiveDiagram((prev) => prev ? { ...prev, name: trimmed } : prev);
        refresh();
        message.success('Diagram renamed');
      } catch (e: any) {
        message.error(e.response?.data?.error || e.message);
      }
    }
    setEditingName(false);
  }, [activeDiagram, message, refresh]);

  const sortedAnalyticsModels = useMemo(() => {
    const sourceModels = neighborhoodTabs.length
      ? neighborhoodTabs
      : [{ name: DEFAULT_NEIGHBORHOOD_NAME, factoryCount: 0 } as FactoryNeighborhoodSummary];

    return [...sourceModels].sort((left, right) => {
      const leftIndex = neighborhoodTabOrder.indexOf(left.name);
      const rightIndex = neighborhoodTabOrder.indexOf(right.name);
      const safeLeft = leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex;
      const safeRight = rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex;
      return safeLeft - safeRight;
    });
  }, [DEFAULT_NEIGHBORHOOD_NAME, neighborhoodTabOrder, neighborhoodTabs]);

  const sortedValueStreamModels = useMemo(() => {
    const sourceModels = neighborhoodTabs.length
      ? neighborhoodTabs
      : [{ name: DEFAULT_NEIGHBORHOOD_NAME, factoryCount: 0 } as FactoryNeighborhoodSummary];

    return [...sourceModels].sort((left, right) => {
      const leftIndex = neighborhoodTabOrder.indexOf(left.name);
      const rightIndex = neighborhoodTabOrder.indexOf(right.name);
      const safeLeft = leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex;
      const safeRight = rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex;
      return safeLeft - safeRight;
    });
  }, [DEFAULT_NEIGHBORHOOD_NAME, neighborhoodTabOrder, neighborhoodTabs]);

  const valueStreamModelTabItems = useMemo(() => sortedValueStreamModels.map((model) => ({
    key: model.name,
    label: neighborhoodTabLabel(model.name, model.name),
    children: (
      <ValueStreamsMatrix
        neighborhoodName={model.name}
        mode={activeValueStreamsModeByModel[model.name] || 'valueStream'}
        onModeChange={(mode) => setActiveValueStreamsModeByModel((current) => ({ ...current, [model.name]: mode }))}
        onDomainSelect={handleValueStreamDomainSelect}
        onSubdomainSelect={handleValueStreamSubdomainSelect}
        onCapabilitySelect={handleValueStreamCapabilitySelect}
        onRollupSelect={handleValueStreamRollupSelect}
        onValueStreamSelect={handleValueStreamFlowSelect}
        selectedCapabilityName={selectedValueStreamEntity?.type === 'businessCapability' ? selectedValueStreamEntity.capabilityName || null : null}
        selectedValueStreamName={selectedValueStreamEntity?.valueStreamName || null}
        selectedRollupKey={selectedValueStreamEntity?.type === 'rollup' ? `${selectedValueStreamEntity.domain}|||${selectedValueStreamEntity.subdomain}` : null}
        selectedValueStreamKey={selectedValueStreamEntity?.type === 'valueStream' && selectedValueStreamEntity.valueStreamName ? `${selectedValueStreamEntity.valueStreamName}|||${selectedValueStreamEntity.domain} | ${selectedValueStreamEntity.subdomain}` : null}
      />
    ),
  })), [activeValueStreamsModeByModel, handleValueStreamCapabilitySelect, handleValueStreamFlowSelect, handleValueStreamRollupSelect, neighborhoodTabLabel, selectedValueStreamEntity, sortedValueStreamModels]);

  const analyticsModelTabItems = useMemo(() => sortedAnalyticsModels.map((model) => ({
    key: model.name,
    label: neighborhoodTabLabel(model.name, model.name),
    children: (
      <Tabs
        className="factory-tabs"
        activeKey={activeAnalyticsTabsByModel[model.name] || activeAnalyticsTab || 'dashboard'}
        onChange={(key) => {
          setActiveAnalyticsTab(key);
          setActiveAnalyticsTabsByModel((current) => ({ ...current, [model.name]: key }));
        }}
        destroyInactiveTabPane
        items={[
          {
            key: 'dashboard',
            label: analyticsTabLabel('dashboard', <span><DashboardOutlined /> Dashboards</span>),
            children: <Dashboard key={`dashboard:${model.name}`} />,
          },
          {
            key: 'reports',
            label: analyticsTabLabel('reports', <span><FileTextOutlined /> Reports</span>),
            children: <ReportsPanel key={`reports:${model.name}`} />,
          },
        ].sort((a, b) => analyticsTabOrder.indexOf(a.key) - analyticsTabOrder.indexOf(b.key))}
      />
    ),
  })), [activeAnalyticsTab, activeAnalyticsTabsByModel, analyticsTabLabel, neighborhoodTabLabel, sortedAnalyticsModels]);

  const dataTabItems = useMemo(() => visibleDataTabs.map((tab) => {
    const componentType = tab.key;
    const isLoaded = dataFactoriesByType[componentType] !== undefined;
    const loadedFactories = dataFactoriesByType[componentType] || [];
    return {
      key: componentType,
      label: dataTabLabel(componentType, <span>{getDataTypeDisplayName(componentType)}</span>),
      children: renderScrollablePane(
        <SystemComponentSummary
          dataType={getDataTypeDisplayName(componentType)}
          batchCount={tab.batchCount}
          dataRows={loadedFactories.flatMap((factory) => factory.rows || [])}
          dataColumns={tab.dataColumns}
          isLoaded={isLoaded}
          neighborhoodName={REFERENCE_DATA_NEIGHBORHOOD_NAME}
          readOnly={readOnly}
          onDeleteAllComponents={() => handleDeleteDataComponentType(
            componentType,
            tab.dataTypeValues.length ? tab.dataTypeValues : [tab.dataType],
          )}
          deleteLoading={deleteComponentTypeLoading === componentType}
        />,
      ),
    };
  }), [
    dataFactoriesByType,
    dataTabLabel,
    deleteComponentTypeLoading,
    getDataTypeDisplayName,
    handleDeleteDataComponentType,
    readOnly,
    renderScrollablePane,
    visibleDataTabs,
  ]);

  const sortedNeighborhoodTabItems = useMemo(() => {
    return [...neighborhoodTabs].sort((left, right) => {
      const leftIndex = neighborhoodTabOrder.indexOf(left.name);
      const rightIndex = neighborhoodTabOrder.indexOf(right.name);
      const safeLeft = leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex;
      const safeRight = rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex;
      return safeLeft - safeRight;
    });
  }, [neighborhoodTabOrder, neighborhoodTabs]);

  const neighborhoodTabItems = useMemo(() => sortedNeighborhoodTabItems.map((neighborhood) => ({
    key: neighborhood.name,
    label: neighborhoodTabLabel(neighborhood.name, neighborhood.name),
    children: (
      <div className="flex h-full min-h-0 flex-col">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '1px solid #dbe3ec', background: '#f8fafc' }}>
          <div>
            <Space size="small">
              <NeighborhoodFactory
                canManageFactories={canEditFactories}
                fixedNeighborhoodName={neighborhood.name}
                onNeighborhoodsChanged={() => refreshNeighborhoodModelData(neighborhood.name)}
                onNeighborhoodCreated={(name) => {
                  setActiveOuterTab('neighborhoods');
                  setActiveNeighborhoodTab(name);
                }}
                onNeighborhoodDeleted={(name) => {
                  setNeighborhoodFactories((current) => {
                    if (!current[name]) return current;
                    const next = { ...current };
                    delete next[name];
                    return next;
                  });
                  setActiveModelComponentTabs((current) => {
                    if (!current[name]) return current;
                    const next = { ...current };
                    delete next[name];
                    return next;
                  });
                  setActiveFactoryTabs((current) => {
                    if (!current[name]) return current;
                    const next = { ...current };
                    delete next[name];
                    return next;
                  });
                  setActiveNeighborhoodTab((current) => {
                    if (current !== name) return current;
                    const remaining = neighborhoodTabs
                      .map((tab) => tab.name)
                      .filter((tabName) => tabName !== name);
                    return remaining[0] || '';
                  });
                  setActiveOuterTab('neighborhoods');
                }}
                showCreateNeighborhood={false}
                mode="action"
              />
            </Space>
          </div>
          <div style={{ marginLeft: 'auto' }}>
            <Button
              size="small"
              type="primary"
              icon={<UploadOutlined />}
              onClick={() => handleImportModelBpmn(neighborhood.name)}
              className="framework-toolbar-btn"
            >
              Bulk Import BPMN 2.0 XML
            </Button>
          </div>
        </div>
        <Tabs
          className="factory-tabs model-factory-tabs"
          defaultActiveKey={getModelCatalogTabKey(neighborhood.name)}
          activeKey={(() => {
            const modelCatalogTabKey = getModelCatalogTabKey(neighborhood.name);
            const modelComponentsTabKey = getModelComponentsTabKey(neighborhood.name);
            const currentModelTab = activeFactoryTabs[neighborhood.name];
            if (currentModelTab === modelCatalogTabKey || currentModelTab === modelComponentsTabKey) {
              return currentModelTab;
            }
            return modelCatalogTabKey;
          })()}
          onChange={(key) => {
            setActiveFactoryTabs((current) => ({ ...current, [neighborhood.name]: key }));
          }}
          destroyInactiveTabPane
          items={[
            {
              key: getModelCatalogTabKey(neighborhood.name),
              label: fTabLabel(getModelCatalogTabKey(neighborhood.name), <><DatabaseOutlined /> Model</>),
              children: renderScrollablePane(
                <ModelCatalog
                  modelName={neighborhood.name}
                  requestedSearch={modelCatalogSearchRequest[neighborhood.name] || null}
                />,
              ),
            },
            {
              key: getModelComponentsTabKey(neighborhood.name),
              label: fTabLabel(getModelComponentsTabKey(neighborhood.name), <><AppstoreOutlined /> Model Components</>),
              children: renderScrollablePane(
                <ComponentsViewer
                  neighborhoodName={neighborhood.name}
                  availableComponentIds={(neighborhoodFactories[neighborhood.name] || []).map((f) => f._id)}
                  onComponentTabSelect={(componentId, componentName) => {
                    setActiveModelComponentTabs((current) => ({ ...current, [neighborhood.name]: componentId }));
                  }}
                  onApplicationLinkClick={(applicationName, correlationId, rowSearchText) => {
                    if (!correlationId) return;
                    const applicationSearch = encodeExactFactorySearch(`correlation_id:${correlationId}`);
                    setFactorySearch((current) => ({
                      ...current,
                      applications: applicationSearch,
                    }));
                    setActiveOuterTab('data');
                    setActiveDataTab('applications');
                    setRequestedApplicationDetail({ correlationId, nonce: Date.now() });
                  }}
                  renderComponentContent={(componentId, componentName, highlightedRowName) => {
                    const factoryComponent = (neighborhoodFactories[neighborhood.name] || []).find((f) => f._id === componentId);
                    if (!factoryComponent) return <div>Component not found</div>;

                    return (
                      <NeighborhoodFactory
                        canManageFactories={canEditFactories}
                        fixedNeighborhoodName={neighborhood.name}
                        fixedFactoryId={componentId}
                        defaultRowSearch={highlightedRowName || factorySearch[componentId]}
                        defaultRowSearchColumn="name"
                        hideFactoryList
                        onNeighborhoodsChanged={loadNeighborhoodTabs}
                        onFactoryDeleted={() => loadNeighborhoodFactoriesFor(neighborhood.name)}
                        onApplicationLinkClick={(applicationName, correlationId, rowSearchText) => {
                          if (!correlationId) return;
                          const applicationSearch = encodeExactFactorySearch(`correlation_id:${correlationId}`);
                          setFactorySearch((current) => ({
                            ...current,
                            applications: applicationSearch,
                          }));
                          setActiveOuterTab('data');
                          setActiveDataTab('applications');
                          setRequestedApplicationDetail({ correlationId, nonce: Date.now() });
                        }}
                      />
                    );
                  }}
                />,
              ),
            },
          ]}
        />
      </div>
    ),
  })), [
    activeFactoryTabs,
    canEditFactories,
    DEFAULT_NEIGHBORHOOD_NAME,
    fTabLabel,
    factorySearch,
    getModelCatalogTabKey,
    getModelComponentsTabKey,
    handleImportModelBpmn,
    loadNeighborhoodFactoriesFor,
    loadNeighborhoodTabs,
    modelCatalogSearchRequest,
    neighborhoodFactories,
    neighborhoodTabLabel,
    neighborhoodTabs,
    refreshNeighborhoodModelData,
    setActiveDataTab,
    setActiveFactoryTabs,
    setActiveModelComponentTabs,
    setActiveNeighborhoodTab,
    setActiveOuterTab,
    setFactorySearch,
    setRequestedApplicationDetail,
    sortedNeighborhoodTabItems,
  ]);

  return (
    <Layout className="h-screen overflow-hidden" style={{ height: 'var(--app-h)' }}>
      {/* Hidden file input for local upload */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".bpmn,.xml"
        onChange={handleFileSelected}
        className="hidden"
      />
      <input
        ref={modelBatchInputRef}
        type="file"
        accept=".bpmn,.xml"
        multiple
        onChange={handleModelBatchFilesSelected}
        className="hidden"
      />

      {/* ─── Header ─────────────────────────────────────── */}
      <Header className="app-header">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Title level={4} className="!text-white !m-0 !font-semibold tracking-tight">
              BPMN IQ
            </Title>
            <span className="version-badge">2.0</span>
          </div>
          {(activeDiagram || activeFileName) && (
            <div className="flex items-center gap-2 ml-2 pl-4 border-l border-gray-600">
              {activeDiagram ? (
                <DatabaseOutlined className="text-blue-400 text-xs" />
              ) : (
                <FolderOpenOutlined className="text-green-400 text-xs" />
              )}
              {editingName && activeDiagram ? (
                <Input
                  size="small"
                  autoFocus
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  onPressEnter={() => handleRenameDiagram(nameInput)}
                  onBlur={() => handleRenameDiagram(nameInput)}
                  style={{ width: 200 }}
                  className="!bg-gray-700 !text-white !border-blue-400"
                />
              ) : (
                <Text
                  className="!text-gray-300 text-sm cursor-pointer hover:!text-white"
                  onClick={() => {
                    if (activeDiagram && !readOnly) {
                      if (!canEditCurrentDiagramName) return;
                      setNameInput(activeDiagram.name);
                      setEditingName(true);
                    }
                  }}
                  title={activeDiagram && canEditCurrentDiagramName ? 'Click to rename' : activeDiagram && !readOnly ? 'Set status to Draft to rename' : undefined}
                >
                  {activeDiagram?.name || activeFileName}
                </Text>
              )}
              {isDirty && <span className="dirty-indicator" />}
            </div>
          )}
        </div>

        {/* Toolbar */}
        <Space size={4} className="toolbar-actions">
          <div className="toolbar-divider" />

          <Tooltip title="Search all components">
            <Button type="text" icon={<SearchOutlined />} onClick={() => setShowGlobalComponentSearch(true)} className="toolbar-btn" size="small" />
          </Tooltip>

          <Tooltip title={`Signed in as ${user.userId}`}>
            <span className="text-gray-400 text-xs mr-1"><UserOutlined /> {user.userId}</span>
          </Tooltip>
          {hasAdminAccess && (
            <Tooltip title="User Administration">
              <Button type="text" icon={<SettingOutlined />} onClick={() => setShowAdmin(true)} className="toolbar-btn" size="small" />
            </Tooltip>
          )}
          <Tooltip title="Sign out">
            <Button type="text" icon={<LogoutOutlined />} onClick={onLogout} className="toolbar-btn" size="small" />
          </Tooltip>
        </Space>
      </Header>

      <Layout className="flex-1 overflow-hidden">
        {/* ─── BPMN Canvas (takes all space, toolbox on left edge) ─── */}
        <Content className="bpmn-content">
          <Tabs
            activeKey={activeOuterTab}
            onChange={handleOuterTabChange}
            type="card"
            size="small"
            className="factory-tabs"
            destroyInactiveTabPane
            renderTabBar={(props, DefaultBar) => (
              <div ref={tabNavWrapRef} style={{ background: '#f1f5f9', borderBottom: '1px solid #d1d9e0' }}>
                <DefaultBar {...props} />
              </div>
            )}
            items={[
              {
                key: 'analytics',
                label: outerTabLabel('analytics', <span><DashboardOutlined /> Analytics</span>),
                children: (
                  <Tabs
                    className="factory-tabs"
                    activeKey={activeAnalyticsModel}
                    onChange={setActiveAnalyticsModel}
                    items={analyticsModelTabItems}
                  />
                ),
              },
              {
                key: 'valueStreams',
                label: outerTabLabel('valueStreams', <span><BranchesOutlined /> Value Streams/Journeys</span>),
                children: (
                  <Tabs
                    className="factory-tabs"
                    activeKey={activeValueStreamsModel}
                    onChange={setActiveValueStreamsModel}
                    items={valueStreamModelTabItems}
                  />
                ),
              },
              {
                key: 'bpmn',
                label: outerTabLabel('bpmn', <span><PartitionOutlined /> Diagrams</span>),
                children: (
                  <div className="flex h-full w-full min-h-0">
                    <div className="bpmn-ribbon w-[92px] shrink-0 px-2 py-3 overflow-y-auto">
                      <div className="flex flex-col gap-3">
                        {getBpmnRibbonGroups().map((group) => (
                          <div key={group.key} className="bpmn-ribbon-group px-2 py-2">
                            <div className="bpmn-ribbon-title mb-2 text-center text-[10px] font-semibold uppercase tracking-[0.14em]">{group.title}</div>
                            <div className="flex flex-col items-center gap-1.5">
                              {group.actions.map((action) => (
                                <Tooltip key={action.key} title={action.tooltip} placement="right">
                                      <Button
                                        type={(action as any).type ?? 'text'}
                                        icon={action.icon}
                                        onClick={action.onClick}
                                        disabled={(action as any).disabled}
                                        className="bpmn-ribbon-btn flex h-9 w-9 items-center justify-center rounded-lg border-0"
                                      />
                                </Tooltip>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="flex-1 min-h-0 min-w-0 relative">
                      <div className="flex h-full min-h-0">
                        <div className="w-1/2 min-w-[360px] max-w-[620px] min-h-0">
                          <DiagramBrowser
                            frameworks={neighborhoodTabs}
                            selectedDiagramIds={selectedDiagramIds}
                            externalFilterRequest={diagramBrowserFilterRequest}
                            onToggleDiagram={async (id, neighborhoodName) => {
                              if (neighborhoodName) {
                                setApiNeighborhoodScope(neighborhoodName);
                              }
                              const selected = await getDiagram(id);
                              if ((selected as any).neighborhoodName) {
                                setApiNeighborhoodScope((selected as any).neighborhoodName);
                              }
                              await toggleCanvasDiagram(id, (selected as any).neighborhoodName || neighborhoodName);
                            }}
                          />
                        </div>
                        <div className="min-h-0 min-w-0 flex-1">
                          <BpmnEditor
                            ref={editorRef}
                            xml={currentXml}
                            importTrigger={importTrigger}
                            onXmlChange={handleXmlChange}
                            onDirty={handleEditorDirty}
                            allApplicationNames={allAppNames}
                            allApplications={allApplications}
                            allBusinessFlowNames={allBusinessFlowNames}
                            allTaskNames={allTaskNames}
                            allActorNames={allActorNames}
                            diagramName={activeDiagram?.name || canvasDiagramName || diagramMeta.businessFlow || activeFileName?.replace(/\.bpmn$/i, '') || undefined}
                            diagramStatus={activeDiagram?.status || null}
                            diagramBreadcrumb={(() => {
                              const parts = [
                                diagramMeta.lineOfBusiness,
                                diagramMeta.channel,
                                diagramMeta.product,
                                diagramMeta.domain,
                                diagramMeta.subdomain,
                                diagramMeta.businessFlow,
                              ].filter(Boolean);
                              return parts.length > 1 ? parts.join(' | ') : undefined;
                            })()}
                            canEditDiagramName={canEditCurrentDiagramName}
                            isInFactory={activeDiagram?.source === 'db'}
                            isAlreadyLoaded={activeDiagram?.source === 'local-match'}
                            readOnly={readOnly}
                            onNavigateToFactory={handleNavigateToFactory}
                            onTaskSelect={(task) => {
                              setSelectedDiagramTask(task);
                              setSelectedCapability(null);
                            }}
                            selectedCapability={selectedCapability}
                            isCapabilityAssigned={!!selectedCapability && selectedCaps.some((c) => c.capabilityId === selectedCapability.capabilityId)}
                            onCapabilityAssignToggle={handleCapabilityAssignToggle}
                            onCapabilityViewInCatalog={handleViewCapabilityInCatalog}
                            onCapabilityBack={() => setSelectedCapability(null)}
                            onAddToFactory={() => setShowSaveDb(true)}
                            onDeleteAndReload={async () => {
                          if (!activeDiagram?._id) return;
                          try {
                            await deleteDiagram(activeDiagram._id);
                            const xml = await editorRef.current?.getXml() || currentXmlRef.current;
                            const meta = extractDiagramMetadata(xml);
                            const diagramName = meta.businessFlow || activeDiagram.name;
                            const created = await createDiagram({ name: diagramName, xml, status: 'staged', createdBy: user.userId });
                            setActiveDiagram({ _id: created._id, name: created.name, description: created.description || '', tags: created.tags || [], status: created.status, source: 'db' });
                            refresh();
                            message.success(`Replaced: ${created.name}`);
                          } catch (err: any) { message.error(err.message); }
                        }}
                        onSaveAsNew={async (newName: string) => {
                          try {
                            const xml = await editorRef.current?.getXml() || currentXmlRef.current;
                            const created = await createDiagram({ name: newName, xml, status: 'draft', createdBy: user.userId });
                            setActiveDiagram({ _id: created._id, name: created.name, description: created.description || '', tags: created.tags || [], status: created.status, source: 'db' });
                            refresh();
                            message.success(`Saved as new: ${created.name}`);
                          } catch (err: any) { message.error(err.message); }
                        }}
                        onNewDiagram={handleNew}
                        onDiagramNameChange={async (name) => {
                          const trimmed = name.trim();
                          if (!trimmed) return;
                          if (activeDiagram?._id) {
                            await handleRenameDiagram(trimmed);
                            return;
                          }
                          setCanvasDiagramName(trimmed);
                          try {
                            const flowMap = await getBusinessFlowMap();
                            const existingId = flowMap[trimmed];
                            if (existingId) {
                              setActiveDiagram({ _id: existingId, name: trimmed, description: '', tags: [], source: 'local-match' });
                            } else {
                              setActiveDiagram(null);
                            }
                          } catch {
                            setActiveDiagram(null);
                          }
                        }}
                      />
                    </div>
                  </div>
                    </div>
                  </div>
                ),
              },
              {
                key: 'data',
                label: outerTabLabel('data', <span><DatabaseOutlined /> System Components</span>),
                children: (
                  <SystemComponentsPane
                    neighborhoodName={REFERENCE_DATA_NEIGHBORHOOD_NAME}
                    readOnly={readOnly}
                    visibleDataTabsLength={visibleDataTabs.length}
                    activeDataTab={activeDataTab}
                    dataTabItems={dataTabItems}
                    onActiveDataTabChange={handleActiveDataTabChange}
                    onUploaded={handleSystemComponentsUploaded}
                  />
                ),
              },
              {
                key: 'neighborhoods',
                label: outerTabLabel('neighborhoods', <span><ShoppingOutlined /> Frameworks</span>),
                children: loadingNeighborhoodTabs ? (
                  <div className="flex min-h-[240px] items-center justify-center">
                    <Spin size="large" tip="Loading models..." />
                  </div>
                ) : (
                  <div className="flex h-full min-h-0 flex-col">
                    <div style={{ display: 'flex', justifyContent: 'flex-start', padding: '12px 16px', borderBottom: '1px solid #dbe3ec', background: '#f8fafc' }}>
                      <NeighborhoodFactory
                        canManageFactories={canEditFactories}
                        onNeighborhoodsChanged={loadNeighborhoodTabs}
                        onNeighborhoodCreated={(name) => {
                          setActiveOuterTab('neighborhoods');
                          setActiveNeighborhoodTab(name);
                        }}
                        showAddFactory={false}
                        showDeleteNeighborhood={false}
                        mode="action"
                      />
                    </div>
                    <Tabs
                      className="neighborhood-tabs"
                      activeKey={activeNeighborhoodTab}
                      onChange={setActiveNeighborhoodTab}
                      destroyInactiveTabPane
                      items={neighborhoodTabItems}
                    />
                  </div>
                ),
              },
            ].sort((a, b) => outerTabOrder.indexOf(a.key) - outerTabOrder.indexOf(b.key))}
          />
        </Content>

        {/* ─── Right Sidebar ──────────────────────────────── */}
        <Sider
          width={rightCollapsed ? 0 : rightWidth}
          className="sidebar-panel"
          collapsedWidth={0}
          collapsed={rightCollapsed}
          trigger={null}
          style={{ position: 'relative', transition: rightResizing.current ? 'none' : 'width 0.2s' }}
        >
          {/* Resize handle */}
          {!rightCollapsed && (
            <div
              style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, cursor: 'col-resize', zIndex: 10 }}
              onMouseDown={(e) => {
                e.preventDefault();
                rightResizing.current = true;
                rightStartX.current = e.clientX;
                rightStartW.current = rightWidth;
                const onMove = (ev: MouseEvent) => {
                  const delta = rightStartX.current - ev.clientX;
                  const newW = Math.max(200, Math.min(600, rightStartW.current + delta));
                  setRightWidth(newW);
                };
                const onUp = () => {
                  rightResizing.current = false;
                  document.removeEventListener('mousemove', onMove);
                  document.removeEventListener('mouseup', onUp);
                };
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
              }}
            />
          )}
          <div className="flex flex-col h-full overflow-hidden">
            <div className="flex justify-end p-1">
              <Button
                size="small"
                type="text"
                icon={<RightOutlined />}
                onClick={() => setRightCollapsed(true)}
                title="Collapse sidebar"
              />
            </div>
            {selectedValueStreamEntity && (
              <Card
                size="small"
                className="sidebar-card !mt-3"
                title={
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <ThunderboltOutlined className="text-sky-600" /> Selected {selectedValueStreamEntity.flowMode === 'journey' ? 'Journey' : 'Value Stream'} Item
                  </span>
                }
                extra={
                  <Button size="small" type="link" onClick={handleOpenCapabilityDiagrams}>
                    Open in Diagrams
                  </Button>
                }
              >
                <Spin spinning={selectedValueStreamEntityLoading}>
                  <div className="flex flex-col gap-3 text-xs text-slate-700">
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                        {selectedValueStreamEntity.type === 'businessCapability'
                          ? 'Business Capability'
                          : selectedValueStreamEntity.type === 'valueStream'
                            ? (selectedValueStreamEntity.flowMode === 'journey' ? 'Journey' : 'Value Stream')
                            : selectedValueStreamEntity.type === 'rollup'
                              ? 'Domain / Subdomain'
                              : selectedValueStreamEntity.type === 'domain'
                                ? 'Domain'
                                : 'Subdomain'}
                      </div>
                      <div className="mt-1 text-sm font-semibold text-slate-900">{selectedValueStreamEntity.title}</div>
                    </div>
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Model</div>
                      <div className="mt-1">{selectedValueStreamEntity.neighborhoodName}</div>
                    </div>
                    {selectedValueStreamEntity.valueStreamName ? (
                      <div>
                        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{selectedValueStreamEntity.flowMode === 'journey' ? 'Journey' : 'Value Stream'}</div>
                        <div className="mt-1">{selectedValueStreamEntity.valueStreamName}</div>
                      </div>
                    ) : null}
                    {selectedValueStreamEntity.type === 'domain' ? (
                      <div>
                        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Subdomains</div>
                        <div className="mt-1">{selectedValueStreamEntity.secondaryCountLabel}</div>
                      </div>
                    ) : selectedValueStreamEntity.type === 'subdomain' ? (
                      <div>
                        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Business Flows</div>
                        <div className="mt-1">{selectedValueStreamEntity.domain}</div>
                      </div>
                    ) : (
                      <div>
                        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Domain / Subdomain</div>
                        <div className="mt-1">{selectedValueStreamEntity.domain} | {selectedValueStreamEntity.subdomain}</div>
                      </div>
                    )}
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                        {selectedValueStreamEntity.type === 'rollup' ? 'Related Diagrams' : 'Supporting Diagrams'}
                      </div>
                      <div className="mt-1">{selectedValueStreamEntity.relationshipCount}</div>
                    </div>
                    {selectedValueStreamEntity.secondaryCountLabel ? (
                      <div>
                        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Summary</div>
                        <div className="mt-1">{selectedValueStreamEntity.secondaryCountLabel}</div>
                      </div>
                    ) : null}
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Metadata</div>
                      {selectedValueStreamEntity.metadata.length ? (
                        <div className="mt-2 max-h-72 overflow-y-auto rounded border border-slate-200 bg-slate-50">
                          {selectedValueStreamEntity.metadata.map((entry) => (
                            <div key={entry.label} className="border-b border-slate-200 px-3 py-2 last:border-b-0">
                              <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{entry.label}</div>
                              <div className="mt-1 break-words text-slate-800">{entry.value}</div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="mt-1 text-slate-500">No metadata found for this selected item.</div>
                      )}
                    </div>
                  </div>
                </Spin>
              </Card>
            )}
          </div>
        </Sider>
        {rightCollapsed && (
          <div style={{ display: 'flex', alignItems: 'flex-start', paddingTop: 8 }}>
            <Button
              size="small"
              type="text"
              icon={<LeftOutlined />}
              onClick={() => setRightCollapsed(false)}
              title="Expand sidebar"
            />
          </div>
        )}
      </Layout>
      {/* ─── Modals ───────────────────────────────────────── */}
      <SaveModal
        open={showSaveDb}
        onClose={() => setShowSaveDb(false)}
        isUpdate={!!activeDiagram?._id}
        defaultChangeNote={activeDiagram?._id ? generateChangeNote(savedXmlRef.current, currentXmlRef.current, savedCapsRef.current, selectedCapsRef.current) : undefined}
        onSave={handleSaveDb}
      />
      {/* Fuzzy Match Modals */}
      <AppMatchModal
        open={showAppMatch}
        matches={appMatchResults}
        title="Application Name Matching"
        onApprove={handleAppMatchApprove}
        onClose={() => setShowAppMatch(false)}
      />
      <AppMatchModal
        open={showTaskMatch}
        matches={taskMatchResults}
        title="Task Name Matching"
        onApprove={handleTaskMatchApprove}
        onClose={() => setShowTaskMatch(false)}
      />

      {/* New Diagram Name Prompt */}
      <Modal
        title="New Diagram"
        open={showNewDiagramPrompt}
        onOk={() => {
          const val = (document.getElementById('new-diagram-name-input') as HTMLInputElement)?.value?.trim();
          if (val) handleNewDiagramConfirm(val);
        }}
        onCancel={() => setShowNewDiagramPrompt(false)}
        okText="Create"
        destroyOnClose
      >
        <div className="mt-4">
          <label className="block text-sm font-medium text-gray-700 mb-1">Diagram Name <span className="text-red-500">*</span></label>
          <Input
            id="new-diagram-name-input"
            placeholder="Enter diagram name"
            autoFocus
            onPressEnter={(e) => {
              const val = (e.target as HTMLInputElement).value.trim();
              if (val) handleNewDiagramConfirm(val);
            }}
          />
          <div className="text-xs text-gray-500 mt-1">This name will appear as the diagram title on the canvas.</div>
        </div>
      </Modal>

      {hasAdminAccess && <AdminPanel open={showAdmin} onClose={() => setShowAdmin(false)} />}
      <GlobalComponentSearch
        open={showGlobalComponentSearch}
        neighborhoodName={activeNeighborhoodTab}
        onClose={() => setShowGlobalComponentSearch(false)}
        onRowClick={(componentId, rowId, searchTerm, componentName) => {
          // Navigate to the component factory with the search term
          if (componentName && searchTerm) {
            handleNavigateToFactory(componentName, searchTerm);
          }
          // Close the modal after navigation
          setShowGlobalComponentSearch(false);
        }}
      />

    </Layout>
  );
}
