import React, { useEffect, useState } from 'react';
import {
  ApartmentOutlined,
  BranchesOutlined,
  FundOutlined,
  RadarChartOutlined,
  ExperimentOutlined,
  SafetyCertificateOutlined,
  ArrowRightOutlined,
  HighlightOutlined,
  BuildOutlined,
  ShopOutlined,
  ToolOutlined,
  WifiOutlined,
  LockOutlined,
} from '@ant-design/icons';
import { SmcLogo, SmcMark } from './brand/SmcLogo';
import VehicleArt, { type VehicleBody, type VehicleArtProps } from './brand/VehicleArt';

/**
 * BPMN IQ landing tab: the internal process-intelligence site of Standard
 * Motor Company (SMC). Logo and vehicles are original vector art in
 * ./brand (SmcLogo, VehicleArt). The hero background is drawn in real BPMN 2.0
 * notation (pools, lanes, start/intermediate/end events, exclusive and
 * parallel gateways, tasks, sequence and message flows) with animated
 * tokens travelling the flows. Everything is inline SVG + CSS — no assets.
 */

interface LandingPageProps {
  /** Switches the outer app tab (same keys as App.tsx's outer Tabs). */
  onNavigate: (tabKey: string) => void;
}

const STROKE = 'rgba(147, 197, 253, 0.55)';
const STROKE_SOFT = 'rgba(147, 197, 253, 0.28)';
const FILL = 'rgba(30, 64, 175, 0.22)';
const LABEL = 'rgba(219, 234, 254, 0.75)';

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);
  return reduced;
}

// ── BPMN 2.0 shape primitives ─────────────────────────────────────────────

const Task: React.FC<{ x: number; y: number; label: string; delay: number; w?: number }> = ({ x, y, label, delay, w = 120 }) => (
  <g>
    <rect
      x={x} y={y} width={w} height={60} rx={10}
      fill={FILL} stroke={STROKE} strokeWidth={1.6}
      className="lp-task" style={{ animationDelay: `${delay}s` }}
    />
    <text x={x + w / 2} y={y + 35} textAnchor="middle" fontSize={12} fill={LABEL} fontFamily="Inter, system-ui, sans-serif">
      {label}
    </text>
  </g>
);

const StartEvent: React.FC<{ cx: number; cy: number }> = ({ cx, cy }) => (
  <circle cx={cx} cy={cy} r={18} fill={FILL} stroke={STROKE} strokeWidth={1.6} />
);

const EndEvent: React.FC<{ cx: number; cy: number }> = ({ cx, cy }) => (
  <circle cx={cx} cy={cy} r={18} fill={FILL} stroke={STROKE} strokeWidth={4} />
);

const TimerEvent: React.FC<{ cx: number; cy: number }> = ({ cx, cy }) => (
  <g>
    <circle cx={cx} cy={cy} r={18} fill={FILL} stroke={STROKE} strokeWidth={1.6} />
    <circle cx={cx} cy={cy} r={14} fill="none" stroke={STROKE} strokeWidth={1.2} />
    <circle cx={cx} cy={cy} r={9} fill="none" stroke={STROKE} strokeWidth={1} />
    <line x1={cx} y1={cy} x2={cx} y2={cy - 7} stroke={STROKE} strokeWidth={1.2} className="lp-clock" style={{ transformOrigin: `${cx}px ${cy}px` }} />
    <line x1={cx} y1={cy} x2={cx + 5} y2={cy} stroke={STROKE} strokeWidth={1.2} />
  </g>
);

const MessageEvent: React.FC<{ cx: number; cy: number; end?: boolean }> = ({ cx, cy, end }) => (
  <g>
    <circle cx={cx} cy={cy} r={18} fill={FILL} stroke={STROKE} strokeWidth={end ? 4 : 1.6} />
    {!end && <circle cx={cx} cy={cy} r={14} fill="none" stroke={STROKE} strokeWidth={1.2} />}
    <rect x={cx - 8} y={cy - 5.5} width={16} height={11} fill="none" stroke={STROKE} strokeWidth={1.2} />
    <polyline points={`${cx - 8},${cy - 5.5} ${cx},${cy + 1} ${cx + 8},${cy - 5.5}`} fill="none" stroke={STROKE} strokeWidth={1.2} />
  </g>
);

const Gateway: React.FC<{ cx: number; cy: number; kind: 'exclusive' | 'parallel' }> = ({ cx, cy, kind }) => (
  <g className="lp-gateway" style={{ transformOrigin: `${cx}px ${cy}px` }}>
    <polygon
      points={`${cx},${cy - 25} ${cx + 25},${cy} ${cx},${cy + 25} ${cx - 25},${cy}`}
      fill={FILL} stroke={STROKE} strokeWidth={1.6}
    />
    {kind === 'exclusive' ? (
      <g stroke={STROKE} strokeWidth={3} strokeLinecap="round">
        <line x1={cx - 7} y1={cy - 7} x2={cx + 7} y2={cy + 7} />
        <line x1={cx + 7} y1={cy - 7} x2={cx - 7} y2={cy + 7} />
      </g>
    ) : (
      <g stroke={STROKE} strokeWidth={3} strokeLinecap="round">
        <line x1={cx} y1={cy - 10} x2={cx} y2={cy + 10} />
        <line x1={cx - 10} y1={cy} x2={cx + 10} y2={cy} />
      </g>
    )}
  </g>
);

