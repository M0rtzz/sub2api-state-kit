'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ui = require('../ui/assets/app.js');

function configured(overrides = {}) {
  return { ...ui.DEFAULT_CONFIG, accounts: [{ account_id: 7, enabled: false, plan: 'pro', models: ['gpt-6-astra'] }], ...overrides };
}

test('empty configuration and newly imported accounts default off', () => {
  assert.deepEqual(ui.normalizeConfig({}), { ...ui.DEFAULT_CONFIG, accounts: [] });
  assert.equal(ui.normalizeConfig({ accounts: [{ account_id: 7 }] }).accounts[0].enabled, false);
  assert.equal(ui.normalizeConfig({ accounts: [{ account_id: 7 }] }).accounts[0].plan, 'pro');
  assert.equal(ui.validateConfig(configured()).enabled, false);
});

test('requires dynamic proxy only when global and account switches are both on', () => {
  assert.doesNotThrow(() => ui.validateConfig(configured({ enabled: true })));
  const config = configured({ enabled: true }); config.accounts[0].enabled = true;
  assert.throws(() => ui.validateConfig(config), /填写动态代理/);
  config.dynamic_proxy_url = 'socks5h://user-sid-{random}:placeholder@proxy.example:1080';
  assert.equal(ui.validateConfig(config), config);
  config.dynamic_proxy_url = 'javascript:alert(1)';
  assert.throws(() => ui.validateConfig(config), /HTTP/);
});

test('validates bounds, renewal horizon, duplicate accounts and model allowlist', () => {
  assert.throws(() => ui.validateConfig(configured({ max_attempts: 33 })), /1–32/);
  assert.throws(() => ui.validateConfig(configured({ ttl_minutes: 61 })), /1–60/);
  assert.throws(() => ui.validateConfig(configured({ cooldown_seconds: 29 })), /30–3600/);
  assert.throws(() => ui.validateConfig(configured({ ttl_minutes: 10, refresh_before_minutes: 10 })), /必须小于/);
  const config = configured(); config.accounts.push({ ...config.accounts[0] });
  assert.throws(() => ui.validateConfig(config), /重复/);
  config.accounts.pop(); config.accounts[0].models = ['gpt-6-astra', 'gpt-6-astra'];
  assert.throws(() => ui.validateConfig(config), /不能重复/);
  config.accounts[0].models = ['<img src=x onerror=alert(1)>'];
  assert.throws(() => ui.validateConfig(config), /模型须以/);
  config.accounts[0].models = ['gpt-6-astra']; config.accounts[0].plan = 'team';
  assert.doesNotThrow(() => ui.validateConfig(config));
});

test('status tolerates pre-initialization, de-duplicates safe IDs, never labels unknown state as raw text', () => {
  assert.deepEqual(ui.parseStatus({ healthy: true }), { host_ready: false, resources_ready: false, actions_ready: false, manual_test: null, accounts: [], proxies: [], account_ids: [], tickets: [], events: [], dynamic_proxy_mode:'auto', dynamic_proxy_entry_count:0, dynamic_proxy_active_id:'', dynamic_proxy_active_name:'', dynamic_proxy_active_country:'', dynamic_proxy_advanced_at:'', dynamic_proxy_advance_reason:'', message: '' });
  const status = ui.parseStatus({ status_json: JSON.stringify({ host_ready: true, account_ids: [8, 2, 8, null, -1, '9', '9007199254740992'], tickets: [] }) });
  assert.deepEqual(status.account_ids, [2, 8, 9]);
  assert.deepEqual(ui.stateLabel('raw-sensitive-ticket-content'), ['未知状态', 'warning']);
  assert.deepEqual(ui.stateLabel('ready'), ['可用', 'success']);
  assert.equal(ui.errorLabel('unknown-raw-ticket'), '操作未完成，请检查账号与插件设置。');
  assert.equal(ui.errorLabel('upstream_rate_limited'), '上游限流（429）');
  assert.throws(() => ui.parseStatus({ status_json: 'broken{' }), /格式不正确/);
});

test('redacts credentials and common ticket fields from error display', () => {
  const redacted = ui.redactError('proxy socks5h://my-user:my-secret@proxy.example:1080 x-codex-turn-state=opaque-state authorization=Bearer-token');
  assert.equal(redacted.includes('my-secret'), false);
  assert.equal(redacted.includes('opaque-state'), false);
  assert.equal(redacted.includes('Bearer-token'), false);
  assert.equal(ui.remainingText(127), '2 分 7 秒');
  assert.equal(ui.remainingText(-1), '—');
});

test('GeoNode country selector exposes 191 flags and replaces only country marker', () => {
  assert.equal(ui.GEONODE_COUNTRY_CODES.length, 191);
  assert.equal(new Set(ui.GEONODE_COUNTRY_CODES).size, 191);
  assert.match(ui.countryFlag('DE'), /\p{Regional_Indicator}/u);
  const original = 'socks5://demo-country-de:private@example.test:11000';
  const changed = ui.replaceProxyCountry(original, 'sg');
  assert.equal(changed, 'socks5://demo-country-sg:private@example.test:11000');
  assert.equal(ui.proxyCountryCode(changed), 'sg');
  assert.equal(ui.safeProxyEndpoint(changed), 'socks5://example.test:11000');
  assert.throws(() => ui.replaceProxyCountry('socks5://demo:private@example.test:11000', 'fr'), /country-xx/);
});

