import { useState, useEffect, useRef, useCallback } from 'react';
import {
  PanelLeft, X, FolderPlus, Folder, ChevronRight,
  Shield, ShieldCheck, Eye, EyeOff, MoreHorizontal, Search,
} from 'lucide-react';
import { ContextMiniBar, DotSep } from '../shared';
import type { AgentState, LockWatchState } from '../../models/types';
import { AGENT_STATE_META } from '../../models/types';
import FilesTab from './FilesTab';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExplorerSession {
  id: string;
  name: string;
  contextPercent: number; // 0–1
  cost: number;
  duration: string;
  isObserving: boolean;
  isAgentActive: boolean;
  agentState: AgentState;
  hasDrift: boolean;
  hasEnforcement: boolean;
  specPaths: string[];
  serverDead: boolean;
}

export interface ExplorerSessionGroup {
  label: string;
  sessions: ExplorerSession[];
}

export interface ExplorerProject {
  id: string;
  name: string;
  path: string;
  totalSessions: number;
  sessionGroups: ExplorerSessionGroup[];
}

interface Props {
  projects: ExplorerProject[];
  projectName?: string;  // The bound project folder name — shown as panel title
  isExpanded: boolean;
  onToggle: () => void;
  selectedSessionId: string | null;
  onSessionSelect: (session: ExplorerSession) => void;
  onSessionSettings?: (session: ExplorerSession) => void;
  onToggleEnforcement?: (session: ExplorerSession) => void;
  onToggleObserving?: (session: ExplorerSession) => void;
  onLinkSpec?: (session: ExplorerSession) => void;
  onRenameSession?: (session: ExplorerSession) => void;
  lockWatchState?: LockWatchState;
  onToggleLock?: (path: string, locked: boolean) => void;
  onToggleWatch?: (path: string, watched: boolean) => void;
  onWidthChange?: (width: number) => void;
}

// ---------------------------------------------------------------------------
// Helpers — match Swift stripeColor exactly
// ---------------------------------------------------------------------------

/**
 * Swift logic (ProjectExplorer.swift:896-902):
 *   serverDead → red
 *   !isObserving → gray 0.25
 *   hasDrift → red
 *   hasEnforcement → green
 *   else → gray 0.25
 */
function stripeColor(session: ExplorerSession): string {
  if (session.serverDead) return '#ef4444';          // red
  if (!session.isObserving) return 'rgba(107,114,128,0.25)';  // gray 0.25
  if (session.hasDrift) return '#ef4444';             // red
  if (session.hasEnforcement) return '#22c55e';       // green
  return 'rgba(107,114,128,0.25)';                    // gray 0.25
}

function orbColor(session: ExplorerSession): string {
  if (session.serverDead || !session.isObserving) return 'rgba(107,114,128,0.35)';
  return AGENT_STATE_META[session.agentState].color;
}

function isOrbGlowing(session: ExplorerSession): boolean {
  return !session.serverDead && session.isObserving &&
    (session.agentState === 'working' || session.agentState === 'modifying');
}

/**
 * Swift shield color logic (ProjectExplorer.swift:783-789):
 *   !isObserving → gray 0.25
 *   hasDrift → red
 *   hasEnforcement → green
 *   else → gray 0.5
 */
function shieldColor(session: ExplorerSession): string {
  if (!session.isObserving) return 'rgba(107,114,128,0.25)';
  if (session.hasDrift) return '#ef4444';
  if (session.hasEnforcement) return '#22c55e';
  return 'rgba(107,114,128,0.5)';
}

