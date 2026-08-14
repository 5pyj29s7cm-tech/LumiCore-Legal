import { useEffect, useState } from 'react';
import { LegalHub, type LegalView } from './org/LegalHub';

export function LegalDesktopWorkspace({ initialView }: { initialView: LegalView }) {
  const [view, setView] = useState<LegalView>(initialView);
  const [workspaceResetKey, setWorkspaceResetKey] = useState(0);

  useEffect(() => {
    setView(initialView);
    if (initialView === 'workspace') setWorkspaceResetKey(value => value + 1);
  }, [initialView]);

  return (
    <LegalHub
      view={view}
      onViewChange={setView}
      workspaceResetKey={workspaceResetKey}
    />
  );
}
