import { useState, useEffect } from 'react';

interface ConsoleEntry {
  id: number;
  level: 'log' | 'warn' | 'error';
  message: string;
  ts: string;
}

let counter = 0;

export function useConsoleCapture() {
  const [entries, setEntries] = useState<ConsoleEntry[]>([]);

  useEffect(() => {
    const push = (level: ConsoleEntry['level'], args: unknown[]) => {
      const message = args.map(a => {
        if (a instanceof Error) return `${a.message}\n${a.stack ?? ''}`;
        if (typeof a === 'object') { try { return JSON.stringify(a, null, 2); } catch { return String(a); } }
        return String(a);
      }).join(' ');
      setEntries(prev => [...prev.slice(-49), { id: counter++, level, message, ts: new Date().toLocaleTimeString() }]);
    };

    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;

    console.log = (...args) => { origLog(...args); push('log', args); };
    console.warn = (...args) => { origWarn(...args); push('warn', args); };
    console.error = (...args) => { origError(...args); push('error', args); };

    // Capture unhandled promise rejections
    const onUnhandled = (e: PromiseRejectionEvent) => {
      push('error', [`Unhandled Promise Rejection: ${e.reason}`]);
    };
    window.addEventListener('unhandledrejection', onUnhandled);

    return () => {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
      window.removeEventListener('unhandledrejection', onUnhandled);
    };
  }, []);

  return entries;
}

export function DebugOverlay() {
  const [show, setShow] = useState(false);
  const entries = useConsoleCapture();
  const errorCount = entries.filter(e => e.level === 'error').length;

  return (
    <>
      {/* Debug toggle button — bottom-left corner */}
      <button
        onClick={() => setShow(v => !v)}
        className={`fixed bottom-3 left-3 z-[999] px-2.5 py-1 rounded-full text-[10px] font-mono backdrop-blur border cursor-pointer transition-colors ${
          errorCount > 0 ? 'bg-red-500/20 border-red-500/40 text-red-400' : 'bg-white/5 border-white/10 text-white/30 hover:text-white/60'
        }`}
      >
        {errorCount > 0 ? `${errorCount} error${errorCount > 1 ? 's' : ''}` : 'console'}
      </button>

      {show && (
        <div className="fixed bottom-10 left-3 z-[999] w-[480px] max-h-[50vh] glass-panel flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b border-white/5">
            <span className="text-[11px] font-mono text-white/40">Console — {entries.length} messages</span>
            <button onClick={() => setShow(false)} className="text-white/20 hover:text-white/50 cursor-pointer text-xs">✕</button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {entries.length === 0 && (
              <p className="text-[11px] text-white/20 p-3 font-mono">No output</p>
            )}
            {entries.map(e => (
              <div
                key={e.id}
                className={`px-3 py-1 border-b border-white/[0.03] font-mono text-[11px] ${
                  e.level === 'error' ? 'text-red-400 bg-red-500/5' :
                  e.level === 'warn' ? 'text-yellow-400 bg-yellow-500/5' :
                  'text-white/40'
                }`}
              >
                <span className="text-white/20 mr-2">{e.ts}</span>
                <span className="whitespace-pre-wrap break-all">{e.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
