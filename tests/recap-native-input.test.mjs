import assert from "node:assert/strict";
import test from "node:test";
import {readFile, mkdtemp, rm} from "node:fs/promises";
import {resolve} from "node:path";
import {tmpdir} from "node:os";
import {MarketWorkflow} from "../scripts/daily-workflow.mjs";
import {fixtureInput} from "./daily-v10-fixture.mjs";
import {recapFixture} from "./complete-recap-fixture.mjs";
import {recapTargets} from "../scripts/complete-recap.mjs";
import {assertRecapStageTargets,completeRecapQueryLimit,availableRecapRepairQueries,recapDiscoveryQueries,validateRecapDiscoveryOutput} from "../scripts/recap-native-input.mjs";

test("native recap inputs must match the immutable complete target set and the actual output bounds", async()=>{
 const {envelope}=recapFixture();
 const payload={envelope,targets:recapTargets(envelope)};
 for(const [role,file] of [["recap_attributor","recap-attribution.schema.json"],["recap_writer","recap.schema.json"],["recap_reviewer","recap-review.schema.json"]]){
  const schema=JSON.parse(await readFile(new URL('../docs/daily-agents/'+file,import.meta.url),'utf8'));
  assert.doesNotThrow(()=>assertRecapStageTargets(role,payload,schema));
  assert.throws(()=>assertRecapStageTargets(role,{...payload,targets:payload.targets.slice(0,1)},schema),/未启动原始调用/u);
  const changed=structuredClone(payload);changed.targets[1].change="+99.00%";
  assert.throws(()=>assertRecapStageTargets(role,changed,schema),/冻结行情/u);
  const duplicate=structuredClone(payload);duplicate.targets[1]=duplicate.targets[0];
  assert.throws(()=>assertRecapStageTargets(role,duplicate,schema),/冻结行情/u);
  assert.throws(()=>assertRecapStageTargets(role,payload,{properties:{}}),/输出目标数量/u);
 }
 assert.doesNotThrow(()=>assertRecapStageTargets('facts',{},{}));
});

test("discovery, recap repair and the remaining narrative keep separate cumulative query capacity",()=>{
 assert.equal(completeRecapQueryLimit(20),108);
 assert.equal(availableRecapRepairQueries(108,80),12);
 assert.equal(availableRecapRepairQueries(108,84,2),10);
 assert.equal(availableRecapRepairQueries(108,96),0);
 assert.equal(availableRecapRepairQueries(108,108),0);
 assert.throws(()=>completeRecapQueryLimit(0),/数量/u);
});

test("new-session discovery retains only actual supported URLs, never generated clocks or facts",()=>{
 const {envelope}=recapFixture();
 const slug='stock-market-today-thursday-oct-1-dow-sp-500-nasdaq-080602402';
 const url=`https://finance.yahoo.com/markets/live/${slug}.html`;
 const output={contractVersion:'stock-daily-recap-discovery-v1',market:'US',marketAsOf:envelope.marketAsOf,queries:recapDiscoveryQueries(envelope),sourceUrls:[url+'?guccounter=1',`https://ca.finance.yahoo.com/news/${slug}.html`,url+'?fake=1','https://other.example/'+slug+'.html'],publishedAt:'Invented clock',facts:'Invented causal claim'};
 const leads=validateRecapDiscoveryOutput(output,envelope);
 assert.deepEqual(leads,[{url:url+'?guccounter=1',discoveryOnly:true}]);
 assert.deepEqual(validateRecapDiscoveryOutput({...output,sourceUrls:[]},envelope),[]);
 assert.throws(()=>validateRecapDiscoveryOutput({...output,marketAsOf:'2026-08-20'},envelope),/交易日/u);
 assert.throws(()=>validateRecapDiscoveryOutput({...output,queries:output.queries.slice(0,1)},envelope),/查询/u);
 assert.throws(()=>validateRecapDiscoveryOutput({...output,sourceUrls:Array(9).fill(url)},envelope),/地址结构/u);
});

test("first-run discovery validates the process queries and preserves a legitimate empty result on resume", async t => {
 for (const variant of ["valid", "missing", "extra", "different"]) {
  await t.test(variant, async () => {
   const root = await mkdtemp(resolve(tmpdir(), "stock-daily-native-discovery-"));
   try {
    const workflow = new MarketWorkflow({input: fixtureInput(), market: "US", completeRecap: true, workRoot: root});
    await workflow.initialize();
    assert.deepEqual(workflow.recapDiscoveryLeads, []);
    let calls = 0;
    // Controlled process events exercise validation; these are not live searches.
    workflow.runAgent = async ({role, payload}) => {
     calls++;
     assert.equal(role, "recap_discovery");
     const queries = variant === "missing" ? payload.queries.slice(0, 1) : variant === "extra" ? [...payload.queries, "extra controlled query"] : variant === "different" ? ["different controlled query", payload.queries[1]] : payload.queries;
     const events = [...queries.map(query => JSON.stringify({type: "item.completed", item: {type: "web_search", action: {type: "search", queries: [query]}}})), JSON.stringify({type: "turn.completed"})].join("\n");
     return {output: {...payload, contractVersion: "stock-daily-recap-discovery-v1", sourceUrls: []}, events};
    };
    if (variant === "valid") {
     const book = await workflow.prepareRecapNewsOriginals();
     assert.equal(calls, 1);
     assert.deepEqual(book.snapshots, []);
     assert.deepEqual(workflow.newsOriginalsContext.sources, []);
     await workflow.prepareRecapNewsOriginals();
     assert.equal(calls, 1, "an empty frozen result must not silently grant another discovery attempt");
    } else {
     await assert.rejects(() => workflow.prepareRecapNewsOriginals(), /真实搜索|实际执行/);
     assert.equal(calls, 2);
     assert.equal(workflow.newsOriginalsBook, undefined);
    }
   } finally { await rm(root, {recursive: true, force: true}); }
  });
 }
});
