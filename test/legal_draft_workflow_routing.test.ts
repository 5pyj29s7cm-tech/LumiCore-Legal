import { describe, expect, it } from 'vitest';
import { matchSkillWorkflow } from '../server/skills/workflow_registry';

describe('verified legal draft workflow routing', () => {
  it('routes a case-grounded review draft through the legal skill adapter', () => {
    const workflow = matchSkillWorkflow(
      '\u57fa\u4e8e\u521a\u521b\u5efa\u7684\u6848\u4ef6ID case_legal_001\uff0c\u53ea\u4f7f\u7528\u6848\u4ef6\u5de5\u4f5c\u53f0\u91cc\u5df2\u4fdd\u5b58\u7684\u4e8b\u5b9e\uff0c\u751f\u6210\u4e00\u4efd\u8bc9\u524d\u5e94\u5bf9\u7b56\u7565\u5f8b\u5e08\u590d\u6838\u8349\u7a3f\u3002',
    );
    expect(workflow?.id).toBe('verified_case_draft');
    expect(workflow?.requiredTools).toEqual([
      'legal_case_workflow_status',
      'legal_generate_argument_or_opinion',
    ]);
  });

  it('does not hijack formal external submission or ordinary legal questions', () => {
    expect(matchSkillWorkflow('\u5e2e\u6211\u628a\u8d77\u8bc9\u72b6\u63d0\u4ea4\u5230\u6cd5\u9662\u7f51\u7ad9')).toBeNull();
    expect(matchSkillWorkflow('\u8fd9\u4e2a\u6848\u4ef6\u5e94\u8be5\u600e\u4e48\u529e\uff1f')).toBeNull();
  });
});
