import React, { useId } from 'react';

/**
 * Original vector vehicle renderings for Standard Motor Company pages (no
 * photos, no real makes or models). Conventional proportions, side profile
 * facing right, on a 400 × 160 canvas with the ground at y = 140.
 *
 * Studio-render techniques: metallic paint with a sky-to-ground horizon
 * reflection and a shoulder highlight, tinted glass with a reflection streak
 * and chrome trim, alloy wheels with brake discs and calipers, dark wheel-arch
 * gaps, contact and ambient shadows, and an optional floor reflection.
 *
 *   body    sedan | suv | pickup | ev
 *   finish  paint (default) | primer (unpainted, the Build stage) | blueprint (outline, the Design stage)
 */

export type VehicleBody = 'sedan' | 'suv' | 'pickup' | 'ev';
export type VehicleFinish = 'paint' | 'primer' | 'blueprint';

const GROUND = 140;

interface Shape {
  body: string;
  /** Side glass (daylight opening). */
  glass: string;
  /** Pillars between the side windows, painted black. */
  pillars: Array<[number, number, number, number]>;
  /** Shut lines (doors, tailgate, hood). */
  gaps: string[];
  /** Bright specular line just under the beltline. */
  shoulder: string;
  wheels: [number, number];
  wheelY: number;
  tireR: number;
  archR: number;
  rim: 'alloy' | 'aero' | 'truck';
  /** Topmost body y, beltline y and lowest body y; these drive the paint reflection. */
  top: number;
  belt: number;
  bottom: number;
  head: string;
  headInner?: string;
  drl?: string;
  tail: string;
  mirror: string;
  handles: Array<[number, number]>;
  /** Black trim: grille, intakes, diffuser, cladding. */
  trim: string[];
  /** Bright trim: grille surround, bumper, roof rails. */
  chrome?: string[];
  roofRails?: string;
}

