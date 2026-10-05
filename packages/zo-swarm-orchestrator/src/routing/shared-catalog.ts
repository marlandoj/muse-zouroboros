import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// 'consensus' remains readable for historical evidence, but is never an active consumer.
export type Consumer = 'swarm' | 'chat' | 'automation' | 'consensus' | 'factory';
export type Failure = 'ok' | 'slow' | 'timeout' | 'authentication' | 'quota' | 'model_not_found' | 'outage' | 'transport' | 'invalid_response';
export interface Probe { at: string; category: Failure; latencyMs: number | null; passed: boolean; caseId: string; transport: string; }
export interface Route {
  id: string; harness: string; provider: string; model: string; providerModel: string;
  family: string; tier: 'light'|'mid'|'heavy'; openWeight: boolean;
  price: { inputPerMillion: number|null; outputPerMillion: number|null; evidence: string|null; at: string|null };
  capabilities: { context: number|null; advertised: string[]; verified: string[] };
  availability: 'unverified'|'available'|'unavailable'; discoveredAt: string|null;
  qualifications: Partial<Record<Consumer, { at: string; transport: string; probes: Probe[]; passingDays?: string[]; firstSeen?: string }>>;
  health: Probe[];
  qualificationAttempts?: Partial<Record<Consumer,{at:string;passed:boolean}>>;
}
export interface SharedCatalog {
  version: 1; generatedAt: string; routes: Route[]; sources: Record<string,{at:string;count:number;error?:string}>;
  nominations: unknown[]; sha256: string;
}
export const sharedPath = () => process.env.ZOUROBOROS_MODEL_CATALOG_PATH || '/var/lib/zouroboros/model-routing/current.json';
export function digest(c: Omit<SharedCatalog,'sha256'>|SharedCatalog): string {
  const {sha256: _, ...body}=c as SharedCatalog;
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}
export function validCatalog(c: any): c is SharedCatalog {
  return c?.version===1 && Array.isArray(c.routes) && c.routes.every((r:any)=>typeof r.id==='string'&&typeof r.model==='string'&&typeof r.family==='string'&&r.qualifications&&Array.isArray(r.health)) && new Set(c.routes.map((r:Route)=>r.id)).size===c.routes.length && c.sha256===digest(c);
}
export function readSharedCatalog(path=sharedPath()): SharedCatalog|null {
  for(const p of [path,join(dirname(path),'last-known-good.json')]) {
    try {const c=JSON.parse(readFileSync(p,'utf8'));if(validCatalog(c)) return c;} catch {}
  }
  return null;
}
export function family(model: string): string {
  const s=model.toLowerCase();
  for(const [name,re] of Object.entries({claude:/claude|\bopus\b|\bsonnet\b|\bhaiku\b/,gpt:/gpt|codex|openai/,gemini:/gemini/,kimi:/kimi|moonshot/,glm:/glm|zai-org|z-ai/,deepseek:/deepseek/,qwen:/qwen/,llama:/llama/,mistral:/mistral/,nemotron:/nemotron/})) if(re.test(s)) return name;
  return 'unknown';
}
export function healerExcluded(r: Pick<Route,'model'|'providerModel'>): boolean {
  return /qwen3[.\-_]?8|kimi-code\/k3|kimi-for-coding-highspeed/i.test(r.model+' '+r.providerModel);
}
export function fresh(at:string,maxMs:number,now=Date.now()):boolean {const age=now-Date.parse(at);return Number.isFinite(age)&&age>=0&&age<=maxMs;}
export function confirmedUnavailable(probes: Probe[],now=Date.now()): boolean {
  const last=probes.slice(-2);
  return last.length===2 && last.every(p=>fresh(p.at,30*60_000,now)&&['authentication','quota','model_not_found','outage'].includes(p.category)) && Date.parse(last[1]!.at)-Date.parse(last[0]!.at)>=1000;
}
export function qualified(r:Route,consumer:Consumer,now=Date.now()):boolean {
  if(consumer==='consensus')return false; // Retired; replaced by persona-based Diversity of Thought.
  if(r.harness==='cursor' || r.family==='unknown' || r.availability==='unavailable') return false;
  const q=r.qualifications[consumer];
  if(consumer==='swarm') {
    try {
      const registry=JSON.parse(readFileSync(new URL('../executor/registry/executor-registry.json',import.meta.url),'utf8'));
      const entry=registry.executors.find((e:any)=>e.id===r.harness);
      const actual=entry?.transportFallback&&process.env[entry.transportFallback.envVar]===entry.transportFallback.equals?entry.transportFallback.transport:entry?.transport||'bridge';
      // Shell canaries cannot promote an ACP route. Existing bridge evidence remains valid for bridge callers.
      if(actual==='acp'&&!q?.transport.startsWith('swarm:acp:'))return false;
      if(actual==='bridge'&&q?.transport.startsWith('swarm:acp:'))return false;
    }catch{return false;}
  }
  // The pinned Command Center persona dispatcher selects its harness from the
  // model identifier. An isolated Pi pass must not advertise an OpenCode chat route.
  if(consumer==='chat') {
    const expected=/^(sonnet|opus|haiku|claude)/i.test(r.model)?'claude-code':/^(gpt-|o\d|codex)/i.test(r.model)?'codex':/^gemini/i.test(r.model)?'gemini':/^(kimi|moonshot)/i.test(r.model)?'kimi':/^(synthetic-direct|openrouter)\//i.test(r.model)?'opencode':null;
    if(expected!==r.harness)return false;
  }
  if(!q || !fresh(q.at,7*86400_000,now) || q.probes.length<3 || !q.probes.every(p=>p.passed&&p.transport===q.transport)) return false;
  if(consumer==='automation' && healerExcluded(r)) return false;

  return !confirmedUnavailable(r.health.filter(p=>p.transport.startsWith(consumer+':')),now);
}
export function selectShared(consumer:Consumer,options:{harness?:string;tier?:string;excludeProviders?:string[];catalog?:SharedCatalog|null}={}):Route[] {
  const catalog=options.catalog===undefined?readSharedCatalog():options.catalog;
  return (catalog?.routes||[]).filter(r=>qualified(r,consumer)&&(!options.harness||r.harness===options.harness)&&(!options.excludeProviders?.includes(r.provider))&&(!options.tier||r.tier===options.tier))
    .sort((a,b)=>(a.price.outputPerMillion??Infinity)-(b.price.outputPerMillion??Infinity)||a.id.localeCompare(b.id));
}
export function consensusFamilies(routes:Route[]):boolean {return routes.length>=4&&routes.every(r=>r.family!=='unknown')&&new Set(routes.map(r=>r.family)).size===routes.length;}
export function classifyFailure(text:string,timedOut=false,status?:number): Failure {
  if(timedOut||/timed?\s*out|idle timeout|timeout exceeded/i.test(text)) return 'timeout';
  if(status===401||status===403||/(?:HTTP|API error:)\s*(401|403)|unauth|invalid.*key|authentication|login required|not logged in/i.test(text))return 'authentication';
  if(status===429||/(?:HTTP|API error:)\s*429|quota|rate.limit|usage limit|insufficient.*(credit|balance)|credit.*exhaust/i.test(text))return 'quota';
  if(status===404||/(?:HTTP|API error:)\s*404|model.*(not found|not exist|invalid|unsupported)|unknown model|ModelNotFound/i.test(text))return 'model_not_found';
  if((status&&status>=500)||/(?:HTTP|API error:)\s*5\d\d|overloaded|service unavailable/i.test(text))return 'outage';
  return 'transport';
}
export function healerDecision(primary:Route,current:Route|undefined,alternatives:Route[],now=Date.now()):{route:string;reason:string} {
  const primaryHealth=primary.health.filter(p=>p.transport.startsWith('automation:'));
  const latest=primaryHealth.at(-1);
  if(current&&current.id!==primary.id&&latest?.passed&&fresh(latest.at,30*60_000,now)) return {route:primary.id,reason:'preferred route recovered; latency alone does not block restoration'};
  if(!confirmedUnavailable(primaryHealth,now))return {route:current?.id||primary.id,reason:'no repeated explicit availability failure'};
  const fallback=alternatives.find(r=>{const evidence=r.health.filter(p=>p.transport.startsWith('automation:')).slice(-2);return r.provider!==primary.provider&&r.openWeight&&!healerExcluded(r)&&qualified(r,'automation',now)&&evidence.length===2&&evidence.every(p=>p.passed&&p.category==='ok'&&p.latencyMs!==null&&p.latencyMs<=10000&&fresh(p.at,30*60_000,now))});
  return fallback?{route:fallback.id,reason:'two explicit failures; independent qualified fallback'}:{route:current?.id||primary.id,reason:'no fresh independently qualified fallback'};
}
