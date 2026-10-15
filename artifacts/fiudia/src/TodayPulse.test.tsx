import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Me, PulseMessage } from '@workspace/api-client-react';
import { afterEach, expect, test, vi } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { PulsePage } from './TodayPulse';

const clients: QueryClient[] = [];

afterEach(() => {
  cleanup();
  clients.splice(0).forEach(client => client.clear());
  vi.unstubAllGlobals();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => { resolve = finish; });
  return { promise, resolve };
}

function notices(): PulseMessage[] {
  // Both All and Unread have an older page, but different cursor boundaries.
  return Array.from({ length: 38 }, (_, index) => {
    const id = 100 - index;
    const isRead = [100, 90, 80].includes(id);
    return {
      id, title: `Hinweis ${id}`, body: `Nachrichtentext ${id}`,
      priority: 'info', audience: 'all', revision: 1,
      studioId: null, studioName: null, roomClosureId: null,
      authorName: 'Studio-Team', createdAt: '2026-01-01T09:00:00Z',
      editedAt: null, isRead, readCount: isRead ? 1 : 0, canManage: false,
    };
  });
}

type RequestLog = { method: string; path: string; params: Record<string, string> };

function servePulse(
  rows: PulseMessage[],
  hold?: (request: RequestLog) => Promise<void> | undefined,
  history: Array<{
    id: number;
    action: 'correction' | 'retraction';
    editorStaffId: number;
    editorName: string;
    editedAt: string;
    previous: { title: string; body: string; priority: 'info' | 'important' | 'urgent' };
    changes: Array<{ field: 'title' | 'body' | 'priority'; before: string; after: string }>;
  }> = [],
) {
  const requests: RequestLog[] = [];
  // Mock only HTTP: the component, router, generated API hooks and query cache are real.
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const request = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      params: Object.fromEntries(url.searchParams),
    };
    requests.push(request);
    await hold?.(request);
    if (request.method === 'GET' && request.path === '/api/pulse') {
      const beforeId = Number(url.searchParams.get('beforeId'));
      const page = rows
        .filter(row => !beforeId || row.id < beforeId)
        .filter(row => url.searchParams.get('unreadOnly') !== 'true' || !row.isRead)
        .slice(0, 30);
      return Response.json(page);
    }
    if (request.method === 'GET' && /^\/api\/pulse\/\d+\/history$/.test(request.path)) {
      return Response.json(history);
    }
    const match = request.path.match(/^\/api\/pulse\/(\d+)\/read$/);
    if (request.method === 'POST' && match) {
      const row = rows.find(row => row.id === Number(match[1]));
      if (!row) throw new Error(`Unknown notice: ${match[1]}`);
      row.isRead = true;
      row.readCount += 1;
      return Response.json({ messageId: row.id, readAt: '2026-01-02T09:00:00Z' });
    }
    throw new Error(`Unexpected request: ${request.method} ${url}`);
  }));
  return requests;
}

function renderPulse(role: Me['role'] = 'studio_employee') {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
  clients.push(client);
  const location = memoryLocation({ path: '/pulse' });
  const me: Me = {
    userId: 'staff-1', email: 'staff@example.test', userName: 'Test Team', isOnboarded: true,
    role, studioId: 1, organizationId: 1,
  };
  render(
    <QueryClientProvider client={client}>
      <Router hook={location.hook} searchHook={location.searchHook}>
        <PulsePage me={me} />
      </Router>
    </QueryClientProvider>,
  );
  return { client, user: userEvent.setup() };
}

function visibleIds() {
  return screen.queryAllByRole('article').map(card =>
    Number(card.getAttribute('data-testid')?.replace('pulse-message-', '')));
}

function allDisplayOrder(rows: PulseMessage[]) {
  return [...rows].sort((a, b) => Number(a.isRead) - Number(b.isRead) || b.id - a.id)
    .map(row => row.id);
}

test('ordinary readers see corrected content without history or withdrawn archive controls', async () => {
  const rows = notices().slice(0, 1);
  rows[0].editedAt = '2026-01-02T10:00:00Z';
  const requests = servePulse(rows);
  renderPulse();
  await screen.findByText(rows[0].title);
  expect(screen.queryByText('Korrekturverlauf ansehen')).toBeNull();
  expect(screen.queryByText('Zurückgezogene Meldungen prüfen')).toBeNull();
  expect(requests.some(request => request.path.endsWith('/history'))).toBe(false);
});

