import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

describe('client surface navigation rendering', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'components', 'DesktopUI.tsx'), 'utf8');

  it('closes fullscreen command center before presenting an independent workspace', () => {
    expect(source).toContain("if (windowId !== 'command-center')");
    expect(source).toContain('setChatOpen(false)');
  });

  it('marks ordinary OS windows and waits for the exact target to render', () => {
    expect(source).toContain('data-lumi-rendered-surface={isMinimized ? undefined : id}');
    expect(source).toContain('await waitForClientSurfaceRendered(registeredSurface.target)');
    expect(source).toContain('did not render visibly');
  });
});
