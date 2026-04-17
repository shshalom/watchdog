import { useState, useRef, useEffect } from 'react';

// ---------------------------------------------------------------------------
// Types & persistence
// ---------------------------------------------------------------------------

export interface GraphSettings {
  connectionMode: 'references' | 'temporal';
  repulsionForce: number;
  sizeFactor: number;
  lineWidth: number;
  gridOpacity: number;
  showFileTypes: boolean;
  ambientMotion: boolean;
  showClusters: boolean;
  clusterOpacity: number;
  showDeleted: boolean;
  minCollapse: number;
}

export const DEFAULT_GRAPH_SETTINGS: GraphSettings = {
  connectionMode: 'references',
  repulsionForce: 70,
  sizeFactor: 2.5,
  lineWidth: 1.0,
  gridOpacity: 3,
  showFileTypes: true,
  ambientMotion: true,
  showClusters: true,
  clusterOpacity: 8,
  showDeleted: true,
  minCollapse: 4,
};

const STORAGE_KEY = 'watchdog_graph_settings';

export function loadGraphSettings(): GraphSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULT_GRAPH_SETTINGS, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { ...DEFAULT_GRAPH_SETTINGS };
}

export function saveGraphSettings(s: GraphSettings): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function SectionLabel({ children }: { children: string }) {
  return (
    <p className="text-[9px] font-semibold tracking-widest uppercase text-white/25 mt-1">
      {children}
    </p>
  );
}

