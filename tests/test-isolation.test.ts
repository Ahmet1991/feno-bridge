import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getCodexHome } from "../src/codex-integration-shared";
import { getConfigDir } from "../src/config";
import { restoreTestHomes, TEST_BRIDGE_HOME, TEST_CODEX_HOME } from "./support/isolate-homes";
import { StdioClientTransport } from "./fixtures/isolated-mcp-transport";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { defaultConfig } from "../src/config";

test("tests resolve throwaway homes, never the live bridge or Codex state", () => {
  expect(resolve(getConfigDir())).toBe(resolve(TEST_BRIDGE_HOME));
  expect(resolve(getCodexHome())).toBe(resolve(TEST_CODEX_HOME));
  expect(resolve(getConfigDir())).not.toBe(resolve(join(homedir(), ".codex-chatgpt-web")));
  expect(resolve(getCodexHome())).not.toBe(resolve(join(homedir(), ".codex")));
});

test("restoring after a test returns to the throwaway homes instead of the live defaults", () => {
  // Read through a function: after `delete`, TypeScript narrows a direct property read to undefined.
  const read = (name: string) => process.env[name];
  process.env.CODEX_CHATGPT_WEB_HOME = "/elsewhere/bridge";
  delete process.env.CODEX_HOME;
  restoreTestHomes();
  expect(read("CODEX_CHATGPT_WEB_HOME")).toBe(TEST_BRIDGE_HOME);
  expect(read("CODEX_HOME")).toBe(TEST_CODEX_HOME);
});

test("a configured MCP child writes request records only under its private fixture home", async()=>{
  const transport=new StdioClientTransport({command:process.execPath,args:[resolve(import.meta.dir,'../src/cli.ts'),'mcp','--contract','native'],stderr:'pipe'});
  const core=join(transport.fixtureHome,'core');
  mkdirSync(join(core,'runtime','pc2-normal'),{recursive:true});
  writeFileSync(join(core,'config.json'),JSON.stringify(defaultConfig('browser-only')));
  const client=new Client({name:'fixture-isolation-proof',version:'1'});
  try{
    await client.connect(transport);
    await client.callTool({name:'pc_status',arguments:{}});
    const file=join(core,'runtime','pc2-normal','pc-mcp-requests.jsonl');
    let rows='';
    for(let i=0;i<30;i++){
      try{rows=readFileSync(file,'utf8');}catch{}
      if(rows.includes('pc_status'))break;
      await Bun.sleep(20);
    }
    expect(rows).toContain('fixture-isolation-proof');
    expect(rows).toContain('pc_status');
    expect(core).not.toBe(resolve(join(homedir(),'.codex-chatgpt-web')));
  }finally{await client.close();}
},15000);
