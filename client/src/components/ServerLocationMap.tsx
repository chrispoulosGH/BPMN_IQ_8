import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, Checkbox, Col, Descriptions, Divider, Empty, Row, Select, Spin, Statistic, Tag, Typography } from 'antd';
import Plot from 'react-plotly.js';

import { getDashboardServerLocationPoints, getServer } from '../api';
import type { ServerItem } from '../types';

interface RawServerPoint {
  _id: string;
  name: string;
  hostName?: string | null;
  ipAddress?: string | null;
  location?: string | null;
  environment?: string | null;
  operationalStatus?: string | null;
  internetFacing?: string | null;
  healthNotes?: Array<{ label: string; severity?: string | null }>;
  linkedApplications?: Array<{
    correlationId?: string | null;
    name?: string | null;
    acronym?: string | null;
  }>;
}

interface GeocodedServerPoint extends RawServerPoint {
  lat: number;
  lon: number;
  locationLabel: string;
}

interface PlotServerPoint extends GeocodedServerPoint {
  plotLat: number;
  plotLon: number;
  overlapCount: number;
}

interface LocationCluster {
  key: string;
  label: string;
  count: number;
  centerLat: number;
  centerLon: number;
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

// Server dots are color-coded by their worst health-note severity, not by
// which specific label caused it — a 4-step vulnerability scale (green/
// yellow/orange/red) rather than the old one-color-per-label scheme, so the
// map reads at a glance regardless of how many different note types exist.
// 'critical' and 'high' are deliberately both red: 4 colors were asked for,
// and "high-severity vulnerabilities" is exactly the kind of thing that
// belongs at the top of the scale alongside 'critical'.
const VULNERABILITY_SEVERITY_COLORS: Record<string, string> = {
  none: '#22c55e', // green  — no known vulnerabilities
  low: '#eab308', // yellow
  medium: '#f97316', // orange
  high: '#ef4444', // red
};

const SEVERITY_PRIORITY = ['critical', 'high', 'medium', 'low', 'info'] as const;

// Collapses the schema's 5-level severity enum (info/low/medium/high/critical)
// down to the 4 colors requested — 'critical' rolls into the same 'high' (red)
// bucket as 'high' itself.
function colorSeverityBucket(severity: string): 'high' | 'medium' | 'low' | 'none' {
  if (severity === 'critical' || severity === 'high') return 'high';
  if (severity === 'medium') return 'medium';
  if (severity === 'low') return 'low';
  return 'none';
}

const OVERLAY_OPTIONS = [
  { label: 'Density Heat', value: 'density' },
  { label: 'High Risk Halo', value: 'riskHalo' },
];

const STATE_CENTROIDS: Record<string, { lat: number; lon: number }> = {
  AL: { lat: 32.7794, lon: -86.8287 }, AK: { lat: 64.0685, lon: -152.2782 }, AZ: { lat: 34.2744, lon: -111.6602 },
  AR: { lat: 34.8938, lon: -92.4426 }, CA: { lat: 36.7783, lon: -119.4179 }, CO: { lat: 39.5501, lon: -105.7821 },
  CT: { lat: 41.6032, lon: -73.0877 }, DE: { lat: 38.9108, lon: -75.5277 }, FL: { lat: 27.6648, lon: -81.5158 },
  GA: { lat: 32.1656, lon: -82.9001 }, HI: { lat: 19.8968, lon: -155.5828 }, ID: { lat: 44.0682, lon: -114.742 },
  IL: { lat: 40.6331, lon: -89.3985 }, IN: { lat: 40.2672, lon: -86.1349 }, IA: { lat: 41.878, lon: -93.0977 },
  KS: { lat: 39.0119, lon: -98.4842 }, KY: { lat: 37.8393, lon: -84.27 }, LA: { lat: 30.9843, lon: -91.9623 },
  ME: { lat: 45.2538, lon: -69.4455 }, MD: { lat: 39.0458, lon: -76.6413 }, MA: { lat: 42.4072, lon: -71.3824 },
  MI: { lat: 44.3148, lon: -85.6024 }, MN: { lat: 46.7296, lon: -94.6859 }, MS: { lat: 32.3547, lon: -89.3985 },
  MO: { lat: 37.9643, lon: -91.8318 }, MT: { lat: 46.8797, lon: -110.3626 }, NE: { lat: 41.4925, lon: -99.9018 },
  NV: { lat: 38.8026, lon: -116.4194 }, NH: { lat: 43.1939, lon: -71.5724 }, NJ: { lat: 40.0583, lon: -74.4057 },
  NM: { lat: 34.5199, lon: -105.8701 }, NY: { lat: 43.2994, lon: -74.2179 }, NC: { lat: 35.7596, lon: -79.0193 },
  ND: { lat: 47.5515, lon: -101.002 }, OH: { lat: 40.4173, lon: -82.9071 }, OK: { lat: 35.0078, lon: -97.0929 },
  OR: { lat: 43.8041, lon: -120.5542 }, PA: { lat: 41.2033, lon: -77.1945 }, RI: { lat: 41.5801, lon: -71.4774 },
  SC: { lat: 33.8361, lon: -81.1637 }, SD: { lat: 43.9695, lon: -99.9018 }, TN: { lat: 35.5175, lon: -86.5804 },
  TX: { lat: 31.9686, lon: -99.9018 }, UT: { lat: 39.321, lon: -111.0937 }, VT: { lat: 44.5588, lon: -72.5778 },
  VA: { lat: 37.4316, lon: -78.6569 }, WA: { lat: 47.7511, lon: -120.7401 }, WV: { lat: 38.5976, lon: -80.4549 },
  WI: { lat: 43.7844, lon: -88.7879 }, WY: { lat: 43.0759, lon: -107.2903 }, DC: { lat: 38.9072, lon: -77.0369 },
};

const STATE_NAMES_TO_CODE: Record<string, string> = {
  ALABAMA: 'AL', ALASKA: 'AK', ARIZONA: 'AZ', ARKANSAS: 'AR', CALIFORNIA: 'CA', COLORADO: 'CO', CONNECTICUT: 'CT',
  DELAWARE: 'DE', FLORIDA: 'FL', GEORGIA: 'GA', HAWAII: 'HI', IDAHO: 'ID', ILLINOIS: 'IL', INDIANA: 'IN', IOWA: 'IA',
  KANSAS: 'KS', KENTUCKY: 'KY', LOUISIANA: 'LA', MAINE: 'ME', MARYLAND: 'MD', MASSACHUSETTS: 'MA', MICHIGAN: 'MI',
  MINNESOTA: 'MN', MISSISSIPPI: 'MS', MISSOURI: 'MO', MONTANA: 'MT', NEBRASKA: 'NE', NEVADA: 'NV', 'NEW HAMPSHIRE': 'NH',
  'NEW JERSEY': 'NJ', 'NEW MEXICO': 'NM', 'NEW YORK': 'NY', 'NORTH CAROLINA': 'NC', 'NORTH DAKOTA': 'ND', OHIO: 'OH',
  OKLAHOMA: 'OK', OREGON: 'OR', PENNSYLVANIA: 'PA', 'RHODE ISLAND': 'RI', 'SOUTH CAROLINA': 'SC', 'SOUTH DAKOTA': 'SD',
  TENNESSEE: 'TN', TEXAS: 'TX', UTAH: 'UT', VERMONT: 'VT', VIRGINIA: 'VA', WASHINGTON: 'WA', 'WEST VIRGINIA': 'WV',
  WISCONSIN: 'WI', WYOMING: 'WY', 'DISTRICT OF COLUMBIA': 'DC',
};

export const CITY_COORDS: Record<string, { lat: number; lon: number }> = {
  'NEW YORK': { lat: 40.7128, lon: -74.006 }, 'LOS ANGELES': { lat: 34.0522, lon: -118.2437 },
  CHICAGO: { lat: 41.8781, lon: -87.6298 }, HOUSTON: { lat: 29.7604, lon: -95.3698 },
  PHOENIX: { lat: 33.4484, lon: -112.074 }, DALLAS: { lat: 32.7767, lon: -96.797 },
  ATLANTA: { lat: 33.749, lon: -84.388 }, MIAMI: { lat: 25.7617, lon: -80.1918 },
  SEATTLE: { lat: 47.6062, lon: -122.3321 }, BOSTON: { lat: 42.3601, lon: -71.0589 },
  DENVER: { lat: 39.7392, lon: -104.9903 }, AUSTIN: { lat: 30.2672, lon: -97.7431 },
  NASHVILLE: { lat: 36.1627, lon: -86.7816 }, CHARLOTTE: { lat: 35.2271, lon: -80.8431 },
  DETROIT: { lat: 42.3314, lon: -83.0458 }, COLUMBUS: { lat: 39.9612, lon: -82.9988 },
  PORTLAND: { lat: 45.5152, lon: -122.6784 }, 'SAN FRANCISCO': { lat: 37.7749, lon: -122.4194 },
  'SAN DIEGO': { lat: 32.7157, lon: -117.1611 }, 'SAN JOSE': { lat: 37.3382, lon: -121.8863 },
  PHILADELPHIA: { lat: 39.9526, lon: -75.1652 }, MINNEAPOLIS: { lat: 44.9778, lon: -93.265 },
  'ST LOUIS': { lat: 38.627, lon: -90.1994 }, TAMPA: { lat: 27.9506, lon: -82.4572 },
};

function parseNumericLatLon(location: string): { lat: number; lon: number } | null {
  const match = location.match(/(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/);
  if (!match) return null;
  const lat = Number(match[1]);
  const lon = Number(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < 18 || lat > 72 || lon > -60 || lon < -175) return null;
  return { lat, lon };
}

function inferStateCode(location: string): string | null {
  const upper = location.toUpperCase();
  const codeMatch = upper.match(/\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|IA|ID|IL|IN|KS|KY|LA|MA|MD|ME|MI|MN|MO|MS|MT|NC|ND|NE|NH|NJ|NM|NV|NY|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VA|VT|WA|WI|WV|WY|DC)\b/);
  if (codeMatch) return codeMatch[1];

  for (const [name, code] of Object.entries(STATE_NAMES_TO_CODE)) {
    if (upper.includes(name)) return code;
  }

  return null;
}

export function inferCityCoord(location: string): { lat: number; lon: number } | null {
  const upper = location.toUpperCase();
  for (const [city, coord] of Object.entries(CITY_COORDS)) {
    if (upper.includes(city)) return coord;
  }
  return null;
}

function geocodeServer(point: RawServerPoint): GeocodedServerPoint | null {
  const locationLabel = String(point.location || '').trim();
  if (!locationLabel) return null;

  const numeric = parseNumericLatLon(locationLabel);
  if (numeric) {
    return { ...point, ...numeric, locationLabel };
  }

  const city = inferCityCoord(locationLabel);
  if (city) {
    return { ...point, ...city, locationLabel };
  }

  const stateCode = inferStateCode(locationLabel);
  if (stateCode && STATE_CENTROIDS[stateCode]) {
    return { ...point, ...STATE_CENTROIDS[stateCode], locationLabel };
  }

  return null;
}

function spreadOverlappingPoints(points: GeocodedServerPoint[]): PlotServerPoint[] {
  const byAnchor = new Map<string, GeocodedServerPoint[]>();
  for (const point of points) {
    const key = `${point.lat.toFixed(6)}|${point.lon.toFixed(6)}`;
    if (!byAnchor.has(key)) byAnchor.set(key, []);
    byAnchor.get(key)!.push(point);
  }

  const output: PlotServerPoint[] = [];
  for (const group of byAnchor.values()) {
    if (group.length === 1) {
      const point = group[0];
      output.push({ ...point, plotLat: point.lat, plotLon: point.lon, overlapCount: 1 });
      continue;
    }

    // Sunflower spiral offsets colocated points so each server is visible while preserving geographic context.
    const goldenAngle = 137.508;
    const baseRadiusMeters = 80;
    const growthMeters = 28;

    group.forEach((point, idx) => {
      const angleRad = (idx * goldenAngle * Math.PI) / 180;
      const radiusMeters = baseRadiusMeters + Math.sqrt(idx) * growthMeters;
      const dx = radiusMeters * Math.cos(angleRad);
      const dy = radiusMeters * Math.sin(angleRad);

      const latRad = (point.lat * Math.PI) / 180;
      const metersPerDegLat = 111320;
      const metersPerDegLon = Math.max(111320 * Math.cos(latRad), 1);

      output.push({
        ...point,
        plotLat: point.lat + (dy / metersPerDegLat),
        plotLon: point.lon + (dx / metersPerDegLon),
        overlapCount: group.length,
      });
    });
  }

  return output;
}

function getPrimaryNoteLabel(point: RawServerPoint): string {
  const labels = (point.healthNotes || []).map((note) => String(note.label || '').trim()).filter(Boolean);
  return labels[0] || 'OTHER';
}

/** Worst (highest-priority) health-note severity for a server, defaulting to 'info' (no known vulnerabilities) when it has none. */
function worstSeverityForServer(point: RawServerPoint): string {
  const severities = new Set(
    (point.healthNotes || []).map((note) => String(note.severity || '').trim().toLowerCase()).filter(Boolean)
  );
  for (const level of SEVERITY_PRIORITY) {
    if (severities.has(level)) return level;
  }
  return 'info';
}

function pinColorForServer(point: RawServerPoint): string {
  const bucket = colorSeverityBucket(worstSeverityForServer(point));
  return VULNERABILITY_SEVERITY_COLORS[bucket];
}

function renderServerValue(value: unknown): React.ReactNode {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) {
    if (!value.length) return '—';
    return <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{JSON.stringify(value, null, 2)}</pre>;
  }
  if (typeof value === 'object') {
    return <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{JSON.stringify(value, null, 2)}</pre>;
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function toLabel(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/^./, (ch) => ch.toUpperCase());
}

function isKeyLikeString(value: string): boolean {
  const text = value.trim();
  if (!text) return false;

  const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text);
  const mongoIdLike = /^[0-9a-f]{24}$/i.test(text);
  const longOpaqueToken = /^[A-Za-z0-9_-]{20,}$/i.test(text) && /\d/.test(text) && /[A-Za-z]/.test(text);

