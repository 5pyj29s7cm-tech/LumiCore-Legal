import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDataPath } from '../server/config/data_path';
import { getWebLoginSitePreset } from '../server/web_login/legal_presets';
import { runWebLogin, saveWebLoginProfile, listWebLoginProfiles, webLoginProfileAllowsUrl } from '../server/web_login/manager';
const mocks = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock('playwright-core', () => ({ chromium: { launchPersistentContext: (...args: unknown[]) => mocks.launch(...args) } }));
const priorExecutable = process.env.LUMI_BROWSER_EXECUTABLE;
const presetId = 'china-judgments-online';
const entry = 'https://wenshu.court.gov.cn/website/wenshu/181010CARHS5BS3C/index.html?open=login';
const officialFrame = 'https://account.court.gov.cn/oauth/authorize?response_type=code&client_id=synthetic-client&redirect_uri=https%3A%2F%2Fwenshu.court.gov.cn%2Fcallback&state=synthetic-private-state&timestamp=123&signature=synthetic-signature&scope=profile';
let sequence = 0;
const contexts: any[] = [];
beforeAll(() => { const exe=getDataPath('synthetic-iframe-browser'); fs.mkdirSync(path.dirname(exe), { recursive:true }); fs.writeFileSync(exe, 'never executed'); process.env.LUMI_BROWSER_EXECUTABLE=exe; });
afterAll(async () => { for(const context of contexts) await context.close(); if(priorExecutable===undefined) delete process.env.LUMI_BROWSER_EXECUTABLE; else process.env.LUMI_BROWSER_EXECUTABLE=priorExecutable; });
beforeEach(() => { mocks.launch.mockReset(); vi.useFakeTimers({toFake:['Date']}); });
afterAll(() => { vi.useRealTimers(); });
function browser(options: {src?:string; frameMissing?:boolean; frameEmpty?:boolean; authenticated?:boolean; after?:'callback'|'account-auth'|'captcha'; redirectForeign?:boolean} = {}) {
  let url = entry, stage='entry';
  const navigations:string[] = [], fills:unknown[] = [];
  const frameWait = vi.fn(async () => { if(options.frameMissing) throw new Error('synthetic iframe absent'); });
  function locator(selector:string): any {
    const iframe=selector==='iframe#contentIframe';
    const account=stage==='account', rootAuth=options.authenticated || stage==='callback';
    const visible=iframe ? !options.frameMissing && stage==='entry' : selector==='input[type="password"]' ? account && !options.after : selector==='input[autocomplete="username"]' ? account && !options.after : selector==='button[type="submit"]' ? account && !options.after : selector==='input[autocomplete="one-time-code"]' ? account && options.after==='captcha' : selector==='a[href*="logout" i]' ? rootAuth || (account && options.after==='account-auth') : false;
    const value:any={first:()=>value,count:async()=>Number(Boolean(visible)),isVisible:async()=>Boolean(visible),waitFor:frameWait,innerText:async()=>rootAuth?'Account signed in':account&&options.after==='captcha'?'Enter verification code':'Public portal',fill:async(v:unknown)=>{fills.push(v)},inputValue:async()=>'',click:async()=>{},press:async()=>{}};
    return value;
  }
  const page:any={url:()=>url,title:async()=>stage==='account'?'Sign in':'Portal',locator,goto:vi.fn(async(target:string)=>{navigations.push(target);url=target;if(new URL(target).hostname==='account.court.gov.cn'){stage='account';if(options.after==='callback'){stage='callback';url='https://wenshu.court.gov.cn/cases'}if(options.redirectForeign)url='https://unapproved.example/login';}else if(options.authenticated){stage='callback';url='https://wenshu.court.gov.cn/cases'}else stage='entry';}),waitForFunction:vi.fn(async()=>{if(options.frameEmpty)throw new Error('synthetic empty source');return{jsonValue:async()=>options.src??officialFrame,dispose:async()=>{}}}),waitForTimeout:async(ms:number)=>{vi.setSystemTime(Date.now()+ms)},waitForLoadState:async()=>{},close:async()=>{}};
  const listeners:Record<string,()=>void>={};
  const context:any={pages:()=>[page],newPage:async()=>page,once:(name:string,fn:()=>void)=>{listeners[name]=fn},close:async()=>{listeners.close?.()}};
  contexts.push(context); mocks.launch.mockResolvedValue(context);
  return {page,context,navigations,fills,frameWait};
}
function scope(){ return {userId:'synthetic-iframe-owner-'+(++sequence),domain:'personal'}; }
function options(){ return {profileId:presetId,headless:false,autoSubmit:false,waitForManualMs:3000}; }
describe('official embedded login reuses the current scoped browser and navigation guard', () => {
  it('admits exactly the official account host in the existing preset', () => {
    const preset=getWebLoginSitePreset(presetId)!;
    expect(preset.matchHosts).toEqual(['wenshu.court.gov.cn','account.court.gov.cn']);
    expect(webLoginProfileAllowsUrl(preset,officialFrame)).toBe(true);
    expect(webLoginProfileAllowsUrl(preset,'https://account.court.gov.cn.evil.test/login')).toBe(false);
    expect(webLoginProfileAllowsUrl(preset,'https://other.court.gov.cn/login')).toBe(false);
  });
  it('opens the actual iframe source top-level intact, within the original visible context, without exposing OAuth query', async () => {
    const own=scope(), b=browser(); const result=await runWebLogin(options(),own);
    expect(b.navigations).toEqual([entry,officialFrame]);
    expect(mocks.launch).toHaveBeenCalledTimes(1);
    expect(mocks.launch.mock.calls[0][0]).toContain('user-'+own.userId);
    expect(result).toMatchObject({status:'manual_required',browserOpen:true,submitted:false});
    expect(result.url).toBe('https://account.court.gov.cn/oauth/authorize');
    expect(JSON.stringify(result)).not.toContain('synthetic-private-state');
    expect(JSON.stringify(result)).not.toContain('synthetic-signature');
    expect(b.fills).toEqual([]);
  });
  it('requires positive service callback evidence and accepts it when present', async () => {
    const b=browser({after:'callback'});const result=await runWebLogin(options(),scope());
    expect(b.navigations).toEqual([entry,officialFrame]);
    expect(result).toMatchObject({status:'logged_in',loginState:'authenticated',url:'https://wenshu.court.gov.cn/cases'});
  });
  it('does not call an authenticated SSO account page a logged-in Wenshu session', async () => {
    browser({after:'account-auth'}); const result=await runWebLogin(options(),scope());
    expect(result.status).toBe('manual_required'); expect(result.loginState).not.toBe('authenticated');
  });
  it('leaves an already-authenticated service page alone', async () => {
    const b=browser({authenticated:true});const result=await runWebLogin(options(),scope());
    expect(result.status).toBe('logged_in');expect(b.navigations).toEqual([entry]);expect(b.frameWait).not.toHaveBeenCalled();
  });
  it.each([{frameMissing:true},{frameEmpty:true}])('keeps missing/unready official frame manual, without guessing a URL: %j', async setting => {
    const b=browser(setting);const result=await runWebLogin(options(),scope());
    expect(result.status).toBe('manual_required');expect(b.navigations).toEqual([entry]);expect(b.fills).toEqual([]);
  });
  it.each(['javascript:alert(1)','data:text/html,not-a-login','http://account.court.gov.cn/oauth/authorize','https://unapproved.example/oauth/authorize'])('rejects an invalid or unauthorized frame source before second navigation or credential use: %s', async src => {
    const b=browser({src}); await expect(runWebLogin(options(),scope())).rejects.toThrow(/http|HTTPS|authorized/);
    expect(b.navigations).toEqual([entry]);expect(b.fills).toEqual([]);
  });
  it('does not silently broaden an existing owner profile; normal owner save can authorize the exact host', async () => {
    const own=scope();saveWebLoginProfile({id:presetId,loginUrl:entry,matchHosts:['wenshu.court.gov.cn']},own);
    const b=browser();await expect(runWebLogin(options(),own)).rejects.toThrow(/not authorized/);
    expect(listWebLoginProfiles(own)[0].matchHosts).toEqual(['wenshu.court.gov.cn']);expect(b.fills).toEqual([]);
    saveWebLoginProfile({id:presetId,loginUrl:entry,matchHosts:getWebLoginSitePreset(presetId)!.matchHosts},own);
    const result=await runWebLogin(options(),own);expect(result.status).toBe('manual_required');expect(b.navigations).toEqual([entry,entry,officialFrame]);
  });
  it('does not borrow a custom profile or credentials from another personal scope', async () => {
    const own=scope();saveWebLoginProfile({id:'private-custom-iframe',loginUrl:entry,matchHosts:['wenshu.court.gov.cn','account.court.gov.cn'],username:'synthetic-private-user'},own);
    browser();await expect(runWebLogin({...options(),profileId:'private-custom-iframe'},scope())).rejects.toThrow(/No matching web login profile/);
    expect(mocks.launch).not.toHaveBeenCalled();
  });
  it('keeps captcha manual and rejects an unauthorized redirect without leaking query or filling credentials', async () => {
    browser({after:'captcha'});const result=await runWebLogin(options(),scope());expect(result).toMatchObject({status:'manual_required',loginState:'verification_required',submitted:false});
    const b=browser({redirectForeign:true});await expect(runWebLogin(options(),scope())).rejects.toThrow('The authorized embedded sign-in page could not be opened.');expect(b.fills).toEqual([]);
  });
  it('preserves the ordinary top-level login flow without frame probing', async () => {
    const own=scope(),b=browser();saveWebLoginProfile({id:'generic-standalone',loginUrl:'https://example.com/login',matchHosts:['example.com']},own);
    const result=await runWebLogin({...options(),profileId:'generic-standalone'},own);
    expect(result.status).toBe('manual_required');expect(b.navigations).toEqual(['https://example.com/login']);expect(b.frameWait).not.toHaveBeenCalled();
  });
  it('retains one same-scope session operation lease while opening the first browser', async () => {
    const own=scope(),b=browser();let release!:(v:any)=>void;let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve});
    mocks.launch.mockImplementationOnce(()=>{entered();return new Promise(resolve=>{release=resolve})});
    const first=runWebLogin(options(),own);await started;
    await expect(runWebLogin(options(),own)).rejects.toThrow(/already in use/);expect(mocks.launch).toHaveBeenCalledTimes(1);
    release(b.context);const result=await first;expect(result.status).toBe('manual_required');
  });
});
