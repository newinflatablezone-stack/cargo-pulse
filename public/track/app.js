const STEP_LABELS={rendering:"Order Confirmation",production:"Production",production_shipping:"Production Completed & Shipped",ready_to_ship:"Shipping Arrangements",shipping_selection:"Shipping Arrangements",tracking:"Tracking Number Added",air_pickup:"Awaiting Air Pickup",delivery:"Out for Delivery",domestic_customs:"Export Customs & Departure",ocean_transit:"Ocean Transit",overseas_customs:"Import Customs & Container Pickup",warehouse_appointment:"Warehouse Appointment",last_mile:"Final Delivery",batch_shipping:"Split Shipment",completed:"Delivered"};
const SALES_REPRESENTATIVES={
  ella:{name:"Ella",phone:"+1 (626) 342-7272",whatsapp:"+1 (626) 342-7272",email:"sales@inflatable-zone.com"},
  sherry:{name:"Sherry",phone:"+1 (626) 230-3755",whatsapp:"+86 13580563412",email:"sherry@inflatable-zone.com"},
  demi:{name:"Demi",phone:"+1 (626) 216-9617",whatsapp:"+1 (626) 216-9617",email:"demi@inflatable-zone.com"},
  rayna:{name:"Rayna",phone:"+1 (213) 849-0088",whatsapp:"+1 (213) 849-0088",email:"rayna@inflatable-zone.com"}
};
const form=document.querySelector("#track-form"),contactInput=document.querySelector("#contact"),button=document.querySelector("#submit-button"),message=document.querySelector("#form-message"),result=document.querySelector("#result");

form.addEventListener("submit",async(event)=>{
  event.preventDefault();message.textContent="";result.hidden=true;result.replaceChildren();
  const contact=contactInput.value.trim(),isEmail=/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact),phoneDigits=contact.replace(/\D/g,"");
  if(!isEmail&&phoneDigits.length<7){message.textContent="Please enter a valid email address or phone number.";return}
  button.disabled=true;button.textContent="Tracking…";
  try{
    const configResponse=await fetch("/api/config",{cache:"no-store"});
    if(!configResponse.ok)throw new Error("config");
    const config=await configResponse.json();
    if(!config.url||!config.key)throw new Error("config");
    const response=await fetch(`${config.url}/rest/v1/rpc/lookup_customer_tracking`,{method:"POST",headers:{"Content-Type":"application/json",apikey:config.key,Authorization:`Bearer ${config.key}`},body:JSON.stringify({p_email:contact}),cache:"no-store"});
    if(!response.ok){if(response.status===404)throw new Error("setup");throw new Error("request")}
    const data=await response.json();
    if(!data?.found){message.textContent="No matching shipment was found. Please check your email address or phone number.";return}
    renderResult(data);result.hidden=false;result.scrollIntoView({behavior:"smooth",block:"start"});
  }catch(error){message.textContent=error.message==="setup"?"The tracking service is being configured. Please try again shortly.":"Tracking is temporarily unavailable. Please try again later."}
  finally{button.disabled=false;button.textContent="Track Shipment"}
});

