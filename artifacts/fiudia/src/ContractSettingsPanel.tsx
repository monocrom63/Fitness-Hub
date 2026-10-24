import { useEffect, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getGetContractSettingsQueryKey, getListMembersQueryKey, useGetContractSettings, useListMembers, useUpdateContractSettings, useUpdateMember } from "@workspace/api-client-react";

type Plan = {
  id?: number | null;
  name: string;
  durationMonths: number;
  monthlyPriceCents: number;
  semiannualDiscountPercent: number;
  annualDiscountPercent: number;
};
type FormState = {
  legalName: string; legalAddress: string; contactEmail: string; contactPhone: string;
  termsText: string; enrollmentFeeCents: number; membershipCardFeeCents: number;
  paymentDueDay: number; plans: Plan[];
};
const blank: FormState = {
  legalName: "", legalAddress: "", contactEmail: "", contactPhone: "", termsText: "",
  enrollmentFeeCents: 0, membershipCardFeeCents: 0, paymentDueDay: 1, plans: [],
};

export default function ContractSettingsPanel({ studioId }: { studioId: number | null }) {
  const client = useQueryClient();
  const query = useGetContractSettings();
  const save = useUpdateContractSettings();
  const [form, setForm] = useState<FormState>(blank);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (query.data) setForm({
      legalName: query.data.legalName, legalAddress: query.data.legalAddress,
      contactEmail: query.data.contactEmail, contactPhone: query.data.contactPhone,
      termsText: query.data.termsText, enrollmentFeeCents: query.data.enrollmentFeeCents,
      membershipCardFeeCents: query.data.membershipCardFeeCents,
      paymentDueDay: query.data.paymentDueDay,
      plans: query.data.plans.length
        ? query.data.plans.map(({ active: _active, ...plan }) => plan)
        : [
          { name: "Basis", durationMonths: 0, monthlyPriceCents: 2990, semiannualDiscountPercent: 5, annualDiscountPercent: 10 },
          { name: "Premium", durationMonths: 0, monthlyPriceCents: 4990, semiannualDiscountPercent: 5, annualDiscountPercent: 10 },
        ],
    });
  }, [query.data]);
  const set = (key: keyof Omit<FormState, "plans">, value: string | number) =>
    setForm(current => ({ ...current, [key]: value }));
  const updatePlan = (index: number, key: keyof Plan, value: string | number) =>
    setForm(current => ({ ...current, plans: current.plans.map((plan, i) => i === index
      ? { ...plan, [key]: key === "name" ? value : Number(value) } : plan) }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSaved(false);
    save.mutate({ data: form }, {
      onSuccess: async () => {
        await client.invalidateQueries({ queryKey: getGetContractSettingsQueryKey() });
        setSaved(true);
      },
    });
  };
  return <section className="module-settings" aria-labelledby="contract-settings-title">
    <div className="eyebrow">Mitgliedschaft / Vertrag</div>
    <h2 id="contract-settings-title">Vertragsdaten</h2>
    <p>Hinterlege Fiudia-Angaben, Tarife, Laufzeiten und freigegebene AGB. Ohne ausgefüllte AGB können Mitglieder den Vertrag nicht unterschreiben.</p>
    {query.isLoading ? <p role="status">Vertragsdaten werden geladen …</p> : query.isError ? <p className="form-error" role="alert">Vertragsdaten konnten nicht geladen werden.</p> :
      <form className="form-stack" onSubmit={submit}>
        <label className="profile-field">Vertragspartner<input className="field" required maxLength={200} value={form.legalName} onChange={e => set("legalName", e.target.value)} /></label>
        <label className="profile-field">Geschäftsadresse<textarea className="field" required maxLength={500} value={form.legalAddress} onChange={e => set("legalAddress", e.target.value)} /></label>
        <div className="form-grid">
          <label className="profile-field">Kontakt-E-Mail<input className="field" required type="email" value={form.contactEmail} onChange={e => set("contactEmail", e.target.value)} /></label>
          <label className="profile-field">Telefon<input className="field" maxLength={40} value={form.contactPhone} onChange={e => set("contactPhone", e.target.value)} /></label>
        </div>
        <div className="eyebrow">Tarife und Vertragslaufzeiten</div>
        {form.plans.map((plan, index) => <div className="settings-card" key={plan.id ?? `new-${index}`} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 12 }}>
          <label className="profile-field">Tarif<input className="field" required value={plan.name} onChange={e => updatePlan(index, "name", e.target.value)} /></label>
          <label className="profile-field">Laufzeit (Monate)<input className="field" type="number" min={1} max={1200} required value={plan.durationMonths || ""} onChange={e => updatePlan(index, "durationMonths", e.target.value)} /></label>
          <label className="profile-field">Grundpreis / Monat (€)<input className="field" type="number" min={0} step="0.01" required value={(plan.monthlyPriceCents / 100).toFixed(2)} onChange={e => updatePlan(index, "monthlyPriceCents", Math.round(Number(e.target.value) * 100))} /></label>
          <label className="profile-field">Rabatt 6 Monate (%)<input className="field" type="number" min={0} max={100} value={plan.semiannualDiscountPercent} onChange={e => updatePlan(index, "semiannualDiscountPercent", e.target.value)} /></label>
          <label className="profile-field">Rabatt 12 Monate (%)<input className="field" type="number" min={0} max={100} value={plan.annualDiscountPercent} onChange={e => updatePlan(index, "annualDiscountPercent", e.target.value)} /></label>
        </div>)}
        <button className="button button-outline" type="button" onClick={() => setForm(current => ({ ...current, plans: [...current.plans, { name: "", durationMonths: 0, monthlyPriceCents: 0, semiannualDiscountPercent: 5, annualDiscountPercent: 10 }] }))}>Tarif hinzufügen</button>
        <div className="form-grid">
          <label className="profile-field">Aufnahmegebühr (€)<input className="field" type="number" min={0} step="0.01" value={(form.enrollmentFeeCents / 100).toFixed(2)} onChange={e => set("enrollmentFeeCents", Math.round(Number(e.target.value) * 100))} /></label>
          <label className="profile-field">Kartenpfand (€)<input className="field" type="number" min={0} step="0.01" value={(form.membershipCardFeeCents / 100).toFixed(2)} onChange={e => set("membershipCardFeeCents", Math.round(Number(e.target.value) * 100))} /></label>
          <label className="profile-field">Abbuchung am Monatstag<input className="field" type="number" min={1} max={28} value={form.paymentDueDay} onChange={e => set("paymentDueDay", Number(e.target.value))} /></label>
        </div>
        <label className="profile-field">Fiudia-AGB<textarea className="field" required minLength={1} maxLength={50000} rows={12} value={form.termsText} onChange={e => set("termsText", e.target.value)} placeholder="Hier die freigegebenen Fiudia-AGB eintragen. Der Beispielvertrag wurde nicht übernommen." /></label>
        {save.isError && <p className="form-error" role="alert">Vertragsdaten konnten nicht gespeichert werden.</p>}
        {saved && <p className="profile-success" role="status">Vertragsdaten gespeichert.</p>}
        <button className="button button-primary" type="submit" disabled={save.isPending}>{save.isPending ? "Wird gespeichert …" : "Vertragsdaten speichern"}</button>
      </form>}
    <StaffMemberContractEditor studioId={studioId} />
  </section>;
}

