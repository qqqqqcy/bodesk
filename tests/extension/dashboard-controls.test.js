import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

test('采集页面保留账号、同步与导出，移除公司和JD视图逻辑',()=>{
  const html=readFileSync(new URL('../../extension/dashboard.html',import.meta.url),'utf8');
  const script=readFileSync(new URL('../../extension/dashboard.js',import.meta.url),'utf8');
  for(const id of ['account-select','refresh','sync','stop-sync','export','conversation-count'])assert.match(html,new RegExp('id="'+id+'"'));
  for(const id of ['company-list','job-count','company-filter','status-filter','delete-from-link'])assert.doesNotMatch(html,new RegExp('id="'+id+'"'));
  for(const type of ['DB_GET','SELECT_ACCOUNT','SYNC','STOP_SYNC','EXPORT'])assert.ok(script.includes("'"+type+"'"));
  assert.doesNotMatch(script,/renderJob|renderNote|FIND_JOB|DELETE_JOB|company-filter|job-count/);
});
