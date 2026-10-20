import { afterAll, beforeAll, expect, it } from 'vitest';
import { makeApp } from './helpers';
import { ToolRegistry } from '../server/tools/registry';
import { defineLegalTool, withLegalReceipt, legalCapability } from '../server/regions/packs/cn/legal_tools/tool_contracts';
import { encodeToolResult, decodeToolResult } from '../server/tools/result_envelope';
import * as cases from '../server/org/legal_cases';
import { createLegalArticle } from '../server/legal/kb';
let app: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async()=>{app=await makeApp();}); afterAll(()=>app.cleanup());
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
function setup(handler:(args:any,context:any)=>Promise<string>, profile:any={status:'observed'}) {
  const userId='attempt-write-'+crypto.randomUUID(),orgId=cases.legalWorkspaceNamespace(userId);
  const registry=new ToolRegistry();
  registry.register(defineLegalTool({name:'legal_case_strategy',description:'Synthetic isolated write attribution',properties:{},
    handler:withLegalReceipt(handler,profile),capability:legalCapability({id:'legal.attempt.write.fixture',operation:'observe',risk:'low',successStatuses:['observed'],sideEffects:[]})}));
  const context={userId,domain:'personal' as const,authenticated:true,authRole:'user',localExecution:true,executionBoundary:'trusted_local' as const};
  const run=(args:any)=>registry.execute('legal_case_strategy',args,{...context,requestId:crypto.randomUUID()}).then(decodeToolResult);
  const makeCase=()=>cases.createCase(orgId,userId,{title:'Fictional exact attempt case'});
  return {userId,orgId,registry,context,run,makeCase};
}
it('does not attribute another case workflow-only completion to a waiting partial attempt',async()=>{
  const started=deferred(),release=deferred(); const f=setup(async(args)=>{if(args.tag==='A'){started.resolve();await release.promise;}
    return encodeToolResult('Own result '+args.tag,{ok:args.tag==='B',status:args.tag==='B'?'observed':'partial'});});
  const a=f.makeCase(),b=f.makeCase();const aBefore=cases.getCase(f.orgId,a.id)!.materials,bBefore=cases.getCase(f.orgId,b.id)!.materials;
  const pa=f.run({caseId:a.id,tag:'A'});await started.promise;const rb=await f.run({caseId:b.id,tag:'B'});release.resolve();const ra=await pa;
  expect(rb.receipt).toMatchObject({persisted:false,changedCaseIds:[]});expect(ra.receipt).toMatchObject({ok:false,status:'partial',persisted:false,changedCaseIds:[],articleIds:[]});
  expect(cases.getCase(f.orgId,a.id)!.workflowRuns![0].displayText).toBe('Own result A');
  const bh=cases.getCase(f.orgId,b.id)!;expect(bh.workflowRuns).toHaveLength(1);expect(bh.workflowRuns![0].displayText).toBe('Own result B');
  expect(cases.getCase(f.orgId,a.id)!.materials).toEqual(aBefore);expect(bh.materials).toEqual(bBefore);
});
it('does not copy a concurrent different-case archive or its history into a no-write attempt',async()=>{
  const started=deferred(),release=deferred();let written='';const f=setup(async(args,context)=>{if(args.tag==='A'){started.resolve();await release.promise;}else written=cases.addMaterial(cases.legalWorkspaceNamespace(context.userId),context.userId,args.caseId,{type:'note',source:'tool',title:'Own B archive',content:'Own result B'})!.id;
    return encodeToolResult('Own result '+args.tag,{ok:args.tag==='B',status:args.tag==='B'?'observed':'partial'});});
  const a=f.makeCase(),b=f.makeCase();const pa=f.run({caseId:a.id,tag:'A'});await started.promise;const rb=await f.run({caseId:b.id,tag:'B'});release.resolve();const ra=await pa;
  expect(rb.receipt).toMatchObject({persisted:true,changedCaseIds:[b.id]});expect(ra.receipt).toMatchObject({persisted:false,changedCaseIds:[]});
  const history=cases.getCase(f.orgId,b.id)!.workflowRuns!;expect(history).toHaveLength(1);expect(history[0].materialIds).toEqual([written]);expect(history[0].displayText).toBeUndefined();
  expect(cases.getCase(f.orgId,a.id)!.materials).toHaveLength(0);
});
it('binds only this attempt material IDs when concurrent calls write the same case',async()=>{
  const started=deferred(),release=deferred();const own:Record<string,string>={};const f=setup(async(args,context)=>{if(args.tag==='A'){started.resolve();await release.promise;}
    own[args.tag]=cases.addMaterial(cases.legalWorkspaceNamespace(context.userId),context.userId,args.caseId,{type:'note',source:'tool',title:args.tag,content:'Own result '+args.tag})!.id;
    return encodeToolResult('Own result '+args.tag,{ok:true,status:'observed'});});
  const c=f.makeCase();const pa=f.run({caseId:c.id,tag:'A'});await started.promise;await f.run({caseId:c.id,tag:'B'});release.resolve();const ra=await pa;
  expect(ra.receipt).toMatchObject({persisted:true,changedCaseIds:[c.id]});const after=cases.getCase(f.orgId,c.id)!;
  expect(after.materials).toHaveLength(2);expect(after.workflowRuns![0].materialIds).toEqual([own.A]);expect(after.workflowRuns![1].materialIds).toEqual([own.B]);
});
it('attributes only the article created by this attempt during concurrent same-scope imports',async()=>{
  const started=deferred(),release=deferred();const articles:Record<string,string>={};const f=setup(async(args,context)=>{if(args.tag==='A'){started.resolve();await release.promise;}
    articles[args.tag]=createLegalArticle(cases.legalWorkspaceNamespace(context.userId),context.userId,{title:'Fictional '+args.tag,content:'Independent source '+args.tag,articleType:'research_note'}).id;
    return encodeToolResult('Imported '+args.tag,{ok:true,status:'observed'});},{status:'observed',requireArticleMutation:true});
  const pa=f.run({tag:'A'});await started.promise;const rb=await f.run({tag:'B'});release.resolve();const ra=await pa;
  expect(rb.receipt).toMatchObject({persisted:true,articleIds:[articles.B],changedCaseIds:[]});expect(ra.receipt).toMatchObject({persisted:true,articleIds:[articles.A],changedCaseIds:[]});
});
it('keeps a no-write partial article result empty even if another import finishes',async()=>{
  const started=deferred(),release=deferred();const f=setup(async(args,context)=>{if(args.tag==='A'){started.resolve();await release.promise;}else createLegalArticle(cases.legalWorkspaceNamespace(context.userId),context.userId,{title:'Own B source',content:'B source',articleType:'research_note'});
    return encodeToolResult('Own '+args.tag,{ok:args.tag==='B',status:args.tag==='B'?'observed':'partial'});});
  const pa=f.run({tag:'A',persistCase:false});await started.promise;await f.run({tag:'B'});release.resolve();const ra=await pa;
  expect(ra.receipt).toMatchObject({ok:false,status:'partial',persisted:false,changedCaseIds:[],articleIds:[]});
});
it('does not count this attempt own history-only write as case archival',async()=>{
  const f=setup(async(args,context)=>{cases.recordWorkflowRun(cases.legalWorkspaceNamespace(context.userId),context.userId,args.caseId,{tool:'existing_probe',ok:false,status:'partial',materialIds:[],artifacts:[],displayText:'Prior pending result'});return encodeToolResult('Own history-only result',{ok:false,status:'partial'});});
  const c=f.makeCase(),r=await f.run({caseId:c.id});expect(r.receipt).toMatchObject({persisted:false,changedCaseIds:[]});expect(cases.getCase(f.orgId,c.id)!.materials).toHaveLength(0);
});
it('requires this attempt real mutation instead of accepting a concurrent write to satisfy persistence',async()=>{
  const started=deferred(),release=deferred();const f=setup(async(args,context)=>{if(args.tag==='A'){started.resolve();await release.promise;}else cases.updateCase(cases.legalWorkspaceNamespace(context.userId),context.userId,args.caseId,{notes:'Own B update'});return encodeToolResult('Own '+args.tag,{ok:true,status:'observed'});},{status:'observed',expectCaseMutation:'when_case_id'});
  const a=f.makeCase(),b=f.makeCase();const pa=f.run({caseId:a.id,tag:'A'}).catch(e=>e);await started.promise;await f.run({caseId:b.id,tag:'B'});release.resolve();
  expect(await pa).toBeInstanceOf(Error);expect(cases.getCase(f.orgId,b.id)!.workflowRuns![0].displayText).toBe('Own B');
});
it('captures a newly created case and its original material without relying on a preexisting caseId',async()=>{
  let id='';const f=setup(async(_args,context)=>{const c=cases.createCase(cases.legalWorkspaceNamespace(context.userId),context.userId,{title:'New exact attempt case'});id=c.id;cases.addMaterial(c.orgId,context.userId,c.id,{type:'note',source:'tool',title:'Own new archive',content:'Own new result'});return encodeToolResult('Own new result',{ok:true,status:'observed'});},{status:'observed',expectCaseMutation:'always'});
  const r=await f.run({});expect(r.receipt).toMatchObject({persisted:true,changedCaseIds:[id]});const c=cases.getCase(f.orgId,id)!;expect(c.workflowRuns![0].materialIds).toEqual([c.materials[0].id]);expect(c.workflowRuns![0].displayText).toBeUndefined();
});

