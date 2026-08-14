import { describe, expect, it } from 'vitest';
import { extractCurrentAppTarget, requiresCurrentAppUiMutation } from '../server/cognition/action_contract';

describe('industry external application targets', () => {
  it.each([
    ['在酷家乐里面新建设计方案', '酷家乐'],
    ['在 SketchUp 里面修改当前模型', 'SketchUp'],
    ['在千牛里面修改商品草稿', '千牛'],
    ['在金蝶里面新建凭证草稿', '金蝶'],
    ['inside the current Photoshop app edit the open draft', 'Photoshop'],
  ])('recognizes %s without guessing another application', (command, target) => {
    expect(requiresCurrentAppUiMutation(command)).toBe(true);
    expect(extractCurrentAppTarget(command)).toBe(target);
  });
});

