import React, {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useMemo,
  useCallback,
} from 'react';
import { createPortal } from 'react-dom';
import {
  ShieldHalf,
  Search,
  X,
  XCircle,
  CheckCircle,
  AlertTriangle,
  Ban,
  GitBranch,
  Lightbulb,
  Zap,
  Brain,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Lock,
  Copy,
  CheckSquare,
  Trash2,
} from 'lucide-react';
import type {
  AuditEntryVM,
  IssueThreadVM,
  AuditFinding,
  AuditAction,
  AuditSource,
  IssueEventType,
  TimelineEventVM,
} from '../../models/types';
import {
  FINDING_META,
  SOURCE_META,
  ISSUE_EVENT_META,
  relativeTime,
  fileName,
} from '../../models/types';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface AuditPanelProps {
  auditTrail: AuditEntryVM[];
  issueThreads: IssueThreadVM[];
  isExpanded: boolean;
  onToggle: () => void;
  auditBatchInterval: number;
  auditBatchStartTime: number;
  isAuditorWorking: boolean;
  lockedPaths?: string[];
  onResolveIssue?: (id: string, currentlyResolved: boolean) => void;
  onDismissIssue?: (id: string) => void;
  navigateToSearch?: string | null;
  onNavigateHandled?: () => void;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AuditTab = 'issues' | 'trail';
type TrailFilter = 'all' | 'issues' | 'concerns' | 'aligned';
type IssueStatusFilter = 'all' | 'open' | 'resolved';

const TRAIL_FILTERS: { key: TrailFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'issues', label: 'Issues' },
  { key: 'concerns', label: 'Concerns' },
  { key: 'aligned', label: 'Aligned' },
];

