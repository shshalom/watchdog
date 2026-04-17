import { type ReactNode } from 'react';

// Stat Chip - compact icon + label pair
export function StatChip({ icon, label, color }: { icon: ReactNode; label: string; color: string }) {
  return (
    <span className="inline-flex items-center gap-1" style={{ color }}>
      {icon}
      <span className="text-[10px] font-medium">{label}</span>
    </span>
  );
}

// Context Mini Bar - tiny capsule progress bar
export function ContextMiniBar({ percent, isDead = false, width = 40 }: { percent: number; isDead?: boolean; width?: number }) {
  const barColor = isDead ? 'rgba(107,114,128,0.3)' : percent > 0.8 ? '#ef4444' : percent > 0.6 ? '#eab308' : '#22c55e';
  return (
    <div className="relative h-[5px] rounded-full overflow-hidden" style={{ width, background: 'rgba(255,255,255,0.08)' }}>
      <div className="absolute inset-y-0 left-0 rounded-full transition-all duration-300" style={{ width: `${percent * 100}%`, background: barColor }} />
    </div>
  );
}

// Dot Separator
export function DotSep({ size = 3 }: { size?: number }) {
  return <span className="inline-block rounded-full bg-white/10" style={{ width: size, height: size }} />;
}

// Glass Button (collapsed panel button)
export function GlassButton({ icon, badge, badgeColor = '#ef4444', onClick }: {
  icon: ReactNode;
  badge?: number;
  badgeColor?: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="relative w-[34px] h-[34px] rounded-[10px] glass flex items-center justify-center text-white/80 hover:text-white hover:bg-white/8 transition-all cursor-pointer"
    >
      {icon}
      {badge != null && badge > 0 && (
        <span
          className="absolute -top-1 -right-1 min-w-[14px] h-[14px] flex items-center justify-center rounded-full text-[9px] font-bold text-white"
          style={{ background: badgeColor }}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

// Panel Header
export function PanelHeader({ icon, title, trailing, onClose }: {
  icon: ReactNode;
  title: string;
  trailing?: ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="flex items-center gap-2 px-4 pt-3.5 pb-2.5">
      <span className="text-white/40">{icon}</span>
      <span className="text-lg font-semibold">{title}</span>
      <div className="flex-1" />
      {trailing}
      <button onClick={onClose} className="text-white/30 hover:text-white/60 transition-colors cursor-pointer">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10" opacity="0.3" /><path d="M15 9l-6 6M9 9l6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
      </button>
    </div>
  );
}

// Search Bar
export function SearchBar({ value, onChange, placeholder = 'Search...' }: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5">
      <svg className="w-3.5 h-3.5 text-white/20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
      </svg>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="flex-1 bg-transparent text-sm text-white placeholder-white/20 outline-none"
      />
      {value && (
        <button onClick={() => onChange('')} className="text-white/20 hover:text-white/40 cursor-pointer">
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <circle cx="12" cy="12" r="10" /><path d="M15 9l-6 6M9 9l6 6" />
          </svg>
        </button>
      )}
    </div>
  );
}

// Filter Pill
export function FilterPill({ label, count, active, onClick }: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-2 py-0.5 text-xs rounded-full transition-colors cursor-pointer ${active ? 'bg-white/10 text-white font-semibold' : 'text-white/30 hover:text-white/50'}`}
    >
      {label}
      {count != null && <span className="ml-1 text-[10px] text-white/20">{count}</span>}
    </button>
  );
}

// Divider
export function Divider() {
  return <div className="h-px bg-white/5" />;
}

// Empty State
export function EmptyState({ icon, title, subtitle, action }: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="w-14 h-14 rounded-full glass flex items-center justify-center">
        {icon}
      </div>
      <div>
        <p className="font-semibold">{title}</p>
        <p className="text-sm text-white/40 mt-1 whitespace-pre-line">{subtitle}</p>
      </div>
      {action}
    </div>
  );
}

// Extension color badge
export function ExtBadge({ ext, color }: { ext: string; color: string }) {
  return (
    <div className="w-7 h-7 rounded-md flex items-center justify-center" style={{ background: `${color}22` }}>
      <span className="text-[8px] font-bold font-mono" style={{ color }}>{ext}</span>
    </div>
  );
}
