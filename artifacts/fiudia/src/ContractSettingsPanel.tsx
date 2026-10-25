import { useEffect, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getGetPublicContractTermsQueryKey, getListMembersQueryKey, useGetContractSettings, useGetPublicContractTerms, useListMembers, usePatchContractSettings, useUpdateMember } from "@workspace/api-client-react";
import type { ContractSettingsPatch } from "@workspace/api-client-react";

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
  const query = useGetContractSettings();
  const standardTerms = useGetPublicContractTerms({ query: { queryKey: getGetPublicContractTermsQueryKey(), enabled: !query.data?.termsText } });
  const save = usePatchContractSettings();
  const [form, setForm] = useState<FormState>(blank);
  const [savedSection, setSavedSection] = useState<string | null>(null);
  const [failedSection, setFailedSection] = useState<string | null>(null);
  const [pendingSection, setPendingSection] = useState<string | null>(null);
  const [sectionError, setSectionError] = useState<{ section: string; message: string } | null>(null);
  useEffect(() => {
    if (query.data) {
      setForm({
      legalName: query.data.legalName, legalAddress: query.data.legalAddress,
      contactEmail: query.data.contactEmail, contactPhone: query.data.contactPhone,
      termsText: query.data.termsText || standardTerms.data?.termsText || "", enrollmentFeeCents: query.data.enrollmentFeeCents,
      membershipCardFeeCents: query.data.membershipCardFeeCents,
      paymentDueDay: query.data.paymentDueDay,
      plans: query.data.plans.length
        ? query.data.plans.map(({ active: _active, ...plan }) => plan)
        : [
          { name: "Basis", durationMonths: 0, monthlyPriceCents: 2990, semiannualDiscountPercent: 5, annualDiscountPercent: 10 },
          { name: "Premium", durationMonths: 0, monthlyPriceCents: 4990, semiannualDiscountPercent: 5, annualDiscountPercent: 10 },
        ],
      });
    }
  }, [query.data, standardTerms.data]);
  const set = (key: keyof Omit<FormState, "plans">, value: string | number) => {
    setSavedSection(null);
    setForm(current => ({ ...current, [key]: value }));
  };
  const updatePlan = (index: number, key: keyof Plan, value: string | number) => {
    setSavedSection(null);
    setForm(current => ({ ...current, plans: current.plans.map((plan, i) => i === index
      ? { ...plan, [key]: key === "name" ? value : Number(value) } : plan) }));
  };
  const saveSection = (section: "details" | "fees" | "terms") => {
    if (!query.data) return;
    save.reset();
    setSavedSection(null);
    setFailedSection(null);
    setSectionError(null);
    if (section === "details" && (!form.legalName.trim() || !form.legalAddress.trim() ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.contactEmail) ||
      form.plans.some(plan => plan.name.trim().length < 2 || plan.durationMonths < 1 ||
        plan.durationMonths > 1200 || plan.monthlyPriceCents < 0))) {
      setFailedSection(section);
      setSectionError({ section, message: "Bitte prüfe Vertragspartner, E-Mail-Adresse und alle Tarifangaben." });
      return;
    }
    if (section === "terms" && !form.termsText.trim()) {
      setFailedSection(section);
      setSectionError({ section, message: "Bitte hinterlege AGB, bevor du sie speicherst." });
      return;
    }
    setPendingSection(section);
    let data: ContractSettingsPatch;
    if (section === "details") {
      data = {
        legalName: form.legalName, legalAddress: form.legalAddress,
        contactEmail: form.contactEmail, contactPhone: form.contactPhone,
        plans: form.plans,
      };
    } else if (section === "fees") {
      data = {
        enrollmentFeeCents: form.enrollmentFeeCents,
        membershipCardFeeCents: form.membershipCardFeeCents,
        paymentDueDay: form.paymentDueDay,
      };
    } else {
      data = { termsText: form.termsText };
    }
    save.mutate({ data }, {
      onSuccess: response => {
        if (section === "details") {
          setForm(current => ({
            ...current,
            plans: response.plans.map(({ active: _active, ...plan }) => plan),
          }));
        }
        setSavedSection(section);
        setPendingSection(null);
      },
      onError: () => { setFailedSection(section); setPendingSection(null); },
    });
  };
  const sectionSaveButton = (section: "details" | "fees" | "terms", label: string) => <>
    {failedSection === section && <p className="form-error" role="alert">{sectionError?.section === section ? sectionError.message : "Änderungen konnten nicht gespeichert werden."}</p>}
    <button className="button button-primary" type="button" disabled={save.isPending} onClick={() => saveSection(section)}>
      {pendingSection === section ? "Wird gespeichert …" : savedSection === section ? "Gespeichert" : label}
    </button>
  </>;
  return <section className="module-settings studio-settings contract-settings" aria-labelledby="contract-settings-title">
    <div className="studio-settings-head">
      <div>
        <div className="eyebrow">Mitgliedschaft / Vertrag</div>
        <h2 id="contract-settings-title">Vertragsdaten Mitglieder</h2>
        <p>Vertragspartner, Tarife, Aufnahmegebühren und freigegebene AGB verwalten.</p>
      </div>
    </div>
    {query.isLoading ? <p role="status">Vertragsdaten werden geladen …</p> : query.isError ? <p className="form-error" role="alert">Vertragsdaten konnten nicht geladen werden.</p> :
      <form className="form-stack contract-settings-form" onSubmit={event => event.preventDefault()}>
        <div className="contract-settings-card">
          <h3>Vertragspartner und Tarife</h3>
          <div className="form-grid">
            <label className="profile-field">Vertragspartner<input className="field" required maxLength={200} value={form.legalName} onChange={e => set("legalName", e.target.value)} /></label>
            <label className="profile-field">Geschäftsadresse<textarea className="field" required maxLength={500} value={form.legalAddress} onChange={e => set("legalAddress", e.target.value)} /></label>
            <label className="profile-field">Kontakt-E-Mail<input className="field" required type="email" value={form.contactEmail} onChange={e => set("contactEmail", e.target.value)} /></label>
            <label className="profile-field">Telefon<input className="field" maxLength={40} value={form.contactPhone} onChange={e => set("contactPhone", e.target.value)} /></label>
          </div>
          <div className="contract-settings-subhead">Tarife und Vertragslaufzeiten</div>
          <div className="contract-plan-list">
            {form.plans.map((plan, index) => <div className="contract-plan-card" key={plan.id ?? `new-${index}`}>
              <label className="profile-field">Tarif<input className="field" required value={plan.name} onChange={e => updatePlan(index, "name", e.target.value)} /></label>
              <label className="profile-field">Laufzeit (Monate)<input className="field" type="number" min={1} max={1200} required value={plan.durationMonths || ""} onChange={e => updatePlan(index, "durationMonths", e.target.value)} /></label>
              <label className="profile-field">Grundpreis / Monat (€)<input className="field" type="number" min={0} step="0.01" required value={(plan.monthlyPriceCents / 100).toFixed(2)} onChange={e => updatePlan(index, "monthlyPriceCents", Math.round(Number(e.target.value) * 100))} /></label>
              <label className="profile-field">Rabatt 6 Monate (%)<input className="field" type="number" min={0} max={100} value={plan.semiannualDiscountPercent} onChange={e => updatePlan(index, "semiannualDiscountPercent", e.target.value)} /></label>
              <label className="profile-field">Rabatt 12 Monate (%)<input className="field" type="number" min={0} max={100} value={plan.annualDiscountPercent} onChange={e => updatePlan(index, "annualDiscountPercent", e.target.value)} /></label>
            </div>)}
          </div>
          <button className="button button-outline" type="button" onClick={() => setForm(current => ({ ...current, plans: [...current.plans, { name: "", durationMonths: 0, monthlyPriceCents: 0, semiannualDiscountPercent: 5, annualDiscountPercent: 10 }] }))}>Tarif hinzufügen</button>
          {sectionSaveButton("details", "Vertragsdaten speichern")}
        </div>
        <div className="contract-settings-card">
          <h3>Aufnahmegebühr</h3>
          <div className="form-grid">
            <label className="profile-field">Aufnahmegebühr (€)<input className="field" type="number" min={0} step="0.01" value={(form.enrollmentFeeCents / 100).toFixed(2)} onChange={e => set("enrollmentFeeCents", Math.round(Number(e.target.value) * 100))} /></label>
            <label className="profile-field">Kartenpfand (€)<input className="field" type="number" min={0} step="0.01" value={(form.membershipCardFeeCents / 100).toFixed(2)} onChange={e => set("membershipCardFeeCents", Math.round(Number(e.target.value) * 100))} /></label>
            <label className="profile-field">Abbuchung am Monatstag<input className="field" type="number" min={1} max={28} value={form.paymentDueDay} onChange={e => set("paymentDueDay", Number(e.target.value))} /></label>
          </div>
          {sectionSaveButton("fees", "Gebühren speichern")}
        </div>
        <div className="contract-settings-card">
          <h3>AGB</h3>
          <label className="profile-field">Fiudia-AGB<textarea className="field" required minLength={1} maxLength={50000} rows={12} value={form.termsText} onChange={e => set("termsText", e.target.value)} placeholder="Die Musterfassung wird geladen." /></label>
          <p className="form-hint">Die Musterfassung ist ein Entwurf, kein Rechtsrat. Bitte Firmendaten ergänzen und vor der Verwendung rechtlich prüfen lassen.</p>
          {sectionSaveButton("terms", "AGB speichern")}
        </div>
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
  return <section className="module-settings studio-settings contract-member-settings" aria-labelledby="staff-contract-member-title">
    <div className="studio-settings-head">
      <div>
        <div className="eyebrow">Mitglieder / Vertragsangaben</div>
        <h2 id="staff-contract-member-title">Mitgliedsdaten bearbeiten</h2>
        <p>Tarif, Laufzeit, Abbuchungsrhythmus und Ruhezeiten für Mitglieder dieses Studios anpassen.</p>
      </div>
    </div>
    {!studioId ? <p>Wähle zuerst ein Studio aus, um dessen Mitgliedsdaten zu bearbeiten.</p> :
      members.isLoading ? <p role="status">Mitglieder werden geladen …</p> :
      members.isError ? <p className="form-error" role="alert">Mitglieder konnten nicht geladen werden.</p> :
      <form className="form-stack contract-settings-card" onSubmit={submit}>
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
