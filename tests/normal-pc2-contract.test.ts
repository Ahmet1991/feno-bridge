import {afterAll,test,expect} from 'bun:test';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {randomUUID} from 'node:crypto';
import { trackTempDirectories } from './support/temp-directories';

const mkdtempSync = trackTempDirectories(afterAll);
test('actual isolated native MCP discovery preserves exactly the six 5.0.96 tools and their input contracts',async()=>{
  const root=mkdtempSync(join(tmpdir(),'pc2-mcp-contract-'));
  const broker=process.platform==='win32'?'\\\\.\\pipe\\pc2-contract-'+randomUUID():join(root,'broker.sock');
  const env=Object.fromEntries(Object.entries(process.env).filter((p):p is [string,string]=>typeof p[1]==='string'));
  const transport=new StdioClientTransport({command:process.execPath,args:[join(import.meta.dir,'../src/cli.ts'),'mcp','--contract','native','--broker-socket',broker],cwd:root,env:{...env,HOME:root,USERPROFILE:root,CODEX_CHATGPT_WEB_HOME:root,CODEX_HOME:join(root,'codex'),CODEX_WEB_GPT_DEV_HOME:join(root,'dev'),CODEX_CHATGPT_WEB_PRODUCTION_HOME:join(root,'production'),FENO_PC_COORDINATION_DIR:join(root,'coord')},stderr:'pipe'});
  const client=new Client({name:'isolated-pc2-contract-test',version:'1'});
  try{
    await client.connect(transport);const {tools}=await client.listTools();
    const fields:Record<string,string[]>={
      codex_exec:['turn_token','cmd','workdir','yield_time_ms','max_output_tokens','tty','sandbox_permissions','justification','prefix_rule'],
      codex_write_stdin:['turn_token','session_id','chars','yield_time_ms','max_output_tokens'],
      codex_apply_patch:['turn_token','patch'],codex_view_image:['turn_token','path','detail'],
      codex_tool_inventory:['turn_token','query','offset','limit','include_schema'],
      codex_tool_call:['turn_token','wire_name','arguments','input'],
    };
    const codexTools=tools.filter(t=>t.name.startsWith('codex_'));
    expect(codexTools.map(t=>t.name).sort()).toEqual(Object.keys(fields).sort());
    for(const tool of codexTools){
      expect(Object.keys(tool.inputSchema.properties??{}).sort()).toEqual(fields[tool.name]!.sort());
      const token=tool.inputSchema.properties?.turn_token as {minLength:number;maxLength:number};
      expect(token.minLength).toBe(20);expect(token.maxLength).toBe(256);
      expect(tool.inputSchema.required).toContain('turn_token');
    }
  }finally{await client.close();}
},15000);
