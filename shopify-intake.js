export function mountShopifyIntake({api, refresh, enabled}) {
  const toolbar = document.querySelector('.resource-links');
  if (!enabled || !toolbar || toolbar.querySelector('#shopifyIntake')) return;
  const entry = document.createElement('button');
  entry.type = 'button';
  entry.id = 'shopifyIntake';
  entry.textContent = 'Shopify 待认领';
  toolbar.append(entry);
  const call = (action, fields = {}) => api('/rest/v1/rpc/shopify_order_intake',{
    method:'POST',body:JSON.stringify({action,...fields})
  });
  entry.onclick = () => {
    const dialog = document.createElement('dialog');
    dialog.className = 'q-dialog';
    dialog.innerHTML = '<div class="q-modal"><button type="button" class="q-close" aria-label="关闭">×</button><h2>Shopify 订单认领</h2><p class="q-error" role="alert"></p><div class="q-list"></div></div>';
    document.body.append(dialog);
    dialog.addEventListener('close',()=>dialog.remove(),{once:true});
    dialog.querySelector('.q-close').onclick=()=>dialog.close();
    dialog.showModal();
    const list=dialog.querySelector('.q-list');
    const error=dialog.querySelector('.q-error');
    async function load() {
      list.textContent='正在加载…';
      error.textContent='';
      try {
        const {orders}=await call('list');
        list.replaceChildren();
        if (!orders.length) list.textContent='暂无待认领或待提交的订单';
        for (const order of orders) {
          const button=document.createElement('button');
          button.type='button';
          button.className='q-list-item';
          button.textContent=[order.order_no,order.order_date,order.claimed?'已认领 · 补齐资料':'认领'].join(' · ');
          button.onclick=async()=>{
            button.disabled=true;
            try { edit(order.claimed ? order : await call('claim',{id:order.id})); }
            catch (caught) { button.disabled=false;error.textContent=caught.message; }
          };
          list.append(button);
        }
      } catch (caught) { list.replaceChildren();error.textContent=caught.message; }
    }
    function edit(order) {
      error.textContent='';
      list.innerHTML=`<form class="grid">
        <label>订单号<input name="order_no" readonly></label>
        <label>日期<input name="order_date" type="date" required></label>
        <label>产品名称<input name="product_name" required></label>
        <label>数量<input name="quantity" type="number" min="1" required></label>
        <label>产品尺寸<input name="size" required></label>
        <label>风机<select name="blower" required><option value="">请选择</option><option>包含</option><option>不包含</option></select></label>
        <label>运输方式<select name="shipping_mode" required><option value="">请选择</option><option value="domestic_sea">海运</option><option value="domestic_express">快递</option></select></label>
        <label class="wide">客户地址<textarea name="customer_info" required></textarea></label>
        <label class="wide">备注<textarea name="requirements"></textarea></label>
        <div class="wide q-shopify-images"></div>
        <label class="wide">图片链接（每行一个）<textarea name="image_urls"></textarea></label>
        <button type="button" class="q-intake-back">返回列表</button><button type="submit">提交下单</button>
      </form>`;
      const form=list.querySelector('form');
      for (const field of ['order_no','order_date','size','blower','shipping_mode','customer_info','requirements']) form.elements[field].value=order[field]||'';
      form.elements.image_urls.value=(order.image_urls||[]).join('\n');
      appendShopifyImages(form.querySelector('.q-shopify-images'),order.image_urls);
      form.querySelector('.q-intake-back').onclick=load;
      form.onsubmit=async event=>{
        event.preventDefault();
        const submit=form.querySelector('[type="submit"]');
        submit.disabled=true;
        error.textContent='';
        try { await call('submit',{...Object.fromEntries(new FormData(form)),id:order.id}); }
        catch (caught) { error.textContent=caught.message;submit.disabled=false;return; }
        dialog.close();
        await refresh();
      };
    }
    void load();
  };
}

export function appendShopifyImages(container, urls) {
  for (const url of Array.isArray(urls) ? urls : []) {
    if (typeof url !== 'string' || !url.startsWith('https://')) continue;
    const image=document.createElement('img');
    image.src=url;
    image.alt='Shopify 产品图片';
    image.loading='lazy';
    image.referrerPolicy='no-referrer';
    image.width=84;
    container.append(image);
  }
}
