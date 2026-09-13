#!/usr/bin/env python3
"""Replay the fifteen admitted source-backed rows; no reviewer/model execution.

--sources is a read-only directory containing local bugsjs-{express,eslint,
hessian,shields,mongoose} Git clones. --work must be a new disposable directory.
Uses the repository's existing archive helper and frozen npm locks.
"""
import argparse,importlib.util,json,subprocess,sys
from pathlib import Path
sys.dont_write_bytecode=True
HERE=Path(__file__).resolve().parent

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--repository',type=Path,required=True);p.add_argument('--sources',type=Path,required=True);p.add_argument('--work',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args();repo=a.repository.resolve();sources=a.sources.resolve();work=a.work.resolve();output=a.output.resolve()
 assert not work.exists(),'Use a new disposable directory';work.mkdir(parents=True)
 m=json.loads((HERE/'manifest.json').read_text());spec=importlib.util.spec_from_file_location('existing_qualification_replay',repo/m['supportReplay']);helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper);sha,unpack=helper.sha,helper.unpack
 def save(p,b):
  p=work/p;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(b)
 def git(clone,*args):return subprocess.check_output(['git','-C',str(sources/('bugsjs-'+clone)),*args])
 def normalized(x):
  if isinstance(x,str):return x.replace(str(work),'REPLAY_WORK')
  if isinstance(x,list):return[normalized(v)for v in x]
  if isinstance(x,dict):return{k:normalized(v)for k,v in x.items()}
  return x
 for filename,digest in m['controlScripts'].items():assert sha((HERE/filename).read_bytes())==digest
 assert sha((HERE/'getter-spans.json').read_bytes())==m['getterSpansSha256']
 module_file=HERE/m['sourceModuleIdentities']['file'];assert sha(module_file.read_bytes())==m['sourceModuleIdentities']['sha256']
 for e in json.loads(module_file.read_text()):assert sha(git(e['clone'],'show',e['ref']+':'+e['path']))==e['sha256']
 node=subprocess.check_output(['node','--version']).decode().strip();assert node==m['nodeVersion'],node
 corpus=(repo/m['corpusPath']).read_bytes();assert sha(corpus)==m['corpusSha256'];rows={x['id']:x for x in map(json.loads,corpus.splitlines())}
 runtimes={}
 for key,e in m['runtimes'].items():
  runtime=work/e['directory'];runtime.mkdir(parents=True)
  for filename,hashkey in [('package.json','packageSha256'),('package-lock.json','lockSha256')]:
   b=(HERE/e['directory']/filename).read_bytes();assert sha(b)==e[hashkey];(runtime/filename).write_bytes(b)
  with(runtime/'install.log').open('w')as log:subprocess.run(['npm','ci','--ignore-scripts','--no-audit','--no-fund','--legacy-peer-deps'],cwd=runtime,stdout=log,stderr=subprocess.STDOUT,check=True)
  runtimes[key]=runtime
  print(json.dumps({'runtime':key,'npmCi':'passed','scriptsDisabled':True}),flush=True)
 for e in m.get('runtimeAliases',[]):
  runtime=runtimes[e['runtime']];link=runtime/e['link'];target=runtime/e['target'];assert target.is_dir();link.parent.mkdir(parents=True,exist_ok=True);link.symlink_to(target,target_is_directory=True)
 for e in m['archives']:
  data=git(e['clone'],'archive','--format=tar',e['ref'],*e['paths']);assert sha(data)==e['sha256'];dest=work/e['destination'];dest.mkdir(parents=True);unpack(data,dest)
  if'runtime'in e:(dest/'node_modules').symlink_to(runtimes[e['runtime']]/'node_modules',target_is_directory=True)
 for e in m.get('runtimeLinks',[]):
  dest=work/e['destination'];dest.parent.mkdir(parents=True,exist_ok=True);dest.symlink_to(runtimes[e['runtime']],target_is_directory=True)
 for e in m['sourceFiles']:
  b=git(e['clone'],'show',e['ref']+':'+e['path']);assert sha(b)==e['sha256'];save(e['destination'],b)
 for e in m['staticFiles']:
  b=(HERE/e['bundle']).read_bytes();assert sha(b)==e['sha256'];save(e['destination'],b)
 for e in m['fixtures']:
  row=rows[e['id']];assert row['expected']==e['expected'];b=row['repo'][e['repo']][e['file']].encode();assert sha(b)==e['sha256'];save(e['destination'],b)
 for e in m['derivedFiles']:
  b=(work/e['source']).read_bytes()
  if'byteSlice'in e:
   start,end=e['byteSlice'];b=e['prefix'].encode()+b[start:end]+e['suffix'].encode()
  else:
   assert b.count(e['replace'].encode())==1;b=b.replace(e['replace'].encode(),e['with'].encode())
  assert sha(b)==e['sha256'];save(e['destination'],b)
 ids=[i for f in m['families']for i in f['ids']];assert len(set(ids))==15
 projected=[{k:rows[i][k]for k in ['id','repo']}for i in ids if i in ['corr-null-map-key-clean','corr-ip-address-subdomains-clean','corr-bracketed-host-port-clean']];save(m['repairOnlyProjection'],json.dumps(projected).encode())
 for d in ['public-pair-critique','cache-pair-critique']:(work/d).mkdir(exist_ok=True)
 published=[]
 for e in m['published']:
  d=work/e['qualified'];target=d/'source/lib/rules'/e['rule'];test=d/'source/tests/lib/rules'/e['rule']
  for stage in e['stages']:
   originals={}
   for kind in ['source','adapted']:
    target.write_bytes((d/(stage+('-source'if kind=='source'else'')+'.js')).read_bytes());result=d/(stage+'-'+kind+'-published-replay.json')
    with(d/(stage+'-'+kind+'-published.log')).open('w')as log:subprocess.run(['node',str(HERE/'run-eslint-published.cjs'),str(test),str(result)],cwd=d/'source',stdout=log,stderr=subprocess.STDOUT,timeout=60,check=True)
    actual=json.loads(result.read_text());expected=json.loads((d/(stage+'-'+kind+'-tests.json')).read_text());assert normalized(actual)==expected,(e['qualified'],stage,kind,'published mismatch');assert not actual['fatal']and not actual['unsupported'];originals[kind]=actual
    if stage=='repair':assert actual['failed']==0
   assert originals['source']==originals['adapted'];published.append({'family':e['qualified'],'stage':stage,'observations':2*originals['source']['total'],'failedPerEndpoint':originals['source']['failed'],'sourceAdaptationAgrees':True})
 checks=[]
 for e in m['checks']:
  with(work/(e['name']+'.log')).open('w')as log:subprocess.run(['node',str(HERE/e['script']),str(work)],cwd=work,stdout=log,stderr=subprocess.STDOUT,timeout=90,check=True)
  actual=json.loads((work/e['output']).read_text());expected=json.loads((HERE/e['expected']).read_text());assert normalized(actual)==expected,(e['name'],'expected observations mismatch')
  records=actual['observations'];count=len(records)
  if records and any(k in records[0]for k in ['original','sourceEqual']):observations=2*count;comparisons=count
  elif e['pairedRecords']:
   originals=[x for x in records if x.get('kind')in ['source','operation']]
   for s in originals:
    adapted=next(x for x in records if x.get('kind')=='adapted'and x['stage']==s['stage']and x.get('scenario',x.get('name'))==s.get('scenario',s.get('name')));strip=lambda x:{k:v for k,v in x.items()if k!='kind'};assert strip(s)==strip(adapted),(e['name'],'raw source/adaptation mismatch')
   observations=count;comparisons=len(originals)
  else:observations=count;comparisons=0
  checks.append({'name':e['name'],'observations':observations,'sourceAdaptationComparisons':comparisons,'expectedSha256':sha((HERE/e['expected']).read_bytes()),'exactExpectedObservationsAgree':True});print(json.dumps(checks[-1]),flush=True)
 p1=json.loads((work/'public-datasets/express-params-source-observations.json').read_text());p2=json.loads((work/'public-datasets/express-params-adapted-observations.json').read_text());assert p1==p2
 receipt={'node':node,'corpusSha256':sha(corpus),'manifestSha256':sha((HERE/'manifest.json').read_bytes()),'dynamicReplay':True,'rows':15,'sourceContexts':len(m['families']),'published':published,'controls':checks,'publishedObservations':sum(x['observations']for x in published),'controlObservations':sum(x['observations']for x in checks),'sourceAdaptationComparisons':sum(x['observations']//2 for x in published)+sum(x['sourceAdaptationComparisons']for x in checks)+len(p1['observations']),'allExactExpectedObservationsAgree':True,'npmCiRuntimeLocks':len(runtimes),'installScriptsDisabled':True,'corpusBindings':m['fixtures'],'derivedRepair':'Shields Object.create(null) extension; upstream endpoint retained only as target-specific comparison','disclosure':'Source-exposed agent evidence. Dynamic checks establish bounded source/adaptation conformance, not independent human labels, unseen data or global correctness.'}
 output.parent.mkdir(parents=True,exist_ok=True);output.write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps({k:v for k,v in receipt.items()if k not in ['controls','published','corpusBindings']}),flush=True)
if __name__=='__main__':main()
