import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useAuth } from '@clerk/react';
import { getListStudiosQueryKey, useListStudios } from '@workspace/api-client-react';
import type { Me, StudioSummary } from '@workspace/api-client-react';

type StudioScopeValue = {
  selectedStudioId: number | null;
  selectedStudioName: string | null;
  selectStudio: (id: number) => void;
  studios: ReturnType<typeof useListStudios<StudioSummary[]>>;
};

const StudioScopeContext = createContext<StudioScopeValue | null>(null);

export function useStudioScope(): StudioScopeValue {
  const scope = useContext(StudioScopeContext);
  if (!scope) throw new Error('Studio selection requires StudioScopeProvider');
  return scope;
}

export function StudioScopeProvider({ me, children }: { me: Me; children: ReactNode }) {
  const { userId } = useAuth();
  const district = me.role === 'district_manager';
  const storageKey = `fiudia:studio:${userId ?? 'unknown'}`;
  const [chosenId, setChosenId] = useState<number | null>(() => {
    try {
      const id = Number(sessionStorage.getItem(storageKey));
      return Number.isSafeInteger(id) && id > 0 ? id : null;
    } catch {
      return null;
    }
  });
  const studios = useListStudios({ query: {
    enabled: district,
    queryKey: getListStudiosQueryKey(),
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
  } });
  const available = district ? studios.data ?? [] : [];
  const selectedStudio = available.find(studio => studio.id === chosenId)
    ?? available.find(studio => studio.id === me.studioId)
    ?? available[0];
  const selectedStudioId = district ? selectedStudio?.id ?? null : me.studioId ?? null;
  const selectedStudioName = district ? selectedStudio?.name ?? null : me.studioName ?? null;

  useEffect(() => {
    if (!district || !studios.isSuccess) return;
    try {
      if (selectedStudioId) sessionStorage.setItem(storageKey, String(selectedStudioId));
      else sessionStorage.removeItem(storageKey);
    } catch {
      // The current selection remains usable when browser storage is unavailable.
    }
  }, [district, selectedStudioId, storageKey, studios.isSuccess]);

  const selectStudio = (id: number) => {
    if (!district || !available.some(studio => studio.id === id)) return;
    setChosenId(id);
    try {
      sessionStorage.setItem(storageKey, String(id));
    } catch {
      // The in-memory selection remains usable for this page.
    }
  };

  return <StudioScopeContext.Provider value={{ selectedStudioId, selectedStudioName, selectStudio, studios }}>
    {children}
  </StudioScopeContext.Provider>;
}