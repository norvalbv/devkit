#!/usr/bin/env python3
"""Replay four source-regression families; no models, source mutation or corpus edits.

Requires the public qualification helper shipped in --repository. --source is a
read-only local BugsJS/eslint clone. --work must be new and disposable. All fixture
bytes come from the pinned corpus except explicitly rejected target-only repairs.
"""
import argparse,importlib.util,json,os,shutil,subprocess,sys
from pathlib import Path
sys.dont_write_bytecode=True
HERE=Path(__file__).resolve().parent

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--repository',type=Path,required=True);p.add_argument('--source',type=Path,required=True);p.add_argument('--work',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args();repo=a.repository.resolve();clone=a.source.resolve();work=a.work.resolve();output=a.output.resolve()
 assert not work.exists(),'Use a new disposable work directory';work.mkdir(parents=True)
 manifest=json.loads((HERE/'eslint-regression-manifest.json').read_text());spec=importlib.util.spec_from_file_location('existing_qualification_replay',repo/manifest['supportReplay']);support=importlib.util.module_from_spec(spec);spec.loader.exec_module(support)
 sha=support.sha;unpack=support.unpack
 corpus=(repo/manifest['corpusPath']).read_bytes();assert sha(corpus)==manifest['corpusSha256'],'Corpus identity changed'
 rows={row['id']:row for row in map(json.loads,corpus.splitlines())};node=subprocess.check_output(['node','--version']).decode().strip();assert node=='v24.19.0',node;results=[]
 def git(*args):return subprocess.check_output(['git','-C',str(clone),*args])
 for case in manifest['cases']:
  name=case['name'];d=work/name;checkout=d/'source';checkout.mkdir(parents=True);archive=git('archive','--format=tar',case['coreCommit'],*case['coreArchivePaths']);assert sha(archive)==case['coreArchiveSha256'];unpack(archive,checkout)
  assert git('rev-parse',case['refs']['bug']+'^').decode().strip()==case['refs']['parent'];git('merge-base','--is-ancestor',case['refs']['bug'],case['refs']['repair'])
  runtime=work/case['runtime'];runtime.mkdir(parents=True,exist_ok=True)
  for filename,key in [('package.json','packageSha256'),('package-lock.json','lockSha256')]:
   b=(HERE/case['runtime']/filename).read_bytes();assert sha(b)==case[key];(runtime/filename).write_bytes(b)
  with (runtime/'install.log').open('w') as log:subprocess.run(['npm','ci','--ignore-scripts','--no-audit','--no-fund','--legacy-peer-deps'],cwd=runtime,stdout=log,stderr=subprocess.STDOUT,check=True)
  (checkout/'node_modules').symlink_to(runtime/'node_modules',target_is_directory=True)
  (d/'refs.json').write_text(json.dumps({'rule':case['rule'],'runtimeVersion':case['runtimeVersion']}))
  bound=[]
  for stage,e in case['endpoints'].items():
   original=git('show',e['ref']+':lib/rules/'+case['rule']+'.js');assert sha(original)==e['sourceSha256'];(d/(stage+'-source.js')).write_bytes(original)
   if 'corpus' in e:
    cp=e['corpus'];row=rows[cp['id']];adapted=row['repo'][cp['repo']][cp['file']].encode();bound.append({'id':cp['id'],'repo':cp['repo'],'file':cp['file'],'sha256':sha(adapted)})
    assert row['expected']==('PASS'if stage=='repair'else'FAIL')
   else:
    assert e.get('notClean')is True;adapted=(HERE/e['targetOnlyAdaptation']).read_bytes()
   assert sha(adapted)==e['adaptedSha256'];(d/(stage+'.js')).write_bytes(adapted)
  for which,script,expected in [('targets','eslint-regression-target-controls.cjs',case['expectedTargets']),('edges','eslint-regression-edge-controls.cjs',case['expectedEdges'])]:
   result=d/(which+'.json')
   with (d/(which+'.log')).open('w')as log:subprocess.run(['node',str(HERE/script),name,str(d),str(result)],cwd=checkout,stdout=log,stderr=subprocess.STDOUT,timeout=45,check=True)
   actual=json.loads(result.read_text());wanted=json.loads((HERE/expected).read_text());assert actual==wanted,(name,which,'exact expected observations differ')
   records=actual.get('observations',actual.get('records'));assert records
   if isinstance(records,int):records=actual['records']
   for source in [x for x in records if x['kind']=='source']:
    adapted=next(x for x in records if x['kind']=='adapted'and x['stage']==source['stage']and x['scenario']==source['scenario']);strip=lambda x:{k:v for k,v in x.items()if k!='kind'};assert strip(source)==strip(adapted),(name,which,'dynamic source/adaptation mismatch')
  targets=json.loads((d/'targets.json').read_text());edges=json.loads((d/'edges.json').read_text());receipt={'family':name,'coreCommit':case['coreCommit'],'coreArchiveSha256':case['coreArchiveSha256'],'lockSha256':case['lockSha256'],'corpusBindings':bound,'targetObservations':len(targets['observations']),'independentObservations':len(edges['records']),'sourceAdaptationComparisons':(len(targets['observations'])+len(edges['records']))//2,'sourceAdaptationAgrees':True,'exactExpectedObservationsAgree':True,'eligibleGold':True,'eligibleClean':case['eligibleClean'],'laterEndpointRole':case['laterEndpointRole']};results.append(receipt);print(json.dumps(receipt),flush=True)
 receipt={'runtime':node,'corpusSha256':sha(corpus),'manifestSha256':sha((HERE/'eslint-regression-manifest.json').read_bytes()),'dynamicReplay':True,'families':results,'targetObservations':sum(x['targetObservations']for x in results),'independentObservations':sum(x['independentObservations']for x in results),'sourceAdaptationComparisons':sum(x['sourceAdaptationComparisons']for x in results),'sourceAdaptationAgrees':True,'exposure':'Source-exposed agent qualification; not a model benchmark or independent human labels.'};output.parent.mkdir(parents=True,exist_ok=True);output.write_text(json.dumps(receipt,indent=2)+'\n')
if __name__=='__main__':main()
