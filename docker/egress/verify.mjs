
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawnSync, spawn} from 'node:child_process';
import {mkdirSync, mkdtempSync, writeFileSync, createWriteStream, existsSync} from 'node:fs';
import {networkInterfaces, tmpdir} from 'node:os';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const output=resolve(process.env.EGRESS_VERIFY_OUTPUT || mkdtempSync(tmpdir()+'/reader-egress-evidence-'));
mkdirSync(output,{recursive:true});
const temporary=mkdtempSync(tmpdir()+'/reader-egress-');
const project='reader-egress-'+process.pid+'-'+Date.now();
const network=project+'-network', control=project+'-control', protectedName=project+'-renderer';
const records=[], results=[], commands=[], apiResponses=[];
const bundledImage=process.env.EGRESS_VERIFY_IMAGE || 'reader-next:egress-verify';
let app;
function docker(args, name, env=process.env) {
    const lf=String.fromCharCode(10);
    const result=spawnSync('docker',args,{encoding:'utf8',env,stdio:['ignore','pipe','pipe']});
    commands.push({args,status:result.status});
    if(name){
        const stdout=String(result.stdout || ''),stderr=String(result.stderr || '');
        writeFileSync(output+'/'+name,name.endsWith('.json')?stdout:'STDOUT'+lf+stdout+lf+'STDERR'+lf+stderr);
        if(name.endsWith('.json'))writeFileSync(output+'/'+name+'.stderr.txt',stderr);
    }
    if(result.error)throw result.error;
    if(result.status!==0)throw new Error('docker '+args.join(' ')+' exited '+result.status+lf+String(result.stderr || ''));
    return String(result.stdout || '').trim();
}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const forbidden=createServer((req,res)=>{
    records.push({kind:'forbidden',url:req.url});
    res.setHeader('Access-Control-Allow-Origin','*');
    res.end('CONTROLLED_INTERNAL_DATA_C10');
});
const option=',{"webView":true}';
const attribute=path=>(path+option).replaceAll('"','&quot;');
const normal=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    records.push({kind:'normal',url:req.url,method:req.method,body});
    const path=new URL(req.url,'http://fixture').pathname;
    if(path==='/redirect'){res.writeHead(302,{Location:forbiddenURL});res.end();return;}
    const pages={
        '/search':"<a class='book' href='"+attribute('/detail')+"'>Normal Fixture</a>",
        '/detail':"<h1>Normal Fixture</h1><a id='toc' href='"+attribute('/toc')+"'>Catalog</a>",
        '/toc':"<a class='chapter' href='"+attribute('/chapter')+"'>First</a>",
        '/chapter':"<div id='content'>EGRESS_NORMAL_FIRST_CHAPTER</div>",
        '/fetch':'<p>fetch fixture</p>'
    };
    res.setHeader('Content-Type','text/html; charset=utf-8');
    const html=pages[path] || '<p>Normal</p>';
    res.end(path==='/search'?'<html><body><script>document.body.innerHTML='+JSON.stringify(html)+'</script></body></html>':html);
});
await new Promise(r=>forbidden.listen(0,'0.0.0.0',r));
await new Promise(r=>normal.listen(0,'0.0.0.0',r));
let forbiddenURL;
const compose=['compose','-p',project,'-f',root+'/docker/compose.yml','-f',root+'/docker/compose.egress.yml','-f',temporary+'/override.yml','--profile','webview'];
const before=[];
async function ready(base) {
    for(let i=0;i<200;i++){try{if((await fetch(base+'/health')).ok)return;}catch{}await delay(100)}
    throw Error('renderer not ready');
}
async function render(base,url,js_source) {
    const res=await fetch(base+'/render.html',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url,js_source}),signal:AbortSignal.timeout(25000)});
    return await res.text();
}
try {
    docker(['network','create',network]);
    const info=JSON.parse(docker(['network','inspect',network]))[0];
    const gateway=info.IPAM.Config[0].Gateway;
    forbiddenURL='http://'+gateway+':'+forbidden.address().port+'/secret';
    const normalURL='http://'+gateway+':'+normal.address().port;
    const hostAddresses=Object.values(networkInterfaces()).flat().filter(a=>a && a.family==='IPv4' && !a.internal).map(a=>a.address+'/32');
    assert.ok(hostAddresses.length);
    const env={...process.env,READER_IMAGE:bundledImage,EGRESS_DENY_CIDRS:hostAddresses.join(' '),EGRESS_ALLOW_TCP:gateway+':'+normal.address().port};
    writeFileSync(output+'/test-policy.json',JSON.stringify({hostAddresses,testOnlyAllow:env.EGRESS_ALLOW_TCP,forbiddenURL,normalURL},null,2));
    writeFileSync(temporary+'/override.yml',JSON.stringify({
        services:{'remote-webview':{container_name:protectedName}},
        networks:{default:{external:true,name:network}}
    }));
    if(!process.env.EGRESS_VERIFY_IMAGE) docker(['build','-t',bundledImage,root],'build.txt',env);
    assert.equal(docker(['image','inspect','-f','{{index .Config.Labels "io.reader-next.bundled-webview"}}',bundledImage]),'1','Use an image with bundled WebView');
    docker(['run','-d','--name',control,'--network',network,'--cap-drop','ALL','--security-opt','no-new-privileges',bundledImage,'webview']);
    const controlIP=docker(['inspect','-f','{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',control]);
    const controlBase='http://'+controlIP+':8050';
    await ready(controlBase);
    const script='(async () => { try { return await (await fetch('+JSON.stringify(forbiddenURL)+')).text(); } catch { return "FETCH_BLOCKED"; } })()';
    for(const [label,url,js] of [['direct',forbiddenURL],['redirect',normalURL+'/redirect'],['subrequest',normalURL+'/fetch',script]]){
        const body=await render(controlBase,url,js);assert.ok(body.includes('CONTROLLED_INTERNAL_DATA_C10'),label+' '+body);
        before.push(label);
    }
    const publicHost=hostAddresses.map(s=>s.split('/')[0]).find(s=>!(/^(10\.|127\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)/.test(s)));
    let publicForbidden;
    if(publicHost){publicForbidden='http://'+publicHost+':'+forbidden.address().port+'/secret';assert.ok((await render(controlBase,publicForbidden)).includes('CONTROLLED_INTERNAL_DATA_C10'));before.push('host-public');}
    const hits=records.filter(r=>r.kind==='forbidden').length;
    assert.equal(hits,publicHost?4:3);
    docker([...compose,'up','-d','--no-build','remote-webview'],'up.txt',env);
    const gatewayID=docker([...compose,'ps','-q','renderer-net'],undefined,env);
    const ip=docker(['inspect','-f','{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',gatewayID]);
    const base='http://'+ip+':8050';
    await ready(base);
    for(const [label,url,js] of [['direct',forbiddenURL],['redirect',normalURL+'/redirect'],['subrequest',normalURL+'/fetch',script]]){
        const body=await render(base,url,js);
        assert.ok(!body.includes('CONTROLLED_INTERNAL_DATA_C10'),label);
        if(label==='subrequest')assert.equal(body,'FETCH_BLOCKED');
        else assert.ok(body.startsWith('Error: page.render:'));
        results.push({label,blocked:true,body});console.log('BLOCKED',label);
    }
    const alias=JSON.parse(docker(['exec',control,'node','-e',"fetch('http://remote-webview:8050/health').then(r=>r.text()).then(console.log)"]));assert.equal(alias.renderingCount,0);console.log('COMPOSE_SERVICE_ALIAS_PASS');
    if(publicForbidden){const body=await render(base,publicForbidden);assert.ok(body.startsWith('Error: page.render:'));results.push({label:'host-public',blocked:true,body});console.log('BLOCKED host-public');}
    if(process.env.EGRESS_VERIFY_PUBLIC_URL){const body=await render(base,process.env.EGRESS_VERIFY_PUBLIC_URL);assert.ok(body.includes(process.env.EGRESS_VERIFY_PUBLIC_MARKER || 'Example Domain'),body);console.log('PUBLIC_HTTPS_PASS');}
    for(const url of ['http://127.0.0.1:8050/health','http://127.0.0.11:8050/health','http://[::1]:8050/health']){
        const body=await render(base,url);assert.ok(body.startsWith('Error: page.render:'));results.push({url,blocked:true});
    }
    assert.equal(records.filter(r=>r.kind==='forbidden').length,hits);
    const binary=process.env.READER_BINARY || root+'/target/debug/reader-next';
    assert.ok(existsSync(binary),'Build the candidate reader binary before verification');
    const reserve=createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
    const storage=temporary+'/storage';mkdirSync(storage);
    const log=createWriteStream(output+'/reader.txt');
    app=spawn(binary,[],{cwd:root,env:{...process.env,SERVER_HOST:'127.0.0.1',SERVER_PORT:String(port),SECURE:'true',SECURE_KEY:'egress-fixture-only',STORAGE_DIR:storage,DATABASE_URL:'sqlite:'+storage+'/reader.db?mode=rwc',CHAPTER_UPDATE_INTERVAL_HOURS:'0',LOG_LEVEL:'warn',REMOTE_WEBVIEW_URL:base}});
    app.stdout.pipe(log);app.stderr.pipe(log);
    const apiBase='http://127.0.0.1:'+port+'/reader3';
    async function api(path,body){
        const res=await fetch(apiBase+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-Secure-Key':'egress-fixture-only','X-User-NS':'alice'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
        const json=await res.json();apiResponses.push({path,status:res.status,json});assert.equal(json.isSuccess,true,JSON.stringify(json));return json.data;
    }
    for(let i=0;i<100;i++){try{await fetch(apiBase+'/getBookSources');break}catch{}await delay(100)}
    const source={bookSourceName:'Normal Fixture',bookSourceUrl:normalURL,searchUrl:normalURL+'/search'+option,ruleSearch:{bookList:'a.book',name:'@text',bookUrl:'@href'},ruleBookInfo:{name:'h1@text',tocUrl:'#toc@href'},ruleToc:{chapterList:'a.chapter',chapterName:'@text',chapterUrl:'@href'},ruleContent:{content:'#content@text'}};
    await api('/saveBookSource',source);
    const search=await api('/searchBook?'+new URLSearchParams({bookSourceUrl:normalURL,key:'Normal'}));
    assert.equal(search[0].name,'Normal Fixture');
    const book=search[0].bookUrl;
    const detail=await api('/getBookInfo?'+new URLSearchParams({bookSourceUrl:normalURL,url:book}));
    const toc=await api('/getChapterList?'+new URLSearchParams({bookSourceUrl:normalURL,tocUrl:detail.tocUrl,bookUrl:book,refresh:'1'}));
    const text=await api('/getBookContent?'+new URLSearchParams({bookSourceUrl:normalURL,bookUrl:book,chapterUrl:toc[0].url,refresh:'1'}));
    assert.ok(text.includes('EGRESS_NORMAL_FIRST_CHAPTER'));
    console.log('NORMAL_DYNAMIC_FIRST_CHAPTER_PASS');
    assert.equal(records.filter(r=>r.kind==='forbidden').length,hits);
    docker(['exec',gatewayID,'iptables-save'],'iptables.txt');
    docker(['exec',gatewayID,'iptables','-t','nat','-S'],'dns-nat.txt');
    docker(['exec',gatewayID,'ip','route','show'],'routes.txt');
    docker(['exec',gatewayID,'sha256sum','/app/egress/start.sh'],'policy-source-sha256.txt');
    docker(['exec',gatewayID,'ip6tables-save'],'ip6tables.txt');
    docker(['inspect',protectedName,gatewayID],'containers.json');
    writeFileSync(output+'/results.json',JSON.stringify({passed:true,unprotectedControl:before,results,forbiddenHitsBefore:hits,forbiddenHitsAfter:records.filter(r=>r.kind==='forbidden').length,normalFirstChapter:true},null,2));
    console.log('EGRESS_PASS evidence='+output);
} finally {
    writeFileSync(output+'/requests.json',JSON.stringify(records,null,2));
    writeFileSync(output+'/reader-responses.json',JSON.stringify(apiResponses,null,2));
    app?.kill('SIGTERM');
    normal.close();forbidden.close();
    try{docker([...compose,'down','--timeout','5'],'down.txt',{...process.env,READER_IMAGE:bundledImage,EGRESS_DENY_CIDRS:'127.0.0.1/32',EGRESS_ALLOW_TCP:''})}catch{}
    try{docker(['rm','-f',control])}catch{}
    try{docker(['network','rm',network])}catch{}
    writeFileSync(output+'/commands.json',JSON.stringify(commands,null,2));
}