const SHAPES: Record<VehicleBody, Shape> = {
  // Mid-size sedan: 4.9 m long, 2.85 m wheelbase, 1.45 m tall.
  sedan: {
    body: 'M24 120 C21 110 21 96 24 88 L28 78 C30 72 38 69 52 68 L100 66 C118 64 128 60 136 54 C152 42 172 36 200 35 L236 35 C258 36 274 44 294 58 C300 62 306 64 316 65 L356 70 C370 72 378 76 381 84 C384 92 384 104 381 114 C380 120 376 122 370 122 L332.4 122 A28 28 0 1 0 277.6 122 L122.4 122 A28 28 0 1 0 67.6 122 L30 122 C26 122 24 121 24 120 Z',
    glass: 'M150 66 C162 52 178 43 203 41 L232 41 C250 42 265 49 281 62 C283 64 282 66 279 66 Z',
    pillars: [[208, 40, 6, 27]],
    gaps: ['M214 68 C216 86 216 104 213 120', 'M282 67 C285 82 285 96 279 108', 'M151 68 C148 86 142 100 126 110', 'M300 63 C312 66 330 68 352 71'],
    shoulder: 'M30 80 C120 75 250 74 378 84',
    wheels: [95, 305], wheelY: 116, tireR: 24, archR: 28, rim: 'alloy',
    top: 35, belt: 67, bottom: 122,
    head: 'M350 71 C362 72 374 76 380 83 L377 88 C366 85 356 80 348 76 Z',
    headInner: 'M358 76 C364 77 370 80 374 83',
    drl: 'M352 74 C362 75 371 79 377 84',
    tail: 'M24 86 L52 79 L54 85 L26 93 Z',
    mirror: 'M283 61 C289 57 298 57 300 61 L299 67 C293 68 287 68 284 66 Z',
    handles: [[240, 76], [178, 76]],
    trim: ['M360 104 L382 103 L381 114 L364 114 Z', 'M24 110 L64 110 L62 120 L26 120 Z', 'M124 117 L276 117 L276 121 L124 121 Z'],
    chrome: ['M150 66.5 L279 66.5'],
  },
  // Compact crossover SUV: 4.6 m long, 2.7 m wheelbase, 1.7 m tall.
  suv: {
    body: 'M32 118 C29 108 29 94 31 84 L38 56 C42 40 50 31 66 28 L230 21 C250 22 268 34 290 52 L352 60 C368 62 377 68 380 78 C383 88 383 102 380 112 C379 118 375 120 368 120 L328.2 120 A31 31 0 1 0 267.8 120 L128.2 120 A31 31 0 1 0 67.8 120 L38 120 C34 120 32 119 32 118 Z',
    glass: 'M52 56 L58 37 C60 33 64 32 70 32 L226 27 C244 28 259 38 276 52 C278 54 277 56 274 56 Z',
    pillars: [[108, 29, 9, 28], [194, 27, 7, 30]],
    gaps: ['M201 58 C203 78 203 96 200 112', 'M277 57 C280 74 280 90 272 100', 'M117 58 C116 78 114 92 128 104', 'M36 58 L46 58', 'M292 54 C310 57 330 59 350 61'],
    shoulder: 'M36 63 C130 60 260 60 378 72',
    wheels: [98, 298], wheelY: 113, tireR: 27, archR: 31, rim: 'alloy',
    top: 21, belt: 56, bottom: 120,
    head: 'M348 62 C360 63 373 67 379 73 L377 78 C366 75 356 70 346 66 Z',
    drl: 'M350 64 C361 65 371 69 377 74',
    tail: 'M37 50 L48 50 C50 50 51 52 51 54 L51 60 L34 66 Z',
    mirror: 'M272 52 C278 48 288 48 290 52 L289 58 C283 59 277 59 274 57 Z',
    handles: [[236, 66], [158, 66]],
    trim: [
      'M364 82 L381 84 L381 100 L366 98 Z',
      'M31 106 L64 108 L62 118 L34 118 Z',
      'M127 108 L269 108 L269 120 L127 120 Z',
      'M62 120 A36 36 0 0 1 134 120 L128.2 120 A31 31 0 0 0 67.8 120 Z',
      'M262 120 A36 36 0 0 1 334 120 L328.2 120 A31 31 0 0 0 267.8 120 Z',
      'M354 104 L381 104 L380 112 L358 112 Z',
    ],
    chrome: ['M52 56.5 L274 56.5'],
    roofRails: 'M76 25 L222 18',
  },
  // Crew-cab full-size pickup: 5.8 m long, 3.7 m wheelbase, 1.95 m tall.
  pickup: {
    body: 'M22 118 L22 66 L24 62 L150 62 L154 62 L156 30 C156 24 160 21 168 21 L252 20 C266 21 278 32 294 50 L360 56 C372 57 379 62 381 70 L382 108 C382 116 378 118 372 118 L351.8 118 A29 29 0 1 0 294.2 118 L120.8 118 A29 29 0 1 0 63.2 118 Z',
    glass: 'M162 52 L163 30 C163 27 165 26 168 26 L250 25 C262 26 272 36 284 50 C285 51 284 52 282 52 Z',
    pillars: [[222, 25, 6, 28]],
    gaps: ['M228 54 L229 110', 'M286 53 C289 70 289 90 284 104', 'M161 54 L161 110', 'M152 62 L152 114', 'M26 66 L26 114', 'M296 52 C318 54 340 56 358 57'],
    shoulder: 'M24 70 L150 70 M158 60 C220 58 300 59 380 66',
    wheels: [92, 323], wheelY: 115, tireR: 25, archR: 29, rim: 'truck',
    top: 20, belt: 52, bottom: 118,
    head: 'M352 58 C364 59 375 62 381 68 L380 76 C370 73 360 67 350 62 Z',
    drl: 'M354 60 C364 61 373 64 379 69',
    tail: 'M22 66 L30 66 L30 92 L22 92 Z',
    mirror: 'M280 46 C286 42 298 42 300 47 L299 56 C292 57 285 57 282 54 Z',
    handles: [[262, 62], [190, 62], [60, 68]],
    trim: ['M364 76 L382 78 L382 98 L366 96 Z', 'M124 112 L292 112 L292 116 L124 116 Z', 'M22 108 L60 108 L60 116 L22 116 Z'],
    chrome: ['M364 76 L382 78 L382 98 L366 96 Z', 'M360 100 L382 100 L382 112 L362 112 Z', 'M24 62.5 L150 62.5', 'M162 52.5 L282 52.5'],
  },
  // Electric fastback sedan: 4.8 m long, 2.9 m wheelbase, 1.45 m tall.
  ev: {
    body: 'M24 120 C21 110 21 98 24 90 L28 82 C31 76 38 73 52 72 L92 70 C120 64 146 48 176 40 C190 37 204 36 218 36 L238 36 C258 37 276 46 298 60 C304 63 310 65 320 66 L358 72 C371 74 379 79 382 87 C384 95 384 106 381 114 C380 120 376 122 370 122 L332.4 122 A28 28 0 1 0 277.6 122 L122.4 122 A28 28 0 1 0 67.6 122 L30 122 C26 122 24 121 24 120 Z',
    glass: 'M140 66 C158 54 180 43 210 41 L236 41 C254 42 270 50 288 62 C290 64 289 66 286 66 Z',
    pillars: [[214, 40, 6, 27]],
    gaps: ['M220 68 C222 86 222 104 219 120', 'M289 67 C292 82 292 96 286 108', 'M141 68 C138 86 134 100 124 110', 'M304 64 C318 67 336 69 356 72'],
    shoulder: 'M30 84 C130 76 250 75 380 88',
    wheels: [95, 305], wheelY: 116, tireR: 24, archR: 28, rim: 'aero',
    top: 36, belt: 67, bottom: 122,
    head: 'M346 73 C358 74 372 79 381 86 L380 89 C370 85 356 79 344 76 Z',
    drl: 'M348 74 C360 75 372 80 380 86',
    tail: 'M24 88 L50 82 L51 86 L25 92 Z',
    mirror: 'M290 62 C296 58 305 58 307 62 L306 68 C300 69 294 69 291 67 Z',
    handles: [[246, 77], [184, 77]],
    trim: ['M364 106 L382 105 L381 114 L366 114 Z', 'M24 112 L60 112 L58 120 L26 120 Z', 'M124 117 L276 117 L276 121 L124 121 Z'],
    chrome: ['M140 66.5 L286 66.5'],
  },
};

