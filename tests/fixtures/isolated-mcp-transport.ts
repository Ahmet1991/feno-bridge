import {StdioClientTransport as NativeTransport,type StdioServerParameters} from '@modelcontextprotocol/sdk/client/stdio.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

/** Every stdio test gets a private home, including tests which supply their own fixture config. */
export class StdioClientTransport extends NativeTransport {
  readonly fixtureHome:string;
  constructor(parameters:StdioServerParameters){
    const home=mkdtempSync(join(tmpdir(),'feno-mcp-test-'));
    const cwd=parameters.cwd??process.cwd();
    const args=parameters.args?.map(arg=>arg==='src/cli.ts'?resolve(cwd,arg):arg);
    super({...parameters,args,cwd:home,env:{...process.env as Record<string,string>,
      HOME:home,USERPROFILE:home,CODEX_CHATGPT_WEB_HOME:join(home,'core'),CODEX_HOME:join(home,'codex'),
      CODEX_CHATGPT_WEB_PRODUCTION_HOME:join(home,'production'),CODEX_WEB_GPT_DEV_HOME:join(home,'dev'),
      CODEX_WEB_GPT_DEV_INSTALL_DIR:join(home,'dev-install'),FENO_PC_COORDINATION_DIR:join(home,'coord'),
      LOCALAPPDATA:join(home,'appdata'),APPDATA:join(home,'roaming'),ProgramFiles:join(home,'programs'),'ProgramFiles(x86)':join(home,'programs-x86'),
      ...parameters.env}});
    this.fixtureHome=home;
  }
  override async close(){try{await super.close();}finally{rmSync(this.fixtureHome,{recursive:true,force:true});}}
}
