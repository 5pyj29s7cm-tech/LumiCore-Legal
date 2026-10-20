import { evaluateLegalCaseWorkflow } from '../../../../shared/legal_case_workflow';
import { CheckCircle, AlertTriangle } from "lucide-react";
import type { LegalCaseFile } from "../../../lib/legalCaseStore";
import { uiMessage } from "../../../i18n/uiMessages";
import type { LegalCaseReadinessItem } from './contracts';

const LEGAL_CASE_READINESS_TOOLS: Record<string, string> = {
  intake: 'legal_message_intake_to_case / legal_import_materials_to_kb',
  identity: 'legal_case_workspace / legal_import_materials_to_kb',
  facts: 'legal_meeting_minutes_to_case / legal_case_workspace',
  reasoning: 'legal_case_reasoning_matrix',
  evidence: 'legal_generate_litigation_packet',
  law: 'legal_search_statute / legal_generate_citation_verification_report',
  sources: 'legal_external_research_plan / legal_search_external_authorities / legal_search_tender_projects',
  'work-product': 'legal_generate_litigation_packet / legal_generate_argument_or_opinion',
  filing: 'legal_prepare_filing_handoff',
  delivery: 'legal_finalize_delivery_package',
};

export function buildLegalCaseReadiness(caseFile: LegalCaseFile): LegalCaseReadinessItem[] {
  const workflow = evaluateLegalCaseWorkflow(caseFile);
  const workflowSteps = new Map(workflow.steps.map(step => [step.key, step]));
  const state = (key: string): LegalCaseReadinessItem['status'] => workflowSteps.get(key)?.state || 'missing';
  const done = (key: string) => state(key) === 'done';
  const hasIntake = done('intake');
  const hasIdentity = done('identity');
  const hasFacts = done('facts');
  const hasReasoning = done('reasoning');
  const hasEvidence = done('evidence');
  const hasSources = done('sources');
  const hasWorkProduct = done('drafts');
  const hasLawBlocked = state('current-law') === 'blocked';
  const hasLawPassed = done('current-law');
  const hasFiling = done('filing');
  const hasDeliveryGate = done('delivery');

  const items: LegalCaseReadinessItem[] = [
    {
      key: 'intake',
      label: uiMessage('legal-hub.intake.795643fe2e'),
      detail: hasIntake ? uiMessage('legal-hub.archived.1638832a14') : uiMessage('legal-hub.missing.3a25cf328c'),
      status: state('intake'),
      nextStep: uiMessage('legal-hub.import-meeting-notes-pleadings-evidence.76c0fc3d9c'),
      done: hasIntake,
      view: 'import',
    },
    {
      key: 'identity',
      label: uiMessage('legal-hub.identity.1a371622a1'),
      detail: hasIdentity ? uiMessage('legal-hub.checked.9642f15399') : caseFile.party ? uiMessage('legal-hub.needs-check.bc00456c9a') : uiMessage('legal-hub.missing.2623bb38bf'),
      status: state('identity'),
      nextStep: uiMessage('legal-hub.add-identity-authority-and-service.8e402725fd'),
      done: hasIdentity,
      view: 'workspace',
    },
    {
      key: 'facts',
      label: uiMessage('legal-hub.facts.5d7a5e1f8e'),
      detail: hasFacts ? uiMessage('legal-hub.prepared.9c28beac05') : hasIntake ? uiMessage('legal-hub.ready.2ade9ebc78') : uiMessage('legal-hub.missing.2623bb38bf'),
      status: state('facts'),
      nextStep: uiMessage('legal-hub.build-a-timeline-of-parties.17d8b862d0'),
      done: hasFacts,
      view: 'workspace',
    },
    {
      key: 'reasoning',
      label: uiMessage('legal-hub.reasoning-matrix.83dc0f2ce5'),
      detail: hasReasoning ? uiMessage('legal-hub.ready.3280ebf66e') : uiMessage('legal-hub.required.de4a95adb4'),
      status: state('reasoning'),
      nextStep: uiMessage('legal-hub.generate-the-authority-evidence-and.46ae098910'),
      done: hasReasoning,
      view: 'strategy',
    },
    {
      key: 'evidence',
      label: uiMessage('legal-hub.evidence-review.904c0f7be0'),
      detail: hasEvidence ? uiMessage('legal-hub.prepared.9c28beac05') : uiMessage('legal-hub.missing.293c592854'),
      status: state('evidence'),
      nextStep: uiMessage('legal-hub.map-proof-purpose-original-status.0f3a872b6e'),
      done: hasEvidence,
      view: 'packet',
    },
    {
      key: 'law',
      label: uiMessage('legal-hub.current-law.85754e3378'),
      detail: hasLawBlocked ? uiMessage('legal-hub.blocked.3044b5e296') : hasLawPassed ? uiMessage('legal-hub.passed.24c823b3b1') : uiMessage('legal-hub.missing.ba39d5a9c2'),
      status: state('current-law'),
      nextStep: hasLawBlocked
        ? uiMessage('legal-hub.replace-or-verify-blocking-authorities.d6248457ac')
        : uiMessage('legal-hub.verify-all-statutes-interpretations-and.4348622a41'),
      done: hasLawPassed,
      view: 'verify',
    },
    {
      key: 'sources',
      label: uiMessage('legal-hub.sources.fbb50fb2b2'),
      detail: hasSources ? uiMessage('legal-hub.logged.2bd1b41ec1') : uiMessage('legal-hub.missing.b1cd9e1420'),
      status: state('sources'),
      nextStep: uiMessage('legal-hub.log-authorities-from-supreme-high.adfac8a04d'),
      done: hasSources,
      view: 'external-research',
    },
    {
      key: 'work-product',
      label: uiMessage('legal-hub.drafts.1b1bddcf17'),
      detail: hasWorkProduct ? uiMessage('legal-hub.drafted.ded8cf6f43') : uiMessage('legal-hub.missing.ee4d2a7e05'),
      status: state('drafts'),
      nextStep: uiMessage('legal-hub.generate-complaint-answer-cross-exam.f2aab3a8b7'),
      done: hasWorkProduct,
      view: 'packet',
    },
    {
      key: 'filing',
      label: uiMessage('legal-hub.filing.b85688fcb5'),
      detail: hasFiling ? uiMessage('legal-hub.handoff-ready.bf79982539') : hasWorkProduct ? uiMessage('legal-hub.manual.24f17bdf15') : uiMessage('legal-hub.not-ready.b358df0cab'),
      status: state('filing'),
      nextStep: uiMessage('legal-hub.prepare-court-platform-fields-and.29f878ee91'),
      done: hasFiling,
      view: 'packet',
    },
    {
      key: 'delivery',
      label: uiMessage('legal-hub.delivery-gate.94b193e100'),
      detail: hasLawBlocked ? uiMessage('legal-hub.blocked.e5862a2c38') : hasDeliveryGate ? uiMessage('legal-hub.recorded.5dd3865391') : uiMessage('legal-hub.missing.b4ee8a4d72'),
      status: state('delivery'),
      nextStep: hasLawBlocked
        ? uiMessage('legal-hub.fix-authorities-before-formal-delivery.b2e1639fb7')
        : uiMessage('legal-hub.run-the-formal-delivery-gate.3a08dedc0f'),
      done: hasDeliveryGate && !hasLawBlocked,
      view: 'verify',
    },
  ];
  return items.map(item => ({ ...item, tool: LEGAL_CASE_READINESS_TOOLS[item.key] }));
}

export function legalReadinessTone(status: LegalCaseReadinessItem['status']): string {
  if (status === 'done') return 'border-emerald-400/18 bg-emerald-500/[0.07] text-emerald-100';
  if (status === 'blocked') return 'border-rose-400/24 bg-rose-500/[0.08] text-rose-100';
  if (status === 'ready') return 'border-amber-400/22 bg-amber-500/[0.07] text-amber-100 hover:border-amber-300/35';
  if (status === 'manual') return 'border-cyan-400/20 bg-cyan-500/[0.06] text-cyan-100 hover:border-cyan-300/35';
  return 'border-white/10 bg-black/18 text-white/58 hover:border-white/16 hover:bg-white/[0.05]';
}

export function legalReadinessIcon(item: LegalCaseReadinessItem) {
  if (item.status === 'done') return <CheckCircle size={12} />;
  return <AlertTriangle size={12} />;
}
