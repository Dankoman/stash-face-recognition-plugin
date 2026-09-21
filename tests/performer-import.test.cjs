const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname,'..','face-recognition.js'),'utf8');
const entry = "init().catch(e => console.error('Initfel:', e));";
const scalar = name => ({kind:'SCALAR',name});
const list = name => ({kind:'LIST',ofType:{kind:'NON_NULL',ofType:scalar(name)}});
const fieldTypes = {name:scalar('String'),disambiguation:scalar('String'),alias_list:list('String'),urls:list('String'),stash_ids:list('StashIDInput'),gender:{kind:'ENUM',name:'GenderEnum'},ethnicity:scalar('String'),country:scalar('String'),birthdate:scalar('String'),death_date:scalar('String'),hair_color:scalar('String'),eye_color:scalar('String'),measurements:scalar('String'),height_cm:scalar('Int'),weight:scalar('Int'),career_start:scalar('String'),career_end:scalar('String'),tattoos:scalar('String'),piercings:scalar('String'),fake_tits:scalar('String'),image:scalar('String'),details:scalar('String')};
const metadata = {source_endpoint:'https://stashdb.org/graphql',image_url:'https://images.example.test/profile.png',performer:{id:'external-test-id',name:'Synthetic Person',aliases:['Alias One','Alias Two'],disambiguation:'synthetic fixture',gender:'FEMALE',ethnicity:'MIXED',country:'SE',birthdate:'1990-01-02',death_date:'2020-03-04',hair_color:'AUBURN',eye_color:'GREEN',height:170,weight:60,measurements:'34C-24-35',breast_type:'NATURAL',career_start_year:2010,career_end_year:2019,tattoos:[{location:'arm',description:'test'}],piercings:[{location:'ear',description:'test'}],details:'Synthetic test metadata',urls:['https://example.test/profile']}};
function setup(options={}) {
 const requests=[],mutations=[],notifications=[];
 const types={...fieldTypes,...options.fieldTypes};
 if (options.legacyAliases) { delete types.alias_list; types.aliases=scalar('String'); }
 const schema={performerInput:{inputFields:Object.entries(types).map(([name,type])=>({name,type}))},performerOutput:{fields:['id','image_path',...Object.keys(types)].map(name=>({name}))},performerUpdate:{inputFields:['id',...Object.keys(types)].map(name=>({name}))},genderEnum:{enumValues:[{name:'FEMALE'},{name:'MALE'},{name:'TRANS_FEMALE'}]}};
 const fixture=options.metadata || metadata;
 const response=(data,status=200)=>({ok:status>=200&&status<300,status,json:async()=>data,text:async()=>JSON.stringify(data)});
 const ctx={URL,Blob,File,FormData,AbortController,Uint8Array,btoa:value=>Buffer.from(value,'binary').toString('base64'),setTimeout:()=>1,clearTimeout(){},console:{debug(){},warn(){},error(){}},window:{location:{origin:'https://stash.test',protocol:'https:'},addEventListener(){}},document:{createElement:()=>({style:{},remove(){}}),body:{appendChild:el=>notifications.push(el.textContent)}},fetch:async(url,opts={})=>{
  requests.push({url,opts});
  if(url==='/graphql') {
   const body=JSON.parse(opts.body);
   if(body.query.includes('PerformerInputCaps')) return response(options.schemaError?{errors:[{message:'schema unavailable'}]}:{data:schema});
   if(body.query.includes('findPerformer(')) return response({data:{findPerformer:options.current}});
   mutations.push(body);
   if(options.mutationError)return response({errors:[{message:'invalid imported field'}]},422);
   return response({data:body.query.includes('performerCreate(')?{performerCreate:{id:'42',name:'Synthetic Person'}}:{performerUpdate:{id:'42'}}});
  }
  if(url.includes('/stashdb/performer'))return response(fixture,options.metadataStatus||200);
  if(options.imageFailure || (options.directBlocked && url.startsWith('https://images.')))throw new Error('image unavailable');
  return {ok:true,status:200,blob:async()=>new Blob(['synthetic image'],{type:options.imageMime||'image/png'})};
 }};
 vm.runInNewContext(source.replace(entry,`pluginSettings.create_new_performers=true; pluginSettings.image_source='local'; globalThis.api={create:createPerformerIfAllowed,build:buildPerformerCreateInput,complete:completeExistingPerformer,missing:profileImageMissing};`),ctx);
 return {api:ctx.api,requests,mutations,notifications};
}

