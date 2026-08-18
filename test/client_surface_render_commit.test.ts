import { describe, expect, it } from 'vitest';
import {
  getRenderedClientSurfaceSelector,
  isClientSurfaceRendered,
  waitForClientSurfaceRendered,
} from '../src/lib/clientSurfaceCommit';

describe('visible client surface commit', () => {
  it('only accepts an exact rendered surface marker', () => {
    const selectors: string[] = [];
    const root = {
      querySelector(selector: string) {
        selectors.push(selector);
        return selector === '[data-lumi-rendered-surface="command-center"]' ? {} as Element : null;
      },
    };

    expect(getRenderedClientSurfaceSelector('command-center')).toBe('[data-lumi-rendered-surface="command-center"]');
    expect(isClientSurfaceRendered('command-center', root)).toBe(true);
    expect(isClientSurfaceRendered('chat', root)).toBe(false);
    expect(selectors).toEqual([
      '[data-lumi-rendered-surface="command-center"]',
      '[data-lumi-rendered-surface="chat"]',
    ]);
  });

  it('waits for the React surface commit instead of acknowledging desired state', async () => {
    let ticks = 0;
    let rendered = false;
    const root = {
      querySelector() {
        return rendered ? {} as Element : null;
      },
    };

    const result = await waitForClientSurfaceRendered('command-center', {
      root,
      timeoutMs: 500,
      now: () => ticks * 16,
      schedule: callback => {
        ticks += 1;
        if (ticks === 2) rendered = true;
        callback();
      },
    });

    expect(result).toBe(true);
    expect(ticks).toBe(2);
  });

  it('returns false when no visible surface commits before the timeout', async () => {
    let now = 0;
    const result = await waitForClientSurfaceRendered('command-center', {
      root: { querySelector: () => null },
      timeoutMs: 50,
      now: () => now,
      schedule: callback => {
        now += 25;
        callback();
      },
    });

    expect(result).toBe(false);
  });
});
