import './order-issues.css';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const stateLabel = {waiting_follower:'待跟单回复',waiting_business:'待业务员确认',closed:'已结束'};
const date = value => new Date(value).toLocaleString('zh-CN');
let context = null, identity = '', summary = null, request = null, generation = 0, summaryDialog = null, activeOrder = null;

function rpc(action, values = {}) {
  return context.api('/rest/v1/rpc/order_issues', {method:'POST',body:JSON.stringify({action,...values})});
}

function dialog(title, body) {
  const node = document.createElement('dialog');
  node.className = 'q-dialog';
  node.innerHTML = `<div class="q-modal"><button type="button" class="q-close" aria-label="关闭">×</button><h2>${escape(title)}</h2>${body}</div>`;
  document.body.append(node);
  node.querySelector('.q-close').onclick = () => node.close();
  node.addEventListener('close', () => node.remove(), {once:true});
  node.showModal();
  return node;
}

function paintHome() {
  const stats = document.querySelector('.stats');
  if (!stats || !identity) return;
  stats.classList.add('q-stats');
  let card = stats.querySelector('.q-summary');
  if (!card) {
    card = document.createElement('article');
    card.className = 'q-summary';
    card.tabIndex = 0; card.setAttribute('role','button');
    card.onclick = () => showSummary();
    card.onkeydown = event => {if (event.key === 'Enter' || event.key === ' ') {event.preventDefault();showSummary();}};
    stats.append(card);
  }
  card.innerHTML = `<small>未结束的问题</small><b>${summary ? summary.total : '…'}</b><span>${summary ? '查看问题订单与回复' : '正在加载问题'}</span>`;
  const unreadOrders = new Set((summary?.issues || []).filter(issue => issue.unread).map(issue => issue.order_id));
  document.querySelectorAll('.order-card[data-order]').forEach(order => {
    order.querySelector('.q-unread-dot')?.remove();
    if (unreadOrders.has(order.dataset.order)) {
      const dot = document.createElement('span'); dot.className='q-unread-dot';dot.textContent='新消息';dot.setAttribute('aria-label','问题有未读消息');dot.title='问题有未读消息，打开订单查看';(order.querySelector('.card-top')||order).append(dot);
    }
  });
  if (activeOrder?.panel.isConnected && summary) {
    const changed = summary.issues.some(issue => issue.order_id === activeOrder.id && issue.sequence > (activeOrder.sequences.get(issue.id) || 0));
    activeOrder.panel.querySelector('.q-refresh').hidden = !changed;
  }
}

async function sync(force = false) {
  if (!identity || document.hidden && !force) return;
  if (request) {
    if (!force) return request;
    await request.catch(()=>{});
    if (!identity) return;
  }
  const revision = generation;
  const pending = rpc('summary').then(data => {
    if (revision !== generation) return;
    summary = data; paintHome();
    if (summaryDialog?.isConnected) paintSummary();
  }).catch(error => {
    if (revision !== generation) return;
    const hint = document.querySelector('.q-summary span');
    if (hint) hint.textContent = '加载失败，点击重试';
    throw error;
  }).finally(() => {if (request === pending) request=null;});
  request = pending; return pending;
}

export function mountIssueHome(options) {
  context = options;
  const next = options.userId && options.backend === 'tencent-v1' ? options.userId : '';
  if (next !== identity) {identity=next;generation++;summary=null;request=null;activeOrder=null;summaryDialog?.close();document.querySelectorAll('.q-dialog').forEach(node=>node.close());}
  if (!identity) return;
  paintHome();
  if (!summary && !request) void sync(true).catch(()=>{});
}

setInterval(() => {if(identity)void sync().catch(()=>{});}, 15000);
document.addEventListener('visibilitychange', () => {if(!document.hidden&&identity)void sync(true).catch(()=>{});});
window.addEventListener('focus', () => {if(identity)void sync(true).catch(()=>{});});

function paintSummary() {
  if (!summaryDialog?.isConnected) return;
  const filter = summaryDialog.querySelector('select').value;
  const issues = (summary?.issues || []).filter(issue => issue.status !== 'closed' && (filter === 'all' || issue.status === filter));
  summaryDialog.querySelector('.q-total').textContent = `未结束的问题共 ${summary?.total ?? '…'} 个`;
  const list = summaryDialog.querySelector('.q-list');
  list.innerHTML = summary ? issues.map(issue => `<button type="button" class="q-list-item" data-issue-order="${escape(issue.order_id)}" data-issue-id="${escape(issue.id)}"><span><strong>${escape(issue.order_no)}</strong>${issue.unread?'<i class="q-inline-dot" aria-label="未读"></i>':''}<small>${escape(stateLabel[issue.status])} · ${escape(issue.creator_email)}</small></span><p>${escape(issue.subject)}</p><small>最新：${escape(issue.preview)} · ${escape(date(issue.updated_at))}</small></button>`).join('') || '<p class="q-empty">暂无未结束的问题</p>' : '<p>正在加载…</p>';
  list.querySelectorAll('[data-issue-order]').forEach(button => button.onclick = () => {summaryDialog.close();const issue=issues.find(row=>row.order_id===button.dataset.issueOrder&&row.id===button.dataset.issueId);context.openOrder(button.dataset.issueOrder,issue?.id);});
}