type Paint = [string, string, string, string]; // light, base, mid, dark
const PAINTS: Record<string, Paint> = {
  silver: ['#f8fafc', '#c6ccd4', '#8a929d', '#2c3138'],
  red: ['#ff9a9a', '#c8102e', '#7a0a1c', '#22030a'],
  blue: ['#a9c8ff', '#1f4fbf', '#13306f', '#050d24'],
  green: ['#b3dccc', '#23634f', '#123a2f', '#05130e'],
  graphite: ['#c2c8d0', '#4b5360', '#2a2f37', '#0b0e12'],
  white: ['#ffffff', '#eef1f4', '#c3c9d1', '#5f6874'],
  amber: ['#f6d3a3', '#9a5a24', '#5e3414', '#1d0e04'],
};
const PRIMER: Paint = ['#eceef1', '#b9bdc3', '#9ea3aa', '#6b7078'];

export interface VehicleArtProps {
  body: VehicleBody;
  paint?: keyof typeof PAINTS;
  finish?: VehicleFinish;
  /** Headlights and tail lights lit (night scenes). */
  lightsOn?: boolean;
  /** Ground shadow under the car. */
  shadow?: boolean;
  /** Faint mirror image on a glossy studio floor. */
  reflection?: boolean;
  className?: string;
  style?: React.CSSProperties;
  title?: string;
}

function Wheel({ x, y, r, rim, ids, blueprint }: { x: number; y: number; r: number; rim: Shape['rim']; ids: Record<string, string>; blueprint: boolean }) {
  const rimR = r * 0.68;
  if (blueprint) {
    return (
      <g fill="none" stroke="currentColor" strokeWidth={1.3}>
        <circle cx={x} cy={y} r={r} />
        <circle cx={x} cy={y} r={rimR} strokeDasharray="3 3" />
        <line x1={x - r - 6} y1={y} x2={x + r + 6} y2={y} strokeWidth={0.7} />
        <line x1={x} y1={y - r - 6} x2={x} y2={y + r + 6} strokeWidth={0.7} />
      </g>
    );
  }
  const spokeCount = rim === 'truck' ? 6 : rim === 'aero' ? 5 : 10;
  const spokes = Array.from({ length: spokeCount }, (_, i) => {
    const a = (i / spokeCount) * Math.PI * 2 - Math.PI / 2;
    const w0 = rim === 'alloy' ? 0.13 : 0.24;
    const w1 = rim === 'alloy' ? 0.07 : rim === 'truck' ? 0.2 : 0.3;
    const p = (ang: number, rad: number) => `${(x + Math.cos(ang) * rad).toFixed(2)},${(y + Math.sin(ang) * rad).toFixed(2)}`;
    return <polygon key={i} points={`${p(a - w0, 4.5)} ${p(a - w1, rimR - 0.8)} ${p(a + w1, rimR - 0.8)} ${p(a + w0, 4.5)}`} fill={`url(#${ids.spoke})`} />;
  });
  return (
    <g>
      {/* tire */}
      <circle cx={x} cy={y} r={r} fill={`url(#${ids.tire})`} />
      <circle cx={x} cy={y} r={r - 0.8} fill="none" stroke="#000" strokeOpacity={0.5} strokeWidth={1.2} />
      <circle cx={x} cy={y} r={rimR + 2.6} fill="none" stroke="#3a3f47" strokeWidth={1} />
      {/* brake disc and caliper behind the spokes */}
      <circle cx={x} cy={y} r={rimR - 1} fill={`url(#${ids.disc})`} />
      <path d={`M${x + rimR * 0.35} ${y - rimR * 0.78} A${rimR * 0.85} ${rimR * 0.85} 0 0 1 ${x + rimR * 0.84} ${y - rimR * 0.2} L${x + rimR * 0.56} ${y - rimR * 0.12} A${rimR * 0.58} ${rimR * 0.58} 0 0 0 ${x + rimR * 0.22} ${y - rimR * 0.53} Z`} fill={rim === 'truck' ? '#4b5563' : '#9f1d24'} />
      {rim === 'aero' ? <circle cx={x} cy={y} r={rimR - 1} fill={`url(#${ids.aero})`} opacity={0.9} /> : null}
      {spokes}
      {/* rim lip */}
      <circle cx={x} cy={y} r={rimR} fill="none" stroke={`url(#${ids.lip})`} strokeWidth={1.8} />
      <circle cx={x} cy={y} r={4.2} fill={`url(#${ids.spoke})`} stroke="#4b5563" strokeWidth={0.6} />
      <circle cx={x} cy={y} r={1.6} fill="#1f2937" />
    </g>
  );
}