  return uuidLike || mongoIdLike || longOpaqueToken;
}

function shouldHidePropertyByValue(value: unknown): boolean {
  if (typeof value === 'string' && isKeyLikeString(value)) return true;
  return false;
}

function normalizeText(value: unknown): string {
  return String(value || '').trim();
}

function applicationKey(app: { correlationId?: string | null; name?: string | null; acronym?: string | null }): string | null {
  const correlationId = normalizeText(app.correlationId);
  if (correlationId) return `cid:${correlationId}`;
  const name = normalizeText(app.name);
  if (name) return `name:${name.toLowerCase()}`;
  const acronym = normalizeText(app.acronym);
  if (acronym) return `acr:${acronym.toLowerCase()}`;
  return null;
}

function applicationLabel(app: { correlationId?: string | null; name?: string | null; acronym?: string | null }): string {
  const name = normalizeText(app.name) || 'Unnamed Application';
  const acronym = normalizeText(app.acronym);
  const correlationId = normalizeText(app.correlationId);
  const parts = [name];
  if (acronym) parts.push(`[${acronym}]`);
  if (correlationId) parts.push(`(${correlationId})`);
  return parts.join(' ');
}

function applicationDropdownLabel(app: { correlationId?: string | null; name?: string | null; acronym?: string | null }): string {
  const acronym = normalizeText(app.acronym);
  if (acronym) return acronym;
  return normalizeText(app.name) || 'Unnamed Application';
}

