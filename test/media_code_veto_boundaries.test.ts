import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import cases from './fixtures/media-code-veto/cases.json';
import { initDatabase } from '../db_layer';
import { ToolRegistry } from '../server/tools/registry';
import { registerAllTools } from '../server/tools/definitions';
import { buildLumiExecutionPipeline } from '../server/cognition/execution_pipeline';
const registry=new ToolRegistry();
beforeAll(async()=>{await initDatabase();registerAllTools(registry);});
function pipeline(text:string){return buildLumiExecutionPipeline({dispatch:{userId:'media-word-boundary-fixture',channel:'chat',source:'e2e-formal-client',operationMode:'assistant',text,targetIsLumi:true},registry,personalityToolPolicy:{allowedTools:['*'],forbiddenTools:[],requireConfirmation:[],maxIterations:10}});}
// A standalone React-themed poster still hits the old whole-task veto. That open limitation is recorded separately, not declared fixed by the token-boundary correction.
describe('technical-token boundaries preserve requested media and code-only scope',()=>{
 it.each(cases.positives)('projects the explicitly requested image tool %s',(_label,text)=>{const p=pipeline(text);expect(p.normalizedIntent.kind).toBe('media_generation');expect(p.modelToolProjection.toolNames).toContain('generate_image');expect(p.authorizationPolicy.forbiddenTools).not.toContain('generate_image');});
 it.each([...cases.pureCode,...cases.negative])('does not expose a paid generator %s',(_label,text)=>{const p=pipeline(text);expect(p.modelToolProjection.toolNames).not.toContain('generate_image');expect(p.modelToolProjection.toolNames).not.toContain('generate_video');});
});
