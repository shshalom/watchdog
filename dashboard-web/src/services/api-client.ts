import type {
  SessionSummary, SessionDetail, FilesResponse, FileDiff,
  AuditTrailEntry, APIIssueThread, SpecContent, WatchdogConfig,
  ProjectInfo, DiscoveredSession, FsEntry, LockWatchState,
} from '../models/types';

class APIClient {
  private baseURL: string;
  private port: number;

  constructor(port = 9100) {
    // Use relative URLs — Vite proxy handles /api in dev, same-origin in production
    this.baseURL = '/api';
    this.port = port;
  }

  updatePort(port: number) {
    this.port = port;
    // In dev, Vite proxy handles it. In production (served from Rust), same origin.
    this.baseURL = '/api';
  }

  currentPort(): number {
    return this.port;
  }

  // Sessions
  async fetchSessions(): Promise<SessionSummary[]> {
    const res = await this.get<{ sessions: SessionSummary[] }>('/sessions');
    return res.sessions;
  }

  async fetchSessionDetail(id: string): Promise<SessionDetail> {
    return this.get<SessionDetail>(`/sessions/${id}`);
  }

  // Files
  async fetchFiles(sessionId: string): Promise<FilesResponse> {
    return this.get<FilesResponse>(`/sessions/${sessionId}/files`);
  }

  async fetchFileDiff(sessionId: string, filePath: string): Promise<FileDiff> {
    const encoded = encodeURIComponent(filePath).replace(/%2F/g, '/');
    return this.get<FileDiff>(`/sessions/${sessionId}/diff/${encoded}`);
  }

  // Audit Trail
  async fetchAuditTrail(sessionId: string): Promise<{ entries: AuditTrailEntry[] }> {
    return this.get<{ entries: AuditTrailEntry[] }>(`/sessions/${sessionId}/audit-trail`);
  }

  async dismissAuditEntries(timestamps: string[]): Promise<void> {
    await this.post('/audit-trail/dismiss', { timestamps });
  }

  // Issues
  async fetchIssues(sessionId: string): Promise<APIIssueThread[]> {
    const res = await this.get<{ issues: APIIssueThread[] }>(`/sessions/${sessionId}/issues`);
    return res.issues;
  }

  async resolveIssue(sessionId: string, issueId: string): Promise<void> {
    await this.post(`/sessions/${sessionId}/issues/${issueId}/resolve`, {});
  }

  // Observation
  async registerSession(sessionId: string): Promise<void> {
    await this.post('/observe/register', { session_id: sessionId });
  }

  async unregisterSession(sessionId: string): Promise<void> {
    await this.post('/observe/unregister', { session_id: sessionId });
  }

  // Spec
  async fetchSpec(sessionId: string): Promise<SpecContent> {
    return this.get<SpecContent>(`/sessions/${sessionId}/spec`);
  }

  // Config
  async fetchConfig(): Promise<WatchdogConfig> {
    return this.get<WatchdogConfig>('/config');
  }

  async updateConfig(values: Record<string, unknown>): Promise<void> {
    await this.post('/config/update', values);
  }

  async reloadSpecs(specPaths: string[]): Promise<void> {
    await this.post('/reload-specs', { spec_paths: specPaths });
  }

  // File Lock/Watch
  async lockFiles(sessionId: string, paths: string[], locked: boolean): Promise<void> {
    await this.post(`/sessions/${sessionId}/files/lock`, { paths, locked });
  }

  async watchFiles(sessionId: string, paths: string[], watched: boolean): Promise<void> {
    await this.post(`/sessions/${sessionId}/files/watch`, { paths, watched });
  }

  // Per-session config
  async updateSessionConfig(sessionId: string, values: Record<string, unknown>): Promise<void> {
    await this.post(`/sessions/${sessionId}/config`, values);
  }

  // Session label
  async setSessionLabel(sessionId: string, label: string): Promise<void> {
    await this.post(`/project/sessions/${sessionId}/label`, { label });
  }

  // Project & session discovery
  async fetchProject(): Promise<ProjectInfo> {
    return this.get<ProjectInfo>('/project');
  }

