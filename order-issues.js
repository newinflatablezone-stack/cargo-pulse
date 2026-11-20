import './order-issues.css';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const stateLabel = {waiting_follower:'待跟单回复',waiting_business:'待业务员确认',closed:'已结束'};
const date = value => new Date(value).toLocaleString('zh-CN');
function createIssueView(afterSales) {
  const topic = afterSales ? '售后' : '问题';
  const orderTitle = afterSales ? '订单售后' : '订单问题';
  const closeLabel = afterSales ? '确认解决' : '结束问题';
  const panelClass = afterSales ? 'q-after-sales' : 'q-order-issue';
  let context = null, identity = '', summary = null, request = null, generation = 0, summaryDialog = null, activeOrder = null;

  function rpc(action, values = {}) {
    return context.api('/rest/v1/rpc/order_issues', {method:'POST',body:JSON.stringify({action,...(afterSales ? {category:'after_sales'} : {}),...values})});
  }

  function dialog(title, body) {
    const node = document.createElement('dialog');
    node.className = 'q-dialog';
    node.dataset.issueView = panelClass;
    node.innerHTML = `<div class="q-modal"><button type="button" class="q-close" aria-label="关闭">×</button><h2>${escape(title)}</h2>${body}</div>`;
    document.body.append(node);
    node.querySelector('.q-close').onclick = () => node.close();
    node.addEventListener('close', () => node.remove(), {once:true});
    node.showModal();
    return node;
  }

  function paintHome() {
    const stats = document.querySelector('.stats');
    if (!identity) return;
    if (afterSales) {
      const anchor = document.querySelector('#imageResource');
      if (anchor) {
        let entry = document.querySelector('#afterSalesSummary');
        if (!entry) {
          entry = document.createElement('button');
          entry.type = 'button'; entry.id = 'afterSalesSummary';
          entry.onclick = () => {
            history.pushState({},'',location.pathname+'?after-sales=1');
            void showSummary();
          };
          anchor.after(entry);
        }
        const unread = summary?.issues.filter(issue => issue.unread).length || 0;
        entry.textContent = summary?.total ? `售后（${summary.total}）` : '售后';
        if (unread) entry.textContent += ' · 未读 '+unread;
      }
    } else if (stats) {
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
    card.innerHTML = `<small>未结束的问题</small><b>${summary ? summary.total : '…'}</b><span>${summary ? '查看问题、售后与回复' : '正在加载问题'}</span>`;
    }
    const unreadOrders = new Set((summary?.issues || []).filter(issue => issue.unread && (afterSales || issue.category !== 'after_sales')).map(issue => issue.order_id));
    document.querySelectorAll('.order-card[data-order]').forEach(order => {
      order.querySelector('.q-unread-dot.'+panelClass)?.remove();
      if (unreadOrders.has(order.dataset.order)) {
        const dot = document.createElement('span'); dot.className='q-unread-dot '+panelClass;dot.textContent=afterSales?'售后新消息':'新消息';dot.setAttribute('aria-label','问题有未读消息');dot.title='问题有未读消息，打开订单查看';(order.querySelector('.card-top')||order).append(dot);
      }
    });
    if (activeOrder?.panel.isConnected && summary) {
      const changed = summary.issues.some(issue => (afterSales || issue.category !== 'after_sales') && issue.order_id === activeOrder.id && issue.sequence > (activeOrder.sequences.get(issue.id) || 0));
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
    const pending = rpc('summary',afterSales?{}:{include_after_sales:true}).then(data => {
      if (revision !== generation) return;
      summary = data; paintHome();
      if (summaryDialog?.isConnected) paintSummary();
    }).catch(error => {
      if (revision !== generation) return;
      const hint = afterSales ? null : document.querySelector('.q-summary span');
      if (hint) hint.textContent = '加载失败，点击重试';
      throw error;
    }).finally(() => {if (request === pending) request=null;});
    request = pending; return pending;
  }

  function mountHome(options) {
    context = options;
    const next = options.userId && options.backend === 'tencent-v1' ? options.userId : '';
    if (next !== identity) {identity=next;generation++;summary=null;request=null;activeOrder=null;if(summaryDialog?.isConnected){if(afterSales)summaryDialog.remove();else summaryDialog.close();}document.querySelectorAll(`.q-dialog[data-issue-view="${panelClass}"]`).forEach(node=>node.close());if(afterSales)document.querySelector('#afterSalesSummary')?.remove();}
    if (!identity) return;
    paintHome();
    if (afterSales && new URLSearchParams(location.search).get('after-sales')==='1' && !summaryDialog?.isConnected) {
      void showSummary();
    } else if (!summary && !request) void sync(true).catch(()=>{});
  }

  setInterval(() => {if(identity)void sync().catch(()=>{});}, 15000);
  document.addEventListener('visibilitychange', () => {if(!document.hidden&&identity)void sync(true).catch(()=>{});});
  window.addEventListener('focus', () => {if(identity)void sync(true).catch(()=>{});});

  function paintSummary() {
    if (!summaryDialog?.isConnected) return;
    const start = summaryDialog.querySelector('.q-start-after-sales');
    if (start) start.hidden = !summary?.can_create;
    const filter = summaryDialog.querySelector('select').value;
    const records = summary?.issues || [];
    const factorySelect = summaryDialog.querySelector('[name="factory_filter"]');
    const factory = factorySelect?.value || '';
    if (factorySelect) {
      const names = [...new Set(records.map(issue => issue.factory).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'zh-CN'));
      factorySelect.replaceChildren(new Option('全部工厂',''));
      for (const name of names) factorySelect.add(new Option(name,name));
      if (names.includes(factory)) factorySelect.value = factory;
    }
    const issues = records.filter(issue =>
      (filter === 'history' || (filter === 'all' ? issue.status !== 'closed' : issue.status === filter)) &&
      (!factorySelect?.value || issue.factory === factorySelect.value)
    );
    summaryDialog.querySelector('.q-total').textContent = `未结束的${afterSales?topic:'问题和售后'}共 ${summary?.total ?? '…'} 个`;
    const list = summaryDialog.querySelector('.q-list');
    list.innerHTML = summary ? issues.map(issue => `<button type="button" class="q-list-item" data-issue-order="${escape(issue.order_id)}" data-issue-id="${escape(issue.id)}"><span><strong>${escape(issue.order_no)}</strong>${issue.unread?'<i class="q-inline-dot" aria-label="未读"></i>':''}<small>${escape(stateLabel[issue.status])}${issue.category==='after_sales'?' · 售后 · '+escape(issue.factory||'工厂未填写'):''} · ${escape(issue.creator_name || '业务员')}</small></span><p>${escape(issue.subject)}</p><small>最新：${escape(issue.preview)} · ${escape(date(issue.updated_at))}</small></button>`).join('') || `<p class="q-empty">暂无符合条件的${topic}</p>` : '<p>正在加载…</p>';
    list.querySelectorAll('[data-issue-order]').forEach(button => button.onclick = () => {
      if (!afterSales) {
        summaryDialog.close();
        context.openOrder(button.dataset.issueOrder,button.dataset.issueId);
        return;
      }
      const detail = summaryDialog.querySelector('.q-after-sales-detail');
      detail.hidden = false;
      detail.innerHTML = '<button type="button" class="q-detail-back">返回列表</button><div class="detail"></div>';
      detail.querySelector('.q-detail-back').onclick = () => { detail.hidden = true; detail.replaceChildren(); };
      const record = issues.find(issue=>issue.id===button.dataset.issueId);
      const heading = document.createElement('h2');
      heading.textContent = record.order_no;
      detail.querySelector('.detail').append(heading);
      void mountOrder({id:record.order_id},detail,record.id);
      detail.scrollIntoView({block:'start'});
    });
  }

  async function showSummary() {
    if (!summaryDialog?.isConnected) {
      const content = `<p class="q-total"></p>${afterSales ? '<button type="button" class="q-create q-start-after-sales" hidden>发起售后</button>' : ''}<label>查看范围<select><option value="all">全部未结束</option><option value="waiting_follower">待跟单回复</option><option value="waiting_business">待业务员确认</option>${afterSales ? '<option value="closed">已解决</option><option value="history">全部记录</option>' : ''}</select></label>${afterSales ? '<label>工厂<select name="factory_filter"><option value="">全部工厂</option></select></label>' : ''}<p class="q-error" role="alert"></p><div class="q-list"></div>`;
      if (afterSales) {
        const main = document.querySelector('#app main');
        if (!main) return;
        main.className = 'q-after-sales-page';
        main.innerHTML = `<section class="q-modal q-page-content"><div class="q-page-heading"><h1>售后</h1><button type="button" class="q-return">返回订单中心</button></div><section class="q-after-sales-form" hidden></section><section class="q-after-sales-detail" hidden></section>${content}</section>`;
        summaryDialog = main;
        main.querySelector('.q-return').onclick = () => {
          history.pushState({},'',location.pathname);
          context.renderHome();
        };
      } else summaryDialog = dialog('订单问题汇总',content);
      summaryDialog.querySelectorAll('select').forEach(select=>{select.onchange=paintSummary;});
      const start = summaryDialog.querySelector('.q-start-after-sales');
      if (start) start.onclick = startAfterSales;
    }
    paintSummary();
    try {await sync(true);}catch(error){if(summaryDialog?.isConnected)summaryDialog.querySelector('.q-error').textContent=error.message;}
  }

  async function startAfterSales() {
    const requestId = crypto.randomUUID(), revision = generation;
    const orderNumber = value => String(value ?? '').trim().replace(/^#\s*/, '').toLowerCase();
    let orders = [];
    const host = summaryDialog.querySelector('.q-after-sales-form');
    if (!host.hidden) return;
    const node = compose('发起售后', async (body, fields) => {
      const matches = orders.filter(order => orderNumber(order.order_no) === orderNumber(fields.order_no.value));
      if (matches.length !== 1) throw Error(matches.length ? '该单号匹配多笔订单，请联系主管核对' : '请输入有权限的完整订单号，或从推荐中选择');
      await rpc('create', {order_id:matches[0].id, factory:fields.factory.value, body, request_id:requestId});
      if (revision !== generation || !summaryDialog?.isConnected) return;
      summaryDialog.querySelector('select').value = 'all';
      void sync(true).catch(error => {
        const hint = summaryDialog?.querySelector('.q-error');
        if (hint) hint.textContent = '售后已提交，刷新汇总失败：' + error.message;
      });
    }, '<label>订单号<input name="order_no" list="after-sales-order-options" autocomplete="off" required disabled placeholder="正在加载订单…"></label><datalist id="after-sales-order-options"></datalist><label>工厂<input name="factory" list="after-sales-factory-options" autocomplete="off" maxlength="120" required placeholder="选择已有工厂或输入新名称"></label><datalist id="after-sales-factory-options"></datalist>',host);
    const input = node.querySelector('[name="order_no"]');
    const submit = node.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const result = await rpc('eligible_orders');
      if (!node.isConnected || node.hidden || revision !== generation) return;
      orders = result.orders.filter(order => orderNumber(order.order_no));
      const orderOptions = node.querySelector('#after-sales-order-options');
      for (const order of orders) orderOptions.append(new Option(order.product_name || order.order_no, order.order_no));
      const factoryOptions = node.querySelector('#after-sales-factory-options');
      for (const name of result.factories || []) factoryOptions.append(new Option(name, name));
      input.placeholder = orders.length ? '输入订单号搜索或选择' : '暂无可发起售后的订单';
      input.disabled = submit.disabled = !orders.length;
      if (orders.length) input.focus();
    } catch (error) {
      if (!node.isConnected || node.hidden || revision !== generation) return;
      node.querySelector('.q-error').textContent = '订单加载失败：' + error.message;
      input.placeholder = '订单加载失败';
    }
  }

  function compose(title, onSubmit, fields = '', host = null) {
    const content=`<form>${fields}<label>内容<textarea name="body" maxlength="5000" rows="5" required placeholder="请填写具体问题或处理要求"></textarea></label><p class="q-error" role="alert"></p><button class="q-submit" type="submit">提交</button></form>`;
    const node = host || dialog(title,content);
    const close = () => {
      if (!host) { node.close(); return; }
      host.hidden = true;
      host.replaceChildren();
    };
    if (host) {
      host.innerHTML = `<h2>${escape(title)}</h2><button type="button" class="q-close">取消</button>${content}`;
      host.hidden = false;
      host.querySelector('.q-close').onclick = close;
      host.scrollIntoView({block:'nearest'});
    }
    const form=node.querySelector('form'), cancel=node.querySelector('.q-close');
    form.onsubmit=async event=>{
      event.preventDefault();const body=form.elements.body.value.trim();if(!body){form.elements.body.focus();return;}
      const button=form.querySelector('[type="submit"]');button.disabled=true;cancel.disabled=true;
      try{await onSubmit(body,form.elements);close();}catch(error){form.querySelector('.q-error').textContent=error.message;}finally{button.disabled=false;cancel.disabled=false;}
    };
    if (!fields) form.elements.body.focus();
    return node;
  }

  async function mountOrder(order, detail, issueId = null) {
    if (!identity || order.deleted_at) return;
    const revision = generation, userId=identity;
    let panel=detail.querySelector('.'+panelClass);
    if(!panel){panel=document.createElement('section');panel.className='q-order '+panelClass;panel.innerHTML=`<h3>${orderTitle}</h3><p>正在加载…</p>`;detail.querySelector('.detail').append(panel);}
    const loadToken=Symbol();panel.issueLoadToken=loadToken;
    const valid=()=>revision===generation&&identity===userId&&panel.issueLoadToken===loadToken&&panel.isConnected&&(issueId ? !detail.hidden : detail.open);
    try {
      const data=await rpc('order',{order_id:order.id});
      if(!valid())return;
      activeOrder={id:order.id,panel,sequences:new Map(data.issues.map(issue=>[issue.id,issue.sequence]))};
      panel.innerHTML=`<div class="q-order-head"><h3>${orderTitle}</h3><button type="button" class="q-refresh" hidden>有新消息，点击刷新</button></div><p class="q-error" role="alert"></p><div class="q-threads">${data.issues.map(issue=>`<article class="q-thread ${issue.status==='closed'?'q-closed':''}" data-issue="${escape(issue.id)}"><div class="q-thread-head"><strong>${escape(stateLabel[issue.status])}${afterSales?' · '+escape(issue.factory||'工厂未填写'):''}</strong><small>${escape(date(issue.created_at))}</small></div><div class="q-messages">${issue.messages.map(message=>`<div class="q-message ${message.author_id===userId?'q-mine':''} ${message.kind!=='message'?'q-system':''}"><small>${escape(message.author_role==='follower'?'跟单':'业务员')} · ${escape(message.author_name || (message.author_role === 'follower' ? '跟单' : '业务员'))} · ${escape(date(message.created_at))}</small><p>${escape(message.body)}</p></div>`).join('')}</div><div class="q-thread-actions">${issue.can_reply?'<button type="button" data-reply>回复</button>':''}${issue.can_close?`<button type="button" class="q-end" data-close>${closeLabel}</button>`:''}${issue.can_remind?'<button type="button" data-remind>提醒业务员确认</button>':''}</div></article>`).join('')||`<p class="q-empty">暂无${topic}</p>`}</div>${!afterSales&&data.can_create?'<button type="button" class="q-create">提交问题</button>':''}`;
      panel.querySelector('.q-refresh').onclick=()=>mountOrder(order,detail,issueId);
      const reload=async()=>{await mountOrder(order,detail,issueId);await sync(true);};
      panel.querySelector('.q-create')?.addEventListener('click',()=>{const requestId=crypto.randomUUID();compose('提交问题',async body=>{await rpc('create',{order_id:order.id,body,request_id:requestId});await reload();});});
      for(const issue of data.issues){
        const row=[...panel.querySelectorAll('[data-issue]')].find(node=>node.dataset.issue===issue.id);
        row.querySelector('[data-reply]')?.addEventListener('click',()=>{
          let host = null;
          if (issueId) {
            host = row.querySelector('.q-after-sales-form');
            if (!host) {
              host = document.createElement('section');
              host.className = 'q-after-sales-form';
              row.append(host);
            }
          }
          compose('回复'+topic,async body=>{
            await rpc('reply',{issue_id:issue.id,body});
            await reload();
          },'',host);
        });
        for(const [selector,action] of [['[data-close]','close'],['[data-remind]','remind']])row.querySelector(selector)?.addEventListener('click',async event=>{
          const button=event.currentTarget;button.disabled=true;
          try{await rpc(action,{issue_id:issue.id});await reload();}catch(error){if(valid())panel.querySelector('.q-error').textContent=error.message;}finally{button.disabled=false;}
        });
      }
      const focusId=detail.dataset.issueFocus;
      if(focusId){const row=[...panel.querySelectorAll('[data-issue]')].find(node=>node.dataset.issue===focusId);if(row){row.scrollIntoView({block:'center'});delete detail.dataset.issueFocus;}}
      // Acknowledge only the messages actually displayed, never later arrivals.
      await Promise.all(data.issues.filter(issue=>issue.unread).map(issue=>rpc('read',{issue_id:issue.id,sequence:issue.sequence})));
      if(valid())await sync(true);
    } catch(error) {
      if(!valid())return;
      const hint=panel.querySelector('.q-error')||panel.querySelector('p');hint.textContent=topic+'加载失败：'+error.message;
      const retry=document.createElement('button');retry.type='button';retry.textContent='重试';retry.onclick=()=>mountOrder(order,detail,issueId);panel.append(retry);
    }
  }

  return {mountHome,mountOrder};
}

const issueView = createIssueView(false);
const afterSalesView = createIssueView(true);

export function mountIssueHome(options) {
  issueView.mountHome(options);
  afterSalesView.mountHome(options);
}

export async function mountIssueOrder(order, detail) {
  await Promise.all([issueView.mountOrder(order, detail), afterSalesView.mountOrder(order, detail)]);
}
