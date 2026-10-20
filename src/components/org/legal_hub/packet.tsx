import { useState } from "react";
import { normalizeLegalClientRole } from "../../../../shared/legal_case_workflow";
import { ClipboardList, Loader2 } from "lucide-react";
import { useLegalDocument, useLegalDocumentScope } from "../../../hooks/useLegalDocument";
import { runLegalTool } from "../../../lib/legalToolClient";
import type { LegalCaseFile } from "../../../lib/legalCaseStore";
import { uiMessage } from "../../../i18n/uiMessages";
import { legalCaseDraftContext, legalCaseToolArgs } from './case_values';
import { LegalTwoPaneTool } from './two_pane_tool';

type PacketProps = { caseFile?: LegalCaseFile | null; orgId?: string };
export function LegalPacketView(props: PacketProps) {
  const scope = useLegalDocumentScope(props.caseFile?.id, props.orgId);
  return <LegalPacketForm key={scope} {...props} />;
}
function LegalPacketForm({ caseFile, orgId }: PacketProps) {
  const { text: facts, setText: setFacts, result, successfulResult, restoredResult, busy, generate: run } = useLegalDocument(legalCaseDraftContext(caseFile), { error: 'Error' }, { caseFile, toolName: 'legal_generate_litigation_packet' });
  const [evidence, setEvidence] = useState('');
  const [role, setRole] = useState(() => normalizeLegalClientRole(caseFile?.clientRole));
  const [claims, setClaims] = useState('');
  const loading = Boolean(busy);

  const generate = () => {
    if (!role || (!facts.trim() && !evidence.trim())) return;
    return run(signal => runLegalTool('legal_generate_litigation_packet', {
      ...legalCaseToolArgs(caseFile, orgId),
      role,
      claims,
      facts,
      evidence,
    }, signal));
  };


  return (
    <LegalTwoPaneTool
      icon={<ClipboardList size={22} />}
      accent="amber"
      title={uiMessage('legal-hub.semi-automated-litigation-packet.37b15d0cf5')}
      desc={uiMessage('legal-hub.draft-complaint-defense-evidence-retainer.da01b9a635')}
      caseFile={caseFile}
      running={loading}
      left={(
        <>
          <div className="grid gap-3 md:grid-cols-2">
            <select aria-label={uiMessage('legal-hub.identity.1a371622a1')} value={role} disabled={loading} onChange={event => setRole(event.target.value)} className="lumi-field h-10 rounded-lg">
              <option value="">{uiMessage('avatar-studio.choose.9c29923883')}</option>
              <option value="plaintiff">{uiMessage('legal-hub.plaintiff.607f2116c4')}</option>
              <option value="defendant">{uiMessage('legal-hub.defendant.a3bd508da0')}</option>
              <option value="applicant">{uiMessage('legal-hub.applicant.5be3a82eea')}</option>
              <option value="respondent">{uiMessage('legal-hub.respondent.f726ebb1c2')}</option>
            </select>
            <input value={claims} onChange={event => setClaims(event.target.value)} placeholder={uiMessage('legal-hub.claims-defenses-or-objective.00855c8c20')} className="lumi-field h-10 rounded-lg" />
          </div>
          <label className="mt-3 block space-y-1.5">
            <span className="text-xs text-white/60">{uiMessage('legal-hub.facts-timeline-parties.6783b7303c')}</span>
            <textarea value={facts} onChange={event => setFacts(event.target.value)} aria-label={uiMessage('legal-hub.facts-timeline-parties.6783b7303c')} placeholder={uiMessage('legal-hub.facts-timeline-parties.6783b7303c')} className=" min-h-[240px] w-full resize-none rounded-lg border border-white/10 bg-black/20 px-3 py-3 text-sm leading-6 text-white outline-none placeholder:text-white/35 focus:border-amber-400/35" />
          </label>
          <label className="mt-3 block space-y-1.5">
            <span className="text-xs text-white/60">{uiMessage('legal-hub.evidence-opponent-materials-gaps.61eff6246d')}</span>
            <textarea value={evidence} onChange={event => setEvidence(event.target.value)} aria-label={uiMessage('legal-hub.evidence-opponent-materials-gaps.61eff6246d')} placeholder={uiMessage('legal-hub.evidence-opponent-materials-gaps.61eff6246d')} className=" min-h-[140px] w-full resize-none rounded-lg border border-white/10 bg-black/20 px-3 py-3 text-sm leading-6 text-white outline-none placeholder:text-white/35 focus:border-amber-400/35" />
          </label>
          <button onClick={generate} disabled={loading || !role || (!facts.trim() && !evidence.trim())} className="mt-3 inline-flex items-center justify-center gap-2 rounded-lg border border-amber-400/20 bg-amber-500/15 px-4 py-2.5 text-sm font-medium text-amber-100 transition hover:bg-amber-500/25 disabled:opacity-50">
            {loading ? <Loader2 size={16} className="animate-spin" /> : <ClipboardList size={16} />}
            {loading ? uiMessage('legal-hub.generating.634308f29b') : uiMessage('legal-hub.generate-packet.8494e1ff7c')}
          </button>
        </>
      )}
      result={result}
      successfulResult={successfulResult}
      restoredResult={restoredResult}
      emptyText={uiMessage('legal-hub.the-packet-will-appear-here.52a02955fa')}
    />
  );
}