function addDays(value,days){const date=new Date(value);if(Number.isNaN(date.getTime()))return null;date.setDate(date.getDate()+days);return date}
function oceanDays(item){const base=item.sea_region==="europe"?40:16;return base+(String(item.forwarder_name||"").trim()==="\u4f17\u4e00"&&item.sea_region!=="europe"?4:0)}
function routeAfterProduction(item){if(item.shipping_mode==="air_freight")return 17;if(item.shipping_mode==="domestic_express")return 12;if(item.shipping_mode==="overseas_warehouse")return (item.overseas_method==="truck"?5:2)+7;return (item.sea_region==="europe"?14:10)+oceanDays(item)+21}
function remainingDays(item){switch(item.current_step){case"rendering":return 11+routeAfterProduction(item);case"production":return routeAfterProduction(item);case"ready_to_ship":case"shipping_selection":return routeAfterProduction(item);case"tracking":return item.shipping_mode==="domestic_express"?10:7;case"air_pickup":return 7;case"domestic_customs":return oceanDays(item)+21;case"ocean_transit":return 21;case"overseas_customs":return 14;case"warehouse_appointment":return 7;case"delivery":case"last_mile":case"completed":return 0;default:return 0}}
function expectedDate(item){if(item.current_step==="completed"||item.completed_at)return new Date(item.completed_at||item.step_started_at);const due=new Date(item.step_deadline||Date.now()),now=new Date();const base=Number.isNaN(due.getTime())||due<now?now:due;return addDays(base,remainingDays(item)+1)}
function nextPlannedStep(item,current){
  if(current==="rendering")return {key:"production",days:11};
  if(current==="production"||current==="ready_to_ship"||current==="shipping_selection"){
    if(item.shipping_mode==="air_freight")return {key:"air_pickup",days:10};
    if(item.shipping_mode==="domestic_express")return {key:"tracking",days:2};
    if(item.shipping_mode==="overseas_warehouse")return {key:"tracking",days:item.overseas_method==="truck"?5:2};
    return {key:"domestic_customs",days:item.sea_region==="europe"?14:10};
  }
  if(current==="tracking")return {key:"delivery",days:item.shipping_mode==="domestic_express"?10:7};
  if(current==="air_pickup")return {key:"delivery",days:7};
  if(current==="domestic_customs")return {key:"ocean_transit",days:oceanDays(item)};
  if(current==="ocean_transit")return {key:"overseas_customs",days:7};
  if(current==="overseas_customs")return {key:"warehouse_appointment",days:7};
  if(current==="warehouse_appointment")return {key:"last_mile",days:7};
  if(current==="delivery"||current==="last_mile")return {key:"completed",days:1};
  return null;
}
function projectedSteps(item){
  if(!item?.current_step||item.current_step==="completed"||item.completed_at)return [];
  const now=new Date(),due=new Date(item.step_deadline||now);
  let expected=Number.isNaN(due.getTime())||due<now?now:due;
  let current=item.current_step;
  const future=[];
  if(current==="production")future.push({step_key:"production_shipping",expected_at:new Date(expected)});
  for(let guard=0;guard<10;guard+=1){
    const next=nextPlannedStep(item,current);
    if(!next)break;
    expected=addDays(expected,next.days)||expected;
    future.push({step_key:next.key,expected_at:new Date(expected)});
    current=next.key;
    if(current==="production")future.push({step_key:"production_shipping",expected_at:new Date(expected)});
    if(current==="completed")break;
  }
  return future;
}
function fmt(value,withTime=false){if(!value)return"—";const d=new Date(value);if(Number.isNaN(d.getTime()))return"—";return new Intl.DateTimeFormat("en-US",withTime?{year:"numeric",month:"short",day:"2-digit",hour:"2-digit",minute:"2-digit"}:{year:"numeric",month:"short",day:"2-digit"}).format(d)}
function englishText(value,fallback=""){
  const text=String(value||"").replace(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g," ").replace(/\s+/g," ").trim();
  return text||fallback;
}
function stepLabel(key){return STEP_LABELS[key]||"Shipment Update"}
function el(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node}
function contactItem(label,value){const row=el("div","representative-contact");row.append(el("span","",label),el("strong","",value));return row}
function renderRepresentative(name){
  const representative=SALES_REPRESENTATIVES[String(name||"").trim().toLowerCase()];
  if(!representative)return null;
  const card=el("article","representative"),contacts=el("div","representative-contacts");
  if(representative.phone===representative.whatsapp)contacts.append(contactItem("Phone & WhatsApp",representative.phone));
  else contacts.append(contactItem("Phone",representative.phone),contactItem("WhatsApp",representative.whatsapp));
  contacts.append(contactItem("Email",representative.email));
  const identity=el("div","representative-identity",representative.name),header=el("div","sales-contact-header"),body=el("div","sales-contact-body");
  header.append(el("p","sales-contact-help","Questions about your shipment? Please contact your sales representative."));
  body.append(identity,contacts);card.append(header,body);return card;
}

function parseCustomerInformation(value){
  const original=String(value||"").replace(/\s+/g," ").trim();
  if(!original)return {};
  const emailMatch=original.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const email=emailMatch?.[0]||"";
  let remaining=email?original.replace(email," "):original;
  const phoneMatches=[...remaining.matchAll(/\+\d[\d\s().-]{6,}\d/g)];
  const phone=phoneMatches.at(-1)?.[0]?.trim()||"";
  if(phone)remaining=remaining.replace(phone," ");
  remaining=remaining.replace(/\s+/g," ").trim();
  const addressStart=remaining.search(/\b\d+[A-Za-z]?(?:[-/]\d+)?\b/);
  const name=addressStart>0?remaining.slice(0,addressStart).trim():"";
  const address=addressStart>0?remaining.slice(addressStart).trim():remaining;
  return {name,address,phone,email};
}
function customerField(label,value,className=""){
  if(!value)return null;
  const field=el("div",`customer-field ${className}`.trim());
  field.append(el("span","customer-label",label),el("strong","customer-value",englishText(value)));
  return field;
}

