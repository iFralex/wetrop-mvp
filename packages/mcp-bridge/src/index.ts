/** Persistent MCP connectors, independently started and shared by the host. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { SearchPreparationResultSchema } from '@steward/search';
import { connectorEnvironment } from './environment.ts';
import {CalendarStatusResultSchema,type CalendarDiagnostics} from './calendar-status.ts';
export { connectorEnvironment } from './environment.ts';

export interface McpServerSpec {
  command:string;
  args:string[];
  callTimeoutMs?:number;
  /** Explicit connector-specific overrides, applied after Steward's allowlist. */
  env?:Record<string,string>;
}
export interface ConnectorState {
  state:'connecting'|'ready'|'error'|'closed';
  tools:string[];
  error?:string;
}
export interface McpBridge {
  tools:ToolDefinition[];
  callTool(toolName:string,args:Record<string,unknown>):Promise<unknown>;
  close():Promise<void>;
  connectorStates?():Record<string,ConnectorState>;
  waitForServer?(server:string):Promise<void>;
  prepareSearch?(server:string):Promise<{skipped?:string}>;
  calendarStatus?():Promise<CalendarDiagnostics>;
  activeCalls?:number;
  firstReady?:Promise<void>;
  settled?:Promise<void>;
}
export function startMcpBridge(specs:Record<string,McpServerSpec>):McpBridge {
  const clients=new Map<string,Client>();
  const states:Record<string,ConnectorState>={};
  const tools:ToolDefinition[]=[];
  let closed=false, activeCalls=0;
  let firstReadyResolve!:()=>void;
  const firstReady=new Promise<void>(resolve=>{firstReadyResolve=resolve;});
  const connecting=new Map<string,Promise<void>>();
  const call=async(toolName:string,args:Record<string,unknown>)=>{
    const parsed=/^mcp__(.+?)__(.+)$/.exec(toolName);
    if(!parsed)throw new Error(`Invalid MCP tool name: ${toolName}`);
    const [,server,tool]=parsed;
    activeCalls++;
    try {
      await connecting.get(server);
      const client=clients.get(server);
      if(!client)throw new Error(`MCP server not available: ${server}`);
      const res=await client.callTool({name:tool,arguments:args??{}},undefined,
        specs[server].callTimeoutMs?{timeout:specs[server].callTimeoutMs}:undefined);
      if (res.isError) {const error=new Error((res.content as any[] ?? []).filter(c=>c.type==='text').map(c=>c.text).join('\n') || 'MCP tool failed');error.name='McpToolError';throw error;}

      return res.content as any[] ??[{type:'text',text:''}];
    } finally {activeCalls--;}
  };
  for(const [server,spec]of Object.entries(specs)) {
    states[server]={state:'connecting',tools:[]};
    const client=new Client({name:`host-${server}`,version:'0.0.0'});
    clients.set(server,client);
    client.onerror=err=>console.warn(`[mcp-bridge] ${server}: ${err?.message??err}`);
    client.onclose=()=>{if(states[server].state==='ready')states[server]={...states[server],state:'error',error:'Connector disconnected'};};
    const pending=(async()=>{
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(new Error('Connector startup timed out')),10_000);
      try {
        await client.connect(new StdioClientTransport({command:spec.command,args:spec.args,
          env:{...connectorEnvironment(server),...spec.env}}),{signal:controller.signal});
        const result=await client.listTools(undefined,{signal:controller.signal});
        if(closed)return;
        for(const tool of result.tools) {
          const name=`mcp__${server}__${tool.name}`;
          tools.push({name,label:tool.name,description:tool.description??tool.name,parameters:tool.inputSchema as any,
            prepareArguments:(args:unknown)=>args as any,
            execute:async(_id:string,args:any)=>({content:await call(name,args),details:{}})} as ToolDefinition);
        }
        states[server]={state:'ready',tools:result.tools.map(tool=>tool.name)};
        firstReadyResolve();
      } catch(error) {
        states[server]={state:'error',tools:[],error:error instanceof Error?error.message:String(error)};
        clients.delete(server);
        try{await client.close();}catch{/* already stopped */}
      } finally {clearTimeout(timer);}
    })();
    connecting.set(server,pending);
  }
  const settled=Promise.all(connecting.values()).then(()=>{firstReadyResolve();});
  return {tools,callTool:call,firstReady,settled,get activeCalls(){return activeCalls;},
    connectorStates:()=>Object.fromEntries(Object.entries(states).map(([key,value])=>[key,{...value,tools:[...value.tools]}])),
    waitForServer:async server=>{
      await connecting.get(server);
      if(states[server]?.state!=="ready")throw new Error(`MCP server not available: ${server}`);
    },
    prepareSearch:async server=>{
      await connecting.get(server);
      const client=clients.get(server);
      if(!client||states[server]?.state!=='ready')throw new Error(`MCP server not available: ${server}`);
      try {return await client.request({method:'steward/prepareSearch'},SearchPreparationResultSchema,{timeout:35_000});}
      catch(error) {
        if((error as {code?:number}).code===ErrorCode.MethodNotFound)return {skipped:'Connector does not support search preparation'};
        throw error;
      }
    },
    calendarStatus:async()=>{
      const client=clients.get('calendar');
      if(!client||states.calendar?.state!=='ready')throw new Error('Calendar connector is not ready');
      activeCalls++;
      try {return await client.request({method:'steward/calendarStatus'},CalendarStatusResultSchema,{timeout:5_000});}
      finally {activeCalls--;}
    },
    close:async()=>{
      closed=true;
      await Promise.allSettled([...clients.values()].map(client=>client.close()));
      await settled;
      clients.clear();
      for(const state of Object.values(states))state.state='closed';
    }};
}
/** Full-catalog initialization for one-shot callers and existing integrations. */
export async function buildMcpBridge(specs:Record<string,McpServerSpec>):Promise<McpBridge> {
  const bridge=startMcpBridge(specs);
  await bridge.settled;
  return bridge;
}
