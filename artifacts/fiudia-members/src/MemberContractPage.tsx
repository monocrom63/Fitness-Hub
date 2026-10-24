import { useEffect, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, FileText } from "lucide-react";
import { Link } from "wouter";
import {
  getGetCurrentMemberContractQueryKey,
  getGetMemberContractPdfQueryKey,
  useGetCurrentMemberContract,
  useGetMemberContractPdf,
  useSignMemberContract,
} from "@workspace/api-client-react";
import type { Member } from "@workspace/api-client-react";

export default function MemberContractPage({ member }: { member: Member }) {
  const client = useQueryClient();
  const contract = useGetCurrentMemberContract({ query: { queryKey: getGetCurrentMemberContractQueryKey(), retry: false } });
  const contractId = contract.data?.id ?? 0;
  const pdf = useGetMemberContractPdf(contractId, { query: { queryKey: getGetMemberContractPdfQueryKey(contractId), enabled: contractId > 0 } });
  const sign = useSignMemberContract();
  const [signatureName, setSignatureName] = useState(member.fullName);
  const [accepted, setAccepted] = useState(false);
  const [pdfUrl, setPdfUrl] = useState("");
  useEffect(() => {
    if (!(pdf.data instanceof Blob)) return;
    const url = URL.createObjectURL(pdf.data);
    setPdfUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [pdf.data]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!accepted || !signatureName.trim() || !contractId) return;
    sign.mutate({ id: contractId, data: { signatureName: signatureName.trim(), acceptTerms: true } }, {
      onSuccess: () => {
        void client.invalidateQueries({ queryKey: getGetCurrentMemberContractQueryKey() });
      },
    });
  };
  return <div className="page">
    <Link href="/profile" className="button button-outline"><ArrowLeft size={15} /> Zurück zum Profil</Link>
    <div style={{ maxWidth: 860, margin: "24px auto" }}>
      <p className="eyebrow">Mitgliedschaft / Vertrag</p>
      <h1>Dein Mitgliedsvertrag</h1>
      <p>Prüfe den Vertrag. Nach deiner Bestätigung senden wir das unterschriebene PDF an {member.email}.</p>
      {contract.isLoading && <p role="status">Vertrag wird geladen …</p>}
      {contract.isError && <div className="form-error" role="alert">{(contract.error as Error)?.message || "Der Vertrag konnte nicht geladen werden. Bitte lass die Leitung zuerst die Vertragsdaten und AGB eintragen."}</div>}
      {contract.data && <>
        {pdfUrl ? <iframe title="Fiudia-Mitgliedsvertrag als PDF" src={pdfUrl} style={{ width: "100%", height: 540, border: "1px solid #dce2eb", borderRadius: 16, background: "#fff" }} /> :
          <div className="settings-card"><FileText /><span>{pdf.isLoading ? "PDF wird vorbereitet …" : "Die PDF-Vorschau konnte nicht geladen werden."}</span></div>}
        {contract.data.status === "signed" ? <section className="profile-success" role="status">
          <h2><Check size={18} /> Vertrag bestätigt</h2>
          <p>Dein Vertrag wurde am {contract.data.signedAt ? new Date(contract.data.signedAt).toLocaleDateString("de-DE") : "heute"} bestätigt.</p>
          <p>{contract.data.emailStatus === "sent" ? `Das PDF wurde an ${member.email} gesendet.` : contract.data.emailStatus === "failed" ? "Die Bestätigung ist gespeichert, aber der E-Mail-Versand ist fehlgeschlagen. Bitte wende dich an dein Studio." : "Der E-Mail-Versand wird verarbeitet."}</p>
        </section> : <form onSubmit={submit} className="form-stack" style={{ marginTop: 20 }}>
          <label className="profile-field">Vollständiger Name als Unterschrift
            <input className="field" required minLength={2} maxLength={160} value={signatureName} onChange={e => setSignatureName(e.target.value)} />
          </label>
          <label style={{ display: "flex", alignItems: "start", gap: 10 }}>
            <input type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)} required />
            <span>Ich habe den Vertrag und die AGB gelesen und akzeptiere sie.</span>
          </label>
          {sign.isError && <p className="form-error" role="alert">Die Unterschrift konnte nicht gespeichert werden. Bitte erneut versuchen.</p>}
          <button className="button button-primary" type="submit" disabled={!accepted || sign.isPending}>
            {sign.isPending ? "Wird bestätigt …" : "Unterschrift bestätigen"} <Check size={15} />
          </button>
        </form>}
      </>}
    </div>
  </div>;
}