const VehicleArt: React.FC<VehicleArtProps> = ({ body, paint = 'silver', finish = 'paint', lightsOn = false, shadow = true, reflection = false, className, style, title }) => {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const s = SHAPES[body];
  const blueprint = finish === 'blueprint';
  const primer = finish === 'primer';
  const [light, base, mid, dark] = primer ? PRIMER : PAINTS[paint] || PAINTS.silver;
  const id = (k: string) => `va-${k}-${uid}`;
  const ids = { paint: id('paint'), gloss: id('gloss'), glass: id('glass'), tire: id('tire'), disc: id('disc'), spoke: id('spoke'), lip: id('lip'), aero: id('aero'), soft: id('soft'), glow: id('glow'), car: id('car'), fade: id('fade'), mask: id('mask'), lens: id('lens'), tail: id('tail') };

  // Paint: sky reflection on the upper body, a bright shoulder just under the
  // beltline, then the dark horizon (ground reflection) and a little floor bounce.
  const H = s.bottom - s.top;
  const at = (y: number) => Math.min(1, Math.max(0, (y - s.top) / H)).toFixed(3);
  const lower = s.bottom - s.belt;
  const stops: Array<[string, string]> = primer
    ? [['0', light], [at(s.belt), base], ['1', mid]]
    : [
      ['0', light],
      [at(s.belt - 8), base],
      [at(s.belt + 1), mid],
      [at(s.belt + 4), light],
      [at(s.belt + 9), base],
      [at(s.belt + lower * 0.42), mid],
      [at(s.belt + lower * 0.6), dark],
      [at(s.belt + lower * 0.85), mid],
      ['1', dark],
    ];

  const car = blueprint ? (
    <g fill="none" stroke="currentColor" strokeLinejoin="round">
      <path d={s.body} strokeWidth={1.7} />
      <path d={s.glass} strokeWidth={1.1} strokeDasharray="4 3" />
      {s.gaps.map((d) => <path key={d} d={d} strokeWidth={0.9} strokeDasharray="2 3" />)}
      {s.roofRails ? <path d={s.roofRails} strokeWidth={1.2} /> : null}
      <path d={s.head} strokeWidth={0.9} />
      <path d={s.tail} strokeWidth={0.9} />
      {s.trim.map((d) => <path key={d} d={d} strokeWidth={0.6} opacity={0.7} />)}
      <g strokeWidth={0.7} opacity={0.8}>
        <line x1={22} y1={150} x2={384} y2={150} />
        <line x1={22} y1={145} x2={22} y2={155} />
        <line x1={384} y1={145} x2={384} y2={155} />
        <line x1={s.wheels[0]} y1={146} x2={s.wheels[0]} y2={154} />
        <line x1={s.wheels[1]} y1={146} x2={s.wheels[1]} y2={154} />
      </g>
      <Wheel x={s.wheels[0]} y={s.wheelY} r={s.tireR} rim={s.rim} ids={ids} blueprint />
      <Wheel x={s.wheels[1]} y={s.wheelY} r={s.tireR} rim={s.rim} ids={ids} blueprint />
    </g>
  ) : (
    <g id={ids.car}>
      {/* dark wheel-arch openings */}
      <circle cx={s.wheels[0]} cy={s.wheelY} r={s.archR - 0.5} fill="#07090d" />
      <circle cx={s.wheels[1]} cy={s.wheelY} r={s.archR - 0.5} fill="#07090d" />
      {/* body */}
      <path d={s.body} fill={`url(#${ids.paint})`} />
      {!primer && <path d={s.body} fill={`url(#${ids.gloss})`} />}
      <path d={s.body} fill="none" stroke={dark} strokeOpacity={0.6} strokeWidth={0.8} />
      {s.trim.map((d) => <path key={d} d={d} fill="#14171c" />)}
      {s.chrome?.map((d) => (d.endsWith('Z')
        ? <path key={d} d={d} fill="none" stroke="#e5e7eb" strokeWidth={1.4} />
        : <path key={d} d={d} fill="none" stroke="#e5e7eb" strokeWidth={1.2} strokeLinecap="round" />))}
      {s.roofRails ? <path d={s.roofRails} fill="none" stroke="#1f2329" strokeWidth={3.2} strokeLinecap="round" /> : null}
      {/* glass with chrome surround */}
      <path d={s.glass} fill={`url(#${ids.glass})`} stroke="#d4d8de" strokeWidth={1} />
      {s.pillars.map(([x, y, w, h]) => <rect key={x} x={x} y={y} width={w} height={h} fill="#0b0d11" />)}
      {/* shut lines and shoulder highlight */}
      {s.gaps.map((d) => <path key={d} d={d} fill="none" stroke="#000" strokeOpacity={0.45} strokeWidth={0.8} />)}
      {!primer && <path d={s.shoulder} fill="none" stroke="#fff" strokeOpacity={0.75} strokeWidth={1.1} filter={`url(#${ids.soft})`} />}
      {s.handles.map(([x, y]) => <rect key={`${x}-${y}`} x={x} y={y} width={13} height={2.6} rx={1.3} fill={primer ? '#8b9097' : '#dfe3e8'} stroke="#4b5563" strokeWidth={0.4} />)}
      <path d={s.mirror} fill={`url(#${ids.paint})`} stroke={dark} strokeOpacity={0.6} strokeWidth={0.6} />
      {/* lights */}
      {lightsOn ? <path d={s.head} fill="#fffbe6" filter={`url(#${ids.glow})`} /> : null}
      <path d={s.head} fill={`url(#${ids.lens})`} stroke="#6b7280" strokeWidth={0.5} />
      {s.headInner ? <path d={s.headInner} fill="none" stroke="#94a3b8" strokeWidth={0.8} /> : null}
      {s.drl ? <path d={s.drl} fill="none" stroke={lightsOn ? '#ffffff' : '#f1f5f9'} strokeWidth={1.1} strokeLinecap="round" /> : null}
      {lightsOn ? <path d={s.tail} fill="#ff2d4a" filter={`url(#${ids.glow})`} /> : null}
      <path d={s.tail} fill={`url(#${ids.tail})`} stroke="#4c0519" strokeWidth={0.4} />
      {/* wheels */}
      <Wheel x={s.wheels[0]} y={s.wheelY} r={s.tireR} rim={s.rim} ids={ids} blueprint={false} />
      <Wheel x={s.wheels[1]} y={s.wheelY} r={s.tireR} rim={s.rim} ids={ids} blueprint={false} />
    </g>
  );

  return (
    <svg viewBox="0 0 400 160" className={className} style={style} role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      {title ? <title>{title}</title> : null}
      <defs>
        <linearGradient id={ids.paint} gradientUnits="userSpaceOnUse" x1="0" y1={s.top} x2="0" y2={s.bottom}>
          {stops.map(([o, c], i) => <stop key={i} offset={o} stopColor={c} />)}
        </linearGradient>
        <linearGradient id={ids.gloss} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#fff" stopOpacity="0" />
          <stop offset="28%" stopColor="#fff" stopOpacity="0.16" />
          <stop offset="40%" stopColor="#fff" stopOpacity="0" />
          <stop offset="66%" stopColor="#fff" stopOpacity="0.1" />
          <stop offset="80%" stopColor="#000" stopOpacity="0.08" />
          <stop offset="100%" stopColor="#000" stopOpacity="0.12" />
        </linearGradient>
        <linearGradient id={ids.glass} x1="0" y1="0" x2="1" y2="0.5">
          <stop offset="0%" stopColor="#0b1018" />
          <stop offset="40%" stopColor="#1d2733" />
          <stop offset="47%" stopColor="#7d8b9c" />
          <stop offset="52%" stopColor="#2a3542" />
          <stop offset="74%" stopColor="#111821" />
          <stop offset="79%" stopColor="#4c5a6a" />
          <stop offset="83%" stopColor="#111821" />
          <stop offset="100%" stopColor="#05080c" />
        </linearGradient>
        <radialGradient id={ids.tire} cx="50%" cy="50%" r="50%">
          <stop offset="62%" stopColor="#2b3038" />
          <stop offset="80%" stopColor="#1c2026" />
          <stop offset="96%" stopColor="#0d0f13" />
          <stop offset="100%" stopColor="#050608" />
        </radialGradient>
        <radialGradient id={ids.disc} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#1f2329" />
          <stop offset="55%" stopColor="#3b4048" />
          <stop offset="75%" stopColor="#6b7078" />
          <stop offset="100%" stopColor="#2b2f36" />
        </radialGradient>
        <linearGradient id={ids.spoke} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#f8fafc" />
          <stop offset="50%" stopColor="#b8bfc8" />
          <stop offset="100%" stopColor="#6b7280" />
        </linearGradient>
        <linearGradient id={ids.lip} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="100%" stopColor="#7c8490" />
        </linearGradient>
        <radialGradient id={ids.aero} cx="40%" cy="35%" r="70%">
          <stop offset="0%" stopColor="#e5e7eb" />
          <stop offset="70%" stopColor="#8a929d" />
          <stop offset="100%" stopColor="#4b5563" />
        </radialGradient>
        <linearGradient id={ids.lens} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="55%" stopColor="#cbd5e1" />
          <stop offset="100%" stopColor="#64748b" />
        </linearGradient>
        <linearGradient id={ids.tail} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ff4d63" />
          <stop offset="55%" stopColor="#b3122b" />
          <stop offset="100%" stopColor="#5a0714" />
        </linearGradient>
        <filter id={ids.soft} x="-5%" y="-200%" width="110%" height="500%"><feGaussianBlur stdDeviation="0.6" /></filter>
        <filter id={ids.glow} x="-60%" y="-300%" width="220%" height="700%"><feGaussianBlur stdDeviation="3.5" /></filter>
        <filter id={ids.fade} x="-10%" y="-100%" width="120%" height="300%"><feGaussianBlur stdDeviation="4" /></filter>
        <linearGradient id={`${ids.mask}-g`} gradientUnits="userSpaceOnUse" x1="0" y1={GROUND} x2="0" y2={GROUND + 22}>
          <stop offset="0%" stopColor="#fff" stopOpacity="0.5" />
          <stop offset="100%" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <mask id={ids.mask} maskUnits="userSpaceOnUse" x="0" y={GROUND} width="400" height="22">
          <rect x="0" y={GROUND} width="400" height="22" fill={`url(#${ids.mask}-g)`} />
        </mask>
      </defs>

      {reflection && !blueprint ? (
        <g mask={`url(#${ids.mask})`} opacity={0.35}>
          <use href={`#${ids.car}`} transform={`translate(0 ${GROUND * 2}) scale(1 -1)`} />
        </g>
      ) : null}

      {shadow && !blueprint ? (
        <g>
          <ellipse cx="203" cy={GROUND} rx="182" ry="7" fill="#000" opacity="0.28" filter={`url(#${ids.fade})`} />
          <ellipse cx={(s.wheels[0] + s.wheels[1]) / 2} cy={GROUND - 2} rx={(s.wheels[1] - s.wheels[0]) / 2} ry="4" fill="#000" opacity="0.45" filter={`url(#${ids.soft})`} />
          <ellipse cx={s.wheels[0]} cy={GROUND} rx={s.tireR * 1.05} ry="2.6" fill="#000" opacity="0.75" filter={`url(#${ids.soft})`} />
          <ellipse cx={s.wheels[1]} cy={GROUND} rx={s.tireR * 1.05} ry="2.6" fill="#000" opacity="0.75" filter={`url(#${ids.soft})`} />
        </g>
      ) : null}

      {car}
    </svg>
  );
};

export default VehicleArt;
