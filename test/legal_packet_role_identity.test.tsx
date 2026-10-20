// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LegalPacketView } from '../src/components/org/legal_hub/packet';
const fixture = vi.hoisted(() => ({ tool: vi.fn(), user: 'packet-owner', domain: 'personal', org: '' }));
vi.mock('../src/contexts/AppContext', () => ({ useApp: () => ({ user: { uid: fixture.user }, workDomain: fixture.domain, orgConnection: { connected: true, orgId: fixture.org } }) }));
vi.mock('../src/lib/legalToolClient', () => ({ runLegalTool: fixture.tool }));
vi.mock('../src/lib/useT', () => ({ useT: () => ({ langCode: 'en' }) }));
vi.mock('../src/i18n/uiMessages', () => ({ uiMessage: (key: string) => key.split('.')[1], formatUiMessage: (key: string) => key.split('.')[1] }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
const file = (clientRole?: string, id = 'case-a') => ({ id, title: id, clientRole, party: '原告虚构甲/被告虚构乙', notes: '仅为虚构原始材料，身份必须明确。', materials: [], workflowRuns: [], createdAt: '', updatedAt: '' } as any);
const roleSelect = () => screen.getByRole('combobox') as HTMLSelectElement;
const generate = () => screen.getByRole('button', { name: 'generate-packet' }) as HTMLButtonElement;
beforeEach(() => { fixture.user = 'packet-owner'; fixture.domain = 'personal'; fixture.org = ''; fixture.tool.mockReset().mockResolvedValue('CURRENT_PACKET_RESULT'); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it.each([
  ['原告', 'plaintiff'], ['被告', 'defendant'], ['申请人', 'applicant'], ['被申请人', 'respondent'],
  ['plaintiff', 'plaintiff'], ['defendant', 'defendant'], ['applicant', 'applicant'], ['respondent', 'respondent'],
])('initializes and submits the explicitly saved clientRole %s as %s without changing the case', async (saved, expected) => {
  const caseFile = file(saved), before = JSON.stringify(caseFile); render(<LegalPacketView caseFile={caseFile}/>);
  expect(roleSelect().value).toBe(expected); fireEvent.click(generate()); await screen.findByText('CURRENT_PACKET_RESULT');
  expect(fixture.tool).toHaveBeenCalledWith('legal_generate_litigation_packet', expect.objectContaining({ caseId: 'case-a', role: expected }), expect.any(AbortSignal)); expect(JSON.stringify(caseFile)).toBe(before);
});
it.each([undefined, '', '委托人', '原告/被告待定', 'constructor', '__proto__'])('does not infer an unspecified role %s from party names or permit generation before selection', async saved => {
  render(<LegalPacketView caseFile={file(saved)}/>); expect(roleSelect().value).toBe(''); expect(generate().disabled).toBe(true); fireEvent.click(generate()); expect(fixture.tool).not.toHaveBeenCalled();
  fireEvent.change(roleSelect(), { target: { value: 'defendant' } }); expect(generate().disabled).toBe(false); fireEvent.click(generate()); await screen.findByText('CURRENT_PACKET_RESULT'); expect(fixture.tool.mock.calls[0][1].role).toBe('defendant');
});
it('keeps a deliberate role/facts edit on same-case metadata refresh without writing clientRole back to the case', async () => {
  const caseFile = file('被告'), before = JSON.stringify(caseFile); const view = render(<LegalPacketView caseFile={caseFile}/>);
  fireEvent.change(roleSelect(), { target: { value: 'respondent' } }); fireEvent.change(screen.getByLabelText('facts-timeline-parties'), { target: { value: 'CURRENT_USER_EDIT' } });
  view.rerender(<LegalPacketView caseFile={{ ...caseFile, clientRole: '原告', title: 'Refreshed title', materials: [{ id: 'fresh', source: 'manual', content: 'NEW_SOURCE' }] }}/>);
  expect(roleSelect().value).toBe('respondent'); expect((screen.getByLabelText('facts-timeline-parties') as HTMLTextAreaElement).value).toBe('CURRENT_USER_EDIT');
  fireEvent.click(generate()); await screen.findByText('CURRENT_PACKET_RESULT'); expect(fixture.tool.mock.calls[0][1].role).toBe('respondent'); expect(JSON.stringify(caseFile)).toBe(before);
});
it.each(['case', 'domain', 'actor', 'organization'] as const)('resets the form identity and aborts late output on %s changes', async change => {
  let finish!: (text: string) => void; fixture.tool.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const caseFile = file('被告'); const view = render(<LegalPacketView caseFile={caseFile} orgId={undefined}/>); fireEvent.change(roleSelect(), { target: { value: 'respondent' } }); fireEvent.click(generate());
  await waitFor(() => expect(fixture.tool).toHaveBeenCalledTimes(1)); const signal = fixture.tool.mock.calls[0][2] as AbortSignal;
  if (change === 'domain') fixture.domain = 'work'; if (change === 'actor') fixture.user = 'other-owner'; if (change === 'organization') fixture.org = 'org-b';
  const next = change === 'case' ? file('申请人', 'case-b') : file(undefined); view.rerender(<LegalPacketView caseFile={next} orgId={change === 'organization' ? 'org-b' : undefined}/>);
  expect(signal.aborted).toBe(true); expect(roleSelect().value).toBe(change === 'case' ? 'applicant' : ''); expect(screen.queryByText('CURRENT_PACKET_RESULT')).toBeNull();
  await act(async () => finish('LATE_OLD_ROLE_RESULT')); expect(screen.queryByText('LATE_OLD_ROLE_RESULT')).toBeNull();
  if (change !== 'case') expect(generate().disabled).toBe(true); expect(fixture.tool).toHaveBeenCalledTimes(1);
});