it('keeps same-case concurrent no-write partial free of the other attempt material and preserves its own history status',async()=>{
 const started=deferred(),release=deferred();const f=setup(async(args,context)=>{if(args.tag==='A'){started.resolve();await release.promise;}else cases.addMaterial(cases.legalWorkspaceNamespace(context.userId),context.userId,args.caseId,{title:'B only',type:'note',source:'tool',content:'Own B'});return encodeToolResult('Own '+args.tag,{ok:args.tag==='B',status:args.tag==='B'?'observed':'partial'});});
 const c=f.makeCase();const pa=f.run({caseId:c.id,tag:'A'});await started.promise;await f.run({caseId:c.id,tag:'B'});release.resolve();const ra=await pa;
 expect(ra.receipt).toMatchObject({ok:false,status:'partial',persisted:false,changedCaseIds:[]});const current=cases.getCase(f.orgId,c.id)!;expect(current.materials).toHaveLength(1);expect(current.workflowRuns![0]).toMatchObject({status:'partial',ok:false,materialIds:[],displayText:'Own A'});
});
it('keeps concurrent organization article imports bound to the actual actor as well as organization',async()=>{
 const db=await import('../server/org/db');const started=deferred(),release=deferred();const ids:Record<string,string>={};const f=setup(async(args,context)=>{if(args.tag==='A'){started.resolve();await release.promise;}ids[args.tag]=createLegalArticle(context.orgId,context.userId,{title:'Actor '+args.tag,content:'Synthetic exact actor source',articleType:'research_note'}).id;return encodeToolResult('Own '+args.tag,{ok:true,status:'observed'});},{status:'observed',requireArticleMutation:true});
 const other='attempt-other-'+crypto.randomUUID(),org=db.createOrg('Synthetic attempt scope',crypto.randomUUID(),f.userId);db.addMember(org.id,other,'member');
 const run=(tag:string,userId:string)=>f.registry.execute('legal_case_strategy',{tag},{...f.context,domain:'work',orgId:org.id,userId,requestId:crypto.randomUUID()}).then(decodeToolResult);
 const pa=run('A',f.userId);await started.promise;const b=await run('B',other);release.resolve();const a=await pa;
 expect(a.receipt).toMatchObject({articleIds:[ids.A],persisted:true});expect(b.receipt).toMatchObject({articleIds:[ids.B],persisted:true});
});
it('does not count an existing article owned by another actor as this attempt reuse',async()=>{
 const f=setup(async(args)=>encodeToolResult('Synthetic reuse',{ok:true,status:'observed',existingArticleIds:[args.articleId]}),{status:'observed',allowExistingArticles:true,requireArticleMutation:true});
 const article=createLegalArticle(f.orgId,'different-actor',{title:'Other author source',content:'Synthetic other author',articleType:'research_note'});
 await expect(f.run({articleId:article.id})).rejects.toThrow('did not persist an article');
});

