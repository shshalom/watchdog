import { useState } from 'react';
import {
  Settings,
  FileText,
  Shield,
  Search,
  DollarSign,
  X,
  Trash2,
  Plus,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  BookOpen,
  Copy,
  Check,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface SessionSettingsModalProps {
  session: {
    id: string;
    name: string;
    isObserving: boolean;
    hasEnforcement: boolean;
    hasDrift: boolean;
    contextPercent: number;
    cost: number;
    duration: string;
    agentState: string;
    specPaths: string[];
    auditMode: string;
  };
  onClose: () => void;
  onRename?: (name: string) => void;
  onToggleObserving?: () => void;
  onToggleEnforcement?: () => void;
  onChangeAuditMode?: (mode: string) => void;
  onLinkSpec?: () => void;
  onUnlinkSpec?: (path: string) => void;
}

// ---------------------------------------------------------------------------
// Tab definitions
// ---------------------------------------------------------------------------

type Tab = 'general' | 'specs' | 'enforcement' | 'auditor' | 'budget';

const TABS: { id: Tab; label: string; icon: typeof Settings }[] = [
  { id: 'general', label: 'General', icon: Settings },
  { id: 'specs', label: 'Specs', icon: FileText },
  { id: 'enforcement', label: 'Enforcement', icon: Shield },
  { id: 'auditor', label: 'Auditor', icon: Search },
  { id: 'budget', label: 'Budget', icon: DollarSign },
];

// ---------------------------------------------------------------------------
// Enforcement mode definitions
// ---------------------------------------------------------------------------

interface EnforcementMode {
  id: string;
  label: string;
  description: string;
  color: string;
  icon: typeof ShieldAlert;
}

const ENFORCEMENT_MODES: EnforcementMode[] = [
  {
    id: 'strict',
    label: 'Strict',
    description: 'Block all violations immediately. No second chances.',
    color: '#ef4444',
    icon: ShieldAlert,
  },
  {
    id: 'balanced',
    label: 'Balanced',
    description: 'Warn on first offense, block on repeat violations.',
    color: '#3b82f6',
    icon: ShieldCheck,
  },
  {
    id: 'guided',
    label: 'Guided',
    description: 'Suggest corrections without blocking the agent.',
    color: '#f97316',
    icon: ShieldQuestion,
  },
  {
    id: 'learning',
    label: 'Learning',
    description: 'Observe and record only. No enforcement actions taken.',
    color: '#a855f7',
    icon: BookOpen,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusOrbColor(agentState: string): string {
  switch (agentState) {
    case 'active': return '#22c55e';
    case 'thinking': return '#3b82f6';
    case 'waiting': return '#eab308';
    case 'error': return '#ef4444';
    default: return '#6b7280';
  }
}

function formatCost(cost: number): string {
  return `$${cost.toFixed(4)}`;
}

function formatContextPercent(pct: number): string {
  return `${Math.round(pct * 100)}%`;
}

function contextBarColor(pct: number): string {
  if (pct > 0.8) return '#ef4444';
  if (pct > 0.6) return '#eab308';
  return '#22c55e';
}

// ---------------------------------------------------------------------------
// Shared sub-components
// ---------------------------------------------------------------------------

function Toggle({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button
      onClick={onChange}
      className={`w-10 h-6 rounded-full transition-colors cursor-pointer ${
        checked ? 'bg-blue-500' : 'bg-white/10'
      }`}
    >
      <span
        className={`block w-4 h-4 rounded-full bg-white transition-transform mx-1 ${
          checked ? 'translate-x-4' : 'translate-x-0'
        }`}
      />
    </button>
  );
}

function SettingRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-white/60">{label}</span>
      {children}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[10px] font-semibold tracking-wider text-white/30 uppercase">
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Tab: General
// ---------------------------------------------------------------------------

function GeneralTab({
  session,
  onRename,
  onToggleObserving,
  onToggleEnforcement,
}: {
  session: SessionSettingsModalProps['session'];
  onRename?: (name: string) => void;
  onToggleObserving?: () => void;
  onToggleEnforcement?: () => void;
}) {
  const [name, setName] = useState(session.name);
  const [copiedId, setCopiedId] = useState(false);

  const handleNameBlur = () => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== session.name) {
      onRename?.(trimmed);
    }
  };

  const handleNameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      (e.target as HTMLInputElement).blur();
    }
  };

  const handleCopyId = () => {
    navigator.clipboard.writeText(session.id);
    setCopiedId(true);
    setTimeout(() => setCopiedId(false), 1500);
  };

  const orbColor = statusOrbColor(session.agentState);

  return (
    <div className="flex flex-col gap-5">
      {/* Hero vitals card */}
      <div className="flex flex-col gap-3 p-4 rounded-xl bg-white/[0.03] border border-white/[0.06]">
        <div className="flex items-center gap-3">
          {/* Status orb */}
          <div className="relative w-10 h-10 shrink-0">
            <div
              className="absolute inset-0 rounded-full opacity-30 blur-md"
              style={{ backgroundColor: orbColor }}
            />
            <div
              className="relative w-10 h-10 rounded-full border border-white/10 flex items-center justify-center"
              style={{ backgroundColor: `${orbColor}22` }}
            >
              <div
                className="w-3 h-3 rounded-full"
                style={{ backgroundColor: orbColor }}
              />
            </div>
          </div>

          <div className="flex flex-col gap-1 min-w-0 flex-1">
            <span className="text-sm font-semibold text-white truncate">{session.name}</span>
            <div className="flex items-center gap-1.5 flex-wrap">
              {session.isObserving && (
                <span className="badge text-emerald-400" style={{ backgroundColor: 'rgba(52,211,153,0.15)' }}>
                  Observing
                </span>
              )}
              {session.hasEnforcement && (
                <span className="badge text-blue-400" style={{ backgroundColor: 'rgba(96,165,250,0.15)' }}>
                  Enforcing
                </span>
              )}
              {session.hasDrift && (
                <span className="badge text-red-400" style={{ backgroundColor: 'rgba(248,113,113,0.15)' }}>
                  Drift
                </span>
              )}
            </div>
          </div>

          <div className="flex flex-col items-end gap-0.5 shrink-0">
            <span className="text-xs text-white/50">{formatCost(session.cost)}</span>
            <span className="text-xs text-white/30">{session.duration || '0s'}</span>
          </div>
        </div>

        {/* Context bar (large) */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-medium text-white/40">Context Window</span>
            <span className="text-[10px] font-medium text-white/60">
              {formatContextPercent(session.contextPercent)}
            </span>
          </div>
          <div className="relative h-2 rounded-full overflow-hidden bg-white/[0.06]">
            <div
              className="absolute inset-y-0 left-0 rounded-full transition-all duration-500"
              style={{
                width: `${Math.min(session.contextPercent * 100, 100)}%`,
                backgroundColor: contextBarColor(session.contextPercent),
              }}
            />
          </div>
        </div>
      </div>

      {/* Settings */}
      <div className="flex flex-col gap-3">
        <SectionLabel>Session Name</SectionLabel>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={handleNameBlur}
          onKeyDown={handleNameKeyDown}
          className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-white/20 transition-colors"
          placeholder="Session name..."
        />
      </div>

      <div className="flex flex-col gap-3">
        <SectionLabel>Controls</SectionLabel>
        <SettingRow label="Observing">
          <Toggle checked={session.isObserving} onChange={() => onToggleObserving?.()} />
        </SettingRow>
        <SettingRow label="Enforcement">
          <Toggle checked={session.hasEnforcement} onChange={() => onToggleEnforcement?.()} />
        </SettingRow>
      </div>

      <div className="flex flex-col gap-2">
        <SectionLabel>Session ID</SectionLabel>
        <div className="flex items-center gap-2">
          <span className="flex-1 text-xs font-mono text-white/30 truncate select-all">
            {session.id}
          </span>
          <button
            onClick={handleCopyId}
            className="shrink-0 w-7 h-7 rounded-md bg-white/5 flex items-center justify-center text-white/30 hover:text-white/60 hover:bg-white/10 transition-colors cursor-pointer"
            title="Copy ID"
          >
            {copiedId ? <Check size={12} /> : <Copy size={12} />}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab: Specs
// ---------------------------------------------------------------------------

function SpecsTab({
  specPaths,
  onLinkSpec,
  onUnlinkSpec,
}: {
  specPaths: string[];
  onLinkSpec?: () => void;
  onUnlinkSpec?: (path: string) => void;
}) {
  if (specPaths.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 flex-1 py-10">
        <div className="w-14 h-14 rounded-full bg-white/[0.03] border border-white/[0.06] flex items-center justify-center">
          <FileText size={22} className="text-white/20" />
        </div>
        <div className="text-center">
          <p className="text-sm font-semibold text-white/80">No Specs Linked</p>
          <p className="text-xs text-white/30 mt-1 leading-relaxed">
            Link spec files to define rules<br />for this session.
          </p>
        </div>
        {onLinkSpec && (
          <button
            onClick={onLinkSpec}
            className="flex items-center gap-1.5 px-4 py-2 rounded-full bg-blue-500/20 text-blue-400 text-sm font-medium hover:bg-blue-500/30 transition-colors cursor-pointer"
          >
            <Plus size={14} />
            Link Spec
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <SectionLabel>Linked Specs ({specPaths.length})</SectionLabel>
        {onLinkSpec && (
          <button
            onClick={onLinkSpec}
            className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-blue-500/15 text-blue-400 text-xs font-medium hover:bg-blue-500/25 transition-colors cursor-pointer"
          >
            <Plus size={11} />
            Link Spec
          </button>
        )}
      </div>

      <div className="flex flex-col gap-1">
        {specPaths.map((path) => {
          const segments = path.split('/');
          const filename = segments[segments.length - 1];
          const dir = segments.slice(0, -1).join('/');

          return (
            <div
              key={path}
              className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg bg-white/[0.03] border border-white/[0.04] hover:border-white/[0.08] transition-colors group"
            >
              <FileText size={14} className="text-white/30 shrink-0" />
              <div className="flex flex-col min-w-0 flex-1">
                <span className="text-sm text-white/80 truncate">{filename}</span>
                {dir && (
                  <span className="text-[10px] text-white/20 font-mono truncate">{dir}</span>
                )}
              </div>
              {onUnlinkSpec && (
                <button
                  onClick={() => onUnlinkSpec(path)}
                  className="shrink-0 w-7 h-7 rounded-md flex items-center justify-center text-white/0 group-hover:text-white/30 hover:!text-red-400 hover:bg-red-500/10 transition-all cursor-pointer"
                  title="Unlink spec"
                >
                  <Trash2 size={12} />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab: Enforcement
// ---------------------------------------------------------------------------

function EnforcementTab({
  auditMode,
  onChangeAuditMode,
}: {
  auditMode: string;
  onChangeAuditMode?: (mode: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <SectionLabel>Enforcement Mode</SectionLabel>
      <div className="flex flex-col gap-2">
        {ENFORCEMENT_MODES.map((mode) => {
          const isActive = auditMode === mode.id;
          const Icon = mode.icon;
          return (
            <button
              key={mode.id}
              onClick={() => onChangeAuditMode?.(mode.id)}
              className={`flex items-start gap-3 p-3.5 rounded-xl border transition-all cursor-pointer text-left ${
                isActive
                  ? 'border-opacity-40 bg-opacity-5'
                  : 'border-white/[0.04] bg-white/[0.02] hover:bg-white/[0.04] hover:border-white/[0.08]'
              }`}
              style={
                isActive
                  ? {
                      borderColor: `${mode.color}66`,
                      backgroundColor: `${mode.color}0d`,
                    }
                  : undefined
              }
            >
              <div
                className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
                style={{
                  backgroundColor: `${mode.color}${isActive ? '22' : '11'}`,
                }}
              >
                <Icon
                  size={16}
                  style={{ color: isActive ? mode.color : `${mode.color}88` }}
                />
              </div>
              <div className="flex flex-col gap-0.5 min-w-0">
                <span
                  className={`text-sm font-medium ${
                    isActive ? 'text-white' : 'text-white/50'
                  }`}
                >
                  {mode.label}
                </span>
                <span
                  className={`text-xs leading-relaxed ${
                    isActive ? 'text-white/50' : 'text-white/25'
                  }`}
                >
                  {mode.description}
                </span>
              </div>
              {isActive && (
                <div
                  className="shrink-0 w-5 h-5 rounded-full flex items-center justify-center mt-0.5"
                  style={{ backgroundColor: `${mode.color}33` }}
                >
                  <Check size={11} style={{ color: mode.color }} />
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab: Auditor
// ---------------------------------------------------------------------------

function AuditorTab() {
  const [enabled, setEnabled] = useState(true);
  const [model, setModel] = useState('sonnet');
  const [interval, setInterval] = useState('15');
  const [threshold, setThreshold] = useState('3');

  const models = [
    { id: 'sonnet', label: 'Claude Sonnet' },
    { id: 'opus', label: 'Claude Opus' },
    { id: 'haiku', label: 'Claude Haiku' },
  ];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3">
        <SectionLabel>Auditor</SectionLabel>
        <SettingRow label="Enabled">
          <Toggle checked={enabled} onChange={() => setEnabled(!enabled)} />
        </SettingRow>
      </div>

      <div className="flex flex-col gap-3">
        <SectionLabel>Model</SectionLabel>
        <div className="flex gap-1.5">
          {models.map((m) => (
            <button
              key={m.id}
              onClick={() => setModel(m.id)}
              className={`flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-all cursor-pointer ${
                model === m.id
                  ? 'bg-white/10 text-white border border-white/15'
                  : 'bg-white/[0.03] text-white/30 border border-white/[0.04] hover:text-white/50 hover:border-white/[0.08]'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <SectionLabel>Audit Interval (seconds)</SectionLabel>
        <input
          type="number"
          value={interval}
          onChange={(e) => setInterval(e.target.value)}
          min="5"
          max="300"
          className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-white/20 transition-colors"
        />
      </div>

      <div className="flex flex-col gap-3">
        <SectionLabel>Escalation Threshold (attempts)</SectionLabel>
        <input
          type="number"
          value={threshold}
          onChange={(e) => setThreshold(e.target.value)}
          min="1"
          max="10"
          className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-white/20 transition-colors"
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab: Budget
// ---------------------------------------------------------------------------

function BudgetTab({
  session,
}: {
  session: SessionSettingsModalProps['session'];
}) {
  return (
    <div className="flex flex-col gap-5">
      {/* Cost display */}
      <div className="flex flex-col gap-3">
        <SectionLabel>Cost</SectionLabel>
        <div className="p-4 rounded-xl bg-white/[0.03] border border-white/[0.06]">
          <div className="flex items-baseline gap-1">
            <span className="text-2xl font-semibold text-white tabular-nums">
              {formatCost(session.cost)}
            </span>
            <span className="text-xs text-white/30">USD</span>
          </div>
        </div>
      </div>

      {/* Duration display */}
      <div className="flex flex-col gap-3">
        <SectionLabel>Duration</SectionLabel>
        <div className="p-4 rounded-xl bg-white/[0.03] border border-white/[0.06]">
          <span className="text-2xl font-semibold text-white tabular-nums">
            {session.duration || '0s'}
          </span>
        </div>
      </div>

      {/* Context window */}
      <div className="flex flex-col gap-3">
        <SectionLabel>Context Window</SectionLabel>
        <div className="p-4 rounded-xl bg-white/[0.03] border border-white/[0.06]">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-white/60">Usage</span>
            <span className="text-sm font-medium text-white/80">
              {formatContextPercent(session.contextPercent)}
            </span>
          </div>
          <div className="relative h-3 rounded-full overflow-hidden bg-white/[0.06]">
            <div
              className="absolute inset-y-0 left-0 rounded-full transition-all duration-500"
              style={{
                width: `${Math.min(session.contextPercent * 100, 100)}%`,
                backgroundColor: contextBarColor(session.contextPercent),
              }}
            />
          </div>
        </div>
      </div>

      {/* Sub-agent count */}
      <div className="flex flex-col gap-3">
        <SectionLabel>Sub-Agents</SectionLabel>
        <div className="p-4 rounded-xl bg-white/[0.03] border border-white/[0.06] flex items-center justify-between">
          <span className="text-sm text-white/60">Active sub-agents</span>
          <span className="text-sm font-semibold text-white tabular-nums">0</span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export default function SessionSettingsModal({
  session,
  onClose,
  onRename,
  onToggleObserving,
  onToggleEnforcement,
  onChangeAuditMode,
  onLinkSpec,
  onUnlinkSpec,
}: SessionSettingsModalProps) {
  const [activeTab, setActiveTab] = useState<Tab>('general');

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="glass-panel flex overflow-hidden"
        style={{ width: 600, height: 460 }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Sidebar */}
        <div className="flex flex-col w-[140px] shrink-0 border-r border-white/[0.06] py-3">
          <div className="flex flex-col gap-0.5 px-2">
            {TABS.map((tab) => {
              const isActive = activeTab === tab.id;
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-all cursor-pointer text-left ${
                    isActive
                      ? 'bg-white/10 text-white font-medium'
                      : 'text-white/30 hover:text-white/50 hover:bg-white/[0.03]'
                  }`}
                >
                  <Icon size={14} />
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Detail area */}
        <div className="flex flex-col flex-1 min-w-0">
          {/* Header */}
          <div className="flex items-center justify-between px-5 pt-4 pb-3">
            <h2 className="text-base font-semibold text-white">
              {TABS.find((t) => t.id === activeTab)?.label}
            </h2>
            <button
              onClick={onClose}
              className="w-7 h-7 rounded-full flex items-center justify-center text-white/30 hover:text-white/60 hover:bg-white/10 transition-colors cursor-pointer"
            >
              <X size={14} />
            </button>
          </div>

          <div className="h-px bg-white/[0.06]" />

          {/* Content */}
          <div className="flex-1 overflow-y-auto px-5 py-4">
            {activeTab === 'general' && (
              <GeneralTab
                session={session}
                onRename={onRename}
                onToggleObserving={onToggleObserving}
                onToggleEnforcement={onToggleEnforcement}
              />
            )}
            {activeTab === 'specs' && (
              <SpecsTab
                specPaths={session.specPaths}
                onLinkSpec={onLinkSpec}
                onUnlinkSpec={onUnlinkSpec}
              />
            )}
            {activeTab === 'enforcement' && (
              <EnforcementTab
                auditMode={session.auditMode}
                onChangeAuditMode={onChangeAuditMode}
              />
            )}
            {activeTab === 'auditor' && <AuditorTab />}
            {activeTab === 'budget' && <BudgetTab session={session} />}
          </div>
        </div>
      </div>
    </div>
  );
}
