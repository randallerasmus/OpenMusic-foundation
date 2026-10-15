// npm run ship -- "commit message"
// Builds the web app (stopping on errors), commits every change in the repository, and pushes.
// A push to master triggers .github/workflows/deploy.yml, which uploads the site; other branches only push.
import {execFileSync} from 'node:child_process';

const message=process.argv.slice(2).join(' ').trim();
const run=(cmd,args,opts={})=>execFileSync(cmd,args,{stdio:'inherit',...opts});
const out=(cmd,args)=>execFileSync(cmd,args,{encoding:'utf8'}).trim();

const root=out('git',['rev-parse','--show-toplevel']);
const branch=out('git',['branch','--show-current']);
if(!branch){console.error('Not on a branch (detached HEAD); check out master first.');process.exit(1);}

console.log('› Building to check nothing is broken…');
run('npm',['run','build']);

const changes=out('git',['-C',root,'status','--porcelain']);
if(changes){
  if(!message){console.error('There are changes to commit: add a message, e.g. npm run ship -- "Fix lyrics scrolling"');process.exit(1);}
  console.log(`› Committing on ${branch}:\n${changes}`);
  run('git',['-C',root,'add','-A']);
  run('git',['-C',root,'commit','-m',message]);
}else console.log('› Nothing new to commit.');

// Bring in anything pushed from elsewhere (e.g. a pull request merged on GitHub) so the push isn't rejected.
// A rebase that conflicts is aborted, leaving everything as it was for a person to sort out.
const upstream=out('git',['-C',root,'ls-remote','--heads','origin',branch]);
if(upstream){
  console.log(`› Updating from origin/${branch}…`);
  run('git',['-C',root,'fetch','origin',branch]);
  try{run('git',['-C',root,'rebase',`origin/${branch}`]);}
  catch{try{run('git',['-C',root,'rebase','--abort']);}catch{} console.error(`✗ Your commits conflict with changes on GitHub's ${branch}. Nothing was pushed; resolve the conflict, then ship again.`);process.exit(1);}
}
console.log(`› Pushing ${branch}…`);
// --follow-tags also sends annotated tags on these commits (e.g. a build-N tag made locally).
run('git',['-C',root,'push','--follow-tags','-u','origin',branch]);

const remote=out('git',['-C',root,'remote','get-url','origin']).replace(/\.git$/,'').replace(/^git@github\.com:/,'https://github.com/');
if(branch==='master')console.log(`✓ Pushed. Deploying to https://music.khoi-san.co.za: follow it at ${remote}/actions\n  Deploy history: ${remote}/releases · live version: https://music.khoi-san.co.za/version.json`);
else console.log(`✓ Pushed ${branch}. Only master deploys; merge it into master to go live.`);
