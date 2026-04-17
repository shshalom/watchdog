import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useWatchdogStore } from './hooks/useWatchdogStore';
import { ProjectExplorer, type ExplorerProject, type ExplorerSession } from './components/panels/ProjectExplorer';
import AuditPanel from './components/panels/AuditPanel';
import ChangesPanel from './components/panels/ChangesPanel';
import SpecPanel from './components/panels/SpecPanel';
import TerminalPanel, { type TerminalPanelHandle } from './components/panels/TerminalPanel';
import GraphView from './components/graph/GraphView';
import { NodeDetailCard } from './components/graph/NodeDetailCard';
import type { DiscoveredSession } from './models/types';
import { ToastOverlay, useToast } from './components/Toast';
import { GraphControlPill, loadGraphSettings, type GraphSettings } from './components/graph/GraphSettingsPopover';
import SessionSettingsModal from './components/panels/SessionSettingsModal';
import { DebugOverlay } from './components/DebugOverlay';
import {
  useNotifications, getNotificationStyle, setNotificationStyle,
  getSystemPermission, requestSystemPermission,
  type NotificationStyle,
} from './hooks/useNotifications';

// ── Main App ────────────────────────────────────────────────────────

function App() {
  const store = useWatchdogStore();

  // Panel expansion — all start collapsed (matches Swift ContentView)
  const [explorerExpanded, setExplorerExpanded] = useState(false);
  const [explorerWidth, setExplorerWidth] = useState(330);
  const rightPanelsRef = useRef<HTMLDivElement>(null);
  const terminalPanelRef = useRef<TerminalPanelHandle>(null);
  const [auditExpanded, setAuditExpanded] = useState(false);
  const [specExpanded, setSpecExpanded] = useState(false);
  const [changesExpanded, setChangesExpanded] = useState(false);
  const [terminalExpanded, setTerminalExpanded] = useState(false);

  // Graph selection
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedNodePos, setSelectedNodePos] = useState({ x: 0, y: 0 });

  // Cross-panel navigation
  const [changesNavigatePath, setChangesNavigatePath] = useState<string | null>(null);

  // Settings modals
  const [showPreferences, setShowPreferences] = useState(false);
  const [showPortConfig, setShowPortConfig] = useState(false);
  const [sessionSettingsTarget, setSessionSettingsTarget] = useState<ExplorerSession | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ session: ExplorerSession; currentName: string } | null>(null);

  // Toast system
  const toast = useToast();
  const { notify } = useNotifications(toast.show);

  const openSpecPicker = useCallback(async () => {
    const { apiClient } = await import('./services/api-client');
    const path = await apiClient.pickFile('any', 'Select a spec file or folder');
    if (path) {
      store.linkSpec(path);
      toast.show('Spec linked', 'info');
    }
  }, [store, toast]);

  // Wire watch_triggered → notification (internal toast or system)
  useEffect(() => {
    store.setWatchTriggeredHandler((path, op) => {
      const name = path.split('/').pop() ?? path;
      const icon = op === 'read' ? '👁' : '✏️';
      notify({
        title: `${icon} Watched file ${op === 'read' ? 'read' : 'written'}`,
        body: name,
        type: 'warning',
      });
    });
  }, [store, notify]);

  // Graph settings
  const [graphSettings, setGraphSettings] = useState<GraphSettings>(loadGraphSettings);

  // Port config — show on first load if not connected
  // Default to the port this page was served from so localhost:1901 auto-connects to 1901
  const [port, setPort] = useState(() => {
    const p = parseInt(window.location.port, 10);
    return Number.isFinite(p) && p > 0 ? p : 9100;
  });
  const [hasAttemptedConnect, setHasAttemptedConnect] = useState(false);

  // On mount: try to connect with default port, expand explorer if connected
  useEffect(() => {
    if (!hasAttemptedConnect) {
      setHasAttemptedConnect(true);
      store.connect(port).then((connected) => {
        if (connected) {
          setExplorerExpanded(true);
        }
      });
    }
  }, [hasAttemptedConnect, port, store]);

  // Auto-expand explorer the FIRST time the server comes online only.
  // Using a ref so clicking close later doesn't re-open it.
  const didAutoExpand = useRef(false);
  useEffect(() => {
    if (store.serverOnline && !didAutoExpand.current) {
      didAutoExpand.current = true;
      setExplorerExpanded(true);
    }
  }, [store.serverOnline]);

  // ── Map discovered sessions → ProjectExplorer format ──────────

  const projects: ExplorerProject[] = useMemo(() => {
    if (!store.project) return [];

    const sessions = store.discoveredSessions;
    const now = Date.now();
    const dayMs = 86400000;
    const weekMs = dayMs * 7;

    // Real-time data for the currently selected session
    const selectedId = store.selectedSessionId;
    const hasDriftForSelected = store.issueThreads.some(i => !i.isResolved);
    const enforcementForSelected = store.config?.enforcement_enabled ?? true;

    const today: ExplorerSession[] = [];
    const thisWeek: ExplorerSession[] = [];
    const older: ExplorerSession[] = [];

    for (const s of sessions) {
      const isSelected = s.id === selectedId;
      // isObserving = true ONLY when this session is the one actively connected
      // to the watchdog server right now. s.is_active just means "used recently."
      const isObserving = isSelected && store.isConnected;
      const es = mapDiscoveredToExplorer(s, {
        isObserving,
        hasDrift: isSelected ? hasDriftForSelected : false,
        hasEnforcement: isSelected ? enforcementForSelected : true,
        agentState: isSelected ? store.agentState : 'idle',
        isAgentActive: isSelected && store.agentState !== 'idle',
        serverDead: false,
      });
      const age = now - new Date(s.last_modified).getTime();
      if (age < dayMs) today.push(es);
      else if (age < weekMs) thisWeek.push(es);
      else older.push(es);
    }

    const groups = [];
    if (today.length) groups.push({ label: 'Today', sessions: today });
    if (thisWeek.length) groups.push({ label: 'This Week', sessions: thisWeek });
    if (older.length) groups.push({ label: 'Older', sessions: older });

    return [{
      id: store.project.path.replace(/\//g, '-'),
      name: store.project.name,
      path: store.project.path,
      totalSessions: sessions.length,
      sessionGroups: groups,
    }];
  }, [
    store.project, store.discoveredSessions, store.selectedSessionId,
    store.issueThreads, store.config, store.isConnected, store.agentState,
  ]);

  // ── Handlers ──────────────────────────────────────────────────

  const handleSessionSelect = useCallback((session: ExplorerSession) => {
    store.selectSession(session.id);
  }, [store]);

  // Returns the max height the terminal panel is allowed to grow to —
  // stops just below the Changes panel button with a 16px gap.
  const getTerminalMaxHeight = useCallback(() => {
    if (!rightPanelsRef.current) return 600;
    const { bottom } = rightPanelsRef.current.getBoundingClientRect();
    return Math.max(200, window.innerHeight - bottom - 16);
  }, []);

  // Auto-start/switch terminal when the selected session changes.
  // Uses terminalSessionId to detect a session switch and always resume for the new session.
  useEffect(() => {
    const id = store.selectedSessionId;
    if (!id) return;
    if (store.terminalSessionId !== id) {
      store.startTerminalSession('resume', id);
      setTerminalExpanded(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.selectedSessionId]);

  const handleNodeSelect = useCallback((id: string | null, pos: { x: number; y: number }) => {
    setSelectedNodeId(id);
    setSelectedNodePos(pos);
  }, []);

  const handleConnectToPort = useCallback(async (newPort: number) => {
    setPort(newPort);
    const ok = await store.connect(newPort);
    if (ok) {
      setShowPortConfig(false);
      setExplorerExpanded(true);
    }
  }, [store]);

  const selectedNode = selectedNodeId
    ? store.graphNodes.find(n => n.id === selectedNodeId)
    : null;

  // ── Render ────────────────────────────────────────────────────

  return (
    <div className="h-screen w-screen overflow-hidden relative bg-zinc-950">
      {/* Graph (full background) */}
      <GraphView
        nodes={store.graphNodes}
        selectedNodeId={selectedNodeId}
        onSelectNode={handleNodeSelect}
        hasSessions={store.discoveredSessions.length > 0}
        isSessionSelected={store.selectedSessionId !== null}
        isLoading={store.isLoading}
        watchedPaths={store.lockWatchState.watches}
        connectionMode={graphSettings.connectionMode}
        sizeFactor={graphSettings.sizeFactor}
        repulsionForce={graphSettings.repulsionForce}
        lineWidth={graphSettings.lineWidth}
        gridOpacity={graphSettings.gridOpacity}
        showFileTypes={graphSettings.showFileTypes}
        ambientMotion={graphSettings.ambientMotion}
        showClusters={graphSettings.showClusters}
        clusterOpacity={graphSettings.clusterOpacity}
        showDeleted={graphSettings.showDeleted}
        minCollapse={graphSettings.minCollapse}
        onResumeSession={() => {
          const latest = store.discoveredSessions[0];
          if (latest) {
            store.selectSession(latest.id);
            setExplorerExpanded(true);
          }
        }}
      />

      {/* Node detail card (floating) */}
      {selectedNode && (
        <NodeDetailCard
          node={selectedNode}
          position={selectedNodePos}
          onDismiss={() => setSelectedNodeId(null)}
          onViewDiff={() => {
            setChangesNavigatePath(selectedNode.path);
            setSelectedNodeId(null);
          }}
          onViewAudit={() => setSelectedNodeId(null)}
        />
      )}

      {/* Graph controls — top centre: mode toggle + settings. Hidden when no session is active. */}
      {store.selectedSessionId !== null && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-30">
          <GraphControlPill
            mode={graphSettings.connectionMode}
            onChange={m => setGraphSettings(s => ({ ...s, connectionMode: m }))}
            settings={graphSettings}
            onSettingsChange={setGraphSettings}
          />
        </div>
      )}

      {/* Project Explorer (top-left overlay) */}
      <div className="absolute top-3 left-3 z-20">
        <ProjectExplorer
          projects={projects}
          projectName={store.project?.name}
          isExpanded={explorerExpanded}
          onToggle={() => setExplorerExpanded(v => !v)}
          selectedSessionId={store.selectedSessionId}
          onSessionSelect={handleSessionSelect}
          onSessionSettings={s => setSessionSettingsTarget(s)}
          onRenameSession={s => setRenameTarget({ session: s, currentName: s.name })}
          onLinkSpec={() => openSpecPicker()}
          lockWatchState={store.lockWatchState}
          onToggleLock={(path, locked) => store.toggleLock(path, locked)}
          onToggleWatch={(path, watched) => store.toggleWatch(path, watched)}
          onWidthChange={setExplorerWidth}
          onToggleEnforcement={s => store.toggleEnforcement(s.id, s.hasEnforcement)}
          onToggleObserving={s => {
            if (s.isObserving) {
              // Currently observing this session — stop
              store.clearSession();
              toast.show('Stopped observing session', 'info');
            } else {
              // Switch to (start observing) this session
              store.selectSession(s.id);
            }
          }}
        />
      </div>

      {/* Right panels (top-right overlay, stacked) */}
      <div ref={rightPanelsRef} className="absolute top-3 right-3 z-20 flex flex-col items-end gap-2">
        {/* Settings button — above Audit */}
        <button
          onClick={() => setShowPreferences(true)}
          className="w-10 h-10 rounded-xl glass flex items-center justify-center text-white/40 hover:text-white/70 transition-colors cursor-pointer"
          title="Preferences"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
        <AuditPanel
          auditTrail={store.auditTrail}
          issueThreads={store.issueThreads}
          isExpanded={auditExpanded}
          onToggle={() => setAuditExpanded(v => !v)}
          auditBatchInterval={store.auditBatchInterval}
          auditBatchStartTime={store.auditBatchStartTime}
          isAuditorWorking={store.isAuditorWorking}
          lockedPaths={store.lockWatchState.locks}
          onResolveIssue={(id, currentlyResolved) => store.resolveIssue(id, currentlyResolved)}
          onDismissIssue={(id) => store.dismissIssue(id)}
        />
        <SpecPanel
          specs={store.specs}
          isExpanded={specExpanded}
          onToggle={() => setSpecExpanded(v => !v)}
          auditMode={store.config?.audit_mode ?? undefined}
          onSpecsChanged={() => store.refreshSpecs()}
        />
        <ChangesPanel
          fileChanges={store.fileChanges}
          isExpanded={changesExpanded}
          onToggle={() => setChangesExpanded(v => !v)}
          navigateToPath={changesNavigatePath}
          onNavigateHandled={() => setChangesNavigatePath(null)}
        />
      </div>

      {/* Terminal (bottom overlay) */}
      <div
        className="absolute bottom-3 right-3 z-20"
        style={{ left: explorerExpanded ? 330 + 24 : 12 }}
      >
        <TerminalPanel
          ref={terminalPanelRef}
          isExpanded={terminalExpanded}
          onToggle={() => setTerminalExpanded(v => !v)}
          agentState={store.agentState}
          isRunning={store.isRunning}
          leftOffset={explorerExpanded ? explorerWidth + 24 : 12}
          onGetMaxHeight={getTerminalMaxHeight}
          hasSessionsInProject={store.discoveredSessions.length > 0}
          hasProjectSelected={store.project !== null}
          shouldShowHandoff={store.selectedSessionId !== null}
          handoffAction={{
            label: ({
              none:     'Handoff to New Session',
              creating: 'Creating Handoff…',
              created:  'Handoff to New Session',
              outdated: 'Update Handoff',
              used:     'Handoff Used ✓',
            } as const)[store.handoffState],
            color: ({
              none:     'text-orange-400',
              creating: 'text-blue-400',
              created:  'text-green-400',
              outdated: 'text-amber-400',
              used:     'text-zinc-500',
            } as const)[store.handoffState],
            bgColor: ({
              none:     'bg-orange-400/10',
              creating: 'bg-blue-400/10',
              created:  'bg-green-400/10',
              outdated: 'bg-amber-400/10',
              used:     'bg-zinc-500/10',
            } as const)[store.handoffState],
            disabled: store.handoffState === 'creating' || store.handoffState === 'used',
          }}
          terminalId={store.terminalId}
          terminalWsUrl={store.terminalWsUrl}
          onResume={() => {
            const latest = store.discoveredSessions[0];
            if (!latest) return;
            if (store.selectedSessionId === latest.id) {
              // Already observing — just restart the terminal
              store.startTerminalSession('resume', latest.id);
            } else {
              // Resume observation (selectSession re-registers + reloads data)
              // The auto-start effect handles terminal start
              store.selectSession(latest.id);
            }
            setTerminalExpanded(true);
          }}
          onNewSession={() => {
            store.startTerminalSession('new');
            setTerminalExpanded(true);
          }}
          onPerformHandoff={() => {
            terminalPanelRef.current?.sendInput(
              'create a handoff document summarizing this session for the next agent\r'
            );
          }}
          onTerminalClosed={() => store.stopTerminal()}
        />
      </div>


      {/* Server not reachable — connection prompt */}
      {!store.serverOnline && hasAttemptedConnect && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <ServerConnectDialog port={port} onConnect={handleConnectToPort} />
        </div>
      )}

      {/* Loading indicator */}
      {store.isLoading && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-50 px-4 py-2 glass rounded-full text-sm text-white/60 flex items-center gap-2">
          <span className="w-3 h-3 border-2 border-white/30 border-t-white/80 rounded-full animate-spin" />
          Loading session...
        </div>
      )}

      {/* Toast notifications */}
      <ToastOverlay messages={toast.messages} onDismiss={toast.dismiss} />

      {/* Debug console overlay (dev only) */}
      <DebugOverlay />

      {/* Preferences modal placeholder */}
      {showPreferences && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={() => setShowPreferences(false)}>
          <div className="glass-panel w-[520px] p-6" onClick={e => e.stopPropagation()}>
            <PreferencesPanel config={store.config} onUpdate={store.updateConfig} onClose={() => setShowPreferences(false)} />
          </div>
        </div>
      )}

      {/* Port config modal */}
      {showPortConfig && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={() => setShowPortConfig(false)}>
          <div onClick={e => e.stopPropagation()}>
            <ServerConnectDialog port={port} onConnect={handleConnectToPort} />
          </div>
        </div>
      )}

      {/* Session Settings modal */}
      {sessionSettingsTarget && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={() => setSessionSettingsTarget(null)}>
          <div onClick={e => e.stopPropagation()}>
            <SessionSettingsModal
              session={{
                id: sessionSettingsTarget.id,
                name: sessionSettingsTarget.name,
                isObserving: sessionSettingsTarget.isObserving,
                hasEnforcement: sessionSettingsTarget.hasEnforcement,
                hasDrift: sessionSettingsTarget.hasDrift,
                contextPercent: sessionSettingsTarget.contextPercent,
                cost: sessionSettingsTarget.cost,
                duration: sessionSettingsTarget.duration,
                agentState: sessionSettingsTarget.agentState,
                specPaths: sessionSettingsTarget.id === store.selectedSessionId
                  ? store.specs.map(s => s.path)
                  : sessionSettingsTarget.specPaths,
                auditMode: store.config?.audit_mode ?? 'balanced',
              }}
              onClose={() => setSessionSettingsTarget(null)}
              onRename={(label: string) => store.renameSession(sessionSettingsTarget.id, label)}
              onToggleEnforcement={() => store.toggleEnforcement(sessionSettingsTarget.id, sessionSettingsTarget.hasEnforcement)}
              onChangeAuditMode={(mode: string) => store.updateConfig({ audit_mode: mode })}
              onLinkSpec={async () => {
                const { apiClient } = await import('./services/api-client');
                const path = await apiClient.pickFile('any', 'Select a spec file or folder');
                if (path) {
                  await store.linkSpec(path);
                  store.refreshSpecs();
                  toast.show('Spec linked', 'info');
                }
                // Modal stays open regardless — user closes it explicitly
              }}
              onUnlinkSpec={async (path: string) => {
                const { apiClient } = await import('./services/api-client');
                const remaining = store.specs.filter(s => s.path !== path).map(s => s.path);
                await apiClient.reloadSpecs(remaining);
                store.refreshSpecs();
              }}
            />
          </div>
        </div>
      )}

      {/* Rename dialog */}
      {renameTarget && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={() => setRenameTarget(null)}>
          <div className="glass-panel px-6 py-5 w-[380px] flex flex-col gap-4" onClick={e => e.stopPropagation()}>
            <p className="font-semibold">Rename Session</p>
            <RenameInput
              initial={renameTarget.currentName}
              onSave={name => {
                store.renameSession(renameTarget.session.id, name);
                setRenameTarget(null);
              }}
              onCancel={() => setRenameTarget(null)}
            />
          </div>
        </div>
      )}

    </div>
  );
}

