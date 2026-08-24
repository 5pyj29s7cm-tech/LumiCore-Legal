import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { makeApp, JWT_SECRET } from './helpers';
import { mountChatRoutes, resolveRestDesktopExecutionBoundary } from '../server/routes/chat_routes';
import { ToolRegistry, toolRegistry } from '../server/tools/registry';
import { addMember, createOrg } from '../server/org/db';
import { startIndustryWorkflow } from '../server/industry/workflow_service';
import { DESKTOP_SESSION_HEADER, issueDesktopSessionProof } from '../server/config/desktop_bootstrap';
import { registerLegalTools } from '../server/regions/packs/cn/legal_tools';
import { getDataDirectory } from '../server/config/data_path';

let url: string;
let cleanup: () => void;
const userToken = jwt.sign({ uid: 'legal-user', username: 'legal-user', role: 'user' }, JWT_SECRET);
const viewerId = `legal-viewer-${Date.now()}`;
const memberId = `legal-member-${Date.now()}`;
let orgId = '';
let viewerToken = '';
let memberToken = '';
const registeredStubTools: string[] = [];
const observedCalls: Array<{
  name: string;
  args: Record<string, any>;
  context: Record<string, any>;
}> = [];

function registerLegalStub(name: string): void {
  const registered = toolRegistry.register({
    name,
    description: `Security-test stub for ${name}`,
    parameters: { type: 'object', properties: {} },
    permission: 'user',
    securityLevel: 'safe',
    capability: {
      operation: name === 'legal_case_workspace' ? 'mutate' : 'observe',
      risk: name === 'legal_case_workspace' ? 'medium' : 'none',
      sideEffects: name === 'legal_case_workspace'
        ? [{ type: 'local_state_change', scope: 'security-test stub', reversible: true }]
        : [],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: [],
        successSignals: ['non-empty test receipt'],
        limitations: [],
      },
    },
    handler: async (args, context) => {
      observedCalls.push({ name, args, context: { ...(context as any) } });
      return `${name}:ok`;
    },
  });
  if (!registered) throw new Error(`Expected ${name} to be unregistered in the isolated test process`);
  registeredStubTools.push(name);
}