const Flow: React.FC<{ d: string }> = ({ d }) => (
  <path d={d} fill="none" stroke={STROKE} strokeWidth={1.6} markerEnd="url(#lp-arrow)" className="lp-flow" />
);

const MessageFlow: React.FC<{ d: string }> = ({ d }) => (
  <path
    d={d} fill="none" stroke={STROKE_SOFT} strokeWidth={1.4} strokeDasharray="7 6"
    markerStart="url(#lp-msg-start)" markerEnd="url(#lp-arrow-open)" className="lp-msgflow"
  />
);

const Token: React.FC<{ path: string; dur: number; begin?: number; color?: string }> = ({ path, dur, begin = 0, color = '#67e8f9' }) => (
  <circle r={5} fill={color} filter="url(#lp-glow)">
    <animateMotion dur={`${dur}s`} begin={`${begin}s`} repeatCount="indefinite" path={path} rotate="auto" />
  </circle>
);

const Pool: React.FC<{ w: number; h: number; label: string; lanes?: string[] }> = ({ w, h, label, lanes = [] }) => {
  const laneH = lanes.length ? h / lanes.length : h;
  return (
    <g>
      <rect x={0} y={0} width={w} height={h} fill="rgba(15, 23, 42, 0.35)" stroke={STROKE_SOFT} strokeWidth={1.4} />
      <line x1={32} y1={0} x2={32} y2={h} stroke={STROKE_SOFT} strokeWidth={1.4} />
      <text
        x={16} y={h / 2} textAnchor="middle" fontSize={12} fill={LABEL} letterSpacing={2}
        transform={`rotate(-90 16 ${h / 2})`} fontFamily="Inter, system-ui, sans-serif"
      >
        {label.toUpperCase()}
      </text>
      {lanes.map((lane, i) => (
        <g key={lane}>
          {i > 0 && <line x1={32} y1={i * laneH} x2={w} y2={i * laneH} stroke={STROKE_SOFT} strokeWidth={1.2} />}
          <line x1={58} y1={i * laneH} x2={58} y2={(i + 1) * laneH} stroke={STROKE_SOFT} strokeWidth={1} />
          <text
            x={45} y={i * laneH + laneH / 2} textAnchor="middle" fontSize={10} fill={LABEL}
            transform={`rotate(-90 45 ${i * laneH + laneH / 2})`} fontFamily="Inter, system-ui, sans-serif"
          >
            {lane}
          </text>
        </g>
      ))}
    </g>
  );
};

// ── Diagram 1: order-to-cash process, one pool, two lanes ─────────────────

const OrderToCash: React.FC<{ animate: boolean }> = ({ animate }) => (
  <g>
    <Pool w={1000} h={300} label="Order to Cash" lanes={['Sales', 'Finance']} />
    <StartEvent cx={95} cy={75} />
    <Flow d="M113 75 H140" />
    <Task x={140} y={45} label="Receive Order" delay={0} />
    <Flow d="M260 75 H290" />
    <Gateway cx={315} cy={75} kind="exclusive" />
    <Flow d="M340 75 H370" />
    <Task x={370} y={45} label="Reserve Stock" delay={1.5} />
    <Flow d="M315 100 V225 H370" />
    <Task x={370} y={195} label="Validate Credit" delay={1.5} />
    <Flow d="M490 75 H525" />
    <Flow d="M490 225 H550 V100" />
    <Gateway cx={550} cy={75} kind="parallel" />
    <Flow d="M575 75 H602" />
    <TimerEvent cx={620} cy={75} />
    <Flow d="M638 75 H665" />
    <Task x={665} y={45} label="Ship Order" delay={3} />
    <Flow d="M725 105 V195" />
    <Task x={665} y={195} label="Send Invoice" delay={4.5} />
    <Flow d="M785 225 H900 V93" />
    <Flow d="M785 75 H882" />
    <EndEvent cx={900} cy={75} />
    {animate && (
      <>
        <Token path="M77 75 H900" dur={7} />
        <Token path="M315 100 V225 H550 V75" dur={5} begin={1.2} color="#a5b4fc" />
        <Token path="M725 105 V225 H900 V93" dur={4.5} begin={2.5} color="#86efac" />
      </>
    )}
  </g>
);

// ── Diagram 2: collaboration — two pools with message flows ───────────────

