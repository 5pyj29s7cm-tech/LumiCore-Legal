import './helpers';
import {beforeAll,afterEach,expect,it,vi} from 'vitest';
import {initDatabase} from '../db_layer';
import {ToolRegistry} from '../server/tools/registry';
import {registerProductVariantTools} from '../server/tools/definitions';
import {routeToolsForTurn} from '../server/cognition/tool_router';
import {buildLumiExecutionPipeline} from '../server/cognition/execution_pipeline';
import {buildActionContract,formatActionContractPrompt} from '../server/cognition/action_contract';
const original="只依据我本次上传的这三份虚构文件回答，逐题引用对应文件及原句；没有取得或仅是计划的内容请按原文区分，不自行补充。文件：KB-QA-20261016-7D42-A-原告陈述.txt（fileId=KB-QA-20261016-7D42-A-原告陈述.txt）；KB-QA-20261016-7D42-B-被告陈述.txt（fileId=KB-QA-20261016-7D42-B-被告陈述.txt）；KB-QA-20261016-7D42-C-材料核对记录.txt（fileId=KB-QA-20261016-7D42-C-材料核对记录.txt）。\nQ01 原告请求的金额是多少，这个数字能否直接当作已核实的合同总价？\nQ02 谁自述向谁付款多少，当前是否取得了可核实这笔款项的银行原始流水？\nQ03 两份陈述的金额相减后，是否能认定被告承认了剩余债务？\nQ04 本轮实际收到过货物照片或转账截图的图片像素吗，可以描述画面或交易信息吗？\nQ05 4箱的记录究竟证明了什么，能认定双方已验收或质量合格吗？\nQ06 两次排期表中的拟交付日期有什么变化，哪一天可以写成实际交货日？\nQ07 能从现有材料确认合同签署日期、具体付款到期条件和管辖法院吗，未提供等不等于双方未约定？\nQ08 质量异议由谁提出，原告承认了吗，缺陷有鉴定或双方复检记录支持吗？\nQ09 下一次材料复核会是什么时间，这个日期能代替合同生效、付款到期或法院立案时间吗？\nQ10 请分别给出三份文件各自尾段的核验码，并引用每个代码实际所在的文件。";
const explicit=original.replace('只依据我本次上传的这三份虚构文件回答','只依据个人知识库中的这三份虚构资料回答');
const registry=new ToolRegistry();
const context={userId:'offline_projection_owner',authenticated:true,authRole:'admin',executionBoundary:'trusted_local' as const,domain:'personal' as const,source:'offline-projection'};
const base={allowedTools:['*'],forbiddenTools:[] as string[],requireConfirmation:[] as string[],maxIterations:80};
beforeAll(async()=>{await initDatabase();registerProductVariantTools(registry);});
afterEach(()=>vi.unstubAllGlobals());
function project(text:string,policy=base){
 const network=vi.fn(()=>{throw Error('Projection must not use network');});vi.stubGlobal('fetch',network);
 const pipeline=buildLumiExecutionPipeline({userText:text,dispatch:{userId:context.userId,text,channel:'chat',source:'chat',operationMode:'assistant',targetIsLumi:true},registry,personalityToolPolicy:policy,executionBoundary:'trusted_local',source:'chat'});
 const execution=pipeline.execution;
 const selection=pipeline.capabilityPlan;
 const projection=pipeline.modelToolProjection;
 expect(network).not.toHaveBeenCalled();
 return {route:execution.toolRoute!,selection,projection,execution,pipeline};
}
it.each([['original',original],['explicit knowledge scope',explicit]])('keeps the real read-only contract source reader through the bounded %s pipeline',(_name,text)=>{
 const {route,selection,projection,pipeline}=project(text);
 expect(buildActionContract(text).label).toBe('Exact read-only file inspection');
 expect(route.maxTools).toBe(32);
 expect(route.toolNames.length).toBeLessThanOrEqual(32);
 expect(selection.preferredTools).toContain('knowledge_file_stats');
 expect(selection.preferredTools.indexOf('read_file')).toBeLessThan(selection.preferredTools.indexOf('knowledge_file_stats')); 
 expect(projection.toolNames).toContain('knowledge_file_stats');
 expect(projection.toolNames.length).toBeLessThanOrEqual(32);
 const declared=registry.getToolDeclarationsForPolicy(pipeline.authorizationPolicy,{context,visibleToolNames:projection.toolNames});
 expect(declared.map(d=>d.function.name)).toContain('knowledge_file_stats');
});
it('does not raise the reader above a policy denial or a hard route',()=>{
 const denied=project(original,{...base,forbiddenTools:['knowledge_file_stats']});
 expect(denied.projection.toolNames).not.toContain('knowledge_file_stats');
 expect(registry.getToolDeclarationsForPolicy(denied.execution.baseToolPolicy,{context,visibleToolNames:denied.projection.toolNames}).map(d=>d.function.name)).not.toContain('knowledge_file_stats');
 const hard=project('查看当前活动窗口');
 expect(hard.route.hardAllowlist).toBe(true);
 expect(hard.projection.toolNames).toEqual(['desktop_active_window']);
});
it('does not add the reader to an unrelated media producer route',()=>{
 const {selection,projection}=project('Generate video\nA fictional holiday promotion');
 expect(selection.preferredTools).not.toContain('knowledge_file_stats');
 expect(projection.toolNames).not.toContain('knowledge_file_stats');
 expect(projection.toolNames[0]).toBe('generate_video');
});
it('describes complete knowledge source receipts as an alternative to local absolute-path reads',()=>{
 const contract=buildActionContract(explicit);
 expect(contract.verificationTools).toEqual(['read_file','knowledge_file_stats']);
 expect(contract.coreAction).toMatch(/local.*absolute path.*knowledge.*fileIds/i);
 expect(contract.requiredEvidence.join(' ')).toMatch(/read_file.*or.*knowledge_file_stats.*source_text.*scope/i);
 expect(contract.nextStep).toContain('knowledge_file_stats');
 expect(contract.caution).toMatch(/fileId.*not a local path/i);
 expect(formatActionContractPrompt(contract)).toContain('fileIds');
});
