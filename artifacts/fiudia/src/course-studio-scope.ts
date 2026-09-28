import { getListCoursesQueryKey, type StudioSummary } from '@workspace/api-client-react';

export function studioScopeStorageKey(userId: string | null): string {
  return `fiudia:studio:${userId ?? 'unknown'}`;
}

export function readStoredStudioId(key: string, getStorage: () => Pick<Storage, 'getItem'>): number | null {
  try {
    const id = Number(getStorage().getItem(key));
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

export function persistStudioId(
  key: string,
  id: number | null,
  getStorage: () => Pick<Storage, 'setItem' | 'removeItem'>,
): void {
  try {
    if (id) getStorage().setItem(key, String(id));
    else getStorage().removeItem(key);
  } catch {
    // An in-memory selection still works if browser storage is unavailable.
  }
}

export function chooseAccessibleStudio(
  available: StudioSummary[],
  chosenId: number | null,
  assignedId: number | null,
): StudioSummary | undefined {
  return available.find(studio => studio.id === chosenId)
    ?? available.find(studio => studio.id === assignedId)
    ?? available[0];
}

export function courseQueryScope(district: boolean, selectedStudioId: number | null) {
  const params = district && selectedStudioId ? { studioId: selectedStudioId } : undefined;
  return {
    params,
    query: {
      queryKey: getListCoursesQueryKey(params),
      enabled: !district || !!selectedStudioId,
    },
  };
}