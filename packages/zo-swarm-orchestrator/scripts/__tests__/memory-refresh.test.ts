import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { refreshMemoryFacts } from '../../../../scripts-vps/refresh-memory-qdrant';

test('incremental refresh embeds changed facts only and never recreates a collection', async () => {
  const root=mkdtempSync(join(tmpdir(),'memory-refresh-'));
  const dbPath=join(root,'facts.db'); const db=new Database(dbPath);
  db.run('CREATE TABLE facts(id TEXT,persona TEXT,entity TEXT,key TEXT,value TEXT,text TEXT,category TEXT,decay_class TEXT,importance REAL,source TEXT,confidence REAL)');
  db.run("INSERT INTO facts VALUES ('one','shared','fixture','value','unchanged','unchanged','fact','stable',1,'fixture',1), ('two','shared','fixture','value','new content','new content','fact','stable',1,'fixture',1)");db.close();
  const requests: Array<{method:string,body:any}>=[]; let embeddings=0;
  const payload={collection:'shared-memory-facts',fact_id:'one',persona:'shared',entity:'fixture',key:'value',value:'unchanged',category:'fact',decay_class:'stable',importance:1,confidence:1,source:'fixture',content:'Entity: fixture\nKey: value\nValue: unchanged'};
  const fetcher=(async(input:any,init:any)=>{
    const url=String(input);requests.push({method:init.method,body:init.body?JSON.parse(init.body):null});
    const result=url.endsWith('/scroll') ? {points:[{id:9,payload}],next_page_offset:null}
      : init.method==='GET' ? {config:{params:{vectors:{size:1536,distance:'Cosine'}}}} : {};
    return new Response(JSON.stringify({result}),{status:200});
  }) as typeof fetch;
  try {
    const options={dbPath,url:'http://fixture',fetcher,embed:async()=>{embeddings++;return Array(1536).fill(0.1);}};
    const preview=await refreshMemoryFacts(options);
    expect(preview).toMatchObject({unchanged:1,embedded:1,applied:false});expect(embeddings).toBe(0);
    expect(requests.filter(r=>r.method==='PUT')).toHaveLength(0);
    const applied=await refreshMemoryFacts({...options,apply:true});
    expect(applied).toMatchObject({unchanged:1,embedded:1,applied:true});expect(embeddings).toBe(1);
    const writes=requests.filter(r=>r.method==='PUT');expect(writes).toHaveLength(1);
    expect(writes[0].body.points[0].payload.fact_id).toBe('two');
    expect(requests.some(r=>r.method==='DELETE')).toBe(false);
    requests.length=0;
    await expect(refreshMemoryFacts({...options,apply:true,embed:async()=>[NaN]})).rejects.toThrow('Invalid production embedding');
    expect(requests.filter(r=>r.method==='PUT')).toHaveLength(0);
    requests.length=0;
    payload.importance=0.5;
    await refreshMemoryFacts({...options,apply:true});
    expect(requests.filter(r=>r.method==='POST' && r.body?.points)).toEqual([
      expect.objectContaining({body:expect.objectContaining({points:[9],payload:expect.objectContaining({importance:1})})}),
    ]);
    expect(embeddings).toBe(2); // Only the new fact embeds; metadata edits reuse its existing vector.
  } finally {rmSync(root,{recursive:true,force:true});}
});