test('dynamic proxy pool validates legacy, manual and automatic configurations', () => {
  const legacy = ui.normalizeConfig({ dynamic_proxy_url: 'socks5://demo-country-de:private@example.test:11000' });
  assert.equal(legacy.dynamic_proxy_entries[0].id, 'legacy');
  assert.equal(legacy.dynamic_proxy_entries[0].country_code, 'de');
  const config = configured({ dynamic_proxy_mode:'manual', dynamic_proxy_selected_id:'sg',
    dynamic_proxy_entries:[
      {id:'de',name:'Germany',country_code:'de',url:'socks5://demo-country-de:private@example.test:11000'},
      {id:'sg',name:'Singapore',country_code:'sg',url:'socks5://demo-country-sg:private@example.test:11000'}
    ] });
  assert.equal(ui.validateConfig(config), config);
  assert.throws(() => ui.validateConfig({...config,dynamic_proxy_selected_id:'missing'}), /不在列表/);
  const duplicate = {...config,dynamic_proxy_entries:[config.dynamic_proxy_entries[0],{...config.dynamic_proxy_entries[0],id:'other'}]};
  assert.throws(() => ui.validateConfig(duplicate), /重复地址/);
});

class Node {
  constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.attributes = {}; this._value = ''; this.textContent = ''; this.hidden = false; this.disabled = false; this.checked = false; }
  get value() { return this._value; }
  set value(value) { this._value = String(value); }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = children; this.textContent = ""; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  setAttribute(key, value) { this.attributes[key] = value; }
  async fire(type, event = {}) { if (this.listeners[type]) return this.listeners[type]({ preventDefault() {}, ...event }); }
  click() { return this.fire('click'); }
}