const SupplierCollaboration: React.FC<{ animate: boolean }> = ({ animate }) => (
  <g>
    <Pool w={820} h={130} label="Customer" />
    <MessageEvent cx={90} cy={65} />
    <Flow d="M108 65 H140" />
    <Task x={140} y={35} label="Request Quote" delay={0.8} />
    <Flow d="M260 65 H520" />
    <Task x={520} y={35} label="Approve Quote" delay={3.8} />
    <Flow d="M640 65 H730" />
    <EndEvent cx={748} cy={65} />

    <g transform="translate(0 210)">
      <Pool w={820} h={130} label="Supplier" />
      <MessageEvent cx={110} cy={65} />
      <Flow d="M128 65 H180" />
      <Task x={180} y={35} label="Price Items" delay={2} />
      <Flow d="M300 65 H340" />
      <Gateway cx={365} cy={65} kind="exclusive" />
      <Flow d="M390 65 H430" />
      <Task x={430} y={35} label="Issue Quote" delay={2.8} />
      <Flow d="M550 65 H720" />
      <MessageEvent cx={738} cy={65} end />
    </g>

    <MessageFlow d="M200 95 V255" />
    <MessageFlow d="M490 245 V95" />
    {animate && (
      <>
        <Token path="M200 95 V245" dur={3.2} color="#fcd34d" />
        <Token path="M490 245 V95" dur={3.2} begin={1.6} color="#fcd34d" />
        <Token path="M72 65 H730" dur={8} begin={0.4} />
      </>
    )}
  </g>
);

// ── Background composition ───────────────────────────────────────────────

const BpmnBackdrop: React.FC<{ animate: boolean }> = ({ animate }) => (
  <svg
    className="absolute inset-0 h-full w-full"
    viewBox="0 0 1600 900"
    preserveAspectRatio="xMidYMid slice"
    aria-hidden="true"
  >
    <defs>
      <marker id="lp-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0 0 L10 5 L0 10 z" fill={STROKE} />
      </marker>
      <marker id="lp-arrow-open" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
        <path d="M0 0 L10 5 L0 10 z" fill="#0b1630" stroke={STROKE_SOFT} />
      </marker>
      <marker id="lp-msg-start" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="7" markerHeight="7">
        <circle cx="5" cy="5" r="4" fill="#0b1630" stroke={STROKE_SOFT} />
      </marker>
      <filter id="lp-glow" x="-200%" y="-200%" width="500%" height="500%">
        <feGaussianBlur stdDeviation="3" result="blur" />
        <feMerge>
          <feMergeNode in="blur" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
      <pattern id="lp-grid" width="40" height="40" patternUnits="userSpaceOnUse">
        <path d="M40 0 H0 V40" fill="none" stroke="rgba(148,163,184,0.07)" strokeWidth="1" />
      </pattern>
      <radialGradient id="lp-vignette" cx="50%" cy="45%" r="75%">
        <stop offset="0%" stopColor="#0b1630" stopOpacity="0" />
        <stop offset="100%" stopColor="#050b1a" stopOpacity="0.9" />
      </radialGradient>
    </defs>

    <rect width="1600" height="900" fill="url(#lp-grid)" />

    <g transform="translate(560 70) scale(1)">
      <g className="lp-drift-a" opacity={0.9}>
        <OrderToCash animate={animate} />
      </g>
    </g>
    <g transform="translate(-120 470) scale(0.95)">
      <g className="lp-drift-b" opacity={0.7}>
        <SupplierCollaboration animate={animate} />
      </g>
    </g>
    <g transform="translate(900 560) scale(0.7)">
      <g className="lp-drift-c" opacity={0.4}>
        <OrderToCash animate={animate} />
      </g>
    </g>

    <rect width="1600" height="900" fill="url(#lp-vignette)" />
  </svg>
);

// ── Page ─────────────────────────────────────────────────────────────────

const FEATURES: Array<{ icon: React.ReactNode; title: string; body: string; tab: string; cta: string }> = [
  {
    icon: <ApartmentOutlined />,
    title: 'Business Processes',
    body: 'Every SMC business flow, from the design studio to the service lane, modeled in BPMN 2.0, plus the processes discovered in production traces that nobody has modeled yet.',
    tab: 'bpmn',
    cta: 'Open Business Processes',
  },
  {
    icon: <BranchesOutlined />,
    title: 'Value Streams & Capabilities',
    body: 'Trace each SMC domain and value stream down through the business capabilities it enables to the flows that support them.',
    tab: 'valueStreams',
    cta: 'Explore value streams',
  },
  {
    icon: <FundOutlined />,
    title: 'Flow Scorecards',
    body: 'One tile per process flow scoring cost of ownership, security, defect risk, SOX compliance and change exposure, plus the business measures leadership tracks.',
    tab: 'execDashboard',
    cta: 'View the dashboard',
  },
  {
    icon: <RadarChartOutlined />,
    title: 'Process Change Intelligence',
    body: 'See which flows in-flight Jira work touches, in a heat map by domain and a radar down to the task and application.',
    tab: 'processChanges',
    cta: 'See process changes',
  },
  {
    icon: <ExperimentOutlined />,
    title: 'What-If Modeling',
    body: 'Edit a flow side by side with its baseline and watch cost and risk gauges move in real time. AI-assisted optimization proposals are included.',
    tab: 'quantitativeModeling',
    cta: 'Start modeling',
  },
  {
    icon: <SafetyCertificateOutlined />,
    title: 'SOX Controls on the Canvas',
    body: 'ITGC, process and interface controls appear as shields on tasks and applications, with audit deviations a click away.',
    tab: 'bpmn',
    cta: 'Review controls',
  },
];

type Stage = {
  key: string;
  icon: React.ReactNode;
  title: string;
  domain: string;
  body: string;
  flows: string[];
  scene: React.ReactNode;
};

