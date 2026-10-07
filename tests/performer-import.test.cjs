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
 const requests=[],mutations=[],notifications=[],lookups=[];
 const types={...fieldTypes,...options.fieldTypes};
 if (options.legacyAliases) { delete types.alias_list; types.aliases=scalar('String'); }
 const schema={performerInput:{inputFields:Object.entries(types).map(([name,type])=>({name,type}))},performerOutput:{fields:['id','image_path',...Object.keys(types)].map(name=>({name}))},performerUpdate:{inputFields:['id',...Object.keys(types)].map(name=>({name}))},genderEnum:{enumValues:[{name:'FEMALE'},{name:'MALE'},{name:'TRANS_FEMALE'}]}};
 const fixture=options.metadata || metadata;
 const response=(data,status=200)=>({ok:status>=200&&status<300,status,json:async()=>data,text:async()=>JSON.stringify(data)});
 const ctx={FaceRecognitionStandalone:{metadataClient:()=>({lookup:async(...args)=>{
  lookups.push(args);
  if(options.metadataStatus===404)return null;
  if(options.metadataStatus && options.metadataStatus!==200)throw new Error('metadata unavailable');
  return fixture;
 }})},location:{pathname:'/scenes/14220'},URL,Blob,File,FormData,AbortController,Uint8Array,btoa:value=>Buffer.from(value,'binary').toString('base64'),setTimeout:()=>1,clearTimeout(){},console:{debug(){},warn(){},error(){}},window:{location:{origin:'https://stash.test',protocol:'https:'},addEventListener(){}},document:{createElement:()=>({style:{},remove(){}}),body:{appendChild:el=>notifications.push(el.textContent)}},fetch:async(url,opts={})=>{
  requests.push({url,opts});
  if(url==='/graphql') {
   const body=JSON.parse(opts.body);
   if(body.query.includes('PerformerInputCaps')) return response(options.schemaError?{errors:[{message:'schema unavailable'}]}:{data:schema});
   if(body.query.includes('findPerformers(')) return response({data:{findPerformers:{performers:options.localPerformers||[]}}});
   if(body.query.includes('findScene(')) return response({data:{findScene:{performers:(options.scenePerformers||[]).map(id=>({id}))}}});
   if(body.query.includes('findPerformer(')) return response({data:{findPerformer:options.current}});
   mutations.push(body);
   if(options.mutationError)return response({errors:[{message:'invalid imported field'}]},422);
   return response({data:body.query.includes('performerCreate(')?{performerCreate:{id:'42',name:'Synthetic Person'}}:{performerUpdate:{id:'42'}}});
  }
  if(url.includes('/stashdb/performer'))return response(fixture,options.metadataStatus||200);
  if(options.imageFailure || (options.directBlocked && url.startsWith('https://images.')))throw new Error('image unavailable');
  return {ok:true,status:200,blob:async()=>new Blob(['synthetic image'],{type:options.imageMime||'image/png'})};
 }};
 vm.runInNewContext(source.replace(entry,`pluginSettings.create_new_performers=true; pluginSettings.image_source='local'; globalThis.api={create:createPerformerIfAllowed,build:buildPerformerCreateInput,complete:completeExistingPerformer,missing:profileImageMissing,add:addPerformerToSceneByName};`),ctx);
 return {api:ctx.api,requests,mutations,notifications,lookups};
}