function ParamSlider({
  label, value, min, max, step, format, onChange,
}: {
  label: string; value: number; min: number; max: number;
  step: number; format: (v: number) => string; onChange: (v: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-white/50 select-none">{label}</span>
        <span className="text-[11px] font-mono text-white/70 tabular-nums select-none">{format(value)}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        className="w-full h-[3px] appearance-none rounded-full bg-white/10 cursor-pointer accent-white/70
          [&::-webkit-slider-thumb]:appearance-none
          [&::-webkit-slider-thumb]:w-[13px] [&::-webkit-slider-thumb]:h-[13px]
          [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white/80
          [&::-webkit-slider-thumb]:shadow-[0_0_6px_rgba(255,255,255,0.25)]
          [&::-webkit-slider-thumb]:hover:bg-white [&::-webkit-slider-thumb]:cursor-pointer
          [&::-moz-range-thumb]:w-[13px] [&::-moz-range-thumb]:h-[13px]
          [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-white/80
          [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:cursor-pointer
          [&::-moz-range-track]:bg-white/10 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:h-[3px]"
      />
    </div>
  );
}

function ToggleRow({
  label, checked, onChange, children,
}: {
  label: string; checked: boolean; onChange: (v: boolean) => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-white/60 select-none">{label}</span>
        <button
          type="button"
          onClick={() => onChange(!checked)}
          style={{
            width: 34, height: 20, borderRadius: 10, flexShrink: 0, cursor: 'pointer',
            position: 'relative', border: 'none', outline: 'none', overflow: 'hidden',
            background: checked ? '#3b82f6' : 'rgba(255,255,255,0.15)',
            transition: 'background 0.2s',
          }}
        >
          <span style={{
            position: 'absolute', top: 3, left: checked ? 17 : 3,
            width: 14, height: 14, borderRadius: '50%', background: 'white',
            boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
            transition: 'left 0.2s',
          }} />
        </button>
      </div>
      {checked && children && (
        <div className="pl-2">{children}</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main popover
// ---------------------------------------------------------------------------

interface GraphSettingsProps {
  isOpen: boolean;
  onClose: () => void;
  settings: GraphSettings;
  onSettingsChange: (s: GraphSettings) => void;
}

export function GraphSettingsPopover({ isOpen, onClose, settings, onSettingsChange }: GraphSettingsProps) {
  const [savedFlash, setSavedFlash] = useState(false);

  if (!isOpen) return null;

  const update = (patch: Partial<GraphSettings>) => {
    const next = { ...settings, ...patch };
    onSettingsChange(next);
    saveGraphSettings(next);
  };

  const handleReset = () => {
    onSettingsChange({ ...DEFAULT_GRAPH_SETTINGS });
    saveGraphSettings({ ...DEFAULT_GRAPH_SETTINGS });
  };

  const handleSave = () => {
    saveGraphSettings(settings);
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1500);
  };

  const fmtInt = (v: number) => `${Math.round(v)}`;
  const fmtDec = (v: number) => v.toFixed(1);
  const fmtPct = (v: number) => `${Math.round(v)}%`;

  return (
    <div
      className="glass-panel w-[270px] flex flex-col gap-0 animate-in fade-in zoom-in-95 duration-150 select-none overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
        <h3 className="text-[13px] font-semibold text-white/90">Graph Settings</h3>
        <button onClick={onClose} className="text-white/30 hover:text-white/60 transition-colors cursor-pointer">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </button>
      </div>

      {/* Scrollable content */}
      <div className="px-4 py-3 flex flex-col gap-3 overflow-y-auto max-h-[70vh]">

        {/* Connection mode */}
        <div>
          <SectionLabel>Connections</SectionLabel>
          <div className="flex rounded-full bg-white/[0.06] p-0.5 mt-1.5">
            {(['references', 'temporal'] as const).map(mode => (
              <button
                key={mode} type="button"
                onClick={() => update({ connectionMode: mode })}
                className={`flex-1 text-[11px] font-medium py-1 rounded-full transition-all duration-150 cursor-pointer ${
                  settings.connectionMode === mode
                    ? 'bg-white/[0.12] text-white/90 shadow-sm'
                    : 'text-white/40 hover:text-white/60'
                }`}
              >
                {mode === 'references' ? 'References' : 'Temporal'}
              </button>
            ))}
          </div>
        </div>

        <div className="h-px bg-white/[0.06]" />

        {/* Sliders */}
        <div className="flex flex-col gap-2.5">
          <SectionLabel>Physics</SectionLabel>
          <ParamSlider label="Node Spacing" value={settings.repulsionForce} min={20} max={200} step={5} format={fmtInt} onChange={v => update({ repulsionForce: v })} />
          <ParamSlider label="Node Size" value={settings.sizeFactor} min={0.5} max={6.0} step={0.1} format={fmtDec} onChange={v => update({ sizeFactor: v })} />
          <ParamSlider label="Edge Width" value={settings.lineWidth} min={0.5} max={4.0} step={0.1} format={fmtDec} onChange={v => update({ lineWidth: v })} />
          <ParamSlider label="Grid Opacity" value={settings.gridOpacity} min={0} max={20} step={1} format={fmtPct} onChange={v => update({ gridOpacity: v })} />
        </div>

        <div className="h-px bg-white/[0.06]" />

        {/* Toggles */}
        <div className="flex flex-col gap-2">
          <SectionLabel>Display</SectionLabel>
          <ToggleRow label="File type labels" checked={settings.showFileTypes} onChange={v => update({ showFileTypes: v })} />
          <ToggleRow label="Ambient motion" checked={settings.ambientMotion} onChange={v => update({ ambientMotion: v })} />
          <ToggleRow label="Show deleted files" checked={settings.showDeleted} onChange={v => update({ showDeleted: v })} />
          <ToggleRow label="Cluster boundaries" checked={settings.showClusters} onChange={v => update({ showClusters: v })}>
            <ParamSlider label="Boundary opacity" value={settings.clusterOpacity} min={2} max={30} step={1} format={fmtPct} onChange={v => update({ clusterOpacity: v })} />
          </ToggleRow>
          <ToggleRow label="Collapse clusters" checked={settings.minCollapse > 0} onChange={v => update({ minCollapse: v ? 4 : 99 })}>
            <ParamSlider label="Min nodes" value={settings.minCollapse >= 99 ? 4 : settings.minCollapse} min={2} max={12} step={1} format={fmtInt} onChange={v => update({ minCollapse: v })} />
          </ToggleRow>
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between px-4 py-2.5 border-t border-white/[0.06]">
        <button
          type="button" onClick={handleReset}
          className="text-[11px] text-white/30 hover:text-white/60 transition-colors cursor-pointer"
        >
          Reset Defaults
        </button>
        <button
          type="button" onClick={handleSave}
          className={`text-[11px] font-medium px-3 py-1 rounded-full transition-all cursor-pointer ${
            savedFlash
              ? 'bg-green-500/20 text-green-400'
              : 'bg-white/8 text-white/60 hover:bg-white/12 hover:text-white/90'
          }`}
        >
          {savedFlash ? '✓ Saved' : 'Save'}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// GraphControlPill — top-centre graph mode toggle + in-place settings morph
// ---------------------------------------------------------------------------

export interface GraphControlPillProps {
  mode: 'references' | 'temporal';
  onChange: (m: 'references' | 'temporal') => void;
  settings: GraphSettings;
  onSettingsChange: (s: GraphSettings) => void;
}

export function GraphControlPill({ mode, onChange, settings, onSettingsChange }: GraphControlPillProps) {
  const [open, setOpen] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const pillRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onMouse = (e: MouseEvent) => {
      if (!pillRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onMouse);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouse);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const update = (patch: Partial<GraphSettings>) => {
    const next = { ...settings, ...patch };
    onSettingsChange(next);
    saveGraphSettings(next);
  };

  const handleReset = () => {
    onSettingsChange({ ...DEFAULT_GRAPH_SETTINGS });
    saveGraphSettings({ ...DEFAULT_GRAPH_SETTINGS });
  };

  const handleSave = () => {
    saveGraphSettings(settings);
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1500);
  };

  const fmtInt = (v: number) => `${Math.round(v)}`;
  const fmtDec = (v: number) => v.toFixed(1);
  const fmtPct = (v: number) => `${Math.round(v)}%`;

  return (
    <div
      ref={pillRef}
      className="glass overflow-hidden select-none"
      style={{
        borderRadius: open ? 16 : 9999,
        width: 270,
        // Staged transition: border-radius morphs first when opening, last when closing
        transition: open
          ? 'border-radius 180ms cubic-bezier(0.4,0,0.2,1) 0ms'
          : 'border-radius 180ms cubic-bezier(0.4,0,0.2,1) 220ms',
      }}
    >
      {/* Header row */}
      <div className="flex items-center px-2 py-1.5">

        {/* Mode buttons — slide out when open */}
        <div
          className="flex items-center overflow-hidden transition-all duration-300"
          style={{ maxWidth: open ? 0 : 240, opacity: open ? 0 : 1 }}
        >
          <button
            onClick={() => onChange('references')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs transition-all cursor-pointer whitespace-nowrap ${
              mode === 'references' ? 'bg-white/10 text-white font-semibold' : 'text-white/40 hover:text-white/60'
            }`}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
            </svg>
            References
          </button>
          <button
            onClick={() => onChange('temporal')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs transition-all cursor-pointer whitespace-nowrap ${
              mode === 'temporal' ? 'bg-white/10 text-white font-semibold' : 'text-white/40 hover:text-white/60'
            }`}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <polyline points="12 6 12 12 16 14"/>
            </svg>
            Temporal
          </button>
          <span className="text-white/15 select-none text-sm px-1">|</span>
        </div>

        {/* "Graph Settings" title — slides in when open */}
        <div
          className="flex-1 overflow-hidden transition-all duration-300"
          style={{ opacity: open ? 1 : 0 }}
        >
          <span className="text-xs font-semibold text-white/80 whitespace-nowrap pl-3">
            Graph Settings
          </span>
        </div>

        {/* Gear / close — always visible, right edge */}
        <button
          onClick={() => setOpen(v => !v)}
          className={`flex items-center justify-center w-8 h-8 rounded-full flex-shrink-0 transition-all cursor-pointer ${
            open ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white/70'
          }`}
          title={open ? 'Close settings' : 'Graph settings'}
        >
          {open ? (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12"/>
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/>
              <line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/>
              <line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/>
              <line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/>
              <line x1="17" y1="16" x2="23" y2="16"/>
            </svg>
          )}
        </button>
      </div>

      {/* Settings body — expands downward inside the same glass element */}
      <div
        className="overflow-hidden"
        style={{
          maxHeight: open ? 600 : 0,
          opacity: open ? 1 : 0,
          // Content expands after radius starts morphing; collapses immediately on close
          transition: open
            ? 'max-height 350ms cubic-bezier(0.4,0,0.2,1) 80ms, opacity 220ms ease 80ms'
            : 'max-height 220ms cubic-bezier(0.4,0,0.2,1) 0ms, opacity 150ms ease 0ms',
        }}
      >
        <div className="h-px bg-white/[0.06]" />

        <div className="px-4 py-3 flex flex-col gap-3 overflow-y-auto max-h-[70vh]">
          {/* Connection mode */}
          <div>
            <SectionLabel>Connections</SectionLabel>
            <div className="flex rounded-full bg-white/[0.06] p-0.5 mt-1.5">
              {(['references', 'temporal'] as const).map(m => (
                <button
                  key={m} type="button"
                  onClick={() => update({ connectionMode: m })}
                  className={`flex-1 text-[11px] font-medium py-1 rounded-full transition-all duration-150 cursor-pointer ${
                    settings.connectionMode === m
                      ? 'bg-white/[0.12] text-white/90 shadow-sm'
                      : 'text-white/40 hover:text-white/60'
                  }`}
                >
                  {m === 'references' ? 'References' : 'Temporal'}
                </button>
              ))}
            </div>
          </div>

          <div className="h-px bg-white/[0.06]" />

          <div className="flex flex-col gap-2.5">
            <SectionLabel>Physics</SectionLabel>
            <ParamSlider label="Node Spacing" value={settings.repulsionForce} min={20} max={200} step={5} format={fmtInt} onChange={v => update({ repulsionForce: v })} />
            <ParamSlider label="Node Size" value={settings.sizeFactor} min={0.5} max={6.0} step={0.1} format={fmtDec} onChange={v => update({ sizeFactor: v })} />
            <ParamSlider label="Edge Width" value={settings.lineWidth} min={0.5} max={4.0} step={0.1} format={fmtDec} onChange={v => update({ lineWidth: v })} />
            <ParamSlider label="Grid Opacity" value={settings.gridOpacity} min={0} max={20} step={1} format={fmtPct} onChange={v => update({ gridOpacity: v })} />
          </div>

          <div className="h-px bg-white/[0.06]" />

          <div className="flex flex-col gap-2">
            <SectionLabel>Display</SectionLabel>
            <ToggleRow label="File type labels" checked={settings.showFileTypes} onChange={v => update({ showFileTypes: v })} />
            <ToggleRow label="Ambient motion" checked={settings.ambientMotion} onChange={v => update({ ambientMotion: v })} />
            <ToggleRow label="Show deleted files" checked={settings.showDeleted} onChange={v => update({ showDeleted: v })} />
            <ToggleRow label="Cluster boundaries" checked={settings.showClusters} onChange={v => update({ showClusters: v })}>
              <ParamSlider label="Boundary opacity" value={settings.clusterOpacity} min={2} max={30} step={1} format={fmtPct} onChange={v => update({ clusterOpacity: v })} />
            </ToggleRow>
            <ToggleRow label="Collapse clusters" checked={settings.minCollapse > 0} onChange={v => update({ minCollapse: v ? 4 : 99 })}>
              <ParamSlider label="Min nodes" value={settings.minCollapse >= 99 ? 4 : settings.minCollapse} min={2} max={12} step={1} format={fmtInt} onChange={v => update({ minCollapse: v })} />
            </ToggleRow>
          </div>
        </div>

        <div className="flex items-center justify-between px-4 py-2.5 border-t border-white/[0.06]">
          <button
            type="button" onClick={handleReset}
            className="text-[11px] text-white/30 hover:text-white/60 transition-colors cursor-pointer"
          >
            Reset Defaults
          </button>
          <button
            type="button" onClick={handleSave}
            className={`text-[11px] font-medium px-3 py-1 rounded-full transition-all cursor-pointer ${
              savedFlash
                ? 'bg-green-500/20 text-green-400'
                : 'bg-white/[0.08] text-white/60 hover:bg-white/[0.12] hover:text-white/90'
            }`}
          >
            {savedFlash ? '✓ Saved' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
