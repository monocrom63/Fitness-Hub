import { useQueryClient, type InfiniteData } from '@tanstack/react-query';
import type { MemberNotification, MemberNotificationUnreadCount } from '@workspace/api-client-react';
import {
  getGetMemberHomeQueryKey,
  getGetMemberNotificationUnreadCountQueryKey,
  getListMemberCoursesQueryKey,
  getListMemberCheckInsQueryKey,
  getListMemberNotificationsQueryKey,
  useAcceptMemberInvitation,
  useBookMemberCourse,
  useCancelMemberCourse,
  useClaimMembership,
  useGetMemberHome,
  useGetMemberNotificationUnreadCount,
  useListMemberCheckIns,
  useListMemberCourses,
  useMarkMemberNotificationRead,
  useUpdateMemberNotificationSettings,
} from '@workspace/api-client-react';
import { memberNotificationArchiveQueryKey } from '../notification-history';

export { useGetMemberHome, useListMemberCourses, useListMemberCheckIns };

export function useMemberNotificationUnreadCount(enabled: boolean) {
  return useGetMemberNotificationUnreadCount({
    query: {
      queryKey: getGetMemberNotificationUnreadCountQueryKey(),
      enabled,
      refetchOnWindowFocus: true,
      refetchInterval: enabled ? 45_000 : false,
    },
  });
}

export function useNotificationRead() {
  const client = useQueryClient();
  return useMarkMemberNotificationRead({
    mutation: {
      onSuccess: (notification) => {
        const archive = client.getQueryData<InfiniteData<MemberNotification[], number>>(memberNotificationArchiveQueryKey);
        const wasUnread = archive?.pages.some(page => page.some(item => item.id === notification.id && !item.readAt));
        if (wasUnread) {
          client.setQueryData<MemberNotificationUnreadCount>(getGetMemberNotificationUnreadCountQueryKey(), old =>
            old ? { count: Math.max(0, old.count - 1) } : old,
          );
        }
        client.setQueryData<InfiniteData<MemberNotification[], number>>(memberNotificationArchiveQueryKey, old =>
          old && { ...old, pages: old.pages.map(page =>
            page.map(item => item.id === notification.id ? notification : item),
          ) },
        );
        void client.invalidateQueries({ queryKey: getListMemberNotificationsQueryKey() });
        void client.invalidateQueries({ queryKey: getGetMemberNotificationUnreadCountQueryKey() });
      },
    },
  });
}

export function useEmailPreference() {
  const client = useQueryClient();
  return useUpdateMemberNotificationSettings({
    mutation: {
      onSuccess: (home) => {
        client.setQueryData(getGetMemberHomeQueryKey(), home);
        void client.invalidateQueries({ queryKey: getListMemberNotificationsQueryKey() });
      },
    },
  });
}

export function useInvitationAcceptance() {
  const client = useQueryClient();
  return useAcceptMemberInvitation({
    mutation: {
      onSuccess: (home) => {
        client.setQueryData(getGetMemberHomeQueryKey(), home);
        void client.invalidateQueries({ queryKey: getGetMemberHomeQueryKey() });
      },
    },
  });
}

export function useMemberActions() {
  const client = useQueryClient();
  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: getGetMemberHomeQueryKey() }),
      client.invalidateQueries({ queryKey: getListMemberCoursesQueryKey() }),
      client.invalidateQueries({ queryKey: getListMemberCheckInsQueryKey() }),
      client.invalidateQueries({ queryKey: getListMemberNotificationsQueryKey() }),
      client.invalidateQueries({ queryKey: getGetMemberNotificationUnreadCountQueryKey() }),
    ]);
  };
  const claim = useClaimMembership({ mutation: { onSuccess: refresh } });
  const book = useBookMemberCourse({ mutation: { onSuccess: refresh } });
  const cancel = useCancelMemberCourse({ mutation: { onSuccess: refresh } });
  return { claim, book, cancel };
}