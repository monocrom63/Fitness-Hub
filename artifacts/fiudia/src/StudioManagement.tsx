import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { Plus } from 'lucide-react';
import { getListStudiosQueryKey, useCreateStudio, useListStudios } from '@workspace/api-client-react';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';

type StudioFields = { name: string; city: string };

export default function StudioManagement() {
  const client = useQueryClient();
  const studios = useListStudios({ query: { queryKey: getListStudiosQueryKey(), refetchOnMount: 'always' } });
  const create = useCreateStudio();
  const form = useForm<StudioFields>({ defaultValues: { name: '', city: '' } });
  const [formOpen, setFormOpen] = useState(false);
  const [feedback, setFeedback] = useState('');

  const submit = (fields: StudioFields) => {
    setFeedback('');
    create.mutate({ data: { name: fields.name.trim(), city: fields.city.trim() } }, {
      onSuccess: studio => {
        void client.invalidateQueries({ queryKey: getListStudiosQueryKey() });
        setFeedback(`Studio „${studio.name}“ in ${studio.city} angelegt.`);
        form.reset();
        setFormOpen(false);
      },
    });
  };

  return <section className="module-settings studio-settings" data-testid="section-studio-management">
    <div className="studio-settings-head">
      <div>
        <div className="eyebrow">Organisation / Standorte</div>
        <h2>Studios</h2>
        <p>Lege weitere Standorte an. Danach kannst du für sie Kurse planen und Teammitglieder einladen.</p>
      </div>
      <button type="button" className="button button-dark" onClick={() => { create.reset(); setFormOpen(true); }} disabled={formOpen} data-testid="button-create-studio"><Plus size={16} /> Studio anlegen</button>
    </div>
    {formOpen && <Form {...form}>
      <form className="studio-create-form" onSubmit={form.handleSubmit(submit)} data-testid="form-create-studio">
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
          <button type="submit" className="button button-dark" disabled={create.isPending} data-testid="button-save-studio">{create.isPending ? 'Wird angelegt …' : 'Speichern'}</button>
          <button type="button" className="button button-outline" disabled={create.isPending} onClick={() => { setFormOpen(false); form.reset(); create.reset(); }} data-testid="button-cancel-studio">Abbrechen</button>
        </div>
        {create.isError && <p className="form-error" role="alert" data-testid="error-create-studio">
          {(create.error as { data?: { error?: string } } | null)?.data?.error || 'Studio konnte nicht angelegt werden.'}
        </p>}
      </form>
    </Form>}
    {feedback && <p className="booking-result" role="status" data-testid="status-studio-created">{feedback}</p>}
    {studios.isLoading ? <p className="studio-settings-status" role="status">Studios werden geladen …</p>
      : studios.isError ? <p className="form-error" role="alert">Studios konnten nicht geladen werden. <button type="button" className="button button-outline" onClick={() => void studios.refetch()} data-testid="button-retry-studio-list">Erneut versuchen</button></p>
      : <div className="module-list" data-testid="list-studios">{studios.data?.length
        ? studios.data.map(studio => <div className="module-row" key={studio.id} data-testid={`row-studio-${studio.id}`}><div><strong>{studio.name}</strong><span>{studio.city}</span></div></div>)
        : <div className="module-row">Noch kein Studio angelegt.</div>}</div>}
  </section>;
}