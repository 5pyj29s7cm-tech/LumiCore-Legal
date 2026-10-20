import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import { collectChatArtifacts } from '../server/conversation/chat_artifacts';
import { isArtifactProducerRecord } from '../server/tools/artifact_evidence';
import { resolveGeneratedDownloadPath } from '../server/files/knowledge/paths';
import { archiveGeneratedOutputs, listGeneratedArchive } from '../server/files/generated_archive';
import { ToolRegistry } from '../server/tools/registry';
import { executeToolCall } from '../server/tools/execution_engine';
import { startIsolatedConversation, addMessage } from '../server/conversation/manager';
import { initDatabase, readDB, writeDB } from '../db_layer';
import type { ToolExecutionRecord } from '../server/tools/types';

const owner = 'collection-fixture-owner';
const root = process.env.LUMI_DATA_DIR!;
const directory = path.join(root, 'Documents', 'declared-output-collection');
const files = Array.from({ length: 25 }, (_, index) => path.join(directory, String(index).padStart(2, '0') + (index % 2 ? '.docx' : '.md')));
const record = (artifacts: unknown[] = files.slice(0, 24)): ToolExecutionRecord => ({
  name: 'fixture_bundle_output', arguments: { writeFiles: true }, result: 'Synthetic work product body without file paths.',
  receipt: { ok: true, status: 'generated', artifacts },
  terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'Server verified this fixture receipt.' },
  capability: { capabilityId: 'industry.fixture.bundle', lane: 'industry', operation: 'create', risk: 'medium',
    sideEffects: [{ type: 'local_write', scope: 'fixture output files', reversible: true }],
    verification: { strategy: 'terminal_receipt', required: true, requiredFields: ['ok', 'status', 'artifacts'],
      requiredValues: { ok: true }, successStatuses: ['generated'], failureStatuses: ['blocked', 'failed', 'unverified'], successSignals: [], limitations: [] } },
});
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

beforeAll(async () => {
  await initDatabase();
  fs.mkdirSync(directory, { recursive: true });
  files.forEach((file, index) => fs.writeFileSync(file, 'Synthetic file body ' + index));
  const database = readDB();
  database.users.push({ uid: owner, role: 'admin', username: owner, password: 'fixture-only', balance: 0, createdAt: new Date().toISOString() } as any);
  writeDB(database);
});

it('projects all 24 standard declared output files without broadening completion producer classification', () => {
  const value = record();
  expect(value.capability!.verification.requiredArtifactCollections).toBeUndefined();
  expect(isArtifactProducerRecord(value)).toBe(false);
  const artifacts = collectChatArtifacts([value], 'fixture-conversation');
  expect(artifacts.map(item => item.path)).toEqual(files.slice(0, 24));
  expect(new URL(artifacts[0].url, 'http://fixture.invalid').searchParams.get('conversationId')).toBe('fixture-conversation');
  expect(value).toEqual(record());
});

it('uses producer metadata rather than a legal tool name or prose path', () => {
  const value = record([files[0]]); value.name = 'unrelated_domain_output';
  value.result = 'Do not use this prose path: C:/private/should-not-attach.md';
  expect(collectChatArtifacts([value]).map(item => item.path)).toEqual([files[0]]);
  value.capability!.verification.requiredFields = ['ok', 'status'];
  expect(collectChatArtifacts([value])).toEqual([]);
});

it('supports existing dot-separated requiredArtifactCollections with path objects', () => {
  const value = record([]); value.capability!.verification.requiredFields = ['ok'];
  value.capability!.verification.requiredArtifactCollections = ['delivery.outputs'];
  value.receipt = { ok: true, status: 'generated', delivery: { outputs: [{ path: files[0] }, files[1]] } };
  expect(collectChatArtifacts([value]).map(item => item.path)).toEqual(files.slice(0, 2));
});

it.each(['partial', 'failed', 'blocked', 'unknown_outcome', 'waiting_confirmation'])('does not turn a %s receipt into attachments or success', status => {
  const value = record([files[0]]); value.receipt = { ok: true, status, artifacts: [files[0]] };
  const before = clone(value);
  expect(collectChatArtifacts([value])).toEqual([]);
  expect(value).toEqual(before);
});

it('rejects unsuccessful, unverified and contradictory canonical outcomes', () => {
  for (const amend of [
    (value: ToolExecutionRecord) => { value.error = 'Write failed'; },
    (value: ToolExecutionRecord) => { (value as any).outcome = 'failure'; },
    (value: ToolExecutionRecord) => { value.terminalVerification!.status = 'unverified'; },
    (value: ToolExecutionRecord) => { value.receipt = { ok: false, status: 'generated', artifacts: [files[0]] }; },
    (value: ToolExecutionRecord) => { value.envelope = { status: 'unknown_outcome' } as any; },
  ]) { const value = record([files[0]]); amend(value); expect(collectChatArtifacts([value])).toEqual([]); }
});

it('does not attach input reads, undeclared arrays or outputs without declared local writes', () => {
  for (const amend of [
    (value: ToolExecutionRecord) => { value.capability!.operation = 'observe'; },
    (value: ToolExecutionRecord) => { value.capability!.sideEffects = [{ type: 'local_read', scope: 'input', reversible: true }]; },
    (value: ToolExecutionRecord) => { value.capability!.verification.requiredFields = ['ok']; },
    (value: ToolExecutionRecord) => { delete value.capability; },
  ]) { const value = record([files[0]]); amend(value); expect(collectChatArtifacts([value])).toEqual([]); }
});

