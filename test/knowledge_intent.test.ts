import { describe, expect, it } from 'vitest';
import { isReadOnlyKnowledgeBaseInspectionRequest } from '../server/cognition/knowledge_intent';
import { isKnowledgeInventoryRequest } from '../server/cognition/knowledge_result';
import { routeToolsForTurn } from '../server/cognition/tool_router';
import { buildActionContract } from '../server/cognition/action_contract';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';

const contentQueries = [
  '这是虚构材料的知识库运用验收。请只依据个人知识库中的《青檀采购合同》，告诉我合同总价、收到预付款后的交货期限和设备质保期限，注明来源文件名。没有原文依据就明确说未检索到，禁止猜测。',
  '根据知识库里的采购合同，合同总价多少？注明来源文件名。',
  '请总结知识库中的裁判文书内容。',
  '知识库文件的吸收和运用，可行吗？',
  '知识库里这份合同的状态如何，分析逾期付款风险。',
  'What price is stated in the knowledge base document? Cite the source filename.',
];

describe('knowledge inventory remains distinct from source questions', () => {
  it.each(contentQueries)('does not hard-route a source question to inventory: %s', text => {
    expect(isReadOnlyKnowledgeBaseInspectionRequest(text)).toBe(false);
    expect(isKnowledgeInventoryRequest(text)).toBe(false);
    const declarations = ['knowledge_file_stats', 'knowledge_coverage_report', 'read_file', 'search_files', 'extract_document_text']
      .map(name => ({ type: 'function' as const, function: { name, description: name, parameters: { type: 'object', properties: {} } } }));
    const route = routeToolsForTurn(text, declarations, { enableMcpHealthGate: false });
    expect(route.hardAllowlist && route.toolNames.every(name => ['knowledge_file_stats', 'knowledge_coverage_report'].includes(name))).not.toBe(true);
  });

  it.each([
    '查看一下知识库的文件',
    '查询知识库文件列表',
    '看一下现在知识库里有多少的文件内容。',
    '请检查当前个人知识库是否可用，报告文档数量、已索引数量和最近错误。只读取真实状态，不导入、不修改任何内容。',
    '检查知识库文件吸收状态和索引覆盖率',
    '知识库里还有哪些文件没完成索引？',
    'Show knowledge base files',
    'How many documents are in the knowledge base?',
    'Check knowledge base indexing status and recent errors.',
  ])('keeps a genuine inventory or indexing inspection grounded: %s', text => {
    expect(isReadOnlyKnowledgeBaseInspectionRequest(text)).toBe(true);
    expect(isKnowledgeInventoryRequest(text)).toBe(true);
  });

  it.each(['打开知识库页面', '删除知识库全部文件', '导入知识库文件', '知识库里的文件能发给我吗？'])(
    'does not use inventory receipts for another operation: %s', text => {
      expect(isReadOnlyKnowledgeBaseInspectionRequest(text)).toBe(false);
      expect(isKnowledgeInventoryRequest(text)).toBe(false);
    },
  );

  it.each([
    [contentQueries[0], '已核对《青檀采购合同》：合同总价735821元，交货期限17个自然日，质保43个月。来源：知识运用验收.txt。'],
    ['仍只依据《青檀采购合同》原文，这个合同约定的收款银行账号是什么？原文没有就直接说明未约定，不要推荐或查找其他来源。', '原文未约定收款银行账号。来源：《青檀采购合同》。'],
    ['请依据知识库中的采购合同告诉我交货期限，不要起草文书。', '合同已约定在收到预付款后的17个自然日内交货。'],
    ['What price is stated in the knowledge base document? Cite the source filename.', 'The contract price is 735821 yuan. Source: acceptance-contract.txt.'],
    ['根据知识库里已有的协议，付款期限是多少？', '协议已经约定付款期限为30日。'],
  ])('does not require an unrequested deliverable for a source answer: %s', (taskText, responseText) => {
    expect(buildActionContract(taskText).kind).toBe('none');
    const result = finalizeLumiResponse({ taskText, responseText, source: 'chat', toolRecords: [] });
    expect(result.blocked).toBe(false);
    expect(result.text).toBe(responseText);
  });

  it.each(['生成正式法律意见书', '起草一份采购合同', '直接给我一份正式版起诉状', '把办案会议整理成案件会议纪要', 'Draft a purchase contract'])('keeps real legal production evidence-gated: %s', taskText => {
    expect(buildActionContract(taskText).kind).toBe('legal_document');
    const result = finalizeLumiResponse({ taskText, responseText: '正式文书已生成完成，可以直接使用。', source: 'chat', toolRecords: [] });
    expect(result.blocked).toBe(true);
  });
});