function estimateFitZoom(cluster: LocationCluster, mapWidth: number, mapHeight: number): number {
  const paddingFactor = 1.35;
  const lonDelta = Math.max(0.01, Math.abs(cluster.maxLon - cluster.minLon));
  const latDelta = Math.max(0.01, Math.abs(cluster.maxLat - cluster.minLat));

  // Approximate mapbox zoom from lat/lon extent and pixel dimensions.
  const zoomLng = Math.log2((mapWidth * 360) / (lonDelta * 256 * paddingFactor));
  const zoomLat = Math.log2((mapHeight * 170) / (latDelta * 256 * paddingFactor));
  const zoom = Math.min(zoomLng, zoomLat);

  if (!Number.isFinite(zoom)) return 8;
  return Math.max(3.1, Math.min(13.5, zoom));
}

// ─── Granularity drill-down ──────────────────────────────────────────────
// Below STATE_TIER_MAX_ZOOM the map shows one bubble per state; between that
// and ANCHOR_TIER_MAX_ZOOM it shows one bubble per unique geocoded location
// (city/coord); at or above ANCHOR_TIER_MAX_ZOOM it shows individual server
// dots (the pre-existing per-server rendering). Clicking a bubble zooms/pans
// into it, crossing the next threshold so the next tier down renders.
const STATE_TIER_MAX_ZOOM = 5;
const ANCHOR_TIER_MAX_ZOOM = 9;

type MapTier = 'state' | 'anchor' | 'individual';

