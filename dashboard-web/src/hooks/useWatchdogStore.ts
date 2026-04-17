import { useState, useCallback, useRef, useEffect } from 'react';
import type {
  GraphNodeVM, AuditEntryVM, IssueThreadVM, SpecVM, FileChangeVM,
  WebSocketEvent, AgentState, ProjectInfo, DiscoveredSession, WatchdogConfig,
} from '../models/types';
import type { LockWatchState } from '../models/types';
import { extensionColor, fileName, fileExt, fileDir } from '../models/types';
import { apiClient } from '../services/api-client';
import { wsClient } from '../services/websocket-client';
import { mapFileToGraphNode, mapAuditEntry, mapIssueThread, mapSpec } from '../services/model-mapping';
import { parseDiff } from '../services/diff-parser';

// ── State shape ─────────────────────────────────────────────────────

export interface WatchdogState {
  // Connection
  serverOnline: boolean;
  isConnected: boolean;
  isLoading: boolean;
  error: string | null;
  // Project & sessions (from discovery API)
  project: ProjectInfo | null;
  discoveredSessions: DiscoveredSession[];
  // Selected session data
  selectedSessionId: string | null;
  graphNodes: GraphNodeVM[];
  auditTrail: AuditEntryVM[];
  issueThreads: IssueThreadVM[];
  specs: SpecVM[];
  fileChanges: FileChangeVM[];
  // Auditor
  auditBatchInterval: number;
  auditBatchStartTime: number;
  isAuditorWorking: boolean;
  // Agent
  agentState: AgentState;
  lastBlockTime: number | null;
  activeIssueCount: number;
  // Config
  config: WatchdogConfig | null;
  // Lock/Watch
  lockWatchState: LockWatchState;
  // Terminal
  isRunning: boolean;
  terminalId: string | null;
  terminalSessionId: string | null;
  terminalWsUrl: string | null;  // locked at start time — avoids stale-port issues
  // Handoff lifecycle
  handoffState: 'none' | 'creating' | 'created' | 'outdated' | 'used';
  handoffPath: string | null;
  // Context window usage for the selected session (0–100)
  contextPercent: number;
}

const INITIAL_STATE: WatchdogState = {
  serverOnline: false,
  isConnected: false,
  isLoading: false,
  error: null,
  project: null,
  discoveredSessions: [],
  selectedSessionId: null,
  graphNodes: [],
  auditTrail: [],
  issueThreads: [],
  specs: [],
  fileChanges: [],
  auditBatchInterval: 15,
  auditBatchStartTime: Date.now(),
  isAuditorWorking: false,
  agentState: 'idle',
  lastBlockTime: null,
  activeIssueCount: 0,
  config: null,
  lockWatchState: { locks: [], watches: [] },
  isRunning: false,
  terminalId: null,
  terminalSessionId: null,
  terminalWsUrl: null,
  handoffState: 'none',
  handoffPath: null,
  contextPercent: 0,
};

// ── Hook ────────────────────────────────────────────────────────────

