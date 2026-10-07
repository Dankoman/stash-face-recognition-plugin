const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const context={console,URL};vm.runInNewContext(fs.readFileSync('standalone-browser.js','utf8'),context);
const api=context.FaceRecognitionStandalone;
const fields=['name','aliases','remote_site_id','images','birthdate','country','height','weight','career_start','career_end','tattoos','piercings','fake_tits','urls'];
function setup({rows,rowsByEndpoint,failEndpoints=[],fail=false,boxes=[{name:'StashDB',endpoint:'https://stashdb.org/graphql'}]}={}) {
 const calls=[];const client=api.metadataClient(async(query,variables)=>{
  calls.push({query,variables});
  if(query.includes('__type'))return {configuration:{general:{stashBoxes:boxes}},__type:{fields:fields.map(name=>({name}))}};
  const endpoint=variables.source.stash_box_endpoint;
  if(fail||failEndpoints.includes(endpoint))throw new Error('provider offline');
  if(rowsByEndpoint)return {scrapeSinglePerformer:rowsByEndpoint[endpoint]||[]};
  return {scrapeSinglePerformer:rows||[{name:'Synthetic Person',aliases:'Alias, Other',remote_site_id:'remote',images:['data:image/png;base64,aGVsbG8='],height:'170',weight:'60',career_start:'2010',tattoos:'arm'}]};
 });return {client,calls};
}
test('native Stash query imports full metadata and never requests credentials',async()=>{
 const {client,calls}=setup();const result=await client.lookup('Synthetic Person');
 assert.equal(result.performer.id,'remote');assert.equal(result.performer.height,'170');assert.equal(result.performer.career_start_year,'2010');assert.deepEqual(Array.from(result.performer.aliases),['Alias','Other']);
 assert.equal(result.image_url,'data:image/png;base64,aGVsbG8=');
 assert.ok(calls.every(c=>!c.query.includes('api_key')&&!c.query.includes('apiKey')));
 assert.equal(calls[1].variables.source.stash_box_endpoint,'https://stashdb.org/graphql');
 await client.lookup('Synthetic Person');assert.equal(calls.length,2);
});
test('partial names cannot import an unrelated identity',async()=>{
 const {client}=setup({rows:[{name:'Synthetic Person Two',aliases:''}]});assert.equal(await client.lookup('Synthetic Person'),null);
});
test('aliases can match and ambiguous identities require manual resolution',async()=>{
 const {client}=setup();assert.equal((await client.lookup('Alias')).performer.name,'Synthetic Person');
 const ambiguous=setup({rows:[{name:'Synthetic Person'},{name:'Synthetic Person'}]});await assert.rejects(ambiguous.client.lookup('Synthetic Person'),/tvetydig/);
});
test('provider failures are distinct from no match and missing configuration',async()=>{
 await assert.rejects(setup({fail:true}).client.lookup('Synthetic Person'),/provider offline/);
 await assert.rejects(setup({boxes:[]}).client.lookup('Synthetic Person'),/Metadata Providers/);
 assert.equal(await setup({rows:[]}).client.lookup('Synthetic Person'),null);
});
test('preferred metadata source is tried first with fallback through native providers',async()=>{
 const {client,calls}=setup({boxes:[{name:'StashDB',endpoint:'https://stashdb.org/graphql'},{name:'ThePornDB',endpoint:'https://theporndb.net/graphql'}]});
 await client.lookup('Synthetic Person',[],{metadata_source:'tpdb'});assert.equal(calls[1].variables.source.stash_box_endpoint,'https://theporndb.net/graphql');
});

const sameNameRows=[{name:'Synthetic Person',remote_site_id:'other-person'},{name:'Synthetic Person',remote_site_id:'linked-person'}];
const linkedIdentity={stash_ids:[{endpoint:'https://stashdb.org/graphql/',stash_id:'linked-person'}]};
test('saved source ID resolves two exact name matches to the linked person',async()=>{
 const {client}=setup({rows:sameNameRows});
 const result=await client.lookup('Synthetic Person',[],{},undefined,linkedIdentity);
 assert.equal(result.performer.id,'linked-person');
 await assert.rejects(client.lookup('Synthetic Person'),/tvetydig/);
});
test('a saved ID is authoritative after a remote name change',async()=>{
 const {client}=setup({rows:[sameNameRows[0],{...sameNameRows[1],name:'Changed Name'}]});
 assert.equal((await client.lookup('Synthetic Person',[],{},undefined,linkedIdentity)).performer.id,'linked-person');
});
test('a missing saved identity never selects the other same-name person',async()=>{
 const {client}=setup({rows:[sameNameRows[0]]});
 assert.equal(await client.lookup('Synthetic Person',[],{},undefined,linkedIdentity),null);
});
test('same-name identities have separate cache entries',async()=>{
 const {client}=setup({rows:sameNameRows});
 assert.equal((await client.lookup('Synthetic Person',[],{},undefined,linkedIdentity)).performer.id,'linked-person');
 const other={stash_ids:[{endpoint:'https://stashdb.org/graphql',stash_id:'other-person'}]};
 assert.equal((await client.lookup('Synthetic Person',[],{},undefined,other)).performer.id,'other-person');
});
test('duplicate rows for one remote ID are a single identity',async()=>{
 const {client}=setup({rows:[sameNameRows[1],sameNameRows[1]]});
 assert.equal((await client.lookup('Synthetic Person')).performer.id,'linked-person');
});

