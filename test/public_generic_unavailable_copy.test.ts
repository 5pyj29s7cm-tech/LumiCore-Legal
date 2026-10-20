import { describe, expect, it, vi } from 'vitest';
import { sanitizeUserFacingExecutionOutput } from '../server/cognition/user_output_protection';
vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No network or model call permitted'); }));
describe('public unavailable result copy',()=>{
 it('states only that a confirmable result was not delivered after suppressing unsafe internal payload',()=>{
  const hidden='internal-fixture-only-314';
  const text=sanitizeUserFacingExecutionOutput(JSON.stringify({terminalVerification:{status:'verified'},requestId:hidden}),{task:'请给出合同结果'});
  expect(text).toBe('这次未能给出可确认的结果。');
  expect(text).not.toContain(hidden);
  expect(text).not.toMatch(/已获取执行结果|原始系统数据|我会只汇报|重试|重新|请先/);
 });
});
