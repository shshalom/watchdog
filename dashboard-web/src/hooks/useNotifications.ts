import { useCallback } from 'react';
import type { ToastType } from '../components/Toast';

export type NotificationStyle = 'internal' | 'system';

const PREF_KEY = 'watchdog_notification_style';

export function getNotificationStyle(): NotificationStyle {
  return (localStorage.getItem(PREF_KEY) as NotificationStyle) ?? 'internal';
}

export function setNotificationStyle(style: NotificationStyle) {
  localStorage.setItem(PREF_KEY, style);
}

export function getSystemPermission(): NotificationPermission {
  return typeof Notification !== 'undefined' ? Notification.permission : 'denied';
}

export async function requestSystemPermission(): Promise<NotificationPermission> {
  if (typeof Notification === 'undefined') return 'denied';
  return Notification.requestPermission();
}

// ── Hook ────────────────────────────────────────────────────────────

interface NotifyOptions {
  title: string;
  body?: string;
  type?: ToastType;
}

export function useNotifications(
  toastShow: (text: string, type?: ToastType) => void,
) {
  const notify = useCallback((opts: NotifyOptions) => {
    const style = getNotificationStyle();
    const text = opts.body ? `${opts.title}: ${opts.body}` : opts.title;

    if (style === 'system' && getSystemPermission() === 'granted') {
      new Notification(opts.title, {
        body: opts.body,
        icon: '/favicon.svg',
      });
    } else {
      toastShow(text, opts.type ?? 'warning');
    }
  }, [toastShow]);

  return { notify };
}