test('imports every supported metadata field, all aliases and a native Stash image URL',async()=>{
 const t=setup();await t.api.create('Synthetic Person',['Extra Alias']);
 assert.equal(t.mutations.length,1);const input=t.mutations[0].variables.input;
 assert.deepEqual(input.alias_list,['Alias One','Alias Two','Extra Alias']);
 for(const [key,value] of Object.entries({name:'Synthetic Person',disambiguation:'synthetic fixture',gender:'FEMALE',ethnicity:'MIXED',country:'SE',birthdate:'1990-01-02',death_date:'2020-03-04',hair_color:'AUBURN',eye_color:'GREEN',height_cm:170,weight:60,measurements:'34C-24-35',fake_tits:'NATURAL',career_start:'2010',career_end:'2019',tattoos:'arm: test',piercings:'ear: test',details:'Synthetic test metadata'}))assert.equal(input[key],value,key);
 assert.deepEqual(input.urls,['https://example.test/profile']);
 assert.deepEqual(input.stash_ids,[{stash_id:'external-test-id',endpoint:'https://stashdb.org/graphql'}]);
 assert.equal(input.image,metadata.image_url);
});
test('legacy aliases String retains every alias',async()=>{
 const t=setup({legacyAliases:true});await t.api.create('Synthetic Person',[]);
 assert.equal(t.mutations[0].variables.input.aliases,'Alias One, Alias Two');
});
test('a rejected create is not retried with metadata stripped',async()=>{
 const t=setup({mutationError:true});await assert.rejects(t.api.create('Synthetic Person',[]),/invalid imported field/);
 assert.equal(t.mutations.length,1);assert.ok(t.mutations[0].variables.input.image);
});
test('native image download failure rejects the create without a bare-name retry',async()=>{
 const t=setup({mutationError:true});await assert.rejects(t.api.create('Synthetic Person',[]),/invalid imported field/);
 assert.equal(t.mutations.length,1);assert.equal(t.mutations[0].variables.input.image,metadata.image_url);
});
test('metadata service and schema failures do not create bare-name records',async()=>{
 for(const options of [{metadataStatus:502},{schemaError:true}]) {
  const t=setup(options);await assert.rejects(t.api.create('Synthetic Person',[]));assert.equal(t.mutations.length,0);
 }
});
test('image downloads are delegated to Stash, with no browser CORS or Go proxy request',async()=>{
 const t=setup({directBlocked:true});await t.api.create('Synthetic Person',[]);
 assert.equal(t.mutations[0].variables.input.image,metadata.image_url);
 assert.ok(t.requests.every(r=>r.url==='/graphql'));
});
const current={id:'42',name:'Locally edited name',hair_color:'Blue',country:'NO',image_path:'https://stash.test/performer/42/image?default=true',alias_list:['Local Alias'],urls:['https://example.test/local'],stash_ids:[{stash_id:'external-test-id',endpoint:'https://stashdb.org/graphql'}]};
test('a linked existing profile receives missing data and image without overwriting local values',async()=>{
 const t=setup({current});await t.api.complete({id:'42'},'Synthetic Person',[]);
 const input=t.mutations[0].variables.input;assert.equal(input.id,'42');
 assert.equal(input.name,undefined);assert.equal(input.hair_color,undefined);assert.equal(input.country,undefined);
 assert.equal(input.eye_color,'GREEN');assert.equal(input.image,metadata.image_url);
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

test('a missing external match creates a performer using only the detected name',async()=>{
 const t=setup({metadataStatus:404});
 const created=await t.api.create('  Synthetic Person  ',['Extra Alias']);
 assert.equal(created.id,'42');
 assert.equal(t.mutations.length,1);
 assert.deepEqual(t.mutations[0].variables.input,{name:'Synthetic Person'});
 assert.ok(!t.requests.some(r=>r.url.includes('images.example')||r.url.includes('/resolve_image')));
});

test('an already attached performer skips ambiguous provider lookup and all mutations',async()=>{
 const t=setup({localPerformers:[{id:'42',name:'Synthetic Person'}],scenePerformers:['42','17'],metadataStatus:502});
 await t.api.add('Synthetic Person');
 assert.equal(t.lookups.length,0);
 assert.equal(t.mutations.length,0);
 assert.ok(t.notifications.some(message=>/finns redan i scenen/.test(message)));
});
test('metadata enrichment passes the saved external identity before lookup',async()=>{
 const t=setup({current});await t.api.complete({id:'42'},'Synthetic Person',[]);
 assert.deepEqual(JSON.parse(JSON.stringify(t.lookups[0][4].stash_ids)),current.stash_ids);
 assert.ok(t.requests.find(r=>r.url==='/graphql'&&JSON.parse(r.opts.body).query.includes('findPerformer(')));
});
test('an unlinked profile can be attached even when the metadata provider fails',async()=>{
 const t=setup({localPerformers:[{id:'42',name:'Synthetic Person'}],current:{...current,stash_ids:[]},scenePerformers:['17'],metadataStatus:502});
 await t.api.add('Synthetic Person');
 assert.equal(t.lookups.length,0);
 assert.equal(t.mutations.length,1);
 assert.ok(t.mutations[0].query.includes('sceneUpdate('));
 assert.deepEqual(t.mutations[0].variables.input,{id:'14220',performer_ids:[17,42]});
});
