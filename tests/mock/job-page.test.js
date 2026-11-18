import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createWorld, jobPageFixtures} from '../../mock/fixtures.ts';
import {clientFor} from './support/client.js';

test('职位页数据按真实jobInfo和brandComInfo层次生成，已有JD与聊天记录使用相同ID',()=>{
  const world=createWorld(),before=structuredClone(world),fixtures=jobPageFixtures(world);
  const stored=new Set(world.conversations.map(item=>item.row.encryptJobId).filter(Boolean));
  assert.equal(fixtures.cases.existing,world.conversations[0].row.encryptJobId);
  assert.equal(new Set(fixtures.rows.map(row=>row.encryptJobId)).size,fixtures.rows.length);
  for(const row of fixtures.rows){
    const detail=fixtures.details[row.encryptJobId];
    assert.equal(detail.jobInfo.encryptId,row.encryptJobId);
    assert.equal(detail.jobInfo.jobName,row.jobName);
    assert.equal(detail.brandComInfo.brandName,row.brandName);
    assert.equal(detail.brandComInfo.encryptBrandId,row.encryptBrandId);
    assert.ok(!Object.hasOwn(detail.jobInfo,'brandName'));
    assert.ok(!JSON.stringify(detail).includes('securityId'));
  }
  for(const name of ['companyOnly','unknownCompany','sameTitleDifferentId'])assert.equal(stored.has(fixtures.cases[name]),false);
  const original=fixtures.details[fixtures.cases.existing];
  assert.equal(fixtures.details[fixtures.cases.companyOnly].brandComInfo.brandName,original.brandComInfo.brandName);
  assert.equal(fixtures.details[fixtures.cases.sameTitleDifferentId].jobInfo.jobName,original.jobInfo.jobName);
  assert.notEqual(fixtures.details[fixtures.cases.unknownCompany].brandComInfo.brandName,original.brandComInfo.brandName);
  assert.deepEqual(world,before);
});

test('职位页HTTP夹具不改聊天和消息，账号与场景切换隔离职位ID',async context=>{
  const client=await clientFor(context),before=await client.json('/__mock/list?all=1');
  const first=await client.json('/__mock/jobs');
  assert.equal(first.details[first.cases.existing].brandComInfo.brandName,'星河科技');
  assert.deepEqual(await client.json('/__mock/list?all=1'),before);
  assert.deepEqual(await client.json('/__mock/requests'),[]);
  await client.json('/__mock/state',{account:'beta',scenario:'ambiguous_resume'});
  const second=await client.json('/__mock/jobs'),previous=new Set(first.rows.map(row=>row.encryptJobId));
  assert.ok(second.rows.every(row=>!previous.has(row.encryptJobId)));
  await client.json('/__mock/state',{scenario:'empty'});
  const empty=await client.json('/__mock/jobs');
  assert.equal(empty.cases.existing,null);
  assert.equal(empty.rows.length,3);
});

test('删除演示JD在同一模拟会话稳定、重置后使用新ID',async context=>{
  const client=await clientFor(context),first=await client.json('/__mock/jobs'),again=await client.json('/__mock/jobs');
  assert.ok(first.cases.deleteByCard);assert.equal(first.cases.deleteByCard,again.cases.deleteByCard);
  assert.equal(first.details[first.cases.deleteByCard].brandComInfo.brandName,'删除演示公司');
  await client.json('/__mock/state',{scenario:'normal'});
  const reset=await client.json('/__mock/jobs');assert.notEqual(reset.cases.deleteByCard,first.cases.deleteByCard);
});

test('收藏夹具包含聊天已有、仅收藏和已下架岗位，取消收藏不改聊天数据',async context=>{
  const client=await clientFor(context),before=await client.json('/__mock/list?all=1');
  const favorites=await client.json('/__mock/favorites');assert.equal(favorites.rows.length,3);
  assert.ok(favorites.rows.some(row=>row.closed));
  const saved=favorites.rows.find(row=>row.encryptJobId.endsWith('-favorite-only'));
  assert.ok(!before.rows.some(row=>row.encryptJobId===saved.encryptJobId));
  assert.equal((await client.json('/__mock/jobs')).details[saved.encryptJobId].relationInfo.interestJob,true);
  await client.json('/__mock/favorite',{jobId:saved.encryptJobId,favorite:false});
  assert.equal((await client.json('/__mock/favorites')).rows.length,2);
  assert.equal((await client.json('/__mock/jobs')).details[saved.encryptJobId].relationInfo.interestJob,false);
  assert.deepEqual(await client.json('/__mock/list?all=1'),before);
  assert.equal((await client.request('/web/geek/recommend?tab=4&sub=1')).status,200);
});