/** The vehicle lifecycle, each stage drawn as a scene and backed by real SMC flows. */
const STAGES: Stage[] = [
  {
    key: 'design',
    icon: <HighlightOutlined />,
    title: 'Design',
    domain: 'Engineering & Product Development',
    body: 'From concept to a certified, production-ready program.',
    flows: ['New Model Development Program', 'Prototype Vehicle Build', 'Vehicle Safety Compliance Certification'],
    scene: (
      <span className="lp-scene lp-scene-blueprint">
        <VehicleArt body="sedan" finish="blueprint" className="lp-scene-car text-sky-200" />
      </span>
    ),
  },
  {
    key: 'build',
    icon: <BuildOutlined />,
    title: 'Build',
    domain: 'Manufacturing & Supply Chain',
    body: 'Body in white to the end of the line, every lot accounted for.',
    flows: ['Vehicle Assembly Line Execution', 'End-of-Line Quality Inspection', 'Warehouse Inventory Management'],
    scene: (
      <span className="lp-scene lp-scene-factory">
        <span className="lp-conveyor" />
        <VehicleArt body="suv" finish="primer" className="lp-scene-car lp-on-line" />
      </span>
    ),
  },
  {
    key: 'sell',
    icon: <ShopOutlined />,
    title: 'Sell',
    domain: 'Sales & Distribution · Finance & Insurance',
    body: 'Online or in the showroom, through financing to the delivery handshake.',
    flows: ['Digital Retailing Journey', 'Finance Contract Funding', 'New Vehicle Delivery Experience'],
    scene: (
      <span className="lp-scene lp-scene-showroom">
        <span className="lp-spotlight" />
        <VehicleArt body="sedan" paint="red" className="lp-scene-car" />
      </span>
    ),
  },
  {
    key: 'service',
    icon: <ToolOutlined />,
    title: 'Service',
    domain: 'After-Sales & Service',
    body: 'Repair orders, warranty claims and recall campaigns at every dealer.',
    flows: ['Repair Order Completion', 'Warranty Claim Submission', 'Recall Campaign Execution'],
    scene: (
      <span className="lp-scene lp-scene-service">
        <span className="lp-lift lp-lift-l" />
        <span className="lp-lift lp-lift-r" />
        <VehicleArt body="pickup" paint="graphite" shadow={false} className="lp-scene-car lp-raised" />
      </span>
    ),
  },
  {
    key: 'connect',
    icon: <WifiOutlined />,
    title: 'Connect',
    domain: 'Connected Vehicle & Mobility',
    body: 'Over-the-air updates, subscriptions and EV care after the sale.',
    flows: ['Over-the-Air Software Update', 'Connected Subscription Renewal', 'Battery Replacement Service'],
    scene: (
      <span className="lp-scene lp-scene-night">
        <svg className="lp-signal" viewBox="0 0 60 40" aria-hidden="true">
          <path d="M18 30 Q30 14 42 30" />
          <path d="M10 26 Q30 2 50 26" />
          <path d="M2 22 Q30 -10 58 22" />
        </svg>
        <VehicleArt body="ev" paint="blue" lightsOn className="lp-scene-car" />
      </span>
    ),
  },
];

/** SMC's lineup (fictional models), each with processes it passes through. */
const LINEUP: Array<{ name: string; type: string; body: VehicleBody; paint: VehicleArtProps['paint']; tagline: string; flows: string[] }> = [
  { name: 'Halcyon', type: 'Midsize sedan', body: 'sedan', paint: 'blue', tagline: 'Our best-selling sedan, built in two plants.', flows: ['Vehicle Assembly Line Execution', 'Digital Retailing Journey', 'Warranty Contract Execution'] },
  { name: 'Tessera', type: 'Compact crossover', body: 'suv', paint: 'silver', tagline: 'Family favorite and fleet staple.', flows: ['Fleet Order Fulfillment', 'Customer Credit Application', 'Repair Order Completion'] },
  { name: 'Ironbark', type: 'Crew-cab pickup', body: 'pickup', paint: 'red', tagline: 'Work truck with a towing package.', flows: ['End-of-Line Quality Inspection', 'Finance Contract Funding', 'Recall Campaign Execution'] },
  { name: 'Lumen EV', type: 'Electric fastback', body: 'ev', paint: 'white', tagline: 'Connected from day one, updated over the air.', flows: ['Over-the-Air Software Update', 'Connected Subscription Renewal', 'Battery Replacement Service'] },
];

const STEPS = [
  { n: '01', title: 'Model', body: 'Capture end-to-end SMC flows in BPMN 2.0, tied to the real application, API and infrastructure catalog.' },
  { n: '02', title: 'Analyze', body: 'Roll up cost, risk, compliance and change activity per flow, per capability and per domain.' },
  { n: '03', title: 'Optimize', body: 'Test changes in a what-if sandbox and act on evidence-backed proposals before you commit.' },
];

/** A start event, the flows as task boxes, an end event: a flow list drawn as a mini BPMN strip. */
const FlowStrip: React.FC<{ flows: string[] }> = ({ flows }) => (
  <span className="lp-flowstrip">
    <span className="lp-fs-event" aria-hidden="true" />
    {flows.map((f) => (
      <span key={f} className="lp-fs-task">{f}</span>
    ))}
    <span className="lp-fs-event lp-fs-end" aria-hidden="true" />
  </span>
);