type PanelMode = 'sessions' | 'files';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ProjectExplorer({
  projects,
  projectName,
  isExpanded,
  onToggle,
  selectedSessionId,
  onSessionSelect,
  onSessionSettings,
  onToggleEnforcement,
  onToggleObserving,
  onLinkSpec,
  onRenameSession,
  lockWatchState = { locks: [], watches: [] },
  onToggleLock,
  onToggleWatch,
  onWidthChange,
}: Props) {
  const [mode, setMode] = useState<PanelMode>('sessions');
  const [searchText, setSearchText] = useState('');
  // "Older" collapsed by default — matches Swift .onAppear logic
  const [collapsedGroupLabels, setCollapsedGroupLabels] = useState<Set<string>>(new Set(['Older']));
  const [panelWidth, setPanelWidth] = useState(330);

  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const onResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizeRef.current = { startX: e.clientX, startWidth: panelWidth };

    const onMouseMove = (ev: MouseEvent) => {
      if (!resizeRef.current) return;
      const next = Math.max(260, Math.min(500, resizeRef.current.startWidth + ev.clientX - resizeRef.current.startX));
      setPanelWidth(next);
      onWidthChange?.(next);
    };
    const onMouseUp = () => {
      resizeRef.current = null;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [panelWidth, onWidthChange]);

  const toggleGroup = useCallback((label: string) => {
    setCollapsedGroupLabels(prev => {
      const next = new Set(prev);
      next.has(label) ? next.delete(label) : next.add(label);
      return next;
    });
  }, []);

  const filterSessions = useCallback((sessions: ExplorerSession[]) => {
    if (!searchText) return sessions;
    const q = searchText.toLowerCase();
    return sessions.filter(s => s.name.toLowerCase().includes(q));
  }, [searchText]);

  // ---- BOTH STATES — animated with CSS scale from top-left (matches Swift) ----
  // The button is always rendered and fades in when collapsed.
  // The panel renders on top and scales out when closed.
  return (
    <div className="relative" style={{ width: isExpanded ? panelWidth : 34, height: isExpanded ? undefined : 34 }}>
      {/* Collapsed button — always present, invisible when expanded */}
      <button
        onClick={onToggle}
        className="absolute top-0 left-0 w-[34px] h-[34px] rounded-[10px] backdrop-blur-md bg-white/[0.06] border border-white/[0.08] flex items-center justify-center text-white/80 hover:text-white hover:bg-white/10 cursor-pointer shadow-lg transition-all duration-200"
        style={{ opacity: isExpanded ? 0 : 1, pointerEvents: isExpanded ? 'none' : 'auto' }}
      >
        <PanelLeft size={16} />
      </button>

      {/* Expanded panel — scales down to top-left corner when closing */}
      <div
        className="origin-top-left transition-all duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]"
        style={{
          transform: isExpanded ? 'scale(1)' : 'scale(0.3)',
          opacity: isExpanded ? 1 : 0,
          pointerEvents: isExpanded ? 'auto' : 'none',
        }}
      >
    <div
      className="relative glass-panel flex flex-col shadow-[0_8px_32px_rgba(0,0,0,0.3)]"
      style={{
        width: panelWidth,
        maxHeight: 'calc(100vh - 24px)',
        transition: 'max-height 0.3s cubic-bezier(0.4,0,0.2,1)',
      }}
    >
      {/* Header — title is the bound project folder name */}
      <div className="flex items-center gap-2 px-4 pt-3.5 pb-2.5">
        <Folder size={16} className="text-orange-400" />
        <span className="text-[17px] font-semibold truncate flex-1">
          {projectName ?? 'Project'}
        </span>
        <div className="flex-1" />
        <button onClick={onToggle} className="text-white/30 hover:text-white/60 transition-colors cursor-pointer">
          <svg width="16" height="16" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="10" fill="currentColor" opacity="0.3" />
            <path d="M15 9l-6 6M9 9l6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="h-px bg-white/[0.08]" />

      {/* Mode selector */}
      <div className="flex items-center gap-1 px-3.5 py-1.5">
        {(['sessions', 'files'] as PanelMode[]).map(m => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`px-3.5 py-[5px] text-[13px] rounded-full transition-colors cursor-pointer ${
              mode === m
                ? 'bg-white/10 font-semibold text-white'
                : 'text-white/50 hover:text-white/70'
            }`}
          >
            {m === 'sessions' ? 'Sessions' : 'Files'}
          </button>
        ))}
      </div>

      <div className="h-px bg-white/[0.08]" />

      {/* Content — scrollable */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {mode === 'sessions' ? (
          <SessionsMode
            projects={projects}
            collapsedGroupLabels={collapsedGroupLabels}
            selectedSessionId={selectedSessionId}
            searchText={searchText}
            onSearchChange={setSearchText}
            onToggleGroup={toggleGroup}
            onSessionSelect={onSessionSelect}
            onSessionSettings={onSessionSettings}
            onToggleEnforcement={onToggleEnforcement}
            onToggleObserving={onToggleObserving}
            onLinkSpec={onLinkSpec}
            onRenameSession={onRenameSession}
            filterSessions={filterSessions}
          />
        ) : (
          <FilesTab
            lockWatchState={lockWatchState}
            projectPath={projects[0]?.path}
            onToggleLock={(path, locked) => onToggleLock?.(path, locked)}
            onToggleWatch={(path, watched) => onToggleWatch?.(path, watched)}
          />
        )}
      </div>

      {/* Resize handle — starts below the header so it doesn't block the close button */}
      <div
        className="absolute right-0 bottom-0 w-2.5 cursor-col-resize group z-10"
        style={{ top: 52 }}
        onMouseDown={onResizeMouseDown}
      >
        <div className="absolute right-0 top-1/2 -translate-y-1/2 w-[4px] h-[40px] rounded-full bg-white/0 group-hover:bg-white/10 transition-colors" />
      </div>
    </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sessions Mode
// ---------------------------------------------------------------------------

interface SessionsModeProps {
  projects: ExplorerProject[];
  collapsedGroupLabels: Set<string>;
  selectedSessionId: string | null;
  searchText: string;
  onSearchChange: (v: string) => void;
  onToggleGroup: (label: string) => void;
  onSessionSelect: (s: ExplorerSession) => void;
  onSessionSettings?: (s: ExplorerSession) => void;
  onToggleEnforcement?: (s: ExplorerSession) => void;
  onToggleObserving?: (s: ExplorerSession) => void;
  onLinkSpec?: (s: ExplorerSession) => void;
  onRenameSession?: (s: ExplorerSession) => void;
  filterSessions: (sessions: ExplorerSession[]) => ExplorerSession[];
}

function SessionsMode({
  projects, collapsedGroupLabels, selectedSessionId,
  searchText, onSearchChange, onToggleGroup, onSessionSelect,
  onSessionSettings, onToggleEnforcement,
  onToggleObserving, onLinkSpec, onRenameSession,
  filterSessions,
}: SessionsModeProps) {
  if (projects.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-6 text-center flex-1 py-8">
        {/* Glass orb — matches Swift: outer ring + inner frosted circle */}
        <div className="relative w-14 h-14">
          <div className="absolute inset-0 rounded-full" style={{
            background: 'conic-gradient(rgba(255,255,255,0.15) 0%, rgba(255,255,255,0.04) 25%, rgba(255,255,255,0.15) 50%, rgba(255,255,255,0.04) 75%, rgba(255,255,255,0.15) 100%)',
            padding: '1px',
          }}>
            <div className="w-full h-full rounded-full backdrop-blur-xl bg-white/[0.05] flex items-center justify-center">
              <FolderPlus size={22} className="text-white/40" strokeWidth={1.5} />
            </div>
          </div>
        </div>

        <div className="space-y-1.5">
          <p className="font-semibold">No Project Connected</p>
          <p className="text-[13px] text-white/40 leading-relaxed text-center">
            Start the server with a project path:
          </p>
        </div>

        <code className="text-[11px] text-white/50 bg-white/[0.06] border border-white/[0.08] px-3 py-2 rounded-lg leading-relaxed text-center">
          watchdog start --project-dir .
        </code>
      </div>
    );
  }

  return (
    <div className="pb-1">
      {/* Search bar (matches Swift: h:12, v:7) */}
      <div className="flex items-center gap-1.5 px-3 py-[7px]">
        <Search size={12} className="text-white/20 flex-shrink-0" />
        <input
          type="text"
          value={searchText}
          onChange={e => onSearchChange(e.target.value)}
          placeholder="Filter sessions"
          className="flex-1 bg-transparent text-[13px] text-white placeholder-white/20 outline-none"
        />
        {searchText && (
          <button onClick={() => onSearchChange('')} className="text-white/20 hover:text-white/40 cursor-pointer">
            <X size={12} />
          </button>
        )}
      </div>
      <div className="h-px bg-white/[0.08]" />

      {/* Session groups — flat list (single project bound to server) */}
      <div className="py-1">
        {projects[0]?.sessionGroups.map(group => {
          const filtered = filterSessions(group.sessions);
          const sorted = [...filtered].sort((a, b) => {
            if (a.isObserving !== b.isObserving) return a.isObserving ? -1 : 1;
            if (a.isAgentActive !== b.isAgentActive) return a.isAgentActive ? -1 : 1;
            return 0;
          });
          if (sorted.length === 0) return null;
          const isCollapsed = collapsedGroupLabels.has(group.label);

          return (
            <div key={group.label}>
              <button
                onClick={() => onToggleGroup(group.label)}
                className="w-full flex items-center gap-1.5 px-4 pl-4 py-[6px] cursor-pointer hover:bg-white/[0.03] transition-colors"
              >
                <ChevronRight
                  size={8}
                  className="text-white/30 flex-shrink-0 transition-transform"
                  style={{ transform: isCollapsed ? 'rotate(0deg)' : 'rotate(90deg)' }}
                  strokeWidth={3}
                />
                <span className="text-[13px] font-medium text-white/50 flex-1 text-left">
                  {group.label}
                </span>
                <span className="text-[11px] text-white/20">{sorted.length}</span>
              </button>

              {!isCollapsed && sorted.map(session => (
                <SessionRow
                  key={session.id}
                  session={session}
                  isSelected={selectedSessionId === session.id}
                  onClick={() => onSessionSelect(session)}
                  onSessionSettings={onSessionSettings}
                  onToggleEnforcement={onToggleEnforcement}
                  onToggleObserving={onToggleObserving}
                  onLinkSpec={onLinkSpec}
                  onRenameSession={onRenameSession}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Session Row — matches Swift sessionRow exactly
// ---------------------------------------------------------------------------

interface SessionRowProps {
  session: ExplorerSession;
  isSelected: boolean;
  onClick: () => void;
  onSessionSettings?: (s: ExplorerSession) => void;
  onToggleEnforcement?: (s: ExplorerSession) => void;
  onToggleObserving?: (s: ExplorerSession) => void;
  onLinkSpec?: (s: ExplorerSession) => void;
  onRenameSession?: (s: ExplorerSession) => void;
}

function SessionRow({
  session, isSelected, onClick, onSessionSettings, onToggleEnforcement,
  onToggleObserving, onLinkSpec, onRenameSession,
}: SessionRowProps) {
  const [hovered, setHovered] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const stripe = stripeColor(session);
  const orb = orbColor(session);
  const glowing = isOrbGlowing(session);
  const dead = session.serverDead;
  const showActions = hovered || isSelected;

  // Shield fill: shield.fill when hasEnforcement && isObserving (matches Swift)
  const enforcementFill = session.hasEnforcement && session.isObserving;
  const shieldCol = shieldColor(session);

  // Eye color: green when observing, gray 0.5 when not (matches Swift)
  const eyeColor = session.isObserving ? '#22c55e' : 'rgba(107,114,128,0.5)';

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setContextMenu(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [contextMenu]);

  return (
    <div
      className="relative"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onContextMenu={e => {
        e.preventDefault();
        setContextMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      {/* Row: matches Swift HStack layout */}
      {/* Leading padding 28, stripe inside, then content */}
      <div
        onClick={onClick}
        className={`flex items-stretch cursor-pointer pl-7 transition-colors ${
          showActions || isSelected ? 'bg-white/[0.05]' : 'hover:bg-white/[0.03]'
        }`}
        style={{ paddingRight: 12 }}
      >
        {/* Left health stripe — 3px, rounded, vertical padded 6 (matches Swift) */}
        <div className="flex items-stretch py-[6px] flex-shrink-0 mr-0 pr-0">
          <div
            className="w-[3px] rounded-full"
            style={{ background: stripe }}
          />
        </div>

        {/* Content: orb + text + spacer (leading:8, trailing:12, v:8) */}
        <div className="flex items-center gap-2.5 flex-1 min-w-0 pl-2 py-2">
          {/* Agent status orb */}
          <div className="relative w-5 h-5 flex items-center justify-center flex-shrink-0">
            <span
              className="w-2 h-2 rounded-full"
              style={{
                background: orb,
                boxShadow: glowing ? `0 0 6px 1px ${orb}` : 'none',
              }}
            />
          </div>

          {/* Text content — VStack spacing 3 */}
          <div className="flex-1 min-w-0">
            <p className={`text-[14px] truncate leading-tight ${dead ? 'text-white/30' : 'text-white'}`}>
              {session.name}
            </p>
            {/* Stats row — one line, matches Swift: contextBar + % + dot + cost + dot + duration */}
            <div className={`flex items-center gap-1.5 mt-0.5 ${dead ? 'opacity-40' : ''}`}>
              <ContextMiniBar percent={session.contextPercent} isDead={dead} width={40} />
              <span className="text-[11px] text-white/40">
                {Math.round(session.contextPercent * 100)}%
              </span>
              <DotSep size={2} />
              {/* Cost always shown (matches Swift — always renders $%.2f) */}
              <span className="text-[11px] text-white/40">
                ${session.cost.toFixed(2)}
              </span>
              {session.duration && (
                <>
                  <DotSep size={2} />
                  <span className="text-[11px] text-white/40">{session.duration}</span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Hover action overlay — gradient + 3 buttons (matches Swift) */}
        {showActions && (
          <div
            className="absolute inset-y-0 right-0 flex items-center pr-2 gap-0"
            style={{
              background: 'linear-gradient(to right, transparent 0%, rgba(18,18,20,0.7) 20%, rgba(18,18,20,0.9) 100%)',
              paddingLeft: 32,
            }}
          >
            {/* Shield: fill when hasEnforcement && isObserving */}
            <button
              onClick={e => {
                e.stopPropagation();
                if (session.isObserving) onToggleEnforcement?.(session);
              }}
              className="w-[26px] h-[26px] flex items-center justify-center rounded hover:bg-white/10 cursor-pointer transition-colors"
              title={session.hasEnforcement ? 'Enforcement On' : 'Enforcement Off'}
            >
              {enforcementFill
                ? <ShieldCheck size={14} style={{ color: shieldCol }} />
                : <Shield size={14} style={{ color: shieldCol }} />}
            </button>

            {/* Eye: green if observing, gray if not */}
            <button
              onClick={e => {
                e.stopPropagation();
                onToggleObserving?.(session);
              }}
              className="w-[26px] h-[26px] flex items-center justify-center rounded hover:bg-white/10 cursor-pointer transition-colors"
              title={session.isObserving ? 'Stop Observing' : 'Start Observing'}
            >
              {session.isObserving
                ? <Eye size={14} style={{ color: eyeColor }} />
                : <EyeOff size={14} style={{ color: eyeColor }} />}
            </button>

            {/* Ellipsis: settings */}
            <button
              onClick={e => {
                e.stopPropagation();
                onSessionSettings?.(session);
              }}
              className="w-[26px] h-[26px] flex items-center justify-center rounded hover:bg-white/10 cursor-pointer transition-colors"
              title="Options"
            >
              <MoreHorizontal size={14} className="text-white/40" />
            </button>
          </div>
        )}
      </div>

      {/* Context menu (matches Swift contextMenu items) */}
      {contextMenu && (
        <div
          ref={menuRef}
          className="fixed z-50 py-1 rounded-lg bg-[#1c1c1e] border border-white/10 shadow-xl min-w-[180px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <ContextMenuItem label="Rename" onClick={() => { setContextMenu(null); onRenameSession?.(session); }} />
          <ContextMenuItem label="Link Spec" onClick={() => { setContextMenu(null); onLinkSpec?.(session); }} />
          <div className="h-px bg-white/[0.06] my-1" />
          <ContextMenuItem
            label={session.isObserving ? 'Stop Observing' : 'Start Observing'}
            onClick={() => { setContextMenu(null); onToggleObserving?.(session); }}
          />
          <ContextMenuItem
            label={session.hasEnforcement ? 'Disable Enforcement' : 'Enable Enforcement'}
            onClick={() => { setContextMenu(null); onToggleEnforcement?.(session); }}
          />
          <div className="h-px bg-white/[0.06] my-1" />
          <ContextMenuItem label="Settings" onClick={() => { setContextMenu(null); onSessionSettings?.(session); }} />
        </div>
      )}
    </div>
  );
}

function ContextMenuItem({ label, onClick, destructive }: { label: string; onClick: () => void; destructive?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-[6px] text-[13px] hover:bg-white/[0.06] transition-colors cursor-pointer ${
        destructive ? 'text-red-400' : 'text-white/80'
      }`}
    >
      {label}
    </button>
  );
}

