import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { Plus } from 'lucide-react';
import {
  getGetDashboardQueryKey, getGetMeQueryKey, getListCoursesQueryKey, getListInvitationsQueryKey,
  getListPulseQueryKey, getListStudiosQueryKey, useCreateStudio, useListStudios, useUpdateStudio,
} from '@workspace/api-client-react';
import type { StudioSummary } from '@workspace/api-client-react';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';

type StudioFields = { name: string; city: string };

export default function StudioManagement() {
  const client = useQueryClient();
  const studios = useListStudios({ query: { queryKey: getListStudiosQueryKey(), refetchOnMount: 'always' } });
  const create = useCreateStudio();
  const update = useUpdateStudio();
  const form = useForm<StudioFields>({ defaultValues: { name: '', city: '' } });
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [feedback, setFeedback] = useState('');

  const saved = (studio: StudioSummary, edited: boolean) => {
    void client.invalidateQueries({ queryKey: getListStudiosQueryKey() });
    void client.invalidateQueries({ queryKey: getGetMeQueryKey() });
    void client.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
    void client.invalidateQueries({ queryKey: getListCoursesQueryKey() });
    void client.invalidateQueries({ queryKey: getListInvitationsQueryKey() });
    void client.invalidateQueries({ queryKey: getListPulseQueryKey() });
    setFeedback(`Studio „${studio.name}“ in ${studio.city} ${edited ? 'aktualisiert' : 'angelegt'}.`);
    form.reset();
    setEditingId(null);
    setFormOpen(false);
  };

  const submit = (fields: StudioFields) => {
    setFeedback('');
    const data = { name: fields.name.trim(), city: fields.city.trim() };
    if (editingId !== null) {
      update.mutate({ id: editingId, data }, { onSuccess: studio => saved(studio, true) });
    } else {
      create.mutate({ data }, { onSuccess: studio => saved(studio, false) });
    }
  };

  return <section className="module-settings studio-settings" data-testid="section-studio-management">
    <div className="studio-settings-head">
      <div>
        <div className="eyebrow">Organisation / Standorte</div>
        <h2>Studios</h2>
        <p>Lege weitere Standorte an. Danach kannst du für sie Kurse planen und Teammitglieder einladen.</p>
      </div>
      <button type="button" className="button button-dark" onClick={() => { create.reset(); update.reset(); setEditingId(null); form.reset({ name: '', city: '' }); setFormOpen(true); }} disabled={formOpen} data-testid="button-create-studio"><Plus size={16} /> Studio anlegen</button>
    </div>
    {formOpen && <Form {...form}>
      <form className="studio-create-form" onSubmit={form.handleSubmit(submit)} data-testid={editingId === null ? 'form-create-studio' : 'form-edit-studio'}>
        {editingId !== null && <h3 className="studio-form-title">Studio bearbeiten</h3>}
        <FormField control={form.control} name="name" rules={{
          validate: value => value.trim().length >= 2 || 'Bitte mindestens zwei Zeichen eingeben.',
          maxLength: { value: 120, message: 'Bitte höchstens 120 Zeichen eingeben.' },
        }} render={({ field }) => <FormItem className="field">
          <FormLabel>Studio-Name</FormLabel>
          <FormControl><input {...field} autoComplete="organization" maxLength={120} data-testid="input-studio-name" /></FormControl>
          <FormMessage />
        </FormItem>} />
        <FormField control={form.control} name="city" rules={{
          validate: value => value.trim().length >= 2 || 'Bitte mindestens zwei Zeichen eingeben.',
          maxLength: { value: 120, message: 'Bitte höchstens 120 Zeichen eingeben.' },
        }} render={({ field }) => <FormItem className="field">
          <FormLabel>Stadt</FormLabel>
          <FormControl><input {...field} autoComplete="address-level2" maxLength={120} data-testid="input-studio-city" /></FormControl>
          <FormMessage />
        </FormItem>} />
        <div className="studio-create-actions">
          <button type="submit" className="button button-dark" disabled={create.isPending || update.isPending} data-testid="button-save-studio">{create.isPending || update.isPending ? 'Wird gespeichert …' : 'Speichern'}</button>
          <button type="button" className="button button-outline" disabled={create.isPending || update.isPending} onClick={() => { setFormOpen(false); setEditingId(null); form.reset(); create.reset(); update.reset(); }} data-testid="button-cancel-studio">Abbrechen</button>
        </div>
        {(create.isError || update.isError) && <p className="form-error" role="alert" data-testid="error-save-studio">
          {((update.error || create.error) as { data?: { error?: string } } | null)?.data?.error || 'Studio konnte nicht gespeichert werden.'}
        </p>}
      </form>
    </Form>}
    {feedback && <p className="booking-result" role="status" data-testid="status-studio-created">{feedback}</p>}
    {studios.isLoading ? <p className="studio-settings-status" role="status">Studios werden geladen …</p>
      : studios.isError ? <p className="form-error" role="alert">Studios konnten nicht geladen werden. <button type="button" className="button button-outline" onClick={() => void studios.refetch()} data-testid="button-retry-studio-list">Erneut versuchen</button></p>
      : <div className="module-list" data-testid="list-studios">{studios.data?.length
        ? studios.data.map(studio => <div className="module-row" key={studio.id} data-testid={`row-studio-${studio.id}`}><div><strong>{studio.name}</strong><span>{studio.city}</span></div><button type="button" className="button button-outline" disabled={formOpen} onClick={() => {
          create.reset(); update.reset(); setFeedback(''); setEditingId(studio.id);
          form.reset({ name: studio.name, city: studio.city }); setFormOpen(true);
        }} data-testid={`button-edit-studio-${studio.id}`}>Bearbeiten</button></div>)
        : <div className="module-row">Noch kein Studio angelegt.</div>}</div>}
  </section>;
}