it('binds conflicting userId arguments to the server caller before a real case archive and receipt',async()=>{
 const forged='spoof-actor-'+crypto.randomUUID();let created='';const f=setup(async(args)=>{const actor=args.userId;const c=cases.createCase(cases.legalWorkspaceNamespace(actor),actor,{title:'Canonical actor archive'});created=c.id;cases.addMaterial(c.orgId,actor,c.id,{title:'Owned output',type:'note',source:'tool',content:'Canonical actor result'});return encodeToolResult('Canonical actor result',{ok:true,status:'observed'});},{status:'observed',expectCaseMutation:'always'});
 const r=await f.run({userId:forged});expect(r.receipt).toMatchObject({ok:true,persisted:true,changedCaseIds:[created]});const c=cases.getCase(f.orgId,created,f.userId)!;expect(c.createdBy).toBe(f.userId);expect(c.materials[0].createdBy).toBe(f.userId);expect(c.workflowRuns![0].materialIds).toEqual([c.materials[0].id]);expect(cases.listCases(cases.legalWorkspaceNamespace(forged),'',200,forged)).toEqual([]);
});
it('binds conflicting userId arguments before a real knowledge article write',async()=>{
 const forged='spoof-kb-actor-'+crypto.randomUUID();let written:any;const f=setup(async(args,context)=>{written=createLegalArticle(cases.legalWorkspaceNamespace(context.userId),args.userId,{title:'Canonical author source',content:'Synthetic caller-owned source',articleType:'research_note'});return encodeToolResult('Canonical article result',{ok:true,status:'observed'});},{status:'observed',requireArticleMutation:true});
 const r=await f.run({userId:forged});expect(r.receipt).toMatchObject({ok:true,persisted:true,articleIds:[written.id]});expect(written.authorId).toBe(f.userId);
});
it('retains legacy explicit userId when there is no context caller',async()=>{
 const legacy='legacy-actor-'+crypto.randomUUID();let created='';const f=setup(async(args)=>{const c=cases.createCase(cases.legalWorkspaceNamespace(args.userId),args.userId,{title:'Legacy explicit actor case'});created=c.id;return encodeToolResult('Legacy exact actor',{ok:true,status:'observed'});},{status:'observed',expectCaseMutation:'always'});
 const r=decodeToolResult(await f.registry.execute('legal_case_strategy',{userId:legacy}));expect(r.receipt).toMatchObject({persisted:true,changedCaseIds:[created]});expect(cases.getCase(cases.legalWorkspaceNamespace(legacy),created,legacy)!.createdBy).toBe(legacy);
});
it('does not grant access to another personal case through a forged userId',async()=>{
 const other='spoof-case-owner-'+crypto.randomUUID();const otherOrg=cases.legalWorkspaceNamespace(other);const victim=cases.createCase(otherOrg,other,{title:'Untouched foreign synthetic case'});const before=cases.getCase(otherOrg,victim.id,other);const f=setup(async()=>encodeToolResult('Must never execute',{ok:true,status:'observed'}));
 await expect(f.run({userId:other,caseId:victim.id})).rejects.toThrow('selected legal case is unavailable');expect(cases.getCase(otherOrg,victim.id,other)).toEqual(before);
});
