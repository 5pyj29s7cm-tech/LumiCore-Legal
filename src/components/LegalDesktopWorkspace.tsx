import { LegalHub, type LegalView } from './org/LegalHub';
export function LegalDesktopWorkspace({ initialView }: { initialView: LegalView }) {
  return <LegalHub initialView={initialView} />;
}
