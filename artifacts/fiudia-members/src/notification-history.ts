import {
  getListMemberNotificationsQueryKey,
  listMemberNotifications,
} from '@workspace/api-client-react';

export const memberNotificationArchiveQueryKey = [...getListMemberNotificationsQueryKey(), 'archive'] as const;

export function memberNotificationArchiveQueryOptions(
  loadNotifications: typeof listMemberNotifications = listMemberNotifications,
) {
  return {
    queryKey: memberNotificationArchiveQueryKey,
    queryFn: ({ pageParam, signal }: { pageParam: number; signal: AbortSignal }) =>
      loadNotifications(pageParam ? { beforeId: pageParam } : {}, { signal }),
    initialPageParam: 0,
    getNextPageParam: (lastPage: Awaited<ReturnType<typeof listMemberNotifications>>) =>
      lastPage.length === 50 ? lastPage[lastPage.length - 1].id : undefined,
    refetchOnWindowFocus: true,
    refetchInterval: 45_000,
  };
}