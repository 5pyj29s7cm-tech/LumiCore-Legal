import { describe, expect, it } from 'vitest';
import { getToolExecutionTimeoutMs } from '../server/tools/registry';

describe('tool execution timeouts', () => {
  it('allows visible web login enough time for the maximum manual handoff window', () => {
    expect(getToolExecutionTimeoutMs('web_login_run')).toBeGreaterThan(225_000);
    expect(getToolExecutionTimeoutMs('url_fetch_logged_in')).toBeGreaterThan(225_000);
  });

  it('lets model-based legal work products use the canonical reasoning deadline', () => {
    const reasoning = getToolExecutionTimeoutMs('legal_case_reasoning_matrix');
    expect(getToolExecutionTimeoutMs('legal_case_strategy')).toBe(reasoning);
    expect(getToolExecutionTimeoutMs('legal_generate_argument_or_opinion')).toBe(reasoning);
    expect(reasoning).toBeGreaterThan(90_000);
  });

  it('does not apply the generic 30-second ceiling to vision OCR tools', () => {
    expect(getToolExecutionTimeoutMs('ocr_image_file')).toBe(90_000);
    expect(getToolExecutionTimeoutMs('ocr_screen')).toBe(90_000);
  });
  it('keeps the bounded120s budget longer than the observed48min four-native-clip recovery', () => {
    const full = getToolExecutionTimeoutMs('generate_video', { duration: 120 });
    expect(full).toBeGreaterThan(48 * 60_000);
    expect(full).toBe(53 * 60_000);
    expect(getToolExecutionTimeoutMs('generate_video', { duration: 10000 })).toBe(full);
    expect(getToolExecutionTimeoutMs('generate_video', { duration: 30 })).toBe(17 * 60_000);
    expect(getToolExecutionTimeoutMs('generate_video', { duration: Number.NaN })).toBe(15 * 60_000);
  });

});