  async discoverSessions(): Promise<DiscoveredSession[]> {
    const res = await this.get<{ sessions: DiscoveredSession[] }>('/project/sessions');
    return res.sessions;
  }

  // Filesystem browse + lock/watch
  async browseFsDir(path: string): Promise<FsEntry[]> {
    const url = path ? `/fs/browse?path=${encodeURIComponent(path)}` : '/fs/browse';
    return this.get<FsEntry[]>(url);
  }

  async getLocks(): Promise<LockWatchState> {
    return this.get<LockWatchState>('/fs/locks');
  }

  async setLock(path: string, locked: boolean): Promise<void> {
    await this.post('/fs/lock', { path, locked });
  }

  async setWatch(path: string, watched: boolean): Promise<void> {
    await this.post('/fs/watch', { path, watched });
  }

  /** Opens a native macOS file/folder picker. Returns path or null if cancelled. */
  async pickFile(kind: 'file' | 'folder' | 'any' = 'any', prompt?: string): Promise<string | null> {
    const params = new URLSearchParams({ kind });
    if (prompt) params.set('prompt', prompt);
    // No timeout — blocks until user interacts with the native dialog.
    const res = await fetch(`${this.baseURL}/fs/pick?${params}`);
    if (!res.ok) return null;
    const json = await res.json() as { path?: string; cancelled?: boolean; error?: string };
    return json.path ?? null;
  }

  /** Opens a multi-select file picker. Returns selected paths (empty if cancelled). */
  async pickFiles(prompt?: string): Promise<string[]> {
    const params = new URLSearchParams({ multiple: 'true' });
    if (prompt) params.set('prompt', prompt);
    // No timeout — blocks until user interacts with the native dialog.
    const res = await fetch(`${this.baseURL}/fs/pick?${params}`);
    if (!res.ok) return [];
    const json = await res.json() as { paths?: string[]; cancelled?: boolean; error?: string };
    return json.paths ?? [];
  }

  async revealInFinder(path: string): Promise<void> {
    await this.post('/fs/reveal', { path });
  }

  async searchFs(query: string, path?: string): Promise<FsEntry[]> {
    const params = new URLSearchParams({ q: query });
    if (path) params.set('path', path);
    return this.get<FsEntry[]>(`/fs/search?${params}`);
  }

  // Health check — returns true if server is reachable
  async ping(): Promise<boolean> {
    try {
      await this.get<unknown>('/config');
      return true;
    } catch {
      return false;
    }
  }

  // Handoff lifecycle
  async fetchHandoff(): Promise<{ handoff_state: string; path: string | null } | null> {
    try {
      const val = await this.get<unknown>('/handoff');
      if (!val) return null;
      const h = val as Record<string, unknown>;
      const state = h.used_by_session_id ? 'used'
        : h.is_outdated ? 'outdated'
        : h.path ? 'created'
        : 'none';
      return { handoff_state: state, path: (h.path as string) ?? null };
    } catch { return null; }
  }

  async markHandoffUsed(sessionId: string): Promise<void> {
    await this.post('/handoff/mark-used', { session_id: sessionId });
  }

  // Terminal
  async startTerminal(body: { session_id?: string; working_dir: string; mode: string }): Promise<{ terminal_id: string }> {
    return this.postJSON<{ terminal_id: string }>('/terminal/start', body);
  }

  terminalWsUrl(terminalId: string): string {
    return `ws://127.0.0.1:${this.port}/api/terminal/ws/${terminalId}`;
  }

  // Private helpers
  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseURL}${path}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new APIError(res.status);
    return res.json();
  }

  private async post(path: string, body: unknown): Promise<void> {
    const res = await fetch(`${this.baseURL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new APIError(res.status);
  }

  private async postJSON<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseURL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new APIError(res.status);
    return res.json();
  }
}

class APIError extends Error {
  statusCode: number;
  constructor(statusCode: number) {
    super(`HTTP error: ${statusCode}`);
    this.name = 'APIError';
    this.statusCode = statusCode;
  }
}

export const apiClient = new APIClient();
export { APIClient, APIError };
