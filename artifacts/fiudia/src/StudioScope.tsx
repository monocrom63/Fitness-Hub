import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useAuth } from '@clerk/react';
import { getListStudiosQueryKey, useListStudios } from '@workspace/api-client-react';
import type { Me, StudioSummary } from '@workspace/api-client-react';
import { chooseAccessibleStudio, persistStudioId, readStoredStudioId, studioScopeStorageKey } from './course-studio-scope';

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
  const storageKey = studioScopeStorageKey(userId ?? null);
  const [chosenId, setChosenId] = useState<number | null>(() => readStoredStudioId(storageKey, () => sessionStorage));
  const studios = useListStudios({ query: {
    enabled: district,
    queryKey: getListStudiosQueryKey(),
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
  } });
  const available = district ? studios.data ?? [] : [];
  const selectedStudio = chooseAccessibleStudio(available, chosenId, me.studioId ?? null);
  const selectedStudioId = district ? selectedStudio?.id ?? null : me.studioId ?? null;
  const selectedStudioName = district ? selectedStudio?.name ?? null : me.studioName ?? null;

  useEffect(() => {
    if (!district || !studios.isSuccess) return;
    persistStudioId(storageKey, selectedStudioId, () => sessionStorage);
  }, [district, selectedStudioId, storageKey, studios.isSuccess]);

  const selectStudio = (id: number) => {
    if (!district || !available.some(studio => studio.id === id)) return;
    setChosenId(id);
    persistStudioId(storageKey, id, () => sessionStorage);
  };

  return <StudioScopeContext.Provider value={{ selectedStudioId, selectedStudioName, selectStudio, studios }}>
    {children}
  </StudioScopeContext.Provider>;
}