function StaffMemberContractEditor({ studioId }: { studioId: number | null }) {
  const client = useQueryClient();
  const params = studioId ? { studioId } : undefined;
  const members = useListMembers(params, { query: { queryKey: getListMembersQueryKey(params), enabled: !!studioId } });
  const update = useUpdateMember();
  const [memberId, setMemberId] = useState("");
  const [form, setForm] = useState({
    membershipType: "", billingInterval: "monthly", contractStart: "",
    contractDurationMonths: "", restPeriodStart: "", restPeriodEnd: "",
  });
  const member = members.data?.find(item => item.id === Number(memberId));
  useEffect(() => {
    if (!member) return;
    setForm({
      membershipType: member.membershipType, billingInterval: member.billingInterval,
      contractStart: member.contractStart ?? "",
      contractDurationMonths: member.contractDurationMonths ? String(member.contractDurationMonths) : "",
      restPeriodStart: member.restPeriodStart ?? "", restPeriodEnd: member.restPeriodEnd ?? "",
    });
  }, [member]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!member) return;
    update.mutate({ id: member.id, data: {
      membershipType: form.membershipType, billingInterval: form.billingInterval as "monthly" | "semiannual" | "annual",
      contractStart: form.contractStart || null,
      contractDurationMonths: form.contractDurationMonths ? Number(form.contractDurationMonths) : null,
      restPeriodStart: form.restPeriodStart || null, restPeriodEnd: form.restPeriodEnd || null,
    } }, { onSuccess: () => {
      void client.invalidateQueries({ queryKey: getListMembersQueryKey(params) });
    } });
  };
  return <section className="module-settings" aria-labelledby="staff-contract-member-title">
    <div className="eyebrow">Mitglieder / Vertragsangaben</div>
    <h2 id="staff-contract-member-title">Mitgliedsdaten bearbeiten</h2>
    {!studioId ? <p>Wähle zuerst ein Studio aus, um dessen Mitgliedsdaten zu bearbeiten.</p> :
      members.isLoading ? <p role="status">Mitglieder werden geladen …</p> :
      members.isError ? <p className="form-error" role="alert">Mitglieder konnten nicht geladen werden.</p> :
      <form className="form-stack" onSubmit={submit}>
        <label className="profile-field">Mitglied
          <select className="field" value={memberId} onChange={e => setMemberId(e.target.value)} required>
            <option value="">Mitglied auswählen</option>
            {members.data?.map(item => <option key={item.id} value={item.id}>{item.fullName} · #{item.id}</option>)}
          </select>
        </label>
        {member && <>
          <div className="form-grid">
            <label className="profile-field">Tarif<input className="field" required value={form.membershipType} onChange={e => setForm(current => ({ ...current, membershipType: e.target.value }))} /></label>
            <label className="profile-field">Abbuchungsrhythmus<select className="field" value={form.billingInterval} onChange={e => setForm(current => ({ ...current, billingInterval: e.target.value }))}><option value="monthly">Monatlich</option><option value="semiannual">Halbjährlich – 5 % Rabatt</option><option value="annual">Jährlich – 10 % Rabatt</option></select></label>
            <label className="profile-field">Vertragsbeginn<input className="field" type="date" value={form.contractStart} onChange={e => setForm(current => ({ ...current, contractStart: e.target.value }))} /></label>
            <label className="profile-field">Vertragslaufzeit (Monate)<input className="field" type="number" min={1} max={1200} value={form.contractDurationMonths} onChange={e => setForm(current => ({ ...current, contractDurationMonths: e.target.value }))} /></label>
            <label className="profile-field">Ruhezeit von<input className="field" type="date" value={form.restPeriodStart} onChange={e => setForm(current => ({ ...current, restPeriodStart: e.target.value }))} /></label>
            <label className="profile-field">Ruhezeit bis<input className="field" type="date" value={form.restPeriodEnd} onChange={e => setForm(current => ({ ...current, restPeriodEnd: e.target.value }))} /></label>
          </div>
          {update.isError && <p className="form-error" role="alert">Mitgliedsdaten konnten nicht gespeichert werden.</p>}
          {update.isSuccess && <p className="profile-success" role="status">Mitgliedsdaten gespeichert.</p>}
          <button className="button button-primary" type="submit" disabled={update.isPending}>{update.isPending ? "Wird gespeichert …" : "Mitgliedsdaten speichern"}</button>
        </>}
      </form>}
  </section>;
}
