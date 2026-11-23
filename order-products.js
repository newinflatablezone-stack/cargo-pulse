import {productNameReminder} from './product-name.mjs';

const pumps = ['包风机','包气泵','不包风机','不包气泵'];
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
}[char]));

export function orderProducts(order) {
  if (Array.isArray(order?.products) && order.products.length) return order.products;
  return [{
    product_name:order?.product_name, size:order?.size, quantity:order?.quantity,
    requirements:order?.requirements, blower:order?.blower,
    image_urls:order?.shopify_image_urls || [], image_paths:[]
  }];
}

export function productRowsHtml(order) {
  if (!Array.isArray(order?.products) || !order.products.length) return '';
  return '<section class="order-product-list"><h3>产品明细</h3>'+order.products.map((item,index)=>`
    <article class="order-product-row">
      <h4>${index+1}. ${escape(item.product_name || '产品')}</h4>
      <dl><div><dt>尺寸</dt><dd>${escape(item.size || '—')}</dd></div>
      <div><dt>数量</dt><dd>${escape(item.quantity ?? '—')}</dd></div>
      <div><dt>风机／气泵</dt><dd>${escape(item.blower || '—')}</dd></div>
      <div><dt>下单要求</dt><dd>${escape(item.requirements || '—')}</dd></div></dl>
      <div class="q-shopify-images" data-order-product-images="${index}">${(item.image_urls||[]).filter(url=>typeof url==='string'&&url.startsWith('https://')).map(url=>`<img src="${escape(url)}" width="84" loading="lazy" referrerpolicy="no-referrer" alt="产品图片">`).join('')}</div>
    </article>`).join('')+'</section>';
}

export function mountOrderProductEditor(form, order, {upload, listUploads, sign}) {
  const optional = Boolean(order?.shopify_order_id);
  for (const name of ['product_name','quantity','size','blower']) form.elements[name]?.closest('label')?.remove();
  form.querySelector('.shopify-product-images')?.remove();
  if (optional) {
    for (const name of ['shipping_mode','customer_info','abnormal_note']) {
      form.elements[name].required=false;
      const label=form.elements[name].closest('label');
      if (label?.firstChild?.nodeType===3) label.firstChild.textContent=label.firstChild.textContent.replace(/\s*\*\s*$/,'');
    }
  }
  const editor=document.createElement('section');
  editor.className='order-product-list';
  editor.innerHTML='<h3>产品明细</h3><div class="order-product-editor"></div><button type="button" class="secondary" data-add-product>添加产品</button>';
  form.querySelector('.grid').before(editor);
  const list=editor.querySelector('.order-product-editor');
  const rows=[];
  const objectUrls=new Set();
  form.closest('dialog')?.addEventListener('close',()=>{for(const url of objectUrls)URL.revokeObjectURL(url);},{once:true});

  function add(item = {}) {
    const node=document.createElement('fieldset');
    node.className='order-product-row';
    node.innerHTML=`<legend>产品</legend><div class="grid">
      <label class="wide">图片<input type="file" accept="image/*" multiple data-product-files></label><div class="wide q-shopify-images"></div>
      <label>产品名称<input data-field="product_name" ${optional?'':'required'}></label>
      <label>尺寸<input data-field="size"></label>
      <label>数量<input data-field="quantity" type="number" min="1" ${optional?'':'required'}></label>
      <label>风机／气泵<select data-field="blower" ${optional?'':'required'}><option value="">请选择</option>${pumps.map(value=>`<option>${value}</option>`).join('')}</select></label>
      <label class="wide">下单要求<textarea data-field="requirements"></textarea></label>
      </div><button type="button" class="secondary" data-remove-product>删除产品</button>`;
    const fields=[...node.querySelectorAll('[data-field]')];
    for (const field of fields) {
      const value=item[field.dataset.field]??'';
      field.value=field.dataset.field==='blower'?({'风机':'包风机','气泵':'包气泵'}[value]||value):value;
    }
    const gallery=node.querySelector('.q-shopify-images');
    const row={node,fields,images:[],addImage(image){
      this.images.push(image);
      const frame=document.createElement('span');
      frame.className='product-image-frame';
      const img=document.createElement('img');
      img.width=84;img.alt='产品图片';img.referrerPolicy='no-referrer';
      if (image.preview || image.url) img.src=image.preview || image.url;
      if (image.path) void sign(image.path).then(url=>{if(frame.isConnected)img.src=url;}).catch(()=>{img.alt='图片预览不可用';});
      const remove=document.createElement('button');
      remove.type='button';remove.className='product-image-delete';remove.textContent='删除';
      remove.setAttribute('aria-label','删除图片');
      remove.onclick=()=>{
        this.images.splice(this.images.indexOf(image),1);
        if(image.preview){URL.revokeObjectURL(image.preview);objectUrls.delete(image.preview);}
        frame.remove();
      };
      frame.append(img,remove);gallery.append(frame);
    }};
    for (const url of item.image_urls || []) row.addImage({url});
    for (const path of item.image_paths || []) row.addImage({path});
    node.querySelector('[data-product-files]').onchange=event=>{
      for (const file of event.target.files) {
        const preview=URL.createObjectURL(file);
        objectUrls.add(preview);
        row.addImage({file,preview});
      }
      event.target.value='';
    };
    node.querySelector('[data-remove-product]').onclick=()=>{
      if(rows.length===1)return;
      rows.splice(rows.indexOf(row),1);node.remove();numberRows();
    };
    rows.push(row);list.append(node);numberRows();
    return row;
  }

  function numberRows(){
    rows.forEach(({node},index)=>{
      node.querySelector('legend').textContent='产品 '+(index+1);
      node.querySelector('[data-remove-product]').disabled=rows.length===1;
    });
    editor.querySelector('[data-add-product]').disabled=rows.length>=100;
  }

  for (const item of orderProducts(order)) add(item);
  editor.querySelector('[data-add-product]').onclick=()=>{if(rows.length<100)add();};
  const legacyRow=rows[0];
  const ready=order?.id && !order.products ? listUploads(order.id).then(paths=>{
    if(rows.includes(legacyRow)) for(const path of paths)legacyRow.addImage({path});
  }).then(()=>null,error=>error) : Promise.resolve(null);

  form.readOrderProducts=async orderId=>{
    const loadError=await ready;
    if(loadError)throw loadError;
    const products=rows.map(({fields,images},index)=>{
      const values=Object.fromEntries(fields.map(field=>[field.dataset.field,field.value.trim()]));
      const nameError=values.product_name || !optional ? productNameReminder(values.product_name) : '';
      if(nameError)throw Error('第 '+(index+1)+' 行：'+nameError);
      if(!optional && !images.length)throw Error('请为第 '+(index+1)+' 行添加产品图片');
      return {values,images:[...images]};
    });
    const result=[];
    for(const {values,images} of products){
      for(const image of images)if(image.file&&!image.path)image.path=await upload(orderId,image.file);
      result.push({...values,image_urls:images.flatMap(image=>image.url?[image.url]:[]),image_paths:images.flatMap(image=>image.path?[image.path]:[])});
    }
    return result;
  };
}
