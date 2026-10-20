import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
vi.mock('../server/regions/packs/cn/legal_tools/context', async original => ({...await original<Record<string, unknown>>(),runLegalLLM:vi.fn()}));
vi.mock('../server/regions/packs/cn/legal_tools/argument_drafting',()=>({generateArgumentOrOpinionHandler:vi.fn(async()=> '仅供复核的代理词正文')}));
import { runLegalLLM } from '../server/regions/packs/cn/legal_tools/context';
import { generateArgumentOrOpinionHandler } from '../server/regions/packs/cn/legal_tools/argument_drafting';
import { analyzeFolderAndDraftArgumentHandler } from '../server/regions/packs/cn/legal_tools/folder_analysis';
import { buildLegalReasoningMatrixMarkdown } from '../server/regions/packs/cn/legal_tools/case_workspace';
import { decodeToolResult } from '../server/tools/result_envelope';
const folders:string[]=[];
afterEach(()=>{vi.clearAllMocks();for(const folder of folders.splice(0))fs.rmSync(folder,{recursive:true,force:true});});
function fixture(){const folder=fs.mkdtempSync(path.join(os.tmpdir(),'lumi-folder-source-'));folders.push(folder);const content='仅测试材料：我方要求按约交货；未声明质量异议。\n'+'待核对原件及合同履行条件。\n'.repeat(2500)+'SOURCE_TAIL_49281';fs.writeFileSync(path.join(folder,'材料.txt'),content);return {folder,content};}
describe('folder source and honest analysis completion',()=>{
  it('does not invent case-specific disputes in a template',()=>{const draft=buildLegalReasoningMatrixMarkdown({caseType:'买卖合同纠纷',facts:'尚未约定验收方式。'});expect(draft).not.toContain('质量异议或拒付抗辩是否成立');expect(draft).not.toContain('欠款金额');});
  it('retains original tail, temporal slots and neutral attribution throughout drafting',async()=>{const {folder}=fixture();vi.mocked(runLegalLLM).mockResolvedValue('需核对交货条件。');const raw=await analyzeFolderAndDraftArgumentHandler({folderPath:folder,writeFiles:false,factDate:'2018-03-01',procedureDate:'2026-10-13',temporalReviews:[{statuteName:'虚构法源待核验'}]},{});expect(decodeToolResult(raw).receipt).toMatchObject({ok:true,status:'generated'});const prompt=vi.mocked(runLegalLLM).mock.calls[0][0];expect(prompt).toContain('SOURCE_TAIL_49281');const arg=vi.mocked(generateArgumentOrOpinionHandler).mock.calls[0][0];expect(arg).toMatchObject({facts:'',factDate:'2018-03-01',procedureDate:'2026-10-13'});expect(arg.materials).toContain('SOURCE_TAIL_49281');expect(arg.issues).toEqual([]);expect(arg.temporalReviews).toEqual([{statuteName:'虚构法源待核验'}]);});
  it('does not claim completed analysis after the analysis model fails',async()=>{const {folder}=fixture();vi.mocked(runLegalLLM).mockResolvedValue('');const output=path.join(folder,'outputs');const raw=await analyzeFolderAndDraftArgumentHandler({folderPath:folder,outputDir:output},{});expect(decodeToolResult(raw).receipt).toMatchObject({ok:false,status:'partial'});const analysis=fs.readFileSync(path.join(output,'01_案情分析与争议焦点.md'),'utf8');expect(analysis).toContain('案情分析未完成');expect(analysis).toContain('SOURCE_TAIL_49281');expect(analysis).not.toContain('质量异议或拒付抗辩');});
});