export function useWatchdogStore() {
  const [state, setState] = useState<WatchdogState>(INITIAL_STATE);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const diffDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingDiffPaths = useRef(new Set<string>());
  const activityTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initializedRef = useRef(false);
  // Optional callback for watch_triggered events (wired by App.tsx for toasts)
  const onWatchTriggeredRef = useRef<((path: string, op: string) => void) | null>(null);
  // Tracks current session for async handlers that can't close over state
  const selectedSessionIdRef = useRef<string | null>(null);
  const projectPathRef = useRef<string>('');
  // Ref for refreshing audit trail + issues after drift/audit WS events
  const refreshAuditRef = useRef<(() => void) | null>(null);
  // Ref so terminal_exited handler can call clearSession without a dep cycle
  const clearSessionRef = useRef<() => void>(() => {});

  const patch = useCallback((updates: Partial<WatchdogState>) => {
    setState(prev => ({ ...prev, ...updates }));
  }, []);

  // ── Agent activity tracking ─────────────────────────────────────

  const markActive = useCallback((toolName?: string) => {
    const agentState: AgentState = toolName && ['Write', 'Edit', 'Bash'].includes(toolName) ? 'modifying' : 'working';
    patch({ agentState });
    if (activityTimeoutRef.current) clearTimeout(activityTimeoutRef.current);
    activityTimeoutRef.current = setTimeout(() => patch({ agentState: 'idle' }), 12000);
  }, [patch]);

  // ── Debounced diff fetching ─────────────────────────────────────

  const scheduleDiffFetch = useCallback((path: string, sessionId: string) => {
    pendingDiffPaths.current.add(path);
    if (diffDebounceRef.current) clearTimeout(diffDebounceRef.current);
    diffDebounceRef.current = setTimeout(async () => {
      const paths = [...pendingDiffPaths.current];
      pendingDiffPaths.current.clear();
      const newChanges: FileChangeVM[] = [];
      for (const p of paths) {
        try {
          const diff = await apiClient.fetchFileDiff(sessionId, p);
          const hunks = parseDiff(diff.diff);
          const additions = hunks.flatMap(h => h.lines).filter(l => l.type === 'addition').length;
          const removals = hunks.flatMap(h => h.lines).filter(l => l.type === 'removal').length;
          newChanges.push({
            id: p, path: p, name: fileName(p), ext: fileExt(p),
            directory: fileDir(p), operation: diff.operation, hunks, additions, removals,
          });
        } catch { /* silent */ }
      }
      if (newChanges.length > 0) {
        setState(prev => {
          const updated = [...prev.fileChanges];
          for (const nc of newChanges) {
            const idx = updated.findIndex(c => c.path === nc.path);
            if (idx >= 0) updated[idx] = nc;
            else updated.push(nc);
          }
          return { ...prev, fileChanges: updated };
        });
      }
    }, 1000);
  }, []);

  // ── WebSocket event handler ─────────────────────────────────────

  const handleWsEvent = useCallback((event: WebSocketEvent) => {
    setState(prev => {
      const next = { ...prev };
      switch (event.type) {
        case 'file_intent': {
          markActive(event.tool_name);
          const idx = next.graphNodes.findIndex(n => n.path === event.path);
          if (idx >= 0) {
            const nodes = [...next.graphNodes];
            nodes[idx] = { ...nodes[idx], operation: event.operation, timestamp: event.timestamp, auditStatus: 'pending' };
            next.graphNodes = nodes;
          } else {
            next.graphNodes = [...next.graphNodes, {
              id: event.path, path: event.path, name: fileName(event.path),
              ext: fileExt(event.path), directory: event.directory,
              color: extensionColor(event.path), operation: event.operation,
              changeSize: 0, auditStatus: 'pending', imports: [], timestamp: event.timestamp,
            }];
          }
          break;
        }
        case 'file_activity': {
          markActive();
          const idx = next.graphNodes.findIndex(n => n.path === event.path);
          if (idx >= 0) {
            const nodes = [...next.graphNodes];
            nodes[idx] = { ...nodes[idx], operation: event.operation, changeSize: event.change_size, timestamp: event.timestamp };
            next.graphNodes = nodes;
          } else {
            next.graphNodes = [...next.graphNodes, {
              id: event.path, path: event.path, name: fileName(event.path),
              ext: fileExt(event.path), directory: event.directory,
              color: extensionColor(event.path), operation: event.operation,
              changeSize: event.change_size, auditStatus: 'pending', imports: [], timestamp: event.timestamp,
            }];
          }
          if (prev.selectedSessionId) scheduleDiffFetch(event.path, prev.selectedSessionId);
          break;
        }
        case 'audit_complete': {
          next.isAuditorWorking = false;
          if (event.results) {
            const nodes = [...next.graphNodes];
            for (const r of event.results) {
              const idx = nodes.findIndex(n => n.path === r.path);
              if (idx >= 0) {
                nodes[idx] = { ...nodes[idx], auditStatus: r.verdict === 'aligned' ? 'aligned' : 'drift' };
              }
            }
            next.graphNodes = nodes;
          }
          // Refresh audit trail + issues so Audit panel updates without page reload
          setTimeout(() => refreshAuditRef.current?.(), 0);
          break;
        }
        case 'drift_detected': {
          next.lastBlockTime = Date.now();
          const nodes = [...next.graphNodes];
          const idx = nodes.findIndex(n => n.path === event.file_path);
          if (idx >= 0) {
            nodes[idx] = { ...nodes[idx], auditStatus: 'drift', driftEventId: event.drift_event_id, timestamp: new Date().toISOString() };
            next.graphNodes = nodes;
          }
          // Refresh issue threads so Audit panel shows new drift without a page reload
          setTimeout(() => refreshAuditRef.current?.(), 0);
          break;
        }
        case 'drift_resolved': {
          const nodes = [...next.graphNodes];
          const idx = nodes.findIndex(n => n.driftEventId === event.drift_event_id);
          if (idx >= 0) {
            nodes[idx] = { ...nodes[idx], auditStatus: 'aligned', driftEventId: undefined };
            next.graphNodes = nodes;
          }
          break;
        }
        case 'batch_started': {
          next.isAuditorWorking = true;
          next.auditBatchStartTime = Date.now();
          break;
        }
        case 'rule_violation': {
          if (event.action === 'denied') next.lastBlockTime = Date.now();
          break;
        }
        case 'session_status_changed': break;
        case 'watch_triggered':
          onWatchTriggeredRef.current?.(event.path, event.operation);
          break;
        case 'specs_reloaded': {
          // Async — run outside setState
          const sessionId = selectedSessionIdRef.current;
          if (sessionId) {
            setTimeout(async () => {
              try {
                const specResp = await apiClient.fetchSpec(sessionId);
                const specs = (specResp.specs ?? []).map(mapSpec);
                patch({ specs });
              } catch {
                // 404 = all specs unlinked
                patch({ specs: [] });
              }
            }, 0);
          }
          break;
        }
        case 'terminal_exited': {
          if (event.terminal_id === next.terminalId) {
            next.isRunning = false;
            next.terminalId = null;
            next.terminalSessionId = null;
            // Stop server observation — runs after setState settles
            setTimeout(() => clearSessionRef.current(), 0);
          }
          break;
        }
        case 'handoff_creating':
          next.handoffState = 'creating';
          break;
        case 'handoff_updated':
          next.handoffState = event.is_outdated ? 'outdated' : 'created';
          next.handoffPath = event.path;
          break;
        case 'handoff_used':
          next.handoffState = 'used';
          break;
      }
      return next;
    });
  }, [markActive, scheduleDiffFetch, patch]);

  // ── Connect to server + discover project & sessions ─────────────

  const connect = useCallback(async (port?: number) => {
    if (port) apiClient.updatePort(port);

    try {
      // Fetch project info and sessions in parallel
      const [project, sessions, config] = await Promise.all([
        apiClient.fetchProject(),
        apiClient.discoverSessions(),
        apiClient.fetchConfig().catch(() => null),
      ]);

      projectPathRef.current = project?.path ?? '';
      patch({
        serverOnline: true,
        isConnected: true,
        error: null,
        project,
        discoveredSessions: sessions,
        config,
        auditBatchInterval: config?.batch_interval_seconds ?? 15,
      });

      // Connect WebSocket for real-time events
      const wsPort = port ?? apiClient.currentPort();
      wsClient.connect(wsPort, handleWsEvent, (connected) => patch({ isConnected: connected }));

      // Fetch lock/watch state
      fetchLockWatchState();

      return true;
    } catch {
      patch({ serverOnline: false, isConnected: false, error: 'Cannot reach watchdog server', isRunning: false, terminalId: null, terminalSessionId: null, terminalWsUrl: null });
      return false;
    }
  }, [patch, handleWsEvent]);

  // ── Refresh discovered sessions (for polling) ───────────────────

  const refreshSessions = useCallback(async () => {
    try {
      const sessions = await apiClient.discoverSessions();
      patch({ discoveredSessions: sessions, serverOnline: true });
      // Re-establish WebSocket if it dropped (exhausted reconnect attempts during a server restart)
      if (!wsClient.isConnected) {
        wsClient.connect(
          apiClient.currentPort(),
          handleWsEvent,
          (connected) => patch({ isConnected: connected }),
        );
      }
    } catch {
      patch({ serverOnline: false, isRunning: false, terminalId: null, terminalSessionId: null, terminalWsUrl: null });
      return;
    }
    // Keep context_percent fresh for the selected session
    const id = selectedSessionIdRef.current;
    if (id) {
      try {
        const detail = await apiClient.fetchSessionDetail(id);
        patch({ contextPercent: detail.context_percent ?? 0 });
      } catch { /* silent */ }
    }
  }, [patch, handleWsEvent]);

  // ── Select session — fetch all data ─────────────────────────────

  const selectSessionInternal = useCallback(async (sessionId: string) => {
    selectedSessionIdRef.current = sessionId;
    patch({ isLoading: true, error: null, selectedSessionId: sessionId });

    try {
      // Register session with the server
      try { await apiClient.registerSession(sessionId); } catch { /* already registered */ }

      // Parallel fetch
      const [filesResp, auditResp, issuesResp] = await Promise.all([
        apiClient.fetchFiles(sessionId),
        apiClient.fetchAuditTrail(sessionId),
        apiClient.fetchIssues(sessionId),
      ]);

      let specs: SpecVM[] = [];
      try {
        const specResp = await apiClient.fetchSpec(sessionId);
        specs = (specResp.specs ?? []).map(mapSpec);
      } catch { /* no specs linked */ }

      const graphNodes = filesResp.files.map(mapFileToGraphNode);
      const auditTrail = auditResp.entries.map(mapAuditEntry);
      const issueThreads = issuesResp.map(mapIssueThread);

      // Fetch diffs for modified files
      const fileChanges: FileChangeVM[] = [];
      for (const file of filesResp.files.filter(f => f.operation !== 'read')) {
        try {
          const diff = await apiClient.fetchFileDiff(sessionId, file.path);
          const hunks = parseDiff(diff.diff);
          const additions = hunks.flatMap(h => h.lines).filter(l => l.type === 'addition').length;
          const removals = hunks.flatMap(h => h.lines).filter(l => l.type === 'removal').length;
          fileChanges.push({
            id: file.path, path: file.path, name: fileName(file.path), ext: fileExt(file.path),
            directory: fileDir(file.path), operation: file.operation, hunks, additions, removals,
          });
        } catch { /* no diff yet */ }
      }

      // Fetch context_percent from session detail
      let contextPercent = 0;
      try {
        const detail = await apiClient.fetchSessionDetail(sessionId);
        contextPercent = detail.context_percent ?? 0;
      } catch { /* no detail yet */ }

      // Hydrate handoff state from server
      let handoffState: WatchdogState['handoffState'] = 'none';
      let handoffPath: string | null = null;
      try {
        const h = await apiClient.fetchHandoff();
        if (h) {
          handoffState = h.handoff_state as WatchdogState['handoffState'];
          handoffPath = h.path;
        }
      } catch { /* silent */ }

      patch({
        graphNodes, auditTrail, issueThreads, specs, fileChanges,
        isLoading: false,
        activeIssueCount: issueThreads.filter(i => !i.isResolved).length,
        contextPercent,
        handoffState,
        handoffPath,
      });
    } catch (err) {
      patch({ isLoading: false, error: `Failed to load session: ${err}` });
    }
  }, [patch]);

  const selectSession = useCallback((sessionId: string) => {
    selectSessionInternal(sessionId);
  }, [selectSessionInternal]);

  // ── Update config ───────────────────────────────────────────────

  const updateConfig = useCallback(async (values: Record<string, unknown>) => {
    try {
      await apiClient.updateConfig(values);
      const config = await apiClient.fetchConfig();
      patch({ config, auditBatchInterval: config.batch_interval_seconds });
    } catch { /* silent */ }
  }, [patch]);

  // ── Toggle enforcement for a session ────────────────────────────

  const toggleEnforcement = useCallback(async (sessionId: string, currentValue: boolean) => {
    const newValue = !currentValue;
    // Optimistically update so the toggle reflects immediately.
    // fetchConfig() returns the global setting and doesn't see per-session overrides,
    // so we update local state directly instead of re-fetching.
    setState(prev => ({
      ...prev,
      config: prev.config ? { ...prev.config, enforcement_enabled: newValue } : prev.config,
    }));
    try {
      await apiClient.updateSessionConfig(sessionId, { enforcement_enabled: newValue });
    } catch {
      // Revert on failure
      setState(prev => ({
        ...prev,
        config: prev.config ? { ...prev.config, enforcement_enabled: currentValue } : prev.config,
      }));
    }
  }, []);

  // ── Rename a session (write custom-title to transcript) ─────────

  const renameSession = useCallback(async (sessionId: string, label: string) => {
    try {
      await apiClient.setSessionLabel(sessionId, label);
      // Update the label immediately in local state
      setState(prev => ({
        ...prev,
        discoveredSessions: prev.discoveredSessions.map(s =>
          s.id === sessionId ? { ...s, label, label_source: 'user' } : s
        ),
      }));
    } catch { /* silent */ }
  }, []);

  // ── Refresh specs for the current session ───────────────────────

  const refreshAuditAndIssues = useCallback(async () => {
    const sessionId = selectedSessionIdRef.current;
    if (!sessionId) return;
    try {
      const [auditResp, issuesResp] = await Promise.all([
        apiClient.fetchAuditTrail(sessionId),
        apiClient.fetchIssues(sessionId),
      ]);
      const auditTrail = auditResp.entries.map(mapAuditEntry);
      const issueThreads = issuesResp.map(mapIssueThread);
      patch({
        auditTrail,
        issueThreads,
        activeIssueCount: issueThreads.filter(i => !i.isResolved).length,
      });
    } catch { /* silent */ }
  }, [patch]);
  refreshAuditRef.current = refreshAuditAndIssues;

  const refreshSpecs = useCallback(async () => {
    const sessionId = selectedSessionIdRef.current;
    if (!sessionId) return;
    try {
      const specResp = await apiClient.fetchSpec(sessionId);
      const specs = (specResp.specs ?? []).map(mapSpec);
      patch({ specs });
    } catch {
      // 404 = no specs linked (server returns NOT_FOUND when spec_paths is empty)
      patch({ specs: [] });
    }
  }, [patch]);

  // ── Link a spec to the current session ──────────────────────────

  const linkSpec = useCallback(async (specPath: string) => {
    try {
      const sessionId = state.selectedSessionId;
      if (!sessionId) return;
      // Reload specs with new path added to existing list
      const existingPaths = state.specs.map(s => s.path);
      const allPaths = [...existingPaths, specPath];
      await apiClient.reloadSpecs(allPaths);
      // Re-fetch specs
      const specResp = await apiClient.fetchSpec(sessionId);
      const specs = (specResp.specs ?? []).map(mapSpec);
      patch({ specs });
    } catch { /* silent */ }
  }, [state.selectedSessionId, state.specs, patch]);

  // ── Lock/watch ──────────────────────────────────────────────────

  const fetchLockWatchState = useCallback(async () => {
    try {
      const state = await apiClient.getLocks();
      patch({ lockWatchState: state });
    } catch { /* silent — server may not have this endpoint yet */ }
  }, [patch]);

  const toggleLock = useCallback(async (path: string, currentlyLocked: boolean) => {
    try {
      await apiClient.setLock(path, !currentlyLocked);
      await fetchLockWatchState();
    } catch { /* silent */ }
  }, [fetchLockWatchState]);

  const toggleWatch = useCallback(async (path: string, currentlyWatched: boolean) => {
    try {
      await apiClient.setWatch(path, !currentlyWatched);
      await fetchLockWatchState();
    } catch { /* silent */ }
  }, [fetchLockWatchState]);

  // ── Auto-connect on mount + polling ─────────────────────────────

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;

    // Try to connect immediately
    connect();

    // Poll for session discovery every 10 seconds
    pollRef.current = setInterval(() => {
      refreshSessions();
    }, 10000);

    return () => {
      wsClient.disconnect();
      if (pollRef.current) clearInterval(pollRef.current);
      if (diffDebounceRef.current) clearTimeout(diffDebounceRef.current);
      if (activityTimeoutRef.current) clearTimeout(activityTimeoutRef.current);
    };
  }, [connect, refreshSessions]);

  // ── Clear session ───────────────────────────────────────────────

  const resolveIssue = useCallback((id: string, currentlyResolved: boolean) => {
    setState(prev => ({
      ...prev,
      issueThreads: prev.issueThreads.map(t =>
        t.id === id ? { ...t, isResolved: !currentlyResolved } : t
      ),
    }));
  }, []);

  const dismissIssue = useCallback((id: string) => {
    setState(prev => {
      const next = prev.issueThreads.filter(t => t.id !== id);
      return { ...prev, issueThreads: next, activeIssueCount: next.filter(t => !t.isResolved).length };
    });
  }, []);

  const clearSession = useCallback(() => {
    wsClient.disconnect();
    patch({
      selectedSessionId: null,
      graphNodes: [], auditTrail: [], issueThreads: [],
      specs: [], fileChanges: [], activeIssueCount: 0,
      isRunning: false, terminalId: null, terminalSessionId: null, terminalWsUrl: null,
    });
  }, [patch]);
  clearSessionRef.current = clearSession;

  const setWatchTriggeredHandler = useCallback((fn: (path: string, op: string) => void) => {
    onWatchTriggeredRef.current = fn;
  }, []);

  // ── Stop terminal (called when PTY WebSocket closes) ────────────────

  const stopTerminal = useCallback(() => {
    patch({ isRunning: false, terminalId: null, terminalSessionId: null, terminalWsUrl: null });
  }, [patch]);

  // ── Start or resume a terminal session ──────────────────────────────

  const startTerminalSession = useCallback(async (
    mode: 'resume' | 'new',
    sessionId?: string,
  ) => {
    // Use ref so we never get a stale closure — state.project can lag behind connect()
    const workingDir = projectPathRef.current || state.project?.path || '';
    if (!workingDir) {
      patch({ error: 'Cannot start terminal: project directory unknown. Connect to a watchdog server first.' });
      return;
    }
    try {
      const result = await apiClient.startTerminal({
        session_id: sessionId,
        working_dir: workingDir,
        mode,
      });
      const wsUrl = apiClient.terminalWsUrl(result.terminal_id);
      patch({ isRunning: true, terminalId: result.terminal_id, terminalSessionId: sessionId ?? null, terminalWsUrl: wsUrl, error: null });
      if (mode === 'new') {
        refreshSessions();
        setTimeout(() => refreshSessions(), 3000);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      patch({ error: `Terminal failed to start: ${msg}` });
    }
  }, [state.project, patch, refreshSessions]);

  return {
    ...state,
    connect,
    selectSession,
    clearSession,
    refreshSessions,
    updateConfig,
    toggleEnforcement,
    renameSession,
    linkSpec,
    refreshSpecs,
    toggleLock,
    toggleWatch,
    fetchLockWatchState,
    setWatchTriggeredHandler,
    resolveIssue,
    dismissIssue,
    startTerminalSession,
    stopTerminal,
  };
}