const LandingPage: React.FC<LandingPageProps> = ({ onNavigate }) => {
  const reducedMotion = usePrefersReducedMotion();

  return (
    <div className="lp-root h-full w-full overflow-y-auto bg-slate-50">
      <style>{LANDING_CSS}</style>

      {/* Hero */}
      <section className="relative isolate overflow-hidden" style={{ background: 'linear-gradient(160deg, #0b1630 0%, #0f2147 55%, #0b1630 100%)' }}>
        <BpmnBackdrop animate={!reducedMotion} />
        <div className="pointer-events-none absolute inset-0" style={{ background: 'linear-gradient(90deg, rgba(11,22,48,0.94) 0%, rgba(11,22,48,0.75) 42%, rgba(11,22,48,0.1) 75%)' }} />

        <div className="relative z-10 mx-auto max-w-[1200px] px-6 pt-6 sm:px-10">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <SmcLogo tone="dark" size={44} />
            <span className="inline-flex items-center gap-2 rounded-full border border-solid border-amber-300/40 bg-amber-400/10 px-3 py-1 text-xs font-medium text-amber-100">
              <LockOutlined /> Internal · SMC employees and contractors only
            </span>
          </div>
        </div>

        <div className="relative z-10 mx-auto flex min-h-[600px] max-w-[1200px] flex-col justify-center px-6 pb-28 pt-10 sm:px-10">
          <div className="lp-rise inline-flex w-fit items-center gap-2 rounded-full border border-sky-300/30 bg-sky-400/10 px-3 py-1 text-xs font-medium tracking-wide text-sky-200" style={{ animationDelay: '0.05s' }}>
            <span className="lp-pulse-dot h-1.5 w-1.5 rounded-full bg-cyan-300" />
            Standard Motor Company · Business Process Intelligence
          </div>
          <h1 className="lp-rise mt-6 max-w-[760px] text-4xl font-semibold leading-tight tracking-tight text-white sm:text-6xl" style={{ animationDelay: '0.15s' }}>
            BPMN <span className="lp-gradient-text">IQ</span>
          </h1>
          <p className="lp-rise mt-4 max-w-[600px] text-xl font-medium text-slate-200 sm:text-2xl" style={{ animationDelay: '0.25s' }}>
            Every vehicle we design, build, sell and service runs on a process.
          </p>
          <p className="lp-rise mt-4 max-w-[560px] text-base leading-relaxed text-slate-300" style={{ animationDelay: '0.35s' }}>
            One connected BPMN model of how Standard Motor Company works: the business flows behind every program, plant,
            dealership and connected vehicle, with the applications and infrastructure that run them. See what each process
            costs, where it's exposed, and what changing it would mean.
          </p>
          <div className="lp-rise mt-9 flex flex-wrap gap-3" style={{ animationDelay: '0.45s' }}>
            <button
              type="button"
              onClick={() => onNavigate('bpmn')}
              className="group inline-flex items-center gap-2 rounded-lg border-0 bg-sky-500 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-sky-900/40 transition hover:bg-sky-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
            >
              Open Business Processes
              <ArrowRightOutlined className="transition-transform group-hover:translate-x-0.5" />
            </button>
            <button
              type="button"
              onClick={() => onNavigate('execDashboard')}
              className="inline-flex items-center gap-2 rounded-lg border border-solid border-white/25 bg-white/5 px-5 py-3 text-sm font-semibold text-white backdrop-blur transition hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
            >
              View Dashboard
            </button>
          </div>
          <div className="lp-rise mt-12 flex flex-wrap gap-x-8 gap-y-3 text-sm text-slate-300" style={{ animationDelay: '0.55s' }}>
            {['BPMN 2.0 native', 'Live production telemetry', 'SOX control mapping', 'AI process optimizer'].map((item) => (
              <span key={item} className="inline-flex items-center gap-2">
                <span className="h-1 w-4 rounded-full bg-sky-400/70" />
                {item}
              </span>
            ))}
          </div>
        </div>

        {/* The hero car rides a sequence flow: start event → … → end event */}
        <div className="lp-hero-car pointer-events-none absolute bottom-6 right-6 z-0 hidden w-[540px] lg:block xl:right-12" aria-hidden="true">
          <VehicleArt body="ev" paint="silver" lightsOn className="block w-full" />
          <svg viewBox="0 0 600 24" className="-mt-1 block w-full">
            <circle cx="14" cy="12" r="8" fill="#0b1630" stroke="#93c5fd" strokeWidth="1.6" />
            <line x1="22" y1="12" x2="566" y2="12" stroke="#93c5fd" strokeOpacity="0.7" strokeWidth="1.6" />
            <path d="M560 7 L570 12 L560 17 Z" fill="#93c5fd" />
            <circle cx="582" cy="12" r="8" fill="#0b1630" stroke="#f59e0b" strokeWidth="3.5" />
            {!reducedMotion && (
              <circle r="4.5" fill="#67e8f9" filter="url(#lp-glow)">
                <animateMotion dur="5s" repeatCount="indefinite" path="M22 12 H566" />
              </circle>
            )}
          </svg>
        </div>
      </section>

      {/* Lifecycle */}
      <section className="mx-auto max-w-[1200px] px-6 py-16 sm:px-10">
        <div className="max-w-[680px]">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-600">The vehicle lifecycle, as BPMN</div>
          <h2 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">From the design studio to the driveway, and back to the service lane</h2>
          <p className="mt-3 text-base leading-relaxed text-slate-600">
            Each stage of an SMC vehicle's life is a set of modeled business flows. These are a few of them; open the value
            streams to see them all.
          </p>
        </div>
        <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-5">
          {STAGES.map((s, i) => (
            <button
              key={s.key}
              type="button"
              onClick={() => onNavigate('valueStreams')}
              className="lp-card group flex flex-col overflow-hidden rounded-xl border border-solid border-slate-200 bg-white p-0 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-sky-300 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
              style={{ animationDelay: `${0.1 + i * 0.07}s` }}
            >
              {s.scene}
              <span className="flex flex-1 flex-col p-4">
                <span className="flex items-center gap-2">
                  <span className="flex h-7 w-7 items-center justify-center rounded-md bg-sky-50 text-sm text-sky-600 ring-1 ring-sky-100">{s.icon}</span>
                  <span className="text-base font-semibold text-slate-900">{s.title}</span>
                </span>
                <span className="mt-1 text-[11px] font-medium uppercase tracking-wide text-slate-400">{s.domain}</span>
                <span className="mt-2 text-sm leading-relaxed text-slate-600">{s.body}</span>
                <span className="mt-3 flex-1"><FlowStrip flows={s.flows} /></span>
              </span>
            </button>
          ))}
        </div>
      </section>

      {/* Lineup */}
      <section className="border-solid border-slate-200 bg-white" style={{ borderWidth: '1px 0' }}>
        <div className="mx-auto max-w-[1200px] px-6 py-16 sm:px-10">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="max-w-[640px]">
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-600">The 2027 lineup</div>
              <h2 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">Every model, and the processes behind it</h2>
              <p className="mt-3 text-base leading-relaxed text-slate-600">
                A vehicle passes through dozens of flows on its way to a customer. A few that each model depends on:
              </p>
            </div>
            <SmcMark size={56} />
          </div>
          <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {LINEUP.map((v, i) => (
              <button
                key={v.name}
                type="button"
                onClick={() => onNavigate('bpmn')}
                className="lp-card group flex flex-col overflow-hidden rounded-xl border border-solid border-slate-200 bg-white p-0 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-sky-300 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
                style={{ animationDelay: `${0.1 + i * 0.07}s` }}
              >
                <span className="lp-studio block">
                  <VehicleArt body={v.body} paint={v.paint} reflection className="lp-studio-car" title={`SMC ${v.name}`} />
                </span>
                <span className="flex flex-1 flex-col p-5">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">SMC · {v.type}</span>
                  <span className="mt-1 text-xl font-semibold tracking-tight text-slate-900">{v.name}</span>
                  <span className="mt-1 text-sm text-slate-600">{v.tagline}</span>
                  <span className="mt-4 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Processes on its path</span>
                  <span className="mt-2 flex flex-1 flex-col gap-1.5">
                    {v.flows.map((f) => (
                      <span key={f} className="inline-flex items-center gap-2 text-sm text-slate-700">
                        <span className="h-3.5 w-5 shrink-0 rounded-[4px] border border-solid border-sky-400 bg-sky-50" aria-hidden="true" />
                        {f}
                      </span>
                    ))}
                  </span>
                  <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-sky-700">
                    See the flows <ArrowRightOutlined className="text-xs transition-transform group-hover:translate-x-0.5" />
                  </span>
                </span>
              </button>
            ))}
          </div>
          <p className="mt-4 text-xs text-slate-400">Model names and illustrations are for internal demonstration.</p>
        </div>
      </section>

      {/* Features */}
      <section className="mx-auto max-w-[1200px] px-6 py-16 sm:px-10">
        <div className="max-w-[640px]">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-600">Platform</div>
          <h2 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">Everything about a process, in one place</h2>
          <p className="mt-3 text-base leading-relaxed text-slate-600">
            Every view below works on the same SMC model, so a change to a flow, an application or a control shows up
            everywhere at once.
          </p>
        </div>
        <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f, i) => (
            <button
              key={f.title}
              type="button"
              onClick={() => onNavigate(f.tab)}
              className="lp-card group flex flex-col rounded-xl border border-solid border-slate-200 bg-white p-6 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-sky-300 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
              style={{ animationDelay: `${0.1 + i * 0.07}s` }}
            >
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-sky-50 text-lg text-sky-600 ring-1 ring-sky-100">
                {f.icon}
              </span>
              <span className="mt-4 text-base font-semibold text-slate-900">{f.title}</span>
              <span className="mt-2 flex-1 text-sm leading-relaxed text-slate-600">{f.body}</span>
              <span className="mt-5 inline-flex items-center gap-1.5 text-sm font-medium text-sky-700">
                {f.cta}
                <ArrowRightOutlined className="text-xs transition-transform group-hover:translate-x-0.5" />
              </span>
            </button>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section className="border-solid border-slate-200 bg-white" style={{ borderWidth: '1px 0' }}>
        <div className="mx-auto max-w-[1200px] px-6 py-16 sm:px-10">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-600">How it works</div>
          <h2 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">From model to measurable change</h2>
          <div className="mt-10 grid gap-8 md:grid-cols-3">
            {STEPS.map((s, i) => (
              <div key={s.n} className="relative">
                <div className="flex items-center gap-3">
                  <span className="flex h-11 w-11 items-center justify-center rounded-full border-2 border-solid border-sky-500 text-sm font-semibold text-sky-700">
                    {s.n}
                  </span>
                  {i < STEPS.length - 1 && (
                    <span className="lp-connector hidden h-0.5 flex-1 md:block" />
                  )}
                </div>
                <h3 className="mt-4 text-lg font-semibold text-slate-900">{s.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Closing CTA */}
      <section className="mx-auto max-w-[1200px] px-6 py-16 sm:px-10">
        <div className="relative overflow-hidden rounded-2xl px-8 py-12 sm:px-12" style={{ background: 'linear-gradient(120deg, #0f2147, #1d4ed8)' }}>
          <div className="pointer-events-none absolute -bottom-10 right-[-60px] hidden w-[380px] opacity-[0.12] md:block" aria-hidden="true">
            <VehicleArt body="suv" paint="white" shadow={false} className="block w-full" />
          </div>
          <div className="relative z-10 flex flex-col items-start justify-between gap-6 md:flex-row md:items-center">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">Ready to see SMC's processes clearly?</h2>
              <p className="mt-2 max-w-[560px] text-sm leading-relaxed text-sky-100">
                Start with a single flow: open it, check its scorecard, and try a change in the what-if sandbox.
              </p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('quantitativeModeling')}
              className="inline-flex shrink-0 items-center gap-2 rounded-lg border-0 bg-white px-5 py-3 text-sm font-semibold text-sky-800 shadow transition hover:bg-sky-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              Try What-If Modeling
              <ArrowRightOutlined />
            </button>
          </div>
        </div>
        <footer className="mt-12 flex flex-col items-center gap-3 text-center">
          <SmcLogo tone="light" size={32} />
          <div className="text-xs text-slate-400">
            BPMN IQ · Business process intelligence on BPMN 2.0 · Standard Motor Company internal use only
          </div>
        </footer>
      </section>
    </div>
  );
};

const LANDING_CSS = `
.lp-root .lp-flow {
  stroke-dasharray: 600;
  stroke-dashoffset: 600;
  animation: lp-draw 1.8s ease-out forwards;
}
.lp-root .lp-msgflow { animation: lp-march 1.4s linear infinite; }
.lp-root .lp-task { animation: lp-task-glow 6s ease-in-out infinite; }
.lp-root .lp-gateway { transform-box: fill-box; animation: lp-gw 4s ease-in-out infinite; }
.lp-root .lp-clock { transform-box: view-box; animation: lp-spin 6s linear infinite; }
.lp-root .lp-drift-a { animation: lp-drift-a 26s ease-in-out infinite alternate; }
.lp-root .lp-drift-b { animation: lp-drift-b 32s ease-in-out infinite alternate; }
.lp-root .lp-drift-c { animation: lp-drift-c 38s ease-in-out infinite alternate; }
.lp-root .lp-rise { opacity: 0; animation: lp-rise 0.8s cubic-bezier(.2,.7,.2,1) forwards; }
.lp-root .lp-card { opacity: 0; animation: lp-card-in 0.6s cubic-bezier(.2,.7,.2,1) forwards; }
@keyframes lp-card-in { from { opacity: 0; translate: 0 14px; } to { opacity: 1; translate: 0 0; } }
.lp-root .lp-pulse-dot { animation: lp-pulse 2s ease-in-out infinite; }
.lp-root .lp-gradient-text {
  background: linear-gradient(90deg, #67e8f9, #60a5fa, #a5b4fc, #67e8f9);
  background-size: 300% 100%;
  -webkit-background-clip: text; background-clip: text; color: transparent;
  animation: lp-shimmer 8s linear infinite;
}
.lp-root .lp-connector {
  background: linear-gradient(90deg, #0ea5e9 0%, #0ea5e9 40%, #e2e8f0 40%);
  background-size: 250% 100%;
  animation: lp-connector 3s ease-in-out infinite;
}
@keyframes lp-draw { to { stroke-dashoffset: 0; } }
@keyframes lp-march { to { stroke-dashoffset: -26; } }
@keyframes lp-task-glow {
  0%, 70%, 100% { stroke: rgba(147,197,253,0.55); fill: rgba(30,64,175,0.22); }
  10%, 25% { stroke: #67e8f9; fill: rgba(34,211,238,0.18); }
}
@keyframes lp-gw { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.06); } }
@keyframes lp-spin { to { transform: rotate(360deg); } }
@keyframes lp-drift-a { from { transform: translate(0, 0); } to { transform: translate(-40px, 18px); } }
@keyframes lp-drift-b { from { transform: translate(0, 0); } to { transform: translate(50px, -14px); } }
@keyframes lp-drift-c { from { transform: translate(0, 0); } to { transform: translate(-30px, -22px); } }
@keyframes lp-rise { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
@keyframes lp-pulse { 0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(103,232,249,0.6); } 50% { opacity: .7; box-shadow: 0 0 0 6px rgba(103,232,249,0); } }
@keyframes lp-shimmer { to { background-position: 300% 0; } }
@keyframes lp-connector { 0% { background-position: 100% 0; } 100% { background-position: 0 0; } }

/* ── SMC scenes ── */
.lp-root .lp-scene { position: relative; display: block; height: 128px; overflow: hidden; }
.lp-root .lp-scene-car { position: absolute; left: 6%; bottom: -6px; width: 88%; }
.lp-root .lp-scene-blueprint {
  background-color: #0b3a6e;
  background-image: linear-gradient(rgba(186,230,253,.14) 1px, transparent 1px), linear-gradient(90deg, rgba(186,230,253,.14) 1px, transparent 1px);
  background-size: 14px 14px;
}
.lp-root .lp-scene-factory { background: linear-gradient(180deg, #cbd5e1 0%, #e2e8f0 55%, #94a3b8 100%); }
.lp-root .lp-scene-factory::before {
  content: ''; position: absolute; inset: 0 0 auto 0; height: 26px;
  background: repeating-linear-gradient(90deg, rgba(15,23,42,.18) 0 2px, transparent 2px 34px);
}
.lp-root .lp-conveyor {
  position: absolute; left: 0; right: 0; bottom: 4px; height: 8px;
  background: repeating-linear-gradient(90deg, #475569 0 10px, #64748b 10px 20px);
  animation: lp-belt 1.2s linear infinite;
}
.lp-root .lp-on-line { bottom: 10px; animation: lp-roll 9s ease-in-out infinite alternate; }
.lp-root .lp-scene-showroom { background: radial-gradient(ellipse at 50% 0%, #ffffff 0%, #e2e8f0 55%, #cbd5e1 100%); }
.lp-root .lp-spotlight {
  position: absolute; left: 50%; top: -20px; width: 70%; height: 150px; transform: translateX(-50%);
  background: radial-gradient(ellipse at 50% 0%, rgba(255,255,255,.95), rgba(255,255,255,0) 70%);
}
.lp-root .lp-scene-service { background: linear-gradient(180deg, #f1f5f9 0%, #e2e8f0 70%, #cbd5e1 100%); }
.lp-root .lp-lift { position: absolute; bottom: 0; width: 8px; height: 78px; background: linear-gradient(90deg, #f59e0b, #b45309); border-radius: 2px 2px 0 0; }
.lp-root .lp-lift-l { left: 14%; }
.lp-root .lp-lift-r { right: 14%; }
.lp-root .lp-raised { bottom: 14px; }
.lp-root .lp-scene-service::after { content: ''; position: absolute; left: 12%; right: 12%; bottom: 22px; height: 4px; background: #92400e; border-radius: 2px; }
.lp-root .lp-scene-night { background: radial-gradient(ellipse at 70% 110%, #1e3a8a 0%, #0b1630 60%, #050b1a 100%); }
.lp-root .lp-signal { position: absolute; left: 50%; top: 6px; width: 54px; transform: translateX(-50%); fill: none; stroke: #67e8f9; stroke-width: 2.4; stroke-linecap: round; }
.lp-root .lp-signal path { opacity: .25; animation: lp-signal 2.4s ease-in-out infinite; }
.lp-root .lp-signal path:nth-child(2) { animation-delay: .3s; }
.lp-root .lp-signal path:nth-child(3) { animation-delay: .6s; }
.lp-root .lp-studio { position: relative; height: 150px; background: linear-gradient(180deg, #f8fafc 0%, #e2e8f0 62%, #cbd5e1 63%, #f1f5f9 100%); }
.lp-root .lp-studio-car { position: absolute; left: 5%; bottom: 2px; width: 90%; transition: transform .4s cubic-bezier(.2,.7,.2,1); }
.lp-root .group:hover .lp-studio-car { transform: translateX(6px); }
.lp-root .lp-hero-car { filter: drop-shadow(0 18px 30px rgba(0,0,0,.45)); }
/* a flow list drawn as a mini BPMN strip */
.lp-root .lp-flowstrip { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; position: relative; padding-left: 2px; }
.lp-root .lp-flowstrip::before { content: ''; position: absolute; left: 9px; top: 8px; bottom: 8px; width: 1.5px; background: #93c5fd; }
.lp-root .lp-fs-event { position: relative; display: block; width: 16px; height: 16px; border-radius: 50%; border: 1.5px solid #60a5fa; background: #fff; }
.lp-root .lp-fs-end { border-width: 3.5px; border-color: #f59e0b; }
.lp-root .lp-fs-task { position: relative; display: block; font-size: 12px; line-height: 1.3; color: #334155; background: #f0f9ff; border: 1.5px solid #7dd3fc; border-radius: 6px; padding: 5px 8px; }
@keyframes lp-belt { to { background-position: 20px 0; } }
@keyframes lp-roll { from { transform: translateX(-8%); } to { transform: translateX(8%); } }
@keyframes lp-signal { 0%, 100% { opacity: .2; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .lp-root *, .lp-root *::before, .lp-root *::after { animation: none !important; }
  .lp-root .lp-flow { stroke-dashoffset: 0; }
  .lp-root .lp-rise, .lp-root .lp-card { opacity: 1; }
}
`;

export default LandingPage;
