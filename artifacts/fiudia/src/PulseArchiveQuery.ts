import { getListPulseQueryKey, listPulse } from '@workspace/api-client-react';

export type PulseArchiveFilter = 'all' | 'unread';

export function pulseArchiveQueryOptions(
  filter: PulseArchiveFilter,
  searchTerm: string,
  loadMessages: typeof listPulse = listPulse,
) {
  return {
    queryKey: [...getListPulseQueryKey(), 'history', filter, searchTerm] as const,
    queryFn: ({ pageParam, signal }: { pageParam: number; signal: AbortSignal }) => loadMessages({
      ...(pageParam ? { beforeId: pageParam } : {}),
      ...(filter === 'unread' ? { unreadOnly: true } : {}),
      ...(searchTerm ? { search: searchTerm } : {}),
    }, { signal }),
    initialPageParam: 0,
    getNextPageParam: (lastPage: Awaited<ReturnType<typeof listPulse>>) =>
      lastPage.length === 30 ? lastPage[lastPage.length - 1].id : undefined,
    refetchInterval: 60000,
  };
}