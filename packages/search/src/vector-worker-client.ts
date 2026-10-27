import { Worker } from 'node:worker_threads';

type Hit = {rowid: number; distance: number};
/** A private, persistent read-only connection. Slow SQLite calls never block MCP stdio. */
export class VectorWorkerClient {
  private worker?: Worker;
  private nextId = 0;
  private pending = new Map<number, {resolve: (hits:Hit[])=>void; reject: (error:Error)=>void; timer:ReturnType<typeof setTimeout>}>();
  constructor(private path:string, private table:string, private timeoutMs=30_000) {}
  query(vector:number[], limit:number, warmup=false):Promise<Hit[]> {
    const worker = this.worker ??= this.start();
    worker.ref();
    const id = ++this.nextId;
    return new Promise((resolve,reject) => {
      const timer=setTimeout(()=>this.fail(worker,new Error('Vector search worker timed out')),this.timeoutMs);
      this.pending.set(id,{resolve,reject,timer});
      worker.postMessage({id,vector,limit,warmup});
    });
  }
  private start() {
    const bundled=import.meta.url.endsWith('.js');
    const worker=new Worker(new URL(bundled?'../workers/vector-worker.js':'./vector-worker.ts',import.meta.url), {workerData:{path:this.path,table:this.table}});
    worker.on('message', (message:{id:number;hits:Hit[];error?:string}) => {
      const request=this.pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);this.pending.delete(message.id);
      if(message.error)request.reject(new Error(message.error));else request.resolve(message.hits);
      if(!this.pending.size)worker.unref();
    });
    worker.on('error',error=>this.fail(worker,error));
    worker.on('exit',code=>{if(this.worker===worker)this.fail(worker,new Error(`Vector worker exited (${code})`));});
    worker.unref();
    return worker;
  }
  private fail(worker:Worker,error:Error) {
    if(this.worker!==worker)return;
    this.worker=undefined;
    for(const request of this.pending.values()){clearTimeout(request.timer);request.reject(error);}
    this.pending.clear();void worker.terminate();
  }
  close() {if(this.worker)this.fail(this.worker,new Error('Vector worker closed'));}
}
