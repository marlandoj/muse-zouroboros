/** Installed managed Factory boundary. Environment values are never authority.
 * Legacy callers outside the exact cgroup keep their existing containment path.
 * Inside it, a missing/invalid root-enrolled policy is a hard failure.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, writeSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type { AdapterSpawnSpec } from './agent-containment.js';

export const MANAGED_FACTORY_UNIT = 'zouroboros-factory-execution.service';
export const MANAGED_FACTORY_POLICY = '/etc/zouroboros-factory-executor-boundary.json';
const CGROUP = `/system.slice/${MANAGED_FACTORY_UNIT}`;
const HASH = /^[a-f0-9]{64}$/;
const CLEAN = { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C' };
const CAP_BOUND = '00000000000800e4';
const LIBC = '/usr/lib/x86_64-linux-gnu/libc.so.6';
const NICE_PATHS = ['/usr/bin/nice'];
function nicePath(p: ManagedFactoryPolicy): string {
  const matches=p.runtime_files.filter(f=>NICE_PATHS.includes(f.path)||f.path===join(dirname(p.native.path),'nice'));
  if(matches.length!==1)fail('exact resolved nice runtime pin');
  return matches[0].path;
}
type FilePin = { path: string; sha256: string };
export interface ManagedFactoryPolicy {
  schema: 'factory-managed-systemd-boundary/v1';
  unit_inputs_sha256: string; execution_sha256: string; unit_fragment_sha256: string;
  source_root: string; source_head: string; registry_sha256: string;
  worker_uid: number; worker_gid: number; workdir: string; home: string; state_root: string;
  harness: 'codex'; model: string; runtime_ms: number; timeout_ms: number; approved_at_ms: number; expires_at_ms: number;
  adapter: FilePin & { name: 'codex-acp-swarm'; args: string[] };
  native: FilePin; node: FilePin; bun: FilePin; bwrap: FilePin; systemctl: FilePin; python: FilePin;
  profile_files: FilePin[]; runtime_files: FilePin[];
}
interface Evidence {
  cgroup: string; status: string; unit: string; mountinfo: string;
  mount_ids: { sys: string; cgroup: string; runtime: string };
  supervisor_status: string; supervisor_cgroup: string;
  cgroup_type: string; memory_max: string; pids_max: string; now: number;
}
export interface ManagedFactoryBoundary {
  readonly policy: Readonly<ManagedFactoryPolicy>;
  readonly invocationId: string;
}
const issued = new WeakSet<object>();
const sha = (raw: string | Buffer) => createHash('sha256').update(raw).digest('hex');
const fail = (message: string): never => { throw new Error(`managed Factory containment: ${message}`); };
function path(value: unknown): string {
  if (typeof value !== 'string' || !/^\/[A-Za-z0-9_./-]+$/.test(value) || resolve(value) !== value) fail('literal absolute path');
  return value as string;
}
function pin(value: unknown): FilePin {
  if (!value || typeof value !== 'object' || Object.keys(value).sort().join() !== 'path,sha256') fail('file pin shape');
  const item = value as FilePin;
  path(item.path); if (typeof item.sha256 !== 'string' || !HASH.test(item.sha256)) fail('file digest');
  return item;
}
function identity(info: NonNullable<ReturnType<typeof lstatSync>>): string {
  return [info.dev, info.ino, info.uid, info.gid, info.mode, info.nlink].join(':');
}
function controlled(rawPath: string, expected?: string, owner = 0, maximum = 512*1024*1024, mutableRoot?:string): Buffer {
  const name = path(rawPath); const ancestors: Array<[string, string]> = [];
  let parent = dirname(name);
  while (true) {
    const info = lstatSync(parent);
    const profileOwned=owner>0&&mutableRoot!==undefined&&(parent===mutableRoot||parent.startsWith(mutableRoot+'/'))&&info.uid===owner;
    if (!info.isDirectory() || info.isSymbolicLink() || (info.uid !== 0&&!profileOwned) || (info.mode & 0o022)) fail('root path ancestry');
    ancestors.push([parent, identity(info)]); if (parent === '/') break; parent = dirname(parent);
  }
  const fd = openSync(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.uid !== owner || before.nlink !== 1 || (before.mode & 0o022) || before.size > maximum) fail('file ownership/shape');
    const chunks:Buffer[]=[];let length=0;
    while(true){const block=Buffer.alloc(Math.min(65536,maximum+1-length));const count=readSync(fd,block,0,block.length,null);if(!count)break;length+=count;if(length>maximum)fail('file byte bound');chunks.push(block.subarray(0,count));}
    const raw=Buffer.concat(chunks); const after = fstatSync(fd); const named = lstatSync(name);
    if (raw.length > maximum || identity(before) !== identity(after) || identity(after) !== identity(named)
        || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
        || ancestors.some(([p, id]) => identity(lstatSync(p)) !== id) || (expected !== undefined && sha(raw) !== expected)) fail('file changed or digest mismatch');
    return raw;
  } finally { closeSync(fd); }
}
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) frozen(child); Object.freeze(value); }
  return value;
}
export function parseManagedFactoryPolicy(raw: string): ManagedFactoryPolicy {
  if (Buffer.byteLength(raw) > 2_000_000) fail('policy byte bound');
  const p = JSON.parse(raw) as ManagedFactoryPolicy;
  const canonical=(value:any):string=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}':JSON.stringify(value);
  if(canonical(p)!==raw)fail('canonical policy required');
  const fields = ['schema','unit_inputs_sha256','execution_sha256','unit_fragment_sha256','source_root','source_head','registry_sha256',
    'worker_uid','worker_gid','workdir','home','state_root','harness','model','runtime_ms','timeout_ms','approved_at_ms','expires_at_ms',
    'adapter','native','node','bun','bwrap','systemctl','python','profile_files','runtime_files'];
  if (!p || typeof p !== 'object' || Object.keys(p).sort().join() !== fields.sort().join()
      || p.schema !== 'factory-managed-systemd-boundary/v1' || p.harness !== 'codex'
      || typeof p.source_head !== 'string' || !/^[a-f0-9]{40}$/.test(p.source_head) || typeof p.model !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(p.model)
      || !['unit_inputs_sha256','execution_sha256','unit_fragment_sha256','registry_sha256'].every(k => typeof (p as any)[k] === 'string' && HASH.test((p as any)[k]))
      || !['worker_uid','worker_gid','runtime_ms','timeout_ms','approved_at_ms','expires_at_ms'].every(k => Number.isSafeInteger((p as any)[k]))
      || p.worker_uid <= 0 || p.worker_gid <= 0 || p.runtime_ms < 180_000 || p.runtime_ms > 600_000 || p.runtime_ms % 60_000
      || p.timeout_ms <= 0 || p.timeout_ms > 120_000 || p.timeout_ms + 60_000 > p.runtime_ms
      || p.approved_at_ms <= 0 || p.expires_at_ms <= p.approved_at_ms || p.expires_at_ms - p.approved_at_ms > 3_600_000) fail('policy schema');
  for (const key of ['source_root','workdir','home','state_root'] as const) path(p[key]);
  if (new Set([p.source_root,p.workdir,p.home,p.state_root]).size !== 4) fail('separate paths');
  for (const mutable of [p.workdir,p.home,p.state_root]) {
    if (relative(p.source_root,mutable).split('/')[0] !== '..' || relative(mutable,p.source_root).split('/')[0] !== '..') fail('runtime/write separation');
  }
  const mutableRoots=[p.workdir,p.home,p.state_root,'/etc/zouroboros/hermes-issuer'];
  for(let i=0;i<mutableRoots.length;i++)for(const right of mutableRoots.slice(i+1)){
    const left=mutableRoots[i];if(left===right||left.startsWith(right+'/')||right.startsWith(left+'/'))fail('mutable roots must not overlap');
  }
  for (const key of ['native','node','bun','bwrap','systemctl','python'] as const) pin(p[key]);
  if (p.bwrap.path !== '/usr/bin/bwrap' || p.systemctl.path !== '/usr/bin/systemctl') fail('fixed boundary tools');
  if (!p.adapter || Object.keys(p.adapter).sort().join() !== 'args,name,path,sha256' || p.adapter.name !== 'codex-acp-swarm'
      || !Array.isArray(p.adapter.args) || p.adapter.args.length !== 0) fail('fixed adapter invocation');
  pin({path:p.adapter.path,sha256:p.adapter.sha256});
  if (dirname(p.adapter.path) !== dirname(p.native.path) || dirname(p.node.path) !== dirname(p.native.path)) fail('native adapter PATH binding');
  for (const item of [p.adapter,p.native,p.node]) if (!item.path.startsWith(p.source_root+'/')) fail('native runtime must be materialized');
  for (const [key, maximum] of [['profile_files',16],['runtime_files',2048]] as const) {
    const list = p[key]; if (!Array.isArray(list) || list.length < 1 || list.length > maximum) fail('bounded runtime/profile list');
    const names: string[] = [];
    for (const item of list) {
      if (key === 'profile_files') {
        if (!item || Object.keys(item).sort().join() !== 'path,sha256' || typeof item.path !== 'string'
            || !/^\.codex\/[A-Za-z0-9_.-]+$/.test(item.path) || typeof item.sha256 !== 'string' || !HASH.test(item.sha256)) fail('Codex profile file');
      } else pin(item);
      names.push(item.path);
    }
    if (names.join() !== [...new Set(names)].sort().join()) fail('inventory ordering');
  }
  if (!p.profile_files.some(f => f.path === '.codex/auth.json')) fail('subscription auth profile required');
  for(const required of [LIBC,'/usr/bin/taskset']) if (!p.runtime_files.some(f=>f.path===required)) fail('sealed profile/resource runtime pin');
  nicePath(p);
  return frozen(p);
}
function records(raw: string, separator: string): Record<string,string> {
  const out: Record<string,string> = {};
  for (const row of raw.trimEnd().split('\n')) {
    const at = row.indexOf(separator); if (at < 0) fail('observation record');
    const key = row.slice(0,at); if (Object.hasOwn(out,key)) fail('duplicate observation'); out[key] = row.slice(at+separator.length).trim();
  }
  return out;
}
function mountId(target: string): string {
  // fdinfo identifies the visible mount, including stacked read-only binds.
  // Choosing by pathname/order alone can inspect a hidden lower mount.
  const fd=openSync(target,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try { return records(readFileSync(`/proc/self/fdinfo/${fd}`,'utf8'),':').mnt_id; }
  finally { closeSync(fd); }
}
function readonlyMount(raw: string, target: string, mount: string): boolean {
  if (typeof mount!=='string'||!/^[1-9][0-9]*$/.test(mount)) return false;
  const rows=raw.trim().split('\n').map(row=>{
    const parts=row.split(' ');if(parts.length<10||!row.includes(' - '))fail('mountinfo shape');return parts;
  }).filter(parts=>parts[0]===mount);
  if(rows.length!==1)return false;
  const parts=rows[0];const point=parts[4].replace(/\\040/g,' ');
  return (target===point||target.startsWith(point.replace(/\/$/,'')+'/'))&&parts[5].split(',').includes('ro');
}
function validateEvidence(p: ManagedFactoryPolicy, e: Evidence): string {
  if (e.cgroup !== `0::${CGROUP}\n` || !Number.isSafeInteger(e.now) || e.now < p.approved_at_ms || e.now + p.timeout_ms >= p.expires_at_ms) fail('actual cgroup/approval');
  const s = records(e.status,':');
  if (s.Uid !== Array(4).fill(p.worker_uid).join('\t') || s.Gid !== Array(4).fill(p.worker_gid).join('\t')
      || !['',String(p.worker_gid)].includes(s.Groups) || s.NoNewPrivs !== '1'
      || ['CapEff','CapPrm','CapInh','CapAmb'].some(k => s[k] !== '0000000000000000') || s.CapBnd !== CAP_BOUND) fail('worker privilege identity');
  const u = records(e.unit,'=');
  const expected: Record<string,string> = { Id:MANAGED_FACTORY_UNIT,LoadState:'loaded',ActiveState:'active',SubState:'running',
    User:'',Group:'root',ControlPID:'0',FragmentPath:`/etc/systemd/system/${MANAGED_FACTORY_UNIT}`,DropInPaths:'',SourcePath:'',
    NeedDaemonReload:'no',Transient:'no',Delegate:'no',KillMode:'control-group',Restart:'no',Type:'exec',
    NoNewPrivileges:'yes',ProtectControlGroups:'yes',ProtectSystem:'strict',ProtectHome:'yes',PrivateTmp:'yes',
    ProtectKernelTunables:'no',ProtectKernelLogs:'no',ProtectKernelModules:'yes',PrivateDevices:'yes',
    BindReadOnlyPaths:'/sys:/sys:rbind',SystemCallFilter:'~syslog',
    RestrictNamespaces:'ipc mnt pid user uts',RuntimeMaxUSec:`${p.runtime_ms/60_000}min`,TimeoutStopUSec:'3s',
    SendSIGKILL:'yes',FinalKillSignal:'9',MemoryMax:'12884901888',TasksMax:'256',ControlGroup:CGROUP };
  if (Object.entries(expected).some(([key,value])=>u[key]!==value) || !/^[1-9][0-9]*$/.test(u.MainPID??'')
      || !/^[a-f0-9]{32}$/.test(u.InvocationID??'') || Object.keys(u).sort().join()!==[...Object.keys(expected),'MainPID','InvocationID'].sort().join()) fail('loaded unit policy');
  // Implicit root avoids systemd's explicit-user SETUID removal before NNP;
  // actual MainPID identity and capabilities, not an empty User field, prove it.
  const root=records(e.supervisor_status,':');
  if(root.Uid!=='0\t0\t0\t0'||root.Gid!=='0\t0\t0\t0'||!['','0'].includes(root.Groups)||root.NoNewPrivs!=='1'
      ||['CapPrm','CapEff','CapBnd'].some(k=>root[k]!==CAP_BOUND)||['CapInh','CapAmb'].some(k=>root[k]!=='0000000000000000')
      ||e.supervisor_cgroup!==`0::${CGROUP}\n`)fail('actual root supervisor identity');
  if (e.cgroup_type !== 'domain\n' || e.memory_max !== '12884901888\n' || e.pids_max !== '256\n'
      || !readonlyMount(e.mountinfo,'/sys',e.mount_ids?.sys)
      || !readonlyMount(e.mountinfo,'/sys/fs/cgroup',e.mount_ids?.cgroup)
      || !readonlyMount(e.mountinfo,p.source_root,e.mount_ids?.runtime)) fail('kernel control/runtime boundary');
  return u.InvocationID;
}
/** Test-only raw observations do not manufacture an issued production capability. */
export function validateManagedFactoryEvidenceFixture(p: ManagedFactoryPolicy,e: Evidence): string {
  if (process.env.FACTORY_STATE_MODE !== 'test') fail('fixture-only observation');
  return validateEvidence(p,e);
}
export function readManagedFactoryBoundary(): ManagedFactoryBoundary | null {
  if (process.platform !== 'linux') return null;
  const cgroup = readFileSync('/proc/self/cgroup','utf8');
  if (cgroup !== `0::${CGROUP}\n`) return null;
  if (process.env.FACTORY_STATE_MODE === 'test') fail('production managed boundary excludes fixtures');
  const start = Date.now(); const raw = controlled(MANAGED_FACTORY_POLICY,undefined,0,2_000_000);
  const p = parseManagedFactoryPolicy(raw.toString('utf8'));
  if(realpathSync('/proc/self/exe')!==p.bun.path)fail('actual worker Bun executable');
  controlled(`/etc/systemd/system/${MANAGED_FACTORY_UNIT}`,p.unit_fragment_sha256,0,32768);
  for (const key of ['adapter','native','node','bun','bwrap','systemctl','python'] as const) controlled(p[key].path,p[key].sha256);
  for (const item of p.runtime_files) controlled(item.path,item.sha256);
  const registry = controlled(join(p.source_root,'packages/swarm/src/executor/registry/executor-registry.json'),p.registry_sha256,0,2_000_000);
  const entry = JSON.parse(registry.toString()).executors?.filter((item:any)=>item.id===p.harness);
  if (entry?.length!==1 || entry[0].transport!=='acp' || entry[0].acp?.adapterBin!==p.adapter.name || JSON.stringify(entry[0].acp?.adapterArgs??[])!==JSON.stringify(p.adapter.args)) fail('exact registry ACP route');
  const properties = ['Id','LoadState','ActiveState','SubState','User','Group','MainPID','ControlPID','FragmentPath','DropInPaths','SourcePath',
    'NeedDaemonReload','Transient','Delegate','KillMode','Restart','Type','NoNewPrivileges','ProtectControlGroups','ProtectSystem','ProtectHome','PrivateTmp',
    'ProtectKernelTunables','ProtectKernelLogs','ProtectKernelModules','PrivateDevices','BindReadOnlyPaths','SystemCallFilter',
    'RestrictNamespaces','RuntimeMaxUSec','TimeoutStopUSec','SendSIGKILL','FinalKillSignal','MemoryMax','TasksMax','ControlGroup','InvocationID'];
  const group=join('/sys/fs/cgroup',CGROUP);
  const cstat=lstatSync(group);if(!cstat.isDirectory()||cstat.uid!==0||cstat.gid!==0)fail('root cgroup ownership');
  const unit = execFileSync(p.systemctl.path,['show',MANAGED_FACTORY_UNIT,'--no-pager',`--property=${properties.join(',')}`],
    {env:CLEAN,encoding:'utf8',timeout:3000,maxBuffer:32768});
  const main=records(unit,'=').MainPID;if(!/^[1-9][0-9]*$/.test(main??''))fail('actual supervisor PID');
  const now=Date.now();if(now<start)fail('clock reversed');
  const invocationId=validateEvidence(p,{cgroup:readFileSync('/proc/self/cgroup','utf8'),status:readFileSync('/proc/self/status','utf8'),unit,
    supervisor_status:readFileSync(`/proc/${main}/status`,'utf8'),supervisor_cgroup:readFileSync(`/proc/${main}/cgroup`,'utf8'),
    mount_ids:{sys:mountId('/sys'),cgroup:mountId('/sys/fs/cgroup'),runtime:mountId(p.source_root)},
    mountinfo:readFileSync('/proc/self/mountinfo','utf8'),cgroup_type:readFileSync(join(group,'cgroup.type'),'utf8'),
    memory_max:readFileSync(join(group,'memory.max'),'utf8'),pids_max:readFileSync(join(group,'pids.max'),'utf8'),now});
  if(!controlled(MANAGED_FACTORY_POLICY,undefined,0,2_000_000).equals(raw))fail('policy changed during acquisition');
  if(Date.now()<now||Date.now()+p.timeout_ms>=p.expires_at_ms)fail('approval expired during acquisition');
  const boundary=frozen({policy:p,invocationId});issued.add(boundary);return boundary;
}

