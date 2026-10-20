import './helpers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db_layer';
import { requiresCurrentAppUiMutation } from '../server/cognition/action_request';
import { hasExplicitNoMutationInstruction } from '../server/cognition/tool_intent';
import { buildLumiExecutionPipeline } from '../server/cognition/execution_pipeline';
import { ToolRegistry } from '../server/tools/registry';
import { registerAllTools } from '../server/tools/definitions';

// Exact fictional request captured before the routing fix; no model or cloud is invoked.
const fullPreparedText = "请通过程序现有视频生成功能，按下面完整参数制作约120秒的原创中文双人剧情对唱视频。这次只执行这一份四段计划一遍，收到这份计划的结果后结束生成步骤，后续歌曲核词和聊天气泡合成下一步再做。完整32句原词已经按顺序放在四个segment_prompts中，逐句原样唱出，保留末四句反转。使用已配置的官方API，保持保存的模型配置。请给出实际产物路径和原任务结果。\n\n{\n  \"officialOnly\": true,\n  \"model\": \"aliyun/wan3.0-video\",\n  \"size\": \"720x1280\",\n  \"duration\": 120,\n  \"prompt_extend\": false,\n  \"seed\": 1322026,\n  \"prompt\": \"一段中文原创双人剧情说唱对唱短剧，2D精致卡通、竖屏中景、固定温暖律所办公室。左侧男律师：短深棕发、细框眼镜、蓝色西装；右侧成年女客户：黑色齐肩发、红色外套。只出现这两名虚构成年人，保持造型。两人按给出的歌词轮流真实唱出有旋律的中文，非普通说话朗读；男声沉稳、女声明亮，唱词清晰，伴奏不盖过人声。四段音乐统一D大调、4/4拍、132BPM，轻快喜剧流行说唱，同一D-A-Bm-G和弦循环，以对应段歌词演唱。第1段建立场景，第2至3段继续，第4段自然收尾。无画面字幕、无屏幕文字、无水印外的额外标识；中文聊天气泡由程序后期生成。服装和角色稳定，不生成法院、监控录像、法条或额外情节。只唱当前段落给出的原句，不提前泄露后续剧情、不重唱前段或续唱后段。\",\n  \"segment_prompts\": [\n    \"这一段只唱下面8句，严格按序每句一次，唱完第8句只保留短器乐收尾，不再重复任何词句。男律师唱奇数句、女客户唱偶数句，不唱角色标记。每句约3.6秒，可自然延长末字但不得加字。\\n男律师唱：“请坐，今天想聊什么”\\n女客户唱：“想离婚，财产怎么分呢”\\n男律师唱：“房子存款先列清楚”\\n女客户唱：“我想先把心事说清楚”\\n男律师唱：“你眼里的火烧了半天”\\n女客户唱：“有人半夜还在聊着天”\\n男律师唱：“手机翻面还神神秘秘”\\n女客户唱：“那聊天记录藏得很严”\",\n    \"这一段只唱下面8句，严格按序每句一次，唱完第8句只保留短器乐收尾，不再重复任何词句。男律师唱奇数句、女客户唱偶数句，不唱角色标记。每句约3.6秒，可自然延长末字但不得加字。\\n男律师唱：“周末出门总说去加班”\\n女客户唱：“见面地点却在咖啡店”\\n男律师唱：“一句宝贝喊得那么甜”\\n女客户唱：“两张票根夹在口袋里面”\\n男律师唱：“先别拿猜测当成证据”\\n女客户唱：“可那个人我真的很熟悉”\\n男律师唱：“别急，时间人物慢慢理”\\n女客户唱：“我怕一开口你就生气”\",\n    \"这一段只唱下面8句，严格按序每句一次，唱完第8句只保留短器乐收尾，不再重复任何词句。男律师唱奇数句、女客户唱偶数句，不唱角色标记。每句约3.6秒，可自然延长末字但不得加字。\\n男律师唱：“财产清单一项一项记”\\n女客户唱：“房子和存款我都带齐”\\n男律师唱：“事实材料还得核对”\\n女客户唱：“有些细节我没写进去”\\n男律师唱：“我先听完，不急着站队”\\n女客户唱：“你别替谁先判错与对”\\n男律师唱：“那个人到底是谁约的”\\n女客户唱：“说来话长，是一场误会”\",\n    \"这一段只唱下面8句，严格按序每句一次，唱完第8句只保留短器乐收尾，不再重复任何词句。男律师唱奇数句、女客户唱偶数句，不唱角色标记。每句约3.6秒，可自然延长末字但不得加字。\\n男律师唱：“你丈夫看见那些聊天”\\n女客户唱：“他盯着屏幕一夜没眠”\\n男律师唱：“难怪你今天吞吞吐吐”\\n女客户唱：“因为他说，要我先坦白”\\n男律师唱：“等等，出轨的是哪一位”\\n女客户唱：“是我，是我瞒着他约会”\\n男律师唱：“你把主角藏到最后一页”\\n女客户唱：“所以我才先问财产怎么分”\"\n  ]\n}";
const registry = new ToolRegistry();
beforeAll(async () => { await initDatabase(); registerAllTools(registry); });
const pipeline = (text: string) => buildLumiExecutionPipeline({
  dispatch: { userId: 'creative-content-boundary-fixture', channel: 'chat', source: 'e2e-formal-client',
    operationMode: 'assistant', text, targetIsLumi: true }, registry,
  personalityToolPolicy: { allowedTools: ['*'], requireConfirmation: [], forbiddenTools: [], maxIterations: 10 },
});