function bearer(token: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

function desktopBearer(token: string, userId: string): Record<string, string> {
  return {
    ...bearer(token),
    [DESKTOP_SESSION_HEADER]: issueDesktopSessionProof(userId).proof,
  };
}

describe('direct legal tool route security', () => {
  beforeAll(async () => {
    const app = await makeApp();
    url = app.url;
    cleanup = app.cleanup;
    const unavailable = () => null;
    mountChatRoutes(app.apiRouter, JWT_SECRET, {
      getDeepSeek: unavailable,
      getGemini: unavailable,
      getOpenAI: unavailable,
      getAnthropic: unavailable,
      getQwen: unavailable,
    });

    const org = createOrg('Legal route authorization', `legal-route-${Date.now()}`, 'legal-route-owner');
    orgId = org.id;
    addMember(orgId, viewerId, 'viewer');
    addMember(orgId, memberId, 'member');
    viewerToken = jwt.sign({ uid: viewerId, username: viewerId, role: 'user', orgId }, JWT_SECRET);
    memberToken = jwt.sign({ uid: memberId, username: memberId, role: 'user', orgId }, JWT_SECRET);

    registerLegalStub('legal_authority_source_status');
    registerLegalStub('legal_case_workspace');
    registerLegalStub('legal_review_contract');
    const actualLegalTools = new ToolRegistry();
    registerLegalTools(actualLegalTools);
    const bidTool = actualLegalTools.get('legal_generate_bid');
    if (!bidTool || !toolRegistry.register(bidTool)) {
      throw new Error('Expected the actual legal_generate_bid tool to be available for route integration testing');
    }
    registeredStubTools.push('legal_generate_bid');
  });

  afterAll(() => {
    for (const name of registeredStubTools) toolRegistry.unregister(name);
    cleanup?.();
  });

  it('stops anonymous legal tool calls before argument defaults can enable persistence', async () => {
    const response = await fetch(`${url}/api/legal/tool/legal_case_workspace`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ caseName: 'must-not-persist' }),
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'Authentication required' });
  });

  it('requires authentication for the dedicated contract-review route', async () => {
    const response = await fetch(`${url}/api/legal/contract-review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contract: 'anonymous contract' }),
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'Authentication required' });
  });

  it('rejects an authenticated case write without a native desktop proof', async () => {
    const callCount = observedCalls.length;
    const response = await fetch(`${url}/api/legal/tool/legal_case_workspace`, {
      method: 'POST',
      headers: bearer(userToken),
      body: JSON.stringify({ caseName: 'missing-desktop-proof' }),
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'DESKTOP_SESSION_PROOF_REQUIRED' });
    expect(observedCalls).toHaveLength(callCount);
  });

  it('allows a signed local personal user and passes the trusted boundary to the tool', async () => {
    const response = await fetch(`${url}/api/legal/tool/legal_case_workspace`, {
      method: 'POST',
      headers: desktopBearer(userToken, 'legal-user'),
      body: JSON.stringify({ caseName: 'authenticated-probe' }),
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ text: 'legal_case_workspace:ok' });
    expect(observedCalls.at(-1)).toMatchObject({
      name: 'legal_case_workspace',
      args: {
        userId: 'legal-user',
        domain: 'personal',
        orgId: 'personal:legal-user',
        persistCase: true,
      },
      context: {
        userId: 'legal-user',
        domain: 'personal',
        orgId: '',
        authenticated: true,
        authRole: 'user',
        localExecution: true,
        executionBoundary: 'trusted_local',
      },
    });
  });

  it('lets the signed desktop route write a real bid DOCX inside its scoped delivery root', async () => {
    const legalDeliveryRoot = getDataDirectory(path.join('legal_delivery', 'personal_legal-user'));
    const outputDir = path.join(legalDeliveryRoot, `route-bid-${Date.now()}`);
    try {
      const response = await fetch(`${url}/api/legal/tool/legal_generate_bid`, {
        method: 'POST',
        headers: desktopBearer(userToken, 'legal-user'),
        body: JSON.stringify({
          args: {
            projectName: 'Signed Desktop Bid',
            requirements: 'Create a local review draft and keep submission pending.',
            outputDir,
            persistCase: false,
            useModel: false,
          },
        }),
        signal: AbortSignal.timeout(10000),
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.receipt).toMatchObject({ ok: true, status: 'generated' });
      expect(body.artifacts).toHaveLength(1);
      expect(path.relative(legalDeliveryRoot, body.artifacts[0])).not.toMatch(/^\.\.(?:[\\/]|$)/);
      expect(fs.statSync(body.artifacts[0]).size).toBeGreaterThan(256);
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('fails closed for an empty or UID-mismatched desktop proof', async () => {
    for (const proof of ['', issueDesktopSessionProof('another-legal-user').proof]) {
      const callCount = observedCalls.length;
      const response = await fetch(`${url}/api/legal/tool/legal_authority_source_status`, {
        method: 'POST',
        headers: { ...bearer(userToken), [DESKTOP_SESSION_HEADER]: proof },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(5000),
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'DESKTOP_SESSION_PROOF_REQUIRED' });
      expect(observedCalls).toHaveLength(callCount);
    }
  });

  it('does not trust an otherwise valid proof from a non-loopback address', () => {
    const proof = issueDesktopSessionProof('legal-user').proof;
    expect(resolveRestDesktopExecutionBoundary({
      authenticated: true,
      userId: 'legal-user',
      remoteAddress: '203.0.113.42',
      proofHeaderPresent: true,
      presentedProof: proof,
    })).toEqual({
      trustedLocalExecution: false,
      executionBoundary: 'remote_restricted',
      rejectPresentedProof: true,
    });
  });

  it('allows an organization viewer to invoke an explicit read-only legal tool', async () => {
    const response = await fetch(`${url}/api/legal/tool/legal_authority_source_status`, {
      method: 'POST',
      headers: bearer(viewerToken),
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(200);
    expect(observedCalls.at(-1)).toMatchObject({
      name: 'legal_authority_source_status',
      args: { userId: viewerId, domain: 'work', orgId },
      context: {
        userId: viewerId,
        domain: 'work',
        orgId,
        authenticated: true,
        authRole: 'user',
        orgRole: 'viewer',
      },
    });
  });

  it('denies an organization viewer a case-writing legal tool before execution', async () => {
    const callCount = observedCalls.length;
    const response = await fetch(`${url}/api/legal/tool/legal_case_workspace`, {
      method: 'POST',
      headers: bearer(viewerToken),
      body: JSON.stringify({ caseName: 'viewer-must-not-write' }),
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: 'Organization viewers may only use read-only legal tools.',
    });
    expect(observedCalls).toHaveLength(callCount);
  });

  it('allows an organization viewer to review a contract without persistence', async () => {
    const response = await fetch(`${url}/api/legal/contract-review`, {
      method: 'POST',
      headers: bearer(viewerToken),
      body: JSON.stringify({ contract: 'read-only contract', persistCase: false }),
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ text: 'legal_review_contract:ok', degraded: false });
    expect(observedCalls.at(-1)).toMatchObject({
      name: 'legal_review_contract',
      args: { userId: viewerId, orgId, persistCase: false },
      context: {
        userId: viewerId,
        domain: 'work',
        orgId,
        authenticated: true,
        authRole: 'user',
        orgRole: 'viewer',
      },
    });
  });

  it('requires a signed local session only when contract review persists a case', async () => {
    const beforeCalls = observedCalls.length;
    const denied = await fetch(`${url}/api/legal/contract-review`, {
      method: 'POST',
      headers: bearer(userToken),
      body: JSON.stringify({ contract: 'persistent contract', caseName: 'signed local case' }),
      signal: AbortSignal.timeout(5000),
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: 'DESKTOP_SESSION_PROOF_REQUIRED' });
    expect(observedCalls).toHaveLength(beforeCalls);

    const allowed = await fetch(`${url}/api/legal/contract-review`, {
      method: 'POST',
      headers: desktopBearer(userToken, 'legal-user'),
      body: JSON.stringify({ contract: 'persistent contract', caseName: 'signed local case' }),
      signal: AbortSignal.timeout(5000),
    });
    expect(allowed.status).toBe(200);
    expect(observedCalls).toHaveLength(beforeCalls + 1);
    expect(observedCalls.at(-1)?.context).toMatchObject({
      localExecution: true,
      executionBoundary: 'trusted_local',
    });
  });

  it('records contract review against the supplied unified industry workflow task', async () => {
    const started = startIndustryWorkflow({
      userId: 'legal-user',
      domain: 'personal',
      orgId: '',
      entryId: 'contract-review',
      sourceInput: 'Review the scoped contract.',
      source: 'legal_contract_review_test',
    });
    const beforeCalls = observedCalls.length;
    const response = await fetch(`${url}/api/legal/tool/legal_review_contract`, {
      method: 'POST',
      headers: bearer(userToken),
      body: JSON.stringify({
        args: { contract: 'scoped contract', persistCase: false },
        industryWorkflowTaskId: started.task.id,
      }),
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.industryWorkflow).toMatchObject({ taskId: started.task.id });
    expect(body.industryWorkflow.verification).toEqual(expect.objectContaining({ passed: expect.any(Boolean) }));
    expect(observedCalls).toHaveLength(beforeCalls + 1);
    expect(observedCalls.at(-1)).toMatchObject({
      name: 'legal_review_contract',
      context: {
        taskId: started.conversationTaskId,
        requestId: started.requestId,
      },
    });
  });

  it('denies an organization viewer contract review that would persist a case', async () => {
    const callCount = observedCalls.length;
    const response = await fetch(`${url}/api/legal/contract-review`, {
      method: 'POST',
      headers: bearer(viewerToken),
      body: JSON.stringify({ contract: 'persistent contract', caseName: 'viewer case' }),
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: 'Organization viewers may only run contract review without case persistence.',
    });
    expect(observedCalls).toHaveLength(callCount);
  });

  it('keeps case-writing legal tools available to an organization member', async () => {
    const response = await fetch(`${url}/api/legal/tool/legal_case_workspace`, {
      method: 'POST',
      headers: desktopBearer(memberToken, memberId),
      body: JSON.stringify({ caseName: 'member case' }),
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(200);
    expect(observedCalls.at(-1)).toMatchObject({
      name: 'legal_case_workspace',
      context: { orgRole: 'member', authenticated: true, authRole: 'user' },
    });
  });
});