function tierForZoom(zoom: number): MapTier {
  if (zoom < STATE_TIER_MAX_ZOOM) return 'state';
  if (zoom < ANCHOR_TIER_MAX_ZOOM) return 'anchor';
  return 'individual';
}

/** Groups geocoded points by their exact geocoded anchor (lat/lon pair). */
function groupPointsByAnchor(points: GeocodedServerPoint[]): Map<string, GeocodedServerPoint[]> {
  const grouped = new Map<string, GeocodedServerPoint[]>();
  for (const point of points) {
    const key = `${point.lat.toFixed(6)}|${point.lon.toFixed(6)}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(point);
  }
  return grouped;
}

/** Builds one LocationCluster per anchor group with at least minCount servers. */
function clustersFromAnchorGroups(grouped: Map<string, GeocodedServerPoint[]>, minCount: number): LocationCluster[] {
  const clusters: LocationCluster[] = [];
  for (const [key, group] of grouped.entries()) {
    if (group.length < minCount) continue;
    const lats = group.map((g) => g.lat);
    const lons = group.map((g) => g.lon);
    const centerLat = lats.reduce((s, n) => s + n, 0) / lats.length;
    const centerLon = lons.reduce((s, n) => s + n, 0) / lons.length;
    const sampleLabel = group[0].locationLabel || `${centerLat.toFixed(2)}, ${centerLon.toFixed(2)}`;
    clusters.push({
      key,
      label: sampleLabel,
      count: group.length,
      centerLat,
      centerLon,
      minLat: Math.min(...lats),
      maxLat: Math.max(...lats),
      minLon: Math.min(...lons),
      maxLon: Math.max(...lons),
    });
  }
  return clusters.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.label.localeCompare(b.label);
  });
}

/** Best-effort state code for a geocoded point — parses the location text
 * first, falling back to whichever state centroid is geographically nearest
 * (needed for points geocoded from raw numeric lat/lon with no state name). */
function resolveStateCodeForPoint(point: GeocodedServerPoint): string {
  const direct = inferStateCode(point.locationLabel);
  if (direct && STATE_CENTROIDS[direct]) return direct;

  let bestCode = 'DC';
  let bestDistSq = Infinity;
  for (const [code, centroid] of Object.entries(STATE_CENTROIDS)) {
    const dLat = point.lat - centroid.lat;
    const dLon = point.lon - centroid.lon;
    const distSq = dLat * dLat + dLon * dLon;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      bestCode = code;
    }
  }
  return bestCode;
}

function buildStateClusters(points: GeocodedServerPoint[]): LocationCluster[] {
  const grouped = new Map<string, GeocodedServerPoint[]>();
  for (const point of points) {
    const code = resolveStateCodeForPoint(point);
    if (!grouped.has(code)) grouped.set(code, []);
    grouped.get(code)!.push(point);
  }

  const clusters: LocationCluster[] = [];
  for (const [code, group] of grouped.entries()) {
    const lats = group.map((g) => g.lat);
    const lons = group.map((g) => g.lon);
    // Center on the mean position of this state's actual servers, not the
    // state's fixed geographic centroid — for a large state, the shape's
    // center can sit far from where any server actually is (e.g. Texas'
    // centroid is near Abilene, nowhere near a Dallas/Houston/Austin
    // cluster), which would pan a drill-down into empty map with no bubbles.
    clusters.push({
      key: `state:${code}`,
      label: code,
      count: group.length,
      centerLat: lats.reduce((s, n) => s + n, 0) / lats.length,
      centerLon: lons.reduce((s, n) => s + n, 0) / lons.length,
      minLat: Math.min(...lats),
      maxLat: Math.max(...lats),
      minLon: Math.min(...lons),
      maxLon: Math.max(...lons),
    });
  }
  return clusters.sort((a, b) => b.count - a.count);
}

/** Bubble size/color scale with server count — sqrt-scaled area so a 4x
 * larger cluster reads as roughly 2x the visual size, not 4x. */
function clusterBubbleSize(count: number): number {
  return Math.max(20, Math.min(64, 16 + Math.sqrt(count) * 7));
}

function clusterBubbleColor(count: number): string {
  if (count >= 25) return '#1e3a8a';
  if (count >= 8) return '#2563eb';
  return '#60a5fa';
}

// This component fully unmounts (and its ~1,500+ server records get
// re-fetched from the DB) every time the user leaves the Analytics tab and
// comes back, or switches the Segmented control away from "US Server Map"
// and back — same module-level cache pattern as Dashboard.tsx/
// FeatureCost3DChart.tsx, so a revisit within the TTL renders instantly
// instead of re-querying the database.
const SERVER_LOCATION_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
interface ServerLocationCacheEntry {
  rawPoints: RawServerPoint[];
  fetchedAt: number;
}
let serverLocationCache: ServerLocationCacheEntry | null = null;
function freshServerLocationCache(): ServerLocationCacheEntry | null {
  return serverLocationCache && Date.now() - serverLocationCache.fetchedAt < SERVER_LOCATION_CACHE_TTL_MS ? serverLocationCache : null;
}

export default function ServerLocationMap() {
  const [loading, setLoading] = useState(() => !freshServerLocationCache());
  const [rawPoints, setRawPoints] = useState<RawServerPoint[]>(() => freshServerLocationCache()?.rawPoints || []);
  const [zoom, setZoom] = useState(3.1);
  const [center, setCenter] = useState<{ lat: number; lon: number }>({ lat: 38.5, lon: -96.2 });
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
  const [selectedServer, setSelectedServer] = useState<ServerItem | null>(null);
  const [loadingSelected, setLoadingSelected] = useState(false);
  const [overlays, setOverlays] = useState<string[]>(['riskHalo']);
  const [selectedClusterKey, setSelectedClusterKey] = useState<string | null>(null);
  const [selectedApplicationKey, setSelectedApplicationKey] = useState<string | null>(null);
  const [serverSearchTerm, setServerSearchTerm] = useState('');
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const [mapHeight, setMapHeight] = useState<number>(() => {
    if (typeof window === 'undefined') return 620;
    return Math.max(420, Math.min(980, window.innerHeight - 200));
  });

  const fitMapToScreen = () => {
    if (typeof window === 'undefined') return;
    const top = mapContainerRef.current?.getBoundingClientRect().top ?? 180;
    const availableHeight = window.innerHeight - top - 20;
    setMapHeight(Math.max(420, Math.min(1100, Math.floor(availableHeight))));
  };

  // Shared with both the "Jump to cluster" dropdown and drilling into a
  // cluster bubble by clicking it — estimates the map's rendered pixel width
  // so estimateFitZoom can compute a zoom level that actually fits the
  // cluster's extent on screen.
  const estimateMapWidth = () => (typeof window === 'undefined'
    ? 1000
    : Math.max(520, window.innerWidth >= 1280 ? Math.floor(window.innerWidth * 0.64) : window.innerWidth - 40));

  useEffect(() => {
    if (freshServerLocationCache()) {
      // Already applied via the lazy initializers above.
      setLoading(false);
      return;
    }

    setLoading(true);
    getDashboardServerLocationPoints()
      .then((payload) => {
        const points = payload.points || [];
        setRawPoints(points);
        serverLocationCache = { rawPoints: points, fetchedAt: Date.now() };
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selectedServerId) {
      setSelectedServer(null);
      return;
    }

    setLoadingSelected(true);
    getServer(selectedServerId)
      .then((server) => setSelectedServer(server))
      .finally(() => setLoadingSelected(false));
  }, [selectedServerId]);

  useEffect(() => {
    const handleResize = () => {
      fitMapToScreen();
    };

    fitMapToScreen();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const geocodedPoints = useMemo(() => rawPoints.map(geocodeServer).filter(Boolean) as GeocodedServerPoint[], [rawPoints]);
  const anchorGroups = useMemo(() => groupPointsByAnchor(geocodedPoints), [geocodedPoints]);
  // Only anchors with 2+ servers — feeds the "Jump to cluster" dropdown,
  // where a single-server "cluster" wouldn't be a meaningful shortcut.
  const locationClusters = useMemo(() => clustersFromAnchorGroups(anchorGroups, 2), [anchorGroups]);
  // Every anchor, including single-server ones — feeds the map's mid-tier
  // (city/coord-level) bubbles in the granularity drill-down below.
  const anchorClusters = useMemo(() => clustersFromAnchorGroups(anchorGroups, 1), [anchorGroups]);
  // Coarsest tier — one bubble per state, shown at the most zoomed-out level.
  const stateClusters = useMemo(() => buildStateClusters(geocodedPoints), [geocodedPoints]);
  const mapTier = useMemo(() => tierForZoom(zoom), [zoom]);

  const applicationOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const point of geocodedPoints) {
      for (const app of point.linkedApplications || []) {
        const key = applicationKey(app);
        if (!key || seen.has(key)) continue;
        seen.set(key, applicationDropdownLabel(app));
      }
    }

    return [...seen.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [geocodedPoints]);

  const associatedServerIds = useMemo(() => {
    if (!selectedApplicationKey) return new Set<string>();
    const ids = new Set<string>();
    for (const point of geocodedPoints) {
      const hasMatch = (point.linkedApplications || [])
        .map((app) => applicationKey(app))
        .filter(Boolean)
        .includes(selectedApplicationKey);
      if (hasMatch) ids.add(point._id);
    }
    return ids;
  }, [geocodedPoints, selectedApplicationKey]);

  useEffect(() => {
    if (!selectedApplicationKey) return;
    // As requested, keep application highlighting at whole-US context.
    setCenter({ lat: 38.5, lon: -96.2 });
    setZoom(3.1);
    setSelectedClusterKey(null);
  }, [selectedApplicationKey]);
  const plotPoints = useMemo(() => spreadOverlappingPoints(geocodedPoints), [geocodedPoints]);
  const selectedPlotPoint = useMemo(() => {
    if (!selectedServerId) return null;
    return plotPoints.find((point) => point._id === selectedServerId) || null;
  }, [plotPoints, selectedServerId]);

  const serverSearchOptions = useMemo(() => {
    const term = serverSearchTerm.trim().toLowerCase();
    if (!term) {
      return selectedPlotPoint
        ? [{ label: `${selectedPlotPoint.name} • ${selectedPlotPoint.locationLabel}`, value: selectedPlotPoint._id }]
        : [];
    }

    const matches = plotPoints
      .filter((point) => {
        const haystack = [point.name, point.hostName, point.ipAddress, point.locationLabel]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return haystack.includes(term);
      })
      .slice(0, 200)
      .map((point) => ({
        label: `${point.name} • ${point.locationLabel}${point.hostName ? ` • ${point.hostName}` : ''}`,
        value: point._id,
      }));

    if (selectedPlotPoint && !matches.some((item) => item.value === selectedPlotPoint._id)) {
      matches.unshift({
        label: `${selectedPlotPoint.name} • ${selectedPlotPoint.locationLabel}`,
        value: selectedPlotPoint._id,
      });
    }

    return matches;
  }, [plotPoints, serverSearchTerm, selectedPlotPoint]);
  const uniqueAnchorCount = useMemo(() => new Set(geocodedPoints.map((point) => `${point.lat.toFixed(6)}|${point.lon.toFixed(6)}`)).size, [geocodedPoints]);

  const unknownLocationCount = rawPoints.length - geocodedPoints.length;
  const traces: any[] = useMemo(() => {
    const visiblePoints = selectedApplicationKey
      ? plotPoints.filter((point) => associatedServerIds.has(point._id))
      : plotPoints;

    // Granularity drill-down: at the state/anchor tiers, replace the
    // per-server dots entirely with aggregate bubbles (one per state, or one
    // per unique geocoded location) — skipped while an application is
    // highlighted, which keeps its own dedicated whole-US rendering below
    // regardless of zoom (a pre-existing, separate feature).
    if (!selectedApplicationKey && mapTier !== 'individual') {
      const clustersForTier = mapTier === 'state' ? stateClusters : anchorClusters;
      return [{
        type: 'scattermapbox',
        mode: 'markers+text',
        name: mapTier === 'state' ? 'State clusters' : 'Location clusters',
        lat: clustersForTier.map((c) => c.centerLat),
        lon: clustersForTier.map((c) => c.centerLon),
        text: clustersForTier.map((c) => String(c.count)),
        textfont: { color: '#ffffff', size: 11 },
        textposition: 'middle center',
        customdata: clustersForTier.map((c) => ({ clusterKey: c.key, tier: mapTier })),
        hovertemplate: clustersForTier.map((c) => `<b>${c.label}</b><br>${c.count} server${c.count === 1 ? '' : 's'}<br>Click to drill down<extra></extra>`),
        marker: {
          size: clustersForTier.map((c) => clusterBubbleSize(c.count)),
          color: clustersForTier.map((c) => clusterBubbleColor(c.count)),
          opacity: 0.85,
          line: { width: 1.5, color: '#ffffff' },
        },
      }];
    }

    const markerSize = Math.max(7, Math.min(13, 7 + (zoom - 3.1) * 0.7));
    const haloColor = 'rgba(0,0,0,0.38)';

    const customData = visiblePoints.map((point) => ({
      id: point._id,
      name: point.name,
      hostName: point.hostName || '-',
      location: point.locationLabel,
      primaryLabel: getPrimaryNoteLabel(point),
      vulnerabilitySeverity: worstSeverityForServer(point),
      pinColor: pinColorForServer(point),
      overlapCount: point.overlapCount,
      operationalStatus: point.operationalStatus || '-',
      environment: point.environment || '-',
      ipAddress: point.ipAddress || '-',
    }));

    const layers: any[] = [];

    if (overlays.includes('density')) {
      layers.push({
        type: 'densitymapbox',
        lat: visiblePoints.map((p) => p.plotLat),
        lon: visiblePoints.map((p) => p.plotLon),
        z: visiblePoints.map((p) => Math.max(1, p.overlapCount)),
        radius: 20,
        opacity: 0.36,
        showscale: false,
        colorscale: 'YlOrRd',
        hoverinfo: 'skip',
      });
    }

    // Contrast halo underlay keeps dots readable over street details at deeper zoom.
    layers.push({
      type: 'scattermapbox',
      mode: 'markers',
      lat: visiblePoints.map((p) => p.plotLat),
      lon: visiblePoints.map((p) => p.plotLon),
      hoverinfo: 'skip',
      marker: {
        size: markerSize + 4,
        color: haloColor,
        opacity: 0.78,
        line: { width: 0 },
      },
    });

    if (overlays.includes('riskHalo')) {
      const riskPoints = visiblePoints.filter((p) => colorSeverityBucket(worstSeverityForServer(p)) === 'high');
      if (riskPoints.length) {
        layers.push({
          type: 'scattermapbox',
          mode: 'markers',
          lat: riskPoints.map((p) => p.plotLat),
          lon: riskPoints.map((p) => p.plotLon),
          hoverinfo: 'skip',
          marker: {
            size: 16,
            color: 'rgba(220, 38, 38, 0.22)',
            line: { width: 0 },
          },
        });
      }
    }

    if (selectedApplicationKey) {
      const associatedPoints = visiblePoints;
      const anchorCounts = new Map<string, { lat: number; lon: number; count: number }>();
      for (const point of associatedPoints) {
        const key = `${point.lat.toFixed(6)}|${point.lon.toFixed(6)}`;
        if (!anchorCounts.has(key)) anchorCounts.set(key, { lat: point.lat, lon: point.lon, count: 0 });
        anchorCounts.get(key)!.count += 1;
      }

      const clusteredHighlights = [...anchorCounts.values()].filter((entry) => entry.count > 1);
      if (clusteredHighlights.length) {
        layers.push({
          type: 'scattermapbox',
          mode: 'markers+text',
          lat: clusteredHighlights.map((entry) => entry.lat),
          lon: clusteredHighlights.map((entry) => entry.lon),
          text: clusteredHighlights.map((entry) => String(entry.count)),
          textposition: 'middle center',
          hovertemplate: clusteredHighlights.map((entry) => `${entry.count} servers for selected app<extra></extra>`),
          marker: {
            size: clusteredHighlights.map((entry) => 16 + Math.min(12, entry.count * 0.8)),
            color: 'rgba(3,105,161,0.18)',
            line: { width: 1.2, color: '#0369a1' },
          },
        });
      }

      if (associatedPoints.length) {
        layers.push({
          type: 'scattermapbox',
          mode: 'markers',
          lat: associatedPoints.map((p) => p.plotLat),
          lon: associatedPoints.map((p) => p.plotLon),
          hoverinfo: 'skip',
          marker: {
            size: markerSize + 5,
            color: 'rgba(3,105,161,0.20)',
            line: { width: 0 },
          },
        });
      }
    }

    layers.push({
      type: 'scattermapbox',
      mode: 'markers',
      name: 'Servers',
      lat: visiblePoints.map((p) => p.plotLat),
      lon: visiblePoints.map((p) => p.plotLon),
      customdata: customData,
      hovertemplate: [
        '<b>%{customdata.name}</b>',
        '%{customdata.location}',
        'Vulnerability: %{customdata.vulnerabilitySeverity}',
        'Note Category: %{customdata.primaryLabel}',
        '<extra></extra>',
      ].join('<br>'),
      marker: {
        size: markerSize,
        color: customData.map((d) => d.pinColor),
        opacity: 0.96,
        line: { width: 0.6, color: '#ffffff' },
      },
    });

    return layers;
  }, [plotPoints, overlays, zoom, selectedApplicationKey, associatedServerIds, mapTier, stateClusters, anchorClusters]);

  if (loading) {
    return <div style={{ padding: 48, textAlign: 'center' }}><Spin size="large" /></div>;
  }

  if (!rawPoints.length) {
    return <Empty description="No server records available for map" />;
  }

  const selectedEntries = selectedServer
    ? Object.entries(selectedServer)
        .filter(([key, value]) => key !== 'healthNotes' && key !== 'linkedApplications' && !shouldHidePropertyByValue(value))
        .sort(([a], [b]) => a.localeCompare(b))
    : [];

  return (
    <>
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={24} md={6}><Card size="small"><Statistic title="Total Servers" value={rawPoints.length} /></Card></Col>
        <Col xs={24} md={6}><Card size="small"><Statistic title="Mapped Pins" value={plotPoints.length} /></Card></Col>
        <Col xs={24} md={6}><Card size="small"><Statistic title="Unmapped Locations" value={unknownLocationCount} /></Card></Col>
        <Col xs={24} md={6}>
          <Card size="small">
            <Statistic title="Unique Base Locations" value={uniqueAnchorCount} />
          </Card>
        </Col>
      </Row>

      <Row gutter={[12, 12]} ref={mapContainerRef}>
        <Col xs={24} xl={17}>
          <Card
            title="US Server Location Map"
            extra={(
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <Select
                  showSearch
                  optionFilterProp="label"
                  filterOption={(input, option) => String(option?.label || '').toLowerCase().includes(input.toLowerCase())}
                  allowClear
                  size="small"
                  placeholder="Jump to cluster"
                  style={{ width: 260 }}
                  value={selectedClusterKey || undefined}
                  options={locationClusters.map((cluster) => ({
                    label: `${cluster.label} (${cluster.count})`,
                    value: cluster.key,
                  }))}
                  onChange={(key) => {
                    const nextKey = key || null;
                    setSelectedClusterKey(nextKey);
                    if (!nextKey) return;

                    const cluster = locationClusters.find((item) => item.key === nextKey);
                    if (!cluster) return;

                    setCenter({ lat: cluster.centerLat, lon: cluster.centerLon });
                    setZoom(estimateFitZoom(cluster, estimateMapWidth(), mapHeight));
                  }}
                />
                <Select
                  showSearch
                  allowClear
                  size="small"
                  placeholder="Find server"
                  style={{ width: 320 }}
                  value={selectedServerId || undefined}
                  onSearch={setServerSearchTerm}
                  optionFilterProp="label"
                  filterOption={(input, option) => String(option?.label || '').toLowerCase().includes(input.toLowerCase())}
                  options={serverSearchOptions}
                  notFoundContent={serverSearchTerm ? 'No matches' : 'Type to search'}
                  onChange={(serverId) => {
                    const nextId = serverId ? String(serverId) : null;
                    setSelectedServerId(nextId);
                    if (!nextId) return;

                    const point = plotPoints.find((item) => item._id === nextId);
                    if (!point) return;

                    setSelectedClusterKey(null);
                    setCenter({ lat: point.plotLat, lon: point.plotLon });
                    setZoom(Math.max(zoom, 10));
                  }}
                />
                <Checkbox.Group
                  options={OVERLAY_OPTIONS}
                  value={overlays}
                  onChange={(vals) => setOverlays(vals as string[])}
                />
                <Select
                  showSearch
                  allowClear
                  size="small"
                  placeholder="Highlight by application"
                  style={{ width: 320 }}
                  value={selectedApplicationKey || undefined}
                  options={applicationOptions}
                  optionFilterProp="label"
                  filterOption={(input, option) => String(option?.label || '').toLowerCase().includes(input.toLowerCase())}
                  onChange={(value) => setSelectedApplicationKey(value ? String(value) : null)}
                />
                <Button
                  size="small"
                  onClick={fitMapToScreen}
                >
                  Fit to Screen
                </Button>
                <Button
                  size="small"
                  onClick={() => {
                    setZoom(3.1);
                    setCenter({ lat: 38.5, lon: -96.2 });
                    setSelectedApplicationKey(null);
                  }}
                >
                  Reset US View
                </Button>
              </div>
            )}
          >
            <Typography.Paragraph type="secondary" style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Tag color={mapTier === 'state' ? 'blue' : mapTier === 'anchor' ? 'geekblue' : 'green'}>
                {mapTier === 'state' ? 'Viewing: States' : mapTier === 'anchor' ? 'Viewing: Locations' : 'Viewing: Individual Servers'}
              </Tag>
              {mapTier === 'individual'
                ? 'Click a server dot to open full properties in the panel on the right.'
                : 'Click a bubble to drill down, or zoom in to reveal the next level of detail.'}
            </Typography.Paragraph>

            {mapTier === 'individual' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 8, fontSize: 12, color: '#475569' }}>
                <span style={{ fontWeight: 600 }}>Vulnerability:</span>
                {([
                  ['none', 'None'],
                  ['low', 'Low'],
                  ['medium', 'Medium'],
                  ['high', 'High/Critical'],
                ] as const).map(([bucket, label]) => (
                  <span key={bucket} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ width: 10, height: 10, borderRadius: '50%', background: VULNERABILITY_SEVERITY_COLORS[bucket], display: 'inline-block' }} />
                    {label}
                  </span>
                ))}
              </div>
            )}

            <Plot
              data={traces}
              layout={{
                dragmode: 'pan',
                mapbox: {
                  style: 'open-street-map',
                  center,
                  zoom,
                },
                margin: { t: 0, b: 0, l: 0, r: 0 },
                height: mapHeight,
              }}
              style={{ width: '100%' }}
              config={{ responsive: true, displaylogo: false, scrollZoom: true }}
              onRelayout={(eventData: any) => {
                const nextZoom = Number(eventData?.['mapbox.zoom']);
                const centerObj = eventData?.['mapbox.center'];
                if (Number.isFinite(nextZoom)) setZoom(nextZoom);
                if (centerObj && Number.isFinite(centerObj.lat) && Number.isFinite(centerObj.lon)) {
                  setCenter({ lat: centerObj.lat, lon: centerObj.lon });
                }
              }}
              onClick={(eventData: any) => {
                const point = eventData?.points?.[0];
                const clusterKey = point?.customdata?.clusterKey;
                if (clusterKey) {
                  const tier: MapTier = point.customdata.tier;
                  const source = tier === 'state' ? stateClusters : anchorClusters;
                  const cluster = source.find((item) => item.key === clusterKey);
                  if (cluster) {
                    // Fit the cluster's own extent, but never land short of
                    // the next tier's threshold — a tight cluster (e.g. one
                    // server) should still visibly drill down, not just
                    // re-center at the same zoom level.
                    const fitZoom = estimateFitZoom(cluster, estimateMapWidth(), mapHeight);
                    const minDrillZoom = tier === 'state' ? STATE_TIER_MAX_ZOOM + 0.3 : ANCHOR_TIER_MAX_ZOOM + 0.3;
                    setCenter({ lat: cluster.centerLat, lon: cluster.centerLon });
                    setZoom(Math.max(fitZoom, minDrillZoom));
                  }
                  return;
                }

                const id = point?.customdata?.id;
                if (id) setSelectedServerId(String(id));
              }}
            />
          </Card>
        </Col>

        <Col xs={24} xl={7}>
          <Card title="Selected Server Properties" style={{ height: mapHeight + 120 }} bodyStyle={{ maxHeight: mapHeight + 60, overflowY: 'auto' }}>
            {loadingSelected ? (
              <div style={{ textAlign: 'center', paddingTop: 24 }}><Spin /></div>
            ) : selectedServer ? (
              <>
                <Typography.Title level={5} style={{ marginTop: 0 }}>{selectedServer.name}</Typography.Title>
                <Typography.Text type="secondary">{selectedServer.hostName || selectedServer.ipAddress || selectedServer.fqdn || 'No host identifier'}</Typography.Text>
                <Divider style={{ margin: '12px 0' }} />

                <Typography.Title level={5} style={{ marginTop: 0 }}>Health Notes</Typography.Title>
                {selectedServer.healthNotes?.length ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
                    {selectedServer.healthNotes.map((note, idx) => (
                      <div key={`${note.label}-${idx}`} style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 8, background: '#fafafa' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                          <Tag color={note.severity === 'critical' ? 'red' : note.severity === 'high' ? 'volcano' : note.severity === 'medium' ? 'gold' : 'blue'}>{note.label}</Tag>
                          {note.severity ? <Typography.Text type="secondary">{note.severity}</Typography.Text> : null}
                        </div>
                        <Typography.Text>{note.note}</Typography.Text>
                        {note.rationale ? <div><Typography.Text type="secondary">Why: {note.rationale}</Typography.Text></div> : null}
                        {note.decisionFactors?.length ? (
                          <ul style={{ margin: '6px 0 0 16px', padding: 0 }}>
                            {note.decisionFactors.map((factor, factorIdx) => <li key={`${note.label}-f-${factorIdx}`}>{factor}</li>)}
                          </ul>
                        ) : null}
                        {note.vulnerabilities?.length ? (
                          <>
                            <Typography.Text strong>Known vulnerabilities:</Typography.Text>
                            <ul style={{ margin: '6px 0 0 16px', padding: 0 }}>
                              {note.vulnerabilities.map((item, vulnIdx) => <li key={`${note.label}-v-${vulnIdx}`}>{item}</li>)}
                            </ul>
                          </>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <Typography.Text type="secondary">No health notes</Typography.Text>
                )}

                <Divider style={{ margin: '12px 0' }} />
                <Typography.Title level={5} style={{ marginTop: 0 }}>Linked Applications</Typography.Title>
                {selectedServer.linkedApplications?.length ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
                    {selectedServer.linkedApplications.map((app, idx) => {
                      const appTitle = app.name || app.acronym || `Application ${idx + 1}`;
                      const appMeta = [app.acronym, app.relationType, app.apmNumber].filter(Boolean).join(' | ');
                      const readableParts = [
                        appMeta,
                        app.correlationId && !isKeyLikeString(String(app.correlationId)) ? `Correlation: ${app.correlationId}` : '',
                      ].filter(Boolean);
                      return (
                        <div key={`${appTitle}-${idx}`} style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 8, background: '#fafafa' }}>
                          <Typography.Text strong>{appTitle}</Typography.Text>
                          <div><Typography.Text type="secondary">{readableParts.join(' | ') || 'No additional details'}</Typography.Text></div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <Typography.Text type="secondary">No linked applications</Typography.Text>
                )}

                <Divider style={{ margin: '12px 0' }} />
                <Typography.Title level={5} style={{ marginTop: 0 }}>Other Properties</Typography.Title>
                <Descriptions column={1} size="small" bordered>
                  {selectedEntries.map(([key, value]) => (
                    <Descriptions.Item key={key} label={toLabel(key)}>
                      {renderServerValue(value)}
                    </Descriptions.Item>
                  ))}
                </Descriptions>
              </>
            ) : (
              <Empty description="Select a server on the map" />
            )}
          </Card>
        </Col>
      </Row>
    </>
  );
}
