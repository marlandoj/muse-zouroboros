import { selectShared } from './shared-catalog';
import { readFileSync } from 'node:fs';
const [harness,tier]=process.argv.slice(2);
const registry=JSON.parse(readFileSync(new URL('../executor/registry/executor-registry.json',import.meta.url),'utf8'));
const entry=registry.executors.find((e:any)=>e.id===harness);
const route=selectShared('swarm',{harness,tier})[0]||selectShared('swarm',{harness})[0];
const model=entry?.modelPins?.[tier||'mid']||route?.model||entry?.modelRouter?.tierMap?.[tier||'mid']||entry?.modelRouter?.defaultModel;
if(model)process.stdout.write(model);
