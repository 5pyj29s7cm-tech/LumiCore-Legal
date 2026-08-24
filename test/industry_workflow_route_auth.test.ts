import './helpers';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mountIndustryWorkflowRoutes } from '../server/routes/industry_workflow_routes';
import { JWT_SECRET, makeApp } from './helpers';

describe('legal industry workflow route authentication', () => {
  let baseUrl = '';
  let cleanup = () => {};
  const ownerId = `legal_route_owner_${Date.now()}`;
  const otherId = `${ownerId}_other`;
  const ownerToken = jwt.sign({ uid: ownerId, username: ownerId, role: 'user' }, JWT_SECRET);
  const otherToken = jwt.sign({ uid: otherId, username: otherId, role: 'user' }, JWT_SECRET);
  const branchToken = jwt.sign({
    uid: ownerId,
    username: ownerId,
    role: 'user',
    tokenType: 'organization_branch',
    orgId: 'untrusted-branch-org',
    branchId: 'untrusted-branch',
  }, JWT_SECRET);
  const jsonHeaders = (token: string) => ({
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  });

  beforeAll(async () => {
    const app = await makeApp();
    baseUrl = app.url;
    cleanup = app.cleanup;
    mountIndustryWorkflowRoutes(app.apiRouter);
  });

  afterAll(() => cleanup());

  it('keeps contracts public while rejecting anonymous, invalid, and branch state access', async () => {
    expect((await fetch(`${baseUrl}/api/industry/workflows/contracts`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/industry/workflows`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/industry/workflows/missing`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/industry/workflows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entryId: 'workspace' }),
    })).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/industry/workflows/missing/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resultText: 'must not be accepted' }),
    })).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/industry/workflows`, {
      headers: { Authorization: 'Bearer invalid-or-expired-token' },
    })).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/industry/workflows`, {
      headers: { Authorization: `Bearer ${branchToken}` },
    })).status).toBe(403);
  });

  it('isolates legal workflow tasks from cross-user reads and verification writes', async () => {
    const created = await fetch(`${baseUrl}/api/industry/workflows`, {
      method: 'POST',
      headers: jsonHeaders(ownerToken),
      body: JSON.stringify({
        entryId: 'workspace',
        sourceInput: 'Authenticated legal matter scope.',
        source: 'route_auth_test',
      }),
    });
    expect(created.status).toBe(201);
    const taskId = String((await created.json() as any).task.id);

    const ownerList = await fetch(`${baseUrl}/api/industry/workflows`, { headers: jsonHeaders(ownerToken) });
    expect(ownerList.status).toBe(200);
    expect((await ownerList.json() as any).tasks.map((task: any) => task.id)).toContain(taskId);
    expect((await fetch(`${baseUrl}/api/industry/workflows/${encodeURIComponent(taskId)}`, {
      headers: jsonHeaders(ownerToken),
    })).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/industry/workflows/${encodeURIComponent(taskId)}`, {
      headers: jsonHeaders(otherToken),
    })).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/industry/workflows/${encodeURIComponent(taskId)}/verify`, {
      method: 'POST',
      headers: jsonHeaders(otherToken),
      body: JSON.stringify({ resultText: 'cross-user mutation must not be accepted' }),
    })).status).toBe(404);
  });
});