test('imports every supported metadata field, all aliases and an inline profile image',async()=>{
 const t=setup();await t.api.create('Synthetic Person',['Extra Alias']);
 assert.equal(t.mutations.length,1);const input=t.mutations[0].variables.input;
 assert.deepEqual(input.alias_list,['Alias One','Alias Two','Extra Alias']);
 for(const [key,value] of Object.entries({name:'Synthetic Person',disambiguation:'synthetic fixture',gender:'FEMALE',ethnicity:'MIXED',country:'SE',birthdate:'1990-01-02',death_date:'2020-03-04',hair_color:'AUBURN',eye_color:'GREEN',height_cm:170,weight:60,measurements:'34C-24-35',fake_tits:'NATURAL',career_start:'2010',career_end:'2019',tattoos:'arm: test',piercings:'ear: test',details:'Synthetic test metadata'}))assert.equal(input[key],value,key);
 assert.deepEqual(input.urls,['https://example.test/profile']);
 assert.deepEqual(input.stash_ids,[{stash_id:'external-test-id',endpoint:'https://stashdb.org/graphql'}]);
 assert.equal(input.image,'data:image/png;base64,'+Buffer.from('synthetic image').toString('base64'));
});
test('legacy aliases String retains every alias',async()=>{
 const t=setup({legacyAliases:true});await t.api.create('Synthetic Person',[]);
 assert.equal(t.mutations[0].variables.input.aliases,'Alias One, Alias Two');
});
test('a rejected create is not retried with metadata stripped',async()=>{
 const t=setup({mutationError:true});await assert.rejects(t.api.create('Synthetic Person',[]),/invalid imported field/);
 assert.equal(t.mutations.length,1);assert.ok(t.mutations[0].variables.input.image);
});
test('an unavailable image cannot create an incomplete performer',async()=>{
 const t=setup({imageFailure:true});await assert.rejects(t.api.create('Synthetic Person',[]),/Profilbilden/);assert.equal(t.mutations.length,0);
});
test('an HTML error masquerading as HTTP 200 cannot become a profile image',async()=>{
 const t=setup({imageMime:'text/html'});await assert.rejects(t.api.create('Synthetic Person',[]),/Profilbilden/);assert.equal(t.mutations.length,0);
});
test('metadata and schema failures do not create bare-name records',async()=>{
 for(const options of [{metadataStatus:502},{metadataStatus:404},{schemaError:true}]) {
  const t=setup(options);await assert.rejects(t.api.create('Synthetic Person',[]));assert.equal(t.mutations.length,0);
 }
});
test('CORS failure falls back to the matched metadata provider, never the local placeholder',async()=>{
 const t=setup({directBlocked:true});await t.api.create('Synthetic Person',[]);
 const request=t.requests.find(r=>r.url.includes('/resolve_image'));assert.ok(request);
 assert.equal(new URL(request.url).searchParams.get('source'),'stashdb');
 assert.equal(new URL(request.url).searchParams.get('stashdb_endpoint'),'https://stashdb.org/graphql');
 assert.ok(t.mutations[0].variables.input.image.startsWith('data:image/png;'));
});
const current={id:'42',name:'Locally edited name',hair_color:'Blue',country:'NO',image_path:'https://stash.test/performer/42/image?default=true',alias_list:['Local Alias'],urls:['https://example.test/local'],stash_ids:[{stash_id:'external-test-id',endpoint:'https://stashdb.org/graphql'}]};
test('a linked existing profile receives missing data and image without overwriting local values',async()=>{
 const t=setup({current});await t.api.complete({id:'42'},'Synthetic Person',[]);
 const input=t.mutations[0].variables.input;assert.equal(input.id,'42');
 assert.equal(input.name,undefined);assert.equal(input.hair_color,undefined);assert.equal(input.country,undefined);
 assert.equal(input.eye_color,'GREEN');assert.ok(input.image.startsWith('data:image/png;'));
 assert.deepEqual(input.alias_list,['Local Alias','Alias One','Alias Two']);
 assert.deepEqual(input.urls,['https://example.test/local','https://example.test/profile']);
 assert.equal(input.stash_ids,undefined);
});
test('an existing custom image is preserved and no image request is made',async()=>{
 const t=setup({current:{...current,image_path:'https://stash.test/performer/42/image?t=1'}});
 await t.api.complete({id:'42'},'Synthetic Person',[]);
 assert.equal(t.mutations[0].variables.input.image,undefined);
 assert.ok(!t.requests.some(r=>r.url.includes('images.example')||r.url.includes('/resolve_image')));
});
test('a matching name without the same external identity cannot merge unrelated profiles',async()=>{
 for(const ids of [[],[{stash_id:'different-person',endpoint:'https://stashdb.org/graphql'}]]) {
  const t=setup({current:{...current,stash_ids:ids}});await t.api.complete({id:'42'},'Synthetic Person',[]);assert.equal(t.mutations.length,0);
 }
});