// ── Helper: map DiscoveredSession → ExplorerSession ─────────────

interface SessionEnrichment {
  isObserving: boolean;
  isAgentActive: boolean;
  hasDrift: boolean;
  hasEnforcement: boolean;
  agentState: import('./models/types').AgentState;
  serverDead: boolean;
}

function mapDiscoveredToExplorer(s: DiscoveredSession, enrich: SessionEnrichment): ExplorerSession {
  const usage = s.usage;
  const durationMs = usage?.duration_ms ?? 0;
  let duration = '';
  if (durationMs > 0) {
    const sec = Math.floor(durationMs / 1000);
    if (sec < 60) duration = `${sec}s`;
    else if (sec < 3600) duration = `${Math.floor(sec / 60)}m`;
    else duration = `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  }

  const contextPercent = usage
    ? (usage.context_window > 0 ? (usage.context_pct / 100) : 0)
    : 0;

  return {
    id: s.id,
    name: s.label ?? s.id.slice(0, 8),
    contextPercent,
    cost: usage?.cost ?? 0,
    duration,
    specPaths: [],
    ...enrich,
  };
}

// ── Small dialog helpers ────────────────────────────────────────

function RenameInput({ initial, onSave, onCancel }: { initial: string; onSave: (name: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial);
  return (
    <div className="flex flex-col gap-3">
      <input
        autoFocus
        type="text"
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && value.trim()) onSave(value.trim());
          if (e.key === 'Escape') onCancel();
        }}
        className="bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-white/20"
      />
      <div className="flex gap-2 justify-end">
        <button onClick={onCancel} className="px-4 py-1.5 text-sm text-white/40 hover:text-white/70 cursor-pointer">Cancel</button>
        <button
          onClick={() => value.trim() && onSave(value.trim())}
          className="px-4 py-1.5 text-sm font-medium bg-blue-500/20 text-blue-400 rounded-full hover:bg-blue-500/30 cursor-pointer"
        >Rename</button>
      </div>
    </div>
  );
}


// ── Server Connect Dialog ───────────────────────────────────────

function ServerConnectDialog({ port: initialPort, onConnect }: { port: number; onConnect: (port: number) => void }) {
  const [port, setPort] = useState(initialPort);
  const [trying, setTrying] = useState(false);

  const handleConnect = async () => {
    setTrying(true);
    await onConnect(port);
    setTrying(false);
  };

  return (
    <div className="glass-panel px-6 py-5 flex flex-col items-center gap-4 w-[380px]">
      {/* Glass orb */}
      <div className="relative w-14 h-14">
        <div className="absolute inset-0 rounded-full" style={{ background: 'conic-gradient(rgba(255,255,255,0.15), rgba(255,255,255,0.04), rgba(255,255,255,0.15))', padding: 1 }}>
          <div className="w-full h-full rounded-full backdrop-blur-xl bg-white/5 flex items-center justify-center">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-white/40">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
          </div>
        </div>
      </div>

      <div className="text-center">
        <p className="font-semibold">Agent Watchdog</p>
        <p className="text-sm text-white/40 mt-1">Connect to a running watchdog server.</p>
      </div>

      <div className="flex items-center gap-2 w-full">
        <label className="text-xs text-white/30 w-10">Port</label>
        <input
          type="number"
          value={port}
          onChange={e => setPort(Number(e.target.value))}
          onKeyDown={e => e.key === 'Enter' && handleConnect()}
          className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-white/20 transition-colors"
        />
      </div>

      <button
        onClick={handleConnect}
        disabled={trying}
        className="w-full px-4 py-2.5 text-sm font-medium bg-blue-500/20 text-blue-400 rounded-full hover:bg-blue-500/30 transition-colors cursor-pointer disabled:opacity-50"
      >
        {trying ? (
          <span className="flex items-center justify-center gap-2">
            <span className="w-3 h-3 border-2 border-blue-400/30 border-t-blue-400 rounded-full animate-spin" />
            Connecting...
          </span>
        ) : 'Connect'}
      </button>

      <p className="text-[11px] text-white/20 text-center leading-relaxed">
        Start the server with:<br />
        <code className="text-white/40 bg-white/5 px-1.5 py-0.5 rounded">
          watchdog start --spec spec.md --project-dir .
        </code>
      </p>
    </div>
  );
}

// ── Preferences Panel (simplified — matches Swift 4-tab layout) ─

function PreferencesPanel({ config, onUpdate, onClose }: {
  config: import('./models/types').WatchdogConfig | null;
  onUpdate: (values: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'general' | 'auditor' | 'notifications' | 'appearance'>('general');
  const tabs = [
    { id: 'general' as const, label: 'General', icon: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z' },
    { id: 'auditor' as const, label: 'Auditor', icon: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z' },
    { id: 'notifications' as const, label: 'Notifications', icon: 'M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0' },
    { id: 'appearance' as const, label: 'Appearance', icon: 'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5' },
  ];

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">Preferences</h2>
        <button onClick={onClose} className="text-white/30 hover:text-white/60 cursor-pointer">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
        </button>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 mb-4">
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors cursor-pointer ${
              tab === t.id ? 'bg-white/10 text-white font-medium' : 'text-white/30 hover:text-white/50'
            }`}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d={t.icon} /></svg>
            {t.label}
          </button>
        ))}
      </div>

      <div className="h-px bg-white/5 mb-4" />

      {/* Tab content */}
      {tab === 'general' && (
        <div className="space-y-3">
          <SettingRow label="CLI Port" value={String(config?.api_port ?? 9100)} />
          <SettingToggle label="Auditor Enabled" checked={config?.auditor_enabled ?? true} onChange={v => onUpdate({ auditor_enabled: v })} />
          <SettingToggle label="Enforcement Enabled" checked={config?.enforcement_enabled ?? true} onChange={v => onUpdate({ enforcement_enabled: v })} />
        </div>
      )}
      {tab === 'auditor' && (
        <div className="space-y-3">
          <SettingRow label="Model" value={config?.auditor_model ?? 'claude-sonnet-4-6'} />
          <SettingRow label="Batch Interval" value={`${config?.batch_interval_seconds ?? 15}s`} />
          <SettingRow label="Escalation Threshold" value={`${config?.escalation_threshold ?? 3} attempts`} />
          <SettingRow label="Audit Mode" value={config?.audit_mode ?? 'balanced'} />
        </div>
      )}
      {tab === 'notifications' && (
        <NotificationsTab />
      )}
      {tab === 'appearance' && (
        <div className="space-y-3">
          <p className="text-sm text-white/30">Theme settings coming soon.</p>
        </div>
      )}
    </div>
  );
}

