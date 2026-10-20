import { useApp } from "../../contexts/AppContext";
import { useLegalDocumentScope } from "../../hooks/useLegalDocument";
import { LegalHubScope } from './legal_hub/scope';
import type { LegalView } from './legal_hub/contracts';
export type { LegalView } from './legal_hub/contracts';



export function LegalHub({ initialView, workspaceResetKey }: { initialView?: LegalView; workspaceResetKey?: number } = {}) {
  const scopeKey = useLegalDocumentScope();
  const { workDomain, orgConnection } = useApp();
  return <LegalHubScope key={`${scopeKey}:${workDomain === 'work' && Boolean(orgConnection?.connected)}`} initialView={initialView} workspaceResetKey={workspaceResetKey} />;
}