function renderCustomerProfile(customerInfo){
  const profile=el("div","customer-profile customer-profile-vertical");
  const contact=el("div","customer-contact-block");
  contact.append(
    el("h4","customer-block-title","Email"),
    el("span","customer-contact-value",englishText(customerInfo.email,"Not provided"))
  );

  const shipping=el("div","customer-shipping-block");
  shipping.append(
    el("h4","customer-block-title","Delivery address"),
    el("strong","customer-shipping-name",englishText(customerInfo.name,"Customer")),
    el("span","customer-shipping-address",englishText(customerInfo.address,"Not provided"))
  );
  profile.append(contact,shipping);
  return profile;
}

function renderResult(data){
  const order=data.order,shipments=Array.isArray(data.shipments)?data.shipments:[],events=normalizeEvents(data.events,order);
  const customer=el("article","customer customer-card"),customerInfo=parseCustomerInformation(order.customer_info);
  customer.append(el("h3","overview-panel-title","Customer Information"),renderCustomerProfile(customerInfo));result.append(customer);
  if(shipments.length){const card=el("article","track-card"),title=el("div","section-title"),batches=el("div","batches");title.append(el("h3","","Shipment Journey"),el("span","",`${shipments.length} ${shipments.length===1?"shipment":"shipments"}`));card.append(title);shipments.forEach((item,index)=>batches.append(renderBatch(item,index)));card.append(batches);result.append(card)}
  else result.append(renderTimelineCard(events,"Shipment Journey",order));
  const representative=renderRepresentative(order.business_name);if(representative){representative.classList.add("sales-contact-card");result.append(representative)}
}
function normalizeEvents(source,item){const list=Array.isArray(source)?source:[];const seen=new Set(),out=[];for(const event of list){const key=`${event.step_key}|${event.started_at}|${event.completed_at||""}`;if(seen.has(key))continue;seen.add(key);out.push(event)}if(!out.some(e=>e.step_key===item.current_step))out.push({step_key:item.current_step,started_at:item.step_started_at,deadline_at:item.step_deadline,completed_at:item.current_step==="completed"?item.step_started_at:null,tracking_no:item.tracking_no});return out.filter(e=>e.step_key&&e.step_key!=="production_shipping")}
function renderTimelineCard(events,titleText,item){const card=el("article","track-card"),title=el("div","section-title");title.append(el("h3","",titleText),el("span","","Actual milestones and upcoming schedule"));card.append(title,renderTimeline(events,item));return card}
function renderBatch(item,index){const batch=el("section","batch"),head=el("div","batch-head"),events=normalizeEvents(item.events,item);head.append(el("h4","",englishText(item.batch_name,`Shipment ${index+1}`)),el("span","",`Estimated delivery: ${fmt(expectedDate(item))}`));batch.append(head);const numbers=[item.tracking_no,item.ocean_tracking_no,item.last_mile_tracking_no].filter(Boolean).map(number=>englishText(number)).filter(Boolean);if(numbers.length)batch.append(el("div","tracking-no",`Tracking number: ${numbers.join(" · ")}`));batch.append(renderTimeline(events,item));return batch}
function renderTimeline(events,item){const timeline=el("div","timeline");events.forEach((event,index)=>{const isCurrent=!event.completed_at&&index===events.length-1,row=el("div",`event ${isCurrent?"current":""}`),dot=el("span","dot"),body=el("div"),shownDate=isCurrent?(event.deadline_at||item?.step_deadline):(event.completed_at||event.started_at),time=el("time","",isCurrent?`Expected by ${fmt(shownDate)}`:fmt(shownDate,true));body.append(el("h4","",stepLabel(event.step_key)),el("p","",event.completed_at?"Completed":"In Progress"));if(event.tracking_no)body.append(el("span","tracking-no",`Tracking number: ${englishText(event.tracking_no,"—")}`));row.append(dot,body,time);timeline.append(row)});const future=projectedSteps(item);if(future.length){timeline.append(el("div","schedule-label","Upcoming Steps"));future.forEach(stage=>{const row=el("div","event future"),dot=el("span","dot"),body=el("div"),time=el("time","",`Expected by ${fmt(stage.expected_at)}`);body.append(el("h4","",stepLabel(stage.step_key)),el("p","","Scheduled"));row.append(dot,body,time);timeline.append(row)})}return timeline}
