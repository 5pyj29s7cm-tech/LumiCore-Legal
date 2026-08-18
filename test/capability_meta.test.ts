import { describe, expect, it } from 'vitest';
import {
  buildCapabilityMetaResponse,
  isCapabilityMetaQuestion,
} from '../server/cognition/capability_meta';
import { PRODUCT_VARIANT } from '../shared/product_variant';

describe('capability access explanations', () => {
  it.each([
    '\u4f60\u73b0\u5728\u4e0d\u662f\u52a9\u624b\u6a21\u5f0f\u5417',
    '\u90a3\u8981\u600e\u4e48\u624d\u80fd\u8ba9\u4f60\u4f7f\u7528\u5176\u5b83\u5de5\u5177',
    '\u5f53\u524d\u4f1a\u8bdd\u662f\u4e0d\u662f\u53ea\u6302\u8f7d\u4e86\u4e24\u4e2a\u5de5\u5177',
    'How can I make Lumi use other tools?',
  ])('recognizes a conceptual question without treating it as work: %s', (text) => {
    expect(isCapabilityMetaQuestion(text)).toBe(true);
  });

  it.each([
    '\u67e5\u4e00\u4e0b\u8bb0\u5fc6\u5e93\u91cc\u6709\u6ca1\u6709\u5f20\u52c7\u7684\u4fe1\u606f',
    '\u7528\u8bb0\u5fc6\u68c0\u7d22\u5de5\u5177\u67e5\u4e00\u4e0b\u9879\u76ee\u8bb0\u5f55',
    '\u4e3a\u4ec0\u4e48\u521a\u624d\u6ca1\u6709\u8c03\u7528\u8bb0\u5fc6\u5de5\u5177',
  ])('does not consume real actions or prior-turn corrections: %s', (text) => {
    expect(isCapabilityMetaQuestion(text)).toBe(false);
  });

  it('does not let a trailing capability-report request steal a concrete legal action', () => {
    const text = '律师版实机验收·合同审查：请审查下面这段模拟买卖合同条款，只依据原文输出风险点和修改建议。完成后告诉我实际使用了什么能力、结果是否已验证。';
    expect(isCapabilityMetaQuestion(text)).toBe(false);
    expect(buildCapabilityMetaResponse({ text, operationMode: 'assistant', source: 'command-center-chat' })).toBeNull();
  });

  it('does not treat a contextual delivery verification command as a capability question', () => {
    const text = '律师版实机验收·交付核验：针对四号案件ID d2789373-effc-404c-aff6-25f101267790，对案件工作台中已归档的“诉前应对策略律师复核草稿”执行交付核验。输出总体是否可正式交付、实际使用能力和任务回执状态。';
    expect(isCapabilityMetaQuestion(text)).toBe(false);
  });

  it('explains the integrated command-center entry and per-turn routing truth', () => {
    const response = buildCapabilityMetaResponse({
      text: '\u90a3\u8981\u600e\u4e48\u624d\u80fd\u8ba9\u4f60\u4f7f\u7528\u5176\u5b83\u5de5\u5177',
      operationMode: 'assistant',
      source: 'command-center-chat',
    });

    expect(response).toContain('\u5df2\u7ecf\u662f\u52a9\u624b\u6a21\u5f0f');
    expect(response).toContain('\u552f\u4e00\u7684\u6587\u5b57\u5165\u53e3');
    expect(response).toContain('\u6bcf\u8f6e\u53ea\u9009\u51fa');
    expect(response).toContain('\u8def\u7531\u95ee\u9898');
    expect(response).not.toContain('\u53bb\u6307\u6325\u4e2d\u5fc3');
  });

  it('answers edition identity and professional-review boundaries without treating the question as work', () => {
    const text = '\u4f60\u662f\u8c01\uff1f\u8fd9\u662f\u54ea\u4e2a\u5b9a\u5236\u7248\uff1f\u4f60\u80fd\u5e2e\u5f8b\u5e08\u5b8c\u6210\u54ea\u4e9b\u5de5\u4f5c\uff0c\u54ea\u4e9b\u7ed3\u679c\u5fc5\u987b\u7531\u6267\u4e1a\u5f8b\u5e08\u590d\u6838\uff1f\u8bf7\u7528\u81ea\u7136\u5bf9\u8bdd\u56de\u7b54\uff0c\u4e0d\u8981\u6267\u884c\u5de5\u5177\u3002';
    expect(isCapabilityMetaQuestion(text)).toBe(true);

    const response = buildCapabilityMetaResponse({
      text,
      operationMode: 'assistant',
      source: 'command-center-chat',
    });

    expect(response).toContain(PRODUCT_VARIANT.displayName);
    expect(response).toContain('\u4efb\u52a1\u8d26\u672c');
    expect(response).toContain('\u5fc5\u987b\u7531\u5bf9\u5e94\u4e13\u4e1a\u4eba\u5458\u590d\u6838');
    expect(response).toContain('\u4e0d\u4f1a\u8865\u9020\u4e8b\u5b9e');
    expect(response).not.toContain('\u6ca1\u6709\u6210\u529f\u6267\u884c\u4efb\u4f55\u5de5\u5177');
  });
});