const ISSUE_STATUS_FILTERS: { key: IssueStatusFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'resolved', label: 'Resolved' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findingIcon(finding: AuditFinding) {
  switch (finding) {
    case 'violation': return <Ban size={11} />;
    case 'drift':     return <GitBranch size={11} />;
    case 'concern':   return <AlertTriangle size={11} />;
    case 'guidance':  return <Lightbulb size={11} />;
    case 'aligned':   return <CheckCircle size={11} />;
  }
}

function sourceIcon(source: AuditSource) {
  switch (source) {
    case 'deterministic': return <Zap size={10} />;
    case 'semantic':      return <Brain size={10} />;
  }
}

function eventIcon(type: IssueEventType) {
  switch (type) {
    case 'detected':  return <AlertCircle size={8} />;
    case 'requested': return <AlertTriangle size={8} />;
    case 'responded': return <CheckCircle2 size={8} />;
    case 'resolved':  return <CheckCircle size={8} />;
    case 'escalated': return <AlertTriangle size={8} />;
  }
}

function actionColor(action: AuditAction): string {
  switch (action) {
    case 'denied':   return '#ef4444';
    case 'warned':   return '#f97316';
    case 'observed': return '#6b7280';
  }
}

function matchesTrailFilter(finding: AuditFinding, filter: TrailFilter): boolean {
  switch (filter) {
    case 'all':      return true;
    case 'issues':   return finding === 'violation' || finding === 'drift';
    case 'concerns': return finding === 'concern';
    case 'aligned':  return finding === 'aligned';
  }
}

function matchesSearch(entry: AuditEntryVM, query: string): boolean {
  const q = query.toLowerCase();
  return (
    entry.filePath.toLowerCase().includes(q) ||
    entry.reason.toLowerCase().includes(q) ||
    entry.ruleType.toLowerCase().includes(q) ||
    entry.toolName.toLowerCase().includes(q)
  );
}

// ---------------------------------------------------------------------------
// Resize Handle (same pattern as ChangesPanel / SpecPanel)
// ---------------------------------------------------------------------------

function ResizeHandle({
  panelRef,
  isResizingRef,
  onWidthCommit,
}: {
  panelRef: React.RefObject<HTMLDivElement | null>;
  isResizingRef: React.RefObject<boolean>;
  onWidthCommit: (w: number) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [active, setActive] = useState(false);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const panelEl = panelRef.current;
      if (!panelEl) return;

      setActive(true);
      isResizingRef.current = true;
      panelEl.style.transition = 'none';
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      const startX = e.clientX;
      const startWidth = panelEl.offsetWidth;

      const onMouseMove = (ev: MouseEvent) => {
        const delta = ev.clientX - startX;
        const w = Math.min(Math.max(startWidth - delta, 280), 520);
        panelEl.style.width = `${w}px`;
      };
      const onMouseUp = (ev: MouseEvent) => {
        const delta = ev.clientX - startX;
        const w = Math.min(Math.max(startWidth - delta, 280), 520);
        isResizingRef.current = false;
        setActive(false);
        panelEl.style.transition = '';
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        onWidthCommit(w);
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    },
    [panelRef, isResizingRef, onWidthCommit],
  );

  return (
    <div
      className="absolute left-0 top-0 bottom-0 w-[10px] flex items-center justify-center z-10 cursor-col-resize"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onMouseDown={onMouseDown}
    >
      <div
        className="w-[4px] h-10 rounded-full transition-colors duration-150"
        style={{
          backgroundColor: active
            ? 'rgba(255,255,255,0.4)'
            : hovered
              ? 'rgba(255,255,255,0.25)'
              : 'rgba(255,255,255,0.1)',
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Issue context menu (portaled)
// ---------------------------------------------------------------------------

function IssueContextMenu({
  x, y, issue, onClose, onResolve, onDismiss,
}: {
  x: number;
  y: number;
  issue: IssueThreadVM;
  onClose: () => void;
  onResolve: () => void;
  onDismiss: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const style: React.CSSProperties = {
    position: 'fixed',
    top: Math.min(y, window.innerHeight - 120),
    left: Math.min(x, window.innerWidth - 200),
    zIndex: 9999,
  };

  return createPortal(
    <div
      ref={ref}
      style={style}
      className="w-48 py-1 rounded-lg border border-white/[0.08] bg-zinc-900/95 backdrop-blur shadow-2xl"
    >
      <button
        onClick={() => { onResolve(); onClose(); }}
        className="w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-zinc-200
                   hover:bg-white/[0.06] transition-colors cursor-pointer text-left"
      >
        <CheckSquare className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
        {issue.isResolved ? 'Reopen Issue' : 'Resolve Issue'}
      </button>
      <button
        onClick={() => { navigator.clipboard.writeText(issue.filePath); onClose(); }}
        className="w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-zinc-200
                   hover:bg-white/[0.06] transition-colors cursor-pointer text-left"
      >
        <Copy className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
        Copy File Path
      </button>
      <div className="h-px bg-white/[0.06] my-1" />
      <button
        onClick={() => { onDismiss(); onClose(); }}
        className="w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-red-400
                   hover:bg-red-500/[0.08] transition-colors cursor-pointer text-left"
      >
        <Trash2 className="w-3.5 h-3.5 shrink-0" />
        Dismiss Issue
      </button>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// AuditCountdownRing
// ---------------------------------------------------------------------------

function AuditCountdownRing({
  batchInterval, batchStartTime, isAuditing,
}: {
  batchInterval: number;
  batchStartTime: number;
  isAuditing: boolean;
}) {
  const [progress, setProgress] = useState(1);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (isAuditing) { cancelAnimationFrame(rafRef.current); return; }
    const tick = () => {
      const elapsed = (Date.now() - batchStartTime) / 1000;
      setProgress(elapsed > batchInterval ? 0 : Math.max(0, 1 - elapsed / batchInterval));
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [batchInterval, batchStartTime, isAuditing]);

  const ringColor = progress > 0.5
    ? 'rgba(34,197,94,0.6)'
    : progress > 0.2
      ? 'rgba(249,115,22,0.6)'
      : 'rgba(239,68,68,0.6)';
  const circumference = 2 * Math.PI * 6;

  if (isAuditing) {
    return <Loader2 size={16} className="animate-spin shrink-0" style={{ color: '#3b82f6' }} />;
  }

  return (
    <svg width={16} height={16} viewBox="0 0 16 16" className="shrink-0">
      <circle cx={8} cy={8} r={6} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={2} />
      <circle
        cx={8} cy={8} r={6} fill="none" stroke={ringColor}
        strokeWidth={2} strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - progress)}
        transform="rotate(-90 8 8)"
        style={{ transition: 'stroke-dashoffset 0.1s linear' }}
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// TrailDetailSection
// ---------------------------------------------------------------------------

function TrailDetailSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">{label}</span>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AuditPanel
// ---------------------------------------------------------------------------

export default function AuditPanel({
  auditTrail,
  issueThreads,
  isExpanded,
  onToggle,
  auditBatchInterval,
  auditBatchStartTime,
  isAuditorWorking,
  lockedPaths = [],
  onResolveIssue,
  onDismissIssue,
  navigateToSearch,
  onNavigateHandled,
}: AuditPanelProps) {
  const [activeTab, setActiveTab] = useState<AuditTab>('issues');
  const [searchText, setSearchText] = useState('');
  const [trailFilter, setTrailFilter] = useState<TrailFilter>('all');
  const [issueFilter, setIssueFilter] = useState<IssueStatusFilter>('all');
  const [expandedEntryId, setExpandedEntryId] = useState<string | null>(null);
  const [expandedIssueId, setExpandedIssueId] = useState<string | null>(null);
  const [panelWidth, setPanelWidth] = useState(520);
  const [computedMaxH, setComputedMaxH] = useState('calc(100vh - 120px)');

  const panelRef = useRef<HTMLDivElement>(null);
  const isResizingRef = useRef(false);

  const lockedSet = useMemo(() => new Set(lockedPaths), [lockedPaths]);

  const openCount = useMemo(() => issueThreads.filter((t) => !t.isResolved).length, [issueThreads]);

  // navigate-to-search: expand panel, switch to trail tab, pre-fill search
  useEffect(() => {
    if (!navigateToSearch) return;
    if (!isExpanded) onToggle();
    setActiveTab('trail');
    setSearchText(navigateToSearch);
    onNavigateHandled?.();
  }, [navigateToSearch, isExpanded, onToggle, onNavigateHandled]);

  // Measured maxHeight (same pattern as ChangesPanel / SpecPanel)
  useLayoutEffect(() => {
    if (!isExpanded) return;
    const update = () => {
      if (isResizingRef.current) return;
      const el = panelRef.current;
      if (!el) return;
      const { top } = el.getBoundingClientRect();
      setComputedMaxH(`${Math.max(window.innerHeight - top - 12, 200)}px`);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(document.documentElement);
    window.addEventListener('resize', update);
    return () => { ro.disconnect(); window.removeEventListener('resize', update); };
  }, [isExpanded]);

  const filteredTrail = useMemo(() => {
    let entries = auditTrail.filter((e) => matchesTrailFilter(e.finding, trailFilter));
    if (searchText) entries = entries.filter((e) => matchesSearch(e, searchText));
    return entries;
  }, [auditTrail, trailFilter, searchText]);

  const trailFilterCounts = useMemo(() => {
    const counts: Record<TrailFilter, number> = { all: 0, issues: 0, concerns: 0, aligned: 0 };
    for (const e of auditTrail) {
      counts.all++;
      if (e.finding === 'violation' || e.finding === 'drift') counts.issues++;
      if (e.finding === 'concern') counts.concerns++;
      if (e.finding === 'aligned') counts.aligned++;
    }
    return counts;
  }, [auditTrail]);

  const filteredIssues = useMemo(() => {
    switch (issueFilter) {
      case 'all':      return issueThreads;
      case 'open':     return issueThreads.filter((t) => !t.isResolved);
      case 'resolved': return issueThreads.filter((t) => t.isResolved);
    }
  }, [issueThreads, issueFilter]);

  const toggleEntry = useCallback((id: string) => setExpandedEntryId((p) => p === id ? null : id), []);
  const toggleIssue = useCallback((id: string) => setExpandedIssueId((p) => p === id ? null : id), []);

  // ── Collapsed button ──────────────────────────────────────────────

  if (!isExpanded) {
    return (
      <button
        onClick={onToggle}
        className="changes-btn-enter changes-warp-btn relative glass-panel flex items-center justify-center
                   w-[40px] h-[40px] cursor-pointer"
        style={{ borderRadius: 12 }}
      >
        <ShieldHalf size={18} className="text-zinc-300" />
        {openCount > 0 && (
          <span className="absolute -top-1 -right-1 flex items-center justify-center min-w-[14px] h-[14px]
                           text-[9px] font-bold text-white bg-red-500 rounded-full px-1 leading-none">
            {openCount}
          </span>
        )}
      </button>
    );
  }

  // ── Expanded panel ────────────────────────────────────────────────

  const isEmpty = auditTrail.length === 0 && issueThreads.length === 0;

  return (
    <div
      ref={panelRef}
      className="changes-panel-enter glass-panel relative flex flex-col overflow-hidden"
      style={{
        width: panelWidth,
        minHeight: 300,
        maxHeight: computedMaxH,
        transition: 'width 0.3s cubic-bezier(0.34, 1.2, 0.64, 1)',
      }}
    >
      <ResizeHandle panelRef={panelRef} isResizingRef={isResizingRef} onWidthCommit={setPanelWidth} />

      {/* Header */}
      <div className="flex items-center gap-2 px-4 pt-3.5 pb-2.5">
        <ShieldHalf size={16} className="text-zinc-400 shrink-0" />
        <span className="text-base font-semibold text-zinc-100">Audit</span>
        <div className="flex-1" />
        {openCount > 0 && (
          <span className="text-[9px] font-bold text-white bg-red-500 rounded-full px-1.5 py-0.5 leading-none">
            {openCount}
          </span>
        )}
        <button onClick={onToggle} className="text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer">
          <XCircle className="w-4 h-4" />
        </button>
      </div>

      <div className="h-px bg-white/[0.08]" />

      {isEmpty ? (
        /* Empty state — glass orb */
        <div className="flex flex-col items-center justify-center flex-1 py-12 px-6 gap-3">
          <div className="relative w-14 h-14 flex items-center justify-center">
            <div
              className="absolute inset-0 rounded-full"
              style={{
                background: 'conic-gradient(rgba(255,255,255,0.15), rgba(255,255,255,0.04), rgba(255,255,255,0.15))',
                WebkitMask: 'radial-gradient(farthest-side, transparent calc(100% - 1px), #000 calc(100% - 1px))',
                mask: 'radial-gradient(farthest-side, transparent calc(100% - 1px), #000 calc(100% - 1px))',
              }}
            />
            <div className="w-[54px] h-[54px] rounded-full bg-white/[0.04] backdrop-blur flex items-center justify-center">
              <ShieldHalf size={22} className="text-zinc-500" strokeWidth={1.2} />
            </div>
          </div>
          <div className="text-center">
            <p className="text-sm font-semibold text-zinc-200">No Audit Data</p>
            <p className="text-sm text-zinc-500 mt-1 leading-relaxed">
              Start observing a session to<br />see audit results here.
            </p>
          </div>
        </div>
      ) : (
        <>
          {/* Tab bar */}
          <div className="flex items-center gap-1.5 px-3.5 py-1.5">
            {(['issues', 'trail'] as AuditTab[]).map((tab) => {
              const count = tab === 'issues' ? issueThreads.length : auditTrail.length;
              const active = activeTab === tab;
              return (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`flex items-center gap-1 px-3.5 py-1 rounded-full text-sm transition-colors cursor-pointer
                    ${active ? 'font-semibold text-zinc-100 bg-white/10' : 'font-normal text-zinc-400 hover:text-zinc-300'}`}
                >
                  {tab === 'issues' ? 'Issues' : 'Trail'}
                  <span className="text-[10px] text-zinc-500">{count}</span>
                </button>
              );
            })}
            <div className="flex-1" />
            <AuditCountdownRing
              batchInterval={auditBatchInterval}
              batchStartTime={auditBatchStartTime}
              isAuditing={isAuditorWorking}
            />
          </div>

          <div className="h-px bg-white/[0.08]" />

          {activeTab === 'issues' ? (
            <IssuesView
              issues={filteredIssues}
              issueFilter={issueFilter}
              setIssueFilter={setIssueFilter}
              expandedIssueId={expandedIssueId}
              toggleIssue={toggleIssue}
              onResolveIssue={onResolveIssue}
              onDismissIssue={onDismissIssue}
            />
          ) : (
            <TrailView
              entries={filteredTrail}
              trailFilter={trailFilter}
              setTrailFilter={setTrailFilter}
              filterCounts={trailFilterCounts}
              searchText={searchText}
              setSearchText={setSearchText}
              expandedEntryId={expandedEntryId}
              toggleEntry={toggleEntry}
              lockedSet={lockedSet}
            />
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// IssuesView
// ---------------------------------------------------------------------------

function IssuesView({
  issues, issueFilter, setIssueFilter, expandedIssueId, toggleIssue,
  onResolveIssue, onDismissIssue,
}: {
  issues: IssueThreadVM[];
  issueFilter: IssueStatusFilter;
  setIssueFilter: (f: IssueStatusFilter) => void;
  expandedIssueId: string | null;
  toggleIssue: (id: string) => void;
  onResolveIssue?: (id: string, currentlyResolved: boolean) => void;
  onDismissIssue?: (id: string) => void;
}) {
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center gap-1 px-3.5 py-1.5">
        {ISSUE_STATUS_FILTERS.map((f) => {
          const active = issueFilter === f.key;
          return (
            <button
              key={f.key}
              onClick={() => setIssueFilter(f.key)}
              className={`px-2 py-0.5 rounded-full text-xs transition-colors cursor-pointer
                ${active ? 'font-semibold text-zinc-100 bg-white/[0.08]' : 'text-zinc-500 hover:text-zinc-400'}`}
            >
              {f.label}
            </button>
          );
        })}
      </div>

      {issues.length === 0 ? (
        <EmptyState
          icon={<CheckCircle size={24} className="text-zinc-600" />}
          message={issueFilter === 'all' ? 'No issues detected' : `No ${issueFilter} issues`}
        />
      ) : (
        <div className="flex-1 overflow-y-auto py-1">
          {issues.map((issue) => (
            <IssueRow
              key={issue.id}
              issue={issue}
              isOpen={expandedIssueId === issue.id}
              onToggle={() => toggleIssue(issue.id)}
              onResolve={onResolveIssue ? () => onResolveIssue(issue.id, issue.isResolved) : undefined}
              onDismiss={onDismissIssue ? () => onDismissIssue(issue.id) : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// IssueRow (with context menu)
// ---------------------------------------------------------------------------

function IssueRow({
  issue, isOpen, onToggle, onResolve, onDismiss,
}: {
  issue: IssueThreadVM;
  isOpen: boolean;
  onToggle: () => void;
  onResolve?: () => void;
  onDismiss?: () => void;
}) {
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const meta = FINDING_META[issue.finding];
  const hasEscalated = issue.events.some((e) => e.type === 'escalated');

  return (
    <div className="flex flex-col">
      <div
        onClick={onToggle}
        onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY }); }}
        className="flex items-center gap-2.5 px-3.5 py-2 cursor-pointer hover:bg-white/[0.03] transition-colors"
      >
        <div
          className="flex items-center justify-center w-6 h-6 rounded-full shrink-0"
          style={{ backgroundColor: `${issue.isResolved ? '#22c55e' : '#ef4444'}18` }}
        >
          {issue.isResolved
            ? <CheckCircle size={12} style={{ color: '#22c55e' }} />
            : <AlertCircle size={12} style={{ color: '#ef4444' }} />}
        </div>

        <div className="flex flex-col gap-0.5 min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-sm text-zinc-100 truncate">{fileName(issue.filePath)}</span>
            <span className="badge shrink-0" style={{ color: meta.color, backgroundColor: `${meta.color}1f` }}>
              {meta.label}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            {issue.isResolved && issue.resolveTime ? (
              <span className="text-xs text-green-400">Resolved in {issue.resolveTime}</span>
            ) : (
              <span className="text-xs text-zinc-500">
                {issue.attempts} attempt{issue.attempts === 1 ? '' : 's'}
              </span>
            )}
            {hasEscalated && (
              <span className="flex items-center gap-0.5 text-red-400">
                <AlertTriangle size={8} />
                <span className="text-[10px]">Escalated</span>
              </span>
            )}
          </div>
        </div>
      </div>

      {isOpen && (
        <div className="mx-3 mb-2 p-3 rounded-[10px] bg-white/[0.03] border border-white/[0.06]">
          <p className="text-xs font-mono text-zinc-500 mb-1.5">{issue.filePath}</p>
          <div className="flex flex-col">
            {issue.events.map((event, idx) => (
              <TimelineRow
                key={event.id}
                event={event}
                isFirst={idx === 0}
                isLast={idx === issue.events.length - 1}
              />
            ))}
          </div>
          <div className="flex items-center gap-1.5 mt-2 pt-1.5">
            <span className="text-[10px] text-zinc-600">
              {issue.attempts} attempt{issue.attempts === 1 ? '' : 's'}
            </span>
            {issue.resolveTime && (
              <>
                <span className="w-[3px] h-[3px] rounded-full bg-zinc-700" />
                <span className="text-[10px] text-green-400">{issue.resolveTime}</span>
              </>
            )}
          </div>
        </div>
      )}

      {!isOpen && <div className="h-px bg-white/[0.05] ml-8" />}

      {ctxMenu && onResolve && onDismiss && (
        <IssueContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          issue={issue}
          onClose={() => setCtxMenu(null)}
          onResolve={onResolve}
          onDismiss={onDismiss}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TimelineRow
// ---------------------------------------------------------------------------

function TimelineRow({ event, isFirst, isLast }: { event: TimelineEventVM; isFirst: boolean; isLast: boolean }) {
  const meta = ISSUE_EVENT_META[event.type];
  return (
    <div className="flex gap-2.5">
      <div className="flex flex-col items-center w-3.5 shrink-0">
        {!isFirst ? <div className="w-px h-2 flex-none" style={{ backgroundColor: `${meta.color}4d` }} /> : <div className="h-2" />}
        <div className="flex items-center justify-center w-3.5 h-3.5 shrink-0" style={{ color: meta.color }}>
          {eventIcon(event.type)}
        </div>
        {!isLast ? <div className="w-px flex-1 min-h-[12px]" style={{ backgroundColor: 'rgba(255,255,255,0.06)' }} /> : <div className="flex-1" />}
      </div>
      <div className="flex flex-col gap-0.5 py-1 min-w-0 flex-1">
        <div className="flex items-center gap-1">
          <span className="text-xs font-medium" style={{ color: meta.color }}>{event.label}</span>
          <span className="flex-1" />
          <span className="text-[10px] text-zinc-600 shrink-0">{event.relativeTime}</span>
        </div>
        <span className="text-xs text-zinc-500 leading-snug">{event.detail}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TrailView
// ---------------------------------------------------------------------------

function TrailView({
  entries, trailFilter, setTrailFilter, filterCounts, searchText, setSearchText,
  expandedEntryId, toggleEntry, lockedSet,
}: {
  entries: AuditEntryVM[];
  trailFilter: TrailFilter;
  setTrailFilter: (f: TrailFilter) => void;
  filterCounts: Record<TrailFilter, number>;
  searchText: string;
  setSearchText: (s: string) => void;
  expandedEntryId: string | null;
  toggleEntry: (id: string) => void;
  lockedSet: Set<string>;
}) {
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center gap-1.5 px-3 py-1.5">
        <Search size={12} className="text-zinc-600 shrink-0" />
        <input
          type="text"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          placeholder="Search trail"
          className="flex-1 bg-transparent text-sm text-zinc-200 placeholder:text-zinc-600 outline-none border-none"
        />
        {searchText && (
          <button onClick={() => setSearchText('')} className="flex items-center justify-center w-4 h-4 rounded-full hover:bg-white/10 transition-colors cursor-pointer">
            <X size={10} className="text-zinc-500" />
          </button>
        )}
      </div>

      <div className="flex items-center gap-1 px-3.5 pb-1.5">
        {TRAIL_FILTERS.map((f) => {
          const active = trailFilter === f.key;
          return (
            <button
              key={f.key}
              onClick={() => setTrailFilter(f.key)}
              className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-xs transition-colors cursor-pointer
                ${active ? 'font-semibold text-zinc-100 bg-white/[0.08]' : 'text-zinc-500 hover:text-zinc-400'}`}
            >
              {f.label}
              <span className="text-[10px] text-zinc-600">{filterCounts[f.key]}</span>
            </button>
          );
        })}
      </div>

      <div className="h-px bg-white/[0.08]" />

      {entries.length === 0 ? (
        <EmptyState
          icon={<Search size={24} className="text-zinc-600" />}
          message={searchText ? `No results for "${searchText}"` : `No ${trailFilter === 'all' ? '' : trailFilter} entries`}
        />
      ) : (
        <div className="flex-1 overflow-y-auto py-1">
          {entries.map((entry) => (
            <TrailRow
              key={entry.id}
              entry={entry}
              isOpen={expandedEntryId === entry.id}
              onToggle={() => toggleEntry(entry.id)}
              isLocked={lockedSet.has(entry.filePath)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TrailRow (with lock indicator on denied entries)
// ---------------------------------------------------------------------------

function TrailRow({
  entry, isOpen, onToggle, isLocked,
}: {
  entry: AuditEntryVM;
  isOpen: boolean;
  onToggle: () => void;
  isLocked: boolean;
}) {
  const findingMeta = FINDING_META[entry.finding];
  const actColor = actionColor(entry.action);
  const showLock = entry.action === 'denied' && isLocked;

  return (
    <>
      <div
        onClick={onToggle}
        className={`flex flex-col gap-0 cursor-pointer transition-colors
          ${isOpen ? 'mx-2 rounded-[10px] bg-white/[0.03] border border-white/[0.06]' : 'hover:bg-white/[0.02]'}`}
      >
        <div className="flex items-start gap-2.5 px-3.5 py-2">
          <div
            className="flex items-center justify-center w-6 h-6 rounded-full shrink-0 mt-0.5"
            style={{ backgroundColor: `${findingMeta.color}1f` }}
          >
            <span style={{ color: findingMeta.color }}>{findingIcon(entry.finding)}</span>
          </div>

          <div className="flex flex-col gap-0.5 min-w-0 flex-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-sm text-zinc-100 truncate">{fileName(entry.filePath)}</span>

              <span className="badge shrink-0" style={{ color: findingMeta.color, backgroundColor: `${findingMeta.color}1f` }}>
                {findingMeta.label}
              </span>

              {/* Action badge — with lock icon if denied+locked */}
              <span
                className="badge shrink-0 flex items-center gap-0.5"
                style={{ color: actColor, backgroundColor: `${actColor}1a` }}
              >
                {showLock && <Lock size={7} className="shrink-0" />}
                {entry.action.toUpperCase()}
              </span>

              <span className="flex-1" />
              <span className="text-[10px] text-zinc-600 shrink-0 whitespace-nowrap">
                {relativeTime(entry.timestamp)}
              </span>
            </div>

            <p className={`text-xs text-zinc-500 leading-snug ${isOpen ? '' : 'line-clamp-1'}`}>
              {entry.reason}
            </p>
          </div>
        </div>

        {isOpen && (
          <div className="flex flex-col gap-2.5 pl-[46px] pr-3.5 pb-3 pt-1">
            <TrailDetailSection label="FILE">
              <span className="text-xs font-mono text-zinc-400 select-all break-all">{entry.filePath}</span>
            </TrailDetailSection>
            <TrailDetailSection label="REASON">
              <span className="text-sm text-zinc-400 leading-snug">{entry.reason}</span>
            </TrailDetailSection>
            {entry.ruleQuote && (
              <TrailDetailSection label="RULE">
                <div className="flex items-stretch gap-0">
                  <div className="w-[3px] rounded-full shrink-0" style={{ backgroundColor: findingMeta.color }} />
                  <span className="text-xs font-mono text-zinc-400 pl-2.5 leading-relaxed">{entry.ruleQuote}</span>
                </div>
              </TrailDetailSection>
            )}
            <TrailDetailSection label="SOURCE">
              <span className="flex items-center gap-1 text-sm font-medium" style={{ color: SOURCE_META[entry.source].color }}>
                {sourceIcon(entry.source)}
                {entry.source === 'semantic' ? 'Semantic (LLM)' : 'Deterministic (YAML)'}
              </span>
            </TrailDetailSection>
            <TrailDetailSection label="RULE TYPE">
              <span className="text-sm text-zinc-400">{entry.ruleType}</span>
            </TrailDetailSection>
            <TrailDetailSection label="TOOL">
              <span className="text-sm text-zinc-400">{entry.toolName}</span>
            </TrailDetailSection>
            {entry.linesChanged != null && (
              <TrailDetailSection label="LINES">
                <span className="text-sm text-zinc-400">{entry.linesChanged} changed</span>
              </TrailDetailSection>
            )}
          </div>
        )}
      </div>

      {!isOpen && <div className="h-px bg-white/[0.05] ml-10" />}
    </>
  );
}

// ---------------------------------------------------------------------------
// EmptyState
// ---------------------------------------------------------------------------

function EmptyState({ icon, message }: { icon: React.ReactNode; message: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-8 flex-1">
      {icon}
      <span className="text-sm text-zinc-500">{message}</span>
    </div>
  );
}
