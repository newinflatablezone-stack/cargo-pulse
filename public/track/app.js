const STEP_LABELS={rendering:"效果确认",production:"生产中",production_shipping:"完成生产并发货",ready_to_ship:"安排发货",shipping_selection:"安排发货",tracking:"填写物流单号",air_pickup:"等待提取",delivery:"运输签收",domestic_customs:"国内清关与开船",ocean_transit:"海上运输",overseas_customs:"海外清关与提柜",warehouse_appointment:"海外仓预约",last_mile:"目的地派送",batch_shipping:"分批运输",completed:"已送达"};
const form=document.querySelector("#track-form"),orderInput=document.querySelector("#order-no"),emailInput=document.querySelector("#email"),button=document.querySelector("#submit-button"),message=document.querySelector("#form-message"),result=document.querySelector("#result");

orderInput.addEventListener("focus",()=>{if(orderInput.value==="#")orderInput.setSelectionRange(1,1)});
orderInput.addEventListener("input",()=>{const clean=orderInput.value.replace(/^#+/,"");orderInput.value=`#${clean}`});

form.addEventListener("submit",async(event)=>{
  event.preventDefault();message.textContent="";result.hidden=true;result.replaceChildren();
  const orderNo=orderInput.value.trim(),email=emailInput.value.trim();
  if(orderNo.replace(/^#+/,"").trim()===""||!emailInput.validity.valid){message.textContent="请填写正确的订单号和邮箱。";return}
  button.disabled=true;button.textContent="查询中…";
  try{
    const configResponse=await fetch("/api/config",{cache:"no-store"});
    if(!configResponse.ok)throw new Error("config");
    const config=await configResponse.json();
    if(!config.url||!config.key)throw new Error("config");
    const response=await fetch(`${config.url}/rest/v1/rpc/lookup_customer_tracking`,{method:"POST",headers:{"Content-Type":"application/json",apikey:config.key,Authorization:`Bearer ${config.key}`},body:JSON.stringify({p_order_no:orderNo,p_email:email}),cache:"no-store"});
    if(!response.ok){if(response.status===404)throw new Error("setup");throw new Error("request")}
    const data=await response.json();
    if(!data?.found){message.textContent="未找到匹配记录，请核对订单号和邮箱。";return}
    renderResult(data);result.hidden=false;result.scrollIntoView({behavior:"smooth",block:"start"});
  }catch(error){message.textContent=error.message==="setup"?"查询服务正在配置，请稍后再试。":"暂时无法查询，请稍后再试。"}
  finally{button.disabled=false;button.textContent="查询物流"}
});

function addDays(value,days){const date=new Date(value);if(Number.isNaN(date.getTime()))return null;date.setDate(date.getDate()+days);return date}
function oceanDays(item){const base=item.sea_region==="europe"?40:16;return base+(String(item.forwarder_name||"").trim()==="众一"&&item.sea_region!=="europe"?4:0)}
function routeAfterProduction(item){if(item.shipping_mode==="air_freight")return 17;if(item.shipping_mode==="domestic_express")return 12;if(item.shipping_mode==="overseas_warehouse")return (item.overseas_method==="truck"?5:2)+7;return (item.sea_region==="europe"?14:10)+oceanDays(item)+21}
function remainingDays(item){switch(item.current_step){case"rendering":return 8+routeAfterProduction(item);case"production":return routeAfterProduction(item);case"ready_to_ship":case"shipping_selection":return routeAfterProduction(item);case"tracking":return item.shipping_mode==="domestic_express"?10:7;case"air_pickup":return 7;case"domestic_customs":return oceanDays(item)+21;case"ocean_transit":return 21;case"overseas_customs":return 14;case"warehouse_appointment":return 7;case"delivery":case"last_mile":case"completed":return 0;default:return 0}}
function expectedDate(item){if(item.current_step==="completed"||item.completed_at)return new Date(item.completed_at||item.step_started_at);const due=new Date(item.step_deadline||Date.now()),now=new Date();const base=Number.isNaN(due.getTime())||due<now?now:due;return addDays(base,remainingDays(item)+1)}
function fmt(value,withTime=false){if(!value)return"—";const d=new Date(value);if(Number.isNaN(d.getTime()))return"—";return new Intl.DateTimeFormat("zh-CN",withTime?{year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}:{year:"numeric",month:"2-digit",day:"2-digit"}).format(d)}
function el(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node}

function renderResult(data){
  const order=data.order,shipments=Array.isArray(data.shipments)?data.shipments:[],events=normalizeEvents(data.events,order);
  const etaItems=shipments.length?shipments:[order];
  const etaDates=etaItems.map(expectedDate).filter(date=>date&&!Number.isNaN(date.getTime()));
  const overallEta=etaDates.length?new Date(Math.max(...etaDates.map(d=>d.getTime()))):null;
  const complete=etaItems.length>0&&etaItems.every(item=>item.current_step==="completed"||item.completed_at);
  const summary=el("div","summary"),left=el("div"),right=el("div","eta");
  left.append(el("small","",`订单 ${order.order_no}`),el("h2","",complete?"订单已送达":STEP_LABELS[order.current_step]||"运输处理中"));
  right.append(el("span","",complete?"送达时间":"预计送达时间"),el("strong","",fmt(overallEta)));
  summary.append(left,right);result.append(summary);
  const customer=el("article","customer"),customerTitle=el("div","section-title");customerTitle.append(el("h3","","客户信息"),el("span","","仅显示本订单资料"));customer.append(customerTitle,el("p","",order.customer_info));result.append(customer);
  if(shipments.length){const card=el("article","track-card"),title=el("div","section-title"),batches=el("div","batches");title.append(el("h3","","分批物流轨迹"),el("span","",`${shipments.length} 个批次`));card.append(title);shipments.forEach((item,index)=>batches.append(renderBatch(item,index)));card.append(batches);result.append(card)}
  else result.append(renderTimelineCard(events,"物流轨迹"));
}
function normalizeEvents(source,item){const list=Array.isArray(source)?source:[];const seen=new Set(),out=[];for(const event of list){const key=`${event.step_key}|${event.started_at}|${event.completed_at||""}`;if(seen.has(key))continue;seen.add(key);out.push(event)}if(!out.some(e=>e.step_key===item.current_step))out.push({step_key:item.current_step,started_at:item.step_started_at,deadline_at:item.step_deadline,completed_at:item.current_step==="completed"?item.step_started_at:null,tracking_no:item.tracking_no});return out.filter(e=>e.step_key&&e.step_key!=="production_shipping")}
function renderTimelineCard(events,titleText){const card=el("article","track-card"),title=el("div","section-title");title.append(el("h3","",titleText),el("span","","按实际发生时间更新"));card.append(title,renderTimeline(events));return card}
function renderBatch(item,index){const batch=el("section","batch"),head=el("div","batch-head"),events=normalizeEvents(item.events,item);head.append(el("h4","",item.batch_name||`第 ${index+1} 批`),el("span","",`预计送达 ${fmt(expectedDate(item))}`));batch.append(head);const numbers=[item.tracking_no,item.ocean_tracking_no,item.last_mile_tracking_no].filter(Boolean);if(numbers.length)batch.append(el("div","tracking-no",`物流单号：${numbers.join(" · ")}`));batch.append(renderTimeline(events));return batch}
function renderTimeline(events){const timeline=el("div","timeline");events.forEach((event,index)=>{const row=el("div",`event ${!event.completed_at&&index===events.length-1?"current":""}`),dot=el("span","dot"),body=el("div"),time=el("time","",fmt(event.completed_at||event.started_at,true));body.append(el("h4","",STEP_LABELS[event.step_key]||event.step_key),el("p","",event.completed_at?"已完成":"进行中"));if(event.tracking_no)body.append(el("span","tracking-no",`单号：${event.tracking_no}`));row.append(dot,body,time);timeline.append(row)});return timeline}