async function expectRegistryAdmission(text: string, name: 'generate_video' | 'write_file', admitted: boolean) {
  const p = pipeline(text);
  const definition = registry.get(name)!;
  const oldHandler = definition.handler;
  const oldPreflight = definition.preflight;
  const handler = vi.fn(async () => JSON.stringify({ ok: true, status: 'synthetic_handler_only' }));
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network disabled in routing admission fixture.'));
  definition.handler = handler;
  definition.preflight = vi.fn(async () => undefined);
  try {
    const execute = registry.execute(name, name === 'generate_video'
      ? { prompt: 'Fictional routing fixture only.', duration: 30, size: '720x1280' }
      : { path: 'D:/LumiAcceptance/contract.docx', content: 'must never be written' }, {
      userId: 'creative-content-boundary-fixture', authRole: 'admin', domain: 'personal',
      actionIntent: text, toolPolicy: p.authorizationPolicy, source: 'e2e-formal-client',
      localExecution: true, requestConfirmation: async () => false,
    });
    if (admitted) await expect(execute).resolves.toContain('synthetic_handler_only');
    else await expect(execute).rejects.toThrow(/forbidden/);
    expect(handler).toHaveBeenCalledTimes(admitted ? 1 : 0);
    expect(network).not.toHaveBeenCalled();
  } finally {
    definition.handler = oldHandler;
    definition.preflight = oldPreflight;
    network.mockRestore();
  }
}

describe('creative content is not desktop or whole-turn prohibition authority', () => {
  it('keeps the exact full 32-line request available to the video tool through the final pipeline', () => {
    expect(requiresCurrentAppUiMutation(fullPreparedText)).toBe(false);
    expect(hasExplicitNoMutationInstruction(fullPreparedText)).toBe(false);
    const p = pipeline(fullPreparedText);
    expect(p.normalizedIntent.kind).toBe('media_generation');
    expect(p.modelToolProjection.toolNames).toContain('generate_video');
    expect(p.authorizationPolicy.forbiddenTools).not.toContain('generate_video');
    expect(p.execution.toolRoute?.reasons).not.toContain('the current turn explicitly opens and edits inside a named authoring application');
    expect(p.execution.promptOverlay).not.toContain('Current-turn read-only boundary');
  });
  it.each([
    '生成一个视频，台词是“两张票根夹在口袋里面”，保持保存的模型配置。',
    'Create a video; the story says inside this box save the letter.',
  ])('does not invent an application from content: %s', text => {
    expect(requiresCurrentAppUiMutation(text)).toBe(false);
    const p = pipeline(text);
    expect(p.modelToolProjection.toolNames).toContain('generate_video');
    expect(p.authorizationPolicy.forbiddenTools).not.toContain('generate_video');
  });
  it.each(['生成一个视频，不生成法院、监控录像、法条或额外情节。',
    'Create a video. Do not generate a courthouse or additional story events.'])('keeps content exclusions scoped: %s', text => {
    expect(hasExplicitNoMutationInstruction(text)).toBe(false);
    const p = pipeline(text);
    expect(p.modelToolProjection.toolNames).toContain('generate_video');
    expect(p.authorizationPolicy.forbiddenTools).not.toContain('generate_video');
  });
  it.each(['不要生成', '不要生成文件', '不要生成图片', '不要创建新文档', '不创建、不生成。', '现在不要创建或修改任何内容。', '现在不要生成任何内容。',
    '读取这个文件，但不要修改它', 'Do not generate.', 'Do not generate any files.', 'Do not edit the document.', '不要修改源码', '不要写入数据库', 'Do not edit implementation code', 'Do not change settings', 'Do not save configuration'])('retains an actual prohibition: %s', text => {
    expect(hasExplicitNoMutationInstruction(text)).toBe(true);
    const p = pipeline(text);
    expect(p.modelToolProjection.toolNames).not.toContain('generate_video');
    expect(p.modelToolProjection.toolNames).not.toContain('write_file');
  });
  it.each(['不要发送消息', 'Do not send messages.'])('keeps actual communication forbidden: %s', text => {
    expect(hasExplicitNoMutationInstruction(text)).toBe(true);
    const p = pipeline(text);
    expect(p.modelToolProjection.toolNames).not.toContain('send_email');
    expect(p.modelToolProjection.toolNames).not.toContain('feishu_send_message');
    expect(p.authorizationPolicy.forbiddenTools).toContain('send_email');
  });
  it.each(['在这里面写一篇检讨书给我', '在这个软件里修改当前文档', '打开Word并写入测试',
    '在 WPS 里面新建文档', 'inside the current Photoshop app edit the open draft'])('retains an explicit application anchor: %s', text => {
    expect(requiresCurrentAppUiMutation(text)).toBe(true);
  });
  it('retains the trusted appTarget for a deictic instruction', () => {
    expect(requiresCurrentAppUiMutation('写入测试', 'WPS Office')).toBe(true);
    expect(requiresCurrentAppUiMutation('写入测试')).toBe(false);
  });
});