// ── Notifications Tab ───────────────────────────────────────────────

function NotificationsTab() {
  const [style, setStyleState] = useState<NotificationStyle>(getNotificationStyle);
  const [permission, setPermission] = useState<NotificationPermission>(getSystemPermission);

  const switchStyle = (s: NotificationStyle) => {
    setNotificationStyle(s);
    setStyleState(s);
  };

  const handleRequestPermission = async () => {
    const result = await requestSystemPermission();
    setPermission(result);
    if (result === 'granted') switchStyle('system');
  };

  const styles: { id: NotificationStyle; label: string; desc: string }[] = [
    { id: 'internal', label: 'In-app', desc: 'Toast banners inside the dashboard' },
    { id: 'system',  label: 'System', desc: 'macOS / browser native notifications' },
  ];

  return (
    <div className="space-y-4">
      <p className="text-xs text-white/30 leading-relaxed">
        Choose how AgentWatchdog delivers alerts (watch triggers, rule violations).
      </p>

      <div className="flex flex-col gap-2">
        {styles.map(s => (
          <button
            key={s.id}
            onClick={() => {
              if (s.id === 'system' && permission !== 'granted') {
                handleRequestPermission();
              } else {
                switchStyle(s.id);
              }
            }}
            className={`flex items-start gap-3 px-3 py-2.5 rounded-xl border transition-colors cursor-pointer text-left ${
              style === s.id
                ? 'border-blue-500/40 bg-blue-500/10'
                : 'border-white/8 bg-white/[0.03] hover:bg-white/[0.06]'
            }`}
          >
            <div className={`mt-0.5 w-3.5 h-3.5 rounded-full border-2 flex-shrink-0 flex items-center justify-center ${
              style === s.id ? 'border-blue-400' : 'border-white/20'
            }`}>
              {style === s.id && <div className="w-1.5 h-1.5 rounded-full bg-blue-400" />}
            </div>
            <div>
              <p className={`text-sm font-medium ${style === s.id ? 'text-white' : 'text-white/60'}`}>{s.label}</p>
              <p className="text-[11px] text-white/30 mt-0.5">{s.desc}</p>
            </div>
          </button>
        ))}
      </div>

      {style === 'system' && permission !== 'granted' && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="#f59e0b"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>
          <p className="text-[11px] text-amber-400/80 flex-1">
            {permission === 'denied'
              ? 'Notifications blocked in browser — enable in system settings.'
              : 'Permission required.'}
          </p>
          {permission === 'default' && (
            <button
              onClick={handleRequestPermission}
              className="text-[11px] font-medium text-amber-400 hover:text-amber-300 cursor-pointer"
            >
              Allow
            </button>
          )}
        </div>
      )}

      {style === 'system' && permission === 'granted' && (
        <p className="text-[11px] text-white/20 px-1">System notifications are active.</p>
      )}
    </div>
  );
}

function SettingRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-white/60">{label}</span>
      <span className="text-sm text-white/80 font-mono">{value}</span>
    </div>
  );
}

function SettingToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-white/60">{label}</span>
      <button
        onClick={() => onChange(!checked)}
        className={`w-10 h-6 rounded-full transition-colors cursor-pointer ${checked ? 'bg-blue-500' : 'bg-white/10'}`}
      >
        <span className={`block w-4 h-4 rounded-full bg-white transition-transform mx-1 ${checked ? 'translate-x-4' : 'translate-x-0'}`} />
      </button>
    </div>
  );
}

export default App;