test('managers can review correction differences and the previous version of withdrawn messages', async () => {
  const rows = notices().slice(0, 1);
  rows[0].editedAt = '2026-01-02T10:00:00Z';
  const requested: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    requested.push(url.toString());
    if (url.pathname.endsWith('/history')) {
      const retraction = url.pathname.includes('/99/');
      return Response.json([{
        id: 1, action: retraction ? 'retraction' : 'correction',
        editorStaffId: 7, editorName: 'Bezirksleitung Test', editedAt: '2026-01-02T10:00:00Z',
        previous: { title: 'Alter Titel', body: 'Ursprünglicher Text', priority: 'info' },
        changes: retraction ? [] : [{ field: 'title', before: 'Alter Titel', after: rows[0].title }],
      }]);
    }
    return Response.json(url.searchParams.get('retractedOnly') === 'true'
      ? [{ ...rows[0], id: 99, title: 'Zurückgezogener Hinweis', retractedAt: '2026-01-02T10:00:00Z' }]
      : rows);
  }));
  const { user } = renderPulse('studio_manager');
  await user.click(await screen.findByText('Korrekturverlauf ansehen'));
  expect(await screen.findByText(/Korrigiert von Bezirksleitung Test/)).toBeTruthy();
  expect(screen.getByText('Vorher')).toBeTruthy();
  expect(screen.getByText('Nachher')).toBeTruthy();
  await user.click(screen.getByText('Zurückgezogene Meldungen prüfen'));
  expect(await screen.findByText('Zurückgezogener Hinweis')).toBeTruthy();
  await user.click(screen.getByText('Änderungsverlauf ansehen'));
  expect(await screen.findByText(/Zurückgezogen von Bezirksleitung Test/)).toBeTruthy();
  const previous = screen.getAllByText('Vollständige vorherige Fassung').at(-1)!;
  await user.click(previous);
  expect(within(previous.parentElement!).getByText('Ursprünglicher Text')).toBeTruthy();
  expect(requested.some(url => url.includes('retractedOnly=true'))).toBe(true);
});

test('loads older pages per filter and refreshes an older read receipt across All and Unread', async () => {
  const rows = notices();
  const olderPage = deferred<void>();
  const requests = servePulse(rows, request =>
    request.params.beforeId === '71' ? olderPage.promise : undefined);
  const { client, user } = renderPulse();

  await screen.findByText('30 Nachrichten angezeigt · weitere laden');
  expect(visibleIds()).toEqual(allDisplayOrder(rows.slice(0, 30)));
  expect(screen.queryByRole('heading', { name: 'Hinweis 63' })).toBeNull();

  await user.click(screen.getByRole('button', { name: 'Ältere Nachrichten laden' }));
  const loading = await screen.findByRole('button', { name: 'Wird geladen …' });
  expect((loading as HTMLButtonElement).disabled).toBe(true);
  expect(visibleIds()).toHaveLength(30);
  olderPage.resolve();
  await screen.findByText('38 Nachrichten angezeigt');
  expect(visibleIds()).toEqual(allDisplayOrder(rows));
  expect(new Set(visibleIds()).size).toBe(38);
  expect(screen.queryByRole('button', { name: 'Ältere Nachrichten laden' })).toBeNull();
  expect(requests.slice(0, 2).map(request => request.params)).toEqual([{}, { beforeId: '71' }]);

  await user.click(screen.getByRole('button', { name: 'Ungelesen' }));
  await screen.findByText('30 Nachrichten angezeigt · weitere laden');
  expect(screen.getByRole('button', { name: 'Ungelesen' }).className).toBe('active');
  expect(visibleIds()).toEqual(rows.filter(row => !row.isRead).slice(0, 30).map(row => row.id));
  expect(requests.at(-1)?.params).toEqual({ unreadOnly: 'true' });
  expect(screen.queryByRole('heading', { name: 'Hinweis 63' })).toBeNull();

  await user.click(screen.getByRole('button', { name: 'Ältere Nachrichten laden' }));
  await screen.findByText('35 Nachrichten angezeigt');
  expect(requests.at(-1)?.params).toEqual({ unreadOnly: 'true', beforeId: '68' });
  expect(visibleIds()).toEqual(rows.filter(row => !row.isRead).map(row => row.id));
  expect(screen.queryByRole('button', { name: 'Ältere Nachrichten laden' })).toBeNull();
  const olderUnread = screen.getByTestId('pulse-message-63');
  expect(olderUnread.classList.contains('unread')).toBe(true);
  await user.click(within(olderUnread).getByRole('button', { name: 'Als gelesen markieren' }));

  await screen.findByText('34 Nachrichten angezeigt');
  expect(screen.queryByTestId('pulse-message-63')).toBeNull();
  expect(visibleIds()).toEqual(rows.filter(row => !row.isRead).map(row => row.id));
  expect(requests.filter(request => request.method === 'POST')).toEqual([
    { method: 'POST', path: '/api/pulse/63/read', params: {} },
  ]);

  await user.click(screen.getByRole('button', { name: 'Alle' }));
  await screen.findByText('38 Nachrichten angezeigt');
  await waitFor(() => expect(within(screen.getByTestId('pulse-message-63')).queryByText('Gelesen')).not.toBeNull());
  expect(screen.getByTestId('pulse-message-63').classList.contains('unread')).toBe(false);
  expect(within(screen.getByTestId('pulse-message-63')).queryByRole('button', { name: 'Als gelesen markieren' })).toBeNull();
  expect(within(screen.getByTestId('pulse-message-63')).getByText(/1 Lesebestätigung/)).toBeTruthy();
  expect(visibleIds()).toEqual(allDisplayOrder(rows));
  await waitFor(() => expect(client.isFetching()).toBe(0));

  await user.click(screen.getByRole('button', { name: 'Ungelesen' }));
  await screen.findByText('34 Nachrichten angezeigt');
  expect(screen.queryByTestId('pulse-message-63')).toBeNull();
  expect(visibleIds()).toEqual(rows.filter(row => !row.isRead).map(row => row.id));
});

