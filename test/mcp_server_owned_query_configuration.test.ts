import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const sdk=vi.hoisted(()=>({connect:vi.fn(),list:vi.fn(),call:vi.fn(),transports:[] as any[]}));
vi.mock('@modelcontextprotocol/sdk/client/index.js',()=>({Client:class {connect= sdk.connect;listTools=sdk.list;callTool=sdk.call;}}));
vi.mock('../server/mcp/client/transport',()=>({createMCPTransport:vi.fn((_name:string,config:any)=>{const value={config,close:vi.fn(async()=>{})};sdk.transports.push(value);return value;})}));
import { MCPClientManager } from '../server/mcp/client';
import { getDataDirectory } from '../server/config/data_path';
import { makeApp } from './helpers';
let app:Awaited<ReturnType<typeof makeApp>>, manager:MCPClientManager, configPath:string;
const configuration={enabled:true,source:'external' as const,transport:'http' as const,url:'https://agent.qcc.com/mcp/company/stream',headers:{Authorization:'Bearer fixture-private-key'}};
beforeAll(async()=>{app=await makeApp();});afterAll(()=>app.cleanup());
beforeEach(()=>{configPath=path.join(getDataDirectory('qcc-config-fixture'),crypto.randomUUID()+'.json');manager=new MCPClientManager(configPath);manager.saveConfig({});sdk.connect.mockReset().mockResolvedValue(undefined);sdk.list.mockReset().mockResolvedValue({tools:[{name:'get_company_registration_info',inputSchema:{type:'object'}}]});sdk.call.mockReset().mockResolvedValue({content:[{type:'text',text:'{"企业名称":"虚构主体"}'}]});sdk.transports=[];});
afterEach(async()=>{await manager.disconnectAll();});
describe('server-owned MCP query configuration reuses the existing manager',()=>{
 it('connects once, calls once and does not persist its secret or register its full inventory',async()=>{
  const before=fs.readFileSync(configPath,'utf8');const result=await manager.callToolForServer('qcc-company','get_company_registration_info',{searchKey:'虚构主体'},{configuration});
  expect(result).toContain('虚构主体');expect(sdk.connect).toHaveBeenCalledTimes(1);expect(sdk.list).toHaveBeenCalledTimes(1);expect(sdk.call).toHaveBeenCalledExactlyOnceWith({name:'get_company_registration_info',arguments:{searchKey:'虚构主体'}});
  expect(fs.readFileSync(configPath,'utf8')).toBe(before);expect(manager.getConfig()['qcc-company']).toBeUndefined();expect(manager.getRoutableServers()).toEqual([]);expect(manager.getConnectedServers()).toEqual(['qcc-company']);
 });
 it('preserves an explicitly disabled saved connection',async()=>{manager.saveConfig({'qcc-company':{...configuration,enabled:false}});await expect(manager.callToolForServer('qcc-company','get_company_registration_info',{searchKey:'虚构主体'},{configuration})).rejects.toThrow('disabled');expect(sdk.connect).not.toHaveBeenCalled();expect(sdk.call).not.toHaveBeenCalled();});
 it('preserves a same-fingerprint pending saved installation before using transient configuration',async()=>{manager.saveConfig({'qcc-company':{...configuration,installationState:'pending'}});await expect(manager.callToolForServer('qcc-company','get_company_registration_info',{searchKey:'虚构主体'},{configuration})).rejects.toThrow('pending activation');expect(sdk.connect).not.toHaveBeenCalled();expect(sdk.call).not.toHaveBeenCalled();});
 it('does not replace a separately configured owner or endpoint',async()=>{manager.saveConfig({'qcc-company':{...configuration,url:'https://other.invalid/mcp'}});await expect(manager.callToolForServer('qcc-company','get_company_registration_info',{searchKey:'虚构主体'},{configuration})).rejects.toThrow('different managed configuration');expect(sdk.connect).not.toHaveBeenCalled();expect(sdk.call).not.toHaveBeenCalled();});
 it('cannot substitute an external connection for an installed local managed identity',async()=>{manager.saveConfig({'qcc-company':{enabled:true,source:'local',command:'managed-fixture',managedSkill:{sourceId:'trusted-fixture'} as any}});await expect(manager.callToolForServer('qcc-company','get_company_registration_info',{searchKey:'虚构主体'},{configuration})).rejects.toThrow('different managed configuration');expect(sdk.connect).not.toHaveBeenCalled();expect(sdk.call).not.toHaveBeenCalled();});
 it('reuses matching live configuration and retires the old transport when the server key changes',async()=>{
  await manager.callToolForServer('qcc-company','get_company_registration_info',{searchKey:'虚构主体'},{configuration});await manager.callToolForServer('qcc-company','get_company_registration_info',{searchKey:'虚构主体'},{configuration});expect(sdk.connect).toHaveBeenCalledTimes(1);expect(sdk.call).toHaveBeenCalledTimes(2);
  await manager.callToolForServer('qcc-company','get_company_registration_info',{searchKey:'虚构主体'},{configuration:{...configuration,headers:{Authorization:'Bearer replacement-fixture'}}});expect(sdk.connect).toHaveBeenCalledTimes(2);expect(sdk.transports[0].close).toHaveBeenCalledTimes(1);expect(fs.readFileSync(configPath,'utf8')).not.toContain('replacement-fixture');
 });
 it('propagates a protocol error without a second call or fallback connection',async()=>{sdk.call.mockResolvedValueOnce({isError:true,content:[{type:'text',text:'Controlled denied'}]});await expect(manager.callToolForServer('qcc-company','get_company_registration_info',{searchKey:'虚构主体'},{configuration})).rejects.toThrow('Controlled denied');expect(sdk.call).toHaveBeenCalledTimes(1);expect(sdk.connect).toHaveBeenCalledTimes(1);});
});