it('requires every item in a declared collection to be an existing nonempty absolute file', () => {
  const empty = path.join(directory, 'empty.md'); fs.writeFileSync(empty, '');
  for (const invalid of ['relative.md', 'https://fixture.invalid/output.md', path.join(directory, 'absent.md'), empty, directory, { outputPath: files[0] }]) {
    expect(collectChatArtifacts([record([files[0], invalid])])).toEqual([]);
  }
});

it('keeps inline writeFiles=false and empty output collections artifact-free', () => {
  const value = record([]); value.arguments = { writeFiles: false }; const before = clone(value);
  expect(collectChatArtifacts([value])).toEqual([]); expect(value).toEqual(before);
  expect(value.receipt).toMatchObject({ ok: true, status: 'generated', artifacts: [] });
});

it('retains every verified declared output while deduplicating exact paths', () => {
  expect(collectChatArtifacts([record([...files, files[0]])]).map(item => item.path)).toEqual(files);
  expect(collectChatArtifacts([record([files[0]]), record([{ path: files[0] }])])).toHaveLength(1);
});

it('retains existing legacy single-output behavior', () => {
  const value: ToolExecutionRecord = { name: 'write_file', arguments: { path: files[0] }, result: 'Written',
    receipt: { success: true, path: files[0] }, terminalVerification: { status: 'verified', strategy: 'artifact', reason: 'Legacy fixture' } };
  expect(collectChatArtifacts([value]).map(item => item.path)).toEqual([files[0]]);
});

it('uses unchanged conversation ownership, organization and exact-path download guards for the new collection', () => {
  const conversationId = startIsolatedConversation(owner, 'lumi', 'personal', '').id;
  const value = record([files[0]]);
  addMessage({ userId: owner, agentId: 'lumi', conversationId, role: 'assistant', content: 'Prepared fixture.', toolCalls: [value] });
  const request = (uid = owner, id = conversationId, orgId = '') => ({ user: { uid, orgId }, query: { conversationId: id } }) as any;
  expect(resolveGeneratedDownloadPath(files[0], request())).toBe(fs.realpathSync.native(files[0]));
  expect(() => resolveGeneratedDownloadPath(files[0], request('different-owner'))).toThrow('verified output');
  expect(() => resolveGeneratedDownloadPath(files[0], request(owner, 'unrelated-conversation'))).toThrow('verified output');
  expect(() => resolveGeneratedDownloadPath(files[1], request())).toThrow('verified output');
  const database = readDB(); const conversation = database.conversations.find(item => item.id === conversationId)!;
  conversation.orgId = 'fixture-organization'; writeDB(database);
  expect(() => resolveGeneratedDownloadPath(files[0], request(owner, conversationId, 'other-organization'))).toThrow('verified output');
  expect(resolveGeneratedDownloadPath(files[0], request(owner, conversationId, 'fixture-organization'))).toBe(fs.realpathSync.native(files[0]));
});

it('keeps redirected-parent download protection for declared collection paths', () => {
  const target = path.join(root, 'private-fixture'); fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'secret.md'), 'Fixture secret');
  const link = path.join(root, 'collection-output-link'); fs.symlinkSync(target, link, 'junction');
  const source = path.join(link, 'secret.md'); const conversationId = startIsolatedConversation(owner, 'lumi', 'personal', '').id;
  addMessage({ userId: owner, agentId: 'lumi', conversationId, role: 'assistant', content: 'Fixture.', toolCalls: [record([source])] });
  expect(() => resolveGeneratedDownloadPath(source, { user: { uid: owner }, query: { conversationId } } as any)).toThrow('verified output');
});

it('archives a real registered producer before envelope finalization without upgrading task completion', async () => {
  const registry = new ToolRegistry(); const file = path.join(directory, 'registry-output.md');
  registry.register({ name: 'fixture_registered_output', description: 'Fixture bundle producer', permission: 'public', securityLevel: 'safe',
    parameters: { type: 'object', properties: {}, required: [] },
    capability: { id: 'industry.fixture.registered', family: 'fixture', lane: 'industry', operation: 'create', risk: 'low',
      sideEffects: [{ type: 'local_write', scope: 'fixture output', reversible: true }],
      verification: record().capability!.verification },
    handler: async () => { fs.writeFileSync(file, 'Registered fixture output'); return JSON.stringify({ ok: true, status: 'generated', artifacts: [file] }); },
  });
  const canonical = await executeToolCall({ registry, name: 'fixture_registered_output', arguments: {},
    context: { userId: owner, domain: 'personal', source: 'desktop-chat', requestId: 'fixture-request', taskId: 'fixture-task',
      conversationId: 'fixture-archive-conversation', allowLocalFileWrites: true, authenticated: true, localExecution: true, authRole: 'admin' } });
  expect(canonical.error).toBeUndefined(); expect(canonical.terminalVerification?.status).toBe('verified');
  expect(canonical.envelope?.status).toBe('verified_success');
  expect(collectChatArtifacts([canonical]).map(item => item.path)).toEqual([file]);
  const entries = await listGeneratedArchive({ userId: owner, domain: 'personal' });
  expect(entries.some(entry => entry.sourcePath === file && entry.sourceRequestId === 'fixture-request' && entry.sourceTaskId === 'fixture-task')).toBe(true);
  expect(isArtifactProducerRecord(canonical)).toBe(false);
  const noEnvelope = clone(record([files[2]])); expect(noEnvelope.envelope).toBeUndefined();
  expect(await archiveGeneratedOutputs([noEnvelope], { userId: owner, domain: 'personal', source: 'desktop-chat' })).toHaveLength(1);
});
