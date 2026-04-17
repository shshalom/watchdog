import { useState, useCallback, useRef } from 'react';

export type ToastType = 'error' | 'warning' | 'info';

export interface ToastMessage {
  id: string;
  text: string;
  type: ToastType;
  persistent: boolean;
}

const TOAST_ICONS: Record<ToastType, string> = {
  error: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z',
  warning: 'M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z',
  info: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z',
};

const TOAST_COLORS: Record<ToastType, string> = {
  error: '#ef4444',
  warning: '#f59e0b',
  info: '#3b82f6',
};

export function useToast() {
  const [messages, setMessages] = useState<ToastMessage[]>([]);
  const counterRef = useRef(0);
  // Dedup: track recently shown message texts → last shown timestamp
  const recentRef = useRef<Map<string, number>>(new Map());
  const DEDUP_MS = 2000;

  const show = useCallback((text: string, type: ToastType = 'error', persistent = false) => {
    // Suppress identical messages within the dedup window
    const now = Date.now();
    const last = recentRef.current.get(text) ?? 0;
    if (now - last < DEDUP_MS) return;
    recentRef.current.set(text, now);

    const id = `toast-${counterRef.current++}`;
    const msg: ToastMessage = { id, text, type, persistent };
    setMessages(prev => [...prev, msg]);

    if (!persistent) {
      const duration = type === 'warning' ? 8000 : 4000;
      setTimeout(() => {
        setMessages(prev => prev.filter(m => m.id !== id));
      }, duration);
    }
  }, []);

  const dismiss = useCallback((id: string) => {
    setMessages(prev => prev.filter(m => m.id !== id));
  }, []);

  return { messages, show, dismiss };
}

export function ToastOverlay({ messages, onDismiss }: {
  messages: ToastMessage[];
  onDismiss: (id: string) => void;
}) {
  if (messages.length === 0) return null;

  return (
    <div className="absolute top-2 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center gap-2 pointer-events-none">
      {messages.map(msg => (
        <div
          key={msg.id}
          className="pointer-events-auto flex items-center gap-2 px-3.5 py-2.5 max-w-[400px] glass rounded-full animate-in slide-in-from-top-2 fade-in duration-300"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill={TOAST_COLORS[msg.type]}>
            <path d={TOAST_ICONS[msg.type]} />
          </svg>
          <span className="text-sm text-white/80 line-clamp-2">{msg.text}</span>
          <div className="flex-1" />
          {msg.persistent && (
            <button
              onClick={() => onDismiss(msg.id)}
              className="text-xs font-medium cursor-pointer"
              style={{ color: TOAST_COLORS[msg.type] }}
            >
              Retry
            </button>
          )}
          <button
            onClick={() => onDismiss(msg.id)}
            className="text-white/20 hover:text-white/40 cursor-pointer"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}
