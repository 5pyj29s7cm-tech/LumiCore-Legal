// @vitest-environment jsdom
import fs from 'node:fs';
import crypto from 'node:crypto';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LegalAssetTrace } from '../src/components/org/LegalAssetTrace';
import { chinaLegalCopy } from '../src/i18n/regions/cn/legal';
import { setLocale } from '../src/i18n/runtime';

vi.mock('../src/contexts/AppContext', () => ({ useApp: () => ({ workDomain: 'personal', orgConnection: null, user: { uid: 'direct-shareholder-owner' } }) }));

const company = '虚构独立股东查询公司';
const copy = chinaLegalCopy('zh').assetTraceWorkflow;
const workflowStorageKey = 'lumi_legal_asset_trace_workflow_v1';
const syntheticRows = [
  { 股东名称: '虚构第一股东', 持股比例: '16.3440%', 持股数: '59,205,999' },
  { 股东名称: '虚构第二股东', 持股比例: '0.0000%', 持股数: '0' },
];
const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

function sourceReply(subject = company, rows = syntheticRows) {
  const sourceText = JSON.stringify({ 企业名称: subject, 股东信息: rows });
  const text = '# ' + subject + ' 主体信息查询\n\n### 官方 MCP 原始回执（数据，尚待律师核验）\n- 来源：虚构授权来源\n- 工具：get_shareholder_info\n- 查询端点：https://example.invalid/company\n- 查询时间：2026-01-02T03:04:05.000Z\n\n' + sourceText;
  return {
    text, toolName: 'legal_company_database_lookup',
    receipt: {
      ok: true, status: 'observed', persisted: false, changedCaseIds: [], materialSources: [], articleIds: [], artifacts: [], content: text,
      sourceResults: [{ sourceName: '虚构授权来源', sourceTool: 'get_shareholder_info', sourceEndpoint: 'https://example.invalid/company', queriedAt: '2026-01-02T03:04:05.000Z', subject, queryType: 'shareholders', status: 'observed', sourceTextSha256: sha256(sourceText), sourceText }],
    },
    verification: { status: 'verified', strategy: 'terminal_receipt' }, caseUpdates: [], artifacts: [],
  };
}
type Reply = ReturnType<typeof sourceReply>;

