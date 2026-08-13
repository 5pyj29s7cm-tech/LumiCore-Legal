import { Router } from 'express';
import { optionalAuth, resolveDomain } from '../middleware/auth';
import {
  getIndustryWorkflowTask,
  listCurrentIndustryWorkflowContracts,
  listIndustryWorkflowTasks,
  recordIndustryWorkflowExecution,
  startIndustryWorkflow,
} from '../industry/workflow_service';

function scope(req: any) {
  const userId = req.user?.uid || 'anonymous';
  const resolved = req.user ? resolveDomain(req.user) : { domain: 'personal' as const, orgId: '' };
  return { userId, domain: resolved.domain, orgId: resolved.orgId };
}

export function mountIndustryWorkflowRoutes(router: Router) {
  const asyncHandler = (handler: (req: any, res: any) => Promise<any> | any) => (
    req: any,
    res: any,
    next: any,
  ) => Promise.resolve(handler(req, res)).catch(next);

  router.get('/industry/workflows/contracts', optionalAuth, (_req, res) => {
    res.json({ contracts: listCurrentIndustryWorkflowContracts() });
  });

  router.get('/industry/workflows', optionalAuth, (req, res) => {
    res.json({ tasks: listIndustryWorkflowTasks(scope(req), Number(req.query?.limit) || 50) });
  });

  router.get('/industry/workflows/:taskId', optionalAuth, (req, res) => {
    const task = getIndustryWorkflowTask(scope(req), String(req.params.taskId || ''));
    if (!task) return res.status(404).json({ error: 'Industry workflow task not found' });
    return res.json({ task });
  });

  router.post('/industry/workflows', optionalAuth, asyncHandler((req, res) => {
    const entryId = String(req.body?.entryId || '').trim();
    if (!entryId) return res.status(400).json({ error: 'entryId is required' });
    const result = startIndustryWorkflow({
      ...scope(req),
      entryId,
      sourceInput: String(req.body?.sourceInput || ''),
      source: String(req.body?.source || 'industry_client'),
      context: req.body?.context && typeof req.body.context === 'object' ? req.body.context : undefined,
    });
    return res.status(201).json(result);
  }));

  router.post('/industry/workflows/:taskId/verify', optionalAuth, asyncHandler((req, res) => {
    const result = recordIndustryWorkflowExecution({
      ...scope(req),
      taskId: String(req.params.taskId || ''),
      resultText: String(req.body?.resultText || ''),
      filePaths: Array.isArray(req.body?.filePaths) ? req.body.filePaths.map(String) : [],
      source: String(req.body?.source || 'industry_client'),
      // Browser callers cannot manufacture tool receipts. Real receipts are
      // accepted only through server-owned execution integration.
      toolRecords: [],
    });
    return res.json(result);
  }));
}