function uiHarness() {
  const elements = new Map();
  const calls = { load: 0, save: [], test: 0, status: 0, dispose: 0, actions: [] };
  const timers = new Map();
  const document = { getElementById: id => { if (!elements.has(id)) elements.set(id, new Node('div')); return elements.get(id); },
    createElement: tag => new Node(tag), documentElement: { scrollHeight: 900 }, body: new Node('body'), visibilityState: 'visible' };
  let config = configured();
  let status = { host_ready: true, account_ids: [7, 12], tickets: [{ account_id: 7, plan: 'pro', model: 'gpt-6-astra', state: 'ready', remaining_seconds: 600, attempts: 1 }] };
  const bridge = { ready() {}, resize() {}, dispose() { calls.dispose++; },
    async load() { calls.load++; return { config }; },
    async save(value) { calls.save.push(value); return { config: value }; },
    async action(value) {calls.actions.push(value);return {request_id:'proxy-action-'+calls.actions.length,result:{accepted:true,message:'已开始'}};},
    async test() { calls.test++; return { result: { message: '检查通过' } }; },
    async status() { calls.status++; return { result: { status_json: JSON.stringify(status) } }; } };
  const global = { document, Sub2APIPluginBridge: bridge, setInterval: fn => { timers.set(1, fn); return 1; }, clearInterval: id => timers.delete(id), addEventListener() {}, removeEventListener() {} };
  const runtime = ui.start(global);
  return { elements, get: document.getElementById, calls, timers, runtime, bridge, setConfig:value=>{config=value;}, setStatus: value => { status = value; } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('passive status refresh preserves unsaved form and never invokes test or save', async () => {
  const h = uiHarness(); await settle();
  h.get('dynamic-proxy-url').value = 'socks5h://unsaved:password@proxy.example:1080';
  await h.get('config-form').fire('input');
  h.setStatus({ host_ready: true, account_ids: [7, 12, 13], tickets: [] });
  await h.runtime.refreshStatus();
  assert.equal(h.get('dynamic-proxy-url').value, 'socks5h://unsaved:password@proxy.example:1080');
  assert.equal(h.get('save-state').textContent, '有未保存修改');
  assert.equal(h.calls.load, 1); assert.equal(h.calls.save.length, 0); assert.equal(h.calls.test, 0);
  assert.equal(h.get('detected-accounts').children.length, 3);
  h.runtime.stop(); assert.equal(h.timers.size, 0);
});

test('adding account defaults off, saved-config check does not save or overwrite edits', async () => {
  const h = uiHarness(); await settle();
  h.get('new-account-id').value = '12'; await h.get('add-account').click();
  const row = h.get('accounts-body').children[1];
  assert.equal(row.children[1].children[0].checked, false);
  assert.equal(row.children[0].children[1].children[1].value, 'pro');
  await h.get('test-config').click();
  assert.equal(h.calls.test, 1); assert.equal(h.calls.save.length, 0);
  assert.equal(h.get('accounts-body').children.length, 2);
  assert.match(h.get('notice').textContent, /未保存修改/);
  h.runtime.stop();
});

test('explicit save button works without native form submission in sandbox', async () => {
  const h = uiHarness(); await settle();
  h.get('new-account-id').value = '12'; await h.get('add-account').click();
  await h.get('save-config').click();
  assert.equal(h.calls.save.length, 1);
  assert.equal(h.calls.save[0].enabled, false);
  assert.equal(h.calls.save[0].accounts[1].enabled, false);
  assert.equal(h.get('save-state').textContent, '已保存');
  assert.match(h.get('notice').textContent, /STATE Kit 已关闭/);
  h.runtime.stop();
});

test('country input builds an ordered pool, supports manual selection and hides credentials', async () => {
  const h = uiHarness(); await settle();
  assert.equal(h.get('dynamic-proxy-country').children.length, 192);
  h.get('dynamic-proxy-url').value = 'socks5://demo-country-de:private@example.test:11000';
  await h.get('add-dynamic-proxy').click();
  h.get('dynamic-proxy-country').value = 'sg'; await h.get('dynamic-proxy-country').fire('change');
  await h.get('add-dynamic-proxy').click();
  assert.equal(h.get('dynamic-proxy-list').children.length, 2);
  function text(node) { return String(node.textContent) + node.children.map(text).join(''); }
  assert.equal(text(h.get('dynamic-proxy-list')).includes('private'), false);
  const second = h.get('dynamic-proxy-list').children[1];
  await second.children[1].children[2].click();
  assert.equal(h.get('dynamic-proxy-mode').value, 'manual');
  await h.get('save-config').click();
  const saved = h.calls.save.at(-1);
  assert.equal(saved.dynamic_proxy_entries.length, 2);
  assert.equal(saved.dynamic_proxy_entries[0].country_code, 'de');
  assert.equal(saved.dynamic_proxy_entries[1].country_code, 'sg');
  assert.equal(saved.dynamic_proxy_selected_id, saved.dynamic_proxy_entries[1].id);
  assert.equal('dynamic_proxy_rotation_anchor' in saved, false);
  h.runtime.stop();
});

test('status rendering uses text nodes and never displays unrecognized raw state or model', async () => {
  const h = uiHarness(); await settle();
  h.setStatus({ host_ready: true, account_ids: [7], tickets: [{ account_id: 7, plan: 'pro', model: '<img src=x onerror=alert(1)>', state: 'SECRET-STATE-VALUE', last_error: 'x-codex-turn-state=SECRET-STATE-VALUE', remaining_seconds: 9 }] });
  await h.runtime.refreshStatus();
  function text(node) { return String(node.textContent) + node.children.map(text).join(''); }
  const rendered = text(h.get('accounts-body').children[0].children[2]);
  assert.equal(rendered.includes('SECRET-STATE-VALUE'), false);
  assert.equal(rendered.includes('<img'), false);
  assert.match(rendered, /未知状态/);
  h.runtime.stop();
});

test('front proxy settings validate, save and preserve unsaved edits during log refresh', async () => {
  const config = configured({ harvest_dial_proxy_url: 'socks5h://front:secret@example.test:1080', observe_exit_ip: true });
  assert.doesNotThrow(() => ui.validateConfig(config));
  assert.throws(() => ui.validateConfig({ ...config, harvest_dial_proxy_url: 'http://user-{sid}@proxy.test' }), /占位符/);
  assert.throws(() => ui.validateConfig({ ...config, harvest_dial_proxy_url: 'file:///secret' }), /HTTP/);
  const h = uiHarness(); await settle();
  h.get('harvest-dial-proxy-mode').value = 'manual';
  h.get('harvest-dial-proxy-url').value = config.harvest_dial_proxy_url;
  h.get('observe-exit-ip').checked = true;
  await h.get('config-form').fire('input');
  h.setStatus({ host_ready:true, events: [{ account_id:7, time:'2026-09-19T12:00:00Z', phase:'harvest', result:'model_matched', exit_ip:'203.0.113.8', actual_model:'gpt-test', http_status:200, state_bytes:292, attempt:2, chained:true }] });
  await h.runtime.refreshStatus();
  assert.equal(h.get('harvest-dial-proxy-url').value, config.harvest_dial_proxy_url);
  assert.equal(h.get('activity-body').children.length, 1);
  const row = h.get('activity-body').children[0];
  assert.match(row.children[1].textContent,/前置代理/);
  assert.equal(row.children[2].textContent,'203.0.113.8');
  await h.get('save-config').click();
  assert.equal(h.calls.save[0].harvest_dial_proxy_url,config.harvest_dial_proxy_url);
  assert.equal(h.calls.save[0].observe_exit_ip,true);
  h.runtime.stop();
});

test('activity does not render arbitrary model, IP, phase or error text', async () => {
 const h=uiHarness();await settle();
 h.setStatus({host_ready:true,events:[{account_id:7,phase:'SECRET',result:'SECRET',exit_ip:'SECRET',actual_model:'SECRET',state_bytes:'SECRET'}]});
 await h.runtime.refreshStatus();
 function text(n){return String(n.textContent)+n.children.map(text).join('');}
 assert.equal(text(h.get('activity-body')).includes('SECRET'),false);
 h.runtime.stop();
});


test('legacy config infers direct or manual mode', () => {
 assert.equal(ui.normalizeConfig({}).harvest_dial_proxy_mode, 'direct');
 assert.equal(ui.normalizeConfig({harvest_dial_proxy_url:'http://front.example:8080'}).harvest_dial_proxy_mode, 'manual');
 assert.throws(() => ui.validateConfig(configured({harvest_dial_proxy_mode:'managed'})), /请选择 IP/);
});
test('names and managed proxies render safely and refresh preserves unsaved selection and models', async () => {
 const h=uiHarness(); await settle();
 h.get('harvest-dial-proxy-mode').value='managed'; await h.get('harvest-dial-proxy-mode').fire('change');
 h.get('harvest-dial-proxy-id').value='3';
 const modelInput=h.get('accounts-body').children[0].children[0].children[1].children[2];
 modelInput.value='gpt-unsaved'; await modelInput.fire('input');
 h.setStatus({host_ready:true,resources_ready:true,account_ids:[7],accounts:[{id:7,name:'Mail <img onerror=bad>'}],proxies:[{id:3,name:'Front',protocol:'http',host:'front.example',port:8080}],tickets:[]});
 await h.runtime.refreshStatus();
 assert.match(h.get('accounts-body').children[0].children[0].children[0].textContent,/Mail.*ID 7/);
 assert.equal(h.get('accounts-body').children[0].children[0].children[0].children.length,0);
 assert.equal(h.get('accounts-body').children[0].children[0].children[1].children[2],modelInput);
 assert.equal(modelInput.value,'gpt-unsaved');
 assert.equal(h.get('harvest-dial-proxy-id').value,'3');
 assert.equal(h.get('managed-proxy-option').disabled,false);
 assert.equal(h.get('front-managed').hidden,false);
 await h.get('save-config').click();
 assert.equal(h.calls.save[0].harvest_dial_proxy_mode,'managed');
 assert.equal(h.calls.save[0].harvest_dial_proxy_id,3);
 assert.equal(h.calls.save[0].harvest_dial_proxy_url,'');
 assert.equal(h.calls.save[0].accounts[0].models[0],'gpt-unsaved');
 h.setStatus({host_ready:true,resources_ready:false,account_ids:[7]});await h.runtime.refreshStatus();
 assert.equal(h.get('managed-proxy-option').disabled,true);
 assert.equal(h.get('harvest-dial-proxy-id').value,'3');
 h.get('harvest-dial-proxy-mode').value='direct';await h.get('save-config').click();
 assert.equal(h.calls.save[1].harvest_dial_proxy_id,0);
 assert.equal(h.calls.save[1].harvest_dial_proxy_url,'');
 h.runtime.stop();
});

test('HTML extraction and preview have restrictive policy', () => {
 assert.equal(ui.extractHTML('```html\n<html>hello</html>\n```').trim(),'<html>hello</html>');
 assert.equal(ui.extractHTML('plain response'),'');
 const doc=ui.previewDocument('<script>window.demo=1</script>');
 assert.match(doc,/connect-src 'none'/);assert.match(doc,/form-action 'none'/);
});
test('single-account switch saves only that switch and preserves global drafts', async () => {
 const h=uiHarness();await settle();h.get('dynamic-proxy-url').value='http://unsaved.example:8080';
 const row=h.get('accounts-body').children[0];const checkbox=row.children[1].children[0];checkbox.checked=true;await checkbox.fire('change');
 assert.equal(h.calls.save.length,1);assert.equal(h.calls.save[0].accounts[0].enabled,true);assert.equal(h.calls.save[0].dynamic_proxy_url,'');
 assert.equal(h.get('dynamic-proxy-url').value,'http://unsaved.example:8080');h.runtime.stop();
});
test('manual result is text-only until preview clicked; status never runs tests',async()=>{
 const h=uiHarness();await settle();
 assert.equal(h.get('manual-account').value,'7');
 h.setStatus({host_ready:true,actions_ready:true,account_ids:[7],manual_test:{id:'one',kind:'test',account_id:7,model:'gpt-test',actual_model:'gpt-other',running:false,complete:true,matches:false,text:'<html><script>bad()</script></html>',route:'business'}});
 await h.runtime.refreshStatus();assert.match(h.get('manual-result-title').textContent,/模型不匹配/);
 assert.equal(h.get('manual-output').children.length,0);assert.match(h.get('manual-output').textContent,/<script>/);assert.equal(h.get('html-preview').hidden,true);
 await h.get('preview-html').click();assert.equal(h.get('html-preview').hidden,false);assert.match(h.get('html-preview').srcdoc,/Content-Security-Policy/);
 assert.equal(h.get('manual-output').hidden,true);await h.get('preview-html').click();assert.equal(h.get('html-preview').hidden,true);assert.equal(h.get('manual-output').hidden,false);
 assert.equal(h.calls.test,0);h.runtime.stop();
});

test('model verification exposes request and actual model cards with explicit mismatch status',async()=>{
 const h=uiHarness();await settle();
 h.setStatus({host_ready:true,actions_ready:true,account_ids:[7],manual_test:{id:'model-mismatch',kind:'test',account_id:7,model:'gpt-6-astra',actual_model:'gpt-5.2-luna',running:false,complete:true,matches:false,text:'OK'}});
 await h.runtime.refreshStatus();
 assert.equal(h.get('manual-model-comparison').hidden,false);
 assert.equal(h.get('manual-request-model').textContent,'gpt-6-astra');
 assert.equal(h.get('manual-actual-model').textContent,'gpt-5.2-luna');
 assert.equal(h.get('manual-model-match').className,'model-match mismatch');
 assert.match(h.get('manual-model-match').textContent,/模型名称不一致/);
 h.runtime.stop();
});

test('model cards show pending or absent values, hide for IP tests, and clear without a result',async()=>{
 const h=uiHarness();await settle();
 h.setStatus({host_ready:true,actions_ready:true,account_ids:[7],manual_test:{id:'model-pending',kind:'test',account_id:7,running:true}});
 await h.runtime.refreshStatus();
 assert.equal(h.get('manual-model-comparison').hidden,false);
 assert.equal(h.get('manual-request-model').textContent,'未提供');
 assert.equal(h.get('manual-actual-model').textContent,'等待返回');
 assert.equal(h.get('manual-model-match').className,'model-match pending');
 h.setStatus({host_ready:true,actions_ready:true,account_ids:[7],manual_test:{id:'model-absent',kind:'test',account_id:7,running:false,complete:true}});
 await h.runtime.refreshStatus();
 assert.equal(h.get('manual-actual-model').textContent,'未提供');
 assert.equal(h.get('manual-model-match').className,'model-match warning');
 h.setStatus({host_ready:true,actions_ready:true,account_ids:[7],manual_test:{id:'ip-only',kind:'ip',account_id:7,running:false,complete:true,exit_ip:'203.0.113.8'}});
 await h.runtime.refreshStatus();
 assert.equal(h.get('manual-model-comparison').hidden,true);
 h.setStatus({host_ready:true,actions_ready:true,account_ids:[7],manual_test:null});
 await h.runtime.refreshStatus();
 assert.equal(h.get('manual-model-comparison').hidden,true);
 h.runtime.stop();
});

test('proxy connectivity sends only current draft proxy fields without saving or model prompt',async()=>{
 const h=uiHarness();await settle();h.setStatus({host_ready:true,actions_ready:true,account_ids:[]});await h.runtime.refreshStatus();
 h.get('dynamic-proxy-url').value='socks5h://draft:secret@proxy.test:1080';h.get('harvest-dial-proxy-mode').value='direct';
 await h.get('proxy-test').click();await settle();
 assert.equal(h.calls.save.length,0);assert.equal(h.calls.actions.length,1);
 assert.deepEqual(h.calls.actions[0],{kind:'proxy_test',proxy:{dynamic_proxy_url:'socks5h://draft:secret@proxy.test:1080',dynamic_proxy_mode:'auto',dynamic_proxy_entries:[],dynamic_proxy_selected_id:'',harvest_dial_proxy_mode:'direct',harvest_dial_proxy_url:'',harvest_dial_proxy_id:0}});
 h.runtime.stop();
});
test('account progress is inline, preserves form edits and disables duplicate harvest',async()=>{
 const h=uiHarness();await settle();h.setStatus({host_ready:true,actions_ready:true,account_ids:[7],tickets:[{account_id:7,model:'gpt-test',state:'harvesting',attempts:2}]});await h.runtime.refreshStatus();
 const row=h.get('accounts-body').children[0];function text(n){return String(n.textContent)+n.children.map(text).join('');}
 assert.match(text(row.children[2]),/正在获取/);assert.match(text(row.children[2]),/第 2 次/);
 assert.equal(row.children[3].children[0].disabled,true);assert.equal(row.children[3].children[0].textContent,'正在查找…');
 h.runtime.stop();
});

test('proxy results are prominent and manual connectivity failures stay on the account',async()=>{
 const h=uiHarness();await settle();
 h.setStatus({host_ready:true,actions_ready:true,account_ids:[7],tickets:[{account_id:7,state:'checking_proxy',last_error:'checking_business_proxy'}],manual_test:{id:'net',kind:'proxy_test',running:true}});await h.runtime.refreshStatus();
 assert.equal(h.get('proxy-test-status').className,'proxy-result pending');
 const row=h.get('accounts-body').children[0];assert.equal(row.children[3].children[0].disabled,true);
 h.setStatus({host_ready:true,actions_ready:true,account_ids:[7],tickets:[{account_id:7,state:'cooldown',last_error:'business_connectivity_failed'}],manual_test:{id:'net',kind:'proxy_test',running:false,complete:false,error:'出口 IP 检测失败'}});await h.runtime.refreshStatus();
 assert.equal(h.get('proxy-test-status').className,'proxy-result error');assert.match(h.get('proxy-test-status').textContent,/测试失败/);
 function text(n){return String(n.textContent)+n.children.map(text).join('');}assert.match(text(row.children[2]),/本次查找已停止/);
 h.setStatus({host_ready:true,actions_ready:true,account_ids:[7],manual_test:{id:'net2',kind:'proxy_test',running:false,complete:true,exit_ip:'203.0.113.8',duration_ms:500}});await h.runtime.refreshStatus();
 assert.equal(h.get('proxy-test-status').className,'proxy-result success');h.runtime.stop();
});

test('single row and bulk buttons send different explicitly scoped actions',async()=>{
 const h=uiHarness();await settle();h.setStatus({host_ready:true,actions_ready:true,account_ids:[7,12],tickets:[{account_id:7,state:'cooldown'}]});await h.runtime.refreshStatus();
 await h.get('accounts-body').children[0].children[3].children[0].click();await settle();
 assert.deepEqual(h.calls.actions,[{kind:'refresh',account_id:7}]);
 await h.get('refresh-all').click();await settle();
 assert.deepEqual(h.calls.actions[1],{kind:'refresh_all'});assert.equal(h.calls.save.length,0);
 h.runtime.stop();
});
test('countries and action origin are shown for the observed IP in status and logs',async()=>{
 const h=uiHarness();await settle();h.setStatus({host_ready:true,actions_ready:true,account_ids:[7],tickets:[{account_id:7,state:'harvesting',trigger:'manual',exit_ip:'203.0.113.8',country_code:'JP'}],events:[{account_id:7,phase:'harvest',trigger:'manual_all',result:'model_matched',exit_ip:'203.0.113.9',country_code:'DE',attempt:2}],manual_test:{id:'country',kind:'proxy_test',complete:true,exit_ip:'203.0.113.10',country_code:'US',duration_ms:800}});
 await h.runtime.refreshStatus();function text(n){return String(n.textContent)+n.children.map(text).join('');}
 assert.match(text(h.get('accounts-body')),/单账号手动/);assert.match(text(h.get('accounts-body')),/日本/);
 assert.match(text(h.get('activity-body')),/全部手动/);assert.match(text(h.get('activity-body')),/德国/);assert.match(h.get('proxy-test-status').textContent,/美国/);
 assert.equal(ui.countryLabel('<script>'),'国家未知');assert.equal(ui.countryLabel(''),'国家未知');h.runtime.stop();
});

async function startProxyAutosave(h) {
 h.setStatus({host_ready:true,actions_ready:true,account_ids:[7]});await h.runtime.refreshStatus();
 h.get('dynamic-proxy-url').value='socks5h://draft:secret@proxy.test:1080';h.get('harvest-dial-proxy-mode').value='managed';h.get('harvest-dial-proxy-id').value='3';
 await h.get('proxy-test').click();
}
test('successful proxy test auto-saves only tested proxy fields against latest persisted config once',async()=>{
 const h=uiHarness();await settle();
 h.get('ttl-minutes').value='30';
 const draftModel=h.get('accounts-body').children[0].children[0].children[1].children[2];draftModel.value='gpt-draft';await draftModel.fire('input');
 await startProxyAutosave(h);assert.equal(h.calls.save.length,0);assert.equal(h.get('config-fields').disabled,true);
 const latest=configured({auto_harvest:false,cooldown_seconds:600});latest.accounts[0].plan='team';h.setConfig(latest);
 h.setStatus({host_ready:true,actions_ready:true,account_ids:[7],manual_test:{id:'proxy-action-1',kind:'proxy_test',complete:true,running:false,exit_ip:'203.0.113.8',country_code:'JP'}});
 await h.runtime.refreshStatus();await h.runtime.refreshStatus();
 assert.equal(h.calls.save.length,1);const saved=h.calls.save[0];
 assert.equal(saved.dynamic_proxy_url,'socks5h://draft:secret@proxy.test:1080');assert.equal(saved.harvest_dial_proxy_id,3);
 assert.equal(saved.accounts[0].enabled,false);assert.equal(saved.accounts[0].plan,'team');assert.equal(saved.auto_harvest,false);assert.equal(saved.cooldown_seconds,600);assert.equal(saved.ttl_minutes,60);
 assert.equal(h.get('ttl-minutes').value,'30');assert.equal(draftModel.value,'gpt-draft');assert.equal(h.get('config-fields').disabled,false);
 assert.match(h.get('proxy-test-status').textContent,/已自动保存并生效/);h.runtime.stop();
});
test('failed or unrelated proxy results never auto-save configuration',async()=>{
 const h=uiHarness();await settle();await startProxyAutosave(h);
 h.setStatus({host_ready:true,actions_ready:true,account_ids:[7],manual_test:{id:'unrelated',kind:'proxy_test',complete:true,exit_ip:'203.0.113.8'}});await h.runtime.refreshStatus();assert.equal(h.calls.save.length,0);
 h.setStatus({host_ready:true,actions_ready:true,account_ids:[7],manual_test:{id:'proxy-action-1',kind:'proxy_test',complete:false,error:'失败'}});await h.runtime.refreshStatus();
 assert.equal(h.calls.save.length,0);assert.equal(h.get('config-fields').disabled,false);assert.match(h.get('proxy-test-status').textContent,/保留原配置/);h.runtime.stop();
});

test('proxy success distinguishes retained, expired and legacy sessions from account authorization',async()=>{
 const h=uiHarness();await settle();await startProxyAutosave(h);
 const status={host_ready:true,actions_ready:true,account_ids:[7],manual_test:{id:'proxy-action-1',kind:'proxy_test',complete:true,running:false,exit_ip:'203.0.113.8',proxy_session_expires_at:new Date(Date.now()+30000).toISOString()}};
 h.setStatus(status);await h.runtime.refreshStatus();
 assert.match(h.get('proxy-test-status').textContent,/首次手动查找优先沿用/);
 assert.match(h.get('proxy-test-status').textContent,/账号授权和上游可用性需另行验证/);
 status.manual_test.proxy_session_expires_at=new Date(Date.now()-1000).toISOString();h.setStatus(status);await h.runtime.refreshStatus();
 assert.match(h.get('proxy-test-status').textContent,/已过期/);
 assert.doesNotMatch(h.get('proxy-test-status').textContent,/优先沿用/);
 delete status.manual_test.proxy_session_expires_at;h.setStatus(status);await h.runtime.refreshStatus();
 assert.match(h.get('proxy-test-status').textContent,/仅本次出口检测通过/);
 assert.equal(h.calls.save.length,1);h.runtime.stop();
});

test('attempt log preserves sampled session source and separates 401 from exit failure',async()=>{
 const h=uiHarness();await settle();
 h.setStatus({host_ready:true,account_ids:[7],tickets:[{account_id:7,state:'cooldown',last_error:'upstream_unauthorized'}],events:[
 {round_id:'r',account_id:7,attempt:1,phase:'harvest',result:'started',reused_proxy_session:true},
 {round_id:'r',account_id:7,attempt:1,phase:'connectivity',route:'dynamic',result:'connectivity_ok',exit_ip:'203.0.113.8'},
 {round_id:'r',account_id:7,attempt:1,phase:'harvest',result:'upstream_rejected',http_status:401}
 ]});await h.runtime.refreshStatus();
 function text(n){return String(n.textContent)+n.children.map(text).join('');}
 assert.match(text(h.get('activity-body')),/沿用上方测通的会话/);
 assert.match(text(h.get('activity-body')),/账号授权被拒绝/);
 assert.match(text(h.get('accounts-body')),/重新授权此账号/);
 assert.doesNotMatch(ui.errorLabel('dynamic_connectivity_failed'),/请先在上方测试/);
 assert.match(ui.errorLabel('dynamic_connectivity_failed'),/自动换出口/);
 h.setStatus({host_ready:true,account_ids:[7],tickets:[{account_id:7,state:'cooldown',last_error:'model_mismatch'}]});await h.runtime.refreshStatus();
 assert.match(text(h.get('accounts-body')),/模型仍被路由/);assert.doesNotMatch(text(h.get('accounts-body')),/正在重新获取票据/);
 h.runtime.stop();
});
test('proxy save failure is visible and does not claim the tested proxy is active',async()=>{
 const h=uiHarness();await settle();await startProxyAutosave(h);h.bridge.save=async()=>{throw Error('save failed');};
 h.setStatus({host_ready:true,actions_ready:true,account_ids:[7],manual_test:{id:'proxy-action-1',kind:'proxy_test',complete:true,exit_ip:'203.0.113.8'}});await h.runtime.refreshStatus();
 assert.equal(h.get('proxy-test-status').className,'proxy-result error');assert.match(h.get('proxy-test-status').textContent,/未能确认保存成功/);assert.equal(h.get('config-fields').disabled,false);h.runtime.stop();
});
test('per-attempt rows keep IP and country on final failure and separate rounds',()=>{
 const events=[{round_id:'a',account_id:7,model:'gpt-test',attempt:1,phase:'harvest',result:'started'},
 {round_id:'a',account_id:7,model:'gpt-test',attempt:1,phase:'harvest',result:'ip_observed',exit_ip:'203.0.113.8',country_code:'JP'},
 {round_id:'a',account_id:7,model:'gpt-test',attempt:1,phase:'harvest',result:'model_mismatch',actual_model:'gpt-other'},
 {round_id:'b',account_id:7,model:'gpt-test',attempt:1,phase:'harvest',result:'ip_observed',exit_ip:'203.0.113.9',country_code:'DE'}];
 const rows=ui.attemptRows(events);assert.equal(rows.length,2);assert.equal(rows[0].result,'model_mismatch');assert.equal(rows[0].exit_ip,'203.0.113.8');assert.equal(rows[0].country_code,'JP');assert.equal(rows[1].country_code,'DE');
});

test('business front option defaults off and saves explicitly without changing proxy draft autosave',async()=>{
 const h=uiHarness();await settle();assert.equal(h.get('business-use-front').checked,false);
 h.get('business-use-front').checked=true;await h.get('save-config').click();
 assert.equal(h.calls.save.at(-1).business_use_front,true);
 assert.throws(()=>ui.validateConfig(configured({business_use_front:'true'})),/业务前置代理/);
});

test('failed instant account save restores switch and shows error on its row',async()=>{
 const h=uiHarness();await settle();h.bridge.save=async()=>{throw Error('服务暂不可用');};
 const row=h.get('accounts-body').children[0],check=row.children[1].children[0];check.checked=true;await check.fire('change');
 assert.equal(check.checked,false);assert.equal(h.get('config-fields').disabled,false);
 function text(n){return String(n.textContent)+n.children.map(text).join('');}assert.match(text(row.children[2]),/服务暂不可用/);h.runtime.stop();
});
test('manual submission locks inputs while status is stale, shows inline rejection and prevents duplicate clicks',async()=>{
 const h=uiHarness();await settle();h.setStatus({host_ready:true,actions_ready:true,account_ids:[7]});await h.runtime.refreshStatus();
 h.get('manual-model').value='gpt-test';h.get('manual-prompt').value='OK';
 await h.get('manual-test').click();assert.equal(h.calls.actions.length,1);assert.equal(h.get('manual-test').disabled,true);assert.equal(h.get('manual-account').disabled,true);assert.match(h.get('manual-result-title').textContent,/提交/);
 await h.get('manual-test').click();assert.equal(h.calls.actions.length,1);
 h.setStatus({host_ready:true,actions_ready:true,account_ids:[7],manual_test:{id:'proxy-action-1',kind:'test',account_id:7,running:true}});await h.runtime.refreshStatus();
 assert.equal(h.get('manual-cancel').hidden,false);assert.equal(h.get('manual-cancel').disabled,false);
 h.setStatus({host_ready:true,actions_ready:true,account_ids:[7],manual_test:{id:'proxy-action-1',kind:'test',account_id:7,running:false,error:'测试已取消'}});await h.runtime.refreshStatus();
 assert.equal(h.get('manual-cancel').hidden,true);assert.equal(h.get('manual-account').disabled,false);assert.equal(h.get('manual-result-title').textContent,'测试已停止');
 h.bridge.action=async()=>({result:{accepted:false,message:'账号不可用'}});await h.get('manual-test').click();
 assert.equal(h.get('manual-result-title').textContent,'未能开始测试');assert.match(h.get('manual-status').textContent,/账号不可用/);assert.equal(h.get('manual-test').disabled,false);await h.runtime.refreshStatus();assert.equal(h.get('manual-result-title').textContent,'未能开始测试');h.runtime.stop();
});
test('test result follows selected account and only HTML responses expose preview',async()=>{
 const h=uiHarness();await settle();h.setStatus({host_ready:true,actions_ready:true,account_ids:[7,12],manual_test:{id:'result',kind:'test',account_id:7,complete:true,matches:true,text:'OK'}});await h.runtime.refreshStatus();
 assert.equal(h.get('manual-response').hidden,false);assert.equal(h.get('preview-html').hidden,true);
 h.get('manual-account').value='12';await h.get('manual-account').fire('change');await h.runtime.refreshStatus();
 assert.equal(h.get('manual-response').hidden,true);assert.match(h.get('manual-status').textContent,/ID 12/);assert.equal(h.calls.actions.length,0);
 h.get('manual-prompt').value='custom';await h.get('quick-prompt').click();assert.equal(h.get('manual-prompt').value,'只回复 OK');h.runtime.stop();
});
test('proxy status failures eventually unlock form without saving unconfirmed config',async()=>{
 const h=uiHarness();await settle();await startProxyAutosave(h);assert.equal(h.get('config-fields').disabled,true);
 const now=Date.now;Date.now=()=>now()+60000;h.bridge.status=async()=>{throw Error('disconnected');};
 try{await h.runtime.refreshStatus();assert.equal(h.get('config-fields').disabled,false);assert.equal(h.calls.save.length,0);assert.match(h.get('proxy-test-status').textContent,/未自动保存/);}finally{Date.now=now;h.runtime.stop();}
});
test('log filter shows only selected account and changing it never starts work',async()=>{
 const h=uiHarness();await settle();h.setStatus({host_ready:true,actions_ready:true,account_ids:[7,12],events:[{account_id:7,phase:'harvest',attempt:1,result:'model_mismatch'},{account_id:12,phase:'harvest',attempt:1,result:'model_matched'}]});await h.runtime.refreshStatus();
 assert.equal(h.get('activity-body').children.length,2);h.get('activity-account').value='12';await h.get('activity-account').fire('change');assert.equal(h.get('activity-body').children.length,1);assert.equal(h.calls.actions.length,0);h.runtime.stop();
});
