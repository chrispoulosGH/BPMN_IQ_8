import React, { useId } from 'react';

/**
 * Standard Motor Company logo (original artwork). The mark is a steel-ringed
 * badge whose "S" is a BPMN sequence flow: a start event, a routed flow and
 * an end event, which is the company's processes, literally.
 *
 *   <SmcMark size={40} />                 the badge alone
 *   <SmcLogo tone="dark" />               badge + wordmark, for dark backgrounds
 *   <SmcLogo tone="light" />              badge + wordmark, for light backgrounds
 */

export const SmcMark: React.FC<{ size?: number; className?: string; title?: string }> = ({ size = 40, className, title = 'Standard Motor Company' }) => {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const ring = `smc-ring-${uid}`;
  const face = `smc-face-${uid}`;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={className} role="img" aria-label={title}>
      <title>{title}</title>
      <defs>
        <linearGradient id={ring} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#f8fafc" />
          <stop offset="45%" stopColor="#94a3b8" />
          <stop offset="70%" stopColor="#e2e8f0" />
          <stop offset="100%" stopColor="#64748b" />
        </linearGradient>
        <radialGradient id={face} cx="35%" cy="30%" r="80%">
          <stop offset="0%" stopColor="#1e3a8a" />
          <stop offset="100%" stopColor="#0b1630" />
        </radialGradient>
      </defs>
      <circle cx="32" cy="32" r="30" fill={`url(#${face})`} stroke={`url(#${ring})`} strokeWidth="3.5" />
      <circle cx="32" cy="32" r="25.5" fill="none" stroke="#94a3b8" strokeOpacity="0.35" strokeWidth="0.8" />
      {/* the S: start event → flow → end event */}
      <circle cx="43" cy="19.5" r="3.6" fill="none" stroke="#e2e8f0" strokeWidth="1.6" />
      <path
        d="M39.4 19.5 H25 Q18.5 19.5 18.5 25.75 Q18.5 32 25 32 H39 Q45.5 32 45.5 38.25 Q45.5 44.5 39 44.5 H27.4"
        fill="none" stroke="#e2e8f0" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"
      />
      <path d="M28.6 41.4 L24.6 44.5 L28.6 47.6" fill="none" stroke="#e2e8f0" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="20.8" cy="44.5" r="3.4" fill="#0b1630" stroke="#f59e0b" strokeWidth="2.6" />
    </svg>
  );
};

export const SmcLogo: React.FC<{ tone?: 'dark' | 'light'; size?: number; className?: string }> = ({ tone = 'dark', size = 40, className }) => {
  const main = tone === 'dark' ? '#ffffff' : '#0b1630';
  const sub = tone === 'dark' ? '#cbd5e1' : '#475569';
  return (
    <span className={`inline-flex items-center gap-3 ${className || ''}`}>
      <SmcMark size={size} />
      <span className="flex flex-col leading-none" aria-hidden="true">
        <span style={{ color: main, fontWeight: 700, letterSpacing: '0.22em', fontSize: size * 0.42 }}>STANDARD</span>
        <span style={{ color: sub, fontWeight: 500, letterSpacing: '0.32em', fontSize: size * 0.24, marginTop: size * 0.1 }}>MOTOR COMPANY</span>
      </span>
    </span>
  );
};

export default SmcLogo;
