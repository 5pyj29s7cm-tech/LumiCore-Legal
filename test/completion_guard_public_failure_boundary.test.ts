import { describe, expect, it } from 'vitest';
import { guardCompletionClaims } from '../server/work_product/completion_guard';
import type { ToolExecutionRecord } from '../server/tools/types';
const rawFailures=[
  'Document analysis is blocked until the supplied material is grounded to a trusted application/window/object/path anchor.',
  '{"task":"invoke computer_use","target_application":"WPS Office","max_steps":20,"system_prompt":"Internal execution recovery"}',
  'Internal execution recovery: the model must collect canonical terminalVerification from client_get_state and rerun the tool.',
  'requires user confirmation: {"tool":"computer_use","parameters":{"task":"Read document, then wait"}}',
];
const messages=[
  {task:'请查看客户端设置',response:'我正在打开客户端设置。'},
  {task:'打开桌面上的 WPS 文档',response:'我现在打开 WPS 文档。'},
  {task:'生成案件报告',response:'案件报告已生成。'},
  {task:'Read the document and generate a report',response:'I will do this now.'},
  {task:'Open the desktop application',response:'I am doing it now.'},
  {task:'Generate the report',response:'The report was generated.'},
];
describe('private execution failures never become public conversation text',()=>{
  it.each(rawFailures)('keeps a private failure out of every public failed-action projection: %s',detail=>{
    const record:ToolExecutionRecord={name:'read_docx',arguments:{filePath:'D:/virtual/example.docx'},result:'',error:detail,terminalVerification:{status:'failed',strategy:'terminal_receipt',reason:detail}};
    for(const message of messages){const result=guardCompletionClaims({...message,toolCalls:[record]});expect(result.blocked).toBe(true);expect(result.text).not.toContain(detail);for(const token of ['trusted application','window/object/path anchor','target_application','max_steps','system_prompt','Internal execution recovery','terminalVerification','client_get_state','computer_use'])expect(result.text).not.toContain(token);expect(record.error).toBe(detail);}
  });
  it('preserves a verified step while still rejecting fictional overall completion and raw auxiliary error text',()=>{
    const good:ToolExecutionRecord={name:'read_file',arguments:{},result:'Actual observed source body.',terminalVerification:{status:'verified',strategy:'terminal_receipt',reason:'Observed source'}};
    const bad:ToolExecutionRecord={name:'create_docx',arguments:{},result:'',error:rawFailures[0],terminalVerification:{status:'failed',strategy:'artifact',reason:rawFailures[0]}};
    const result=guardCompletionClaims({task:'生成案件报告文档',response:'报告文档已生成。',toolCalls:[good,bad]});expect(result.blocked).toBe(true);expect(result.text).toContain('已经完成的部分会保留');expect(result.text).not.toContain(rawFailures[0]);
  });
});
