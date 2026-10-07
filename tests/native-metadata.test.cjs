const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const context={console};vm.runInNewContext(fs.readFileSync('standalone-browser.js','utf8'),context);
const api=context.FaceRecognitionStandalone;
const fields=['name','aliases','remote_site_id','images','birthdate','country','height','weight','career_start','career_end','tattoos','piercings','fake_tits','urls'];
function setup({rows,fail=false,boxes=[{name:'StashDB',endpoint:'https://stashdb.org/graphql'}]}={}) {
 const calls=[];const client=api.metadataClient(async(query,variables)=>{
  calls.push({query,variables});
  if(query.includes('__type'))return {configuration:{general:{stashBoxes:boxes}},__type:{fields:fields.map(name=>({name}))}};
  if(fail)throw new Error('provider offline');
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
