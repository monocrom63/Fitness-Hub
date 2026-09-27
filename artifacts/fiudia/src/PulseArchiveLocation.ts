import type { PulseArchiveFilter } from './PulseArchiveQuery';

export function readPulseArchiveLocation(search: string): { filter: PulseArchiveFilter; searchTerm: string } {
  const params = new URLSearchParams(search);
  return {
    filter: params.get('filter') === 'unread' ? 'unread' : 'all',
    searchTerm: (params.get('search') ?? '').trim().slice(0, 120),
  };
}

export function pulseArchiveHref(
  search: string,
  change: { filter?: PulseArchiveFilter; searchTerm?: string },
): string {
  const params = new URLSearchParams(search);
  if (change.filter) {
    if (change.filter === 'unread') params.set('filter', 'unread');
    else params.delete('filter');
  }
  if (change.searchTerm !== undefined) {
    const term = change.searchTerm.trim().slice(0, 120);
    if (term) params.set('search', term);
    else params.delete('search');
  }
  return `/pulse${params.size ? `?${params}` : ''}`;
}