test('enrichment only searches sources linked to the existing identity',async()=>{
 const {client,calls}=setup({rows:sameNameRows,boxes:[{name:'ThePornDB',endpoint:'https://theporndb.net/graphql'},{name:'StashDB',endpoint:'https://stashdb.org/graphql'}]});
 const result=await client.lookup('Synthetic Person',[],{metadata_source:'tpdb'},undefined,linkedIdentity);
 assert.equal(result.performer.id,'linked-person');
 assert.equal(calls[1].variables.source.stash_box_endpoint,'https://stashdb.org/graphql');
});

const providerBoxes=[
 {name:'FansDB',endpoint:'https://fansdb.cc/graphql'},
 {name:'PWM Stash',endpoint:'https://pmvstash.org/graphql'},
 {name:'PornDB_new',endpoint:'https://theporndb.net/graphql'},
 {name:'stashdb.org',endpoint:'https://stashdb.org/graphql'},
];
const orderedEndpoints=['https://stashdb.org/graphql','https://theporndb.net/graphql','https://pmvstash.org/graphql','https://fansdb.cc/graphql'];
const match=id=>[{name:'Synthetic Person',remote_site_id:id}];
const searched=calls=>calls.filter(call=>call.variables.source).map(call=>call.variables.source.stash_box_endpoint);
test('all searches StashDB, TPDB, PMVStash and FansDB in order, regardless of configured order',async()=>{
 const {client,calls}=setup({boxes:providerBoxes,rowsByEndpoint:{[orderedEndpoints[3]]:match('fans-match')}});
 assert.equal((await client.lookup('Synthetic Person',[],{metadata_source:'all'})).performer.id,'fans-match');
 assert.deepEqual(searched(calls),orderedEndpoints);
});
test('all stops at the first matching source without querying later sources',async()=>{
 for(const winningIndex of [0,1,2]) {
  const rowsByEndpoint=Object.fromEntries(orderedEndpoints.slice(winningIndex).map((endpoint,i)=>[endpoint,match('result-'+i)]));
  const {client,calls}=setup({boxes:providerBoxes,rowsByEndpoint});
  assert.equal((await client.lookup('Synthetic Person',[],{metadata_source:'all'})).performer.id,'result-0');
  assert.deepEqual(searched(calls),orderedEndpoints.slice(0,winningIndex+1));
 }
});
test('all skips unconfigured sources and recognizes a TPDB metadataapi endpoint',async()=>{
 const boxes=[providerBoxes[0],{name:'Custom name',endpoint:'https://metadataapi.net/graphql'}];
 const {client,calls}=setup({boxes,rowsByEndpoint:{'https://metadataapi.net/graphql':match('tpdb-match')}});
 assert.equal((await client.lookup('Synthetic Person',[],{metadata_source:'all'})).performer.id,'tpdb-match');
 assert.deepEqual(searched(calls),['https://metadataapi.net/graphql']);
});
test('all tries aliases within each source before moving to the next source',async()=>{
 const {client,calls}=setup({boxes:providerBoxes,rowsByEndpoint:{[orderedEndpoints[1]]:match('tpdb-match')}});
 await client.lookup('Synthetic Person',['Other Alias'],{metadata_source:'all'});
 assert.deepEqual(searched(calls),[orderedEndpoints[0],orderedEndpoints[0],orderedEndpoints[1]]);
});
test('all can use the next source after a provider error or ambiguous result',async()=>{
 for(const options of [{failEndpoints:[orderedEndpoints[0]]},{rowsByEndpoint:{[orderedEndpoints[0]]:sameNameRows,[orderedEndpoints[1]]:match('tpdb-match')}}]) {
  const {client,calls}=setup({boxes:providerBoxes,rowsByEndpoint:{[orderedEndpoints[1]]:match('tpdb-match')},...options});
  assert.equal((await client.lookup('Synthetic Person',[],{metadata_source:'all'})).performer.id,'tpdb-match');
  assert.deepEqual(searched(calls),orderedEndpoints.slice(0,2));
 }
});
test('all distinguishes no match from unavailable or ambiguous sources',async()=>{
 assert.equal(await setup({boxes:providerBoxes,rows:[]}).client.lookup('Synthetic Person',[],{metadata_source:'all'}),null);
 await assert.rejects(setup({boxes:providerBoxes,fail:true}).client.lookup('Synthetic Person',[],{metadata_source:'all'}),/provider offline/);
 await assert.rejects(setup({boxes:providerBoxes,rows:sameNameRows}).client.lookup('Synthetic Person',[],{metadata_source:'all'}),/tvetydig/);
});
test('all does not import unrelated providers or silently create a name-only profile without supported sources',async()=>{
 const {client}=setup({boxes:[{name:'Other source',endpoint:'https://example.test/graphql'}]});
 await assert.rejects(client.lookup('Synthetic Person',[],{metadata_source:'all'}),/Konfigurera StashDB/);
});
test('all respects saved identities while searching linked sources in the fixed order',async()=>{
 const identity={stash_ids:[{endpoint:orderedEndpoints[0],stash_id:'linked-person'},{endpoint:orderedEndpoints[2],stash_id:'pmv-match'}]};
 const {client,calls}=setup({boxes:providerBoxes,rowsByEndpoint:{[orderedEndpoints[0]]:[sameNameRows[0]],[orderedEndpoints[1]]:match('unlinked-match'),[orderedEndpoints[2]]:match('pmv-match')}});
 assert.equal((await client.lookup('Synthetic Person',[],{metadata_source:'all'},undefined,identity)).performer.id,'pmv-match');
 assert.deepEqual(searched(calls),[orderedEndpoints[0],orderedEndpoints[2]]);
});