describe("lyric fidelity constraints preserve the requested generation authority", () => {
  it("keeps the exact new singing pilot executable without rewriting its original words", async () => { const text="请通过当前程序已有的generate_video功能，只生成下面这一份30秒原生音视频演唱样段一次，核验新演唱风格。不创建其它版本、不自动重试、不改写原词。完成后返回真实文件路径，歌词核对和聊天模板合成后续处理。\n\n{\n  \"officialOnly\": true,\n  \"model\": \"aliyun/wan3.0-video\",\n  \"size\": \"720x1280\",\n  \"duration\": 30,\n  \"prompt_extend\": false,\n  \"seed\": 18102026,\n  \"prompt\": \"30秒中文原创双人剧情歌曲样段，2D卡通律所，两位虚构成年人，男律师蓝色西装，女客户红色外套。人声清晰、音乐不盖过词，两个声线固定且有情绪反差。遵循演唱要求：中文双角色剧情歌曲。角色A：律师；角色B：客户。优先沿用用户已保存曲风：中文双人剧情歌：律师男声沉稳、客户女声有情绪反差。剧情对白、节奏念白和短句旋律交替，语气与留白推进情绪，不固定为整首说唱或同一旋律平均唱每句。每句按原文和原顺序呈现，不增词、漏句、改写或重复。。以下叙事编排仅在与该曲风兼容时采用。严格按纯唱词的原文和原顺序逐句呈现，不漏词、改词、调序或增加重复，不唱编号和角色标签，不另加旁白或歌词。重复高潮只按定稿唱词已明确列出的次数呈现，不临时加词或循环。两角色声线和语气有反差，各角色保持音色连续、吐字清楚；允许同一角色连续表达，不将每句唱成等长同旋律。按剧情需要安排轻重、念白与唱句转换及留白，停顿服务情绪与反转；不为凑时长拉长每句或多唱原文。目标约30秒，以实际歌曲为准。使用原创旋律，不模仿特定真人身份。生成后可试听核对，以上要求不代表平台已保证支持。\\n这里只制作以下8句开场，每句一次，不唱角色名。唱完只留短器乐尾声，不补唱任何其余对白或反转；不加背景人声、屏幕文字或字幕。画面只是原生音频容器，不是最终聊天成片。\\n男律师：请坐，今天想聊什么\\n女客户：想离婚，财产怎么分呢\\n男律师：房子存款先列清楚\\n女客户：我想先把心事说清楚\\n男律师：你眼里的火烧了半天\\n女客户：有人半夜还在聊着天\\n男律师：手机翻面还神神秘秘\\n女客户：那聊天记录藏得很严\"\n}"; expect(hasExplicitNoMutationInstruction(text)).toBe(false); const p=pipeline(text); expect(p.normalizedIntent.kind).toBe("media_generation"); expect(p.modelToolProjection.toolNames).toContain("generate_video"); expect(p.authorizationPolicy.forbiddenTools).not.toContain("generate_video"); await expectRegistryAdmission(text, "generate_video", true); });
  it("preserves a real read-only instruction on the original file", async () => { const p=pipeline("读取 D:/LumiAcceptance/contract.docx，不要改写它。"); expect(p.modelToolProjection.toolNames).not.toContain("write_file"); expect(p.modelToolProjection.toolNames).not.toContain("modify_docx"); expect(p.modelToolProjection.toolNames).not.toContain("generate_video"); await expectRegistryAdmission("读取 D:/LumiAcceptance/contract.docx，不要改写它。", "write_file", false); });
});

describe('the existing prohibition object group remains enforced by the registry', () => {
  it.each(['读取 D:/LumiAcceptance/contract.docx，不要改写原文件。', '读取 D:/LumiAcceptance/contract.docx，不要改写文档。', '读取 D:/LumiAcceptance/contract.docx，不要改写。', '不要修改源码', '不要生成视频'])('prevents writes for a real prohibited operation: %s', async text => {
    expect(hasExplicitNoMutationInstruction(text)).toBe(true);
    const p = pipeline(text);
    expect(p.modelToolProjection.toolNames).not.toContain('write_file');
    expect(p.modelToolProjection.toolNames).not.toContain('generate_video');
    await expectRegistryAdmission(text, 'write_file', false);
  });
});
