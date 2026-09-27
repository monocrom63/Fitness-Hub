import { useQueryClient } from '@tanstack/react-query';
import type { MemberNotification } from '@workspace/api-client-react';
import {
  getGetMemberHomeQueryKey,
  getListMemberCoursesQueryKey,
  getListMemberCheckInsQueryKey,
  getListMemberNotificationsQueryKey,
  useAcceptMemberInvitation,
  useBookMemberCourse,
  useCancelMemberCourse,
  useClaimMembership,
  useGetMemberHome,
  useListMemberCheckIns,
  useListMemberCourses,
  useListMemberNotifications,
  useMarkMemberNotificationRead,
  useUpdateMemberNotificationSettings,
} from '@workspace/api-client-react';

export { useGetMemberHome, useListMemberCourses, useListMemberCheckIns };

export function useMemberNotifications(enabled: boolean) {
  return useListMemberNotifications({
    query: {
      queryKey: getListMemberNotificationsQueryKey(),
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
        client.setQueryData<MemberNotification[]>(getListMemberNotificationsQueryKey(), (old) =>
          old?.map(item => item.id === notification.id ? notification : item),
        );
        void client.invalidateQueries({ queryKey: getListMemberNotificationsQueryKey() });
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
    ]);
  };
  const claim = useClaimMembership({ mutation: { onSuccess: refresh } });
  const book = useBookMemberCourse({ mutation: { onSuccess: refresh } });
  const cancel = useCancelMemberCourse({ mutation: { onSuccess: refresh } });
  return { claim, book, cancel };
}