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

const cityKey = (city: string) => city.trim().toLocaleLowerCase('de-DE');

export function cityChoices(available: StudioSummary[]): Array<{ name: string; studioCount: number }> {
  const cities = new Map<string, { name: string; studioCount: number }>();
  for (const studio of available) {
    const name = studio.city.trim();
    if (!name) continue;
    const key = cityKey(name);
    const existing = cities.get(key);
    if (existing) existing.studioCount += 1;
    else cities.set(key, { name, studioCount: 1 });
  }
  return [...cities.values()].sort((a, b) => a.name.localeCompare(b.name, 'de-DE'));
}

export function studiosInCity(available: StudioSummary[], city: string | null): StudioSummary[] {
  return city ? available.filter(studio => cityKey(studio.city) === cityKey(city)) : [];
}

export function chooseStudioForCity(
  available: StudioSummary[],
  city: string,
  selectedStudioId: number | null,
): StudioSummary | undefined {
  const matching = studiosInCity(available, city);
  return matching.find(studio => studio.id === selectedStudioId) ?? matching[0];
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