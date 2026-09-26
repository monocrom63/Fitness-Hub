import { useQueryClient } from '@tanstack/react-query';
import {
  getGetMemberHomeQueryKey,
  getListMemberCoursesQueryKey,
  getListMemberCheckInsQueryKey,
  useBookMemberCourse,
  useCancelMemberCourse,
  useClaimMembership,
  useGetMemberHome,
  useListMemberCheckIns,
  useListMemberCourses,
} from '@workspace/api-client-react';

export { useGetMemberHome, useListMemberCourses, useListMemberCheckIns };

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