function directories(target:string): string[] {
  const result:string[]=[];let parent=dirname(target);
  while(parent!=='/'){result.unshift(parent);parent=dirname(parent);}
  return result.flatMap(p=>['--dir',p]);
}
function sealedProfile(raw:Buffer):number {
  // A sealed anonymous file fixes the already-hashed bytes. Reopening a worker
  // pathname would allow a later same-inode write to alter bwrap's input.
  const ffi=require('bun:ffi');
  const library=ffi.dlopen(LIBC,{memfd_create:{args:['ptr','u32'],returns:'i32'},fcntl:{args:['i32','i32','i32'],returns:'i32'}});
  let fd=-1;
  try {
    const name=Buffer.from('factory-profile\0');fd=Number(library.symbols.memfd_create(ffi.ptr(name),3));
    if(fd<0)fail('sealed profile creation');
    let written=0;while(written<raw.length){const count=writeSync(fd,raw,written,raw.length-written,written);if(count<=0)fail('sealed profile write');written+=count;}
    fchmodSync(fd,0o400);
    if(library.symbols.fcntl(fd,1033,15)!==0||library.symbols.fcntl(fd,1034,0)!==15)fail('sealed profile seals');
    const observed=Buffer.alloc(raw.length);let offset=0;
    while(offset<observed.length){const count=readSync(fd,observed,offset,observed.length-offset,offset);if(count<=0)fail('sealed profile readback');offset+=count;}
    if(!observed.equals(raw))fail('sealed profile changed');
    const retained=fd;fd=-1;return retained;
  }finally{if(fd>=0)closeSync(fd);library.close();}
}
export function sealedManagedProfileFixture(raw:Buffer):number {
  if(process.env.FACTORY_STATE_MODE!=='test')fail('fixture-only sealed profile');
  return sealedProfile(raw);
}
export function prepareManagedFactorySpawn(spawn:AdapterSpawnSpec, workdir:string, env:Record<string,string>, previous:ManagedFactoryBoundary):AdapterSpawnSpec {
  if(!issued.has(previous))fail('unissued boundary');
  const current=readManagedFactoryBoundary();
  if(!current)return fail('boundary absent before spawn');
  if(current.invocationId!==previous.invocationId||JSON.stringify(current.policy)!==JSON.stringify(previous.policy))fail('boundary changed before spawn');
  const p=current.policy;
  const allowed=new Set(['PATH','HOME','CODEX_HOME','LC_ALL','FACTORY_STATE_MODE','FACTORY_STATE_DIR','CODEX_BIN','SWARM_RESOLVED_MODEL','SWARM_EXECUTOR_ID','SWARM_EXEC_RESOURCE_GUARD_REQUIRED','SWARM_EXEC_MEMORY_LIMIT_MIB','SWARM_EXEC_NICE','SWARM_EXEC_CPU_SET','SWARM_EXEC_PROCESS_LIMIT','SWARM_EXEC_CONTAINMENT_REQUIRED','SWARM_EXEC_CONTAINMENT_ROOT','SWARM_EXEC_CONTAINMENT_UID','SWARM_EXEC_CONTAINMENT_GID','ALLOWED_TOOLS']);
  if(Object.keys(env).some(k=>!allowed.has(k))||env.FACTORY_STATE_MODE!=='production'||env.FACTORY_STATE_DIR!==p.state_root
      ||env.CODEX_HOME!==join(p.home,'.codex')||env.SWARM_EXEC_CONTAINMENT_ROOT!==p.workdir
      ||env.SWARM_EXEC_CONTAINMENT_UID!==String(p.worker_uid)||env.SWARM_EXEC_CONTAINMENT_GID!==String(p.worker_gid))fail('clean managed execution environment');
  if(realpathSync(workdir)!==p.workdir||spawn.command!==p.adapter.name||JSON.stringify(spawn.args)!==JSON.stringify(p.adapter.args)
      || env.SWARM_EXEC_RESOURCE_GUARD_REQUIRED!=='1'||env.SWARM_EXEC_MEMORY_LIMIT_MIB!=='12288'||env.SWARM_EXEC_PROCESS_LIMIT!=='256'
      ||env.SWARM_EXEC_NICE!=='10'||env.SWARM_EXEC_CPU_SET!=='0-7'||env.SWARM_EXEC_CONTAINMENT_REQUIRED!=='1'
      || env.SWARM_EXECUTOR_ID!==p.harness||env.SWARM_RESOLVED_MODEL!==p.model||env.CODEX_BIN!==p.native.path||env.HOME!==p.home)fail('actual adapter invocation binding');
  const pathParts=(env.PATH??'').split(':');const wanted=[dirname(p.bun.path),dirname(p.native.path),'/usr/bin','/bin'];
  if(pathParts.join(':')!==wanted.join(':'))fail('adapter executable search path');
  const git=lstatSync(join(p.workdir,'.git'));if(!git.isDirectory()||git.isSymbolicLink())fail('dedicated clone metadata required');
  const fds:number[]=[];const profile:string[]=[];
  try {
    for(const item of p.profile_files){
      const name=join(p.home,item.path);const raw=controlled(name,item.sha256,p.worker_uid,1_000_000,p.home);
      const retained=sealedProfile(raw);
      fds.push(retained);profile.push('--perms','0400','--ro-bind-data',String(2+fds.length),join(p.home,item.path));
    }
    const args=filesystemArguments(p,profile);
    if(Date.now()+p.timeout_ms>=p.expires_at_ms)fail('approval expired before adapter spawn');
    let closed=false;const close=()=>{if(!closed){closed=true;for(const fd of fds)closeSync(fd);}};
    return {command:p.bwrap.path,args,passFds:fds,closeAfterSpawn:close,cleanupAfterExit:close};
  }catch(error){for(const fd of fds)try{closeSync(fd);}catch{}throw error;}
}
function filesystemArguments(p:Readonly<ManagedFactoryPolicy>,profile:string[]):string[]{
  return ['--die-with-parent','--new-session','--unshare-user','--uid','0','--gid','0','--unshare-pid','--unshare-uts','--unshare-ipc',
      '--ro-bind','/usr','/usr','--dir','/etc','--ro-bind','/etc/ssl','/etc/ssl','--ro-bind','/etc/passwd','/etc/passwd',
      '--ro-bind','/etc/group','/etc/group','--ro-bind','/etc/nsswitch.conf','/etc/nsswitch.conf',
      '--ro-bind','/etc/resolv.conf','/etc/resolv.conf','--ro-bind','/etc/hosts','/etc/hosts',
      '--symlink','usr/bin','/bin','--symlink','usr/lib','/lib','--symlink','usr/lib64','/lib64',
      // No host proc bind: mount the new PID namespace proc first, then seal
      // every tunable and mask kernel data before any adapter code executes.
      '--proc','/proc','--ro-bind','/dev/null','/proc/kallsyms','--ro-bind','/dev/null','/proc/kcore',
      '--ro-bind','/dev/null','/proc/kmsg','--remount-ro','/proc',
      '--dev','/dev','--tmpfs','/tmp','--tmpfs','/run',
      ...directories(p.source_root),'--ro-bind',p.source_root,p.source_root,
      ...(p.bun.path.startsWith(p.source_root+'/')||p.bun.path.startsWith('/usr/')?[]:[...directories(p.bun.path),'--ro-bind',p.bun.path,p.bun.path]),
      ...directories(p.workdir),'--bind',p.workdir,p.workdir,...directories(p.home),'--dir',p.home,'--dir',join(p.home,'.codex'),
      ...profile,'--chdir',p.workdir,'--setenv','HOME',p.home,'--setenv','CODEX_HOME',join(p.home,'.codex'),
      '--setenv','CODEX_PATH',p.native.path,'--setenv','TMPDIR','/tmp','--setenv','GIT_OPTIONAL_LOCKS','0','--','/usr/bin/taskset','-c','0-7',nicePath(p),'-n','10',p.adapter.path,...p.adapter.args];
}
export function managedFactoryArgumentsFixture(p:ManagedFactoryPolicy):string[]{
  if(process.env.FACTORY_STATE_MODE!=='test')fail('fixture-only filesystem arguments');
  return filesystemArguments(p,[]);
}
