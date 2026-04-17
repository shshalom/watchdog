import { useRef, useEffect, useState, useCallback, forwardRef, useImperativeHandle } from 'react';
import { createPortal } from 'react-dom';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import {
  Terminal,
  Maximize2,
  Minimize2,
  X,
  Play,
  RotateCcw,
  Plus,
  DollarSign,
  XCircle,
  ArrowRightFromLine,
} from 'lucide-react';
import { type AgentState, AGENT_STATE_META } from '../../models/types';

// ---------------------------------------------------------------------------
// Imperative handle (lets App.tsx send text to the running terminal)
// ---------------------------------------------------------------------------

export interface TerminalPanelHandle {
  sendInput: (text: string) => void;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface TerminalPanelProps {
  isExpanded: boolean;
  onToggle: () => void;
  agentState: AgentState;
  isRunning?: boolean;
  hasSessionsInProject?: boolean;
  hasProjectSelected?: boolean;
  shouldShowHandoff?: boolean;
  terminalId?: string | null;
  terminalWsUrl?: string | null;
  /** Left offset in px — set to explorer width when the explorer is open */
  leftOffset?: number;
  /** Called at drag-start to get the current max panel height */
  onGetMaxHeight?: () => number;
  onResume?: () => void;
  onNewSession?: () => void;
  onPerformHandoff?: () => void;
  /** Dynamic handoff button — label, color and disabled driven by handoff lifecycle state */
  handoffAction?: { label: string; disabled: boolean; color: string; bgColor: string };
  /** Called when the PTY WebSocket closes — used as a fallback to reset isRunning */
  onTerminalClosed?: () => void;
}

// ---------------------------------------------------------------------------
// Prompt-bar actions
// ---------------------------------------------------------------------------

interface ActionButton {
  label: string;
  icon: React.ComponentType<{ size?: number }>;
  color: string;
  bgColor: string;
  id: string;
  /** Literal text sent to the PTY (with trailing \r). null = custom handler. */
  prompt: string | null;
}

const ACTIONS: ActionButton[] = [
  {
    label: 'Run Tests', icon: Play,
    color: 'text-green-400', bgColor: 'bg-green-400/10',
    id: 'run-tests', prompt: 'run the test suite and fix any failures\r',
  },
  {
    label: 'Fix Drift', icon: RotateCcw,
    color: 'text-orange-400', bgColor: 'bg-orange-400/10',
    id: 'fix-drift', prompt: 'fix the drift issues identified by the watchdog auditor\r',
  },
  {
    label: 'Show Cost', icon: DollarSign,
    color: 'text-zinc-400', bgColor: 'bg-zinc-400/10',
    id: 'show-cost', prompt: '/cost\r',
  },
  {
    label: 'Exit', icon: XCircle,
    color: 'text-red-400', bgColor: 'bg-red-400/10',
    id: 'exit', prompt: '/exit\r',
  },
];

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_PANEL_HEIGHT = 280;
const MIN_PANEL_HEIGHT = 150;
const MAX_PANEL_HEIGHT = 600;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const TerminalPanel = forwardRef<TerminalPanelHandle, TerminalPanelProps>(function TerminalPanel({
  isExpanded,
  onToggle,
  agentState,
  isRunning = false,
  hasSessionsInProject = false,
  hasProjectSelected = false,
  shouldShowHandoff = false,
  terminalId,
  terminalWsUrl,
  leftOffset = 0,
  onGetMaxHeight,
  onResume,
  onNewSession,
  onPerformHandoff,
  handoffAction,
  onTerminalClosed,
}: TerminalPanelProps, ref: React.Ref<TerminalPanelHandle>) {
  const termRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const ptyWsRef = useRef<WebSocket | null>(null);
  // Set true when we manually handle Shift+Enter so onData can suppress the \r xterm also fires
  const suppressNextEnterRef = useRef(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  // Track first-expand so we init xterm exactly once
  const xtermInitRef = useRef(false);

  const [panelHeight, setPanelHeight] = useState(DEFAULT_PANEL_HEIGHT);
  const [isMaximized, setIsMaximized] = useState(false);

  const isDragging = useRef(false);
  const dragStartY = useRef(0);
  const dragStartHeight = useRef(0);
  const dragMaxHeight = useRef(MAX_PANEL_HEIGHT);

  // -------------------------------------------------------------------------
  // xterm: init once on first expand, keep alive forever after that
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!isExpanded || xtermInitRef.current || !termRef.current) return;
    xtermInitRef.current = true;

    const term = new XTerm({
      theme: {
        background: 'rgb(13, 13, 20)',
        foreground: '#e4e4e7',
        cursor: '#e4e4e7',
        selectionBackground: 'rgba(255, 255, 255, 0.15)',
      },
      fontFamily: "'SF Mono', Menlo, monospace",
      fontSize: 13,
      cursorBlink: true,
      disableStdin: false,
      convertEol: true,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.open(termRef.current);

    requestAnimationFrame(() => {
      try { fitAddon.fit(); } catch { /* noop */ }
    });

    // Keystrokes → PTY WebSocket (binary frame)
    // Suppress \r when our Shift+Enter handler already sent \x1b[13;2u
    term.onData((data) => {
      if (data === '\r' && suppressNextEnterRef.current) {
        suppressNextEnterRef.current = false;
        return;
      }
      const ws = ptyWsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(new TextEncoder().encode(data));
      }
    });

    // Resize → PTY WebSocket (JSON control frame)
    term.onResize(({ cols, rows }) => {
      const ws = ptyWsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    });

    // ── Custom key handler ─────────────────────────────────────────
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.type !== 'keydown') return true;

      const send = (bytes: string) => {
        const ws = ptyWsRef.current;
        if (ws?.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(bytes));
      };

      // Shift+Enter → kitty/modifyOtherKeys-2 sequence Claude CLI expects
      // Claude sends \x1b[>1u (kitty) + \x1b[>4;2m on startup; both use CSI codepoint;modifier u
      // xterm.js 6 ignores those requests so we send the sequence manually.
      // suppressNextEnterRef blocks the \r that xterm fires via a secondary event path.
      if (e.key === 'Enter' && e.shiftKey) {
        suppressNextEnterRef.current = true;
        send('\x1b[13;2u');
        return false;
      }

      // Cmd+C → copy selection if any; otherwise pass ^C interrupt to PTY
      if (e.metaKey && e.key === 'c') {
        const sel = term.getSelection();
        if (sel) { navigator.clipboard.writeText(sel).catch(() => {}); return false; }
        return true; // no selection → let xterm send ^C
      }

      // Cmd+V → paste from clipboard (with bracketed paste markers)
      if (e.metaKey && e.key === 'v') {
        navigator.clipboard.readText().then(text => {
          if (text) send(`\x1b[200~${text}\x1b[201~`);
        }).catch(() => {});
        return false;
      }

      // Cmd+K → clear screen
      if (e.metaKey && e.key === 'k') {
        term.clear();
        return false;
      }

      // Alt+Left → backward word (readline \eb)
      if (e.altKey && e.key === 'ArrowLeft') {
        send('\x1bb');
        return false;
      }

      // Alt+Right → forward word (readline \ef)
      if (e.altKey && e.key === 'ArrowRight') {
        send('\x1bf');
        return false;
      }

      // Cmd+Left → beginning of line (readline ^A)
      if (e.metaKey && e.key === 'ArrowLeft') {
        send('\x01');
        return false;
      }

      // Cmd+Right → end of line (readline ^E)
      if (e.metaKey && e.key === 'ArrowRight') {
        send('\x05');
        return false;
      }

      // Cmd+Delete → delete entire line (^A to start, ^K to kill to end)
      if (e.metaKey && e.key === 'Backspace') {
        send('\x01\x0b');
        return false;
      }

      return true;
    });

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // ResizeObserver keeps xterm fitted as the container changes size
    const ro = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        try { fitAddonRef.current?.fit(); } catch { /* noop */ }
      });
    });
    ro.observe(termRef.current);

    // No cleanup — we intentionally keep the xterm instance alive for the
    // lifetime of the component so terminal history survives panel collapses.
    return () => { ro.disconnect(); };
  }, [isExpanded]);

  // Re-fit when panel becomes visible again after being hidden
  useEffect(() => {
    if (!isExpanded || !fitAddonRef.current) return;
    requestAnimationFrame(() => {
      try { fitAddonRef.current?.fit(); } catch { /* noop */ }
    });
  }, [isExpanded, panelHeight, isMaximized]);

  // -------------------------------------------------------------------------
  // PTY WebSocket: connect when terminalId is set, disconnect when cleared
  // -------------------------------------------------------------------------

  useEffect(() => {
    // Disconnect any existing WS
    if (ptyWsRef.current) {
      ptyWsRef.current.close();
      ptyWsRef.current = null;
    }

    if (!terminalId || !terminalWsUrl) return;

    // Clear previous session output before streaming new PTY
    xtermRef.current?.clear();

    // Use the URL locked at terminal-start time — avoids stale-port issues when
    // the user has switched the dashboard between different watchdog servers.
    const ws = new WebSocket(terminalWsUrl);
    ws.binaryType = 'arraybuffer';

    let opened = false;

    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        xtermRef.current?.write(new Uint8Array(e.data));
      }
    };

    ws.onopen = () => {
      opened = true;
      const term = xtermRef.current;
      if (term) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    };

    // Only notify onTerminalClosed if the WS actually opened — a connection failure
    // (wrong port, server down) must NOT trigger a restart loop.
    ws.onclose = () => {
      if (ptyWsRef.current === ws && opened) {
        onTerminalClosed?.();
      }
    };

    ptyWsRef.current = ws;

    return () => {
      ptyWsRef.current = null;
      ws.close();
    };
  }, [terminalId, terminalWsUrl]);

  // -------------------------------------------------------------------------
  // Send text to the PTY (prompt-bar helper)
  // -------------------------------------------------------------------------

  const sendToTerminal = useCallback((text: string) => {
    const ws = ptyWsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(new TextEncoder().encode(text));
    }
  }, []);

  // Expose sendInput so App.tsx can trigger prompt-bar actions (e.g. handoff)
  useImperativeHandle(ref, () => ({
    sendInput: (text: string) => sendToTerminal(text),
  }), [sendToTerminal]);

  // -------------------------------------------------------------------------
  // Drag resize
  // -------------------------------------------------------------------------

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    isDragging.current = true;
    dragStartY.current = e.clientY;
    dragStartHeight.current = panelHeight;
    dragMaxHeight.current = onGetMaxHeight ? onGetMaxHeight() : MAX_PANEL_HEIGHT;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [panelHeight, onGetMaxHeight]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDragging.current) return;
    const delta = dragStartY.current - e.clientY;
    const next = Math.max(MIN_PANEL_HEIGHT, Math.min(dragMaxHeight.current, dragStartHeight.current + delta));
    setPanelHeight(next);
    if (isMaximized) setIsMaximized(false);
  }, [isMaximized]);

  const onPointerUp = useCallback(() => {
    isDragging.current = false;
  }, []);

  const toggleMaximize = useCallback(() => setIsMaximized(v => !v), []);

  // -------------------------------------------------------------------------
  // Agent state indicator
  // -------------------------------------------------------------------------

  const stateMeta = AGENT_STATE_META[agentState];
  const resolvedHeight = isMaximized ? '100vh' : `${panelHeight}px`;

  // -------------------------------------------------------------------------
  // Render — both collapsed button and expanded panel always in the tree.
  // Panel uses display:none when collapsed so xterm stays alive in memory.
  // -------------------------------------------------------------------------

  return (
    <>
      {/* Collapsed button — shown only when panel is closed */}
      {!isExpanded && (
        <button
          onClick={onToggle}
          className="fixed bottom-5 right-5 z-50 glass-panel flex items-center justify-center
                     rounded-xl text-zinc-300 hover:text-white
                     transition-colors duration-150 cursor-pointer"
          style={{ width: 34, height: 34 }}
          aria-label="Open terminal"
        >
          <Terminal size={18} />
        </button>
      )}

      {/* Expanded panel — always in DOM, hidden via display:none when collapsed */}
      <div
        className="fixed bottom-0 z-40 flex-col glass-panel rounded-t-2xl rounded-b-none border-b-0"
        style={{
          display: isExpanded ? 'flex' : 'none',
          height: resolvedHeight,
          left: leftOffset,
          right: 12,
          boxShadow: '0 -8px 32px rgba(0, 0, 0, 0.4)',
        }}
      >
        {/* ---- Resize handle ---- */}
        <div
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          className="flex items-center justify-center h-3 cursor-ns-resize shrink-0 group"
        >
          <div className="w-10 h-1 rounded-full bg-zinc-600 group-hover:bg-zinc-400 transition-colors" />
        </div>

        {/* ---- Header ---- */}
        <div className="flex items-center gap-3 shrink-0 border-b border-white/5 px-3 pt-1.5 pb-1">
          <Terminal size={14} className="text-zinc-400" />
          <span className="text-lg font-semibold text-zinc-200 select-none">Terminal</span>

          <div className="flex items-center gap-1.5 ml-2">
            {isRunning ? (
              <>
                <span className="block rounded-full" style={{ width: 6, height: 6, backgroundColor: stateMeta.color }} />
                <span className="text-xs text-white/40">{stateMeta.label}</span>
              </>
            ) : (
              <>
                <span className="block rounded-full bg-zinc-500" style={{ width: 6, height: 6 }} />
                <span className="text-xs text-white/40">Not running</span>
              </>
            )}
          </div>

          <div className="flex-1" />

          <button
            onClick={toggleMaximize}
            className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-white/5 transition-colors cursor-pointer"
            aria-label={isMaximized ? 'Restore panel' : 'Maximize panel'}
          >
            {isMaximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>

          <button
            onClick={onToggle}
            className="p-1.5 rounded-md text-zinc-500 hover:text-red-400 hover:bg-white/5 transition-colors cursor-pointer"
            aria-label="Close terminal"
          >
            <X size={13} />
          </button>
        </div>

        {/* ---- Content area ---- */}
        <div className="flex-1 min-h-0 relative">
          {/* xterm container — always present so the instance stays alive */}
          <div
            ref={termRef}
            className="absolute inset-0 px-2 py-1 overflow-hidden"
            style={{ backgroundColor: 'rgb(13, 13, 20)' }}
            onContextMenu={(e) => {
              e.preventDefault();
              setContextMenu({ x: e.clientX, y: e.clientY });
            }}
          />

          {/* Empty state overlay — covers xterm when not running */}
          {!isRunning && (
            <div
              className="absolute inset-0 flex items-center justify-center overflow-hidden"
              style={{ backgroundColor: 'rgb(13, 13, 20)' }}
            >
              <div className="flex flex-col items-center gap-4" style={{ padding: 24 }}>
                {/* Glass orb */}
                <div
                  className="flex items-center justify-center rounded-full"
                  style={{
                    width: 56, height: 56,
                    background: 'conic-gradient(from 0deg, rgba(255,255,255,0.15), rgba(255,255,255,0.04), rgba(255,255,255,0.15))',
                    padding: 1,
                  }}
                >
                  <div
                    className="flex items-center justify-center rounded-full backdrop-blur-xl"
                    style={{ width: 54, height: 54, background: 'rgba(255, 255, 255, 0.06)' }}
                  >
                    <Terminal size={22} strokeWidth={1.5} className="text-white/40" />
                  </div>
                </div>

                <span className="font-semibold text-zinc-200">Terminal</span>
                <span className="text-sm text-white/40 text-center leading-relaxed whitespace-pre-line">
                  {'Start a new session or resume\nwhere you left off.'}
                </span>

                <div className="flex items-center gap-2 mt-1">
                  <button
                    onClick={onResume}
                    disabled={!hasSessionsInProject}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/10 text-white
                               transition-colors cursor-pointer disabled:cursor-not-allowed"
                    style={{ opacity: hasSessionsInProject ? 1 : 0.4 }}
                  >
                    <RotateCcw size={11} />
                    <span className="text-xs font-medium">Resume</span>
                  </button>

                  <button
                    onClick={onNewSession}
                    disabled={!hasProjectSelected}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-blue-500/30 text-white
                               transition-colors cursor-pointer disabled:cursor-not-allowed"
                    style={{ opacity: hasProjectSelected ? 1 : 0.4 }}
                  >
                    <Plus size={11} />
                    <span className="text-xs font-medium">New Session</span>
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ---- Prompt action bar ---- */}
        <div
          className="flex items-center gap-2 px-4 shrink-0 border-t border-white/5 overflow-x-auto"
          style={{ minHeight: 44, opacity: isRunning ? 1 : 0.4 }}
        >
          {/* Dynamic handoff button — driven by lifecycle state from parent */}
          {shouldShowHandoff && handoffAction && (
            <button
              disabled={!isRunning || handoffAction.disabled}
              onClick={() => onPerformHandoff?.()}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium
                         ${handoffAction.bgColor} ${handoffAction.color}
                         transition-colors duration-100 whitespace-nowrap shrink-0
                         cursor-pointer disabled:cursor-not-allowed disabled:opacity-50`}
            >
              <ArrowRightFromLine size={12} />
              {handoffAction.label}
            </button>
          )}

          {ACTIONS.map((action) => {
            const Icon = action.icon;
            return (
              <button
                key={action.id}
                disabled={!isRunning}
                onClick={() => {
                  if (action.prompt) sendToTerminal(action.prompt);
                }}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium
                            ${action.bgColor} ${action.color}
                            transition-colors duration-100 whitespace-nowrap shrink-0
                            cursor-pointer disabled:cursor-not-allowed`}
              >
                <Icon size={12} />
                {action.label}
              </button>
            );
          })}
        </div>
      </div>
      {/* Right-click context menu — portaled to escape panel transform */}
      {contextMenu && createPortal(
        <>
          {/* Invisible backdrop to dismiss on outside click */}
          <div
            className="fixed inset-0 z-[100]"
            onClick={() => setContextMenu(null)}
          />
          <div
            className="fixed z-[101] bg-zinc-900/95 backdrop-blur border border-white/10 rounded-lg shadow-2xl py-1 min-w-40"
            style={{ top: contextMenu.y, left: contextMenu.x }}
          >
            {/* Copy */}
            <button
              className="w-full px-3 py-1.5 text-left text-sm text-zinc-200 hover:bg-white/10 flex items-center gap-2 cursor-pointer"
              onClick={() => {
                const sel = xtermRef.current?.getSelection();
                if (sel) navigator.clipboard.writeText(sel).catch(() => {});
                setContextMenu(null);
              }}
            >
              Copy
              <span className="ml-auto text-xs text-zinc-500">⌘C</span>
            </button>

            {/* Paste */}
            <button
              className="w-full px-3 py-1.5 text-left text-sm text-zinc-200 hover:bg-white/10 flex items-center gap-2 cursor-pointer"
              onClick={() => {
                navigator.clipboard.readText()
                  .then(text => { if (text) sendToTerminal(text); })
                  .catch(() => {});
                setContextMenu(null);
              }}
            >
              Paste
              <span className="ml-auto text-xs text-zinc-500">⌘V</span>
            </button>

            <div className="border-t border-white/10 my-1" />

            {/* Clear */}
            <button
              className="w-full px-3 py-1.5 text-left text-sm text-zinc-200 hover:bg-white/10 flex items-center gap-2 cursor-pointer"
              onClick={() => {
                xtermRef.current?.clear();
                setContextMenu(null);
              }}
            >
              Clear
              <span className="ml-auto text-xs text-zinc-500">⌘K</span>
            </button>
          </div>
        </>,
        document.body,
      )}
    </>
  );
});

export default TerminalPanel;
