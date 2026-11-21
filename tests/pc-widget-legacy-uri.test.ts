import {expect,test} from 'bun:test';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {ErrorCode} from '@modelcontextprotocol/sdk/types.js';
import {PcAuthorizer} from '../src/pc-control/authorization';
import {registerPcTools,type PcHost} from '../src/pc-control/mcp-tools';
import {PC_SCREENSHOT_URI,PC_SCREENSHOT_SKYBRIDGE_URI} from '../src/pc-control/screenshot-widget';
import {PC_PROBE_MCP_APP_URI,PC_PROBE_SKYBRIDGE_URI} from '../src/pc-control/widget-probe';
import {version} from '../package.json';

const current=[PC_SCREENSHOT_URI,PC_SCREENSHOT_SKYBRIDGE_URI,PC_PROBE_MCP_APP_URI,PC_PROBE_SKYBRIDGE_URI];

test('cached widget URIs resolve to the current resource without advertising aliases',async()=>{
  const server=new McpServer({name:'widget-uri-test',version});
  registerPcTools(server,{authorizer:new PcAuthorizer({profileId:'pc2-normal'}),host:{} as PcHost,pcWidgetProbes:true});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  const client=new Client({name:'widget-uri-client',version});
  await server.connect(serverTransport);
  try{
    await client.connect(clientTransport);
    expect((await client.listResources()).resources.map(r=>r.uri).sort()).toEqual([...current].sort());
    for(const uri of current){
      const actual=await client.readResource({uri});
      expect(actual.contents[0].uri).toBe(uri);
      for(const old of ['5.1.23','5.0.96']){
        const alias=uri.replace(`v${version}.html`,`v${old}.html`);
        const result=await client.readResource({uri:alias});
        expect(result).toEqual({...actual,contents:[{...actual.contents[0],uri:alias}]});
      }
      for(const invalid of ['','5.1','5.1.30.1','9.9.9','5.1.31','0000.1.1','../5.1.23','%35.1.23','5.1.23\n']){
        await expect(client.readResource({uri:uri.replace(`v${version}.html`,`v${invalid}.html`)})).rejects.toMatchObject({code:ErrorCode.InvalidParams});
      }
      for(const malformed of [uri+'?x=1',uri+'#x',uri+'\n',' '+uri,uri.replace('ui:','UI:'),uri.replace('widget','WIDGET'),uri.replace('/widget/','/widget/../'),uri.replace('/widget/','/widget/./'),uri.replace('/widget/','/widget/sub/../')]){
        await expect(client.readResource({uri:malformed})).rejects.toMatchObject({code:ErrorCode.InvalidParams});
      }
    }
    const tools=(await client.listTools()).tools;
    const advertised=new Set<string>();
    for(const tool of tools){
      const meta=tool._meta as {ui?:{resourceUri?:string};'openai/outputTemplate'?:string}|undefined;
      for(const uri of [meta?.ui?.resourceUri,meta?.['openai/outputTemplate']])if(uri){
        expect(current).toContain(uri);advertised.add(uri);
      }
    }
    expect(advertised.has(PC_SCREENSHOT_SKYBRIDGE_URI)).toBeTrue();
    expect(advertised.has(PC_PROBE_MCP_APP_URI)).toBeTrue();
    expect(advertised.has(PC_PROBE_SKYBRIDGE_URI)).toBeTrue();
  }finally{
    await client.close();await server.close();
  }
});
