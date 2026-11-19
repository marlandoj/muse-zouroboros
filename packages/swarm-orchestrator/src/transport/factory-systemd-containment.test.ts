import { afterEach, describe, expect, test } from 'bun:test';
import { closeSync, fstatSync, ftruncateSync, readFileSync, writeSync } from 'node:fs';
import { parseManagedFactoryPolicy, validateManagedFactoryEvidenceFixture, readManagedFactoryBoundary,
  sealedManagedProfileFixture, prepareManagedFactorySpawn, managedFactoryArgumentsFixture, MANAGED_FACTORY_UNIT } from './factory-systemd-containment';

const saved=process.env.FACTORY_STATE_MODE;
afterEach(()=>{if(saved===undefined)delete process.env.FACTORY_STATE_MODE;else process.env.FACTORY_STATE_MODE=saved;});
const canonical=(v:any):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const pin=(path:string)=>({path,sha256:'a'.repeat(64)});
function policy(){
  const source_root='/opt/factory/runtime';const bin=source_root+'/node_modules/.factory-native/bin';
  return {schema:'factory-managed-systemd-boundary/v1',unit_inputs_sha256:'a'.repeat(64),execution_sha256:'b'.repeat(64),unit_fragment_sha256:'c'.repeat(64),
    source_root,source_head:'d'.repeat(40),registry_sha256:'e'.repeat(64),worker_uid:1004,worker_gid:1004,
    workdir:'/var/lib/factory/work',home:'/var/lib/factory/home',state_root:'/var/lib/factory/state',harness:'codex',model:'gpt-5.4',
    runtime_ms:300000,timeout_ms:120000,approved_at_ms:1000,expires_at_ms:301000,
    adapter:{...pin(bin+'/codex-acp-swarm'),name:'codex-acp-swarm',args:[]},native:pin(bin+'/codex'),node:pin(bin+'/node'),
    bun:pin('/opt/factory/bun'),bwrap:pin('/usr/bin/bwrap'),systemctl:pin('/usr/bin/systemctl'),python:pin('/usr/bin/python3.13'),
    profile_files:[{path:'.codex/auth.json',sha256:'f'.repeat(64)}],runtime_files:['/usr/bin/nice','/usr/bin/taskset','/usr/lib/x86_64-linux-gnu/libc.so.6'].map(pin)};
}
function evidence(){
  const cgroup='/system.slice/'+MANAGED_FACTORY_UNIT;
  const u={Id:MANAGED_FACTORY_UNIT,LoadState:'loaded',ActiveState:'active',SubState:'running',User:'',Group:'root',MainPID:'123',ControlPID:'0',
    FragmentPath:'/etc/systemd/system/'+MANAGED_FACTORY_UNIT,DropInPaths:'',SourcePath:'',NeedDaemonReload:'no',Transient:'no',Delegate:'no',
    KillMode:'control-group',Restart:'no',Type:'exec',NoNewPrivileges:'yes',ProtectControlGroups:'yes',ProtectSystem:'strict',ProtectHome:'yes',PrivateTmp:'yes',
    ProtectKernelTunables:'no',ProtectKernelLogs:'no',ProtectKernelModules:'yes',PrivateDevices:'yes',
    BindReadOnlyPaths:'/sys:/sys:rbind',SystemCallFilter:'~syslog',
    RestrictNamespaces:'ipc mnt pid user uts',RuntimeMaxUSec:'5min',TimeoutStopUSec:'3s',SendSIGKILL:'yes',FinalKillSignal:'9',MemoryMax:'12884901888',TasksMax:'256',
    ControlGroup:cgroup,InvocationID:'1'.repeat(32)};
  return {cgroup:'0::'+cgroup+'\n',status:'Uid:\t1004\t1004\t1004\t1004\nGid:\t1004\t1004\t1004\t1004\nGroups:\t1004\nNoNewPrivs:\t1\n'+
    ['CapEff','CapPrm','CapInh','CapAmb'].map(k=>k+':\t0000000000000000\n').join('')+'CapBnd:\t00000000000800e4\n',
    supervisor_cgroup:'0::'+cgroup+'\n',supervisor_status:'Uid:\t0\t0\t0\t0\nGid:\t0\t0\t0\t0\nGroups:\t\nNoNewPrivs:\t1\n'+
      ['CapEff','CapPrm','CapBnd'].map(k=>k+':\t00000000000800e4\n').join('')+['CapInh','CapAmb'].map(k=>k+':\t0000000000000000\n').join(''),
    unit:Object.entries(u).map(([k,v])=>k+'='+v).join('\n')+'\n',mountinfo:'1 0 0:1 / / ro - ext4 /dev/root ro\n2 1 0:2 / /sys/fs/cgroup ro - cgroup2 cgroup ro\n',
    mount_ids:{sys:'1',cgroup:'2',runtime:'1'},
    cgroup_type:'domain\n',memory_max:'12884901888\n',pids_max:'256\n',now:2000};
}
describe('root-enrolled managed boundary',()=>{
  test('canonical exact policy binds native package route and remains immutable',()=>{
    const p=parseManagedFactoryPolicy(canonical(policy()));expect(p.adapter.name).toBe('codex-acp-swarm');expect(Object.isFrozen(p.runtime_files)).toBe(true);
    for(const mutate of [ (p:any)=>{p.worker_uid=0;},(p:any)=>{p.model=123;},(p:any)=>{p.source_head=123;},(p:any)=>{p.adapter.args=['--fallback'];},
      (p:any)=>{p.adapter.path='/usr/bin/other';},(p:any)=>{p.native.path='/opt/foreign/codex';},(p:any)=>{p.home=p.source_root+'/home';},
      (p:any)=>{p.workdir='/var/lib/factory';},(p:any)=>{p.home=p.workdir+'/profile';},(p:any)=>{p.workdir='/etc/zouroboros/hermes-issuer/work';},
      (p:any)=>{p.runtime_files=[];},(p:any)=>{p.profile_files[0].sha256=123;},(p:any)=>{p.timeout_ms=120001;},(p:any)=>{p.extra=true;}]){
      const bad=policy();mutate(bad);expect(()=>parseManagedFactoryPolicy(canonical(bad))).toThrow();
    }
    expect(()=>parseManagedFactoryPolicy(JSON.stringify(policy()))).toThrow('canonical');
    expect(()=>parseManagedFactoryPolicy(canonical(policy()).replace('"harness":"codex"','"harness":"claude","harness":"codex"'))).toThrow('canonical');
  });
  test('actual kernel/unit/identity evidence is required together',()=>{
    process.env.FACTORY_STATE_MODE='test';const p=parseManagedFactoryPolicy(canonical(policy()));
    expect(validateManagedFactoryEvidenceFixture(p,evidence())).toBe('1'.repeat(32));
    for(const [key,value] of Object.entries(evidence())){
      const e:any=evidence();e[key]=typeof value==='string'?'unexpected':301000;
      expect(()=>validateManagedFactoryEvidenceFixture(p,e)).toThrow();
    }
    for(const [before,after] of [['Delegate=no','Delegate=yes'],['MemoryMax=12884901888','MemoryMax=21474836480'],['RestrictNamespaces=ipc mnt pid user uts','RestrictNamespaces=~cgroup'],['InvocationID='+'1'.repeat(32),'InvocationID='],['MainPID=123','MainPID=0']]){
      const e=evidence();e.unit=e.unit.replace(before,after);expect(()=>validateManagedFactoryEvidenceFixture(p,e)).toThrow();
    }
    for(const [before,after] of [['Groups:\t1004','Groups:\t1004 999'],['NoNewPrivs:\t1','NoNewPrivs:\t0'],['CapEff:\t0000000000000000','CapEff:\t0000000000000001']]){
      const e=evidence();e.status=e.status.replace(before,after);expect(()=>validateManagedFactoryEvidenceFixture(p,e)).toThrow();
    }
    for(const [before,after] of [['Uid:\t0\t0\t0\t0','Uid:\t1\t1\t1\t1'],['CapEff:\t00000000000800e4','CapEff:\t0000000000080064'],['CapAmb:\t0000000000000000','CapAmb:\t0000000000000080']]){
      const e=evidence();e.supervisor_status=e.supervisor_status.replace(before,after);expect(()=>validateManagedFactoryEvidenceFixture(p,e)).toThrow('supervisor');
    }
    const e=evidence();e.mountinfo+='3 1 0:3 / /opt/factory/runtime rw - ext4 /dev/other rw\n';e.mount_ids.runtime='3';expect(()=>validateManagedFactoryEvidenceFixture(p,e)).toThrow();
    e.mountinfo=evidence().mountinfo;e.now=181000;expect(()=>validateManagedFactoryEvidenceFixture(p,e)).toThrow('approval');
  });
  test('kernel mount IDs reject writable overmounts and accept visible readonly stacks independent of row order',()=>{
    process.env.FACTORY_STATE_MODE='test';const p=parseManagedFactoryPolicy(canonical(policy()));
    const lower='4 1 0:4 / /sys rw - sysfs sysfs rw\n';const upper='5 4 0:4 / /sys ro - sysfs sysfs rw\n';
    for(const stack of [lower+upper,upper+lower]){
      const e=evidence();e.mountinfo+=stack;e.mount_ids.sys='5';expect(validateManagedFactoryEvidenceFixture(p,e)).toBe('1'.repeat(32));
      e.mount_ids.sys='4';expect(()=>validateManagedFactoryEvidenceFixture(p,e)).toThrow('kernel');
      e.mount_ids.sys='99';expect(()=>validateManagedFactoryEvidenceFixture(p,e)).toThrow('kernel');
      e.mount_ids.sys='5';e.mountinfo+=upper;expect(()=>validateManagedFactoryEvidenceFixture(p,e)).toThrow('kernel');
    }
  });
  test('raw fixture and environment cannot manufacture issued spawn authority',()=>{
    process.env.FACTORY_STATE_MODE='test';const p=parseManagedFactoryPolicy(canonical(policy()));
    expect(()=>prepareManagedFactorySpawn({command:'codex-acp-swarm',args:[]},p.workdir,{}, {policy:p,invocationId:'1'.repeat(32)})).toThrow('unissued');
    const own=process.platform==='linux'?readFileSync('/proc/self/cgroup','utf8'):'';
    if(!own.includes('/'+MANAGED_FACTORY_UNIT))expect(readManagedFactoryBoundary()).toBeNull();
    delete process.env.FACTORY_STATE_MODE;expect(()=>validateManagedFactoryEvidenceFixture(p,evidence())).toThrow('fixture-only');
  });
  test.skipIf(process.platform!=='linux')('sealed profile bytes cannot be changed or truncated before bwrap reads them',()=>{
    process.env.FACTORY_STATE_MODE='test';const raw=Buffer.from('{"synthetic":"no credential"}');const fd=sealedManagedProfileFixture(raw);
    try{expect(fstatSync(fd).mode&0o777).toBe(0o400);expect(readFileSync(fd)).toEqual(raw);
      expect(()=>writeSync(fd,Buffer.from('x'),0,1,0)).toThrow();expect(()=>ftruncateSync(fd,0)).toThrow();
    }finally{closeSync(fd);}
  });
  test('filesystem envelope preserves resource wrappers and pins actual ACP native path',()=>{
    process.env.FACTORY_STATE_MODE='test';const p=parseManagedFactoryPolicy(canonical(policy()));const args=managedFactoryArgumentsFixture(p);
    expect(args.slice(args.indexOf('--')+1)).toEqual(['/usr/bin/taskset','-c','0-7','/usr/bin/nice','-n','10',p.adapter.path]);
    const native=args.indexOf('CODEX_PATH');expect(args.slice(native-1,native+2)).toEqual(['--setenv','CODEX_PATH',p.native.path]);
    expect(args.includes('--unshare-pid')).toBe(true);
    expect(args.slice(args.indexOf('--proc'),args.indexOf('--proc')+13)).toEqual(['--proc','/proc',
      '--ro-bind','/dev/null','/proc/kallsyms','--ro-bind','/dev/null','/proc/kcore','--ro-bind','/dev/null','/proc/kmsg','--remount-ro','/proc']);
    expect(args.includes(p.state_root)).toBe(false);expect(args.includes('--unshare-cgroup')).toBe(false);expect(args.includes('--unshare-net')).toBe(false);
    expect(args.slice(args.indexOf('--bind'),args.indexOf('--bind')+3)).toEqual(['--bind',p.workdir,p.workdir]);
    expect(args.includes('/root')).toBe(false);expect(args.includes('/home/zouroboros')).toBe(false);
    const source=args.indexOf(p.source_root);expect(args.slice(source-1,source+2)).toEqual(['--ro-bind',p.source_root,p.source_root]);
    const bun=args.indexOf(p.bun.path);expect(args.slice(bun-1,bun+2)).toEqual(['--ro-bind',p.bun.path,p.bun.path]);
    const resolved=policy();resolved.runtime_files=resolved.runtime_files.map(f=>f.path==='/usr/bin/nice'?pin('/usr/lib/cargo/bin/coreutils/nice'):f).sort((a,b)=>a.path.localeCompare(b.path));
    expect(()=>parseManagedFactoryPolicy(canonical(resolved))).toThrow('nice');
    const staged=policy();const stagedNice=staged.native.path.replace(/codex$/,'nice');
    staged.runtime_files=staged.runtime_files.map(f=>f.path==='/usr/bin/nice'?pin(stagedNice):f).sort((a,b)=>a.path.localeCompare(b.path));
    const stagedArgs=managedFactoryArgumentsFixture(parseManagedFactoryPolicy(canonical(staged)));
    expect(stagedArgs.slice(stagedArgs.indexOf('--')+1)).toEqual(['/usr/bin/taskset','-c','0-7',stagedNice,'-n','10',p.adapter.path]);
    staged.runtime_files.push(pin('/usr/bin/nice'));staged.runtime_files.sort((a,b)=>a.path.localeCompare(b.path));
    expect(()=>parseManagedFactoryPolicy(canonical(staged))).toThrow('nice');
    const unknown=policy();unknown.runtime_files=unknown.runtime_files.map(f=>f.path==='/usr/bin/nice'?pin('/opt/unapproved/nice'):f).sort((a,b)=>a.path.localeCompare(b.path));
    expect(()=>parseManagedFactoryPolicy(canonical(unknown))).toThrow('nice');
    delete process.env.FACTORY_STATE_MODE;expect(()=>managedFactoryArgumentsFixture(p)).toThrow('fixture-only');
  });
});