test('switching filters during an older-page request cannot leak old pages into Unread', async () => {
  const rows = notices();
  // A read-only older notice makes any cross-filter page leak visible.
  rows.find(row => row.id === 63)!.isRead = true;
  const olderAll = deferred<void>();
  const requests = servePulse(rows, request =>
    request.params.beforeId && !request.params.unreadOnly ? olderAll.promise : undefined);
  const { client, user } = renderPulse();
  await screen.findByText('30 Nachrichten angezeigt · weitere laden');
  await user.click(screen.getByRole('button', { name: 'Ältere Nachrichten laden' }));
  await screen.findByRole('button', { name: 'Wird geladen …' });
  await user.click(screen.getByRole('button', { name: 'Ungelesen' }));
  await screen.findByText('30 Nachrichten angezeigt · weitere laden');
  const unreadFirstPage = rows.filter(row => !row.isRead).slice(0, 30).map(row => row.id);
  expect(visibleIds()).toEqual(unreadFirstPage);

  await act(async () => { olderAll.resolve(); });
  await waitFor(() => expect(client.isFetching()).toBe(0));
  expect(visibleIds()).toEqual(unreadFirstPage);
  expect(screen.queryByTestId('pulse-message-63')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Ältere Nachrichten laden' }));
  await screen.findByText('34 Nachrichten angezeigt');
  expect(requests.at(-1)?.params).toEqual({ unreadOnly: 'true', beforeId: '68' });
  expect(visibleIds()).toEqual(rows.filter(row => !row.isRead).map(row => row.id));
  expect(new Set(visibleIds()).size).toBe(34);
  expect(screen.queryByTestId('pulse-message-63')).toBeNull();

  await user.click(screen.getByRole('button', { name: 'Alle' }));
  // Leaving All cancelled its older request; returning must resume from All's cursor.
  await user.click(await screen.findByRole('button', { name: 'Ältere Nachrichten laden' }));
  await screen.findByText('38 Nachrichten angezeigt');
  expect(visibleIds()).toEqual(allDisplayOrder(rows));
  expect(within(screen.getByTestId('pulse-message-63')).getByText('Gelesen')).toBeTruthy();
});

test('shows who corrected a Pulse message and the before-and-after values', async () => {
  const rows = notices();
  rows[0].editedAt = '2026-01-02T10:00:00Z';
  servePulse(rows, undefined, [{
    id: 1,
    action: 'correction',
    editorStaffId: 2,
    editorName: 'Lea Leitung',
    editedAt: '2026-01-02T10:00:00Z',
    previous: { title: 'Hinweis 100', body: 'Alter Text', priority: 'important' },
    changes: [
      { field: 'title', before: 'Hinweis 100', after: 'Aktualisierter Hinweis' },
      { field: 'body', before: 'Alter Text', after: 'Neuer Text' },
      { field: 'priority', before: 'important', after: 'urgent' },
    ],
  }]);
  const { user } = renderPulse('studio_manager');

  await screen.findByText('30 Nachrichten angezeigt · weitere laden');
  await user.click(within(screen.getByTestId('pulse-message-100'))
    .getByRole('button', { name: 'Korrekturverlauf ansehen' }));

  const history = await screen.findByTestId('pulse-history-100');
  expect(within(history).getByText(/Lea Leitung/)).toBeTruthy();
  expect(within(history).getByText('Titel')).toBeTruthy();
  expect(within(history).getAllByText('Hinweis 100')).toHaveLength(2);
  expect(within(history).getByText('Aktualisierter Hinweis')).toBeTruthy();
  expect(within(history).getAllByText('Alter Text')).toHaveLength(2);
  expect(within(history).getByText('Neuer Text')).toBeTruthy();
  expect(within(history).getByText('Wichtig')).toBeTruthy();
  expect(within(history).getByText('Dringend')).toBeTruthy();
});

test('does not invent details for older corrections without saved history', async () => {
  const rows = notices();
  rows[0].editedAt = '2026-01-02T10:00:00Z';
  servePulse(rows);
  const { user } = renderPulse('studio_manager');

  await screen.findByText('30 Nachrichten angezeigt · weitere laden');
  await user.click(within(screen.getByTestId('pulse-message-100'))
    .getByRole('button', { name: 'Korrekturverlauf ansehen' }));

  const history = await screen.findByTestId('pulse-history-100');
  expect(within(history).getByText('Für frühere Änderungen liegen keine Details vor.')).toBeTruthy();
  expect(within(history).queryByText(/Lea Leitung/)).toBeNull();
  expect(within(history).queryByText('Alter Titel')).toBeNull();
});
