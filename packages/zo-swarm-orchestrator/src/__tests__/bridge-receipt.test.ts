import {describe, expect, test} from 'bun:test';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {parseTaskResult} from '../schemas/swarm-schemas';
const bridgeDir=join(import.meta.dir,'../executor/bridges');
function receipt(kind:string, text:string, selected:string) {
 const dir=mkdtempSync(join(tmpdir(),'bridge-receipt-'));
 try {
  const output=join(dir,'stdout');const result=join(dir,'result.json');writeFileSync(output,text);
  const proc=spawnSync('python3',[join(bridgeDir,'bridge-receipt.py'),kind,output,selected],{encoding:'utf8',env:{PATH:process.env.PATH,RESULT_PATH:result,SWARM_TASK_ID:'test'}});
  return {status:proc.status,result:proc.status===0?parseTaskResult(readFileSync(result,'utf8')):undefined};
 } finally {rmSync(dir,{recursive:true,force:true});}
}
describe('bridge model receipts',()=>{
 test('Pi preserves response identity through the typed parser',()=>{
  const r=receipt('pi',JSON.stringify({type:'message_end',message:{role:'assistant',model:'hf:zai-org/GLM-5.3-Flash',provider:'synthetic',stopReason:'stop',content:[{type:'text',text:'done'}]}}),'synthetic/hf:zai-org/GLM-5.3-Flash');
  expect(r.status).toBe(0);expect(r.result?.modelUsed).toBe('synthetic/hf:zai-org/GLM-5.3-Flash');expect(r.result?.modelProvenance?.selectionEvidence).toBe('provider-response');
 });
 test('Pi reports actual fallback identity rather than inventing the requested model',()=>{
  const r=receipt('pi',JSON.stringify({type:'message_end',message:{role:'assistant',model:'different',provider:'provider',content:[{type:'text',text:'done'}]}}),'requested/model');
  expect(r.result?.modelUsed).toBe('provider/different');expect(r.result?.modelProvenance?.requestedModel).toBe('requested/model');
 });
 test('Pi refuses completed-response claims with no model evidence',()=>{
  expect(receipt('pi','plausible prose','requested/model').status).not.toBe(0);
  expect(receipt('pi',JSON.stringify({type:'message_end',message:{role:'assistant',model:'m',provider:'p',stopReason:'error'}}),'p/m').status).not.toBe(0);
 });
 test('Kimi reports explicit argument evidence, not response attestation',()=>{
  const r=receipt('kimi','done','kimi-k3');expect(r.status).toBe(0);expect(r.result?.modelUsed).toBe('kimi-k3');expect(r.result?.modelProvenance?.selectionEvidence).toBe('cli-argument');
 });
 test('Hermes foreground wrapper retains limits and operator pause results',()=>{
  const code=`import importlib.util,types\ns=importlib.util.spec_from_file_location('adapter',${JSON.stringify(join(bridgeDir,'hermes-acp-sync.py'))})\nm=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nseen={}\ndef delegate(**kw):\n seen.update(kw)\n return 'spawning is paused'\nfake=types.SimpleNamespace(delegate_task=delegate)\nm.install_foreground_delegation(fake)\nassert fake.delegate_task(background=True,max_iterations=7,role='leaf',parent_agent='parent')=='spawning is paused'\nassert seen==dict(background=False,max_iterations=7,role='leaf',parent_agent='parent')\n`;
  const r=spawnSync('python3',['-c',code],{encoding:'utf8'});expect(r.stderr).toBe('');expect(r.status).toBe(0);
 });
});