/** Replay a complete saved response at the network boundary, never as component/storage state. */
function primaryReply(): Reply {
  const capture = process.env.LUMI_SHAREHOLDERS_UI_REPLAY_RESPONSE;
  if (!capture) return sourceReply();
  const recorded = JSON.parse(fs.readFileSync(capture, 'utf8'));
  const body = JSON.parse(JSON.stringify(recorded.body || recorded)) as Reply;
  const originals = body.text.split(/\r?\n/).flatMap(line => {
    try { const value = JSON.parse(line); return value && Array.isArray(value.股东信息) ? [line] : []; } catch { return []; }
  });
  expect(originals).toHaveLength(1);
  const sourceText = originals[0];
  const originalSource = JSON.parse(sourceText);
  const sources = body.receipt.sourceResults.filter(source => source.sourceTool === 'get_shareholder_info');
  expect(sources).toHaveLength(1);
  expect(sources[0].subject).toBe(originalSource.企业名称);
  expect(sources[0].sourceTextSha256).toBe(sha256(sourceText));
  // The current API contract adds the already returned original JSON, and changes no other field.
  sources[0].sourceText = sourceText;
  return body;
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function inputSubject(subject: string) {
  fireEvent.change(screen.getByPlaceholderText(copy.subjectPlaceholder), { target: { value: subject } });
}
function queryShareholders() {
  fireEvent.click(screen.getByRole('button', { name: /股东/ }));
}
function exactRequest(index = 0, subject = company) {
  const [url, init] = vi.mocked(fetch).mock.calls[index];
  expect(new URL(String(url), 'http://localhost').pathname).toBe('/api/legal/tool/legal_company_database_lookup');
  expect(init?.method).toBe('POST');
  expect(JSON.parse(String(init?.body)).args).toEqual({ name: subject, queryType: 'shareholders', sourceIds: ['qichacha'], persistCase: false, confirmedForKb: false });
}
async function checkTable(rows: typeof syntheticRows) {
  const table = await screen.findByRole('table');
  const renderedRows = within(table).getAllByRole('row').slice(1);
  expect(renderedRows).toHaveLength(rows.length);
  rows.forEach((row, index) => {
    const cells = within(renderedRows[index]);
    expect(cells.getByText(row.股东名称, { exact: true })).toBeTruthy();
    expect(cells.getByText(row.持股比例, { exact: true })).toBeTruthy();
    expect(cells.getByText(row.持股数, { exact: true })).toBeTruthy();
  });
  return table;
}
async function openOriginal(sourceText: string) {
  const control = screen.getByRole('button', { name: copy.directShareholders.original });
  fireEvent.click(control);
  expect(control.getAttribute('aria-expanded')).toBe('true');
  await waitFor(() => expect(document.querySelector('pre')?.textContent).toBe(sourceText));
}

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); setLocale('zh');
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected request outside the direct-shareholder test'));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('direct shareholder lookup through the normal asset-trace input', () => {
  it('uses one source-only POST and displays every supplied row and exact original values without starting the workflow', async () => {
    const body = primaryReply();
    const source = body.receipt.sourceResults[0];
    const original = JSON.parse(source.sourceText);
    const before = JSON.stringify(body);
    vi.mocked(fetch).mockResolvedValue(response(body));
    render(<LegalAssetTrace />);
    inputSubject(source.subject); queryShareholders();
    await checkTable(original.股东信息);
    expect(fetch).toHaveBeenCalledTimes(1); exactRequest(0, source.subject);
    await openOriginal(source.sourceText);
    expect(localStorage.getItem(workflowStorageKey)).toBeNull();
    expect(screen.queryByTestId('asset-trace-controls')).toBeNull();
    expect(JSON.stringify(body)).toBe(before);
    const observations = process.env.LUMI_SHAREHOLDERS_UI_OBSERVATIONS;
    if (observations) fs.writeFileSync(observations, JSON.stringify({
      kind: 'saved-source-network-boundary-component-replay', rows: original.股东信息.length, sourceTextSha256: sha256(source.sourceText), reportSha256: sha256(body.text), fullTableVerified: true, rawValuesVerified: true, fullOriginalVerified: true, componentFetchCalls: 1, liveApplicationRequests: 0, providerCalls: 0, nativeAccepted: false,
    }, null, 2) + '\n');
  });

  it('keeps a partial response visible and does not claim the source query completed', async () => {
    const partial = sourceReply();
    partial.text = '虚构股东来源只返回部分记录，请检查原文。'; partial.receipt.content = partial.text;
    partial.receipt.ok = false; partial.receipt.status = 'partial'; partial.verification.status = 'blocked';
    vi.mocked(fetch).mockResolvedValue(response(partial));
    render(<LegalAssetTrace />); inputSubject(company); queryShareholders();
    expect(await screen.findByText(partial.text, { exact: false })).toBeTruthy();
    expect(screen.getByText(copy.directShareholders.incomplete)).toBeTruthy();
    expect(screen.queryByText(copy.directShareholders.received)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1); exactRequest();
    expect(localStorage.getItem(workflowStorageKey)).toBeNull();
  });

  it('shows an actual rejected API error without retrying the POST or creating workflow progress', async () => {
    const error = '虚构股东服务当前不可用';
    vi.mocked(fetch).mockResolvedValue(response({ error }, 503));
    render(<LegalAssetTrace />); inputSubject(company); queryShareholders();
    expect((await screen.findByRole('alert')).textContent).toContain(error);
    expect(fetch).toHaveBeenCalledTimes(1); exactRequest();
    expect(localStorage.getItem(workflowStorageKey)).toBeNull();
  });

  it('clears the former subject rows and uses the changed subject for the next independent query', async () => {
    const nextSubject = '虚构另一股东查询公司';
    const nextRows = [{ 股东名称: '虚构另一公司股东', 持股比例: '2.5000%', 持股数: '1,005' }];
    vi.mocked(fetch).mockResolvedValueOnce(response(sourceReply())).mockResolvedValueOnce(response(sourceReply(nextSubject, nextRows)));
    render(<LegalAssetTrace />); inputSubject(company); queryShareholders(); await checkTable(syntheticRows);
    inputSubject(nextSubject);
    expect(screen.queryByText(syntheticRows[0].股东名称)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    queryShareholders(); await checkTable(nextRows);
    expect(screen.queryByText(syntheticRows[0].股东名称)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2); exactRequest(0, company); exactRequest(1, nextSubject);
    expect(localStorage.getItem(workflowStorageKey)).toBeNull();
  });

  it('aborts the independent request when its owning asset view unmounts', async () => {
    let finish!: (value: Response) => void;
    vi.mocked(fetch).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const view = render(<LegalAssetTrace />); inputSubject(company); queryShareholders();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const signal = vi.mocked(fetch).mock.calls[0][1]?.signal;
    expect(signal?.aborted).toBe(false);
    view.unmount(); expect(signal?.aborted).toBe(true);
    await act(async () => finish(response(sourceReply())));
    expect(fetch).toHaveBeenCalledTimes(1); exactRequest();
    expect(localStorage.getItem(workflowStorageKey)).toBeNull();
  });
});