async function showSummary() {
  if (!summaryDialog?.isConnected) {
    summaryDialog = dialog('订单问题汇总','<p class="q-total"></p><label>查看范围<select><option value="all">全部未结束</option><option value="waiting_follower">待跟单回复</option><option value="waiting_business">待业务员确认</option></select></label><p class="q-error" role="alert"></p><div class="q-list"></div>');
    summaryDialog.querySelector('select').onchange=paintSummary;
  }
  paintSummary();
  try {await sync(true);}catch(error){if(summaryDialog?.isConnected)summaryDialog.querySelector('.q-error').textContent=error.message;}
}

function compose(title, onSubmit) {
  const node=dialog(title,'<form><label>内容<textarea name="body" maxlength="5000" rows="5" required placeholder="请填写具体问题或处理要求"></textarea></label><p class="q-error" role="alert"></p><button class="q-submit" type="submit">提交</button></form>');
  const form=node.querySelector('form');
  form.onsubmit=async event=>{
    event.preventDefault();const body=form.elements.body.value.trim();if(!body){form.elements.body.focus();return;}
    const button=form.querySelector('[type="submit"]');button.disabled=true;node.querySelector('.q-close').disabled=true;
    try{await onSubmit(body);node.close();}catch(error){form.querySelector('.q-error').textContent=error.message;}finally{button.disabled=false;node.querySelector('.q-close').disabled=false;}
  };
  form.elements.body.focus();
}

export async function mountIssueOrder(order, detail) {
  if (!identity || order.deleted_at) return;
  const revision = generation, userId=identity;
  let panel=detail.querySelector('.q-order');
  if(!panel){panel=document.createElement('section');panel.className='q-order';panel.innerHTML='<h3>订单问题</h3><p>正在加载问题…</p>';detail.querySelector('.detail').append(panel);}
  const loadToken=Symbol();panel.issueLoadToken=loadToken;
  const valid=()=>revision===generation&&identity===userId&&panel.issueLoadToken===loadToken&&panel.isConnected&&detail.open;
  try {
    const data=await rpc('order',{order_id:order.id});
    if(!valid())return;
    activeOrder={id:order.id,panel,sequences:new Map(data.issues.map(issue=>[issue.id,issue.sequence]))};
    panel.innerHTML=`<div class="q-order-head"><h3>订单问题</h3><button type="button" class="q-refresh" hidden>有新消息，点击刷新</button></div><p class="q-error" role="alert"></p><div class="q-threads">${data.issues.map(issue=>`<article class="q-thread ${issue.status==='closed'?'q-closed':''}" data-issue="${escape(issue.id)}"><div class="q-thread-head"><strong>${escape(stateLabel[issue.status])}</strong><small>${escape(date(issue.created_at))}</small></div><div class="q-messages">${issue.messages.map(message=>`<div class="q-message ${message.author_id===userId?'q-mine':''} ${message.kind!=='message'?'q-system':''}"><small>${escape(message.author_role==='follower'?'跟单':'业务员')} · ${escape(message.author_email)} · ${escape(date(message.created_at))}</small><p>${escape(message.body)}</p></div>`).join('')}</div><div class="q-thread-actions">${issue.can_reply?'<button type="button" data-reply>回复</button>':''}${issue.can_close?'<button type="button" class="q-end" data-close>结束问题</button>':''}${issue.can_remind?'<button type="button" data-remind>提醒业务员结束问题</button>':''}</div></article>`).join('')||'<p class="q-empty">暂无问题</p>'}</div>${data.can_create?'<button type="button" class="q-create">提交问题</button>':''}`;
    panel.querySelector('.q-refresh').onclick=()=>mountIssueOrder(order,detail);
    const reload=async()=>{await mountIssueOrder(order,detail);await sync(true);};
    panel.querySelector('.q-create')?.addEventListener('click',()=>{const requestId=crypto.randomUUID();compose('提交问题',async body=>{await rpc('create',{order_id:order.id,body,request_id:requestId});await reload();});});
    for(const issue of data.issues){
      const row=[...panel.querySelectorAll('[data-issue]')].find(node=>node.dataset.issue===issue.id);
      row.querySelector('[data-reply]')?.addEventListener('click',()=>compose('回复问题',async body=>{await rpc('reply',{issue_id:issue.id,body});await reload();}));
      for(const [selector,action] of [['[data-close]','close'],['[data-remind]','remind']])row.querySelector(selector)?.addEventListener('click',async event=>{
        const button=event.currentTarget;button.disabled=true;
        try{await rpc(action,{issue_id:issue.id});await reload();}catch(error){if(valid())panel.querySelector('.q-error').textContent=error.message;}finally{button.disabled=false;}
      });
    }
    const focusId=detail.dataset.issueFocus;
    if(focusId){const row=[...panel.querySelectorAll('[data-issue]')].find(node=>node.dataset.issue===focusId);row?.scrollIntoView({block:'center'});delete detail.dataset.issueFocus;}
    // Acknowledge only the messages actually displayed, never later arrivals.
    await Promise.all(data.issues.filter(issue=>issue.unread).map(issue=>rpc('read',{issue_id:issue.id,sequence:issue.sequence})));
    if(valid())await sync(true);
  } catch(error) {
    if(!valid())return;
    const hint=panel.querySelector('.q-error')||panel.querySelector('p');hint.textContent='问题加载失败：'+error.message;
    const retry=document.createElement('button');retry.type='button';retry.textContent='重试';retry.onclick=()=>mountIssueOrder(order,detail);panel.append(retry);
  }
}
